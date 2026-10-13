//! Aba Atividade do painel da direita: o `ActivitySheet` docado do web no nível da lista (agentes rodando, subagentes do
//! disco, shells de fundo, processos vivos e tarefas) e o botão Atividade do cabeçalho. A lista de subagentes é lida por
//! esta view, em pedidos numerados, e a chegada redesenha só ela; a conta de subagentes no disco, que decide se a aba e o
//! botão existem, é do `Hangar`, como no `Chat.svelte`.
use super::*;
use super::subagent::SubConversation;
use crate::appearance::SideTab;
use crate::conversation::{Activity, AgentRun, TaskStatus};
use gpui_kit::component::tooltip::Tooltip;
use gpui_kit::component::tab::{Tab, TabBar};

/// Recontagem dos subagentes no disco enquanto a sessão trabalha.
const COUNT_EVERY: Duration = Duration::from_secs(5);
/// O "há N min" dos shells anda de 20 em 20 s, e só com a aba à vista.
const CLOCK_EVERY: Duration = Duration::from_secs(20);
/// Consulta do subagente aberto, como o `ActivitySheet`.
const DETAIL_EVERY: Duration = Duration::from_millis(2500);
/// Falhas seguidas que param a consulta; o 404 para na primeira.
const DETAIL_FAILS: u32 = 3;
const TAB_CROSS: IconName = IconName::Close;

pub(super) enum ActivityReply {
    /// Quantos subagentes a sessão tem no disco, amarrado à sessão e ao pedido.
    Count(SessionKey, u64, Result<Vec<SubRun>, Failure>),
    /// A lista da aba, com o número do pedido.
    List(u64, Result<Vec<SubRun>, Failure>),
    /// O subagente aberto (`…/subagents/{id}?events=200`), com o número do pedido.
    Detail(u64, Result<Value, Failure>),
    TabDetail(u64, u64, Result<Value, Failure>),
    /// Resposta do envio de mensagem ao subagente: a aba (nenhuma = o detalhe da lista) e o número do envio.
    Sent(Option<u64>, u64, Result<Value, Failure>),
}

/// Um subagente do disco (`GET …/subagents`), só com o que a lista mostra e casa.
#[derive(Clone, Debug, PartialEq)]
pub(super) struct SubRun {
    agent_id: String, agent_type: Option<String>, prompt: Option<String>, calls: u64, last_tool: Option<String>,
    finished: bool, unreadable: bool, tools: Vec<(String, u64)>,
    /// Erro de API no fim do registro (campo `failed` do Claude); servidor sem o campo, `false`.
    failed: bool,
    /// Primeira linha do registro (`startedAt`), em segundos desde a época; vazio ou ilegível, nada.
    started: Option<f64>,
    /// `running`, `finished` ou `failed`, quando o servidor sabe; vale acima do que se deduz do Agent do pai.
    state: Option<String>,
    /// `endedAt` e `updatedAt`, em segundos desde a época.
    ended: Option<f64>,
    updated: Option<f64>,
    /// O servidor aceita mensagem direta a este subagente; senão, o código do motivo.
    can_message: bool,
    message_blocked: Option<String>,
}

/// Sem `state` nem Agent do pai, um registro parado há tanto tempo terminou.
const STALE_SECS: f64 = 600.;

fn wall_seconds(at: &str) -> Option<f64> {
    chrono::DateTime::parse_from_rfc3339(at).ok().map(|at| at.timestamp_millis() as f64 / 1000.)
}

fn parse_sub(item: &Value) -> Option<SubRun> {
    let text = |item: &Value, key: &str| item.get(key).and_then(Value::as_str).map(str::to_owned);
    Some(SubRun {
        state: text(item, "state").filter(|s| !s.is_empty()),
        ended: text(item, "endedAt").as_deref().and_then(wall_seconds),
        updated: text(item, "updatedAt").as_deref().and_then(wall_seconds).or_else(|| item.get("mtime").and_then(Value::as_f64)),
        can_message: item.get("canMessage").and_then(Value::as_bool).unwrap_or(false),
        message_blocked: text(item, "messageBlocked").filter(|s| !s.is_empty()),
        agent_id: text(item, "agentId")?,
        agent_type: text(item, "agentType").filter(|t| !t.is_empty()),
        prompt: text(item, "prompt"),
        calls: item.get("toolCalls").and_then(Value::as_u64).unwrap_or(0),
        last_tool: item.get("recent").and_then(Value::as_array).and_then(|recent| recent.last()).and_then(|last| text(last, "name")),
        finished: item.get("finished").and_then(Value::as_bool).unwrap_or(false),
        unreadable: item.get("ilegivel").and_then(Value::as_bool).unwrap_or(false),
        tools: item.get("tools").and_then(Value::as_array).map(|tools| tools.iter()
            .filter_map(|t| Some((text(t, "name")?, t.get("count").and_then(Value::as_u64).unwrap_or(0)))).collect()).unwrap_or_default(),
        failed: item.get("failed").and_then(Value::as_bool).unwrap_or(false),
        started: text(item, "startedAt").as_deref().and_then(wall_seconds),
    })
}

/// O corpo do `POST …/subagents/{id}/message`.
fn message_body(text: &str) -> Value { serde_json::json!({"text": text.trim()}) }

/// O motivo do compositor desligado, no idioma da tela; código sem frase cai na genérica.
fn blocked_text(code: Option<&str>) -> String {
    code.and_then(|code| crate::i18n::tr_web(code, &HashMap::new())).unwrap_or_else(|| tr("subagent_message_unavailable"))
}

/// Terminou antes de `midnight` (hoje 00:00): vai para "Mais antigos".
fn older(at: Option<f64>, midnight: f64) -> bool { at.is_some_and(|at| at < midnight) }

/// Hoje 00:00 no fuso local, em segundos desde a época.
fn today_start() -> f64 {
    use chrono::{Local, TimeZone};
    let now = Local::now();
    now.date_naive().and_hms_opt(0, 0, 0).and_then(|t| Local.from_local_datetime(&t).earliest())
        .map(|t| t.timestamp() as f64).unwrap_or(0.)
}

/// HH:MM local de um horário de parede.
fn clock(at: f64) -> String {
    chrono::DateTime::from_timestamp(at as i64, 0).map(|t| t.with_timezone(&chrono::Local).format("%H:%M").to_string()).unwrap_or_default()
}

/// O instante local de um horário de parede (segundos desde a época); no futuro, agora.
fn since_wall(ts: f64) -> Option<Instant> {
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).ok()?.as_secs_f64();
    Instant::now().checked_sub(std::time::Duration::from_secs_f64((now - ts).max(0.)))
}

fn parse_subs(value: &Value) -> Vec<SubRun> {
    value.as_array().map(|list| list.iter().filter_map(parse_sub).collect()).unwrap_or_default()
}

pub(super) fn web(key: &str) -> String { crate::i18n::tr_web(key, &HashMap::new()).unwrap_or_else(|| key.to_owned()) }
fn web_with(key: &str, name: &str, value: String) -> String {
    crate::i18n::tr_web(key, &HashMap::from([(name.to_owned(), value)])).unwrap_or_else(|| key.to_owned())
}

/// O `formatarIntervalo` do web: um minuto é o piso.
fn interval(seconds: f64) -> String {
    match seconds.max(0.) {
        s if s < 60. => "1 min".into(),
        s if s < 3600. => format!("{} min", (s / 60.).floor()),
        s if s < 86_400. => format!("{} h", (s / 3600.).floor()),
        s => format!("{} d", (s / 86_400.).floor()),
    }
}

fn now_seconds() -> f64 { std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs_f64()).unwrap_or(0.) }

fn norm(text: &str) -> String { text.split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase() }

/// O subagente do disco de um Agent: prompt normalizado inteiro, senão os 400 primeiros caracteres (o mais recente
/// vence, e a lista já vem do mais recém-escrito).
fn match_sub<'a>(subs: &'a [SubRun], prompt: Option<&str>) -> Option<&'a SubRun> {
    let full = norm(prompt?);
    subs.iter().find(|s| s.prompt.as_deref().is_some_and(|p| norm(p) == full)).or_else(|| {
        let head: String = full.chars().take(400).collect();
        subs.iter().find(|s| s.prompt.as_deref().is_some_and(|p| norm(p).starts_with(&head)))
    })
}

/// Terminou: o backend diz (Kimi, Pi) ou o Agent do pai que o lançou já teve o fim real — o registro do Claude não traz
/// `finished`. O Agent é achado pelo `agentId` do resultado; sem ele, pelo prompt, e só quando um Agent e um subagente
/// casam um com o outro e mais ninguém: ambíguo não afirma o fim.
fn sub_done(agents: &[AgentRun], subs: &[SubRun], run: &SubRun) -> bool {
    sub_status(agents, subs, run, now_seconds()) != SubStatus::Running
}

/// Rodando, terminado ou falho, com o horário do fim (o `endedAt`, senão a última escrita).
#[derive(Clone, Copy, Debug, PartialEq)]
enum SubStatus { Running, Finished(Option<f64>), Failed(Option<f64>) }

/// O `state` do servidor decide; sem ele, o fim do backend ou do Agent do pai, e o registro sem Agent do pai parado há
/// mais de 10 min terminou na última escrita (subagente de outra conversa não fica "Pensando" para sempre).
fn sub_status(agents: &[AgentRun], subs: &[SubRun], run: &SubRun, now: f64) -> SubStatus {
    let at = run.ended.or(run.updated);
    match run.state.as_deref() {
        Some("running") => return SubStatus::Running,
        Some("finished") => return SubStatus::Finished(at),
        Some("failed") => return SubStatus::Failed(at),
        _ => {}
    }
    if run.failed { return SubStatus::Failed(at); }
    if ended_by_parent(agents, subs, run) { return SubStatus::Finished(at); }
    let parent = agents.iter().any(|a| match &a.agent_id {
        Some(id) => id == &run.agent_id,
        None => match_sub(std::slice::from_ref(run), a.prompt.as_deref()).is_some(),
    });
    if !parent && run.updated.is_some_and(|updated| now - updated > STALE_SECS) { return SubStatus::Finished(run.updated); }
    SubStatus::Running
}

