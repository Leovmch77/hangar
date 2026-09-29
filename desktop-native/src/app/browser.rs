//! Navegador do painel lateral: barra com voltar, avançar, recarregar e endereço, e a página embaixo.
//! O comportamento da barra (Enter navega, Esc desiste e devolve à página) vem do Zeron (MIT, crates/ui/src/browser/view.rs).
use std::{cell::Cell, rc::Rc};

use super::*;
use crate::appearance::SideTab;
use crate::browser::{Engine, Pointer, model};

pub(super) struct BrowserPanel {
    /// Nasce na primeira navegação, que tem a janela. No Linux só cabe um por processo: falhou, não tenta de novo.
    engine: Option<Result<Rc<Engine>, String>>,
    /// Endereço a abrir quando o motor terminar de nascer; `Some` enquanto ele nasce.
    starting: Option<String>,
    _start: Option<Task<()>>,
    events: async_channel::Sender<crate::browser::Event>,
    address: Entity<InputState>,
    page: model::PageState,
    /// Endereço recusado, mostrado embaixo da barra.
    invalid: Option<String>,
    focus: FocusHandle,
    /// Origem da página no último desenho: o ponteiro chega ao motor relativo a ela.
    origin: Rc<Cell<Point<Pixels>>>,
    /// Decidido pelo `Hangar` a cada quadro (`browser_visible`).
    shown: bool,
    _drain: Task<()>,
    _subscriptions: [Subscription; 4],
}

