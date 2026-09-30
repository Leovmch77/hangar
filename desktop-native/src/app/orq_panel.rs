//! Aba "Orquestração" do painel lateral de uma sessão `orq` (no lugar de "Contexto"): Tasks, Time, decisões abertas,
//! automação, consumo, integração e ações, lidos de `GET …/orq/panel` a cada 10 s. Regras de exibição espelham
//! `packages/core/src/orqTimeline.ts` e `OrqPanel.svelte`; os textos vêm das chaves `orq_*` que o web também usa.
use super::*;
use super::costs::tok;
use crate::appearance::SideTab;
use chrono::{DateTime, Datelike, Local};

const REFRESH_EVERY: u64 = 10;

/// O que a aba guarda entre desenhos: a última leitura, o erro do último pedido e o que o usuário abriu.
#[derive(Default)]
pub(super) struct State {
    data: Option<(SessionKey, Arc<OrqPanel>)>,
    error: Option<(SessionKey, String)>,
    task: Option<(SessionKey, JoinHandle<()>)>,
    generation: u64,
    queued_open: bool,
    ended_open: bool,
    advanced_open: bool,
}

impl State {
    pub(super) fn stop(&mut self) {
        if let Some((_, task)) = self.task.take() { task.abort(); }
        self.generation += 1;
    }

    pub(super) fn reset(&mut self) {
        self.stop();
        (self.data, self.error) = (None, None);
    }
}

#[derive(Debug, PartialEq)]
struct Status { key: String, round: Option<u32> }

struct TeamRow<'a> { member: &'a OrqTeamMember, status: Status }

/// Quem está vivo e o que faz agora; quem saiu da lista de sessões vai para as encerradas, menos o árbitro atual.
fn team_view<'a>(team: &'a [OrqTeamMember], live: &HashMap<String, String>) -> (Vec<TeamRow<'a>>, Vec<TeamRow<'a>>) {
    let (mut shown, mut ended) = (Vec::new(), Vec::new());
    for member in team {
        let state = live.get(&member.name);
        if state.is_none() && !(member.role == "arbiter" && member.current) {
            ended.push(TeamRow { member, status: Status { key: "orq_live_ended".into(), round: None } });
            continue;
        }
        let status = match (state.map(String::as_str), member.last.as_ref()) {
            (Some("working"), _) => Status { key: "orq_live_working".into(), round: None },
            (Some("awaiting_input"), _) => Status { key: "orq_live_waiting".into(), round: None },
            (_, Some(last)) => Status { key: format!("orq_last_{}", last.code), round: last.round },
            _ => Status { key: "orq_live_idle".into(), round: None },
        };
        shown.push(TeamRow { member, status });
    }
    (shown, ended)
}

struct TaskRows<'a> { visible: Vec<&'a OrqPanelTask>, queued: Vec<&'a OrqPanelTask> }

/// As Tasks na fila saem da lista e viram uma linha só, "{n} na fila".
fn task_rows(rows: &[OrqPanelTask]) -> TaskRows<'_> {
    let (queued, visible) = rows.iter().partition(|row| row.state == "queued");
    TaskRows { visible, queued }
}

fn state_key(state: &str) -> Option<&'static str> {
    Some(match state {
        "queued" => "orq_state_queued",
        "executing" => "orq_state_executing",
        "in_review" => "orq_state_in_review",
        "rejected" => "orq_state_rejected",
        "approved" => "orq_state_approved",
        "integrated" => "orq_state_integrated",
        "integration_red" => "orq_state_integration_red",
        _ => return None,
    })
}

/// Estado que este app não conhece aparece como veio, em vez de sumir.
fn task_state_text(task: &OrqPanelTask) -> String {
    let round = round_text(task.round);
    state_key(&task.state).map_or_else(|| task.state.clone(), |key| tr_shared(key, &[("round", &round)]))
}

/// Rodada que o backend não sabe aparece como traço, não como "R" sem número.
fn round_text(round: Option<u32>) -> String { round.map_or_else(|| "—".to_owned(), |round| round.to_string()) }

fn task_state_color(state: &str) -> Hsla {
    match state {
        "integrated" | "approved" => theme::success(),
        "executing" | "in_review" => theme::accent(),
        "rejected" | "integration_red" => theme::danger(),
        _ => theme::muted(),
    }
}

