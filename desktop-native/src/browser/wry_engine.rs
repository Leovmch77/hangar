//! WebView2 (Windows) / WKWebView (macOS) como janela filha da janela GPUI. A entrada chega direto nela.
use std::{
    cell::{Cell, RefCell},
    rc::Rc,
};

use gpui_kit::*;
use wry::{
    NewWindowResponse, PageLoadEvent, Rect, WebContext, WebView, WebViewBuilder,
    dpi::{LogicalPosition, LogicalSize},
    raw_window_handle::{self, HasWindowHandle},
};

use super::{Event, Pointer, model};

pub struct Engine {
    view: WebView,
    // Declarado depois do `view` para cair depois dele: o contexto guarda a pasta de dados em uso.
    _context: WebContext,
    state: Rc<RefCell<model::PageState>>,
    events: async_channel::Sender<Event>,
    /// Área onde a janela filha está; `None` = escondida. Evita chamada nativa a cada quadro.
    placed: Cell<Option<Bounds<Pixels>>>,
    /// A página caiu (`Inspector.targetCrashed`): o painel refaz o motor no próximo `go`.
    dead: Rc<Cell<bool>>,
    /// CDP que segura os ouvintes do motor (queda); os ouvintes morrem com ele.
    #[cfg(target_os = "windows")]
    _watch: Option<Rc<super::cdp::Cdp>>,
}

/// Clique e tecla de verdade na página vão ao painel, que pausa o agente se ele estiver agindo. Script de
/// inicialização vale desde o primeiro documento; o binding do CDP chegava tarde para ele.
const USER_INPUT: &str = "(()=>{const f=e=>{if(e.isTrusted&&window.ipc)window.ipc.postMessage('hangar-user')};addEventListener('pointerdown',f,true);addEventListener('keydown',f,true)})()";

/// Link com `target=_blank` e `window.open` abrem nesta página: o painel é um navegador de uma aba só.
const SAME_TAB: &str = "(()=>{addEventListener('click',e=>{const a=e.target&&e.target.closest&&e.target.closest('a[target]');if(a&&a.target!=='_self'&&a.target!=='_top'&&a.target!=='_parent')a.target='_self'},true);const o=window.open;window.open=function(u){if(u){location.href=u;return window}return o.apply(this,arguments)}})()";

fn send(events: &async_channel::Sender<Event>, state: &model::PageState) {
    let _ = events.try_send(Event::State(state.clone()));
}

/// Janela pai guardada sem o empréstimo da `Window` da GPUI, para o motor nascer fora dele.
pub struct Starter(raw_window_handle::RawWindowHandle);

impl HasWindowHandle for Starter {
    fn window_handle(&self) -> Result<raw_window_handle::WindowHandle<'_>, raw_window_handle::HandleError> {
        // SAFETY: a janela GPUI dura mais que o motor: o painel que o cria e o guarda vive nela.
        Ok(unsafe { raw_window_handle::WindowHandle::borrow_raw(self.0) })
    }
}

impl Engine {
    pub fn available() -> Result<(), String> { Ok(()) }

    pub fn prepare(window: &Window, _cx: &App) -> Result<Starter, String> {
        // Caminho completo: a `Window` tem um `window_handle()` próprio, que devolve o identificador da GPUI.
        Ok(Starter(HasWindowHandle::window_handle(window).map_err(|e| e.to_string())?.as_raw()))
    }
}