impl BrowserPanel {
    fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let (events, received) = async_channel::unbounded();
        let address = cx.new(|cx| InputState::new(window, cx).placeholder(tr("browser_address")));
        let focus = cx.focus_handle();
        let drain = cx.spawn_in(window, async move |this, cx| {
            while let Ok(event) = received.recv().await {
                if this.update_in(cx, |this, window, cx| this.receive(event, window, cx)).is_err() { break; }
            }
        });
        let address_focus = address.focus_handle(cx);
        let subscriptions = [
            cx.subscribe_in(&address, window, |this, _, event: &InputEvent, window, cx| {
                if let InputEvent::PressEnter { .. } = event { this.submit(window, cx); }
            }),
            cx.on_focus(&address_focus, window, |this, _, _| if let Some(engine) = this.engine() { engine.release_focus() }),
            cx.on_focus(&focus, window, |this, _, _| if let Some(engine) = this.engine() { engine.focus(true) }),
            cx.on_blur(&focus, window, |this, _, _| if let Some(engine) = this.engine() { engine.focus(false) }),
        ];
        Self { engine: None, starting: None, _start: None, events, address, page: model::PageState::default(), invalid: None, focus,
            origin: Rc::default(), shown: false, _drain: drain, _subscriptions: subscriptions }
    }

    fn engine(&self) -> Option<&Rc<Engine>> { self.engine.as_ref()?.as_ref().ok() }

    fn receive(&mut self, event: crate::browser::Event, window: &mut Window, cx: &mut Context<Self>) {
        if let crate::browser::Event::State(page) = event {
            // Quem está digitando no endereço não perde o texto para a página que acabou de carregar.
            let url = page.url.clone().unwrap_or_default();
            if !self.address.focus_handle(cx).is_focused(window) && self.address.read(cx).value() != url {
                self.address.update(cx, |input, cx| input.set_value(url, window, cx));
            }
            self.page = page;
        }
        cx.notify();
    }

    fn submit(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let text = self.address.read(cx).value().to_string();
        match model::normalize_address(&text) {
            Err(key) => self.invalid = Some(tr(key)),
            Ok(url) => {
                self.invalid = None;
                if self.engine.is_some() {
                    self.navigate(url, window, cx);
                } else if self.starting.replace(url).is_none() {
                    // Enter repetido enquanto o motor nasce só troca o endereço pendente.
                    self.start(window, cx);
                }
            }
        }
        cx.notify();
    }

    fn navigate(&mut self, url: String, window: &mut Window, cx: &mut Context<Self>) {
        let Some(engine) = self.engine() else { return };
        engine.load(&url);
        self.address.update(cx, |input, cx| input.set_value(url, window, cx));
        self.focus.focus(window, cx);
    }

    fn start(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let starter = Engine::prepare(window);
        let events = self.events.clone();
        self._start = Some(cx.spawn_in(window, async move |this, cx| {
            // Corpo da tarefa, fora de `update`: a App não está emprestada, então o laço de mensagens que o WebView2
            // roda até nascer pode executar outras tarefas da GPUI sem pânico.
            let engine = starter.and_then(|starter| starter.start(events)).map(Rc::new);
            // Painel fechado no meio: o motor cai junto com o resultado.
            let _ = this.update_in(cx, |this, window, cx| {
                this.engine = Some(engine);
                if let Some(url) = this.starting.take() { this.navigate(url, window, cx); }
                cx.notify();
            });
        }));
    }

    fn restore_address(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let url = self.page.url.clone().unwrap_or_default();
        self.address.update(cx, |input, cx| input.set_value(url, window, cx));
        self.invalid = None;
        self.focus.focus(window, cx);
        cx.notify();
    }

    /// Clique na GPUI com a página nativa segurando o foco do sistema: sem isto o teclado (Esc, atalhos) seguiria
    /// indo para a página.
    pub(super) fn release_focus(&self) {
        if let Some(engine) = self.engine() { engine.release_focus() }
    }

    pub(super) fn focus_address(&self, window: &mut Window, cx: &mut App) {
        self.address.update(cx, |input, cx| input.focus(window, cx));
    }

    /// Diz se mudou. Escondida, a página não se posiciona no desenho e a janela nativa some.
    fn set_shown(&mut self, shown: bool) -> bool {
        if self.shown == shown { return false; }
        self.shown = shown;
        if !shown && let Some(engine) = self.engine() { engine.hide(); }
        true
    }

    fn pointer(&self, kind: Pointer, at: Point<Pixels>, clicks: usize) {
        if let Some(engine) = self.engine() { engine.pointer(kind, at - self.origin.get(), clicks); }
    }

    fn render_page(&self, cx: &mut Context<Self>) -> AnyElement {
        let page = div().id("browser-page").relative().flex_1().min_h_0().overflow_hidden()
            .track_focus(&self.focus).key_context("BrowserPage");
        let note = |text: String, color: Hsla| div().size_full().flex().items_center().justify_center().p_4()
            .text_size(px(12.)).text_color(color).text_center().whitespace_normal().child(text);
        let engine = match &self.engine {
            None if self.starting.is_some() => return page.role(Role::Status).child(note(tr("loading"), theme::muted())).into_any_element(),
            None => return page.child(note(tr("browser_empty"), theme::faint())).into_any_element(),
            Some(Err(error)) => return page.role(Role::Alert)
                .child(note(tr("browser_failed").replace("{error}", error), theme::warning())).into_any_element(),
            Some(Ok(engine)) => engine.clone(),
        };
        // Sem página nenhuma, o erro da primeira carga é o conteúdo; com página, o motor mostra a dele.
        if let (None, Some(error)) = (&self.page.url, &self.page.error) {
            return page.role(Role::Alert).child(note(error.clone(), theme::warning())).into_any_element();
        }
        let origin = self.origin.clone();
        let label = if self.page.title.trim().is_empty() { tr("browser") } else { self.page.title.clone() };
        page.bg(theme::background()).aria_label(label)
            .when(self.shown, |el| el.child(canvas(|_, _, _| {}, move |bounds, _, window, _| {
                origin.set(bounds.origin);
                engine.place(bounds, window);
            }).absolute().inset_0()))
            .on_mouse_down(MouseButton::Left, cx.listener(|this, event: &MouseDownEvent, window, cx| {
                this.focus.focus(window, cx);
                this.pointer(Pointer::Down, event.position, event.click_count);
            }))
            .on_mouse_up(MouseButton::Left, cx.listener(|this, event: &MouseUpEvent, _, _| this.pointer(Pointer::Up, event.position, 0)))
            // Soltar fora da página ainda termina o arrasto começado nela.
            .on_mouse_up_out(MouseButton::Left, cx.listener(|this, event: &MouseUpEvent, _, _| this.pointer(Pointer::Up, event.position, 0)))
            .on_mouse_move(cx.listener(|this, event: &MouseMoveEvent, _, _| this.pointer(Pointer::Move, event.position, 0)))
            .on_scroll_wheel(cx.listener(|this, event: &ScrollWheelEvent, _, _| {
                let Some(engine) = this.engine() else { return };
                let delta = event.delta.pixel_delta(px(16.));
                // A GPUI manda o sinal oposto ao do motor.
                engine.wheel(event.position - this.origin.get(), point(-delta.x, -delta.y));
            }))
            // A tecla é da página: os atalhos do app (Esc, "/") não comem o que se digita nela.
            .on_key_down(cx.listener(|this, event: &KeyDownEvent, _, cx| {
                if let Some(engine) = this.engine() { engine.key(true, &event.keystroke); }
                cx.stop_propagation();
            }))
            .on_key_up(cx.listener(|this, event: &KeyUpEvent, _, cx| {
                if let Some(engine) = this.engine() { engine.key(false, &event.keystroke); }
                cx.stop_propagation();
            }))
            .into_any_element()
    }
}

