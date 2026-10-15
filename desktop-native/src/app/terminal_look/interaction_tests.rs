use super::{assistant_text_row, fold_lead, live_thinking_content, terminal_tool_body, tool_body_control};
use gpui::{Context, Entity, IntoElement, Modifiers, MouseButton, MouseDownEvent, MouseUpEvent, Render, TestAppContext, VisualTestContext, Window, div, point, px, prelude::*};
use gpui_kit::component::text::TextView;
use gpui_kit::base::text::TextViewState;

struct ThinkingSurface {
    text: Entity<TextViewState>,
    look: crate::appearance::ToolLook,
}

impl Render for ThinkingSurface {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        live_thinking_content(self.look, &self.text, None, cx)
    }
}

#[gpui::test]
fn terminal_thinking_shows_brain_label_once_without_the_old_marker(cx: &mut TestAppContext) {
    cx.update(gpui_kit::init);
    let (_, cx) = cx.add_window_view(|window, cx| {
        window.retain_a11y_tree(true);
        ThinkingSurface {
            text: cx.new(|cx| TextViewState::markdown("Texto sintético já exposto. **Conteúdo completo**.", cx)),
            look: crate::appearance::ToolLook::Terminal,
        }
    });
    cx.run_until_parked();
    let snapshot = cx.update(|window, cx| { let _ = window.draw(cx); window.a11y_snapshot(None).unwrap() });
    // O `∴` saiu: quem abre o raciocínio agora é o brain, e o rótulo do T3 aparece uma vez só.
    assert!(!snapshot.contains('∴'));
    assert_eq!(snapshot.matches(&crate::i18n::tr("thinking_live")).count(), 1);
    assert_eq!(snapshot.matches("Texto sintético já exposto.").count(), 1);
    assert!(!snapshot.lines().any(|line| line.trim_start().starts_with("Button ")));
}

#[gpui::test]
fn non_terminal_live_thinking_keeps_its_existing_header(cx: &mut TestAppContext) {
    cx.update(gpui_kit::init);
    let (view, cx) = cx.add_window_view(|window, cx| {
        window.retain_a11y_tree(true);
        ThinkingSurface {
            text: cx.new(|cx| TextViewState::markdown("Texto sintético já exposto.", cx)),
            look: crate::appearance::ToolLook::Classic,
        }
    });
    for look in [crate::appearance::ToolLook::Classic, crate::appearance::ToolLook::Chips, crate::appearance::ToolLook::Tree] {
        view.update(cx, |view, cx| { view.look = look; cx.notify(); });
        cx.run_until_parked();
        let snapshot = cx.update(|window, cx| { let _ = window.draw(cx); window.a11y_snapshot(None).unwrap() });
        assert!(!snapshot.contains('∴'));
        assert_eq!(snapshot.matches(&crate::i18n::tr("thinking_live")).count(), 1);
    }
}

struct ControlSurface {
    collapsed: Vec<String>,
    activated: Vec<String>,
    text: Entity<TextViewState>,
    look: crate::appearance::ToolLook,
}

impl Render for ControlSurface {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let mut body = div().w(px(400.)).flex().flex_col().child(gpui_kit::base::TextSelectionLayer)
            .child(gpui_kit::base::TextView::new(&self.text).selectable(true).scrollable(false));
        for selector in ["copy-control", "open-control", "save-control", "image-control", "diff-control"] {
            let button = gpui_kit::component::button::Button::new(selector).label(selector)
                .debug_selector(move || selector.into())
                .on_click(cx.listener(move |this, _, _, cx| {
                    this.activated.push(selector.into());
                    if selector == "copy-control" { cx.write_to_clipboard(gpui::ClipboardItem::new_string("Conteúdo completo".into())); }
                    cx.notify();
                }));
            body = body.child(tool_body_control(self.look, selector, button));
        }
        terminal_tool_body("call-1".into(), body,
            cx.listener(|this, key: &String, _, cx| { this.collapsed.push(key.clone()); cx.notify(); }))
    }
}

