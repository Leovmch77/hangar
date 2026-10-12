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
    #[cfg(target_os = "windows")]
    pending: PendingDialog,
    /// Escondida de verdade por estar parada (ver `sleep`).
    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    asleep: Cell<bool>,
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
        let pending: PendingDialog = Rc::default();
        #[cfg(target_os = "windows")]
        let watch = {
            use wry::WebViewExtWindows;
            let cdp = Rc::new(super::cdp::Cdp::new(view.webview()));
            let (dead, state, events, held) = (dead.clone(), state.clone(), events.clone(), pending.clone());
            let listened = cdp.on("Inspector.targetCrashed", move |_| {
                dead.set(true);
                release_dialog(&held);
                let mut page = state.borrow_mut();
                (page.loading, page.error, page.dialog) = (false, Some(crate::i18n::tr("browser_err_crashed")), None);
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
            watch_native(&view, &on_native.0, &on_native.1, &pending);
            match listened {
                Ok(()) => {
                    drop(cdp.call("Page.enable", serde_json::json!({})));
                    drop(cdp.call("Inspector.enable", serde_json::json!({})));
                    Some(cdp)
                }
                Err(e) => { eprintln!("[nav] queda da pagina sem ouvinte: {e}"); None }
            }
        };
        let engine = Engine { view, _context: context, state, events, placed: Cell::new(None), asleep: Cell::new(false), dead, #[cfg(target_os = "windows")] _watch: watch, #[cfg(target_os = "windows")] pending };
        #[cfg(target_os = "windows")]
        engine.park();
        Ok(engine)
    }
}

/// Diálogo segurado pelo `GetDeferral` até alguém responder.
#[cfg(target_os = "windows")]
type PendingDialog = Rc<RefCell<Option<(webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2ScriptDialogOpeningEventArgs,
    webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Deferral)>>>;

/// Solta o diálogo segurado, recusado. Quem esquece o diálogo (navegação, queda, página revivida) tem de soltá-lo:
/// com o `GetDeferral` aberto o WebView2 deixa a página parada e não entrega mais clique nem tecla.
#[cfg(target_os = "windows")]
fn release_dialog(pending: &PendingDialog) {
    let Some((_, deferral)) = pending.borrow_mut().take() else { return };
    // SAFETY: thread da interface; `Complete` sem `Accept` recusa o diálogo.
    if let Err(e) = unsafe { deferral.Complete() } { eprintln!("[nav] dialogo esquecido nao foi solto: {}", e.message()); }
}

/// Diálogos e início de navegação pelo próprio WebView2. O diálogo padrão dele é janela modal que ninguém responde
/// quando é o agente que o dispara: o `click` e todo verbo seguinte esperavam o prazo inteiro. Aqui, como no Linux,
/// `alert`/`beforeunload` passam, `confirm`/`prompt` são recusados, e a pessoa vê o aviso no painel. O `Started` do
/// wry só chega com a resposta: sem o `NavigationStarting`, página lenta nunca mostrava o Parar.
#[cfg(target_os = "windows")]
fn watch_native(view: &WebView, state: &Rc<RefCell<model::PageState>>, events: &async_channel::Sender<Event>, pending: &PendingDialog) {
    use webview2_com::{NavigationStartingEventHandler, ScriptDialogOpeningEventHandler, take_pwstr, Microsoft::Web::WebView2::Win32::{
        COREWEBVIEW2_SCRIPT_DIALOG_KIND, COREWEBVIEW2_SCRIPT_DIALOG_KIND_ALERT, COREWEBVIEW2_SCRIPT_DIALOG_KIND_BEFOREUNLOAD,
        COREWEBVIEW2_SCRIPT_DIALOG_KIND_PROMPT}};
    use wry::WebViewExtWindows;
    let core = view.webview();
    // SAFETY: thread da interface, dona do WebView2.
    if let Err(e) = unsafe { core.Settings().and_then(|s| s.SetAreDefaultScriptDialogsEnabled(false)) } {
        eprintln!("[nav] dialogo padrao do WebView2 continua ligado: {}", e.message());
    }
    let (st, ev, held) = (state.clone(), events.clone(), pending.clone());
    let dialogs = ScriptDialogOpeningEventHandler::create(Box::new(move |_, args| {
        let Some(args) = args else { return Ok(()) };
        let mut kind = COREWEBVIEW2_SCRIPT_DIALOG_KIND::default();
        let (mut raw, mut default) = (windows::core::PWSTR::null(), windows::core::PWSTR::null());
        // SAFETY: o WebView2 aloca as strings; `take_pwstr` as libera.
        unsafe { args.Kind(&mut kind)?; args.Message(&mut raw)?; args.DefaultText(&mut default)?; }
        let (message, default) = (take_pwstr(raw).chars().take(500).collect::<String>(), take_pwstr(default));
        // A navegação não espera ninguém.
        if kind == COREWEBVIEW2_SCRIPT_DIALOG_KIND_BEFOREUNLOAD { return unsafe { args.Accept() }; }
        let name = if kind == COREWEBVIEW2_SCRIPT_DIALOG_KIND_ALERT { "alert" } else if kind == COREWEBVIEW2_SCRIPT_DIALOG_KIND_PROMPT { "prompt" } else { "confirm" };
        // Segura o diálogo aberto até o agente ou a pessoa responder (`answer_dialog`).
        let deferral = unsafe { args.GetDeferral()? };
        // Um segundo diálogo (iframe de outro processo) não pode deixar o primeiro preso.
        release_dialog(&held);
        *held.borrow_mut() = Some((args, deferral));
        let mut page = st.borrow_mut();
        page.dialog = Some(model::Dialog { kind: name.into(), message, default });
        send(&ev, &page);
        Ok(())
    }));
    let (st, ev, held) = (state.clone(), events.clone(), pending.clone());
    let starting = NavigationStartingEventHandler::create(Box::new(move |_, args| {
        // O handler do wry roda antes e cancela endereço bloqueado: aí não há carga para mostrar.
        let mut cancel = windows::core::BOOL::default();
        let mut uri = windows::core::PWSTR::null();
        if let Some(args) = &args { unsafe { args.Cancel(&mut cancel)?; args.Uri(&mut uri)?; } }
        // SAFETY: o WebView2 aloca o endereço; `take_pwstr` o libera.
        let uri = if uri.is_null() { String::new() } else { take_pwstr(uri) };
        if cancel.as_bool() { return Ok(()); }
        let mut page = st.borrow_mut();
        // O endereço pedido já na barra: o estado anterior ainda tinha o da página que está saindo.
        if !uri.is_empty() { page.url = Some(uri); }
        page.loading = true;
        page.dialog = None;
        send(&ev, &page);
        drop(page);
        release_dialog(&held);
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

    /// Responde o diálogo segurado e tira a caixa do painel.
    #[cfg(target_os = "windows")]
    pub fn answer_dialog(&self, accept: bool, text: Option<&str>) -> impl std::future::Future<Output = Result<(), String>> + 'static + use<> {
        let Some((args, deferral)) = self.pending.borrow_mut().take() else { return std::future::ready(Err("nenhum dialogo aberto na pagina".into())) };
        // SAFETY: thread da interface; `Complete` solta o diálogo segurado no `GetDeferral`.
        // `Complete` sempre: sem ele a página fica parada no diálogo, mesmo que o texto ou o aceite tenham falhado.
        let answered = unsafe {
            (|| {
                match text {
                    // `CoTaskMemPWSTR` de texto vazio é ponteiro nulo, que o WebView2 recusa.
                    Some("") => args.SetResultText(windows::core::w!(""))?,
                    Some(text) => { let t = webview2_com::CoTaskMemPWSTR::from(text); args.SetResultText(*t.as_ref().as_pcwstr())? }
                    None => {}
                }
                if accept { args.Accept()?; }
                Ok::<(), windows::core::Error>(())
            })()
        };
        let completed = unsafe { deferral.Complete() };
        let mut page = self.state.borrow_mut();
        page.dialog = None;
        send(&self.events, &page);
        // Aceite ou texto que falharam viram recusa na página: quem respondeu tem de saber.
        std::future::ready(match (answered, completed) {
            (Ok(()), Ok(())) => Ok(()),
            (Err(e), _) | (_, Err(e)) => Err(e.message().to_string()),
        })
    }
    #[cfg(not(target_os = "windows"))]
    pub fn answer_dialog(&self, _accept: bool, _text: Option<&str>) -> impl std::future::Future<Output = Result<(), String>> + 'static + use<> {
        std::future::ready(Err("este sistema nao tem dialogo segurado".to_string()))
    }

    /// Página que caiu volta com `Reload` no mesmo WebView2: o processo da página renasce e o histórico fica.
    pub fn revive(&self) {
        self.dead.set(false);
        #[cfg(target_os = "windows")]
        release_dialog(&self.pending);
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
        if hidden { self.report(self.view.set_visible(true)); self.asleep.set(false); }
    }

    /// Estacionada e sem uso: escondida de verdade, o WebView2 para de compor quadros que ninguém vê.
    #[cfg(target_os = "windows")]
    pub fn sleep(&self) {
        if self.placed.get().is_none() && !self.asleep.replace(true) { self.report(self.view.set_visible(false)); }
    }

    /// Estaciona de novo, visível, antes de um verbo. Devolve se estava dormindo: aí o WebView2 precisa de um instante
    /// para voltar a compor antes de receber clique e tecla.
    #[cfg(target_os = "windows")]
    pub fn wake(&self) -> bool {
        if !self.asleep.replace(false) { return false; }
        self.park();
        true
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