fn ended_by_parent(agents: &[AgentRun], subs: &[SubRun], run: &SubRun) -> bool {
    if run.finished { return true; }
    if let Some(agent) = agents.iter().find(|a| a.agent_id.as_deref() == Some(run.agent_id.as_str())) { return !agent.running; }
    let subs_of = |prompt: Option<&str>| subs.iter().filter(|s| match_sub(std::slice::from_ref(*s), prompt).is_some()).count();
    let mut by_prompt = agents.iter().filter(|a| a.agent_id.is_none() && match_sub(std::slice::from_ref(run), a.prompt.as_deref()).is_some());
    match (by_prompt.next(), by_prompt.next()) {
        (Some(agent), None) => !agent.running && subs_of(agent.prompt.as_deref()) == 1,
        _ => false,
    }
}

/// O subagente do Agent da chamada `call` falhou. A posse é a de `sub_done`: o `agentId` do resultado decide; sem ele,
/// pelo prompt, só quando um subagente sem dono e este Agent casam um com o outro e mais ninguém.
fn agent_failed(agents: &[AgentRun], subs: &[SubRun], call: usize) -> bool {
    let Some(agent) = agents.iter().find(|a| a.call == call) else { return false };
    if let Some(id) = &agent.agent_id { return subs.iter().any(|s| &s.agent_id == id && s.failed); }
    let owned = |s: &SubRun| agents.iter().any(|a| a.agent_id.as_deref() == Some(s.agent_id.as_str()));
    let mut candidates = subs.iter().filter(|s| !owned(s) && match_sub(std::slice::from_ref(*s), agent.prompt.as_deref()).is_some());
    let (Some(sub), None) = (candidates.next(), candidates.next()) else { return false };
    let claimants = agents.iter().filter(|a| a.agent_id.is_none() && match_sub(std::slice::from_ref(sub), a.prompt.as_deref()).is_some()).count();
    claimants == 1 && sub.failed
}

/// Primeira linha útil do prompt (pula o cabeçalho de skill e títulos), até 90 caracteres.
fn base_title(sub: &SubRun) -> String {
    let prompt = sub.prompt.as_deref().unwrap_or("");
    let lines: Vec<&str> = prompt.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
    let useful = lines.iter().find(|l| !l.to_lowercase().starts_with("base directory for this skill:") && !l.starts_with('#'));
    useful.or(lines.first()).copied().unwrap_or(&sub.agent_id).chars().take(90).collect()
}

/// Título repetido (os itens de um AgentSwarm abrem igual) leva o `agentId`.
fn sub_title(subs: &[SubRun], sub: &SubRun) -> String {
    let base = base_title(sub);
    if subs.iter().any(|o| o.agent_id != sub.agent_id && base_title(o) == base) { format!("{base} · {}", sub.agent_id) } else { base }
}

/// "N chamadas · última ferramenta".
fn calls_line(sub: &SubRun) -> String {
    let mut line = web_with("atividade_chamadas", "n", sub.calls.to_string());
    if let Some(tool) = &sub.last_tool { line.push_str(&format!(" · {tool}")); }
    line
}

#[derive(Clone, Debug, PartialEq)]
struct AgentLine { key: String, description: String, tags: Vec<(String, bool)>, now: Option<String>, sub: Option<String> }
#[derive(Clone, Debug, PartialEq)]
struct OrphanLine { key: String, title: String, tag: Option<String>, now: String, done: bool, failed: bool }
#[derive(Clone, Debug, PartialEq)]
struct ShellLine { key: String, label: String, raw: String, now: String }
#[derive(Clone, Debug, PartialEq)]
struct TaskLine { mark: &'static str, text: String, status: TaskStatus }

/// O que a lista mostra, preparado quando um dado muda; o desenho só lê.
#[derive(Clone, Debug, Default, PartialEq)]
struct Lines {
    agents: Vec<AgentLine>,
    /// Subagentes do disco: rodando (fora das linhas de Agent), terminados hoje e os de antes de hoje.
    running: Vec<OrphanLine>, finished: Vec<OrphanLine>, older: Vec<OrphanLine>,
    shells: Vec<ShellLine>, processes: Vec<ShellLine>, tasks: Vec<TaskLine>, timed: bool,
}

#[derive(Clone)]
pub(super) struct Link { pub api: Api, pub runtime: Arc<Runtime>, pub tx: async_channel::Sender<Envelope>, pub connection: u64 }

/// O subagente aberto no detalhe: o que a lista sabia dele até a primeira resposta, depois o que a consulta traz.
/// `done` é o fim mostrado: o do backend ou o do Agent que o lançou.
struct Opened { run: SubRun, title: String, raw: Option<Value>, loaded: bool, has_events: bool, fails: u32, busy: bool, done: bool }

pub(super) struct ActivityPanel {
    link: Option<Link>,
    key: Option<SessionKey>,
    shown: bool,
    activity: Activity,
    processes: Vec<ShellAlive>,
    subs: Vec<SubRun>,
    seq: u64,
    loading: bool,
    failed: bool,
    lines: Lines,
    clock: Option<Task<()>>,
    scroll: ScrollHandle,
    opened: Option<Opened>,
    detail_seq: u64,
    poll: Option<Task<()>>,
    /// Aviso do detalhe ("parou", "não achei"), em cima de tudo, como o `subError` do web.
    notice: Option<String>,
    /// Clique num cartão Agent antes de a lista chegar: prompt e título.
    pending: Option<(Option<String>, String)>,
    conversation: Entity<SubConversation>,
    /// O ‹ do detalhe: quem abriu pelo teclado cai nele, e Enter volta.
    back_focus: FocusHandle,
    /// Lugares da marca desta view, que é guardada dentro do painel: ela limpa os seus a cada desenho.
    marks: super::panes::MarkPlaces,
    tab_id: Option<u64>,
    /// "Mais antigos" aberto.
    older_open: bool,
    /// O compositor do subagente: nasce no primeiro desenho do detalhe (o campo pede a janela).
    input: Option<(Entity<TextareaState>, Subscription)>,
    sending: bool,
    send_seq: u64,
    send_error: Option<String>,
    /// Envio aceito: o campo esvazia no próximo desenho, que tem a janela.
    clear_input: bool,
    placeholder: String,
}

impl ActivityPanel {
    fn new(cx: &mut Context<Self>) -> Self {
        Self { link: None, key: None, shown: false, activity: Activity::default(), processes: Vec::new(), subs: Vec::new(), seq: 0,
            loading: false, failed: false, lines: Lines::default(), clock: None, scroll: ScrollHandle::new(), opened: None, detail_seq: 0,
            poll: None, notice: None, pending: None, conversation: cx.new(|_| SubConversation::new()), back_focus: cx.focus_handle().tab_stop(true),
            marks: Default::default(), tab_id: None, older_open: false, input: None, sending: false, send_seq: 0, send_error: None,
            clear_input: false, placeholder: String::new() }
    }

    /// Refaz as linhas; `true` quando mudou algo que aparece.
    fn prepare(&mut self) -> bool {
        let now = now_seconds();
        let mut timed = false;
        let agents = self.activity.running_agents().map(|a| {
            let sub = match_sub(&self.subs, a.prompt.as_deref());
            let mut tags = Vec::new();
            if let Some(t) = &a.subagent_type { tags.push((t.clone(), false)); }
            if let Some(m) = &a.model { tags.push((m.clone(), true)); }
            AgentLine { key: a.id.clone(), description: a.description.clone(), tags, now: sub.map(calls_line), sub: sub.map(|s| s.agent_id.clone()) }
        }).collect();
        // Quem já está na linha de um Agent rodando não se repete entre os subagentes rodando.
        let shown: HashSet<String> = self.activity.running_agents()
            .filter_map(|a| match_sub(&self.subs, a.prompt.as_deref())).map(|s| s.agent_id.clone()).collect();
        let midnight = today_start();
        let (mut running, mut finished, mut older_lines) = (Vec::new(), Vec::new(), Vec::new());
        for s in &self.subs {
            let status = sub_status(&self.activity.agents, &self.subs, s, now);
            let (ended, failed) = match status { SubStatus::Running => (None, false), SubStatus::Finished(at) => (Some(at), false), SubStatus::Failed(at) => (Some(at), true) };
            // Ilegível não diz "0 chamadas": os campos vêm zerados porque o registro não foi lido.
            let calls = if s.unreadable { web("atividade_sub_ilegivel") } else { calls_line(s) };
            let line = OrphanLine { key: s.agent_id.clone(), title: sub_title(&self.subs, s), tag: s.agent_type.clone(), done: ended.is_some(), failed,
                now: match ended {
                    None => calls,
                    Some(at) => {
                        let mark = match at {
                            Some(at) => web_with(if failed { "atividade_parou" } else { "atividade_terminou" }, "h", clock(at)),
                            None => if failed { tr("tool_failed") } else { web("atividade_sub_concluido") },
                        };
                        format!("{mark} · {calls}")
                    }
                },
            };
            match ended {
                None if shown.contains(&s.agent_id) => {}
                None => running.push(line),
                Some(at) if older(at, midnight) => older_lines.push(line),
                Some(_) => finished.push(line),
            }
        }
        let shells = self.activity.running_shells().map(|s| {
            let mut now_text = s.description.clone().unwrap_or_default();
            if let Some(ts) = s.ts {
                timed = true;
                if !now_text.is_empty() { now_text.push_str(" · "); }
                now_text.push_str(&web_with("atividade_shell_ha", "t", interval(now - ts)));
            }
            ShellLine { key: s.id.clone(), label: s.label.clone(), raw: s.command.clone(), now: now_text }
        }).collect();
        let processes = self.processes.iter().map(|p| {
            let mut now_text = format!("pid {}", p.pid);
            if let Some(since) = p.desde {
                timed = true;
                now_text.push_str(&format!(" · {}", web_with("atividade_shell_ha", "t", interval(now - since))));
            }
            ShellLine { key: p.pid.to_string(), label: p.cmd.clone(), raw: p.cmd.clone(), now: now_text }
        }).collect();
        let tasks = self.activity.tasks.iter().map(|t| TaskLine {
            mark: match t.status { TaskStatus::Completed => "✓", TaskStatus::InProgress => "◐", TaskStatus::Pending => "○" },
            text: match (&t.status, &t.active_form) { (TaskStatus::InProgress, Some(form)) => form.clone(), _ => t.title.clone() },
            status: t.status.clone(),
        }).collect();
        // O subagente parado vira terminado com o tempo: o relógio da aba relê.
        timed |= !running.is_empty();
        let lines = Lines { agents, running, finished, older: older_lines, shells, processes, tasks, timed };
        if lines == self.lines { return false; }
        self.lines = lines;
        true
    }

