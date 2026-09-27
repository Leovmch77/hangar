//! Terminal da sessão e shell oculto, no rodapé da conversa.
use super::*;
use crate::{term_view::TermView, ws};
use std::{cell::Cell, rc::Rc};

actions!(terminal, [CopyTerminal, PasteTerminal]);

pub(super) enum Reply {
    Probe(u64, usize, u64, Result<(), Failure>),
    Shell(u64, u64, Result<Value, Failure>),
    Socket(u64, usize, u64, Result<ws::Event, ws::Error>),
}

enum Status { Connecting, Connected, Failed(String) }

struct Slot {
    name: String,
    view: TermView,
    socket: Option<ws::Terminal>,
    status: Status,
    generation: u64,
    bounds: Rc<Cell<Bounds<Pixels>>>,
    selecting: bool,
    fixture_loaded: bool,
    fixture_error: bool,
}

impl Slot {
    fn new(name: String, fixture: bool) -> Self {
        let result = fixture.then(|| TermView::from_fixture_env(80, 24)).transpose();
        let (view, status, fixture_loaded, fixture_error) = match result {
            Ok(Some(Some(view))) => (view, Status::Connecting, true, false),
            Ok(_) => (TermView::new(80, 24), Status::Connecting, false, false),
            Err(_) => (TermView::new(80, 24), Status::Failed(tr("term_fixture_error")), false, true),
        };
        Self { name, view, socket: None, status, generation: 0, bounds: Rc::new(Cell::new(Bounds::default())),
            selecting: false, fixture_loaded, fixture_error }
    }

    fn accepts_input(&self) -> bool {
        matches!(self.status, Status::Connected) && self.socket.is_some()
            || self.fixture_loaded && self.socket.is_none() && matches!(self.status, Status::Connected | Status::Failed(_))
    }
}

pub(super) struct Panel {
    id: u64,
    session: String,
    tabs: [Slot; 2],
    active: usize,
    focus: FocusHandle,
    height: f32,
    drag: Option<(f32, f32)>,
    maximized: bool,
    shell_pending: bool,
    shell_request: u64,
    shell_error: Option<String>,
    /// Quando abriu: o painel sobe do pé da janela nos primeiros 200 ms.
    opened: Instant,
}

impl Panel {
    fn new(id: u64, session: String, cx: &mut Context<Hangar>) -> Self {
        Self { id, tabs: [Slot::new(session.clone(), true), Slot::new(String::new(), false)], session,
            active: 0, focus: cx.focus_handle().tab_stop(true), height: 260., drag: None, maximized: false,
            shell_pending: false, shell_request: 0, shell_error: None, opened: Instant::now() }
    }
}

fn socket_error(error: ws::Error) -> String {
    match error {
        ws::Error::Http(404) => tr("term_missing"),
        ws::Error::Http(401 | 403) => tr("term_denied"),
        _ => tr("term_disconnected"),
    }
}

fn failure_message(error: Failure) -> String {
    if error.status == Some(404) { tr("term_missing") } else { Hangar::failure(&error) }
}

impl Hangar {
    pub(super) fn toggle_terminal(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.terminal.is_some() { self.close_terminal(true, window, cx); return; }
        let Some(session) = self.selected.as_ref().map(|s| s.name.clone()) else { return; };
        self.terminal_serial += 1;
        self.terminal = Some(Panel::new(self.terminal_serial, session, cx));
        self.terminal.as_ref().unwrap().focus.focus(window, cx);
        self.connect_terminal(0);
        cx.notify();
    }

    pub(super) fn close_terminal(&mut self, refocus: bool, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(mut panel) = self.terminal.take() {
            let inside = panel.focus.contains_focused(window, cx);
            for slot in &mut panel.tabs { if let Some(socket) = slot.socket.as_mut() { socket.close(); } }
            if refocus || inside { self.root_focus.focus(window, cx); }
            cx.notify();
        }
    }

    fn connect_terminal(&mut self, tab: usize) {
        let Some(panel) = self.terminal.as_mut() else { return; };
        let slot = &mut panel.tabs[tab];
        if slot.fixture_error { return; }
        if let Some(socket) = slot.socket.as_mut() { socket.close(); }
        slot.socket = None;
        slot.generation += 1;
        slot.status = Status::Connecting;
        let (id, generation, name) = (panel.id, slot.generation, slot.name.clone());
        let Some(api) = self.api.clone() else {
            slot.status = if slot.fixture_loaded { Status::Connected } else { Status::Failed(tr("term_disconnected")) };
            return;
        };
        // O Shell é oculto da lista de sessões; o POST que o criou já validou o alvo.
        if tab == 1 { self.open_terminal_socket(tab, id, generation); return; }
        let (connection, tx) = (self.connection, self.tx.clone());
        // Reqwest roda no Tokio; a resposta da leitura e o socket têm a mesma geração.
        self.runtime.spawn(async move {
            let result = api.sessions().await.and_then(|sessions| sessions.iter().any(|session| session.name == name)
                .then_some(()).ok_or_else(|| Failure { status: Some(404), ..Failure::local("session_missing") }));
            let _ = tx.send(Envelope { connection, selection: None,
                payload: Payload::Terminal(Reply::Probe(id, tab, generation, result)) }).await;
        });
    }