impl Starter {
    /// No Windows o WebView2 roda um laço de mensagens aninhado até o controle ficar pronto, e a GPUI executa outras
    /// tarefas dentro dele: chamar fora de qualquer empréstimo da App, senão elas entram em pânico.
    pub fn start(self, events: async_channel::Sender<Event>) -> Result<Engine, String> {
        // Cookies e logins ficam ao lado das configurações do app. O macOS ignora a pasta e usa o armazenamento do app.
        let mut context = WebContext::new(crate::appearance::dir().map(|dir| dir.join("browser")));
        let state = Rc::new(RefCell::new(model::PageState::default()));
        let (on_load, on_title, on_ipc) = ((state.clone(), events.clone()), (state.clone(), events.clone()), events.clone());
        let builder = WebViewBuilder::new_with_web_context(&mut context).with_visible(false).with_initialization_script(SAME_TAB)
            .with_initialization_script(USER_INPUT)
            .with_ipc_handler(move |req| if req.body() == "hangar-user" { let _ = on_ipc.try_send(Event::UserInput); });
        // Estacionada visível fora da tela (ver `park`): nascer com foco roubaria o teclado da janela do app.
        // O agente dirige a página com o app em segundo plano ou com ela estacionada: sem estes, o WebView2 a dá por
        // encoberta e congela os timers (eval e url estouravam o prazo até um clique no app). Os três primeiros são os
        // padrões do wry, que somem quando se passa argumentos. Todo WebView2 desta pasta nasce com os mesmos.
        #[cfg(target_os = "windows")]
        let builder = {
            use wry::WebViewBuilderExtWindows;
            builder.with_focused(false).with_additional_browser_args(concat!(
                "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,CalculateNativeWinOcclusion ",
                "--disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows"))
        };
        let view = builder
            // Bloqueio sem aviso: o handler só recebe a URL e não distingue o quadro principal de um iframe.
            .with_navigation_handler(|url| model::allowed_request(&url))
            // O que escapar do SAME_TAB (página que abre janela sem ser por link nem `window.open`) não abre.
            .with_new_window_req_handler(|_, _| NewWindowResponse::Deny)
            .with_on_page_load_handler(move |event, url| {
                let mut page = on_load.0.borrow_mut();
                page.url = Some(url);
                page.loading = matches!(event, PageLoadEvent::Started);
                page.error = None;
                // No Windows o histórico vem do CDP (`history`); no macOS o wry não o expõe, e os dois ficam ligados.
                #[cfg(not(target_os = "windows"))]
                if !page.loading {
                    page.can_back = true;
                    page.can_forward = true;
                }
                send(&on_load.1, &page);
            })
            .with_document_title_changed_handler(move |title| {
                let mut page = on_title.0.borrow_mut();
                page.title = title;
                send(&on_title.1, &page);
            })
            .build_as_child(&self)
            .map_err(|e| e.to_string())?;
        let dead = Rc::new(Cell::new(false));
        #[cfg(target_os = "windows")]
        let on_spa = (state.clone(), events.clone());
        #[cfg(target_os = "windows")]
        let on_native = (state.clone(), events.clone());
        #[cfg(target_os = "windows")]
        let watch = {
            use wry::WebViewExtWindows;
            let cdp = Rc::new(super::cdp::Cdp::new(view.webview()));
            let (dead, state, events) = (dead.clone(), state.clone(), events.clone());
            let listened = cdp.on("Inspector.targetCrashed", move |_| {
                dead.set(true);
                let mut page = state.borrow_mut();
                (page.loading, page.error) = (false, Some(crate::i18n::tr("browser_err_crashed")));
                send(&events, &page);
            });
            // Navegação dentro do documento (SPA, âncora) não passa pelo `on_page_load`: sem isto a barra e o voltar ficavam
            // na página anterior.
            let (state, events) = (on_spa.0, on_spa.1);
            let within = cdp.on("Page.navigatedWithinDocument", move |p| {
                let Some(url) = p["url"].as_str() else { return };
                let mut page = state.borrow_mut();
                page.url = Some(url.to_owned());
                send(&events, &page);
            });
            if let Err(e) = within { eprintln!("[nav] navegacao dentro da pagina sem ouvinte: {e}"); }
            watch_native(&view, &on_native.0, &on_native.1);
            match listened {
                Ok(()) => {
                    drop(cdp.call("Page.enable", serde_json::json!({})));
                    drop(cdp.call("Inspector.enable", serde_json::json!({})));
                    Some(cdp)
                }
                Err(e) => { eprintln!("[nav] queda da pagina sem ouvinte: {e}"); None }
            }
        };
        let engine = Engine { view, _context: context, state, events, placed: Cell::new(None), dead, #[cfg(target_os = "windows")] _watch: watch };
        #[cfg(target_os = "windows")]
        engine.park();
        Ok(engine)
    }
}

/// Diálogos e início de navegação pelo próprio WebView2. O diálogo padrão dele é janela modal que ninguém responde
/// quando é o agente que o dispara: o `click` e todo verbo seguinte esperavam o prazo inteiro. Aqui, como no Linux,
/// `alert`/`beforeunload` passam, `confirm`/`prompt` são recusados, e a pessoa vê o aviso no painel. O `Started` do
/// wry só chega com a resposta: sem o `NavigationStarting`, página lenta nunca mostrava o Parar.
#[cfg(target_os = "windows")]
fn watch_native(view: &WebView, state: &Rc<RefCell<model::PageState>>, events: &async_channel::Sender<Event>) {
    use webview2_com::{NavigationStartingEventHandler, ScriptDialogOpeningEventHandler, take_pwstr, Microsoft::Web::WebView2::Win32::{
        COREWEBVIEW2_SCRIPT_DIALOG_KIND, COREWEBVIEW2_SCRIPT_DIALOG_KIND_ALERT, COREWEBVIEW2_SCRIPT_DIALOG_KIND_BEFOREUNLOAD}};
    use wry::WebViewExtWindows;
    let core = view.webview();
    // SAFETY: thread da interface, dona do WebView2.
    if let Err(e) = unsafe { core.Settings().and_then(|s| s.SetAreDefaultScriptDialogsEnabled(false)) } {
        eprintln!("[nav] dialogo padrao do WebView2 continua ligado: {}", e.message());
    }
    let (st, ev) = (state.clone(), events.clone());
    let dialogs = ScriptDialogOpeningEventHandler::create(Box::new(move |_, args| {
        let Some(args) = args else { return Ok(()) };
        let mut kind = COREWEBVIEW2_SCRIPT_DIALOG_KIND::default();
        let mut raw = windows::core::PWSTR::null();
        // SAFETY: o WebView2 aloca a mensagem; `take_pwstr` a libera.
        unsafe { args.Kind(&mut kind)?; args.Message(&mut raw)?; }
        let message: String = take_pwstr(raw).chars().take(200).collect();
        let accept = kind == COREWEBVIEW2_SCRIPT_DIALOG_KIND_ALERT || kind == COREWEBVIEW2_SCRIPT_DIALOG_KIND_BEFOREUNLOAD;
        // Sem `Accept`, o diálogo volta recusado assim que o evento termina.
        if accept { unsafe { args.Accept()?; } }
        let key = if kind == COREWEBVIEW2_SCRIPT_DIALOG_KIND_ALERT { Some("browser_dialog_alert") }
            else if kind == COREWEBVIEW2_SCRIPT_DIALOG_KIND_BEFOREUNLOAD { None } else { Some("browser_dialog_refused") };
        if let Some(key) = key {
            let mut page = st.borrow_mut();
            page.notice = Some(crate::i18n::tr(key).replace("{message}", message.trim()));
            page.notice_seq += 1;
            send(&ev, &page);
        }
        Ok(())
    }));
    let (st, ev) = (state.clone(), events.clone());
    let starting = NavigationStartingEventHandler::create(Box::new(move |_, args| {
        // O handler do wry roda antes e cancela endereço bloqueado: aí não há carga para mostrar.
        let mut cancel = windows::core::BOOL::default();
        if let Some(args) = args { unsafe { args.Cancel(&mut cancel)?; } }
        if cancel.as_bool() { return Ok(()); }
        let mut page = st.borrow_mut();
        if !page.loading { page.loading = true; send(&ev, &page); }
        Ok(())
    }));
    let mut token = 0i64;
    // SAFETY: thread da interface; os handlers vivem enquanto o WebView2 os segurar.
    unsafe {
        if let Err(e) = core.add_ScriptDialogOpening(&dialogs, &mut token) { eprintln!("[nav] dialogos sem ouvinte: {}", e.message()); }
        if let Err(e) = core.add_NavigationStarting(&starting, &mut token) { eprintln!("[nav] inicio de navegacao sem ouvinte: {}", e.message()); }
    }
}

impl Engine {
    /// Falha da chamada nativa vira `error` do estado, para a tela mostrar.
    fn report(&self, result: wry::Result<()>) {
        if let Err(e) = result {
            let mut page = self.state.borrow_mut();
            page.error = Some(e.to_string());
            send(&self.events, &page);
        }
    }