    /// Conversa e estado novos da sessão aberta: a view só redesenha se a lista mudou.
    fn set_data(&mut self, activity: &Activity, processes: &[ShellAlive], cx: &mut Context<Self>) {
        if &self.activity == activity && self.processes == processes { return; }
        (self.activity, self.processes) = (activity.clone(), processes.to_vec());
        if self.prepare() { cx.notify(); }
        // O Agent do pai terminou com o detalhe aberto: uma última leitura traz o fim, e a resposta dela para a consulta.
        if self.poll.is_some() && self.opened.as_ref().is_some_and(|o| !o.done && self.done(&o.run)) { self.fetch_detail(); }
    }

    fn done(&self, run: &SubRun) -> bool { sub_done(&self.activity.agents, &self.subs, run) }

    /// A aba passou a aparecer (ou mudou de sessão): relê a lista. `None` = escondida, o relógio para.
    fn show(&mut self, target: Option<(SessionKey, Link)>, cx: &mut Context<Self>) {
        let Some((key, link)) = target else {
            self.shown = false;
            self.clock = None;
            // Sair da aba mata o pedido do cartão e a consulta, e a volta começa na lista.
            self.close_detail(cx);
            (self.notice, self.pending) = (None, None);
            return;
        };
        let other = self.key.as_ref() != Some(&key);
        if other || !self.shown {
            // Aba que volta a aparecer relê do zero, como o web, que desmonta a lista ao trocar de aba; resposta da
            // sessão anterior não entra na desta.
            self.seq += 1;
            (self.subs, self.failed, self.loading) = (Vec::new(), false, false);
            if other { self.close_detail(cx); (self.notice, self.pending) = (None, None); }
            self.key = Some(key);
            self.link = Some(link);
            self.prepare();
            self.load(cx);
        }
        self.shown = true;
        if self.clock.is_none() {
            self.clock = Some(cx.spawn(async move |this, cx| loop {
                cx.background_executor().timer(CLOCK_EVERY).await;
                let alive = this.update(cx, |this, cx| if this.lines.timed && this.prepare() { cx.notify() });
                if alive.is_err() { break; }
            }));
        }
    }

    fn load(&mut self, cx: &mut Context<Self>) {
        let (Some(link), Some(key)) = (self.link.clone(), self.key.clone()) else { return };
        self.seq += 1;
        self.loading = true;
        let seq = self.seq;
        link.runtime.spawn(async move {
            let result = link.api.read(&key.name, &["subagents"], &[], 15).await.map(|value| parse_subs(&value));
            let _ = link.tx.send(Envelope { connection: link.connection, selection: None, payload: Payload::Activity(ActivityReply::List(seq, result)) }).await;
        });
        cx.notify();
    }

    fn receive(&mut self, seq: u64, result: Result<Vec<SubRun>, Failure>, cx: &mut Context<Self>) {
        if seq != self.seq { return; }
        self.loading = false;
        // Falha mantém o que já se sabia e avisa em cima de tudo.
        match result { Ok(subs) => (self.subs, self.failed) = (subs, false), Err(_) => self.failed = true }
        self.prepare();
        // Pedido do cartão que esperava a lista: com a lista falhando, o aviso dela já diz por quê.
        if let Some((prompt, title)) = self.pending.take().filter(|_| !self.failed) { self.resolve(prompt.as_deref(), title, cx); }
        cx.notify();
    }

    /// Clique no cartão Agent da conversa: abre a conversa daquele agente, casada pelo prompt. Sem a lista ainda,
    /// espera por ela (e a pede de novo se ela não está a caminho).
    pub(super) fn request_agent(&mut self, prompt: Option<String>, title: String, cx: &mut Context<Self>) {
        if self.subs.is_empty() {
            self.pending = Some((prompt, title));
            if !self.loading { self.load(cx); }
            return;
        }
        self.resolve(prompt.as_deref(), title, cx);
    }

    fn resolve(&mut self, prompt: Option<&str>, title: String, cx: &mut Context<Self>) {
        match match_sub(&self.subs, prompt).cloned() {
            Some(run) => self.open_sub(run, title, cx),
            None => {
                // Sem avisar, a tela ficaria no agente anterior: a conversa errada com cara de certa.
                self.close_detail(cx);
                self.notice = Some(web("atividade_agente_nao_achado"));
                cx.notify();
            }
        }
    }

    fn open_sub(&mut self, run: SubRun, title: String, cx: &mut Context<Self>) {
        self.close_detail(cx);
        self.notice = None;
        let done = self.done(&run);
        self.opened = Some(Opened { run, title, raw: None, loaded: false, has_events: false, fails: 0, busy: false, done });
        self.start_poll(cx);
        cx.notify();
    }

    fn start_poll(&mut self, cx: &mut Context<Self>) {
        self.poll = Some(cx.spawn(async move |this, cx| loop {
            if this.update(cx, |this, _| this.fetch_detail()).is_err() { break; }
            cx.background_executor().timer(DETAIL_EVERY).await;
        }));
    }

    /// Enter ou o botão: o texto vai ao subagente aberto; o campo só esvazia quando o servidor aceita.
    fn send_message(&mut self, cx: &mut Context<Self>) {
        let (Some(link), Some(key), Some(input)) = (self.link.clone(), self.key.clone(), self.input.as_ref().map(|(i, _)| i.clone())) else { return };
        let Some(id) = self.opened.as_ref().filter(|o| o.run.can_message).map(|o| o.run.agent_id.clone()) else { return };
        let text = input.read(cx).value().to_string();
        if self.sending || text.trim().is_empty() { return; }
        (self.sending, self.send_error) = (true, None);
        self.send_seq += 1;
        let (seq, tab) = (self.send_seq, self.tab_id);
        link.runtime.spawn(async move {
            let result = link.api.act(&key.name, &["subagents", &id, "message"], Some(message_body(&text)), false, 40).await;
            let _ = link.tx.send(Envelope { connection: link.connection, selection: None, payload: Payload::Activity(ActivityReply::Sent(tab, seq, result)) }).await;
        });
        cx.notify();
    }

    fn receive_sent(&mut self, seq: u64, result: Result<Value, Failure>, cx: &mut Context<Self>) {
        if seq != self.send_seq { return; }
        self.sending = false;
        match result {
            Ok(_) => {
                self.clear_input = true;
                // O agente que já tinha terminado volta a rodar com a mensagem: a consulta, parada no fim, recomeça.
                if self.poll.is_none() && self.opened.is_some() { self.start_poll(cx); } else { self.fetch_detail(); }
            }
            // Sem resposta do servidor, o `detail` é a chave da frase; com resposta, já é a frase traduzida.
            Err(failure) => self.send_error = Some(if failure.status.is_none() { tr(&failure.detail) } else { failure.detail }),
        }
        cx.notify();
    }

    /// Volta para a lista e esquece o subagente: resposta dele que ainda chegar é descartada.
    fn close_detail(&mut self, cx: &mut Context<Self>) {
        self.detail_seq += 1;
        self.send_seq += 1;
        (self.sending, self.send_error) = (false, None);
        self.poll = None;
        if self.opened.take().is_some() { self.conversation.update(cx, |view, _| view.clear()); }
    }

    fn back(&mut self, cx: &mut Context<Self>) {
        self.close_detail(cx);
        cx.notify();
    }

    /// Uma batida da consulta: com um pedido em voo, a batida não pede outro.
    fn fetch_detail(&mut self) {
        let (Some(link), Some(key)) = (self.link.clone(), self.key.clone()) else { return };
        let Some(opened) = self.opened.as_mut().filter(|o| !o.busy) else { return };
        opened.busy = true;
        let (seq, id, tab) = (self.detail_seq, opened.run.agent_id.clone(), self.tab_id);
        link.runtime.spawn(async move {
            let result = link.api.read(&key.name, &["subagents", &id], &[("events", "200")], 15).await;
            let reply = match tab { Some(tab) => ActivityReply::TabDetail(tab, seq, result), None => ActivityReply::Detail(seq, result) };
            let _ = link.tx.send(Envelope { connection: link.connection, selection: None, payload: Payload::Activity(reply) }).await;
        });
    }