    fn open_terminal_socket(&mut self, tab: usize, id: u64, generation: u64) {
        let (Some(api), Some(panel)) = (self.api.as_ref(), self.terminal.as_mut()) else { return; };
        if panel.id != id || panel.tabs[tab].generation != generation { return; }
        let slot = &mut panel.tabs[tab];
        let (cols, rows) = slot.view.dimensions();
        let socket = ws::Terminal::open(self.runtime.handle(), api, &slot.name, self.active_token.clone(), cols, rows);
        let events = socket.events();
        slot.socket = Some(socket);
        let (connection, tx) = (self.connection, self.tx.clone());
        self.runtime.spawn(async move {
            while let Ok(event) = events.recv().await {
                if tx.send(Envelope { connection, selection: None,
                    payload: Payload::Terminal(Reply::Socket(id, tab, generation, event)) }).await.is_err() { break; }
            }
        });
    }

    fn show_shell(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(panel) = self.terminal.as_mut() else { return; };
        panel.active = 1;
        panel.focus.focus(window, cx);
        if panel.tabs[1].name.is_empty() && !panel.shell_pending {
            panel.shell_pending = true;
            panel.shell_error = None;
            panel.shell_request += 1;
            let (id, request, name) = (panel.id, panel.shell_request, panel.session.clone());
            if let Some(api) = self.api.clone() {
                let (connection, tx) = (self.connection, self.tx.clone());
                self.runtime.spawn(async move {
                    let result = api.act(&name, &["shell"], None, false, 15).await;
                    let _ = tx.send(Envelope { connection, selection: None,
                        payload: Payload::Terminal(Reply::Shell(id, request, result)) }).await;
                });
            } else {
                panel.shell_pending = false;
                panel.shell_error = Some(tr("term_disconnected"));
            }
        }
        cx.notify();
    }

    pub(super) fn receive_terminal(&mut self, reply: Reply, _window: &mut Window, cx: &mut Context<Self>) {
        match reply {
            Reply::Probe(id, tab, generation, result) => {
                let Some(panel) = self.terminal.as_mut().filter(|panel| panel.id == id && panel.tabs[tab].generation == generation) else { return; };
                match result {
                    Ok(()) => self.open_terminal_socket(tab, id, generation),
                    Err(error) => panel.tabs[tab].status = Status::Failed(failure_message(error)),
                }
            }
            Reply::Shell(id, request, result) => {
                let Some(panel) = self.terminal.as_mut().filter(|panel| panel.id == id && panel.shell_request == request) else { return; };
                panel.shell_pending = false;
                match result {
                    Ok(value) => match value.get("shell").and_then(Value::as_str).filter(|name| !name.is_empty()) {
                        Some(name) => { panel.tabs[1].name = name.to_owned(); self.connect_terminal(1); }
                        None => panel.shell_error = Some(tr("term_shell_error")),
                    },
                    Err(error) => panel.shell_error = Some(failure_message(error)),
                }
            }
            Reply::Socket(id, tab, generation, event) => {
                let Some(panel) = self.terminal.as_mut().filter(|panel| panel.id == id && panel.tabs[tab].generation == generation) else { return; };
                let slot = &mut panel.tabs[tab];
                match event {
                    Ok(ws::Event::Connected) => {
                        let (cols, rows) = slot.view.dimensions();
                        slot.view = TermView::new(cols as usize, rows as usize);
                        slot.bounds.set(Bounds::default());
                        slot.fixture_loaded = false;
                        slot.status = Status::Connected;
                    }
                    Ok(ws::Event::Data(bytes)) => { slot.view.feed(&bytes); Self::flush_terminal(slot); }
                    Ok(ws::Event::Closed) => { slot.socket = None; slot.status = Status::Failed(tr("term_disconnected")); }
                    Err(error) => { slot.socket = None; slot.status = Status::Failed(socket_error(error)); }
                }
            }
        }
        cx.notify();
    }

    fn flush_terminal(slot: &mut Slot) {
        if slot.socket.is_none() { return; }
        for bytes in slot.view.take_output() {
            if let Some(socket) = &slot.socket {
                if let Err(error) = socket.send(&bytes) { slot.status = Status::Failed(socket_error(error)); }
            }
        }
    }

