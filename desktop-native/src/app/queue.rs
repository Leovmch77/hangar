//! Painel "Na fila" acima do composer, como o `QueuedRunsControl` do T3: o que espera a vez no Hangar, com arrastar,
//! setas, editar no composer, orientar e apagar por mensagem.
use super::*;
use crate::queue_panel::{self as model, QueueEdit, QueuePanel};

/// Cerca de quatro linhas à vista; o resto rola dentro do painel.
const LIST_MAX: f32 = 4. * 28.;

/// O que se arrasta pela alça.
#[derive(Clone)]
pub(super) struct QueueDrag { id: String, text: String }

/// O que acompanha o ponteiro durante o arrasto: o texto da mensagem numa linha.
pub(super) struct QueueDragChip { text: String }

impl Render for QueueDragChip {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div().max_w(px(320.)).px(px(10.)).py(px(4.)).rounded(px(8.)).bg(theme::raised()).border_1().border_color(theme::border_strong())
            .shadow(theme::popover_shadow()).text_size(px(12.5)).text_color(theme::text()).truncate()
            .child(conversation::one_line(&self.text, 80))
    }
}

/// Estado do painel na tela: a edição em curso (de qual conversa), recolhido e onde o arrasto soltaria.
#[derive(Default)]
pub(super) struct QueueUi {
    edit: Option<(SessionKey, QueueEdit)>,
    collapsed: bool,
    /// Linha sob o ponteiro no arrasto e se ele está na metade de baixo dela.
    drop: Option<(String, bool)>,
    /// Entrada que saiu pela alça; só vale enquanto há arrasto ativo.
    dragged: Option<String>,
}

impl QueueUi {
    /// Outra conversa abre com o painel aberto.
    pub(super) fn on_select(&mut self) { self.collapsed = false; self.drop = None; self.dragged = None; }
}

impl Hangar {
    fn queue_busy(&self) -> bool { self.selected_key().is_some_and(|key| self.flight.busy(&key)) }

    pub(super) fn queue_edit_active(&self) -> bool {
        self.queue.edit.as_ref().is_some_and(|(key, _)| Some(key) == self.selected_key().as_ref())
    }

    fn editing_entry(&self) -> Option<&str> {
        self.queue.edit.as_ref().filter(|_| self.queue_edit_active()).map(|(_, edit)| edit.entry_id.as_str())
    }

    /// Rascunho da conversa que sai da tela: em edição de mensagem da fila, o de antes dela (a edição acaba aqui).
    pub(super) fn composer_draft(&mut self, cx: &App) -> String {
        match self.queue.edit.take() {
            Some((_, edit)) => edit.saved_draft,
            None => self.composer.read(cx).value().to_string(),
        }
    }

    fn begin_queue_edit(&mut self, id: &str, window: &mut Window, cx: &mut Context<Self>) {
        let panel = self.chat.queue_panel();
        let (Some(entry), Some(key)) = (panel.entries.iter().find(|e| e.id == id), self.selected_key()) else { return };
        let draft = self.composer.read(cx).value().to_string();
        let current = self.queue.edit.as_ref().filter(|(k, _)| *k == key).map(|(_, e)| e.clone());
        let edit = model::begin_edit(entry, &draft, current.as_ref());
        let text = entry.text.clone();
        self.queue.edit = Some((key, edit));
        self.queue.collapsed = false;
        self.set_composer_at_end(text, window, cx);
        cx.notify();
    }

    /// Troca o texto do campo com o cursor no fim, pronto para continuar.
    fn set_composer_at_end(&mut self, text: String, window: &mut Window, cx: &mut Context<Self>) {
        let last = text.split('\n').count().saturating_sub(1) as u32;
        self.composer.update(cx, |input, cx| {
            input.set_value(text, window, cx);
            input.set_cursor_position(gpui_kit::component::input::Position::new(last, u32::MAX), window, cx);
        });
    }