    pub fn load(&self, url: &str) { self.report(self.view.load_url(url)); }
    pub fn back(&self) { self.report(self.view.evaluate_script("history.back()")); }
    pub fn forward(&self) { self.report(self.view.evaluate_script("history.forward()")); }
    pub fn reload(&self) { self.report(self.view.reload()); }
    /// `window.stop()` roda no documento atual e não cancela a navegação que ainda não trouxe o novo; no Windows o CDP
    /// cancela as duas.
    pub fn stop(&self) {
        #[cfg(target_os = "windows")]
        drop(self.cdp().call("Page.stopLoading", serde_json::json!({})));
        #[cfg(not(target_os = "windows"))]
        self.report(self.view.evaluate_script("window.stop()"));
    }

    #[cfg(target_os = "windows")]
    pub fn cdp(&self) -> std::rc::Rc<super::cdp::Cdp> {
        use wry::WebViewExtWindows;
        std::rc::Rc::new(super::cdp::Cdp::new(self.view.webview()))
    }

    pub fn alive(&self) -> bool { !self.dead.get() }

    /// Página que caiu volta com `Reload` no mesmo WebView2: o processo da página renasce e o histórico fica.
    pub fn revive(&self) {
        self.dead.set(false);
        { let mut page = self.state.borrow_mut(); page.error = None; send(&self.events, &page); }
        self.reload();
        // A página nova pode vir sem os domínios ligados na que caiu; sem eles a próxima queda passaria calada.
        #[cfg(target_os = "windows")]
        if let Some(cdp) = &self._watch {
            drop(cdp.call("Page.enable", serde_json::json!({})));
            drop(cdp.call("Inspector.enable", serde_json::json!({})));
        }
    }

