//! Abas horizontais: o grupo ocupa uma pilha sem desnível vertical.
use super::*;
use super::grouping::{Member, Row, global_groups};
use super::sidebar::Target;

pub(super) struct TabGroup {
    pub(super) label: Option<String>,
    pub(super) members: Vec<Target>,
    /// O primeiro membro abriu os outros (filhas ligadas) ou é o líder `orq`: o grupo vira uma aba só, a dele.
    pub(super) mother: bool,
}

/// O pedaço do nome de cada filha que a distingue: tira o começo (até um `-`/`_`) que ela divide com outro nome do
/// grupo, sem diferenciar maiúsculas. `ABC-42-backend` ao lado de `ABC-42-Lead` vira `backend`.
pub(super) fn short_names(names: &[&str]) -> Vec<String> {
    names.iter().enumerate().map(|(i, name)| {
        let cut = names.iter().enumerate().filter(|&(j, _)| j != i).map(|(_, other)| {
            let common = name.chars().zip(other.chars()).take_while(|(a, b)| a.eq_ignore_ascii_case(b)).count();
            name.char_indices().take(common).filter(|(_, c)| matches!(c, '-' | '_')).map(|(at, _)| at + 1).last().unwrap_or(0)
        }).max().unwrap_or(0);
        let rest = &name[cut..];
        let rest = if rest.is_empty() { *name } else { rest };
        if rest.chars().count() > 12 { format!("{}…", rest.chars().take(11).collect::<String>()) } else { rest.to_owned() }
    }).collect()
}

pub(super) fn reveal_offset(current: f32, viewport: (f32, f32), tab: (f32, f32)) -> f32 {
    if tab.0 + current < viewport.0 { viewport.0 - tab.0 }
    else if tab.1 + current > viewport.1 { viewport.1 - tab.1 }
    else { current }
}

pub(super) const BAR_HEIGHT: f32 = 38.;
const REAR_WIDTH: f32 = 88.;
const OVERLAP: f32 = 12.;

impl TabGroup {
    fn slot(&self, index: usize) -> Option<(f32, f32)> {
        let label = self.label.as_deref()?;
        let front = (label.chars().count() as f32 * 4.5 + 32.).clamp(132., 184.);
        Some(if index == 0 { (0., front) } else { (front - OVERLAP + (index - 1) as f32 * (REAR_WIDTH - OVERLAP), REAR_WIDTH) })
    }
}

/// Uma faixa por grupo do modelo global: membros de máquinas diferentes do mesmo grupo dividem a faixa.
pub(super) fn groups(entries: Vec<(Target, &SessionInfo)>, ids: &HashMap<String, String>) -> Vec<TabGroup> {
    let rows: Vec<Row> = entries.iter().map(|(t, s)| Row { server: &t.server, session: s, invite: false }).collect();
    let mut keys: HashMap<Target, String> = HashMap::new();
    for g in global_groups(&rows, ids) {
        for m in g.members {
            if let Member::Here { server, name } = m { keys.insert(Target { server, name }, g.key.clone()); }
        }
    }
    let mut out: Vec<TabGroup> = Vec::new();
    let mut indexes = HashMap::new();
    // Quem abriu cada filha ligada (mesma máquina: o vínculo é só local) e o líder `orq`, por grupo.
    let mut openers: Vec<Vec<Target>> = Vec::new();
    for (target, session) in entries {
        let Some(key) = keys.get(&target).cloned() else {
            out.push(TabGroup { label: None, members: vec![target], mother: false });
            openers.push(Vec::new());
            continue;
        };
        let index = *indexes.entry(key).or_insert_with(|| {
            out.push(TabGroup { label: Some(String::new()), members: Vec::new(), mother: false });
            openers.push(Vec::new());
            out.len() - 1
        });
        let group = &mut out[index];
        if group.label.as_ref().is_some_and(|s| s.is_empty()) {
            group.label = Some(session.pair_task.as_deref().unwrap_or("").trim().to_owned());
        }
        if let Some(parent) = session.linked_by.as_deref() { openers[index].push(Target::new(&target.server, parent)); }
        if session.orq() {
            group.mother = true;
            group.members.insert(0, target);
        } else { group.members.push(target); }
    }
    for (group, openers) in out.iter_mut().zip(openers) {
        if group.label.as_ref().is_some_and(|s| s.is_empty()) {
            group.label = Some(group.members.iter().map(|t| t.name.as_str()).collect::<Vec<_>>().join(", "));
        }
        if group.members.len() < 2 { group.mother = false; continue; }
        if let Some(at) = group.members.iter().position(|t| openers.contains(t)) {
            let mother = group.members.remove(at);
            group.members.insert(0, mother);
            group.mother = true;
        }
    }
    out
}