    fn receive_detail(&mut self, seq: u64, result: Result<Value, Failure>, cx: &mut Context<Self>) {
        if seq != self.detail_seq { return; }
        let Some(opened) = self.opened.as_mut() else { return };
        opened.busy = false;
        match result {
            Ok(value) => {
                let run = parse_sub(&value).unwrap_or_else(|| opened.run.clone());
                let done = self.done(&run);
                // Terminou: esta leitura já traz o fim, e a consulta para aqui.
                if done { self.poll = None; }
                let Some(opened) = self.opened.as_mut() else { return };
                opened.fails = 0;
                let first = !opened.loaded;
                opened.loaded = true;
                let cleared = self.notice.take().is_some();
                // Resposta igual à anterior não pede quadro.
                if opened.raw.as_ref() == Some(&value) && opened.done == done { if first || cleared { cx.notify(); } return; }
                let events: Vec<ChatEvent> = value.get("events").cloned().and_then(|e| serde_json::from_value(e).ok()).unwrap_or_default();
                let has_events = !events.is_empty();
                let changed = first || cleared || opened.run != run || opened.has_events != has_events || opened.done != done;
                (opened.run, opened.raw, opened.has_events, opened.done) = (run, Some(value), has_events, done);
                let started = opened.run.started;
                self.conversation.update(cx, |view, cx| view.set_events(events, done, started, cx));
                if changed { cx.notify(); }
            }
            Err(failure) => {
                // Falha isolada é normal (o arquivo some quando o agente termina) e mantém o último estado; o 404 é
                // definitivo (a sessão morreu por baixo do painel) e a terceira seguida é erro de verdade.
                opened.fails += 1;
                if failure.status == Some(404) || opened.fails >= DETAIL_FAILS {
                    opened.loaded = true;
                    self.poll = None;
                    self.notice = Some(web("atividade_erro_vivo"));
                    cx.notify();
                }
            }
        }
    }
}

fn spinning(key: String) -> AnyElement {
    div().mt(px(2.)).flex_shrink_0().child(chrome::Spinner::new(SharedString::from(key), IconName::LoaderCircle, px(13.), theme::accent())).into_any_element()
}

fn section(title: String, count: Option<usize>) -> Div {
    div().flex().flex_col().gap_2().child(chrome::section_label(title).flex().gap_1()
        .when_some(count, |el, n| el.child(div().text_color(theme::accent()).child(n.to_string()))))
}

fn tag(text: String, muted: bool) -> AnyElement {
    div().flex_shrink_0().px(px(6.)).py(px(1.)).rounded_full().bg(theme::hover()).font_family(theme::MONO)
        .text_size(px(10.)).text_color(if muted { theme::faint() } else { theme::muted() }).child(text).into_any_element()
}

fn now_text(text: String) -> AnyElement {
    div().font_family(theme::MONO).text_size(px(10.)).text_color(theme::faint()).child(text).into_any_element()
}

fn warning_text(text: String) -> AnyElement {
    div().font_family(theme::MONO).text_size(px(10.)).text_color(theme::warning()).child(text).into_any_element()
}

fn shell_row(prefix: &str, line: &ShellLine) -> AnyElement {
    let raw = line.raw.clone();
    div().id(SharedString::from(format!("{prefix}-{}", line.key))).flex().items_start().gap_2()
        .tooltip(move |window, cx| Tooltip::new(raw.clone()).build(window, cx))
        .child(spinning(format!("{prefix}-spin-{}", line.key)))
        .child(div().flex_1().min_w_0().flex().flex_col().gap(px(3.))
            .child(div().font_family(theme::MONO).text_sm().text_color(theme::text()).line_clamp(2).child(line.label.clone()))
            .when(!line.now.is_empty(), |el| el.child(now_text(line.now.clone()))))
        .into_any_element()
}

impl ActivityPanel {
    /// Views guardadas dentro desta, que redesenham junto na troca de aba (`side_tab_in`).
    pub(super) fn views(&self) -> Vec<EntityId> { vec![self.conversation.entity_id()] }
}

impl Render for ActivityPanel {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.marks.borrow_mut().clear();
        if self.opened.is_some() { return self.render_detail(window, cx); }
        let lines = &self.lines;
        let mut body = div().px_4().py(px(14.)).flex().flex_col().gap_4();
        if self.failed {
            body = body.child(warning_line(web("atividade_erro_subagentes")));
        }
        if let Some(notice) = &self.notice { body = body.child(warning_line(notice.clone())); }
        let sub_row = |s: &OrphanLine, window: &mut Window, cx: &mut Context<Self>| {
            let content = div().flex().flex_col().gap(px(3.)).when(s.done && !s.failed, |el| el.opacity(0.6))
                .child(div().flex().items_center().gap_1().min_w_0()
                    .child(div().min_w_0().truncate().text_sm().text_color(theme::text()).child(s.title.clone()))
                    .when_some(s.tag.clone(), |el, t| el.child(tag(t, false))))
                .child(if s.failed { warning_text(s.now.clone()) } else { now_text(s.now.clone()) });
            openable(format!("act-orphan-{}", s.key), s.key.clone(), s.title.clone(), content, window, cx)
        };
        if !lines.agents.is_empty() || !lines.running.is_empty() {
            let mut rows: Vec<AnyElement> = lines.agents.iter().map(|a| {
                let content = div().flex().items_start().gap_2().child(spinning(format!("act-agent-spin-{}", a.key)))
                    .child(div().flex_1().min_w_0().flex().flex_col().gap(px(3.))
                        .child(div().flex().items_center().gap_1().min_w_0()
                            .child(div().min_w_0().truncate().text_sm().text_color(theme::text()).child(a.description.clone()))
                            .children(a.tags.iter().map(|(t, muted)| tag(t.clone(), *muted))))
                        .when_some(a.now.clone(), |el, now| el.child(now_text(now))));
                // Só abre quem casou com o disco; o resto é informação.
                match &a.sub {
                    Some(sub) => openable(format!("act-agent-{}", a.key), sub.clone(), a.description.clone(), content, window, cx),
                    None => content.into_any_element(),
                }
            }).collect();
            rows.extend(lines.running.iter().map(|s| sub_row(s, window, cx)));
            let count = (lines.agents.len() + lines.running.len()).to_string();
            body = body.child(section(web_with("atividade_grupo_rodando", "n", count), None).children(rows));
        }
        if !lines.finished.is_empty() || !lines.older.is_empty() {
            let rows: Vec<AnyElement> = lines.finished.iter().map(|s| sub_row(s, window, cx)).collect();
            let count = (lines.finished.len() + lines.older.len()).to_string();
            let mut group = section(web_with("atividade_grupo_terminados", "n", count), None).children(rows);
            if !lines.older.is_empty() {
                let open = self.older_open;
                let label = web_with("atividade_grupo_antigos", "n", lines.older.len().to_string());
                group = group.child(div().id("act-older").flex().items_center().gap_1().mx(px(-8.)).px(px(8.)).py(px(4.)).rounded(px(8.))
                    .cursor_pointer().hover(|el| el.bg(theme::hover())).role(Role::Button).aria_label(label.clone())
                    .child(chrome::small_icon(if open { IconName::ChevronDown } else { IconName::ChevronRight }, 14., theme::faint()))
                    .child(chrome::section_label(label))
                    .on_click(cx.listener(|this, _, _, cx| { this.older_open = !this.older_open; cx.notify(); })));
                if open { group = group.children(lines.older.iter().map(|s| sub_row(s, window, cx))); }
            }
            body = body.child(group);
        }
        if !lines.shells.is_empty() {
            body = body.child(section(web("atividade_shells"), Some(lines.shells.len()))
                .children(lines.shells.iter().map(|s| shell_row("act-shell", s))));
        }
        if !lines.processes.is_empty() {
            body = body.child(section(web("atividade_processos"), Some(lines.processes.len()))
                .children(lines.processes.iter().map(|p| shell_row("act-proc", p))));
        }
        if !lines.tasks.is_empty() {
            body = body.child(section(web("atividade_tarefas"), None).children(lines.tasks.iter().map(|t| {
                let (mark, text) = match t.status {
                    TaskStatus::InProgress => (theme::accent(), theme::text()),
                    TaskStatus::Completed => (theme::success(), theme::faint()),
                    TaskStatus::Pending => (theme::faint(), theme::muted()),
                };
                div().flex().items_baseline().gap_2()
                    .child(div().w(px(14.)).flex_shrink_0().text_center().text_sm().text_color(mark).child(t.mark))
                    .child(div().text_sm().text_color(text).when(t.status == TaskStatus::Completed, |el| el.line_through()).child(t.text.clone()))
            })));
        }
        let empty = lines.agents.is_empty() && lines.running.is_empty() && lines.finished.is_empty() && lines.older.is_empty() && lines.shells.is_empty() && lines.processes.is_empty() && lines.tasks.is_empty();
        if empty {
            // Antes da primeira resposta não se afirma que não há nada.
            let text = if self.loading && self.subs.is_empty() && !self.failed { tr("activity_loading") } else { web("atividade_vazio") };
            body = body.child(div().py_4().text_center().text_sm().text_color(theme::faint()).child(text));
        }
        div().id("activity-scroll").size_full().overflow_y_scroll().track_scroll(&self.scroll).child(body).into_any_element()
    }
}

fn warning_line(text: String) -> AnyElement {
    div().text_xs().text_color(theme::warning()).child(format!("⚠ {text}")).into_any_element()
}

/// Linha da lista que abre a conversa do subagente: foco pelo Tab, Enter ou espaço abrem, › à direita como o web.
fn openable(id: String, agent_id: String, title: String, content: Div, window: &mut Window, cx: &mut Context<ActivityPanel>) -> AnyElement {
    let focus = window.use_keyed_state(SharedString::from(format!("{id}-focus")), cx, |_, cx| cx.focus_handle().tab_stop(true)).read(cx).clone();
    let label = format!("{}: {title}", web("tool_abrir_agente"));
    let (click_id, click_title) = (agent_id.clone(), title.clone());
    div().id(SharedString::from(id)).track_focus(&focus).flex().items_center().gap_2().mx(px(-8.)).px(px(8.)).py(px(4.)).rounded(px(8.))
        .cursor_pointer().hover(|el| el.bg(theme::hover()))
        .when(focus.is_focused(window), |el| el.focus_ring_style(window, cx))
        .role(Role::Button).aria_label(label)
        .child(content.flex_1().min_w_0())
        .child(chrome::small_icon(IconName::ChevronRight, 14., theme::faint()).flex_shrink_0())
        .on_click(cx.listener(move |this, _, _, cx| this.open_listed(&click_id, click_title.clone(), cx)))
        .on_key_down(cx.listener(move |this, event: &KeyDownEvent, window, cx| {
            if matches!(event.keystroke.key.as_str(), "enter" | "space") {
                this.open_listed(&agent_id, title.clone(), cx);
                // A linha focada some com a lista: o foco passa ao ‹, e o caminho de volta fica a um Enter.
                if this.opened.is_some() { this.back_focus.focus(window, cx); }
                cx.stop_propagation();
            }
        }))
        .into_any_element()
}

impl ActivityPanel {
    /// Linha da lista: o subagente já é conhecido, sem casar de novo pelo texto.
    fn open_listed(&mut self, agent_id: &str, title: String, cx: &mut Context<Self>) {
        if let Some(run) = self.subs.iter().find(|s| s.agent_id == agent_id).cloned() { self.open_sub(run, title, cx); }
    }

