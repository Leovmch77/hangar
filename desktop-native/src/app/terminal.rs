//! Terminal da sessão, shell oculto e terminais dos atalhos, no rodapé da conversa.
use super::*;
use crate::{term_view::TermView, ws};
use std::{cell::Cell, rc::Rc};

actions!(terminal, [CopyTerminal, PasteTerminal]);

/// Respostas carregam o `uid` da aba, não a posição: aba de atalho entra e sai no meio da fila.
pub(super) enum Reply {
    Probe(u64, u64, u64, Result<(), Failure>),
    Shell(u64, u64, Result<Value, Failure>),
    Socket(u64, u64, u64, Result<ws::Event, ws::Error>),
    /// Lista de terminais de atalho da sessão `name` (lida ao abrir o painel, ao escolher a sessão e depois de rodar/fechar).
    List(String, Result<Value, Failure>),
    Closed(String, Result<Value, Failure>),
}

/// Terminal escondido de um atalho shell (`GET /shortcut-terminals`). Fica depois que o comando sai, com a saída na tela.
#[derive(Clone, Debug, PartialEq)]
pub(super) struct ShortcutTerm { pub id: String, pub label: String, pub alive: bool, pub exit_code: Option<i64> }

pub(super) fn parse_shortcut_terms(value: &Value) -> Vec<ShortcutTerm> {
    value.get("terminals").and_then(Value::as_array).map(|list| list.iter().filter_map(|t| Some(ShortcutTerm {
        id: t.get("id")?.as_str()?.to_owned(),
        label: t.get("label").and_then(Value::as_str).unwrap_or("").to_owned(),
        alive: t.get("alive").and_then(Value::as_bool).unwrap_or(true),
        exit_code: t.get("exit_code").and_then(Value::as_i64),
    })).collect()).unwrap_or_default()
}

enum Status { Connecting, Connected, Failed(String) }

#[derive(Clone, PartialEq)]
enum Kind { Session, Shell, Shortcut(ShortcutTerm) }

struct Slot {
    uid: u64,
    kind: Kind,
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
    fn new(uid: u64, kind: Kind, name: String, fixture: bool) -> Self {
        let result = fixture.then(|| TermView::from_fixture_env(80, 24)).transpose();
        let (view, status, fixture_loaded, fixture_error) = match result {
            Ok(Some(Some(view))) => (view, Status::Connecting, true, false),
            Ok(_) => (TermView::new(80, 24), Status::Connecting, false, false),
            Err(_) => (TermView::new(80, 24), Status::Failed(tr("term_fixture_error")), false, true),
        };
        Self { uid, kind, name, view, socket: None, status, generation: 0, bounds: Rc::new(Cell::new(Bounds::default())),
            selecting: false, fixture_loaded, fixture_error }
    }

    fn shortcut(&self) -> Option<&ShortcutTerm> { if let Kind::Shortcut(term) = &self.kind { Some(term) } else { None } }

    fn accepts_input(&self) -> bool {
        matches!(self.status, Status::Connected) && self.socket.is_some()
            || self.fixture_loaded && self.socket.is_none() && matches!(self.status, Status::Connected | Status::Failed(_))
    }
}

pub(super) struct Panel {
    id: u64,
    session: String,
    /// Sessão sem pane nasce sem aba da sessão nem Shell: só os terminais dos atalhos.
    tabs: Vec<Slot>,
    next_uid: u64,
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
    fn new(id: u64, session: String, headless: bool, cx: &mut Context<Hangar>) -> Self {
        let tabs = if headless { Vec::new() }
            else { vec![Slot::new(0, Kind::Session, session.clone(), true), Slot::new(1, Kind::Shell, String::new(), false)] };
        Self { id, tabs, next_uid: 2, session,
            active: 0, focus: cx.focus_handle().tab_stop(true), height: 260., drag: None, maximized: false,
            shell_pending: false, shell_request: 0, shell_error: None, opened: Instant::now() }
    }

    fn index(&self, uid: u64) -> Option<usize> { self.tabs.iter().position(|slot| slot.uid == uid) }