impl Hangar {
    /// Recalculado só quando muda o que `groups` lê: as abas, os campos de grupo delas e os identificadores.
    fn tab_groups(&self) -> std::rc::Rc<Vec<TabGroup>> {
        use std::hash::{DefaultHasher, Hash, Hasher};
        let entries: Vec<(Target, &SessionInfo)> = self.ungrouped_tab_targets().into_iter()
            .filter_map(|target| self.target_session(&target).map(|session| (target, session))).collect();
        let mut hasher = DefaultHasher::new();
        self.hash_identities(&mut hasher);
        for (t, s) in &entries { (t, &s.pair_gid, &s.pair_owner, s.peers(), &s.pair_task, s.orq(), &s.linked_by).hash(&mut hasher); }
        super::grouping::memo(&self.sidebar.grouping.tabs, hasher.finish(), || groups(entries, &self.identities()))
    }

    pub(super) fn tab_targets(&self) -> Vec<Target> {
        self.tab_groups().iter().flat_map(|group| group.members.iter().cloned()).collect()
    }

    /// As abas que estão na faixa e recebem foco: do grupo com mãe só ela, as filhas ficam na janela dela.
    pub(super) fn tab_stops(&self) -> Vec<Target> {
        self.tab_groups().iter().flat_map(|group| group.members.iter().take(if group.mother { 1 } else { usize::MAX }).cloned()).collect()
    }

    pub(super) fn scroll_target_tab(&mut self, target: &Target) {
        self.pending_tab_reveal = Some(target.clone());
        self.reveal_target_tab(target);
    }

    pub(super) fn schedule_tab_reveal(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.pending_tab_reveal.is_none() || self.tab_reveal_scheduled { return; }
        self.tab_reveal_scheduled = true;
        // Agendado no render: o quadro atual atualiza os bounds antes desta única repetição.
        cx.on_next_frame(window, |this, _, cx| {
            this.tab_reveal_scheduled = false;
            if let Some(target) = this.pending_tab_reveal.take() {
                this.reveal_target_tab(&target);
                cx.notify();
            }
        });
    }

    fn reveal_target_tab(&self, target: &Target) {
        for (index, group) in self.tab_groups().iter().enumerate() {
            let Some(member) = group.members.iter().position(|t| t == target) else { continue; };
            let viewport = self.tabs_scroll.bounds();
            if let Some(bounds) = self.tabs_scroll.bounds_for_item(index) {
                let (left, width) = group.slot(member).unwrap_or((0., f32::from(bounds.size.width)));
                let start = bounds.left() + px(left + if member > 0 { OVERLAP } else { 0. });
                let end = bounds.left() + px(left + width);
                let offset = self.tabs_scroll.offset();
                let inset = px((f32::from(viewport.size.width) / 2.).min(3.));
                let x = reveal_offset(f32::from(offset.x), (f32::from(viewport.left() + inset), f32::from(viewport.right() - inset)),
                    (f32::from(start), f32::from(end)));
                self.tabs_scroll.set_offset(point(px(x), offset.y));
            } else { self.tabs_scroll.scroll_to_item(index); }
            break;
        }
    }

    pub(super) fn render_tab_groups(&self, window: &mut Window, cx: &mut Context<Self>) -> Vec<AnyElement> {
        let mut order = 0;
        let bands = self.tab_groups();
        bands.iter().map(|group| {
            let first = order;
            order += group.members.len();
            let Some(label) = group.label.as_deref() else {
                return div().flex_shrink_0().children(self.render_session_tab(&group.members[0], None, None, first, window, cx)).into_any_element();
            };
            if group.mother && let Some(tab) = self.render_mother_tab(group, label, first, window, cx) { return tab; }
            let (last, size) = group.slot(group.members.len() - 1).expect("grupo com membro");
            let width = last + size;
            // Os de trás pintam primeiro; todos mantêm a mesma altura e deixam uma faixa clicável exposta.
            let tabs = group.members.iter().enumerate().rev().filter_map(|(index, target)| {
                self.render_session_tab(target, (index == 0).then_some(label), group.slot(index), first + index, window, cx)
            }).collect::<Vec<_>>();
            div().id(SharedString::from(format!("tab-group-{}", group.members[0].id())))
                .relative().flex_shrink_0().w(px(width)).h(px(30.)).children(tabs).into_any_element()
        }).collect()
    }