    /// O campo do compositor do subagente, criado uma vez: Enter envia, como o da conversa.
    fn ensure_input(&mut self, window: &mut Window, cx: &mut Context<Self>) -> Entity<TextareaState> {
        if let Some((input, _)) = &self.input { return input.clone(); }
        let input = cx.new(|cx| TextareaState::new(window, cx).auto_grow(1, 10).submit_on_enter(true));
        let subscription = cx.subscribe_in(&input, window, |this, _, event: &InputEvent, _, cx| match event {
            InputEvent::PressEnter { secondary: false, shift: false } => this.send_message(cx),
            InputEvent::Change => { this.send_error = None; cx.notify(); }
            _ => {}
        });
        self.input = Some((input.clone(), subscription));
        input
    }

    /// O compositor da conversa, dirigido ao subagente: o mesmo cartão e o mesmo Enviar; desligado, diz por quê.
    fn render_composer(&mut self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let input = self.ensure_input(window, cx);
        if std::mem::take(&mut self.clear_input) { input.update(cx, |input, cx| input.set_value("", window, cx)); }
        let Some(run) = self.opened.as_ref().map(|o| o.run.clone()) else { return div().into_any_element() };
        let agent = run.agent_type.clone().unwrap_or_else(|| web("atividade_subagente"));
        let placeholder = tr("subagent_composer").replace("{agent}", &agent);
        if self.placeholder != placeholder {
            self.placeholder = placeholder.clone();
            input.update(cx, |input, cx| input.set_placeholder(placeholder, window, cx));
        }
        let focused = input.read(cx).focus_handle(cx).is_focused(window);
        let has_text = !input.read(cx).value().trim().is_empty();
        let label = tr(if self.sending { "sending" } else { "send" });
        let send = super::send_button("subagent-send", run.can_message && has_text && !self.sending, label, cx)
            .on_click(cx.listener(|this, _, _, cx| this.send_message(cx)));
        let note = if run.can_message { self.send_error.clone().map(|e| (e, true)) } else { Some((blocked_text(run.message_blocked.as_deref()), false)) };
        let card = super::composer_card(focused)
            .child(div().text_base().child(Textarea::new(&input).appearance(false).disabled(!run.can_message)))
            .child(div().flex().items_center().child(div().flex_1()).child(send));
        div().flex_shrink_0().px(px(12.)).pb(px(10.)).flex().flex_col().gap_1()
            .when_some(note, |el, (note, error)| el.child(div().px_1().text_xs().text_color(if error { theme::warning() } else { theme::muted() }).child(note)))
            .child(chrome::glass_panel(card, px(18.)))
            .into_any_element()
    }

    /// Detalhe: ‹ e o título, a conversa (só ela rola) e o compositor dirigido ao subagente, como a conversa principal.
    fn render_detail(&mut self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        if self.opened.is_none() { return div().into_any_element() }
        let composer = self.render_composer(window, cx);
        let Some(opened) = &self.opened else { return div().into_any_element() };
        let run = &opened.run;
        let empty = |text: String| div().px_4().py_4().text_center().text_sm().text_color(theme::faint()).child(text).into_any_element();
        let running = !opened.done && !run.failed && !run.unreadable;
        let body = if !opened.loaded { empty(tr("subagent_loading")) }
            else if opened.has_events {
                let conversation = super::panes::cached_selectable(self.conversation.clone().into(), StyleRefinement::default().size_full());
                // Como o `Spinner` que o web põe sob a conversa do subagente enquanto ele roda.
                div().size_full().flex().flex_col().child(div().flex_1().min_h_0().child(conversation))
                    .when(running, |el| el.child(div().flex_shrink_0().px_4().h(px(38.)).flex().items_center().gap(px(8.))
                        .child(super::panes::mark_slot(&self.marks, super::panes::Area::Side, "act-sub-working", 14., theme::accent()))
                        .child(div().min_w_0().truncate().text_size(px(12.)).text_color(theme::muted()).child(web("pensamento_vivo")))
                        // Os segundos desde a primeira linha do registro, como a linha "trabalhando" da conversa.
                        .when_some(run.started.and_then(since_wall), |el, since| el.child(
                            super::panes::elapsed_place(&self.marks, super::panes::Area::Side, "act-sub-elapsed", since)))))
                    .into_any_element()
            }
            // Já chamou ferramentas (ou o registro não foi lido): é falha de leitura, não agente parado.
            else if run.unreadable || run.calls > 0 { empty(web("atividade_erro_transcript")) }
            else { empty(web("atividade_pensando")) };
        let title = if opened.title.trim().is_empty() { web("atividade_subagente") } else { opened.title.clone() };
        let back = web("comum_voltar");
        // Na aba, o título já está nela: sobra a conversa e o compositor.
        div().size_full().flex().flex_col()
            .when(self.tab_id.is_none(), |el| el.child(div().flex_shrink_0().px(px(10.)).pt(px(10.)).pb(px(4.)).flex().items_center().gap_1()
                .child(div().id("act-back").track_focus(&self.back_focus).size(px(28.)).flex_shrink_0().rounded(px(6.))
                    .flex().items_center().justify_center().cursor_pointer().hover(|el| el.bg(theme::hover()))
                    .when(self.back_focus.is_focused(window), |el| el.focus_ring_style(window, cx))
                    .role(Role::Button).aria_label(back.clone())
                    .tooltip(move |window, cx| Tooltip::new(back.clone()).build(window, cx))
                    .child(chrome::small_icon(IconName::ChevronLeft, 16., theme::text()))
                    .on_click(cx.listener(|this, _, _, cx| this.back(cx)))
                    .on_key_down(cx.listener(|this, event: &KeyDownEvent, _, cx| {
                        if matches!(event.keystroke.key.as_str(), "enter" | "space") { this.back(cx); cx.stop_propagation(); }
                    })))
                .child(div().flex_1().min_w_0().truncate().text_sm().font_weight(FontWeight::SEMIBOLD).text_color(theme::text()).child(title))))
            .when_some(self.notice.clone(), |el, notice| el.child(div().flex_shrink_0().px_4().py_2().child(warning_line(notice))))
            .child(div().flex_1().min_h_0().child(body))
            .child(composer)
            .into_any_element()
    }
}

/// Estado do `Hangar` para a aba: a view, a conta do disco e as abas de subagente.
pub(super) struct ActivityState {
    view: Entity<ActivityPanel>,
    /// Subagentes no disco da sessão aberta; falha mantém o número anterior.
    count: usize,
    count_seq: u64,
    count_busy: bool,
    /// A lista da mesma leitura da conta: o cartão Agent do pai sabe da falha do seu subagente sem a aba aberta.
    subs: Vec<SubRun>,
    count_timer: Option<Task<()>>,
    tabs: Vec<SubagentTab>,
    active_tab: Option<u64>,
    tab_seq: u64,
    pending_tab: Option<(Option<String>, String)>,
    tab_error: Option<String>,
    tab_scroll: ScrollHandle,
}

struct SubagentTab { id: u64, agent_id: String, title: String, view: Entity<ActivityPanel>, previous: Option<u64> }

fn tab_after_close(active: Option<u64>, closed: u64, previous: Option<u64>, remaining: &[u64]) -> Option<u64> {
    if active != Some(closed) { return active; }
    previous.filter(|id| remaining.contains(id))
}

impl ActivityState {
    pub fn new(cx: &mut App) -> Self {
        Self { view: cx.new(ActivityPanel::new), count: 0, count_seq: 0, count_busy: false, subs: Vec::new(), count_timer: None,
            tabs: Vec::new(), active_tab: None, tab_seq: 0, pending_tab: None, tab_error: None,
            tab_scroll: ScrollHandle::new() }
    }
}

impl Hangar {
    /// Tarefas, agentes (mesmo os que terminaram), shells rodando, subagentes no disco ou processos vivos.
    pub(super) fn has_activity(&self) -> bool {
        let a = &self.conversation.activity;
        !a.tasks.is_empty() || !a.agents.is_empty() || a.running_shells().next().is_some() || self.act.count > 0 || !self.chat.state.shells.is_empty()
    }

    pub(super) fn activity_tab(&self) -> bool {
        self.act.active_tab.is_none() && !self.side_menu_shown() && self.side_tab() == SideTab::Activity
    }

    pub(super) fn subagent_tab_open(&self) -> bool { self.act.active_tab.is_some() }

    /// A aba lembrada desta sessão, se ela tem o que mostrar nela; senão, Contexto.
    pub(super) fn side_tab(&self) -> SideTab {
        let readable = self.selected.as_ref().is_some_and(|s| s.readable());
        // Arquivos e git da sessão da outra pessoa são recusados pelo servidor dela.
        let own = readable && !self.open_read_only();
        let key = self.side_key();
        let saved = key.as_ref().and_then(|k| self.side.tabs.get(k).copied()).unwrap_or(appearance::get().side_tab);
        match saved {
            SideTab::Files if own => SideTab::Files,
            SideTab::Activity if self.has_activity() => SideTab::Activity,
            SideTab::Git if own && self.selected.as_ref().is_some_and(super::sidebar::has_git) => SideTab::Git,
            // Lembrada de outra execução ou fechada no ×, a aba só volta depois que o navegador for aberto de novo.
            SideTab::Browser if key.is_some_and(|k| self.side.browser_open.contains(&k)) => SideTab::Browser,
            _ => SideTab::Context,
        }
    }

    fn activity_link(&self) -> Option<Link> {
        Some(Link { api: self.session_api()?, runtime: self.runtime.clone(), tx: self.tx.clone(), connection: self.connection })
    }

    /// Depois de mudar conversa, estado, conta ou aba: a view recebe os dados e, se passou a aparecer, relê a lista.
    pub(super) fn sync_activity(&mut self, cx: &mut Context<Self>) {
        let key = self.selected_key();
        if !self.side.open { self.act.pending_tab = None; }
        let target = key.filter(|_| self.side.open && !self.side_menu_shown() && self.side_tab() == SideTab::Activity).zip(self.activity_link());
        let (activity, processes) = (&self.conversation.activity, &self.chat.state.shells);
        self.act.view.update(cx, |view, cx| { view.set_data(activity, processes, cx); view.show(target, cx); });
        for tab in &self.act.tabs { tab.view.update(cx, |view, cx| view.set_data(activity, processes, cx)); }
    }