    fn shell_index(&self) -> Option<usize> { self.tabs.iter().position(|slot| slot.kind == Kind::Shell) }

    /// Acerta as abas de atalho com a lista do servidor: novas entram no fim, as que sumiram saem. Devolve os `uid`
    /// das novas, para conectar.
    fn sync(&mut self, terms: &[ShortcutTerm]) -> Vec<u64> {
        let active_uid = self.tabs.get(self.active).map(|slot| slot.uid);
        self.tabs.retain_mut(|slot| match &slot.kind {
            Kind::Shortcut(term) if !terms.iter().any(|t| t.id == term.id) => {
                if let Some(socket) = slot.socket.as_mut() { socket.close(); }
                false
            }
            _ => true,
        });
        let mut added = Vec::new();
        for term in terms {
            if let Some(slot) = self.tabs.iter_mut().find(|slot| slot.shortcut().is_some_and(|t| t.id == term.id)) {
                slot.kind = Kind::Shortcut(term.clone());
                continue;
            }
            let uid = self.next_uid;
            self.next_uid += 1;
            self.tabs.push(Slot::new(uid, Kind::Shortcut(term.clone()), self.session.clone(), false));
            added.push(uid);
        }
        self.active = active_uid.and_then(|uid| self.index(uid)).unwrap_or(0).min(self.tabs.len().saturating_sub(1));
        added
    }

    fn select_shortcut(&mut self, id: &str) -> bool {
        match self.tabs.iter().position(|slot| slot.shortcut().is_some_and(|t| t.id == id)) {
            Some(index) => { self.active = index; true }
            None => false,
        }
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
        let Some((session, headless)) = self.selected.as_ref().map(|s| (s.name.clone(), s.headless)) else { return; };
        self.terminal_serial += 1;
        self.terminal = Some(Panel::new(self.terminal_serial, session.clone(), headless, cx));
        self.terminal.as_ref().unwrap().focus.focus(window, cx);
        if !headless { self.connect_terminal(0); }
        self.sync_shortcut_tabs();
        self.refresh_shortcut_terms(&session);
        cx.notify();
    }

    /// Terminais de atalho da sessão `name`, lidos do backend. A resposta atualiza a lista e as abas do painel.
    pub(super) fn refresh_shortcut_terms(&mut self, name: &str) {
        let Some(api) = self.api.clone() else { return; };
        let (connection, tx, name) = (self.connection, self.tx.clone(), name.to_owned());
        self.runtime.spawn(async move {
            let result = api.read(&name, &["shortcut-terminals"], &[], 10).await;
            let _ = tx.send(Envelope { connection, selection: None, payload: Payload::Terminal(Reply::List(name, result)) }).await;
        });
    }

    /// Releitura adiada da lista, no máximo uma a cada 5 s por sessão.
    fn recheck_shortcut_terms(&mut self, name: &str) {
        let now = std::time::Instant::now();
        if self.side.shortcut_recheck.get(name).is_some_and(|at| now.duration_since(*at) < std::time::Duration::from_secs(5)) { return; }
        self.side.shortcut_recheck.insert(name.to_owned(), now);
        let Some(api) = self.api.clone() else { return; };
        let (connection, tx, name) = (self.connection, self.tx.clone(), name.to_owned());
        self.runtime.spawn(async move {
            tokio::time::sleep(std::time::Duration::from_secs(5)).await;
            let result = api.read(&name, &["shortcut-terminals"], &[], 10).await;
            let _ = tx.send(Envelope { connection, selection: None, payload: Payload::Terminal(Reply::List(name, result)) }).await;
        });
    }

    /// Sessão aberta tem terminal de atalho? É o que mostra o botão de terminal numa sessão sem pane.
    pub(super) fn has_shortcut_terms(&self) -> bool {
        self.selected.as_ref().and_then(|s| self.side.shortcut_terms.get(&s.name)).is_some_and(|list| !list.is_empty())
    }