    /// Grupo com mãe: uma aba só, a dela. As filhas viram etiquetas pequenas sobre o nome (o clique abre a filha); o clique no
    /// resto abre a mãe e a janela com as abas inteiras das filhas, para cima quando a faixa fica embaixo.
    fn render_mother_tab(&self, group: &TabGroup, label: &str, tab_index: usize, window: &mut Window, cx: &mut Context<Self>) -> Option<AnyElement> {
        let mother = &group.members[0];
        let session = self.target_session(mother)?;
        let focus = self.row_focus(mother)?.clone().tab_index(tab_index as isize);
        let selected = self.selected_target();
        let on = selected.as_ref().is_some_and(|t| group.members.contains(t));
        let was_open = self.tab_group_open.as_ref() == Some(mother);
        let bottom = appearance::get().navigation == appearance::Navigation::BottomTabs;
        let remote = mother.server != self.active_key();
        let names: Vec<&str> = group.members.iter().map(|t| t.name.as_str()).collect();
        let short = short_names(&names);
        let dot = |s: &SessionInfo| if s.pending_questions > 0 || s.state == "awaiting_input" { theme::warning() }
            else if s.state == "working" { theme::accent() } else { theme::success() };
        let kids: Vec<(Target, &SessionInfo, String)> = group.members.iter().zip(short).skip(1)
            .filter_map(|(t, text)| self.target_session(t).map(|s| (t.clone(), s, text))).collect();
        let chips = kids.iter().map(|(target, kid, text)| {
            let pick = target.clone();
            let kid_on = selected.as_ref() == Some(target);
            div().id(SharedString::from(format!("tab-kid-{}", target.id()))).flex_shrink_0().max_w(px(76.)).h(px(12.)).px(px(4.))
                .flex().items_center().gap(px(3.)).rounded(px(3.)).cursor_pointer()
                .bg(if kid_on { theme::accent_dim() } else { theme::hover() }).hover(|el| el.bg(theme::accent_dim()))
                .role(Role::Button).aria_label(format!("{} · {}", kid.name, tr(&format!("chip_{}", kid.state))))
                .child(div().size(px(5.)).flex_shrink_0().rounded_full().bg(dot(kid)))
                .child(div().min_w_0().truncate().text_size(px(9.)).line_height(px(12.))
                    .text_color(if kid_on { theme::text() } else { theme::muted() }).child(text.clone()))
                .on_click(cx.listener(move |this, _, window, cx| {
                    this.tab_group_open = None;
                    this.open_target(&pick, window, cx);
                    cx.stop_propagation();
                }))
        }).collect::<Vec<_>>();
        let count = tr_shared("tab_group_children", &[("n", &kids.len().to_string())]);
        let aria = self.session_number_label(mother, format!("{} · {} · {count}", session.name, label));
        let mark = self.avatar_slot(panes::Area::Nav, format!("tab-mark-{}", mother.id()), sidebar::session_look(session), 20.);
        let window_tabs = was_open.then(|| {
            let tabs = kids.iter().enumerate().filter_map(|(i, (t, _, _))| self.render_session_tab(t, None, None, tab_index + 1 + i, window, cx))
                .collect::<Vec<_>>();
            let body = div().id("tab-group-window").p(px(4.)).flex().items_center().gap(px(2.))
                .child(div().px(px(6.)).max_w(px(160.)).truncate().text_size(px(10.)).font_weight(FontWeight::SEMIBOLD)
                    .text_color(theme::accent_text()).child(label.to_owned()))
                .children(tabs)
                .on_mouse_down_out(cx.listener(|this, _, _, cx| { this.tab_group_open = None; cx.notify(); }))
                .on_mouse_up(MouseButton::Left, cx.listener(|this, _, _, cx| { this.tab_group_open = None; cx.notify(); }));
            deferred(anchored().anchor(if bottom { gpui_kit::Anchor::BottomLeft } else { gpui_kit::Anchor::TopLeft })
                .snap_to_window_with_margin(px(8.))
                .child(div().map(|el| if bottom { el.pb(px(6.)) } else { el.pt(px(36.)) }).child(chrome::popover(body.into_any_element(), false))))
        });
        let (pick, open, menu_target, key) = (mother.clone(), mother.clone(), mother.clone(), mother.clone());
        let weak = cx.entity().downgrade();
        let tooltip = aria.clone();
        let tab = div().id(SharedString::from(format!("tab-{}", mother.id()))).relative().track_focus(&focus)
            .flex_shrink_0().max_w(px(280.)).h(px(30.)).px(px(8.)).flex().items_center().gap(px(6.)).rounded(px(6.)).border_1().cursor_pointer()
            .map(|el| if on { el.bg(theme::accent_dim()).border_color(theme::accent()).text_color(theme::text()).font_weight(FontWeight::SEMIBOLD) }
                else { el.bg(theme::raised()).border_color(if was_open { theme::accent() } else { theme::border() }).text_color(theme::muted())
                    .hover(|el| el.border_color(theme::accent())) })
            .when(focus.is_focused(window), |el| el.focus_ring_style(window, cx))
            .role(Role::Tab).aria_selected(on).aria_label(aria)
            .tooltip(move |window, cx| gpui_kit::component::tooltip::Tooltip::new(tooltip.clone()).build(window, cx))
            .child(mark).children(self.session_number_badge(mother))
            .child(div().min_w_0().flex_1().flex().flex_col().gap(px(1.))
                .child(div().min_w_0().flex().gap(px(2.)).overflow_hidden().children(chips))
                .child(div().truncate().text_size(px(12.)).line_height(px(14.)).child(session.name.clone())))
            .child(div().flex_shrink_0().px(px(4.)).rounded(px(8.)).text_size(px(10.)).line_height(px(14.)).bg(theme::accent_dim())
                .text_color(theme::accent_text()).child(kids.len().to_string()))
            .when(session.pending_questions > 0, |el| el.child(div().flex_shrink_0().text_size(px(12.)).text_color(theme::warning())
                .child(format!("? {}", session.pending_questions))))
            .child(chrome::small_icon(if bottom { IconName::ChevronUp } else { IconName::ChevronDown }, 10., theme::faint()))
            // O fechar pelo clique fora chega antes deste clique: com a janela aberta, o clique só a deixa fechada.
            .on_click(cx.listener(move |this, _, window, cx| {
                this.tab_group_open = (!was_open).then(|| key.clone());
                this.open_target(&pick, window, cx);
            }))
            .on_key_down(cx.listener(move |this, event: &KeyDownEvent, window, cx| {
                if matches!(event.keystroke.key.as_str(), "enter" | "space") {
                    this.select_target(&open, window, cx);
                    cx.stop_propagation();
                }
            }))
            .on_mouse_down(MouseButton::Right, cx.listener(move |this, _, _, cx| this.start_menu(menu_target.clone(), cx)))
            .when(!self.invite_target(mother) && !session.read_only(), |el| {
                self.group_row(el, session, remote.then_some(mother.server.as_str()), 6., cx).ml(px(0.))
            })
            .children(window_tabs);
        Some(tab.context_menu(sidebar::session_menu(weak, mother.server.clone(), session.clone())).into_any_element())
    }