    /// Clique numa aba do painel: fecha a aba de subagente aberta e grava a escolha como as outras preferências de tela.
    pub(super) fn choose_side_tab(&mut self, tab: SideTab, window: &mut Window, cx: &mut Context<Self>) {
        if self.selected.is_none() { return };
        self.side.menu = false;
        self.act.active_tab = None;
        self.act.pending_tab = None;
        self.act.tab_error = None;
        if let Some(key) = self.side_key() { self.side.tabs.insert(key, tab); }
        if appearance::get().side_tab != tab { self.apply_appearance(appearance::Appearance { side_tab: tab, ..appearance::get() }, true, cx); }
        if self.side_tab() == SideTab::Files { self.show_tree(true, Some(window), cx); }
        self.sync_activity(cx);
        cx.notify();
    }

    /// O "+" da fileira de abas: mostra o menu de ferramentas (por cima da aba de subagente também), e de novo volta à
    /// aba de antes.
    pub(super) fn toggle_side_menu(&mut self, cx: &mut Context<Self>) {
        self.side.menu = !self.side_menu_shown();
        if self.side.menu { self.act.active_tab = None; }
        self.sync_activity(cx);
        cx.notify();
    }

    /// O botão do cabeçalho: abre o painel já na aba Atividade.
    fn open_activity(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if !self.side.open { self.toggle_side(cx); }
        self.choose_side_tab(SideTab::Activity, window, cx);
    }

    /// Sessão nova: a conta recomeça e o pedido em voo da anterior é descartado.
    pub(super) fn reset_subagent_count(&mut self) {
        self.act.tabs.clear();
        self.act.active_tab = None;
        self.act.pending_tab = None;
        self.act.tab_error = None;
        self.act.count = 0;
        self.act.subs.clear();
        self.act.count_seq += 1;
        self.act.count_busy = false;
        self.act.count_timer = None;
    }

    /// Conta uma vez agora e, enquanto a sessão trabalha, a cada 5 s; parar de trabalhar reconta uma vez. Só depois de a
    /// conversa carregar.
    pub(super) fn restart_subagent_count(&mut self, cx: &mut Context<Self>) {
        if !self.history_installed { return; }
        self.count_subagents();
        self.act.count_timer = (self.chat.state.state == "working").then(|| cx.spawn(async move |this, cx| loop {
            cx.background_executor().timer(COUNT_EVERY).await;
            if this.update(cx, |this, _| this.count_subagents()).is_err() { break; }
        }));
    }

    /// Um pedido por vez: com um em voo, a batida seguinte não pede outro.
    fn count_subagents(&mut self) {
        if self.act.count_busy { return; }
        let (Some(link), Some(key)) = (self.activity_link(), self.selected_key()) else { return };
        self.act.count_busy = true;
        let seq = self.act.count_seq;
        self.runtime.spawn(async move {
            let result = link.api.read(&key.name, &["subagents"], &[], 15).await.map(|value| parse_subs(&value));
            let _ = link.tx.send(Envelope { connection: link.connection, selection: None, payload: Payload::Activity(ActivityReply::Count(key, seq, result)) }).await;
        });
    }

    pub(super) fn receive_activity(&mut self, reply: ActivityReply, cx: &mut Context<Self>) {
        match reply {
            ActivityReply::Count(key, seq, result) => {
                if seq != self.act.count_seq || self.selected_key().as_ref() != Some(&key) { return; }
                self.act.count_busy = false;
                let Ok(subs) = result else {
                    if self.act.pending_tab.take().is_some() { self.act.tab_error = Some(web("atividade_erro_vivo")); cx.notify(); }
                    return;
                };
                let before = self.has_activity();
                self.act.count = subs.len();
                // Redesenha só quando muda quem falhou: a batida de 5 s não refaz a conversa a cada chamada contada.
                let failed_ids = |subs: &[SubRun]| subs.iter().filter(|s| s.failed).map(|s| s.agent_id.clone()).collect::<Vec<_>>();
                let changed = failed_ids(&subs) != failed_ids(&self.act.subs);
                self.act.subs = subs;
                if let Some(request) = self.act.pending_tab.take() { self.resolve_agent_tab(request, cx); }
                if changed { cx.notify(); }
                // Só a presença da aba e do botão depende da conta: o número dela não aparece.
                if self.has_activity() != before { self.sync_activity(cx); cx.notify(); }
            }
            ActivityReply::List(seq, result) => self.act.view.update(cx, |view, cx| view.receive(seq, result, cx)),
            ActivityReply::Detail(seq, result) => self.act.view.update(cx, |view, cx| view.receive_detail(seq, result, cx)),
            ActivityReply::Sent(None, seq, result) => self.act.view.update(cx, |view, cx| view.receive_sent(seq, result, cx)),
            ActivityReply::Sent(Some(id), seq, result) => {
                if let Some(tab) = self.act.tabs.iter().find(|t| t.id == id) { tab.view.update(cx, |view, cx| view.receive_sent(seq, result, cx)); }
            }
            ActivityReply::TabDetail(id, seq, result) => {
                if let Some(tab) = self.act.tabs.iter().find(|t| t.id == id) {
                    let changed = tab.view.update(cx, |view, cx| {
                        let status = |v: &ActivityPanel| (v.opened.as_ref().map(|o| (o.done, o.run.failed, o.run.unreadable)), v.notice.is_some());
                        let before = status(view);
                        view.receive_detail(seq, result, cx);
                        before != status(view)
                    });
                    if changed { self.redraw(super::panes::Area::Side, cx); }
                }
            }
        }
    }

    /// A conversa do subagente segue a Aparência, como a principal.
    pub(super) fn restyle_subagent(&mut self, cx: &mut Context<Self>) {
        let conversation = self.act.view.read(cx).conversation.clone();
        conversation.update(cx, |view, cx| view.restyle(cx));
        for tab in &self.act.tabs {
            let conversation = tab.view.read(cx).conversation.clone();
            conversation.update(cx, |view, cx| view.restyle(cx));
        }
    }

    /// O Agent desta chamada lançou um subagente que falhou: casado pelo `agentId` do resultado ou pelo prompt.
    pub(super) fn agent_failed(&self, call: usize) -> bool {
        self.act.subs.iter().any(|s| s.failed) && agent_failed(&self.conversation.activity.agents, &self.act.subs, call)
    }

    /// A marca da aba Atividade, pintada fora dela e do painel.
    pub(super) fn activity_mark_float(&self, cx: &App) -> AnyElement {
        super::panes::float_marks(self.act.view.read(cx).marks.clone(), super::panes::Area::Side, WORKING_FADE, cx.reduce_motion())
    }

    /// O cartão abre uma aba por identidade do subagente, sem substituir a lista da Atividade.
    pub(super) fn open_agent(&mut self, request: (Option<String>, String), cx: &mut Context<Self>) {
        self.side.open = true;
        self.act.tab_error = None;
        self.act.pending_tab = Some(request);
        self.count_subagents();
        cx.notify();
    }

    fn resolve_agent_tab(&mut self, (prompt, title): (Option<String>, String), cx: &mut Context<Self>) {
        let Some(run) = match_sub(&self.act.subs, prompt.as_deref()).cloned() else {
            self.act.tab_error = Some(web("atividade_agente_nao_achado"));
            cx.notify();
            return;
        };
        let id = if let Some(tab) = self.act.tabs.iter().find(|t| t.agent_id == run.agent_id) { tab.id } else {
            let (Some(key), Some(link)) = (self.selected_key(), self.activity_link()) else { return };
            self.act.tab_seq += 1;
            let id = self.act.tab_seq;
            let view = cx.new(ActivityPanel::new);
            view.update(cx, |view, cx| {
                view.tab_id = Some(id);
                view.key = Some(key);
                view.link = Some(link);
                view.subs = self.act.subs.clone();
                view.set_data(&self.conversation.activity, &self.chat.state.shells, cx);
                view.request_agent(prompt.clone(), title.clone(), cx);
            });
            self.act.tabs.push(SubagentTab { id, agent_id: run.agent_id, title, view, previous: self.act.active_tab });
            id
        };
        self.select_agent_tab(id, cx);
    }

    fn select_agent_tab(&mut self, id: u64, cx: &mut Context<Self>) {
        let Some(tab) = self.act.tabs.iter_mut().find(|t| t.id == id) else { return; };
        if self.act.active_tab != Some(id) { tab.previous = self.act.active_tab; }
        self.act.active_tab = Some(id);
        if let Some(index) = self.act.tabs.iter().position(|t| t.id == id) { self.act.tab_scroll.scroll_to_item(index); }
        self.act.pending_tab = None;
        self.act.tab_error = None;
        self.sync_activity(cx);
        cx.notify();
    }

    fn close_agent_tab(&mut self, id: u64, cx: &mut Context<Self>) {
        let previous = self.act.tabs.iter().find(|t| t.id == id).and_then(|t| t.previous);
        self.act.tabs.retain(|t| t.id != id);
        self.act.active_tab = tab_after_close(self.act.active_tab, id, previous, &self.act.tabs.iter().map(|t| t.id).collect::<Vec<_>>());
        if let Some(index) = self.act.tabs.iter().position(|t| Some(t.id) == self.act.active_tab) { self.act.tab_scroll.scroll_to_item(index); }
        self.act.pending_tab = None;
        self.sync_activity(cx);
        cx.notify();
    }

    pub(super) fn subagent_mark_float(&self, cx: &App) -> AnyElement {
        div().absolute().size_0().child(self.working_mark_float(super::panes::Area::Side, WORKING_FADE, cx.reduce_motion()))
            .when_some(self.act.active_tab.and_then(|id| self.act.tabs.iter().find(|t| t.id == id)), |el, tab| {
                el.child(super::panes::float_marks(tab.view.read(cx).marks.clone(), super::panes::Area::Side, WORKING_FADE, cx.reduce_motion()))
            }).into_any_element()
    }

    pub(super) fn subagent_tab_view(&self) -> Option<AnyElement> {
        let tab = self.act.tabs.iter().find(|t| Some(t.id) == self.act.active_tab)?;
        Some(super::panes::cached_selectable(tab.view.clone().into(), StyleRefinement::default().size_full()))
    }