    fn terminal_key(&mut self, event: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        let Some(panel) = self.terminal.as_mut() else { return; };
        if !panel.focus.is_focused(window) { return; }
        let mods = event.keystroke.modifiers;
        if mods.control && mods.shift && matches!(event.keystroke.key.as_str(), "c" | "v") {
            cx.stop_propagation();
            return;
        }
        let slot = &mut panel.tabs[panel.active];
        if !slot.accepts_input() {
            if event.keystroke.key == "tab" {
                if mods.shift { window.focus_prev(cx); } else { window.focus_next(cx); }
                cx.stop_propagation();
                return;
            }
            if !matches!(event.keystroke.key.as_str(), "escape" | "tab") { cx.stop_propagation(); }
            return;
        }
        let result = slot.view.key_down(event);
        if result.handled { Self::flush_terminal(slot); cx.stop_propagation(); }
        if result.redraw { cx.notify(); }
    }

    fn resize_terminal(&mut self, tab: usize, bounds: Bounds<Pixels>, window: &mut Window, cx: &mut Context<Self>) {
        let Some(panel) = self.terminal.as_mut() else { return; };
        let slot = &mut panel.tabs[tab];
        if slot.bounds.get() == bounds && !slot.view.typography_changed() { return; }
        slot.bounds.set(bounds);
        if slot.view.resize_to_bounds(bounds, window) {
            let (cols, rows) = slot.view.dimensions();
            if let Some(socket) = &slot.socket { if let Err(error) = socket.resize(cols, rows) { slot.status = Status::Failed(socket_error(error)); } }
            cx.notify();
        }
    }

    pub(super) fn terminal_dragging(&self) -> bool { self.terminal.as_ref().is_some_and(|panel| panel.drag.is_some()) }

    pub(super) fn drag_terminal(&mut self, y: f32, pressed: bool, window: &Window, cx: &mut Context<Self>) {
        let Some(panel) = self.terminal.as_mut() else { return; };
        let Some((start, height)) = panel.drag else { return; };
        if !pressed { panel.drag = None; cx.notify(); return; }
        panel.height = (height + start - y).clamp(120., (f32::from(window.viewport_size().height) - 120.).min(800.).max(120.));
        cx.notify();
    }