    fn render_session_tab(&self, target: &Target, group_label: Option<&str>, slot: Option<(f32, f32)>, tab_index: usize,
        window: &mut Window, cx: &mut Context<Self>) -> Option<AnyElement> {
        let session = self.target_session(target)?;
        let focus = self.row_focus(target)?.clone().tab_index(tab_index as isize);
        let on = self.selected_target().as_ref() == Some(target);
        let remote = target.server != self.active_key();
        let host = self.server_label(cx);
        let machine = self.server_entry(&target.server).map(|s| s.label.as_str()).unwrap_or(&host);
        let compact = slot.is_some() && group_label.is_none();
        let grouped = slot.is_some();
        let state = if session.limited == Some(true) { "limited" } else { session.state.as_str() };
        let mut label = format!("{} · {} · {}", session.name, machine, tr(&format!("chip_{state}")));
        if let Some(group) = session.pair_task.as_deref().filter(|s| !s.trim().is_empty()) {
            label.push_str(&format!(" · {}", tr_shared("sessao_grupo_pareado", &[("label", group)])));
        }
        if session.pending_questions > 0 { label.push_str(&format!(" · ? {}", session.pending_questions)); }
        let mark = self.avatar_slot(panes::Area::Nav, format!("tab-mark-{}", target.id()), sidebar::session_look(session), if compact { 16. } else { 20. });
        let pick = target.clone();
        let open = target.clone();
        let menu_target = target.clone();
        let label = self.session_number_label(target, label);
        let weak = cx.entity().downgrade();
        let title = div().min_w_0().flex_1().flex().flex_col()
            .when_some(group_label, |el, text| el.child(div().truncate().text_size(px(9.)).line_height(px(11.))
                .text_color(theme::accent_text()).child(text.to_owned())))
            .child(div().truncate().text_size(px(if grouped { 11. } else { 13. })).line_height(px(14.)).child(session.name.clone()));
        let tab = div().id(SharedString::from(format!("tab-{}", target.id()))).relative().track_focus(&focus)
            .flex_shrink_0().max_w(px(240.)).h(px(30.)).px(px(8.))
            .when_some(slot, |el, (left, width)| el.absolute().top_0().left(px(left)).w(px(width)).block_mouse_except_scroll())
            .when(compact, |el| el.pl(px(20.)))
            .flex().items_center().gap(px(if compact { 4. } else { 6. })).rounded(px(6.)).border_1().cursor_pointer()
            .map(|el| if on { el.bg(theme::accent_dim()).border_color(theme::accent()).text_color(theme::text()).font_weight(FontWeight::SEMIBOLD) }
                else if grouped { el.bg(theme::raised()).border_color(theme::border()).text_color(theme::muted()).hover(|el| el.border_color(theme::accent())) }
                else { el.border_color(transparent_black()).text_color(theme::muted()).hover(|el| el.bg(theme::hover())) })
            .when(focus.is_focused(window), |el| el.focus_ring_style(window, cx))
            .role(Role::Tab).aria_selected(on).aria_label(label.clone())
            .tooltip(move |window, cx| gpui_kit::component::tooltip::Tooltip::new(label.clone()).build(window, cx))
            .child(mark).children(self.session_number_badge(target))
            .child(title)
            .when(remote && !compact, |el| el.child(div().max_w(px(48.)).truncate().text_size(px(9.)).text_color(theme::faint()).child(machine.to_owned())))
            .when(session.pending_questions > 0, |el| el.child(div().flex_shrink_0().text_size(px(if compact { 9. } else { 12. })).text_color(theme::warning())
                .child(if compact { format!("?{}", session.pending_questions) } else { format!("? {}", session.pending_questions) })))
            .on_click(cx.listener(move |this, _, window, cx| this.open_target(&pick, window, cx)))
            .on_key_down(cx.listener(move |this, event: &KeyDownEvent, window, cx| {
                if matches!(event.keystroke.key.as_str(), "enter" | "space") {
                    this.select_target(&open, window, cx);
                    cx.stop_propagation();
                }
            }))
            .on_mouse_down(MouseButton::Right, cx.listener(move |this, _, _, cx| this.start_menu(menu_target.clone(), cx)))
            .when(!self.invite_target(target) && !session.read_only(), |el| {
                self.group_row(el, session, remote.then_some(target.server.as_str()), 6., cx).ml(px(0.))
            });
        Some(tab.context_menu(sidebar::session_menu(weak, target.server.clone(), session.clone())).into_any_element())
    }
}