    pub(super) fn render_subagent_tabs(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let note = self.act.tab_error.clone().or_else(|| self.act.pending_tab.as_ref().map(|_| tr("subagent_loading")));
        if self.act.tabs.is_empty() && note.is_none() { return None; }
        let tabs = self.act.tabs.iter().map(|tab| {
            let id = tab.id;
            let view = tab.view.read(cx);
            let opened = view.opened.as_ref();
            let unavailable = view.notice.is_some() || opened.is_some_and(|o| o.run.unreadable);
            let running = !unavailable && opened.is_some_and(|o| !o.done);
            let failed = opened.is_some_and(|o| o.run.failed);
            let icon = if running { self.working_mark_slot(super::panes::Area::Side, format!("subagent-tab-{id}"), 12., theme::accent()) }
                else { chrome::small_icon(if unavailable { IconName::Info } else if failed { TAB_CROSS } else { IconName::Check }, 12.,
                    if failed || unavailable { theme::warning() } else { theme::success() }).into_any_element() };
            Tab::new().label(tab.title.clone()).prefix(icon)
                .suffix(Button::new(SharedString::from(format!("subagent-tab-close-{id}"))).ghost().xsmall()
                    .icon(TAB_CROSS).accessibility_label(tr("subagent_tab_close").replace("{name}", &tab.title))
                    .on_click(cx.listener(move |this, _, _, cx| { cx.stop_propagation(); this.close_agent_tab(id, cx); })))
        }).collect::<Vec<_>>();
        let ids: Vec<u64> = self.act.tabs.iter().map(|t| t.id).collect();
        Some(div().flex_shrink_0().min_w_0().border_b_1().border_color(theme::border())
            .when(!tabs.is_empty(), |el| el.child(TabBar::new("subagent-tabs").underline().small().menu(true).max_width(px(160.))
                .track_scroll(&self.act.tab_scroll)
                .when_some(self.act.tabs.iter().position(|t| Some(t.id) == self.act.active_tab), |bar, i| bar.selected_index(i)).children(tabs)
                .on_click(cx.listener(move |this, index: &usize, _, cx| {
                    if let Some(id) = ids.get(*index) { this.select_agent_tab(*id, cx); }
                }))))
            .when_some(note, |el, note| el.child(div().px_4().py_2().text_xs().text_color(theme::muted()).child(note)))
            .into_any_element())
    }
}

/// O cartão Agent (só ele) abre a conversa do agente: prompt, que casa com o disco, e o título do detalhe.
pub(super) fn agent_request(call: &ChatEvent) -> Option<(Option<String>, String)> {
    if call.tool_name.as_deref() != Some("Agent") { return None; }
    let text = |key: &str| call.tool_input.as_ref().and_then(|i| i.get(key)).and_then(Value::as_str).map(str::to_owned);
    Some((text("prompt"), text("description").filter(|d| !d.trim().is_empty()).unwrap_or_else(|| web("atividade_subagente"))))
}

impl Hangar {

    /// A aba do painel: Atividade (a view própria) ou nada, e o Contexto segue como era.
    /// Opacidade da aba do painel que acabou de aparecer (o `fade-quick` do kit). As views guardadas dentro dela redesenham
    /// a cada quadro da troca: a cópia guardada ficaria na opacidade do primeiro quadro.
    pub(super) fn side_tab_in(&self, window: &mut Window, cx: &App) -> f32 {
        let key = match self.act.active_tab { Some(id) => SharedString::from(format!("side-tab-in-{id}")),
            None if self.side_menu_shown() => SharedString::from("side-tab-in-menu"),
            None => SharedString::from(format!("side-tab-in-{:?}", self.side_tab())) };
        let shown = crate::motion::enter(key, crate::motion::FADE_QUICK, window, cx);
        if shown < 1. && (self.act.active_tab.is_some() || self.activity_tab()) {
            let views = self.activity_views(cx);
            window.on_next_frame(move |_, cx| for view in views { cx.notify(view); });
        }
        shown
    }

    pub(super) fn activity_view(&self) -> AnyElement {
        super::panes::cached_selectable(self.act.view.clone().into(), StyleRefinement::default().size_full())
    }

    /// A aba Atividade e as views guardadas dentro dela.
    pub(super) fn activity_views(&self, cx: &App) -> Vec<EntityId> {
        let view = self.act.tabs.iter().find(|t| Some(t.id) == self.act.active_tab).map(|t| &t.view).unwrap_or(&self.act.view);
        let mut views = view.read(cx).views();
        views.push(view.entity_id());
        views
    }

    /// Abas "Contexto | Arquivos | Atividade | Git" numa fileira, como o web: Atividade só com atividade e Git só com
    /// repositório; Arquivos e Git pedem a sessão legível. Navegador de aberto pelo menu até fechado no × dele.
    pub(super) fn render_side_title(&self, cx: &mut Context<Self>) -> AnyElement {
        let readable = self.selected.as_ref().is_some_and(|s| s.readable());
        let git = readable && self.selected.as_ref().is_some_and(super::sidebar::has_git);
        let orq = self.selected.as_ref().is_some_and(SessionInfo::orq);
        let current = (self.act.active_tab.is_none() && !self.side_menu_shown()).then(|| self.side_tab());
        let tab = |id: &'static str, label: String, which: SideTab, close: Option<Button>, cx: &mut Context<Self>| {
            let text = div().min_w_0().truncate().text_size(px(12.)).child(label.clone());
            // O × mora dentro do botão da aba, como o das abas de subagente: o clique dele para ali e não escolhe a aba.
            let body = match close {
                Some(close) => div().min_w_0().flex().items_center().gap(px(2.)).child(text).child(close).into_any_element(),
                None => text.into_any_element(),
            };
            let selected = current == Some(which);
            // Desenho da `.aba` do web: texto pequeno, só a cor e o sublinhado marcam a escolhida (negrito mudaria a largura
            // ao trocar). As quatro cabem a partir de ~300 px; mais estreito, cada uma encolhe com reticências, e o piso
            // guarda "Git" inteiro em vez de virar só "…".
            div().h_full().min_w(px(36.)).flex().items_center().border_b_2().border_color(if selected { theme::accent() } else { transparent_black() })
                .child(Button::new(id).custom(ButtonCustomVariant::new(cx).color(transparent_black())
                        .foreground(if selected { theme::text() } else { theme::muted() }).hover(theme::hover()).active(theme::hover()))
                    // O Button não encolhe sozinho (flex_shrink_0 interno): acompanha a aba, que encolhe, e o rótulo
                    // corta com reticências. O tamanho do texto vai no rótulo porque o do Button é sobrescrito.
                    .w_full().h(px(28.)).px(px(8.)).rounded(px(6.))
                    .role(Role::Tab).aria_selected(selected).accessibility_label(label).child(body)
                    .on_click(cx.listener(move |this, _, window, cx| this.choose_side_tab(which, window, cx))))
        };
        let browser = self.side_key().is_some_and(|k| self.side.browser_open.contains(&k)).then(|| Button::new("side-tab-browser-close").ghost().xsmall().icon(TAB_CROSS)
            .tooltip(tr("browser_close")).accessibility_label(tr("browser_close"))
            .on_click(cx.listener(|this, _, window, cx| { cx.stop_propagation(); this.close_browser(window, cx); })));
        div().id("side-tabs").role(Role::TabList).aria_label(tr("side_tabs")).flex_1().h_full().min_w_0().flex().gap(px(2.)).overflow_hidden()
            .child(tab("side-tab-context", if orq { tr_shared("orq_tab_title", &[]) } else { tr("side_context") }, SideTab::Context, None, cx))
            .when(readable, |el| el.child(tab("side-tab-files", web("arq_aba"), SideTab::Files, None, cx)))
            .when(self.has_activity(), |el| el.child(tab("side-tab-activity", self.background_label(), SideTab::Activity, None, cx)))
            .when(git, |el| el.child(tab("side-tab-git", web("git_coluna_abrir"), SideTab::Git, None, cx)))
            .when_some(browser, |el, close| el.child(tab("side-tab-browser", tr("browser"), SideTab::Browser, Some(close), cx)))
            .into_any_element()
    }

    /// "Em segundo plano · N": N = agentes e subagentes rodando, contados como a seção Rodando da aba.
    fn background_label(&self) -> String {
        let activity = &self.conversation.activity;
        let subs = &self.act.subs;
        let now = now_seconds();
        let shown: HashSet<&str> = activity.running_agents().filter_map(|a| match_sub(subs, a.prompt.as_deref())).map(|s| s.agent_id.as_str()).collect();
        let running = activity.running_agents().count()
            + subs.iter().filter(|s| !shown.contains(s.agent_id.as_str()) && sub_status(&activity.agents, subs, s, now) == SubStatus::Running).count();
        if running == 0 { tr("activity_background") } else { format!("{} · {running}", tr("activity_background")) }
    }

    /// O botão Atividade do cabeçalho: só com atividade e com o painel fora de vista (à vista, a entrada é a aba, como o
    /// web, que esconde a barra de cima com o painel aberto); número = tarefas em andamento + agentes e shells rodando;
    /// com agente rodando, cor de destaque e o ícone respirando.
    pub(super) fn render_activity_button(&self, window: &Window, cx: &mut Context<Self>) -> Option<AnyElement> {
        if !self.has_activity() || self.side_shown(window) { return None; }
        let running = self.conversation.running_agents().next().is_some();
        let badge = self.conversation.activity_badge();
        let label = tr("activity_background");
        let color = if running { theme::accent() } else { theme::muted() };
        let icon: AnyElement = if running { chrome::Breathing::new("activity-breath", IconName::ListChecks, px(16.), color).into_any_element() }
            else { Icon::new(IconName::ListChecks).size(px(16.)).text_color(color).into_any_element() };
        Some(div().relative().flex_shrink_0()
            .child(Button::new("activity-open").custom(ButtonCustomVariant::new(cx).color(transparent_black()).foreground(color)
                    .hover(theme::hover()).active(theme::hover()))
                .w(px(28.)).h(px(28.)).rounded(px(6.)).tooltip(label.clone()).accessibility_label(label).child(icon)
                .on_click(cx.listener(|this, _, window, cx| this.open_activity(window, cx))))
            // Selo no canto de fora do botão, sem cobrir as linhas do ícone.
            .when(badge > 0, |el| el.child(div().absolute().top(px(-6.)).right(px(-7.)).min_w(px(14.)).h(px(14.)).px(px(3.))
                .rounded_full().bg(theme::accent()).text_color(gpui::white()).text_size(px(9.5)).font_weight(FontWeight::SEMIBOLD)
                .flex().items_center().justify_center().child(badge.to_string())))
            .into_any_element())
    }
}