#[gpui::test]
fn terminal_body_controls_activate_without_collapsing(cx: &mut TestAppContext) {
    cx.update(gpui_kit::init);
    let (view, cx) = cx.add_window_view(|_, cx| ControlSurface {
        collapsed: Vec::new(), activated: Vec::new(), look: crate::appearance::ToolLook::Terminal,
        text: cx.new(|cx| TextViewState::markdown("[referência](https://example.org/prova)", cx)),
    });
    cx.run_until_parked();
    cx.update(|window, cx| { let _ = window.draw(cx); });
    for selector in ["copy-control", "open-control", "save-control", "image-control", "diff-control"] {
        let position = cx.debug_bounds(selector).unwrap().center();
        cx.simulate_click(position, Modifiers::default());
        settle_click(cx);
        assert!(view.read_with(cx, |view, _| view.collapsed.is_empty()), "o controle {selector} não recolhe");
        assert!(view.read_with(cx, |view, _| view.activated.iter().any(|id| id == selector)));
    }
    assert_eq!(cx.read_from_clipboard().unwrap().text().unwrap(), "Conteúdo completo");
}

#[gpui::test]
fn review_regression_plain_click_without_control_really_schedules_collapse(cx: &mut TestAppContext) {
    cx.update(gpui_kit::init);
    let (view, cx) = cx.add_window_view(|_, cx| ControlSurface {
        collapsed: Vec::new(), activated: Vec::new(), look: crate::appearance::ToolLook::Terminal,
        text: cx.new(|cx| TextViewState::markdown("Texto selecionável", cx)),
    });
    cx.run_until_parked();
    cx.update(|window, cx| { let _ = window.draw(cx); });
    cx.simulate_click(point(px(12.), px(12.)), Modifiers::default());
    settle_click(cx);
    assert_eq!(view.read_with(cx, |view, _| view.collapsed.clone()), ["call-1"]);
}

#[gpui::test]
fn review_regression_control_cancels_a_pending_body_collapse(cx: &mut TestAppContext) {
    cx.update(gpui_kit::init);
    let (view, cx) = cx.add_window_view(|_, cx| ControlSurface {
        collapsed: Vec::new(), activated: Vec::new(), look: crate::appearance::ToolLook::Terminal,
        text: cx.new(|cx| TextViewState::markdown("Texto selecionável", cx)),
    });
    cx.run_until_parked();
    cx.update(|window, cx| { let _ = window.draw(cx); });
    cx.simulate_click(point(px(12.), px(12.)), Modifiers::default());
    cx.run_until_parked();
    cx.executor().advance_clock(std::time::Duration::from_millis(100));
    cx.run_until_parked();
    let control = cx.debug_bounds("copy-control").unwrap().center();
    cx.simulate_click(control, Modifiers::default());
    settle_click(cx);
    assert_eq!(view.read_with(cx, |view, _| view.activated.clone()), ["copy-control"]);
    assert!(view.read_with(cx, |view, _| view.collapsed.is_empty()), "o controle precisa cancelar o clique anterior");
    assert_eq!(cx.read_from_clipboard().unwrap().text().unwrap(), "Conteúdo completo");
}

#[gpui::test]
fn terminal_body_markdown_link_opens_without_collapsing(cx: &mut TestAppContext) {
    cx.update(gpui_kit::init);
    let (view, cx) = cx.add_window_view(|_, cx| ControlSurface {
        collapsed: Vec::new(), activated: Vec::new(), look: crate::appearance::ToolLook::Terminal,
        text: cx.new(|cx| TextViewState::markdown("[referência](https://example.org/prova)", cx)),
    });
    cx.run_until_parked();
    cx.update(|window, cx| { let _ = window.draw(cx); });
    cx.simulate_click(point(px(12.), px(12.)), Modifiers { control: true, ..Default::default() });
    assert!(view.read_with(cx, |view, _| view.collapsed.is_empty()));
    assert_eq!(cx.opened_url().as_deref(), Some("https://example.org/prova"));
}

struct ToolSurface {
    text: Entity<TextViewState>,
    collapsed: Vec<String>,
    expanded: std::collections::HashSet<String>,
}