    /// Sai da edição (Cancelar, Esc ou atualização feita): o rascunho de antes volta ao composer.
    pub(super) fn finish_queue_edit(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some((_, edit)) = self.queue.edit.take() else { return };
        self.set_composer_at_end(edit.saved_draft, window, cx);
        cx.notify();
    }

    /// "Atualizar" e o Enter em edição. Texto igual ao da fila só sai da edição, sem pedido.
    pub(super) fn submit_queue_edit(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some((_, edit)) = self.queue.edit.clone() else { return };
        let text = self.composer.read(cx).value().to_string();
        if !model::can_update(&text) { return; }
        if text == edit.original { self.finish_queue_edit(window, cx); return; }
        self.act(Action::QueueEdit(edit.entry_id.clone(), text), edit.entry_id, cx);
    }

    /// A atualização voltou: sai da edição se ela ainda é a da mesma mensagem.
    pub(super) fn queue_edit_done(&mut self, id: &str, window: &mut Window, cx: &mut Context<Self>) {
        if self.editing_entry() == Some(id) { self.finish_queue_edit(window, cx); }
    }

    /// A lista nova pode ter levado a mensagem em edição: ela vira rascunho (com o rascunho vazio) e avisa.
    pub(super) fn queue_panel_changed(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if !self.queue_edit_active() { return; }
        let Some((key, edit)) = self.queue.edit.clone() else { return };
        let composer = self.composer.read(cx).value().to_string();
        let Some(text) = model::edit_left(&edit, &self.chat.queue_panel(), &composer) else { return };
        self.queue.edit = None;
        self.set_composer_at_end(text, window, cx);
        self.action_feedback.insert(key, (tr_shared("queue_entry_gone", &[]), true));
        cx.notify();
    }

    fn reorder_queued(&mut self, id: &str, before: Option<String>, cx: &mut Context<Self>) {
        self.act(Action::QueueReorder(id.to_owned(), before), id.to_owned(), cx);
    }

    /// O Enviar do composer em edição: "Atualizar" com texto, na cor do Enviar.
    pub(super) fn queue_update_button(&self, enabled: bool, cx: &mut Context<Self>) -> Button {
        let (fill, ink) = match (enabled, theme::is_floating()) {
            (false, _) => (theme::raised(), theme::faint()),
            (true, true) => (theme::accent(), theme::on_accent()),
            (true, false) => (theme::text(), theme::background()),
        };
        Button::new("send").custom(ButtonCustomVariant::new(cx).color(fill).foreground(ink).hover(fill.opacity(0.88)).active(fill.opacity(0.8)))
            .bg(fill).h(px(30.)).px(px(14.)).rounded_full().text_size(px(13.)).label(tr_shared("queue_panel_update", &[]))
            .accessibility_label(tr_shared("queue_panel_update_aria", &[])).disabled(!enabled)
            .on_click(cx.listener(|this, _, window, cx| this.submit_queue_edit(window, cx)))
    }

    /// Linha acima do campo em edição.
    pub(super) fn queue_editing_note(&self) -> Option<Stateful<Div>> {
        self.queue_edit_active().then(|| div().id("queue-editing").text_xs().text_color(theme::accent())
            .child(tr_shared("queue_panel_editing", &[])))
    }