    pub(super) fn render_terminal(&mut self, window: &mut Window, cx: &mut Context<Self>) -> Option<AnyElement> {
        let panel = self.terminal.as_ref()?;
        // Abrindo, sobe do pé com a altura final: a conversa encolhe uma vez só, não a cada quadro.
        let rising = !panel.maximized && !cx.reduce_motion() && panel.opened.elapsed() < motion::RESIZE.total();
        if rising { motion::request_frame(window, cx); }
        let below = if rising { panel.height * (1. - motion::RESIZE.ease(motion::RESIZE.raw(panel.opened))) } else { 0. };
        let tab = panel.active;
        let slot = &panel.tabs[tab];
        let fixture_loaded = slot.fixture_loaded;
        let bounds = slot.bounds.clone();
        let typography_changed = slot.view.typography_changed();
        let entity = cx.entity();
        let message = if tab == 1 && slot.name.is_empty() {
            panel.shell_error.clone().or_else(|| Some(tr("term_opening_shell")))
        } else { match &slot.status { Status::Connecting => Some(tr("term_connecting")),
            Status::Connected => None, Status::Failed(message) => Some(message.clone()) } };
        let failed = tab == 1 && panel.shell_error.is_some() || matches!(slot.status, Status::Failed(_));
        let body = div().id("terminal-grid").role(Role::Term).aria_label(tr("term_toggle"))
            .track_focus(&panel.focus).key_context("Terminal").relative().flex_1().min_h_0().overflow_hidden()
            .bg(theme::background()).child(slot.view.element())
            .child(canvas(move |area, window, cx| {
                if bounds.get() != area || typography_changed {
                    let entity = entity.clone();
                    window.defer(cx, move |window, cx| entity.update(cx, |this, cx| this.resize_terminal(tab, area, window, cx)));
                }
            }, |_, _, _, _| {}).absolute().inset_0())
            .on_mouse_down(MouseButton::Left, cx.listener(|this, event: &MouseDownEvent, window, cx| {
                let Some(panel) = this.terminal.as_mut() else { return; };
                panel.focus.focus(window, cx);
                let slot = &mut panel.tabs[panel.active];
                let at = event.position - slot.bounds.get().origin;
                slot.selecting = true;
                if slot.view.mouse_down(f32::from(at.x), f32::from(at.y), event.click_count) { cx.notify(); }
            }))
            .on_mouse_move(cx.listener(|this, event: &MouseMoveEvent, _, cx| {
                let Some(panel) = this.terminal.as_mut() else { return; };
                let slot = &mut panel.tabs[panel.active];
                if !slot.selecting { return; }
                if event.pressed_button != Some(MouseButton::Left) { slot.selecting = false; slot.view.mouse_up(); return; }
                let at = event.position - slot.bounds.get().origin;
                if slot.view.mouse_drag(f32::from(at.x), f32::from(at.y)) { cx.notify(); }
            }))
            .on_mouse_up(MouseButton::Left, cx.listener(|this, _, _, _| {
                if let Some(panel) = this.terminal.as_mut() { let slot = &mut panel.tabs[panel.active]; slot.selecting = false; slot.view.mouse_up(); }
            }))
            .on_scroll_wheel(cx.listener(|this, event: &ScrollWheelEvent, _, cx| {
                if let Some(panel) = this.terminal.as_mut() {
                    if panel.tabs[panel.active].view.scroll_wheel(event) { cx.notify(); }
                }
            }))
            .on_action(cx.listener(|this, _: &CopyTerminal, _, cx| {
                if let Some(panel) = this.terminal.as_ref() {
                    if let Some(text) = panel.tabs[panel.active].view.selected_text() { cx.write_to_clipboard(ClipboardItem::new_string(text)); }
                }
            }))
            .on_action(cx.listener(|this, _: &PasteTerminal, _, cx| {
                if let Some(panel) = this.terminal.as_mut() {
                    if !panel.tabs[panel.active].accepts_input() { return; }
                    if let Some(text) = cx.read_from_clipboard().and_then(|item| item.text()) {
                        let slot = &mut panel.tabs[panel.active];
                        if slot.view.paste(&text) { cx.notify(); }
                        Self::flush_terminal(slot);
                    }
                }
            }))
            .on_key_down(cx.listener(|this, event: &KeyDownEvent, window, cx| this.terminal_key(event, window, cx)))
            .when_some(message, |el, message| {
                let notice = div().id("terminal-status").role(if failed { Role::Alert } else { Role::Status })
                    .absolute().text_color(if failed { theme::warning() } else { theme::muted() }).child(message);
                el.child(if fixture_loaded && failed { notice.top_0().right_0().p_2().bg(theme::raised()) }
                    else { notice.inset_0().flex().items_center().justify_center().bg(theme::background()) })
            });
        let header = div().h(px(38.)).flex_shrink_0().flex().items_center().gap_1().px_2()
            .bg(theme::raised()).border_b_1().border_color(theme::border())
            .child(Button::new("term-session").ghost().small().selected(tab == 0).label(panel.session.clone())
                .on_click(cx.listener(|this, _, window, cx| {
                    if let Some(panel) = this.terminal.as_mut() { panel.active = 0; panel.focus.focus(window, cx); cx.notify(); }
                })))
            .child(Button::new("term-shell").ghost().small().selected(tab == 1).label(tr("term_shell"))
                .on_click(cx.listener(|this, _, window, cx| this.show_shell(window, cx))))
            .child(div().flex_1())
            .when(failed, |el| el.child(Button::new("term-reconnect").ghost().small().icon(IconName::RefreshCw)
                .label(tr("term_reconnect")).on_click(cx.listener(|this, _, window, cx| {
                    if let Some(panel) = this.terminal.as_ref() {
                        if panel.active == 1 && panel.tabs[1].name.is_empty() { this.show_shell(window, cx); }
                        else { let tab = panel.active; this.connect_terminal(tab); cx.notify(); }
                    }
                }))))
            .child(chrome::icon_button("term-max", IconName::Maximize,
                tr(if panel.maximized { "term_restore" } else { "term_maximize" }), cx)
                .on_click(cx.listener(|this, _, window, cx| {
                    if let Some(panel) = this.terminal.as_mut() { panel.maximized = !panel.maximized; panel.focus.focus(window, cx); cx.notify(); }
                    cx.stop_propagation();
                })))
            .child(Button::new("term-close").ghost().small().label("✕").accessibility_label(tr("term_close"))
                .on_click(cx.listener(|this, _, window, cx| this.close_terminal(true, window, cx))));
        let terminal = div().id("terminal-panel")
            .when(panel.maximized, |el| el.absolute().inset_0().occlude())
            .when(!panel.maximized, |el| el.h(px(panel.height)).flex_shrink_0())
            .flex().flex_col().min_h_0().border_t_1().border_color(theme::border()).bg(theme::background())
            .when(!panel.maximized, |el| el.child(div().id("term-resize").h(px(6.)).flex_shrink_0().cursor_row_resize()
                .on_mouse_down(MouseButton::Left, cx.listener(|this, event: &MouseDownEvent, _, cx| {
                    if let Some(panel) = this.terminal.as_mut() { panel.drag = Some((f32::from(event.position.y), panel.height)); cx.notify(); }
                }))))
            .child(header).child(body);
        Some(if rising {
            div().h(px(panel.height)).flex_shrink_0().overflow_hidden().child(terminal.relative().top(px(below))).into_any_element()
        } else { terminal.into_any_element() })
    }
}
