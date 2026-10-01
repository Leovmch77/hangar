//! Consulta das execuções preservadas no servidor, independente das sessões vivas.
use super::*;
use super::device::Remote;
use serde::Deserialize;

#[derive(Clone, Deserialize)]
struct Run {
    id: String,
    #[serde(default)] plano: String,
    inicio: Option<String>,
    fim: Option<String>,
    resultado: Option<String>,
    metadata: Option<OrqRunMetadata>,
    #[serde(default)] tasks: Vec<Value>,
}

pub(super) struct History {
    id: u64,
    api: Api,
    server: String,
    runs: Remote<Vec<Run>>,
    selected: Option<String>,
    panel: Remote<Arc<OrqPanel>>,
    pub(super) view: super::orq_panel::View,
}

struct Body { hangar: WeakEntity<Hangar>, _observe: Subscription }

impl Render for Body {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.hangar.update(cx, |hangar, cx| hangar.render_orq_history(window, cx)).unwrap_or_else(|_| div())
    }
}

impl Hangar {
    pub(super) fn open_orq_history(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.orq_history.is_some() { return; }
        let Some(api) = self.session_api().or_else(|| self.api.clone()) else { return };
        self.orq_history_serial += 1;
        let id = self.orq_history_serial;
        self.orq_history = Some(History { id, api, server: self.open_server(), runs: Remote::default(), selected: None,
            panel: Remote::default(), view: Default::default() });
        self.load_orq_history(cx);
        let hangar = cx.entity();
        let body = cx.new(|cx| Body { _observe: cx.observe(&hangar, |_, _, cx| cx.notify()), hangar: hangar.downgrade() });
        let weak = hangar.downgrade();
        window.open_dialog(cx, move |dialog, window, _| {
            let close = weak.clone();
            popup::dialog(dialog).w((window.viewport_size().width - px(48.)).min(px(1100.)))
                .title(tr_shared("orq_history_title", &[])).child(body.clone())
                .on_close(move |_, _, cx| { let _ = close.update(cx, |this, _| {
                    if this.orq_history.as_ref().is_some_and(|h| h.id == id) { this.orq_history = None; }
                }); })
        });
        cx.notify();
    }

    fn history_read(&mut self, path: Vec<String>, cx: &mut Context<Self>,
        done: impl FnOnce(&mut Self, Result<Value, String>, &mut Context<Self>) + 'static) {
        let Some(history) = &self.orq_history else { return };
        let (api, id) = (history.api.clone(), history.id);
        let task = self.runtime.spawn(async move {
            let parts: Vec<&str> = path.iter().map(String::as_str).collect();
            api.server_read(&parts, &[], 30).await.map_err(|e| Hangar::fetch_failure(&e))
        });
        cx.spawn(async move |this, cx| {
            let result = task.await.map_err(|e| e.to_string()).and_then(|r| r);
            let _ = this.update(cx, |this, cx| {
                if this.orq_history.as_ref().is_some_and(|h| h.id == id) { done(this, result, cx); }
            });
        }).detach();
    }

    fn load_orq_history(&mut self, cx: &mut Context<Self>) {
        let Some(history) = &mut self.orq_history else { return };
        let seq = history.runs.start();
        self.history_read(vec!["orq".into()], cx, move |this, result, cx| {
            let parsed = result.and_then(|v| serde_json::from_value(v.get("execucoes").cloned().unwrap_or(Value::Null)).map_err(|e| e.to_string()));
            if let Some(history) = &mut this.orq_history { history.runs.finish(seq, parsed); }
            cx.notify();
        });
    }

    fn select_orq_history(&mut self, id: String, cx: &mut Context<Self>) {
        let Some(history) = &mut self.orq_history else { return };
        history.selected = Some(id.clone());
        history.panel.reset();
        history.view = Default::default();
        self.refresh_orq_history_panel(id, cx);
    }

    fn refresh_orq_history_panel(&mut self, id: String, cx: &mut Context<Self>) {
        let Some(history) = &mut self.orq_history else { return };
        let (seq, serial) = (history.panel.start(), history.id);
        self.history_read(vec!["orq".into(), id.clone(), "panel".into()], cx, move |this, result, cx| {
            let parsed = result.and_then(|v| serde_json::from_value::<OrqPanel>(v).map(Arc::new).map_err(|e| e.to_string()));
            let refresh = parsed.as_ref().is_ok_and(|p| p.timing.finished_at.is_none()
                || (p.consumption.is_none() && !p.errors.iter().any(|e| e.file == "consumption")));
            let Some(history) = &mut this.orq_history else { return };
            if history.selected.as_ref() != Some(&id) || !history.panel.finish(seq, parsed) { return; }
            cx.notify();
            if refresh {
                cx.spawn(async move |this, cx| {
                    cx.background_executor().timer(Duration::from_secs(5)).await;
                    let _ = this.update(cx, |this, cx| {
                        if this.orq_history.as_ref().is_some_and(|h| h.id == serial && h.selected.as_ref() == Some(&id) && h.panel.seq == seq) {
                            this.refresh_orq_history_panel(id, cx);
                        }
                    });
                }).detach();
            }
        });
    }

