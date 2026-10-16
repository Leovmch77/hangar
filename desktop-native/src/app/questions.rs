use super::*;
use gpui_kit::component::input::AnyInputState;

pub(super) fn new_input(secret: bool, window: &mut Window, cx: &mut App) -> AnyInputState {
    if secret {
        cx.new(|cx| InputState::new(window, cx).masked(true).placeholder(tr("ask_placeholder"))).into()
    } else {
        cx.new(|cx| TextareaState::new(window, cx).rows(4).placeholder(tr("ask_placeholder"))).into()
    }
}

pub(super) fn field(input: &AnyInputState, busy: bool) -> AnyElement {
    let field = match input {
        AnyInputState::Input(input) => Input::new(input).small().aria_label(tr("ask_placeholder")).disabled(busy).into_any_element(),
        AnyInputState::Textarea(input) => Textarea::new(input).small().h(rems(6.5)).text_size(rems(0.8125))
            .aria_label(tr("ask_placeholder")).disabled(busy).into_any_element(),
        _ => unreachable!("a resposta é um campo simples ou multilinha"),
    };
    div().id("ask-answer").debug_selector(|| "ask-answer".into()).flex_shrink_0().child(field).into_any_element()
}

pub(super) fn body_height(window_height: f32) -> f32 {
    // Cabeçalho, ações e compositor conservam espaço mesmo com uma pergunta longa.
    (window_height - 360.).max(0.)
}

pub(super) fn card(
    minimized: bool,
    progress: String,
    body: AnyElement,
    footer: AnyElement,
    scroll: &ScrollHandle,
    max_body_height: f32,
    on_toggle: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
) -> AnyElement {
    let toggle_id = if minimized { "ask-reopen" } else { "ask-minimize" };
    let header = div().flex().items_center().gap_2().px_3().py_2()
        .child(div().flex_1().min_w_0().flex().flex_wrap().items_center().gap_2()
            .child(div().text_xs().font_weight(FontWeight::MEDIUM).child(tr(if minimized { "ask_pending" } else { "ask_title" })))
            .child(div().text_xs().text_color(theme::muted()).child(progress)))
        .child(Button::new(toggle_id).debug_selector(move || toggle_id.into()).small().ghost()
            .icon(if minimized { IconName::ChevronDown } else { IconName::Minus })
            .label(tr(if minimized { "ask_reopen" } else { "ask_minimize" })).on_click(on_toggle));
    div().id("ask-card").rounded(px(12.)).border_1().border_color(theme::ask_highlight().opacity(0.55))
        .bg(theme::boxed()).shadow(theme::card_shadow()).flex().flex_col().text_sm()
        .child(header)
        .when(!minimized, |el| el
            .child(div().border_t_1().border_color(theme::border()).p_3()
                .child(scrolled("ask-body-scroll", scroll, max_body_height, body)))
            .child(div().border_t_1().border_color(theme::border()).px_3().py_2().child(footer)))
        .into_any_element()
}

#[cfg(test)]
mod tests {
    use super::{body_height, card, field, new_input};
    use gpui::{Context, Entity, IntoElement, Modifiers, Render, ScrollHandle, TestAppContext, VisualTestContext, Window, div, point, px, size, prelude::*};
    use gpui_kit::component::input::{AnyInputState, Textarea, TextareaState};

    struct QuestionSurface {
        minimized: bool,
        input: Entity<TextareaState>,
        scroll: ScrollHandle,
        long_question: bool,
    }

