//! A coluna da conversa com o terminal encaixado, montada como no `render` do app com Abas embaixo.
use super::{CONVERSATION_MIN_HEIGHT, TERMINAL_MIN_HEIGHT, conversation_pane_style, docked_terminal_frame};
use gpui::{Context, IntoElement, Render, TestAppContext, Window, div, px, size, prelude::*};

/// Cabeçalho, conversa, faixa de baixo e terminal no corpo; a barra de abas depois dele.
struct Column { terminal: f32, bottom: f32 }

impl Render for Column {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        let mut conversation = div().debug_selector(|| "conversation".into());
        conversation.style().refine(&conversation_pane_style(true));
        div().size_full().flex().flex_col()
            .child(div().flex_1().min_h_0().flex()
                .child(div().relative().flex_1().min_w_0().h_full().flex().flex_col()
                    .child(div().h(px(44.)).flex_shrink_0())
                    .child(conversation)
                    .child(div().w_full().flex_shrink_0().h(px(self.bottom)))
                    .child(docked_terminal_frame(self.terminal).debug_selector(|| "terminal".into()))))
            .child(div().w_full().h(px(44.)).flex_shrink_0().debug_selector(|| "tab-bar".into()))
    }
}

fn layout(cx: &mut TestAppContext, terminal: f32) -> [gpui::Bounds<gpui::Pixels>; 3] {
    let (_, cx) = cx.add_window_view(|_, _| Column { terminal, bottom: 223. });
    cx.simulate_resize(size(px(1180.), px(800.)));
    cx.run_until_parked();
    cx.update(|window, cx| { let _ = window.draw(cx); });
    ["conversation", "terminal", "tab-bar"].map(|selector| cx.debug_bounds(selector).unwrap())
}

#[gpui::test]
fn docked_terminal_taller_than_the_column_stops_at_the_bottom_tab_bar(cx: &mut TestAppContext) {
    let [conversation, terminal, bar] = layout(cx, 800.);
    assert!(terminal.bottom() <= bar.top(), "o pé do terminal ({:?}) passou da barra de abas ({:?})", terminal.bottom(), bar.top());
    assert!(conversation.size.height >= px(CONVERSATION_MIN_HEIGHT), "a conversa sumiu: {:?}", conversation.size.height);
    assert!(terminal.size.height >= px(TERMINAL_MIN_HEIGHT));
}

#[gpui::test]
fn docked_terminal_that_fits_keeps_the_stored_height(cx: &mut TestAppContext) {
    let [_, terminal, bar] = layout(cx, 300.);
    assert_eq!(terminal.size.height, px(300.));
    assert!(terminal.bottom() <= bar.top());
}