fn usage_header(sessions: &OrqConsumptionSessions) -> String {
    tr_shared("orq_use_sessions", &[("measured", &sessions.measured.to_string()), ("team", &sessions.team.to_string())])
}

fn mode_text(mode: &str) -> String {
    match mode {
        "on" | "shadow" | "off" => tr_shared(&format!("orq_mode_{mode}"), &[]),
        other => other.to_owned(),
    }
}

fn local_time(iso: Option<&str>) -> Option<DateTime<Local>> {
    DateTime::parse_from_rfc3339(iso?).ok().map(|at| at.with_timezone(&Local))
}

fn clock_of(iso: Option<&str>) -> Option<String> { local_time(iso).map(|at| at.format("%H:%M").to_string()) }

/// O início da execução na metodologia: a hora, e a data quando não é de hoje (a execução pode passar da meia-noite).
fn since_text(iso: Option<&str>) -> String {
    let Some(at) = local_time(iso) else { return "—".into() };
    let time = at.format("%H:%M").to_string();
    if at.date_naive() == Local::now().date_naive() { return time; }
    format!("{} {time}", tr("message_date").replace("{d}", &format!("{:02}", at.day())).replace("{m}", &format!("{:02}", at.month())))
}

fn section(title: String, right: Option<String>, body: impl IntoElement) -> Div {
    div().px_4().py(px(14.)).border_b_1().border_color(theme::border()).flex().flex_col().gap(px(10.))
        .child(div().flex().items_baseline().justify_between().gap_2()
            .child(chrome::section_label(title))
            .when_some(right, |el, text| el.child(div().min_w_0().truncate().text_xs().text_color(theme::faint()).child(text))))
        .child(body)
}

fn stat(value: String, label: String) -> Div {
    div().flex_1().min_w_0().flex().flex_col().gap(px(2.)).px_2().py_2().rounded(px(8.)).bg(theme::raised()).border_1().border_color(theme::border())
        .child(div().truncate().text_size(px(15.)).font_weight(FontWeight::SEMIBOLD).text_color(theme::text()).child(value))
        .child(div().text_size(px(11.)).text_color(theme::faint()).whitespace_normal().child(label))
}

fn note(text: String) -> Div { div().text_size(px(11.)).line_height(px(15.)).text_color(theme::faint()).whitespace_normal().child(text) }

fn dot(color: Hsla) -> Div { div().size(px(6.)).flex_shrink_0().rounded_full().bg(color) }

fn chip(text: String, color: Hsla) -> Div {
    div().flex_shrink_0().px(px(6.)).rounded(px(6.)).bg(color.opacity(0.18)).text_size(px(11.)).font_weight(FontWeight::SEMIBOLD).text_color(color).child(text)
}

impl Hangar {
    /// Só com o painel à vista, a aba Contexto escolhida e uma sessão `orq` aberta; troca de sessão cancela a leitura em curso.
    pub(super) fn sync_orq_panel(&mut self, visible: bool) {
        let tab_shown = !self.subagent_tab_open() && !self.side_menu_shown() && self.side_tab() == SideTab::Context;
        let want = self.selected_key().filter(|_| visible && tab_shown && self.selected.as_ref().is_some_and(SessionInfo::orq));
        if self.side.orq.task.as_ref().map(|(key, _)| key) == want.as_ref() { return; }
        self.side.orq.stop();
        let (Some(key), Some(api)) = (want, self.session_api()) else { return; };
        if self.side.orq.data.as_ref().is_some_and(|(owner, _)| owner != &key) {
            self.side.orq.data = None;
            self.side.orq.error = None;
            (self.side.orq.queued_open, self.side.orq.ended_open, self.side.orq.advanced_open) = (false, false, false);
        }
        let (connection, tx, generation, name) = (self.connection, self.tx.clone(), self.side.orq.generation, key.name.clone());
        let owner = key.clone();
        let task = self.runtime.spawn(async move {
            loop {
                let result = api.read(&name, &["orq", "panel"], &[], 15).await;
                if tx.send(Envelope { connection, selection: None, payload: Payload::Reply(owner.clone(), Reply::OrqPanel(generation), result) }).await.is_err() { return; }
                tokio::time::sleep(Duration::from_secs(REFRESH_EVERY)).await;
            }
        });
        self.side.orq.task = Some((key, task));
    }