    /// O painel; sem mensagem esperando ele não existe.
    pub(super) fn render_queue_panel(&mut self, provider: &str, window: &mut Window, cx: &mut Context<Self>) -> Option<AnyElement> {
        let panel = self.chat.queue_panel();
        if panel.entries.is_empty() { return None; }
        let expanded = !self.queue.collapsed;
        let header_focus = window.use_keyed_state("queue-panel-header-focus", cx, |_, cx| cx.focus_handle().tab_stop(true)).read(cx).clone();
        let header = div().id("queue-panel-header").track_focus(&header_focus).flex().items_center().gap(px(8.)).px(px(12.)).py(px(6.))
            .rounded(px(12.)).cursor_pointer().hover(|el| el.bg(theme::hover()))
            .when(header_focus.is_focused(window), |el| el.focus_ring_style(window, cx))
            .role(Role::Button).aria_label(tr_shared(if expanded { "queue_panel_collapse" } else { "queue_panel_expand" }, &[]))
            .text_size(px(12.5)).text_color(theme::muted())
            .on_click(cx.listener(|this, _, _, cx| { this.queue.collapsed = !this.queue.collapsed; cx.notify(); }))
            .on_key_down(cx.listener(|this, event: &KeyDownEvent, _, cx| {
                if !matches!(event.keystroke.key.as_str(), "enter" | "space") { return; }
                this.queue.collapsed = !this.queue.collapsed;
                cx.stop_propagation();
                cx.notify();
            }))
            .child(chrome::small_icon(IconName::ListOrdered, 14., theme::faint()))
            .child(div().flex_1().min_w_0().child(tr("queued")))
            .child(div().font_family(theme::MONO).text_color(theme::faint()).child(panel.entries.len().to_string()))
            .child(chrome::small_icon(if expanded { IconName::ChevronDown } else { IconName::ChevronUp }, 14., theme::faint()));
        let list = expanded.then(|| {
            let rows: Vec<AnyElement> = (0..panel.entries.len()).map(|i| self.render_queue_row(&panel, i, provider, window, cx)).collect();
            div().id("queue-panel-list").max_h(px(LIST_MAX)).overflow_y_scroll().flex().flex_col().gap(px(1.)).px(px(6.)).pb(px(6.))
                .children(rows)
        });
        // Mesmo material do cartão do composer, colado acima dele.
        let body = div().id("queue-panel").flex().flex_col().rounded(px(12.)).border_1().border_color(theme::border_strong())
            .bg(theme::boxed()).child(header).children(list);
        Some(div().mb(px(6.)).child(chrome::glass_panel(body, px(12.))).into_any_element())
    }