impl Render for BrowserPanel {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let ready = self.engine().is_some();
        let back = chrome::icon_button("browser-back", IconName::ArrowLeft, tr("browser_back"), cx)
            .disabled(!ready || !self.page.can_back)
            .on_click(cx.listener(|this, _, _, _| if let Some(engine) = this.engine() { engine.back() }));
        let forward = chrome::icon_button("browser-forward", IconName::ArrowRight, tr("browser_forward"), cx)
            .disabled(!ready || !self.page.can_forward)
            .on_click(cx.listener(|this, _, _, _| if let Some(engine) = this.engine() { engine.forward() }));
        let reload = chrome::icon_button("browser-reload", IconName::RotateCw, tr("browser_reload"), cx)
            .disabled(!ready || self.page.url.is_none())
            .on_click(cx.listener(|this, _, _, _| if let Some(engine) = this.engine() { engine.reload() }));
        let address = div().flex_1().min_w_0()
            .capture_action(cx.listener(|this, _: &Escape, window, cx| { cx.stop_propagation(); this.restore_address(window, cx); }))
            .child(Input::new(&self.address).id("browser-address").small().aria_label(tr("browser_address"))
                .when(self.page.loading, |el| el.suffix(chrome::Spinner::new("browser-loading", IconName::LoaderCircle, px(12.), theme::muted()))));
        let toolbar = div().id("browser-toolbar").flex_shrink_0().flex().items_center().gap_1().px_2().py(px(6.))
            .border_b_1().border_color(theme::border())
            .child(back).child(forward).child(reload).child(address);
        // Com a página na tela, a falha dela fica numa linha; sem página, `render_page` a mostra no lugar dela.
        let notice = self.invalid.clone().or_else(|| self.page.error.clone().filter(|_| ready && self.page.url.is_some()));
        div().size_full().flex().flex_col()
            .child(toolbar)
            .when_some(notice, |el, text| el.child(div().id("browser-notice").flex_shrink_0().px_3().py(px(6.)).role(Role::Alert)
                .text_size(px(11.)).text_color(theme::danger()).whitespace_normal().child(text)))
            .child(self.render_page(cx))
    }
}

impl Hangar {
    /// Linha Navegador do menu do painel: abre o navegador na primeira vez e leva à aba dele.
    pub(super) fn open_browser(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let browser = self.side.browser.get_or_insert_with(|| cx.new(|cx| BrowserPanel::new(window, cx))).clone();
        self.choose_side_tab(SideTab::Browser, window, cx);
        browser.update(cx, |panel, cx| panel.focus_address(window, cx));
    }

    /// No Windows e no macOS a página é uma janela filha, por cima de tudo o que a GPUI desenha: qualquer camada sobre o
    /// painel a esconde. Cobre o painel fora de vista (fechado, estreito, sem sessão, visor de arquivos expandido), outra
    /// aba à frente (menu, subagente), as páginas de Configurações e Custos, a caixa de configurações ao vivo, a conexão,
    /// a busca, os painéis presos ao compositor e à barra do topo, os diálogos e folhas do kit e as notificações. No
    /// Linux a página é desenhada pela própria GPUI, e as camadas passam por cima dela sem precisar escondê-la.
    fn browser_visible(&self, window: &mut Window, cx: &mut App) -> bool {
        let covered = cfg!(not(target_os = "linux")) && (self.connection_dialog || self.search.open || self.popup_open()
            || window.has_active_dialog(cx) || window.has_active_sheet(cx) || !window.notifications(cx).is_empty());
        self.side_width(window).is_some() && !self.files_expanded()
            && !self.side_menu_shown() && !self.subagent_tab_open() && self.side_tab() == SideTab::Browser
            && self.settings.is_none() && self.costs.view.is_none() && !covered
    }

    /// A cada quadro da janela, antes das áreas guardadas desenharem.
    pub(super) fn sync_browser(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(browser) = self.side.browser.clone() else { return };
        let shown = self.browser_visible(window, cx);
        if browser.update(cx, |panel, _| panel.set_shown(shown)) && shown {
            // O painel é guardado entre quadros: sem um redesenho dele, a página não volta a se posicionar.
            let id = browser.entity_id();
            window.on_next_frame(move |_, cx| cx.notify(id));
        }
    }
}