#[cfg(test)]
mod tests {
    use super::{groups, reveal_offset, Target, SessionInfo};
    use std::collections::HashMap;

    fn session(name: &str, group: Option<&str>, label: Option<&str>) -> SessionInfo {
        SessionInfo { name: name.into(), pair_gid: group.map(str::to_owned), pair_task: label.map(str::to_owned), ..Default::default() }
    }

    #[test]
    fn tab_groups_keep_members_together_and_preserve_the_front() {
        let lead = session("coordenadora", Some("g"), Some("DEMO-42 · Painéis"));
        let other = session("outra", None, None);
        let worker = session("serviço", Some("g"), None);
        let grouped = groups(vec![(Target::new("a", &lead.name), &lead), (Target::new("a", &other.name), &other),
            (Target::new("a", &worker.name), &worker)], &HashMap::new());
        assert_eq!(grouped.len(), 2);
        assert_eq!(grouped[0].label.as_deref(), Some("DEMO-42 · Painéis"));
        assert_eq!(grouped[0].members, vec![Target::new("a", "coordenadora"), Target::new("a", "serviço")]);
        assert_eq!(grouped[1].members, vec![Target::new("a", "outra")]);
    }

    #[test]
    fn tab_groups_use_the_orchestrator_without_crossing_servers() {
        let worker = session("executor", Some("g"), Some(" "));
        let mut lead = session("principal", Some("g"), Some("Plano"));
        lead.provider = "orq".into();
        let remote = session("executor", Some("g"), Some("Outro trabalho"));
        let grouped = groups(vec![(Target::new("a", "executor"), &worker), (Target::new("b", "executor"), &remote),
            (Target::new("a", "principal"), &lead)], &HashMap::new());
        assert_eq!(grouped.len(), 2);
        assert_eq!(grouped[0].members, vec![Target::new("a", "principal"), Target::new("a", "executor")]);
        assert_eq!(grouped[0].label.as_deref(), Some("Plano"));
        assert_eq!(grouped[1].members, vec![Target::new("b", "executor")]);
    }

