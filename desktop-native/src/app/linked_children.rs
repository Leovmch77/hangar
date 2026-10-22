//! Faixa do grupo acima do campo: todos os membros do grupo da conversa aberta, de qualquer máquina conectada, com o
//! vínculo de cada um (quem abriu quem). Na caixa mono da faixa dos mods. Começa fechada, como os mods; aberta ou
//! fechada é escolha de cada conversa.
use gpui_kit::base::AccordionTrigger;

use super::*;
use super::grouping::{Member, Row, global_groups};
use super::sidebar::Target;

/// Cerca de quatro membros à vista; o resto rola, para a faixa não empurrar a conversa.
const LIST_MAX: f32 = 4. * 24.;

/// O que não é pergunta, pronto nem encerrado conta como trabalhando (carregando, sem estado).
fn tone(state: &str) -> &'static str {
    match state { "awaiting_input" => "awaiting_input", "idle" => "idle", "dead" => "dead", _ => "working" }
}

/// As palavras do `rotuloEstado` do web, pelo tom.
fn state_label(tone: &str) -> String {
    tr_shared(match tone { "awaiting_input" => "estado_aguardando", "idle" => "estado_pronto", "dead" => "estado_encerrado", _ => "estado_em_execucao" }, &[])
}

impl Hangar {
    /// O avatar do agente com o estado (o giro de trabalhando é pintado fora da faixa guardada, como nas abas).
    /// `place` separa o chip do cabeçalho da linha da lista: a mesma chave faria um lugar apagar o outro.
    fn linked_avatar(&self, place: &str, target: &Target, session: &SessionInfo, size: f32) -> AnyElement {
        self.avatar_slot(panes::Area::Bottom, format!("linked-{place}-{}", target.id()), sidebar::session_look(session), size)
    }

    /// Os membros do grupo da conversa aberta que abrem daqui, por nome, e os que não abrem (máquina sem conexão aqui,
    /// par de fora) como texto; nada sem grupo de dois.
    fn open_group(&self) -> Option<(Target, Vec<(Target, &SessionInfo)>, Vec<String>)> {
        let open = self.selected.as_ref()?;
        // Sem grupo nada a montar: a conta abaixo roda a cada desenho da área do campo.
        if open.pair_gid.as_deref().is_none_or(str::is_empty) && open.peers().is_empty() { return None; }
        // shortcut: refeito a cada desenho com grupo; lista curta. Memoizar como `tab_groups` se pesar.
        let current = Target::new(&self.open_server(), &open.name);
        let mut machines = self.group_machines();
        if !machines.contains(&current.server) { machines.push(current.server.clone()); }
        let rows: Vec<Row> = machines.iter().flat_map(|key| self.sessions_of(key).iter().map(move |s| Row { server: key, session: s, invite: false })).collect();
        let here = |m: &Member| matches!(m, Member::Here { server, name } if *server == current.server && *name == current.name);
        let group = global_groups(&rows, &self.identities()).into_iter().find(|g| g.members.iter().any(here))?;
        let mut members: Vec<(Target, &SessionInfo)> = group.members.iter().filter_map(|m| match m {
            Member::Here { server, name } => self.sessions_of(server).iter().find(|s| s.name == *name).map(|s| (Target::new(server, name), s)),
            _ => None,
        }).collect();
        let away: Vec<String> = group.members.iter().filter_map(|m| match m {
            Member::Missing { server_id, name } => Some(format!("{server_id}::{name}")),
            Member::Outside { alias, session } => Some(format!("{alias}::{session}")),
            Member::Here { .. } => None,
        }).collect();
        if members.len() + away.len() < 2 { return None; }
        members.sort_by(|a, b| a.1.name.cmp(&b.1.name).then_with(|| a.0.server.cmp(&b.0.server)));
        Some((current, members, away))
    }