    pub(super) fn receive_orq_panel(&mut self, generation: u64, key: SessionKey, result: Result<Value, Failure>) {
        if generation != self.side.orq.generation { return; }
        let parsed = result.map_err(|error| Self::failure(&error))
            .and_then(|value| serde_json::from_value::<OrqPanel>(value).map_err(|error| error.to_string()));
        let orq = &mut self.side.orq;
        match parsed {
            Ok(panel) => { orq.data = Some((key, Arc::new(panel))); orq.error = None; }
            Err(error) => orq.error = Some((key, error)),
        }
    }

    /// Corpo da aba: carregando, vazio, erro do pedido ou os blocos; as ações da sessão vão sempre por último.
    pub(super) fn render_orq_panel(&mut self, width: f32, readable: bool, cx: &mut Context<Self>) -> AnyElement {
        let Some(key) = self.selected_key() else { return div().into_any_element() };
        let panel = self.side.orq.data.as_ref().filter(|(owner, _)| owner == &key).map(|(_, panel)| Arc::clone(panel));
        let error = self.side.orq.error.as_ref().filter(|(owner, _)| owner == &key).map(|(_, error)| error.clone());
        let orq_target = super::sidebar::Target::new(&self.open_server(), &key.name);
        let live: HashMap<String, String> = self.sessions_of(&key.server).iter().map(|s| (s.name.clone(), s.state.clone())).collect();
        let message = |text: String, color: Hsla| div().px_4().py(px(14.)).border_b_1().border_color(theme::border()).text_xs().text_color(color).whitespace_normal().child(text);

        let mut content = div().flex().flex_col();
        match (panel.as_deref(), &error) {
            (None, None) => content = content.child(message(tr_shared("orq_panel_loading", &[]), theme::muted())),
            (None, Some(error)) => content = content.child(div().px_4().py(px(14.)).border_b_1().border_color(theme::border()).flex().flex_col().items_start().gap_2()
                .child(div().text_xs().text_color(theme::warning()).whitespace_normal().child(tr_shared("orq_panel_fetch_error", &[("error", error)])))
                .child(Button::new("orq-panel-retry").xsmall().outline().label(tr_shared("orq_panel_retry", &[]))
                    .on_click(cx.listener(|this, _, _, cx| { this.side.orq.reset(); cx.notify(); })))),
            (Some(panel), error) => {
                // A leitura anterior segue à vista quando um pedido falha; o erro vem em linha, nunca some.
                if let Some(error) = error { content = content.child(message(tr_shared("orq_panel_fetch_error", &[("error", error)]), theme::warning())); }
                for file in &panel.errors {
                    content = content.child(message(tr_shared("orq_panel_file_error", &[("file", &file.file), ("error", &file.error)]), theme::warning()));
                }
                if panel.empty {
                    content = content.child(message(tr_shared("orq_panel_empty", &[]), theme::muted()));
                } else {
                    content = content.child(self.orq_tasks(panel, cx))
                        .child(self.orq_team(panel, &live, &orq_target, cx))
                        .child(self.orq_decisions(panel, &orq_target, cx))
                        .child(self.orq_automation(panel, cx))
                        .child(self.orq_consumption(panel))
                        .child(self.orq_integration(panel));
                }
            }
        }
        content.children(self.render_shortcuts(readable, width, cx).map(|actions| div().px_4().py(px(14.)).child(actions))).into_any_element()
    }