impl Render for ToolSurface {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        terminal_tool_body("call-1".into(),
            div().w(px(400.)).p(px(16.)).child(gpui_kit::base::TextSelectionLayer)
                .child(TextView::new(&self.text).selectable(true).scrollable(false)),
            cx.listener(|this, key: &String, _, cx| {
                this.collapsed.push(key.clone());
                super::super::toggle_detail(&mut this.expanded, &mut Default::default(), key);
                cx.notify();
            }))
            .debug_selector(|| "tool-body".into())
    }
}

fn settle_click(cx: &mut VisualTestContext) {
    cx.run_until_parked();
    cx.executor().advance_clock(std::time::Duration::from_millis(550));
    cx.run_until_parked();
}

fn surface(cx: &mut TestAppContext) -> (Entity<ToolSurface>, &mut VisualTestContext) {
    cx.update(gpui_kit::init);
    let (view, cx) = cx.add_window_view(|_, cx| ToolSurface {
        text: cx.new(|cx| TextViewState::markdown("Resultado selecionável de prova", cx)),
        collapsed: Vec::new(),
        expanded: ["call-1".into(), "row#fold-call-1".into()].into_iter().collect(),
    });
    cx.run_until_parked();
    cx.update(|window, cx| { let _ = window.draw(cx); });
    (view, cx)
}

#[gpui::test]
fn terminal_body_text_click_collapses(cx: &mut TestAppContext) {
    let (view, cx) = surface(cx);
    cx.simulate_click(point(px(24.), px(26.)), Modifiers::default());
    settle_click(cx);
    assert_eq!(view.read_with(cx, |view, _| view.collapsed.clone()), ["call-1"]);
}

#[gpui::test]
fn terminal_body_drag_keeps_selection_without_collapsing(cx: &mut TestAppContext) {
    let (view, cx) = surface(cx);
    let (start, end) = (point(px(18.), px(26.)), point(px(180.), px(26.)));
    cx.simulate_mouse_down(start, MouseButton::Left, Modifiers::default());
    cx.simulate_mouse_move(end, MouseButton::Left, Modifiers::default());
    cx.simulate_mouse_up(end, MouseButton::Left, Modifiers::default());
    assert!(view.read_with(cx, |view, _| view.collapsed.is_empty()));
    let selected = cx.update(|window, cx| gpui_kit::base::TextSelection::selected_text(window, cx));
    assert!(!selected.is_empty(), "o arrasto precisa selecionar texto real");
    cx.update(|window, cx| gpui_kit::base::TextSelection::clear_for_window(window.window_handle().window_id(), cx));
    cx.simulate_click(start, Modifiers::default());
    settle_click(cx);
    assert_eq!(view.read_with(cx, |view, _| view.collapsed.clone()), ["call-1"]);
}

#[gpui::test]
fn terminal_body_modified_clicks_do_not_collapse(cx: &mut TestAppContext) {
    let (view, cx) = surface(cx);
    for modifiers in [
        Modifiers { control: true, ..Default::default() },
        Modifiers { platform: true, ..Default::default() },
        Modifiers { alt: true, ..Default::default() },
        Modifiers { shift: true, ..Default::default() },
    ] {
        cx.simulate_click(point(px(4.), px(4.)), modifiers);
    }
    assert!(view.read_with(cx, |view, _| view.collapsed.is_empty()));
}

#[gpui::test]
fn terminal_body_multiple_clicks_select_without_collapsing(cx: &mut TestAppContext) {
    let (view, cx) = surface(cx);
    for click_count in [2, 3] {
        let position = point(px(24.), px(26.));
        cx.simulate_event(MouseDownEvent { position, button: MouseButton::Left, click_count, ..Default::default() });
        cx.simulate_event(MouseUpEvent { position, button: MouseButton::Left, click_count, ..Default::default() });
        assert!(view.read_with(cx, |view, _| view.collapsed.is_empty()));
        assert!(!cx.update(|window, cx| gpui_kit::base::TextSelection::selected_text(window, cx)).is_empty());
    }
}