#[cfg(test)]
mod tests {
    use super::{AgentRun, SubRun, agent_failed, base_title, interval, match_sub, sub_done, sub_title};

    #[test]
    fn tab_status_and_close_icons_are_embedded() {
        use gpui_kit::AssetSource;
        for icon in [super::TAB_CROSS, super::IconName::Check, super::IconName::Info] {
            assert!(crate::AppAssets.load(icon.path().as_ref()).unwrap().is_some());
        }
    }

    #[test]
    fn closing_a_tab_preserves_a_newer_selection_and_never_restores_a_closed_tab() {
        use super::tab_after_close;
        assert_eq!(tab_after_close(Some(3), 2, Some(1), &[1, 3]), Some(3));
        assert_eq!(tab_after_close(Some(3), 3, Some(2), &[1, 2]), Some(2));
        assert_eq!(tab_after_close(Some(3), 3, Some(2), &[1]), None);
        assert_eq!(tab_after_close(Some(1), 1, None, &[]), None);
        assert_eq!(tab_after_close(None, 1, None, &[2]), None);
    }

    fn parent(id: &str, prompt: &str, agent_id: Option<&str>, running: bool) -> AgentRun {
        AgentRun { call: 0, id: id.into(), description: String::new(), subagent_type: None, model: None, prompt: Some(prompt.into()),
            running, agent_id: agent_id.map(Into::into) }
    }

    #[test]
    fn claude_subagent_ends_with_its_parent_agent_by_id_or_by_a_unique_prompt() {
        let subs = vec![sub("a", "tarefa um"), sub("b", "tarefa dois"), sub("c", "tarefa dois")];
        // Pelo agentId, mesmo com o prompt repetido.
        assert!(sub_done(&[parent("t1", "tarefa dois", Some("b"), false)], &subs, &subs[1]));
        assert!(!sub_done(&[parent("t1", "tarefa dois", Some("b"), true)], &subs, &subs[1]));
        // Pelo prompt só quando um Agent e um subagente casam entre si.
        assert!(sub_done(&[parent("t1", "tarefa um", None, false)], &subs, &subs[0]));
        assert!(!sub_done(&[parent("t1", "tarefa um", None, true)], &subs, &subs[0]));
        assert!(!sub_done(&[parent("t1", "tarefa dois", None, false)], &subs, &subs[1]));
        assert!(!sub_done(&[parent("t1", "tarefa um", None, false), parent("t2", "tarefa um", None, false)], &subs, &subs[0]));
        // Agent que já se sabe de outro subagente não fecha este; o `finished` do backend fecha sozinho.
        assert!(!sub_done(&[parent("t1", "tarefa um", Some("z"), false)], &subs, &subs[0]));
        assert!(sub_done(&[], &subs, &SubRun { finished: true, ..sub("k", "kimi") }));
        assert!(sub_done(&[], &subs, &SubRun { failed: true, ..sub("f", "falhou") }));
    }

    #[test]
    fn agent_card_fails_only_for_its_own_subagent() {
        let failed = vec![SubRun { failed: true, ..sub("f", "rode a suíte") }];
        let at = |call, prompt: &str, id: Option<&str>| AgentRun { call, ..parent("t", prompt, id, false) };
        assert!(agent_failed(&[at(1, "rode a suíte", None)], &failed, 1));
        assert!(agent_failed(&[at(1, "outra coisa", Some("f"))], &failed, 1));
        // O agentId de outro subagente vence o prompt igual.
        assert!(!agent_failed(&[at(1, "rode a suíte", Some("g"))], &failed, 1));
        // Prompt repetido em dois Agent: nenhum dos dois afirma a falha.
        assert!(!agent_failed(&[at(1, "rode a suíte", None), at(2, "rode a suíte", None)], &failed, 1));
        assert!(!agent_failed(&[at(1, "outra coisa", None)], &failed, 1));
        // Subagente que já tem dono pelo agentId não é casado pelo prompt de outro Agent.
        let both = vec![SubRun { failed: true, ..sub("f", "rode a suíte") }, sub("g", "rode a suíte")];
        let agents = [at(1, "rode a suíte", Some("f")), at(2, "rode a suíte", None)];
        assert!(agent_failed(&agents, &both, 1));
        assert!(!agent_failed(&agents, &both, 2));
        // Dois subagentes sem dono com o mesmo prompt: ambíguo, não afirma.
        assert!(!agent_failed(&[at(1, "rode a suíte", None)], &both, 1));
    }

    fn sub(id: &str, prompt: &str) -> SubRun {
        SubRun { agent_id: id.into(), agent_type: None, prompt: Some(prompt.into()), calls: 0, last_tool: None, finished: false, unreadable: false, tools: Vec::new(), failed: false, started: None,
            state: None, ended: None, updated: None, can_message: false, message_blocked: None }
    }

    #[test]
    fn server_state_wins_and_a_stale_orphan_without_state_counts_as_finished() {
        use super::{SubStatus, sub_status};
        let now = 10_000.;
        let with = |state: Option<&str>, ended: Option<f64>, updated: Option<f64>| SubRun {
            state: state.map(Into::into), ended, updated, ..sub("a", "tarefa um") };
        let running_parent = [parent("t1", "tarefa um", Some("a"), true)];
        // `state` do servidor decide, mesmo contra o Agent do pai.
        assert_eq!(sub_status(&running_parent, &[], &with(Some("finished"), Some(9_000.), Some(9_500.)), now), SubStatus::Finished(Some(9_000.)));
        assert_eq!(sub_status(&running_parent, &[], &with(Some("failed"), None, Some(9_500.)), now), SubStatus::Failed(Some(9_500.)));
        assert_eq!(sub_status(&[parent("t1", "tarefa um", Some("a"), false)], &[], &with(Some("running"), None, Some(1.)), now), SubStatus::Running);
        // Sem `state`, sem Agent do pai e parado há mais de 10 min: terminou na última escrita.
        assert_eq!(sub_status(&[], &[], &with(None, None, Some(now - 601.)), now), SubStatus::Finished(Some(now - 601.)));
        assert_eq!(sub_status(&[], &[], &with(None, None, Some(now - 60.)), now), SubStatus::Running);
        assert_eq!(sub_status(&[], &[], &with(None, None, None), now), SubStatus::Running);
        // Com o Agent do pai rodando, o registro parado não vira fim.
        assert_eq!(sub_status(&running_parent, &[], &with(None, None, Some(now - 601.)), now), SubStatus::Running);
        assert_eq!(sub_status(&[parent("t1", "tarefa um", None, true)], &[with(None, None, Some(1.))], &with(None, None, Some(1.)), now), SubStatus::Running);
    }

    #[test]
    fn finished_before_today_go_under_older() {
        use super::older;
        assert!(older(Some(99.), 100.));
        assert!(!older(Some(100.), 100.) && !older(None, 100.));
    }

    #[test]
    fn the_message_goes_as_trimmed_text_and_the_parse_reads_the_new_fields() {
        use super::{message_body, parse_sub};
        assert_eq!(message_body("  oi\n"), serde_json::json!({"text": "oi"}));
        let run = parse_sub(&serde_json::json!({"agentId": "a", "state": "failed", "endedAt": "2026-10-13T10:00:00Z",
            "updatedAt": "2026-10-13T09:00:00Z", "canMessage": false, "messageBlocked": "erro_subagente_mensagem_sem_terminal"})).unwrap();
        assert_eq!((run.state.as_deref(), run.can_message, run.message_blocked.as_deref()), (Some("failed"), false, Some("erro_subagente_mensagem_sem_terminal")));
        assert_eq!((run.ended, run.updated), (Some(1_791_885_600.), Some(1_791_882_000.)));
        assert!(parse_sub(&serde_json::json!({"agentId": "b", "canMessage": true})).unwrap().can_message);
    }

    #[test]
    fn a_blocked_composer_explains_itself_in_the_screen_language() {
        use super::blocked_text;
        assert_eq!(blocked_text(Some("erro_subagente_mensagem_sem_terminal")),
            crate::i18n::tr_web("erro_subagente_mensagem_sem_terminal", &Default::default()).unwrap());
        assert_eq!(blocked_text(None), crate::i18n::tr("subagent_message_unavailable"));
        assert_eq!(blocked_text(Some("codigo_novo")), crate::i18n::tr("subagent_message_unavailable"));
    }

    #[test]
    fn subagents_match_by_whole_prompt_then_by_its_head() {
        let long = "x".repeat(500);
        let subs = vec![sub("a", "Pesquise  na web\nfontes"), sub("b", &format!("{long} fim")), sub("c", "outro")];
        assert_eq!(match_sub(&subs, Some("pesquise na web fontes")).map(|s| s.agent_id.as_str()), Some("a"));
        assert_eq!(match_sub(&subs, Some(&format!("{long} diferente"))).map(|s| s.agent_id.as_str()), Some("b"));
        assert_eq!(match_sub(&subs, Some("nada")), None);
        assert_eq!(match_sub(&subs, None), None);
    }

    #[test]
    fn titles_skip_skill_header_and_repeat_with_the_id() {
        assert_eq!(base_title(&sub("a", "Base directory for this skill: /x\n# Título\n\nFaça isto")), "Faça isto");
        assert_eq!(base_title(&sub("a", "")), "a");
        let subs = vec![sub("a", "Mesmo começo\nitem 1"), sub("b", "Mesmo começo\nitem 2"), sub("c", "Outro")];
        assert_eq!(sub_title(&subs, &subs[0]), "Mesmo começo · a");
        assert_eq!(sub_title(&subs, &subs[2]), "Outro");
        assert_eq!((interval(5.), interval(125.), interval(7200.), interval(90_000.)), ("1 min".into(), "2 min".into(), "2 h".into(), "1 d".into()));
    }
}