    fn orq_tasks(&self, panel: &OrqPanel, cx: &mut Context<Self>) -> Div {
        let tasks = &panel.tasks;
        let title = if tasks.total_known {
            tr_shared("orq_tasks_count", &[("n", &tasks.integrated.to_string()), ("total", &tasks.total.to_string())])
        } else {
            tr_shared("orq_tasks_count_unknown", &[("n", &tasks.integrated.to_string())])
        };
        let fraction = if tasks.total_known && tasks.total > 0 { (tasks.integrated as f32 / tasks.total as f32).clamp(0., 1.) } else { 0. };
        let bar = div().h(px(4.)).w_full().rounded_full().bg(theme::raised())
            .child(div().h_full().rounded_full().bg(theme::success()).w(relative(fraction)));
        let rows = task_rows(&tasks.rows);
        let row = |task: &OrqPanelTask| {
            let color = task_state_color(&task.state);
            div().w_full().flex().items_center().gap_2().py(px(4.)).text_sm()
                .child(div().flex_shrink_0().w(px(26.)).text_xs().font_family(crate::theme::MONO).text_color(theme::faint()).child(format!("T{}", task.n)))
                .child(div().flex_1().min_w_0().truncate().text_color(theme::text()).child(task.title.clone()))
                .child(chip(task_state_text(task), color))
        };
        let queued_open = self.side.orq.queued_open;
        let queue = (!rows.queued.is_empty()).then(|| {
            let label = tr_shared("orq_tasks_queued", &[("n", &rows.queued.len().to_string())]);
            div().flex().flex_col()
                .child(div().flex().child(Button::new("orq-queued").ghost().xsmall().label(label)
                    .on_click(cx.listener(|this, _, _, cx| { this.side.orq.queued_open = !this.side.orq.queued_open; cx.notify(); }))))
                .when(queued_open, |el| el.children(rows.queued.iter().map(|task| row(task))))
        });
        section(tr_shared("orq_tasks_title", &[]), Some(title), div().flex().flex_col().gap(px(8.))
            .child(bar)
            .child(div().flex().flex_col().children(rows.visible.iter().map(|task| row(task))))
            .children(queue))
    }

    fn orq_team(&self, panel: &OrqPanel, live: &HashMap<String, String>, orq_target: &super::sidebar::Target, cx: &mut Context<Self>) -> Div {
        let (shown, ended) = team_view(&panel.team, live);
        let server = orq_target.server.clone();
        let card = |row: &TeamRow, clickable: bool, cx: &mut Context<Self>| {
            let member = row.member;
            let round = round_text(row.status.round);
            let status = tr_shared(&row.status.key, &[("round", &round)]);
            let role = tr_shared(&format!("orq_role_{}", member.role), &[("task", &member.task.map(|task| task.to_string()).unwrap_or_default())]);
            let color = match row.status.key.as_str() {
                "orq_live_working" => theme::accent(),
                "orq_live_waiting" => theme::warning(),
                _ => theme::faint(),
            };
            let (name, arbiter, orq, server) = (member.name.clone(), member.role == "arbiter" && member.current, orq_target.clone(), server.clone());
            div().id(SharedString::from(format!("orq-team-{}", member.name))).flex_1().min_w_0().flex().flex_col().gap(px(2.)).px_2().py_2()
                .rounded(px(8.)).bg(theme::raised()).border_1().border_color(theme::border())
                .child(div().min_w_0().flex().items_center().gap(px(6.)).child(dot(color))
                    .child(div().min_w_0().truncate().text_sm().font_weight(FontWeight::SEMIBOLD).text_color(theme::text()).child(member.name.clone())))
                .child(div().truncate().text_size(px(11.)).text_color(theme::faint()).child(format!("{role} · {status}")))
                .when(clickable, |el| el.cursor_pointer().hover(|el| el.bg(theme::hover()))
                    .on_click(cx.listener(move |this, _, window, cx| {
                        if arbiter { this.open_arbiter(&orq, window, cx); }
                        else { this.open_target(&super::sidebar::Target::new(&server, &name), window, cx); }
                    })))
        };
        let pair = |cards: Vec<Stateful<Div>>| {
            let mut lines = Vec::new();
            let mut iter = cards.into_iter();
            while let Some(first) = iter.next() {
                let second = iter.next();
                lines.push(div().flex().gap(px(6.)).child(first).child(second.map_or_else(|| div().flex_1().into_any_element(), IntoElement::into_any_element)));
            }
            div().flex().flex_col().gap(px(6.)).children(lines)
        };
        let live_cards: Vec<_> = shown.iter().map(|row| card(row, true, cx)).collect();
        let ended_open = self.side.orq.ended_open;
        let ended_block = (!ended.is_empty()).then(|| {
            let label = if ended_open { tr_shared("orq_team_hide_ended", &[]) } else { tr_shared("orq_team_show_ended", &[("n", &ended.len().to_string())]) };
            let cards: Vec<_> = if ended_open { ended.iter().map(|row| card(row, false, cx)).collect() } else { Vec::new() };
            div().flex().flex_col().gap(px(6.))
                .child(div().flex().child(Button::new("orq-ended").ghost().xsmall().label(label)
                    .on_click(cx.listener(|this, _, _, cx| { this.side.orq.ended_open = !this.side.orq.ended_open; cx.notify(); }))))
                .when(!cards.is_empty(), |el| el.child(pair(cards)))
        });
        section(tr_shared("orq_team_title", &[]), None, div().flex().flex_col().gap(px(8.)).child(pair(live_cards)).children(ended_block))
    }

