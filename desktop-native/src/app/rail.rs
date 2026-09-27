//! Marcador de mensagens (`MessageRail` do Zeron): uma risca por pergunta do usuário na borda esquerda da conversa.
//! A da pergunta que está no topo da tela acende, o mouse em cima mostra o começo dela e o clique leva até ela, mesmo
//! fora do trecho desenhado da lista.
use super::*;

/// Abaixo desta largura da conversa o marcador some: encostaria no texto.
const MIN_WIDTH: f32 = 768.;
/// Altura de cada risca clicável e o vão entre elas.
const SLOT: f32 = 10.;
const GAP: f32 = 3.;
/// Folga acima e abaixo da pilha de riscas.
const MARGIN: f32 = 24.;
/// Pilha compacta em qualquer altura de janela: passando disso, cada risca vale um trecho da conversa.
const MAX_TICKS: usize = 12;
const PREVIEW_CHARS: usize = 160;

/// Trechos `[início, fim)` das perguntas que cada risca representa: uma por risca enquanto couberem.
fn buckets(count: usize, capacity: usize) -> Vec<(usize, usize)> {
    if count == 0 { return Vec::new(); }
    let slots = capacity.clamp(1, count);
    (0..slots).map(|k| (k * count / slots, (k + 1) * count / slots)).collect()
}

fn preview(text: &str) -> String {
    let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() <= PREVIEW_CHARS { return flat; }
    format!("{}…", flat.chars().take(PREVIEW_CHARS - 1).collect::<String>().trim_end())
}

impl Hangar {
    pub(super) fn render_rail(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let viewport = self.list_state.viewport_bounds().size;
        let (width, height) = (f32::from(viewport.width), f32::from(viewport.height));
        // Antes do primeiro layout a lista mede zero: aí desenha, e a medida certa decide no quadro seguinte.
        if width > 0. && width < MIN_WIDTH { return None; }
        let events = &self.chat.events;
        // Recado de outra sessão não é pergunta sua.
        let rows: Vec<(usize, usize)> = self.items.iter().enumerate().filter_map(|(row, item)| match item {
            Item::Event(i) if events[*i].kind == "user_msg" && peer_of(&events[*i]).is_none() => Some((row, *i)),
            _ => None,
        }).collect();
        // Uma pergunta só não é navegação.
        if rows.len() < 2 { return None; }
        // Colada no fim, o topo lógico passa do último item e acende a última pergunta.
        let top = self.list_state.logical_scroll_top().item_ix;
        let active = rows.iter().rposition(|&(row, _)| row <= top).unwrap_or(0);
        let usable = (if height > 0. { height } else { 600. } - 2. * MARGIN).max(SLOT);
        let capacity = (((usable + GAP) / (SLOT + GAP)).floor() as usize).min(MAX_TICKS);
        let ticks = buckets(rows.len(), capacity).into_iter().map(|(start, end)| {
            let lit = (start..end).contains(&active);
            let (row, event) = rows[if lit { active } else { start }];
            let text = display_body(&events[event]);
            let text = if text.trim().is_empty() { activity::web("anexos_imagem_enviada") } else { preview(&text) };
            let label = text.clone();
            div().id(SharedString::from(format!("rail-{}", events[rows[start].1].id))).group("rail-tick")
                .h(px(SLOT)).w_full().flex().items_center().cursor_pointer()
                .role(Role::Button).aria_label(text.clone())
                .tooltip(move |window, cx| gpui_kit::component::tooltip::Tooltip::new(label.clone()).build(window, cx))
                .on_click(cx.listener(move |this, _, _, cx| this.jump_to_row(row, cx)))
                .child(div().h(px(2.)).w(px(12.)).rounded(px(1.)).bg(if lit { theme::text().opacity(0.8) } else { theme::faint().opacity(0.5) })
                    .group_hover("rail-tick", |el| el.w(px(20.)).bg(theme::text().opacity(0.8))))
        });
        Some(div().absolute().left(px(16.)).top_0().bottom_0().w(px(26.)).flex().flex_col().items_start().justify_center()
            .gap(px(GAP)).children(ticks).into_any_element())
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn buckets_cover_every_question_once() {
        assert_eq!(super::buckets(3, 12), vec![(0, 1), (1, 2), (2, 3)]);
        let many = super::buckets(100, 12);
        assert_eq!((many.len(), many[0].0, many[11].1), (12, 0, 100));
        assert!(many.windows(2).all(|pair| pair[0].1 == pair[1].0));
        assert!(super::buckets(0, 12).is_empty());
    }
}