#[gpui::test]
fn terminal_body_drag_returning_to_the_start_does_not_collapse(cx: &mut TestAppContext) {
    let (view, cx) = surface(cx);
    let start = point(px(4.), px(4.));
    cx.simulate_mouse_down(start, MouseButton::Left, Modifiers::default());
    cx.simulate_mouse_move(point(px(100.), px(4.)), MouseButton::Left, Modifiers::default());
    cx.simulate_mouse_move(start, MouseButton::Left, Modifiers::default());
    cx.simulate_mouse_up(start, MouseButton::Left, Modifiers::default());
    assert!(view.read_with(cx, |view, _| view.collapsed.is_empty()));
}

#[gpui::test]
fn terminal_body_drag_outside_and_back_does_not_collapse(cx: &mut TestAppContext) {
    let (view, cx) = surface(cx);
    let start = point(px(4.), px(4.));
    cx.simulate_mouse_down(start, MouseButton::Left, Modifiers::default());
    cx.simulate_mouse_move(point(px(4.), px(300.)), MouseButton::Left, Modifiers::default());
    cx.simulate_mouse_move(start, MouseButton::Left, Modifiers::default());
    cx.simulate_mouse_up(start, MouseButton::Left, Modifiers::default());
    settle_click(cx);
    assert!(view.read_with(cx, |view, _| view.collapsed.is_empty()));
}

#[gpui::test]
fn terminal_body_keyboard_copy_keeps_the_control_action(cx: &mut TestAppContext) {
    cx.update(gpui_kit::init);
    let (view, cx) = cx.add_window_view(|window, cx| {
        window.retain_a11y_tree(true);
        ControlSurface {
            collapsed: Vec::new(), activated: Vec::new(), look: crate::appearance::ToolLook::Terminal,
            text: cx.new(|cx| TextViewState::markdown("Texto de prova", cx)),
        }
    });
    cx.run_until_parked();
    cx.update(|window, cx| { let _ = window.draw(cx); window.a11y_click("copy-control", cx).unwrap(); });
    settle_click(cx);
    assert_eq!(view.read_with(cx, |view, _| view.activated.clone()), ["copy-control"]);
    assert!(view.read_with(cx, |view, _| view.collapsed.is_empty()));
    assert_eq!(cx.read_from_clipboard().unwrap().text().unwrap(), "Conteúdo completo");
}

#[gpui::test]
fn non_terminal_controls_keep_the_existing_event_propagation(cx: &mut TestAppContext) {
    cx.update(gpui_kit::init);
    let (view, cx) = cx.add_window_view(|_, cx| ControlSurface {
        collapsed: Vec::new(), activated: Vec::new(), look: crate::appearance::ToolLook::Classic,
        text: cx.new(|cx| TextViewState::markdown("Texto de prova", cx)),
    });
    for look in [crate::appearance::ToolLook::Classic, crate::appearance::ToolLook::Chips, crate::appearance::ToolLook::Tree] {
        view.update(cx, |view, cx| { view.look = look; view.collapsed.clear(); view.activated.clear(); cx.notify(); });
        cx.run_until_parked();
        cx.update(|window, cx| { let _ = window.draw(cx); });
        let position = cx.debug_bounds("copy-control").unwrap().center();
        cx.simulate_click(position, Modifiers::default());
        settle_click(cx);
        assert_eq!(view.read_with(cx, |view, _| view.activated.clone()), ["copy-control"]);
        assert_eq!(view.read_with(cx, |view, _| view.collapsed.clone()), ["call-1"]);
    }
}

#[gpui::test]
fn terminal_body_dragging_a_link_keeps_selection_and_does_not_open_it(cx: &mut TestAppContext) {
    cx.update(gpui_kit::init);
    let (view, cx) = cx.add_window_view(|_, cx| ControlSurface {
        collapsed: Vec::new(), activated: Vec::new(), look: crate::appearance::ToolLook::Terminal,
        text: cx.new(|cx| TextViewState::markdown("[referência](https://example.org/prova)", cx)),
    });
    cx.run_until_parked();
    cx.update(|window, cx| { let _ = window.draw(cx); });
    let (start, end) = (point(px(1.), px(12.)), point(px(80.), px(12.)));
    cx.simulate_mouse_down(start, MouseButton::Left, Modifiers::default());
    cx.simulate_mouse_move(end, MouseButton::Left, Modifiers::default());
    cx.simulate_mouse_up(end, MouseButton::Left, Modifiers::default());
    settle_click(cx);
    assert!(view.read_with(cx, |view, _| view.collapsed.is_empty()));
    assert!(cx.opened_url().is_none());
    assert!(!cx.update(|window, cx| gpui_kit::base::TextSelection::selected_text(window, cx)).is_empty());
}