    fn orq_decisions(&self, panel: &OrqPanel, orq_target: &super::sidebar::Target, cx: &mut Context<Self>) -> Div {
        let has_arbiter = self.arbiter_of(orq_target).is_some();
        let body = if panel.decisions.is_empty() {
            div().text_xs().text_color(theme::faint()).child(tr_shared("orq_decisions_none", &[]))
        } else {
            div().flex().flex_col().gap_2().children(panel.decisions.iter().enumerate().map(|(index, decision)| {
                let time = clock_of(decision.ts.as_deref()).unwrap_or_else(|| "—".into());
                let parecer = decision.parecer.clone().filter(|path| !path.is_empty());
                let orq = orq_target.clone();
                div().flex().flex_col().gap(px(6.)).px_3().py_2().rounded(px(10.)).border_1().border_color(theme::warning().opacity(0.34)).bg(theme::warning().opacity(0.08))
                    .child(div().flex().items_center().gap_2().text_xs().text_color(theme::muted())
                        .children(decision.task.map(|task| chip(format!("T{task}"), theme::warning())))
                        .child(tr_shared("orq_decision_unanswered", &[("time", &time)])))
                    .child(div().text_sm().text_color(theme::text()).whitespace_normal().child(decision.question.clone()))
                    .child(div().flex().flex_wrap().gap_1()
                        .children(parecer.map(|path| Button::new(SharedString::from(format!("orq-parecer-{index}"))).ghost().xsmall()
                            .label(tr_shared("orq_open_parecer", &[]))
                            .on_click(cx.listener(move |this, _, window, cx| this.open_file(path.clone(), None, window, cx)))))
                        .child(Button::new(SharedString::from(format!("orq-arbiter-{index}"))).ghost().xsmall().label(tr_shared("orq_talk_to_arbiter", &[]))
                            .disabled(!has_arbiter)
                            .on_click(cx.listener(move |this, _, window, cx| this.open_arbiter(&orq, window, cx)))))
            }))
        };
        section(tr_shared("orq_decisions_title", &[]), (!panel.decisions.is_empty()).then(|| panel.decisions.len().to_string()), body)
    }