    /// O grupo da conversa aberta; sem grupo, nada.
    pub(super) fn render_linked_children(&mut self, window: &mut Window, cx: &mut Context<Self>) -> Option<AnyElement> {
        let (current, members, away) = self.open_group()?;
        // Nome de outra máquina leva a máquina, como na lista do grupo.
        let names: Vec<String> = members.iter().map(|(t, _)| if t.server == current.server { t.name.clone() }
            else { format!("{}::{}", self.machine_label(&t.server, cx), t.name) }).collect();
        let label = members.iter().find_map(|(_, s)| s.pair_task.as_deref().map(str::trim).filter(|t| !t.is_empty())).unwrap_or_default().to_owned();
        // O vínculo só existe na mesma máquina: quem abriu está na máquina da filha.
        let relation = |t: &Target, s: &SessionInfo| -> String {
            if let Some(parent) = s.linked_by.as_deref().filter(|p| members.iter().any(|(m, _)| m.server == t.server && m.name == *p)) {
                return tr_shared("native_group_panel_child_of", &[("name", parent)]);
            }
            let kids: Vec<&str> = members.iter().filter(|(m, k)| m.server == t.server && k.linked_by.as_deref() == Some(t.name.as_str())).map(|(m, _)| m.name.as_str()).collect();
            if kids.is_empty() { String::new() } else { tr_shared("native_group_panel_parent_of", &[("names", &kids.join(", "))]) }
        };
        let relations: Vec<String> = members.iter().map(|(t, s)| relation(t, s)).collect();
        // A conversa aberta já está na tela: o painel mostra só os outros membros.
        let others: Vec<usize> = (0..members.len()).filter(|&i| members[i].0 != current).collect();
        // A coluna do vínculo só ocupa lugar quando algum membro mostrado tem um.
        let show_relation = others.iter().any(|&i| !relations[i].is_empty());
        let expanded = self.linked_children_open.contains(&current);
        let total = (members.len() + away.len()).to_string();
        let title = tr_shared("native_group_panel_title", &[("count", &total)]);
        let working = others.iter().filter(|&&i| sidebar::working(members[i].1)).count();
        let busy = (working > 0).then(|| tr_shared("native_group_panel_working", &[("count", &working.to_string())]));

        let focus = window.use_keyed_state("linked-children-header-focus", cx, |_, cx| cx.focus_handle().tab_stop(true)).read(cx).clone();
        let weak = cx.entity().downgrade();
        let key = current.clone();
        let header = AccordionTrigger::new("linked-children-header").open(expanded).track_focus(&focus)
            .flex().items_center().gap(px(10.)).min_w_0().rounded(px(6.)).cursor_pointer().hover(|el| el.bg(theme::hover()))
            .when(focus.is_focused(window), |el| el.focus_ring_style(window, cx))
            .aria_label(match &busy { Some(b) => format!("{title}, {b}"), None => title.clone() })
            .on_change(move |open, _, _, cx| {
                let _ = weak.update(cx, |this, cx| {
                    if open { this.linked_children_open.insert(key.clone()); } else { this.linked_children_open.remove(&key); }
                    cx.notify();
                });
            })
            .child(chrome::small_icon(if expanded { IconName::ChevronDown } else { IconName::ChevronRight }, 12., theme::text()))
            .child(div().flex_shrink_0().flex().gap(px(6.)).whitespace_nowrap()
                .child("⑃").child(div().font_weight(FontWeight::BOLD).child(title)))
            .when(!label.is_empty(), |el| el.child(div().flex_shrink_0().max_w(px(260.)).truncate().text_color(theme::muted()).child(label.clone())))
            .child(div().flex().flex_1().gap(px(6.)).min_w_0().overflow_hidden()
                .children(others.iter().map(|&i| {
                    let (t, s) = &members[i];
                    let pick = t.clone();
                    div().id(SharedString::from(format!("group-chip-{i}"))).flex_shrink_0().flex().items_center().gap(px(5.)).pl(px(4.)).pr(px(7.))
                        .rounded(px(5.)).bg(theme::hover()).font_family(theme::SANS).text_size(px(12.5))
                        .cursor_pointer().hover(|el| el.bg(theme::accent_dim()))
                        .on_click(cx.listener(move |this, _, window, cx| { cx.stop_propagation(); this.open_target(&pick, window, cx); }))
                        .child(self.linked_avatar("chip", t, s, 14.)).child(names[i].clone())
                }))
                // Membro que não abre daqui: só o nome, apagado e sem clique.
                .children(away.iter().map(|name| div().flex_shrink_0().px(px(7.)).rounded(px(5.)).border_1().border_color(theme::border())
                    .font_family(theme::SANS).text_size(px(12.5)).text_color(theme::faint()).child(name.clone()))))
            .children(busy.map(|b| div().flex_shrink_0().whitespace_nowrap().text_color(theme::muted()).child(b)));

        let list = expanded.then(|| {
            let open_label = tr_shared("linked_children_open", &[]);
            div().id("linked-children-list").max_h(px(LIST_MAX)).overflow_y_scroll().flex().flex_col().pt(px(4.))
                .children(others.iter().map(|&i| {
                    let (t, s) = &members[i];
                    let provider = super::orchestration::provider_name(&s.provider);
                    let kind = match s.engine.as_deref().or(s.model.as_deref()).filter(|m| !m.is_empty()) {
                        Some(model) => format!("{provider} · {}", crate::status::model_label(model)),
                        None => provider.to_owned(),
                    };
                    let last = s.last_reply.as_deref().map(|text| conversation::one_line(text, 160)).unwrap_or_default();
                    let target = t.clone();
                    let name = names[i].clone();
                    // O estado está no avatar; o nome falado o leva em palavras.
                    let row = target.clone();
                    div().id(SharedString::from(format!("group-row-{i}"))).flex().items_center().gap(px(10.)).min_h(px(24.)).pl(px(22.)).rounded(px(5.))
                        .cursor_pointer().hover(|el| el.bg(theme::hover()))
                        .on_click(cx.listener(move |this, _, window, cx| this.open_target(&row, window, cx)))
                        .child(self.linked_avatar("row", t, s, 16.))
                        .child(div().w(px(190.)).flex_shrink_0().min_w_0().truncate().font_weight(FontWeight::BOLD).child(name.clone()))
                        .child(div().w(px(160.)).flex_shrink_0().min_w_0().truncate().text_color(theme::muted()).child(kind))
                        .when(show_relation, |el| el.child(div().w(px(270.)).flex_shrink_0().min_w_0().truncate().text_color(theme::accent()).child(relations[i].clone())))
                        .child(div().flex_1().min_w_0().truncate().text_color(theme::muted()).child(last))
                        .child(Button::new(SharedString::from(format!("linked-child-open-{i}"))).link().xsmall()
                            .label(open_label.clone()).accessibility_label(format!("{open_label}: {name} · {}", state_label(tone(&s.state))))
                            .on_click(cx.listener(move |this, _, window, cx| { cx.stop_propagation(); this.open_target(&target, window, cx); })))
                }))
        });

        Some(linked_frame().child(header).children(list).into_any_element())
    }
}

/// Mesmo material e tipo da faixa dos mods (`plugin_ui::frame`), logo acima dela.
fn linked_frame() -> Div {
    div().w_full().mb(px(4.)).px(px(10.)).py(px(6.)).rounded(px(8.)).bg(theme::inset()).overflow_hidden()
        .font_family(theme::MONO).text_size(px(12.)).line_height(px(17.)).text_color(theme::text())
}