    fn render_orq_history(&self, window: &Window, cx: &mut Context<Self>) -> Div {
        let Some(history) = &self.orq_history else { return div() };
        let text = |value: String| div().text_sm().text_color(theme::muted()).whitespace_normal().child(value);
        let refresh = Button::new("orq-history-refresh").ghost().small().icon(IconName::RefreshCw)
            .label(tr_shared("orq_history_refresh", &[])).disabled(history.runs.loading || history.panel.loading)
            .on_click(cx.listener(|this, _, _, cx| {
                if let Some(id) = this.orq_history.as_ref().and_then(|h| h.selected.clone()) { this.refresh_orq_history_panel(id, cx); }
                else { this.load_orq_history(cx); }
                cx.notify();
            }));
        let mut body = div().flex().flex_col().gap_2().child(div().flex().items_center().justify_between()
            .child(text(history.server.clone())).child(refresh));
        if history.selected.is_some() {
            body = body.child(div().flex().child(Button::new("orq-history-back").ghost().small().label(tr_shared("orq_history_back", &[]))
                .on_click(cx.listener(|this, _, _, cx| {
                    if let Some(history) = &mut this.orq_history { history.selected = None; history.panel.reset(); }
                    cx.notify();
                }))));
            body = match &history.panel.value {
                Some(Ok(panel)) => body.child(text(tr_shared(if panel.timing.finished_at.is_some() { "orq_concluida" } else { "orq_em_curso" }, &[])))
                    .child(self.render_orq_content(panel, None, true, cx)),
                Some(Err(error)) => body.child(text(error.clone()).text_color(theme::warning())),
                None => body.child(text(tr_shared("orq_panel_loading", &[]))),
            };
        } else {
            body = match &history.runs.value {
                Some(Err(error)) => body.child(text(error.clone()).text_color(theme::warning())),
                None => body.child(text(tr_shared("orq_panel_loading", &[]))),
                Some(Ok(runs)) if runs.is_empty() => body.child(text(tr_shared("orq_vazio", &[]))),
                Some(Ok(runs)) => body.children(runs.iter().map(|run| {
                    let id = run.id.clone();
                    let name = run.metadata.as_ref().map(|m| m.title.as_str()).filter(|s| !s.is_empty())
                        .unwrap_or(if run.plano.is_empty() { &run.id } else { &run.plano });
                    let seconds = run.inicio.as_deref().zip(run.fim.as_deref()).and_then(|(a, b)| {
                        let elapsed = chrono::DateTime::parse_from_rfc3339(b).ok()?.signed_duration_since(chrono::DateTime::parse_from_rfc3339(a).ok()?).num_seconds();
                        u64::try_from(elapsed).ok()
                    });
                    let count = run.metadata.as_ref().and_then(|m| m.total_tasks).unwrap_or(run.tasks.len() as u32);
                    Button::new(SharedString::from(format!("orq-history-{}", run.id))).ghost().w_full().h_auto().py_3()
                        .child(div().w_full().flex().flex_col().items_start().gap_1()
                            .child(div().whitespace_normal().text_sm().font_weight(FontWeight::SEMIBOLD).child(name.to_owned()))
                            .child(text(run.metadata.as_ref().map(|m| m.repo.clone()).unwrap_or_default()))
                            .child(text(format!("{} · {} · {} · {}", super::orq_panel::since_text(run.inicio.as_deref()),
                                tr_shared("orq_history_tasks", &[("n", &count.to_string())]), super::orq_panel::elapsed_text(seconds),
                                tr_shared(if run.fim.is_none() { "orq_em_curso" } else if run.resultado.as_deref() == Some("abortada") { "orq_abortada" } else { "orq_concluida" }, &[])))))
                        .on_click(cx.listener(move |this, _, _, cx| { this.select_orq_history(id.clone(), cx); cx.notify(); }))
                })),
            };
        }
        div().child(div().id("orq-history-scroll").w_full().max_h((window.viewport_size().height - px(180.)).max(px(160.))).overflow_y_scroll().child(body))
    }
}