#[gpui::test]
fn terminal_body_a_real_double_click_keeps_the_first_release_from_collapsing(cx: &mut TestAppContext) {
    let (view, cx) = surface(cx);
    let position = point(px(24.), px(26.));
    for click_count in [1, 2] {
        cx.simulate_event(MouseDownEvent { position, button: MouseButton::Left, click_count, ..Default::default() });
        cx.simulate_event(MouseUpEvent { position, button: MouseButton::Left, click_count, ..Default::default() });
    }
    cx.run_until_parked();
    cx.executor().advance_clock(std::time::Duration::from_secs(1));
    cx.run_until_parked();
    assert!(view.read_with(cx, |view, _| view.collapsed.is_empty()));
    assert!(!cx.update(|window, cx| gpui_kit::base::TextSelection::selected_text(window, cx)).is_empty());
}

#[gpui::test]
fn terminal_body_background_collapses_only_the_call(cx: &mut TestAppContext) {
    cx.update(gpui_kit::init);
    let (view, cx) = cx.add_window_view(|_, cx| ToolSurface {
        text: cx.new(|cx| TextViewState::markdown("Resultado selecionável", cx)),
        collapsed: Vec::new(),
        expanded: ["call-1".into(), "row#fold-call-1".into()].into_iter().collect(),
    });
    let cx: &mut VisualTestContext = cx;
    cx.run_until_parked();
    cx.update(|window, cx| { let _ = window.draw(cx); });
    let bounds = cx.debug_bounds("tool-body").unwrap();
    cx.simulate_click(bounds.origin + point(px(4.), px(4.)), Modifiers::default());
    settle_click(cx);
    assert_eq!(view.read_with(cx, |view, _| view.collapsed.clone()), ["call-1"]);
    assert!(view.read_with(cx, |view, _| view.expanded.contains("row#fold-call-1")));
    assert!(!view.read_with(cx, |view, _| view.expanded.contains("call-1")));
}

struct DotSurface { live: bool }

impl Render for DotSurface {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div().w(px(400.)).flex().flex_col()
            .child(div().flex().gap(px(8.)).child(fold_lead(self.live))
                .child(div().debug_selector(|| "term-fold-title".into()).child("Rodou 1 comando de shell")))
            .child(assistant_text_row(div().child("Texto do agente."), 27.))
    }
}

#[gpui::test]
fn fold_line_has_the_dot_only_while_a_call_runs(cx: &mut TestAppContext) {
    cx.update(gpui_kit::init);
    let (view, cx) = cx.add_window_view(|_, _| DotSurface { live: true });
    cx.run_until_parked();
    let _ = cx.update(|window, cx| window.draw(cx));
    assert!(cx.debug_bounds("term-fold-dot").is_some());
    let running = cx.debug_bounds("term-fold-title").unwrap().origin.x;
    view.update(cx, |view, cx| { view.live = false; cx.notify(); });
    cx.run_until_parked();
    let _ = cx.update(|window, cx| window.draw(cx));
    assert!(cx.debug_bounds("term-fold-dot").is_none());
    // Terminada, o espaço do ponto fica: o título não anda.
    assert_eq!(cx.debug_bounds("term-fold-title").unwrap().origin.x, running);
}

#[gpui::test]
fn agent_text_gets_the_white_dot_before_it(cx: &mut TestAppContext) {
    cx.update(gpui_kit::init);
    let (_, cx) = cx.add_window_view(|_, _| DotSurface { live: false });
    cx.run_until_parked();
    let _ = cx.update(|window, cx| window.draw(cx));
    let dot = cx.debug_bounds("term-text-dot").unwrap();
    assert_eq!(dot.origin.x, px(0.));
    // Centrado na primeira linha de 27 px.
    assert_eq!(dot.size.height, px(27.));
}