    fn sync_shortcut_tabs(&mut self) {
        let Some(panel) = self.terminal.as_mut() else { return; };
        let terms = self.side.shortcut_terms.get(&panel.session).cloned().unwrap_or_default();
        let added = panel.sync(&terms);
        // Id vazio = o atalho falhou antes de devolver o terminal: a aba dele é a mais nova.
        if let Some(id) = self.side.shortcut_focus.get(&panel.session).cloned() {
            let id = if id.is_empty() { terms.last().map(|t| t.id.clone()) } else { Some(id) };
            if id.is_some_and(|id| panel.select_shortcut(&id)) { self.side.shortcut_focus.remove(&panel.session); }
        }
        for uid in added {
            if let Some(tab) = self.terminal.as_ref().and_then(|panel| panel.index(uid)) { self.connect_terminal(tab); }
        }
    }

    fn close_shortcut(&mut self, id: String, cx: &mut Context<Self>) {
        let (Some(api), Some(panel)) = (self.api.clone(), self.terminal.as_ref()) else { return; };
        let (connection, tx, name) = (self.connection, self.tx.clone(), panel.session.clone());
        self.runtime.spawn(async move {
            let result = api.act(&name, &["shortcut-terminals", &id, "close"], None, false, 15).await;
            let _ = tx.send(Envelope { connection, selection: None, payload: Payload::Terminal(Reply::Closed(name, result)) }).await;
        });
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
        let Some(slot) = panel.tabs.get_mut(tab) else { return; };
        if slot.fixture_error { return; }
        if let Some(socket) = slot.socket.as_mut() { socket.close(); }
        slot.socket = None;
        slot.generation += 1;
        slot.status = Status::Connecting;
        let (id, uid, generation, name) = (panel.id, slot.uid, slot.generation, slot.name.clone());
        let Some(api) = self.api.clone() else {
            slot.status = if slot.fixture_loaded { Status::Connected } else { Status::Failed(tr("term_disconnected")) };
            return;
        };
        // Shell e atalhos são ocultos da lista de sessões: o POST que criou o Shell já validou o alvo, e o dono do
        // terminal de atalho o backend confere no próprio socket.
        if slot.kind != Kind::Session { self.open_terminal_socket(uid, id, generation); return; }
        let (connection, tx) = (self.connection, self.tx.clone());
        // Reqwest roda no Tokio; a resposta da leitura e o socket têm a mesma geração.
        self.runtime.spawn(async move {
            let result = api.sessions().await.and_then(|sessions| sessions.iter().any(|session| session.name == name)
                .then_some(()).ok_or_else(|| Failure { status: Some(404), ..Failure::local("session_missing") }));
            let _ = tx.send(Envelope { connection, selection: None,
                payload: Payload::Terminal(Reply::Probe(id, uid, generation, result)) }).await;
        });
    }

    fn open_terminal_socket(&mut self, uid: u64, id: u64, generation: u64) {
        let (Some(api), Some(panel)) = (self.api.as_ref(), self.terminal.as_mut()) else { return; };
        let Some(tab) = panel.index(uid) else { return; };
        if panel.id != id || panel.tabs[tab].generation != generation { return; }
        let slot = &mut panel.tabs[tab];
        let (cols, rows) = slot.view.dimensions();
        let shortcut = slot.shortcut().map(|t| t.id.clone());
        let socket = ws::Terminal::open(self.runtime.handle(), api, &slot.name, shortcut.as_deref(), self.active_token.clone(), cols, rows);
        let events = socket.events();
        slot.socket = Some(socket);
        let (connection, tx) = (self.connection, self.tx.clone());
        self.runtime.spawn(async move {
            while let Ok(event) = events.recv().await {
                if tx.send(Envelope { connection, selection: None,
                    payload: Payload::Terminal(Reply::Socket(id, uid, generation, event)) }).await.is_err() { break; }
            }
        });
    }