    #[test]
    fn members_of_one_group_on_two_machines_share_the_band() {
        let owned = |name: &str| SessionInfo { pair_owner: Some("casa".into()), ..session(name, Some("g"), Some("ABC-1")) };
        let (x, y, solo) = (owned("x"), owned("y"), session("z", Some("g"), None));
        let ids = HashMap::from([("a".to_owned(), "casa".to_owned()), ("b".to_owned(), "lab".to_owned())]);
        let grouped = groups(vec![(Target::new("a", "x"), &x), (Target::new("b", "z"), &solo), (Target::new("b", "y"), &y)], &ids);
        assert_eq!(grouped.len(), 2);
        assert_eq!(grouped[0].members, vec![Target::new("a", "x"), Target::new("b", "y")], "mesma dona e gid: uma faixa");
        assert_eq!(grouped[1].members, vec![Target::new("b", "z")], "gid igual sem dona é outro grupo, da máquina dele");
    }

    #[test]
    fn the_session_that_opened_the_others_becomes_the_single_tab() {
        let lead = session("ABC-42-Lead", Some("g"), Some("ABC-42"));
        let kid = |name: &str| SessionInfo { linked_by: Some("ABC-42-Lead".into()), ..session(name, Some("g"), None) };
        let (web, api, solo) = (kid("ABC-42-web"), kid("ABC-42-api"), session("outra", None, None));
        let grouped = groups(vec![(Target::new("a", &web.name), &web), (Target::new("a", "outra"), &solo),
            (Target::new("a", &lead.name), &lead), (Target::new("a", &api.name), &api)], &HashMap::new());
        assert!(grouped[0].mother, "quem abriu as filhas é a aba do grupo");
        assert_eq!(grouped[0].members[0], Target::new("a", "ABC-42-Lead"));
        assert_eq!(grouped[0].members.len(), 3);
        assert!(!grouped[1].mother);
        // Pareamento de iguais, sem quem abriu: fica a pilha de sempre.
        let (x, y) = (session("x", Some("h"), Some("Par")), session("y", Some("h"), None));
        assert!(!groups(vec![(Target::new("a", "x"), &x), (Target::new("a", "y"), &y)], &HashMap::new())[0].mother);
    }

    #[test]
    fn children_show_the_part_of_the_name_that_differs() {
        let short = super::short_names(&["ABC-42-Lead", "ABC-42-backend", "abc41-mobile", "abc41-web", "solo"]);
        assert_eq!(short, ["Lead", "backend", "mobile", "web", "solo"]);
        assert_eq!(super::short_names(&["x-a", "x-uma-filha-de-nome-comprido"])[1], "uma-filha-d…");
    }

    #[test]
    fn tab_reveal_scrolls_to_the_member_inside_a_wide_group() {
        assert_eq!(reveal_offset(0., (100., 400.), (700., 778.)), -378.);
        assert_eq!(reveal_offset(-400., (100., 400.), (700., 778.)), -400.);
        assert_eq!(reveal_offset(-400., (100., 400.), (100., 284.)), 0.);
    }
}