    fn orq_automation(&self, panel: &OrqPanel, cx: &mut Context<Self>) -> Div {
        let auto = &panel.automation;
        let mode = tr_shared("orq_auto_mode", &[("jev", &mode_text(auto.mode.jev.as_deref().unwrap_or("—"))), ("regex", &mode_text(auto.mode.regex.as_deref().unwrap_or("—")))]);
        let woke = tr_shared("orq_auto_woke_detail", &[("decisions", &auto.woke.decisions.to_string()), ("alarms", &auto.woke.alarms.to_string()), ("messages", &auto.woke.messages.to_string())]);
        let alone = tr_shared("orq_auto_alone_detail", &[("opened", &auto.alone.opened.to_string()), ("integrated", &auto.alone.integrated.to_string()), ("dropped", &auto.alone.dropped.to_string())]);
        let advanced = &auto.advanced;
        let open = self.side.orq.advanced_open;
        let line = |label: String, value: String, hint: Option<String>| div().flex().flex_col().gap(px(2.))
            .child(div().flex().items_baseline().justify_between().gap_2().text_sm()
                .child(div().min_w_0().text_color(theme::text()).child(label))
                .child(div().flex_shrink_0().font_weight(FontWeight::SEMIBOLD).text_color(theme::text()).child(value)))
            .children(hint.map(note));
        let min_confidence = advanced.min_confidence.as_ref().and_then(|min| min.p).map_or_else(|| "—".to_owned(), super::orq_timeline::pct);
        let details = div().flex().flex_col().gap_2().px_2().py_2().rounded(px(8.)).border_1().border_color(theme::border())
            .child(div().id("orq-advanced").cursor_pointer().text_sm().text_color(theme::muted())
                .child(format!("{} {}", if open { "▾" } else { "▸" }, tr_shared("orq_adv_title", &[])))
                .on_click(cx.listener(|this, _, _, cx| { this.side.orq.advanced_open = !this.side.orq.advanced_open; cx.notify(); })))
            .when(open, |el| el
                .child(line(tr_shared("orq_adv_false_positive", &[]), advanced.would_drop.to_string(), Some(tr_shared("orq_adv_false_positive_hint", &[]))))
                .child(line(tr_shared("orq_adv_disagree", &[]),
                    tr_shared("orq_adv_disagree_value", &[("n", &advanced.disagree.to_string()), ("m", &advanced.judged.to_string())]),
                    Some(tr_shared("orq_adv_disagree_hint", &[]))))
                .child(line(tr_shared("orq_adv_min_conf", &[]), min_confidence, Some(tr_shared("orq_adv_min_conf_hint", &[]))))
                .child(line(tr_shared("orq_adv_by_rule", &[]), advanced.by_rule.to_string(), Some(tr_shared("orq_adv_by_rule_hint", &[])))));
        section(tr_shared("orq_auto_title", &[]), Some(mode), div().flex().flex_col().gap_2()
            .child(div().flex().gap(px(6.))
                .child(stat(auto.woke.total.to_string(), tr_shared("orq_auto_woke", &[])))
                .child(stat(auto.alone.total.to_string(), tr_shared("orq_auto_alone", &[])))
                .child(stat(auto.dropped_by_jev.to_string(), tr_shared("orq_auto_dropped", &[]))))
            .child(note(format!("{woke} · {alone}")))
            .child(details))
    }

    fn orq_consumption(&self, panel: &OrqPanel) -> Div {
        let title = tr_shared("orq_use_title", &[]);
        let Some(usage) = panel.consumption.as_ref() else {
            // Consumo que falhou já tem a própria linha de erro no topo: não fica em "calculando".
            let failed = panel.errors.iter().any(|error| error.file == "consumption");
            return section(title, None, div().text_xs().text_color(theme::muted()).when(!failed, |el| el.child(tr_shared("orq_use_computing", &[]))));
        };
        let usd = |value: Option<f64>| value.map_or_else(|| "—".to_owned(), |usd| self.money(usd));
        // A coluna já diz a moeda no cabeçalho: na linha vai só o número.
        let symbol = self.money(0.).split(' ').next().unwrap_or_default().to_owned();
        let usd_number = |value: Option<f64>| usd(value).split_once(' ').map_or_else(|| "—".to_owned(), |(_, number)| number.to_owned());
        let total_cost = format!("{}{}", usd(usage.totals.usd), if usage.totals.usd_partial { "*" } else { "" });
        let cell = |text: String, bold: bool, muted: bool| div().flex_shrink_0().w(px(64.)).text_right().text_size(px(12.)).font_family(crate::theme::MONO)
            .text_color(if muted { theme::muted() } else { theme::text() }).when(bold, |el| el.font_weight(FontWeight::SEMIBOLD)).child(text);
        let row = |name: String, new: String, cache: String, cost: String, provider: bool| div().w_full().flex().items_center().gap_1().py(px(4.))
            .border_t_1().border_color(theme::border())
            .child(div().flex_1().min_w_0().truncate().text_size(px(12.)).when(provider, |el| el.font_weight(FontWeight::SEMIBOLD).text_color(theme::text()))
                .when(!provider, |el| el.pl_2().text_color(theme::muted())).child(name))
            .child(cell(new, provider, !provider)).child(cell(cache, provider, !provider)).child(cell(cost, provider, !provider));
        let head = div().w_full().flex().gap_1().text_size(px(11.)).text_color(theme::faint())
            .child(div().flex_1())
            .children([tr_shared("orq_use_col_new", &[]), tr_shared("orq_use_col_cache", &[]), format!("{} {symbol}", tr_shared("orq_use_col_cost", &[]))]
                .map(|label| div().flex_shrink_0().w(px(64.)).text_right().child(label)));
        let mut table = div().flex().flex_col().child(head);
        for provider in &usage.providers {
            table = table.child(row(super::side::agent_label(&provider.provider), tok(provider.new as f64), tok(provider.cache_read as f64), usd_number(provider.usd), true));
            for model in &provider.models {
                let name = tr_shared("orq_use_model_sessions", &[("model", &model.model), ("n", &model.sessions.to_string())]);
                table = table.child(row(name, tok(model.new as f64), tok(model.cache_read as f64), usd_number(model.usd), false));
            }
        }
        let method = tr_shared("orq_use_method", &[("since", &since_text(usage.since.as_deref()))]);
        section(title, Some(usage_header(&usage.sessions)), div().flex().flex_col().gap_2()
            .child(div().flex().gap(px(6.))
                .child(stat(tok(usage.totals.new as f64), tr_shared("orq_use_new", &[])))
                .child(stat(tok(usage.totals.cache_read as f64), tr_shared("orq_use_cache", &[])))
                .child(stat(total_cost, tr_shared("orq_use_cost", &[]))))
            .child(table)
            .child(note(method))
            .when(!usage.sessions.missing.is_empty(), |el| el.child(note(tr_shared("orq_use_missing", &[("names", &usage.sessions.missing.join(", "))]))))
            .when(!usage.missing_prices.is_empty(), |el| el.child(note(tr_shared("orq_use_no_price", &[("models", &usage.missing_prices.join(", "))])))))
    }