    /// Voltar/avançar de verdade, lidos do histórico do WebView2 depois de cada carga. Devolve a tarefa: o painel a
    /// roda, porque o motor não tem executor.
    #[cfg(target_os = "windows")]
    pub fn history(&self) -> impl std::future::Future<Output = ()> + 'static {
        let (call, state, events) = (self.cdp().call("Page.getNavigationHistory", serde_json::json!({})), self.state.clone(), self.events.clone());
        async move {
            let h = match call.await { Ok(h) => h, Err(e) => return eprintln!("[nav] historico nao lido: {e}") };
            let (index, count) = (h["currentIndex"].as_i64().unwrap_or(0), h["entries"].as_array().map_or(0, Vec::len) as i64);
            let mut page = state.borrow_mut();
            (page.can_back, page.can_forward) = (index > 0, index + 1 < count);
            send(&events, &page);
        }
    }

    pub fn place(&self, bounds: Bounds<Pixels>, _window: &mut Window) {
        let hidden = self.placed.get().is_none();
        if self.placed.get() == Some(bounds) { return; }
        self.placed.set(Some(bounds));
        // Lógico: o wry converte para físico com o DPI da janela pai.
        self.report(self.view.set_bounds(Rect {
            position: LogicalPosition::new(f32::from(bounds.origin.x) as f64, f32::from(bounds.origin.y) as f64).into(),
            size: LogicalSize::new(f32::from(bounds.size.width) as f64, f32::from(bounds.size.height) as f64).into(),
        }));
        if hidden { self.report(self.view.set_visible(true)); }
    }

    /// Escondido de verdade (`SW_HIDE`), o WebView2 para de gerar quadros e o CDP perde clique, tecla e `shot`.
    /// Fica visível para o Chromium, mas fora da área do pai, que recorta a janela filha: ninguém a vê.
    #[cfg(target_os = "windows")]
    fn park(&self) {
        // Longe demais estoura os 16 bits do WM_MOVE em DPI alto; -3000 já tira os 1280 da área do pai.
        self.report(self.view.set_bounds(Rect {
            position: LogicalPosition::new(-3000.0, 0.0).into(),
            size: LogicalSize::new(1280.0, 800.0).into(),
        }));
        self.report(self.view.set_visible(true));
    }

    pub fn hide(&self) {
        if self.placed.take().is_some() {
            #[cfg(target_os = "windows")]
            self.park();
            #[cfg(not(target_os = "windows"))]
            self.report(self.view.set_visible(false));
            // Página escondida com o foco do sistema deixaria o teclado sem dono.
            self.release_focus();
        }
    }

    pub fn pointer(&self, _kind: Pointer, _at: Point<Pixels>, _clicks: usize) {}
    pub fn wheel(&self, _at: Point<Pixels>, _delta: Point<Pixels>) {}
    pub fn mouse(&self, _kind: Pointer, _button: MouseButton, _at: Point<Pixels>, _clicks: usize, _modifiers: &Modifiers) {}
    pub fn scroll(&self, _at: Point<Pixels>, _delta: Point<Pixels>, _modifiers: &Modifiers) {}
    pub fn key(&self, _down: bool, _keystroke: &Keystroke) {}
    pub fn insert_text(&self, _text: &str) {}
    /// O WebView nasce sem foco no Windows: sem mover o foco aqui, o que se digita depois do Enter na barra não chega.
    #[cfg(target_os = "windows")]
    pub fn focus(&self, focused: bool) { if focused { self.report(self.view.focus()); } }
    #[cfg(not(target_os = "windows"))]
    pub fn focus(&self, _focused: bool) {}
    /// A janela filha guarda o foco do sistema depois de um clique nela; sem devolver, o que se digita na barra vai à página.
    pub fn release_focus(&self) { self.report(self.view.focus_parent()); }
}
