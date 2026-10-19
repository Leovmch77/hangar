//! Linha "N subagentes" acima do campo: as sessões ligadas à conversa aberta (`linked_by`), na caixa mono da faixa
//! dos mods. Começa fechada, como os mods; aberta ou fechada é escolha de cada conversa.
use gpui_kit::base::AccordionTrigger;

use super::*;
use super::sidebar::Target;

/// Cerca de quatro filhas à vista; o resto rola, para a faixa não empurrar a conversa.
const LIST_MAX: f32 = 4. * 24.;

/// O que não é pergunta nem pronto conta como trabalhando (carregando, sem estado).
fn tone(state: &str) -> &'static str {
    match state { "awaiting_input" => "awaiting_input", "idle" => "idle", _ => "working" }
}

/// As palavras do `rotuloEstado` do web, pelo tom.
fn state_label(tone: &str) -> String {
    tr_shared(match tone { "awaiting_input" => "estado_aguardando", "idle" => "estado_pronto", _ => "estado_em_execucao" }, &[])
}

fn dot(state: &str) -> Div { div().flex_shrink_0().size(px(8.)).rounded_full().bg(theme::status(tone(state))) }

impl Hangar {
    /// Nenhuma filha ligada: nada desenhado.
    pub(super) fn render_linked_children(&mut self, window: &mut Window, cx: &mut Context<Self>) -> Option<AnyElement> {
        let parent = self.selected.as_ref()?.name.clone();
        let server = self.open_server();
        let mut children: Vec<&SessionInfo> = self.sessions_of(&server).iter()
            .filter(|s| s.linked_by.as_deref() == Some(parent.as_str())).collect();
        // Mesma ordem do `linkedChildren` do core (PWA e app): por nome, não pela atividade da lista.
        children.sort_by(|a, b| a.name.cmp(&b.name));
        if children.is_empty() { return None; }
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
                .children(children.iter().map(|c| div().flex_shrink_0().px(px(7.)).rounded(px(5.)).bg(theme::hover())
                    .font_family(theme::SANS).text_size(px(12.5)).child(c.name.clone()))))
            .child(div().flex_shrink_0().flex().items_center().gap(px(10.)).whitespace_nowrap()
                .child(div().flex().items_center().gap(px(7.)).children(children.iter().map(|c| dot(&c.state))))
                .child(div().text_color(theme::muted())
                    .child(tr_shared("linked_children_done", &[("done", &done), ("total", &total)]))));

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
                    div().flex().items_center().gap(px(10.)).min_h(px(24.)).pl(px(22.))
                        .child(dot(&c.state))
                        .child(div().w(px(150.)).flex_shrink_0().min_w_0().truncate().font_weight(FontWeight::BOLD).child(c.name.clone()))
                        .child(div().w(px(140.)).flex_shrink_0().min_w_0().truncate().text_color(theme::muted()).child(kind))
                        .child(div().flex_shrink_0().whitespace_nowrap().text_color(theme::status(tone)).child(state_label(tone)))
                        .child(div().flex_1().min_w_0().truncate().text_color(theme::muted()).child(last))
                        .child(Button::new(SharedString::from(format!("linked-child-open-{i}"))).link().xsmall()
                            .label(open_label.clone()).accessibility_label(format!("{open_label}: {}", c.name))
                            .on_click(cx.listener(move |this, _, window, cx| this.open_target(&target, window, cx))))
                }))
        });

        // Mesmo material e tipo da faixa dos mods (`plugin_ui::frame`), logo acima dela.
        Some(div().w_full().mb(px(4.)).px(px(10.)).py(px(6.)).rounded(px(8.)).bg(theme::inset()).overflow_hidden()
            .font_family(theme::MONO).text_size(px(12.)).line_height(px(17.)).text_color(theme::text())
            .child(header).children(list).into_any_element())
    }
}