    impl Render for QuestionSurface {
        fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
            card(self.minimized, "1 de 2 respondidas".into(),
                div().debug_selector(|| "question-body".into())
                    .when(self.long_question, |el| el.child(div().h(px(1500.)).child("Pergunta longa")))
                    .child(Textarea::new(&self.input)).into_any_element(),
                div().debug_selector(|| "question-footer".into()).child("Enviar").into_any_element(),
                &self.scroll, body_height(f32::from(window.viewport_size().height)),
                cx.listener(|this, _, _, cx| { this.minimized = !this.minimized; cx.notify(); }))
        }
    }

    fn draw(cx: &mut VisualTestContext) {
        cx.run_until_parked();
        cx.update(|window, cx| { let _ = window.draw(cx); });
    }

    #[gpui::test]
    fn minimizing_questions_preserves_the_draft_and_reopens_the_form(cx: &mut TestAppContext) {
        cx.update(gpui_kit::init);
        let (view, cx) = cx.add_window_view(|window, cx| {
            window.retain_a11y_tree(true);
            QuestionSurface { minimized: false, scroll: ScrollHandle::new(), long_question: false,
                input: cx.new(|cx| TextareaState::new(window, cx).default_value("Primeira linha\nSegunda linha")) }
        });
        cx.simulate_resize(size(px(680.), px(800.)));
        draw(cx);
        assert!(cx.debug_bounds("question-body").is_some());
        let minimize = cx.debug_bounds("ask-minimize");
        assert!(minimize.is_some(), "a pergunta precisa oferecer o botão Minimizar");
        cx.simulate_click(minimize.unwrap().center(), Modifiers::default());
        draw(cx);
        assert!(cx.debug_bounds("question-body").is_none());
        assert!(cx.debug_bounds("question-footer").is_none());
        let reopen = cx.debug_bounds("ask-reopen").expect("a faixa precisa permitir reabrir");
        assert!(reopen.size.height <= px(40.), "a faixa minimizada ocupa uma linha");
        cx.simulate_click(reopen.center(), Modifiers::default());
        draw(cx);
        assert!(cx.debug_bounds("question-body").is_some());
        assert!(cx.debug_bounds("question-footer").is_some());
        let snapshot = cx.update(|window, cx| { let _ = window.draw(cx); window.a11y_snapshot(None).unwrap() });
        assert!(snapshot.contains("Primeira linha") && snapshot.contains("Segunda linha"), "o rascunho reaparece inteiro: {snapshot}");
        assert!(!view.read_with(cx, |view, _| view.minimized));
    }

    #[gpui::test]
    fn long_question_scrolls_without_pushing_actions_out_of_a_short_window(cx: &mut TestAppContext) {
        cx.update(gpui_kit::init);
        let (view, cx) = cx.add_window_view(|window, cx| QuestionSurface {
            minimized: false, scroll: ScrollHandle::new(), long_question: true,
            input: cx.new(|cx| TextareaState::new(window, cx)),
        });
        cx.simulate_resize(size(px(680.), px(480.)));
        draw(cx);
        let footer = cx.debug_bounds("question-footer").expect("as ações continuam visíveis");
        let body = cx.debug_bounds("question-body").unwrap();
        assert!(footer.bottom() < px(480.), "as ações precisam caber na janela: {footer:?}");
        assert!(body.size.height > px(1500.), "a pergunta não deve ser truncada");
        let position = point(body.left() + px(20.), body.top() + px(20.));
        cx.simulate_event(gpui::ScrollWheelEvent { position, delta: gpui::ScrollDelta::Pixels(point(px(0.), px(-1500.))),
            modifiers: Modifiers::default(), touch_phase: gpui::TouchPhase::Moved });
        draw(cx);
        assert!(view.read_with(cx, |view, _| view.scroll.offset().y) < px(0.), "o corpo comprido precisa rolar");
        assert_eq!(cx.debug_bounds("question-footer").unwrap(), footer, "rolar a pergunta não desloca as ações");
    }

    struct FieldSurface(AnyInputState);

    impl Render for FieldSurface {
        fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
            div().w(px(500.)).child(field(&self.0, false))
        }
    }

    #[gpui::test]
    fn written_answer_has_room_for_multiple_lines_and_keeps_line_breaks(cx: &mut TestAppContext) {
        cx.update(gpui_kit::init);
        let (view, cx) = cx.add_window_view(|window, cx| FieldSurface(new_input(false, window, cx)));
        draw(cx);
        let bounds = cx.debug_bounds("ask-answer").unwrap();
        assert!(bounds.size.height >= px(96.), "o campo precisa mostrar várias linhas: {bounds:?}");
        cx.simulate_click(bounds.center(), Modifiers::default());
        cx.simulate_input("Primeira linha");
        cx.simulate_keystrokes("enter");
        cx.simulate_input("Segunda linha");
        draw(cx);
        assert_eq!(view.read_with(cx, |view, cx| view.0.value(cx)), "Primeira linha\nSegunda linha");
    }

    #[gpui::test]
    fn secret_answer_is_masked_and_keeps_the_value_for_sending(cx: &mut TestAppContext) {
        cx.update(gpui_kit::init);
        let (view, cx) = cx.add_window_view(|window, cx| {
            window.retain_a11y_tree(true);
            FieldSurface(new_input(true, window, cx))
        });
        draw(cx);
        let bounds = cx.debug_bounds("ask-answer").unwrap();
        cx.simulate_click(bounds.center(), Modifiers::default());
        cx.simulate_input("resposta-sigilosa-sintética");
        draw(cx);
        let snapshot = cx.update(|window, cx| { let _ = window.draw(cx); window.a11y_snapshot(None).unwrap() });
        assert!(!snapshot.contains("resposta-sigilosa-sintética"));
        assert_eq!(view.read_with(cx, |view, cx| view.0.value(cx)), "resposta-sigilosa-sintética");
    }
}