    fn orq_integration(&self, panel: &OrqPanel) -> Div {
        let integration = &panel.integration;
        let label = |text: String| div().flex_shrink_0().text_sm().text_color(theme::muted()).child(text);
        let mono = |text: String| div().min_w_0().truncate().px(px(6.)).rounded(px(4.)).bg(theme::raised()).text_xs().font_family(crate::theme::MONO).text_color(theme::text()).child(text);
        let last = match integration.last.as_ref() {
            Some(last) => {
                let parts: Vec<String> = [last.task.map(|task| format!("T{task}")), last.commit.clone(), clock_of(last.ts.as_deref())].into_iter().flatten().collect();
                parts.join(" · ")
            }
            None => tr_shared("orq_int_none", &[]),
        };
        let outcome = integration.outcome.as_deref().and_then(|outcome| match outcome {
            "green" => Some(("orq_int_green", theme::success())),
            "red" => Some(("orq_int_red", theme::danger())),
            "conflict" => Some(("orq_int_conflict", theme::danger())),
            "failed" => Some(("orq_int_failed", theme::danger())),
            _ => None,
        });
        let checks = &integration.delivery_checks;
        let checks_line = (checks.total > 0).then(|| {
            let params = [("ok", checks.ok.to_string()), ("total", checks.total.to_string()), ("tasks", checks.failing.iter().map(|task| format!("T{task}")).collect::<Vec<_>>().join(", "))];
            let params: Vec<(&str, &str)> = params.iter().map(|(key, value)| (*key, value.as_str())).collect();
            if checks.ok >= checks.total { (tr_shared("orq_int_checks_green", &params), theme::success()) } else { (tr_shared("orq_int_checks_red", &params), theme::danger()) }
        });
        let status = |text: String, color: Hsla| div().flex().items_center().gap_2().text_sm().text_color(theme::text()).child(dot(color)).child(div().min_w_0().whitespace_normal().child(text));
        section(tr_shared("orq_int_title", &[]), None, div().flex().flex_col().gap(px(6.))
            .child(div().flex().items_center().gap_2().child(label(tr_shared("orq_int_branch", &[]))).child(match integration.branch.clone() {
                Some(branch) => mono(branch).into_any_element(),
                None => div().text_sm().text_color(theme::muted()).child("—").into_any_element(),
            }))
            .child(div().flex().items_center().gap_2().child(label(tr_shared("orq_int_last", &[]))).child(div().min_w_0().truncate().text_sm().text_color(theme::text()).child(last)))
            .children(outcome.map(|(key, color)| status(tr_shared(key, &[]), color)))
            .children(checks_line.map(|(text, color)| status(text, color))))
    }
}