    fn render_queue_row(&mut self, panel: &QueuePanel, i: usize, provider: &str, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let entry = &panel.entries[i];
        let (id, text) = (entry.id.clone(), entry.text.clone());
        let busy = self.queue_busy();
        let editing = self.editing_entry() == Some(id.as_str());
        let dragging = cx.has_active_drag();
        let drop_line = self.queue.drop.as_ref().filter(|(over, _)| dragging && *over == id).map(|(_, after)| *after);
        let mut row = div().id(SharedString::from(format!("queue-row-{i}"))).relative().flex().items_center().gap(px(4.))
            .min_h(px(26.)).px(px(4.)).rounded(px(8.)).when(editing, |el| el.bg(theme::accent_dim()));
        if let Some(after) = drop_line {
            let line = div().absolute().left_0().right_0().h(px(2.)).rounded_full().bg(theme::accent());
            row = row.child(if after { line.bottom_0() } else { line.top_0() });
        }
        if panel.actions {
            let focus = window.use_keyed_state(SharedString::from(format!("queue-grip-{id}-focus")), cx, |_, cx| cx.focus_handle().tab_stop(true))
                .read(cx).clone();
            let (keys_id, entries) = (id.clone(), panel.entries.clone());
            let grip = div().id(SharedString::from(format!("queue-grip-{i}"))).track_focus(&focus).flex_shrink_0().p(px(3.)).rounded(px(5.))
                .when(!busy, |el| el.cursor_grab().hover(|el| el.bg(theme::hover())))
                .when(focus.is_focused(window), |el| el.focus_ring_style(window, cx))
                .role(Role::Button).aria_label(tr_shared("queue_panel_reorder", &[]))
                .child(chrome::small_icon(IconName::GripVertical, 14., theme::faint()))
                .on_key_down(cx.listener(move |this, event: &KeyDownEvent, _, cx| {
                    let up = match event.keystroke.key.as_str() { "up" => true, "down" => false, _ => return };
                    cx.stop_propagation();
                    if this.queue_busy() { return; }
                    if let Some(before) = model::move_target(&entries, &keys_id, up) { this.reorder_queued(&keys_id, before, cx); }
                }));
            let grip = if busy { grip } else {
                let weak = cx.entity().downgrade();
                grip.on_drag(QueueDrag { id: id.clone(), text: text.clone() }, move |drag, _, _, cx| {
                    let _ = weak.update(cx, |this, cx| { (this.queue.drop, this.queue.dragged) = (None, Some(drag.id.clone())); cx.notify(); });
                    cx.new(|_| QueueDragChip { text: drag.text.clone() })
                })
            };
            let (over, entries) = (id.clone(), panel.entries.clone());
            let moved = id.clone();
            row = row.child(grip)
                .on_drag_move(cx.listener(move |this, event: &DragMoveEvent<QueueDrag>, _, cx| {
                    let inside = event.bounds.contains(&event.event.position);
                    let spot = inside.then(|| (moved.clone(), event.event.position.y > event.bounds.center().y));
                    let next = match spot {
                        Some(spot) => Some(spot),
                        None if this.queue.drop.as_ref().is_some_and(|(over, _)| *over == moved) => None,
                        None => return,
                    };
                    if this.queue.drop != next { this.queue.drop = next; cx.notify(); }
                }))
                .on_drop(cx.listener(move |this, drag: &QueueDrag, _, cx| {
                    let after = this.queue.drop.take().filter(|(spot, _)| *spot == over).is_some_and(|(_, after)| after);
                    this.queue.dragged = None;
                    cx.notify();
                    if this.queue_busy() { return; }
                    if let Some(before) = model::drop_target(&entries, &drag.id, &over, after) { this.reorder_queued(&drag.id, before, cx); }
                }))
                .when(dragging && self.queue.dragged.as_deref() == Some(id.as_str()), |el| el.opacity(0.5));
        }
        let full = text.clone();
        row = row.child(div().id(SharedString::from(format!("queue-text-{i}"))).flex_1().min_w_0().px(px(4.)).truncate()
            .text_size(px(12.5)).text_color(theme::text()).child(conversation::one_line(&text, 400))
            .tooltip(move |window, cx| gpui_kit::component::tooltip::Tooltip::new(full.clone()).build(window, cx)));
        if !panel.actions { return row.into_any_element(); }
        if editing {
            return row.child(Button::new("queue-cancel-edit").ghost().xsmall().label(tr("cancel"))
                .on_click(cx.listener(|this, _, window, cx| this.finish_queue_edit(window, cx)))).into_any_element();
        }
        let steerable = model::steerable(provider);
        let (edit, steer, remove) = (id.clone(), id.clone(), id);
        let steer_tip = if steerable { tr_shared("codex_orientar_ajuda", &[]) } else { tr_shared("queue_panel_steer_unavailable", &[]) };
        row.child(Button::new(SharedString::from(format!("queue-edit-{i}"))).ghost().xsmall().icon(IconName::Pencil)
                .tooltip(tr_shared("queue_panel_edit", &[])).accessibility_label(tr_shared("queue_panel_edit", &[])).disabled(busy)
                .on_click(cx.listener(move |this, _, window, cx| this.begin_queue_edit(&edit, window, cx))))
            .child(Button::new(SharedString::from(format!("queue-steer-{i}"))).ghost().xsmall().icon(IconName::CornerUpRight)
                .label(tr_shared("codex_orientar", &[])).tooltip(steer_tip).disabled(busy || !steerable)
                .on_click(cx.listener(move |this, _, _, cx| this.act(Action::QueueSteer(steer.clone()), steer.clone(), cx))))
            .child(Button::new(SharedString::from(format!("queue-remove-{i}"))).ghost().xsmall().icon(IconName::Close)
                .tooltip(tr_shared("queue_panel_remove", &[])).accessibility_label(tr_shared("queue_panel_remove", &[])).disabled(busy)
                .on_click(cx.listener(move |this, _, _, cx| this.act(Action::QueueCancel(remove.clone()), remove.clone(), cx))))
            .into_any_element()
    }
}
