//! Bandeja das abas: as listas já abertas de cada máquina, sem streams próprios.
use super::*;
use super::sidebar::Target;

pub(super) struct Tray { pub(super) open: bool, focus: FocusHandle }

impl Tray {
    pub(super) fn new(cx: &mut Context<Hangar>) -> Self { Self { open: false, focus: cx.focus_handle() } }
}

impl Hangar {
    fn tray_sessions<'a>(&'a self, key: &str) -> Vec<&'a SessionInfo> {
        let mut sessions: Vec<_> = self.sessions_of(key).iter().filter(|s| !self.sidebar.is_hidden(key, &s.name)).collect();
        sessions.sort_by(|a, b| a.name.cmp(&b.name));
        sessions
    }

    fn other_machines_have_sessions(&self) -> bool {
        let active = self.active_key();
        self.servers.iter().filter(|entry| !entry.disabled).any(|entry| {
            let key = servers::norm(&entry.address);
            (key != active || entry.invite) && self.sessions_of(&key).iter().any(|s| !self.sidebar.is_hidden(&key, &s.name))
        })
    }

    pub(super) fn render_machines_tray_button(&self, cx: &mut Context<Self>) -> AnyElement {
        let occupied = self.other_machines_have_sessions();
        let tip = tr(if occupied { "machines_tray_occupied" } else { "machines_tray_open" });
        let icon = div().relative().size(px(18.)).child(svg().path(crate::MACHINES_GLYPH).size_full().text_color(theme::muted()))
            .when(occupied, |el| el.child(div().id("machines-tray-dot").absolute().right(px(-2.)).top(px(-2.))
                .size(px(5.)).rounded_full().bg(theme::warning())));
        let button = Button::new("machines-tray-toggle").ghost().size(px(28.)).rounded(px(6.)).child(icon)
            .selected(self.machines_tray.open).tooltip(tip.clone()).accessibility_label(tip)
            .on_click(cx.listener(|this, _, window, cx| {
                let opening = !this.machines_tray.open;
                this.close_popups();
                this.machines_tray.open = opening;
                if opening { this.machines_tray.focus.focus(window, cx); }
                cx.notify();
            }));
        popup::anchor(button.relative(), "machines-tray-toggle").into_any_element()
    }

    pub(super) fn render_machines_tray(&self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let active = self.active_key();
        let enabled: Vec<_> = self.servers.iter().filter(|s| !s.disabled).collect();
        let count = enabled.len().max(1);
        let width = px((count as f32 * 240. + 24.).min(900.)).min(window.viewport_size().width - px(32.));
        let height = (window.viewport_size().height - px(160.)).clamp(px(120.), px(380.));
        let mut columns = Vec::new();
        for entry in enabled {
            let key = servers::norm(&entry.address);
            let (loaded, online, error) = if key == active {
                (self.list_online || self.list_error.is_some(), self.list_online,
                    self.invite_ended.contains(&key).then(|| tr_shared("convite_encerrado", &[])).or(self.list_error.clone()))
            } else {
                self.remote.get(&key).map(|list| (list.loaded, list.online, list.error.clone())).unwrap_or_default()
            };
            columns.push(self.render_machine_column(&key, &entry.label, entry.invite, loaded, online, error, height, window, cx));
        }
        if columns.is_empty() {
            columns.push(self.render_machine_column(&active, &self.server_label(cx), self.active_invite(),
                self.list_online || self.list_error.is_some(), self.list_online, self.list_error.clone(), height, window, cx));
        }
        div().id("machines-tray").w(width).p(px(12.)).flex().flex_col().gap_2().track_focus(&self.machines_tray.focus)
            .role(Role::Dialog).aria_label(tr("machines_tray_title"))
            .child(div().flex().items_center().gap_2()
                .child(div().flex_1().text_sm().font_weight(FontWeight::SEMIBOLD).child(tr("machines_tray_title")))
                .child(chrome::icon_button("machines-tray-close", IconName::Close, tr("close"), cx)
                    .on_click(cx.listener(|this, _, window, cx| {
                        this.close_popups();
                        this.root_focus.focus(window, cx);
                        cx.notify();
                    }))))
            .child(div().id("machines-tray-columns").relative().w_full().min_w_0().overflow_x_scroll()
                .flex().items_start().gap(px(12.)).children(columns))
            .child(div().pt_2().border_t_1().border_color(theme::border()).text_xs().text_color(theme::muted())
                .whitespace_normal().child(tr("machines_tray_pair_hint")))
            .into_any_element()
    }

    #[allow(clippy::too_many_arguments)]
    fn render_machine_column(&self, key: &str, label: &str, invite: bool, loaded: bool, online: bool, error: Option<String>,
        height: Pixels, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let sessions = self.tray_sessions(key);
        let remote = (!self.is_active_key(key)).then_some(key);
        let mut rows = Vec::new();
        for row in grouping::cluster(&sessions) {
            match row {
                grouping::ListRow::Header { gid, label, members } => rows.push(self.render_pair_header(&gid, &label, &members, remote, window, cx)),
                grouping::ListRow::Session(s) if !self.pair_collapsed(s, remote) => rows.push(self.render_machine_session(s, key, invite, window, cx)),
                grouping::ListRow::External { gid, owner, session, alias } if !self.sidebar.is_collapsed(&grouping::pair_key(&gid, remote)) =>
                    rows.push(self.render_external_pair_row(&gid, &owner, &session, &alias, remote, window, cx)),
                _ => {}
            }
        }
        let empty = sessions.is_empty();
        div().id(SharedString::from(format!("machines-tray-machine-{key}"))).w(px(228.)).flex_shrink_0().flex().flex_col().gap_2()
            .role(Role::Group).aria_label(label.to_owned())
            .child(div().flex().items_center().gap(px(6.))
                .child(div().size(px(6.)).rounded_full().bg(if online { theme::success() } else { theme::warning() }))
                .child(div().flex_1().min_w_0().truncate().text_xs().font_weight(FontWeight::SEMIBOLD).child(label.to_owned()))
                .when(invite, |el| el.child(div().text_size(px(10.)).text_color(theme::muted()).child(tr("invite_badge"))))
                .child(div().text_xs().text_color(theme::faint()).child(sessions.len().to_string())))
            .child(div().id(SharedString::from(format!("machines-tray-list-{key}"))).relative().w_full().max_h(height).overflow_y_scroll()
                .flex().flex_col().gap(px(5.))
                .when(!loaded && error.is_none(), |el| el.child(div().p_2().text_xs().text_color(theme::muted()).child(tr("loading"))))
                .when(empty && loaded && error.is_none(), |el| el.child(div().p_2().text_xs().text_color(theme::muted()).child(tr("empty_sessions"))))
                .when_some(error, |el, error| el.child(div().p_2().text_xs().text_color(theme::warning()).whitespace_normal().child(error)))
                .children(rows)
                .map(|el| self.drop_background(el, cx)))
            .into_any_element()
    }

    fn render_machine_session(&self, session: &SessionInfo, key: &str, invite: bool, window: &mut Window,
        cx: &mut Context<Self>) -> AnyElement {
        let target = Target::new(key, &session.name);
        let on = self.selected_target().as_ref() == Some(&target);
        let row_id = format!("machines-tray-row-{}", target.id());
        let focus = window.use_keyed_state(SharedString::from(format!("{row_id}-focus")), cx, |_, cx| cx.focus_handle().tab_stop(true))
            .read(cx).clone();
        let state = session.display_state();
        let readonly = session.read_only();
        let tip = format!("{} · {}", session.name, tr(&format!("chip_{state}")));
        let pick = target.clone();
        let open = target.clone();
        let session_menu = sidebar::session_menu(cx.entity().downgrade(), key.to_owned(), session.clone());
        let row = div().id(SharedString::from(row_id)).relative().w_full().min_h(px(48.))
            .p(px(8.)).flex().items_center().gap(px(6.)).rounded(px(7.)).border_1().border_color(theme::border()).cursor_pointer()
            .when(on, |el| el.bg(theme::accent_dim()).border_color(theme::accent()))
            .when(!on, |el| el.hover(|el| el.bg(theme::hover())))
            .track_focus(&focus).when(focus.is_focused(window), |el| el.focus_ring_style(window, cx))
            .role(Role::Button).aria_selected(on).aria_label(tip.clone())
            .tooltip(move |window, cx| gpui_kit::component::tooltip::Tooltip::new(tip.clone()).build(window, cx))
            .child(div().size(px(6.)).flex_shrink_0().rounded_full().bg(theme::status(state)))
            .child(chrome::provider_glyph(&session.provider, 14.))
            .child(div().flex_1().min_w_0().flex().flex_col().gap(px(2.))
                .child(div().truncate().text_size(px(12.)).child(session.name.clone()))
                .child(div().truncate().text_size(px(10.)).text_color(theme::muted()).child(tr(&format!("chip_{state}")))))
            .when(readonly, |el| el.child(div().flex_shrink_0().text_size(px(9.)).text_color(theme::muted()).child(tr("machines_tray_read_only"))))
            .when(session.pending_questions > 0, |el| el.child(div().text_xs().text_color(theme::warning()).child(format!("? {}", session.pending_questions))))
            .child(chrome::icon_button(SharedString::from(format!("machines-tray-menu-{}", target.id())), IconName::Ellipsis,
                    tr("sidebar_options").replace("{n}", &session.name), cx).size(px(20.))
                .dropdown_menu_with_anchor(Anchor::TopRight,
                    sidebar::session_menu(cx.entity().downgrade(), key.to_owned(), session.clone())))
            .on_click(cx.listener(move |this, _, window, cx| {
                this.close_popups();
                this.open_target(&pick, window, cx);
                cx.notify();
            }))
            .on_key_down(cx.listener(move |this, event: &KeyDownEvent, window, cx| {
                if !matches!(event.keystroke.key.as_str(), "enter" | "space") { return; }
                this.close_popups();
                this.open_target(&open, window, cx);
                cx.stop_propagation();
                cx.notify();
            }))
            .on_mouse_down(MouseButton::Right, cx.listener(move |this, _, _, cx| this.start_menu(target.clone(), cx)))
            .when(!invite && !readonly, |row| self.group_row(row, session, (!self.is_active_key(key)).then_some(key), 7., cx));
        row.context_menu(session_menu).into_any_element()
    }
}