#[cfg(test)]
mod tests {
    use super::{Status, state_key, task_rows, task_state_text, team_view, usage_header};
    use crate::{api::dto::*, i18n::tr_shared};
    use std::collections::HashMap;

    fn member(name: &str, role: &str, current: bool, last: Option<(&str, Option<u32>)>) -> OrqTeamMember {
        OrqTeamMember { name: name.into(), role: role.into(), task: (role != "arbiter").then_some(2), current,
            last: last.map(|(code, round)| OrqLast { code: code.into(), round, ts: None }) }
    }
    fn task(n: u32, state: &str) -> OrqPanelTask { OrqPanelTask { n, title: format!("T{n}"), state: state.into(), round: None } }
    fn live(entries: &[(&str, &str)]) -> HashMap<String, String> { entries.iter().map(|(k, v)| ((*k).into(), (*v).into())).collect() }

    #[test]
    fn team_view_matches_the_core() {
        let team = [
            member("arb", "arbiter", true, None),
            member("rev", "reviewer", false, None),
            member("exec", "executor", false, Some(("delivered", Some(2)))),
            member("gone", "executor", false, Some(("started", None))),
        ];
        let (shown, ended) = team_view(&team, &live(&[("arb", "awaiting_input"), ("rev", "working"), ("exec", "idle")]));
        let status = |name: &str| shown.iter().find(|row| row.member.name == name).map(|row| &row.status);
        assert_eq!(status("arb"), Some(&Status { key: "orq_live_waiting".into(), round: None }));
        assert_eq!(status("rev"), Some(&Status { key: "orq_live_working".into(), round: None }));
        assert_eq!(status("exec"), Some(&Status { key: "orq_last_delivered".into(), round: Some(2) }));
        assert_eq!(ended.iter().map(|row| (row.member.name.as_str(), row.status.key.as_str())).collect::<Vec<_>>(), [("gone", "orq_live_ended")]);
        // O árbitro atual fica à vista mesmo fora da lista de sessões.
        let (shown, ended) = team_view(&team[..1], &live(&[]));
        assert_eq!((shown.len(), ended.len(), shown[0].status.key.as_str()), (1, 0, "orq_live_idle"));
    }

    #[test]
    fn task_rows_collapse_the_queue() {
        let rows = [task(1, "integrated"), task(5, "in_review"), task(6, "queued"), task(7, "queued")];
        let split = task_rows(&rows);
        assert_eq!(split.visible.iter().map(|t| t.n).collect::<Vec<_>>(), [1, 5]);
        assert_eq!(split.queued.iter().map(|t| t.n).collect::<Vec<_>>(), [6, 7]);
        assert_eq!(split.queued.len(), 2);
    }

    #[test]
    fn task_state_label_keys() {
        for (state, key) in [("queued", "orq_state_queued"), ("executing", "orq_state_executing"), ("in_review", "orq_state_in_review"),
            ("rejected", "orq_state_rejected"), ("approved", "orq_state_approved"), ("integrated", "orq_state_integrated"),
            ("integration_red", "orq_state_integration_red")] {
            assert_eq!(state_key(state), Some(key));
        }
        assert_eq!(state_key("novo"), None);
        let reviewing = OrqPanelTask { round: Some(2), ..task(4, "in_review") };
        assert_eq!(task_state_text(&reviewing), tr_shared("orq_state_in_review", &[("round", "2")]));
        assert!(task_state_text(&reviewing).contains("R2"));
        assert_eq!(task_state_text(&task(9, "novo")), "novo");
        // Rodada desconhecida vira traço, nunca "R" solto.
        assert!(task_state_text(&task(4, "in_review")).ends_with("R—"));
    }

    #[test]
    fn usage_header_shows_the_pair() {
        let sessions = OrqConsumptionSessions { team: 11, measured: 7, missing: Vec::new() };
        assert_eq!(usage_header(&sessions), tr_shared("orq_use_sessions", &[("measured", "7"), ("team", "11")]));
        assert!(usage_header(&sessions).contains("7") && usage_header(&sessions).contains("11"));
    }
}