    fn show_shell(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(panel) = self.terminal.as_mut() else { return; };
        let Some(shell) = panel.shell_index() else { return; };
        panel.active = shell;
        panel.focus.focus(window, cx);
        if panel.tabs[shell].name.is_empty() && !panel.shell_pending {
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
            Reply::Probe(id, uid, generation, result) => {
                let Some(panel) = self.terminal.as_mut().filter(|panel| panel.id == id) else { return; };
                let Some(tab) = panel.index(uid).filter(|&tab| panel.tabs[tab].generation == generation) else { return; };
                match result {
                    Ok(()) => self.open_terminal_socket(uid, id, generation),
                    Err(error) => panel.tabs[tab].status = Status::Failed(failure_message(error)),
                }
            }
            Reply::Shell(id, request, result) => {
                let Some(panel) = self.terminal.as_mut().filter(|panel| panel.id == id && panel.shell_request == request) else { return; };
                panel.shell_pending = false;
                match result {
                    Ok(value) => match (value.get("shell").and_then(Value::as_str).filter(|name| !name.is_empty()), panel.shell_index()) {
                        (Some(name), Some(shell)) => { panel.tabs[shell].name = name.to_owned(); self.connect_terminal(shell); }
                        _ => panel.shell_error = Some(tr("term_shell_error")),
                    },
                    Err(error) => panel.shell_error = Some(failure_message(error)),
                }
            }
            Reply::Socket(id, uid, generation, event) => {
                let Some(panel) = self.terminal.as_mut().filter(|panel| panel.id == id) else { return; };
                let Some(slot) = panel.tabs.iter_mut().find(|slot| slot.uid == uid && slot.generation == generation) else { return; };
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
            Reply::List(name, result) => {
                // Falha de leitura mantém a lista anterior: o botão não some por um GET perdido.
                let Ok(value) = result else { return; };
                let terms = parse_shortcut_terms(&value);
                // Terminal do atalho fechado ou morto: o aviso "rodando" dele deixa de ser verdade.
                if let Some((id, text)) = self.side.shortcut_running.get(&name).cloned() {
                    if !terms.iter().any(|t| t.id == id && t.alive) {
                        self.side.shortcut_running.remove(&name);
                        self.action_feedback.retain(|key, note| !(key.name == name && note.0 == text));
                    } else {
                        // O programa pode fechar sozinho (a janela do RDP): relê a lista enquanto o aviso estiver na tela.
                        self.recheck_shortcut_terms(&name);
                    }
                }
                self.side.shortcut_terms.insert(name.clone(), terms);
                if self.terminal.as_ref().is_some_and(|panel| panel.session == name) { self.sync_shortcut_tabs(); }
            }
            Reply::Closed(name, result) => {
                if let (Err(error), Some(key)) = (result, self.selected_key().filter(|key| key.name == name)) {
                    self.action_feedback.insert(key, (tr("term_shortcut_close_error").replace("{error}", &Hangar::failure(&error)), true));
                }
                self.refresh_shortcut_terms(&name);
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
        let Some(slot) = panel.tabs.get_mut(panel.active) else { return; };
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

    fn resize_terminal(&mut self, uid: u64, bounds: Bounds<Pixels>, window: &mut Window, cx: &mut Context<Self>) {
        let Some(panel) = self.terminal.as_mut() else { return; };
        let Some(slot) = panel.tabs.iter_mut().find(|slot| slot.uid == uid) else { return; };
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
        let body = match panel.tabs.get(tab) {
            Some(slot) => self.terminal_body(panel, slot, cx),
            // Sessão sem pane e sem atalho aberto: nada a anexar.
            None => div().id("terminal-grid").track_focus(&panel.focus).key_context("Terminal").relative().flex_1().min_h_0()
                .flex().items_center().justify_center().text_color(theme::muted()).bg(theme::background())
                .child(div().id("terminal-status").role(Role::Status).child(tr("term_shortcut_empty"))).into_any_element(),
        };
        let failed = panel.tabs.get(tab).is_some_and(|slot| slot.kind == Kind::Shell && panel.shell_error.is_some()
            || matches!(slot.status, Status::Failed(_)));
        let mut tabs = div().flex().items_center().gap_1().min_w_0().flex_1().overflow_hidden();
        for (index, slot) in panel.tabs.iter().enumerate() {
            let selected = index == tab;
            tabs = tabs.child(match &slot.kind {
                Kind::Session => Button::new("term-session").ghost().small().selected(selected).label(panel.session.clone())
                    .on_click(cx.listener(move |this, _, window, cx| {
                        if let Some(panel) = this.terminal.as_mut() { panel.active = index; panel.focus.focus(window, cx); cx.notify(); }
                    })).into_any_element(),
                Kind::Shell => Button::new("term-shell").ghost().small().selected(selected).label(tr("term_shell"))
                    .on_click(cx.listener(|this, _, window, cx| this.show_shell(window, cx))).into_any_element(),
                Kind::Shortcut(term) => {
                    let label = shortcut_tab_label(term);
                    let (id, close_id) = (term.id.clone(), term.id.clone());
                    div().flex().items_center().flex_shrink_0()
                        .child(Button::new(SharedString::from(format!("term-sc-{}", term.id))).ghost().small().selected(selected)
                            .label(label).tooltip(term.label.clone())
                            .on_click(cx.listener(move |this, _, window, cx| {
                                if let Some(panel) = this.terminal.as_mut() {
                                    if panel.select_shortcut(&id) { panel.focus.focus(window, cx); cx.notify(); }
                                }
                            })))
                        .child(Button::new(SharedString::from(format!("term-sc-close-{}", term.id))).ghost().xsmall().label("×")
                            .accessibility_label(tr("term_shortcut_close").replace("{label}", &term.label))
                            .tooltip(tr("term_shortcut_close").replace("{label}", &term.label))
                            .on_click(cx.listener(move |this, _, _, cx| { this.close_shortcut(close_id.clone(), cx); cx.stop_propagation(); })))
                        .into_any_element()
                }
            });
        }
        let header = div().h(px(38.)).flex_shrink_0().flex().items_center().gap_1().px_2()
            .bg(theme::raised()).border_b_1().border_color(theme::border())
            .child(tabs)
            .when(failed, |el| el.child(Button::new("term-reconnect").ghost().small().icon(IconName::RefreshCw)
                .label(tr("term_reconnect")).on_click(cx.listener(|this, _, window, cx| {
                    if let Some(panel) = this.terminal.as_ref() {
                        let shell_unnamed = panel.tabs.get(panel.active).is_some_and(|slot| slot.kind == Kind::Shell && slot.name.is_empty());
                        if shell_unnamed { this.show_shell(window, cx); }
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

    fn terminal_body(&self, panel: &Panel, slot: &Slot, cx: &mut Context<Self>) -> AnyElement {
        let fixture_loaded = slot.fixture_loaded;
        let bounds = slot.bounds.clone();
        let typography_changed = slot.view.typography_changed();
        let entity = cx.entity();
        let uid = slot.uid;
        let shell_unnamed = slot.kind == Kind::Shell && slot.name.is_empty();
        let message = if shell_unnamed {
            panel.shell_error.clone().or_else(|| Some(tr("term_opening_shell")))
        } else { match &slot.status { Status::Connecting => Some(tr("term_connecting")),
            Status::Connected => None, Status::Failed(message) => Some(message.clone()) } };
        let failed = slot.kind == Kind::Shell && panel.shell_error.is_some() || matches!(slot.status, Status::Failed(_));
        div().id("terminal-grid").role(Role::Term).aria_label(tr("term_toggle"))
            .track_focus(&panel.focus).key_context("Terminal").relative().flex_1().min_h_0().overflow_hidden()
            .bg(theme::background()).child(slot.view.element())
            .child(canvas(move |area, window, cx| {
                if bounds.get() != area || typography_changed {
                    let entity = entity.clone();
                    window.defer(cx, move |window, cx| entity.update(cx, |this, cx| this.resize_terminal(uid, area, window, cx)));
                }
            }, |_, _, _, _| {}).absolute().inset_0())
            .on_mouse_down(MouseButton::Left, cx.listener(|this, event: &MouseDownEvent, window, cx| {
                let Some(panel) = this.terminal.as_mut() else { return; };
                panel.focus.focus(window, cx);
                let Some(slot) = panel.tabs.get_mut(panel.active) else { return; };
                let at = event.position - slot.bounds.get().origin;
                slot.selecting = true;
                if slot.view.mouse_down(f32::from(at.x), f32::from(at.y), event.click_count) { cx.notify(); }
            }))
            .on_mouse_move(cx.listener(|this, event: &MouseMoveEvent, _, cx| {
                let Some(slot) = this.terminal.as_mut().and_then(|panel| panel.tabs.get_mut(panel.active)) else { return; };
                if !slot.selecting { return; }
                if event.pressed_button != Some(MouseButton::Left) { slot.selecting = false; slot.view.mouse_up(); return; }
                let at = event.position - slot.bounds.get().origin;
                if slot.view.mouse_drag(f32::from(at.x), f32::from(at.y)) { cx.notify(); }
            }))
            .on_mouse_up(MouseButton::Left, cx.listener(|this, _, _, _| {
                if let Some(slot) = this.terminal.as_mut().and_then(|panel| panel.tabs.get_mut(panel.active)) { slot.selecting = false; slot.view.mouse_up(); }
            }))
            .on_scroll_wheel(cx.listener(|this, event: &ScrollWheelEvent, _, cx| {
                if let Some(slot) = this.terminal.as_mut().and_then(|panel| panel.tabs.get_mut(panel.active)) {
                    if slot.view.scroll_wheel(event) { cx.notify(); }
                }
            }))
            .on_action(cx.listener(|this, _: &CopyTerminal, _, cx| {
                if let Some(slot) = this.terminal.as_ref().and_then(|panel| panel.tabs.get(panel.active)) {
                    if let Some(text) = slot.view.selected_text() { cx.write_to_clipboard(ClipboardItem::new_string(text)); }
                }
            }))
            .on_action(cx.listener(|this, _: &PasteTerminal, _, cx| {
                if let Some(slot) = this.terminal.as_mut().and_then(|panel| panel.tabs.get_mut(panel.active)) {
                    if !slot.accepts_input() { return; }
                    if let Some(text) = cx.read_from_clipboard().and_then(|item| item.text()) {
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
            }).into_any_element()
    }
}

/// Rótulo da aba do atalho: o nome e, depois que o comando saiu, o código (o pane continua com a saída na tela).
fn shortcut_tab_label(term: &ShortcutTerm) -> String {
    let label = conversation::one_line(&term.label, 24);
    if term.alive { return label; }
    let status = term.exit_code.map_or_else(|| tr("term_shortcut_ended"), |code| tr("term_shortcut_exit").replace("{code}", &code.to_string()));
    format!("{label} · {status}")
}

#[cfg(test)]
mod tests {
    // Sem glob: o `test` da gpui colide com o atributo padrão.
    use super::{ShortcutTerm, parse_shortcut_terms, shortcut_tab_label};
    use serde_json::Value;

    fn term(id: &str, alive: bool, exit_code: Option<i64>) -> ShortcutTerm {
        ShortcutTerm { id: id.into(), label: format!("L{id}"), alive, exit_code }
    }

    #[test]
    fn parses_the_shortcut_terminal_list() {
        let value: Value = serde_json::from_str(r#"{"terminals": [
            {"id": "a1b2c3", "label": "RDP", "alive": true, "exit_code": null, "created": 1},
            {"id": "d4e5f6", "label": "Build", "alive": false, "exit_code": 2},
            {"label": "sem id"}
        ]}"#).unwrap();
        assert_eq!(parse_shortcut_terms(&value), vec![
            ShortcutTerm { id: "a1b2c3".into(), label: "RDP".into(), alive: true, exit_code: None },
            ShortcutTerm { id: "d4e5f6".into(), label: "Build".into(), alive: false, exit_code: Some(2) },
        ]);
        assert!(parse_shortcut_terms(&Value::Null).is_empty());
    }

    #[test]
    fn dead_tab_label_carries_the_exit_status() {
        assert_eq!(shortcut_tab_label(&term("1", true, None)), "L1");
        assert!(shortcut_tab_label(&term("1", false, Some(3))).contains('3'));
    }
}
