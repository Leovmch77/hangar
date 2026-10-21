//! Linha "N subagentes" acima do campo: as sessões ligadas à conversa aberta (`linked_by`), na caixa mono da faixa
//! dos mods. Começa fechada, como os mods; aberta ou fechada é escolha de cada conversa.
use gpui_kit::base::AccordionTrigger;

use super::*;
use super::sidebar::Target;

/// Cerca de quatro filhas à vista; o resto rola, para a faixa não empurrar a conversa.
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
    fn linked_avatar(&self, place: &str, server: &str, session: &SessionInfo, size: f32) -> AnyElement {
        self.avatar_slot(panes::Area::Bottom, format!("linked-{place}-{}", Target::new(server, &session.name).id()), sidebar::session_look(session), size)
    }

    /// Filhas ligadas à conversa aberta; sem filhas, a faixa de volta ao pai quando ela mesma é filha; senão nada.
    pub(super) fn render_linked_children(&mut self, window: &mut Window, cx: &mut Context<Self>) -> Option<AnyElement> {
        let parent = self.selected.as_ref()?.name.clone();
        let server = self.open_server();
        let mut children: Vec<&SessionInfo> = self.sessions_of(&server).iter()
            .filter(|s| s.linked_by.as_deref() == Some(parent.as_str())).collect();
        // Mesma ordem do `linkedChildren` do core (PWA e app): por nome, não pela atividade da lista.
        children.sort_by(|a, b| a.name.cmp(&b.name));
        if children.is_empty() { return self.render_linked_parent(&server, cx); }
        let key = Target::new(&server, &parent);
        let expanded = self.linked_children_open.contains(&key);
        let total = children.len().to_string();
        let count = if children.len() == 1 { tr_shared("linked_children_count_one", &[]) } else { tr_shared("linked_children_count", &[("count", &total)]) };
        let done = children.iter().filter(|c| tone(&c.state) == "idle").count().to_string();

        let focus = window.use_keyed_state("linked-children-header-focus", cx, |_, cx| cx.focus_handle().tab_stop(true)).read(cx).clone();
        let weak = cx.entity().downgrade();
        let header = AccordionTrigger::new("linked-children-header").open(expanded).track_focus(&focus)
            .flex().items_center().gap(px(10.)).min_w_0().rounded(px(6.)).cursor_pointer().hover(|el| el.bg(theme::hover()))
            .when(focus.is_focused(window), |el| el.focus_ring_style(window, cx))
            // O nome falado leva o que se vê (contagem e concluídos), não só a ação.
            .aria_label(format!("{count}, {}", tr_shared("linked_children_done", &[("done", &done), ("total", &total)])))
            .on_change(move |open, _, _, cx| {
                let _ = weak.update(cx, |this, cx| {
                    if open { this.linked_children_open.insert(key.clone()); } else { this.linked_children_open.remove(&key); }
                    cx.notify();
                });
            })
            .child(chrome::small_icon(if expanded { IconName::ChevronDown } else { IconName::ChevronRight }, 12., theme::text()))
            .child(div().flex_shrink_0().flex().gap(px(6.)).whitespace_nowrap()
                .child("⑃").child(div().font_weight(FontWeight::BOLD).child(count)))
            .child(div().flex().flex_1().gap(px(6.)).min_w_0().overflow_hidden()
                .children(children.iter().map(|c| div().flex_shrink_0().flex().items_center().gap(px(5.)).pl(px(4.)).pr(px(7.))
                    .rounded(px(5.)).bg(theme::hover()).font_family(theme::SANS).text_size(px(12.5))
                    .child(self.linked_avatar("chip", &server, c, 14.)).child(c.name.clone()))))
            .child(div().flex_shrink_0().whitespace_nowrap().text_color(theme::muted())
                .child(tr_shared("linked_children_done", &[("done", &done), ("total", &total)])));

        let list = expanded.then(|| {
            let open_label = tr_shared("linked_children_open", &[]);
            div().id("linked-children-list").max_h(px(LIST_MAX)).overflow_y_scroll().flex().flex_col().pt(px(4.))
                .children(children.iter().enumerate().map(|(i, c)| {
                    let tone = tone(&c.state);
                    let provider = super::orchestration::provider_name(&c.provider);
                    let kind = match c.engine.as_deref().or(c.model.as_deref()).filter(|m| !m.is_empty()) {
                        Some(model) => format!("{provider} · {}", crate::status::model_label(model)),
                        None => provider.to_owned(),
                    };
                    let last = c.last_reply.as_deref().map(|text| conversation::one_line(text, 160)).unwrap_or_default();
                    let target = Target::new(&server, &c.name);
                    // O estado está no avatar; o nome falado o leva em palavras.
                    div().flex().items_center().gap(px(10.)).min_h(px(24.)).pl(px(22.))
                        .child(self.linked_avatar("row", &server, c, 16.))
                        .child(div().w(px(150.)).flex_shrink_0().min_w_0().truncate().font_weight(FontWeight::BOLD).child(c.name.clone()))
                        .child(div().w(px(160.)).flex_shrink_0().min_w_0().truncate().text_color(theme::muted()).child(kind))
                        .child(div().flex_1().min_w_0().truncate().text_color(theme::muted()).child(last))
                        .child(Button::new(SharedString::from(format!("linked-child-open-{i}"))).link().xsmall()
                            .label(open_label.clone()).accessibility_label(format!("{open_label}: {} · {}", c.name, state_label(tone)))
                            .on_click(cx.listener(move |this, _, window, cx| this.open_target(&target, window, cx))))
                }))
        });

        Some(linked_frame().child(header).children(list).into_any_element())
    }

    /// Na filha ligada: quem a abriu, com o avatar e o estado dele; o clique volta para a conversa do pai.
    fn render_linked_parent(&self, server: &str, cx: &mut Context<Self>) -> Option<AnyElement> {
        let name = self.selected.as_ref()?.linked_by.clone()?;
        let parent = self.sessions_of(server).iter().find(|s| s.name == name)?;
        let target = Target::new(server, &name);
        let back = tr_shared("linked_parent_back", &[]);
        let pick = target.clone();
        Some(linked_frame().child(div().flex().items_center().gap(px(10.)).min_w_0()
            .child(div().flex_shrink_0().whitespace_nowrap().text_color(theme::muted()).child(format!("↰ {}", tr_shared("linked_parent_opened_by", &[]))))
            .child(div().id("linked-parent-pill").min_w_0().flex().items_center().gap(px(6.)).pl(px(4.)).pr(px(8.)).rounded(px(5.))
                .bg(theme::hover()).cursor_pointer().hover(|el| el.bg(theme::accent_dim()))
                .font_family(theme::SANS).text_size(px(12.5)).font_weight(FontWeight::BOLD)
                .role(Role::Button).aria_label(format!("{back}: {name} · {}", state_label(tone(&parent.state))))
                .child(self.linked_avatar("parent", server, parent, 14.))
                .child(div().min_w_0().truncate().child(name.clone()))
                .on_click(cx.listener(move |this, _, window, cx| this.open_target(&pick, window, cx))))
            .child(div().flex_1())
            .child(Button::new("linked-parent-back").link().xsmall().label(back.clone()).accessibility_label(format!("{back}: {name}"))
                .on_click(cx.listener(move |this, _, window, cx| this.open_target(&target, window, cx)))))
            .into_any_element())
    }
}

/// Mesmo material e tipo da faixa dos mods (`plugin_ui::frame`), logo acima dela.
fn linked_frame() -> Div {
    div().w_full().mb(px(4.)).px(px(10.)).py(px(6.)).rounded(px(8.)).bg(theme::inset()).overflow_hidden()
        .font_family(theme::MONO).text_size(px(12.)).line_height(px(17.)).text_color(theme::text())
}
