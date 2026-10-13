use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::sync::{broadcast, oneshot, watch};

use crate::interactions::{InteractionBinding, InteractionKind, InteractionStore, InteractionTarget, plugin_target, plugin_semantic};
use super::{PluginMode, PluginReply, PluginRequest, ServiceError};

const POLL: Duration = Duration::from_secs(25);
const NO_POLL: Duration = Duration::from_secs(5);
const ALIVE: Duration = Duration::from_secs(35);
const HOOK_ALIVE: Duration = Duration::from_secs(2);
const CONFIRM: Duration = Duration::from_secs(5);
const PUBLISH: Duration = Duration::from_secs(30);
const FOCUS: Duration = Duration::from_secs(1);

fn question_visible(interrupted: bool, poll_open: bool, age: Duration) -> bool {
    !interrupted && age <= ALIVE && (poll_open || age <= NO_POLL)
}

#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct PluginQuestion {
    pub id: String,
    pub interaction_id: String,
    pub questions: Value,
    pub tool: Option<String>,
    #[serde(rename = "resumo")]
    pub summary: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct Receipt {
    pub publication_id: String,
    pub generation: u64,
    pub session_id: String,
}

#[derive(Clone, Debug, Deserialize)]
pub struct Ask {
    pub id: String,
    pub questions: Option<Vec<Value>>,
    pub tool: Option<String>,
    pub janela_ms: Option<i64>,
    #[serde(rename = "resumo")]
    pub summary: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct Pull {
    #[serde(default)] pub instance: String,
    #[serde(default)] pub modos: Vec<String>,
    pub estado: Option<String>,
    pub session_id: Option<String>,
}

/// Na dúvida sobre terminal ou presença, a permissão continua no CLI.
#[derive(Clone, Copy, Debug)]
pub struct PermissionGate {
    pub app_present: bool,
    pub terminal_attached: bool,
    pub mode_without_dialog: bool,
}
impl PermissionGate {
    fn hold(self) -> bool { self.app_present && !self.terminal_attached && !self.mode_without_dialog }
}

struct Waiter { id: u64, sender: Option<oneshot::Sender<Value>> }
impl Waiter {
    fn send(&mut self, value: Value) -> bool { self.sender.take().is_some_and(|sender| sender.send(value).is_ok()) }
}
struct Owner { instance: String, modes: HashSet<String>, seen: Instant }
struct Publication {
    receipt: Receipt,
    mode: PluginMode,
    result: watch::Sender<Option<PluginReply>>,
    handed: bool,
    poll_id: u64,
    deadline: Instant,
}
struct Answer {
    receipt: Option<Receipt>,
    payload: Value,
    result: watch::Sender<Option<PluginReply>>,
    handed: bool,
    poll_id: Option<u64>,
    deadline: Instant,
}
struct Question {
    public: PluginQuestion,
    seen: Instant,
    interrupted: Option<Instant>,
    expired: bool,
    waiter: Option<Waiter>,
    answer: Option<Answer>,
}
struct Session {
    binding: InteractionBinding,
    owner: Option<Owner>,
    waiter: Option<Waiter>,
    heartbeat: Option<Instant>,
    publication: Option<Publication>,
    questions: BTreeMap<String, Question>,
    closed: HashMap<String, (String, Option<Receipt>)>,
    state: Option<(Instant, String, Option<String>)>,
    suggestion: String,
    plan: Option<PlanNotice>,
}

/// Aviso do `ExitPlanMode`: o hook não segura, o diálogo do terminal é que responde.
#[derive(Clone, Debug, PartialEq)]
pub struct PlanNotice { pub tool_use_id: String, pub plan: String, pub path: Option<String> }
#[derive(Default)]
struct Memory { sessions: HashMap<String, Session>, next_waiter: u64, stopping: bool }

pub struct Store {
    interactions: Arc<InteractionStore>,
    memory: Mutex<Memory>,
    events: broadcast::Sender<String>,
}

fn target(id: &str) -> InteractionTarget {
    plugin_target(if id.starts_with("perm:") { InteractionKind::Approval } else { InteractionKind::Question }, id)
}
fn unavailable() -> ServiceError { ServiceError("plugin_store_unavailable") }
fn changed() -> ServiceError { ServiceError("erro_interacao_desatualizada") }
fn session<'a>(memory: &'a mut Memory, binding: &InteractionBinding) -> Result<&'a mut Session, ServiceError> {
    memory.sessions.get_mut(&binding.key).filter(|s| s.binding == *binding).ok_or_else(changed)
}
fn close_question(interactions: &InteractionStore, binding: &InteractionBinding, id: &str) -> Result<(), ServiceError> {
    interactions.observe(binding, &target(id), None).map(|_| ()).map_err(|error| ServiceError(error.code()))
}
fn finish_question(mut question: Question, reply: PluginReply) {
    if let Some(mut waiter) = question.waiter.take() { let _ = waiter.send(json!({"answers":null})); }
    if let Some(answer) = question.answer { answer.result.send_replace(Some(reply)); }
}
fn visible_questions(interactions: &InteractionStore, s: &mut Session, now: Instant) -> Result<Vec<PluginQuestion>, ServiceError> {
    let mut out = Vec::new();
    for q in s.questions.values_mut() {
        if question_visible(q.interrupted.is_some() || q.expired, q.waiter.is_some(), now.saturating_duration_since(q.seen)) {
            out.push(q.public.clone());
        } else {
            close_question(interactions, &s.binding, &q.public.id)?;
            q.expired = true;
        }
    }
    Ok(out)
}
fn discard_unhanded_answer(question: &mut Question, now: Instant) {
    if question.answer.as_ref().is_some_and(|a| !a.handed && a.poll_id.is_none() && now >= a.deadline)
        && let Some(answer) = question.answer.take() {
        answer.result.send_replace(Some(PluginReply::NotWritten));
    }
}
fn finish_session(session: Session) {
    if let Some(mut waiter) = session.waiter { let _ = waiter.send(json!({"text":null})); }
    if let Some(publication) = session.publication {
        publication.result.send_replace(Some(if publication.handed { PluginReply::Unknown } else { PluginReply::NotWritten }));
    }
    for (_, question) in session.questions { finish_question(question, PluginReply::Unknown); }
}

impl Store {
    pub fn new(interactions: Arc<InteractionStore>) -> Self {
        Self { interactions, memory: Mutex::new(Memory::default()), events: broadcast::channel(256).0 }
    }
    pub fn interactions(&self) -> &Arc<InteractionStore> { &self.interactions }
    pub fn subscribe(&self) -> broadcast::Receiver<String> { self.events.subscribe() }
    fn notify(&self, key: &str) { let _ = self.events.send(key.to_owned()); }

    /// O runtime já ativou esta vida na Arc; isto só liga a memória do plugin.
    pub fn bind(&self, binding: &InteractionBinding) -> Result<(), ServiceError> {
        let mut memory = self.memory.lock().map_err(|_| unavailable())?;
        if memory.sessions.get(&binding.key).is_some_and(|s| s.binding == *binding) { return Ok(()); }
        if let Some(old) = memory.sessions.get(&binding.key) {
            self.interactions.forget_binding(&old.binding).map_err(|error| ServiceError(error.code()))?;
        }
        if let Some(old) = memory.sessions.remove(&binding.key) { finish_session(old); }
        memory.sessions.insert(binding.key.clone(), Session { binding: binding.clone(), owner: None, waiter: None,
            heartbeat: None, publication: None, questions: BTreeMap::new(), closed: HashMap::new(), state: None, suggestion: String::new(), plan: None });
        self.notify(&binding.key);
        Ok(())
    }

    pub fn forget(&self, key: &str) -> Result<(), ServiceError> {
        let mut memory = self.memory.lock().map_err(|_| unavailable())?;
        if let Some(old) = memory.sessions.get(key) {
            self.interactions.forget_binding(&old.binding).map_err(|error| ServiceError(error.code()))?;
        }
        if let Some(old) = memory.sessions.remove(key) { finish_session(old); }
        self.notify(key);
        Ok(())
    }

    pub fn stop(&self) -> Result<(), ServiceError> {
        let mut memory = self.memory.lock().map_err(|_| unavailable())?;
        memory.stopping = true;
        for session in memory.sessions.values_mut() {
            if let Some(mut waiter) = session.waiter.take() { let _ = waiter.send(json!({"text":null})); }
            for question in session.questions.values_mut() {
                if let Some(mut waiter) = question.waiter.take() { let _ = waiter.send(json!({"answers":null})); }
            }
        }
        Ok(())
    }

    pub fn begin_pull(&self, binding: &InteractionBinding, pull: Pull, now: Instant) -> Result<Poll<'_>, ServiceError> {
        if pull.session_id.as_deref() != Some(binding.conversation.as_str()) { return Err(ServiceError("plugin_conversation_mismatch")); }
        let mut memory = self.memory.lock().map_err(|_| unavailable())?;
        if memory.stopping { return Ok(Poll::ready(json!({"text":null}))); }
        memory.next_waiter += 1;
        let id = memory.next_waiter;
        let s = session(&mut memory, binding)?;
        if s.owner.as_ref().is_some_and(|owner| owner.instance != pull.instance && now.saturating_duration_since(owner.seen) < ALIVE) {
            return Err(ServiceError("plugin_instance_conflict"));
        }
        if s.owner.as_ref().is_none_or(|owner| owner.instance != pull.instance)
            && s.publication.as_ref().is_some_and(|p| now >= p.deadline) {
            s.publication = None;
        }
        let modes = if pull.modos.is_empty() { HashSet::from(["fill".to_owned()]) } else { pull.modos.into_iter().collect() };
        s.owner = Some(Owner { instance: pull.instance, modes, seen: now });
        if s.state.is_none() { s.state = pull.estado.map(|state| (now, state, None)); }
        let (sender, receiver) = oneshot::channel();
        s.waiter = Some(Waiter { id, sender: Some(sender) });
        s.heartbeat = Some(now);
        self.notify(&binding.key);
        Ok(Poll { guard: Some(PollGuard { store: self, binding: binding.clone(), request_id: None, id, handed: false }),
            receiver: Some(receiver), ready: None, timeout: POLL })
    }

    pub fn begin_ask(&self, binding: &InteractionBinding, ask: Ask, gate: PermissionGate, now: Instant) -> Result<Poll<'_>, ServiceError> {
        let mut memory = self.memory.lock().map_err(|_| unavailable())?;
        if memory.stopping { return Ok(Poll::ready(json!({"answers":null}))); }
        memory.next_waiter += 1;
        let poll_id = memory.next_waiter;
        let s = session(&mut memory, binding)?;
        if ask.id.starts_with("perm:") && !gate.hold() {
            close_question(&self.interactions, binding, &ask.id)?;
            if let Some(old) = s.questions.remove(&ask.id) {
                let reply = if old.answer.as_ref().is_some_and(|a| a.handed || a.poll_id.is_some()) { PluginReply::Unknown } else { PluginReply::NotWritten };
                finish_question(old, reply);
            }
            self.notify(&binding.key);
            return Ok(Poll::ready(json!({"soltar":true})));
        }
        let semantic = plugin_semantic(&json!({"questions":ask.questions.clone().unwrap_or_default(),"tool":ask.tool,"resumo":ask.summary}));
        let interrupted = s.questions.get(&ask.id).and_then(|q| q.interrupted);
        if interrupted.is_some_and(|at| now.saturating_duration_since(at) <= HOOK_ALIVE) {
            return Ok(Poll::ready(json!({"answers":null})));
        }
        if s.questions.get(&ask.id).is_some_and(|q| !question_visible(q.interrupted.is_some() || q.expired, q.waiter.is_some(), now.saturating_duration_since(q.seen))) {
            close_question(&self.interactions, binding, &ask.id)?;
        }
        let interaction_id = self.interactions.observe(binding, &target(&ask.id), Some(semantic.clone()))
            .map_err(|error| ServiceError(error.code()))?.ok_or_else(unavailable)?;
        let replace = s.questions.get(&ask.id).is_none_or(|q| q.public.interaction_id != interaction_id);
        if replace {
            if let Some(old) = s.questions.remove(&ask.id) { finish_question(old, PluginReply::Unknown); }
            s.closed.remove(&ask.id);
            s.questions.insert(ask.id.clone(), Question {
                public: PluginQuestion { id: ask.id.clone(), interaction_id, questions: semantic["questions"].clone(), tool: ask.tool, summary: ask.summary },
                seen: now, interrupted: None, expired: false, waiter: None, answer: None,
            });
        }
        let q = s.questions.get_mut(&ask.id).ok_or_else(unavailable)?;
        discard_unhanded_answer(q, now);
        q.seen = now;
        q.interrupted = None;
        self.notify(&binding.key);
        if let Some(answer) = q.answer.as_mut().filter(|a| !a.handed && a.poll_id.is_none() && now < a.deadline) {
            answer.handed = true;
            return Ok(Poll::ready(answer.payload.clone()));
        }
        let (sender, receiver) = oneshot::channel();
        q.waiter = Some(Waiter { id: poll_id, sender: Some(sender) });
        let timeout = match ask.janela_ms { Some(ms) if ms != 0 => Duration::from_millis(ms.max(0) as u64).min(POLL), _ => POLL };
        Ok(Poll { guard: Some(PollGuard { store: self, binding: binding.clone(), request_id: Some(ask.id), id: poll_id, handed: false }),
            receiver: Some(receiver), ready: None, timeout })
    }

    pub fn pending_all(&self, binding: &InteractionBinding, now: Instant) -> Result<Vec<PluginQuestion>, ServiceError> {
        let mut memory = self.memory.lock().map_err(|_| unavailable())?;
        let s = session(&mut memory, binding)?;
        visible_questions(&self.interactions, s, now)
    }

    /// O consumidor singular não escolhe arbitrariamente entre dois alvos.
    pub fn pending(&self, binding: &InteractionBinding, now: Instant) -> Option<PluginQuestion> {
        match self.pending_all(binding, now) {
            Ok(mut questions) if questions.len() == 1 => questions.pop(),
            Ok(_) => None,
            Err(error) => { tracing::warn!(code = error.0, "pergunta do plugin indisponível"); None }
        }
    }

    pub fn interrupt(&self, binding: &InteractionBinding, request_id: &str) -> Result<(), ServiceError> {
        let mut memory = self.memory.lock().map_err(|_| unavailable())?;
        let s = session(&mut memory, binding)?;
        close_question(&self.interactions, binding, request_id)?;
        if let Some(q) = s.questions.get_mut(request_id) {
            q.interrupted = Some(Instant::now());
            if let Some(mut waiter) = q.waiter.take() { let _ = waiter.send(json!({"answers":null})); }
            if let Some(answer) = q.answer.take() { answer.result.send_replace(Some(PluginReply::Unknown)); }
        }
        self.notify(&binding.key);
        Ok(())
    }

    /// Corpo completo do hook: `{"permitir":true/false}`, `{"answers":{"Escolha":"A"}}`
    /// ou `{"deny":"motivo"}`. O recibo é acrescentado no topo, sem envolver o corpo em `answers`.
    pub async fn answer(&self, binding: &InteractionBinding, request_id: &str, interaction_id: &str, body: Value,
        receipt: Option<Receipt>) -> Result<PluginReply, ServiceError> {
        let (result, deadline) = {
            let mut memory = self.memory.lock().map_err(|_| unavailable())?;
            let s = session(&mut memory, binding)?;
            if let Some((closed_id, closed_receipt)) = s.closed.get(request_id)
                && closed_id == interaction_id && closed_receipt == &receipt { return Ok(PluginReply::Accepted); }
            let expected = self.interactions.validate(binding, Some(interaction_id)).map_err(|e| ServiceError(e.code()))?;
            if expected != target(request_id) { return Err(changed()); }
            if receipt.as_ref().is_some_and(|r| r.generation != binding.generation || r.session_id != binding.conversation) { return Err(changed()); }
            let q = s.questions.get_mut(request_id).ok_or_else(changed)?;
            let now = Instant::now();
            if !question_visible(q.interrupted.is_some() || q.expired, q.waiter.is_some(), now.saturating_duration_since(q.seen)) {
                close_question(&self.interactions, binding, request_id)?;
                q.expired = true;
                return Err(changed());
            }
            discard_unhanded_answer(q, now);
            if let Some(answer) = &q.answer {
                if answer.receipt != receipt { return Err(ServiceError("plugin_publication_conflict")); }
                (answer.result.subscribe(), answer.deadline)
            } else {
                if !body.is_object() { return Err(ServiceError("plugin_answer_body_invalid")); }
                let mut payload = body;
                if let Some(r) = &receipt {
                    payload["publication_id"] = json!(r.publication_id);
                    payload["generation"] = json!(r.generation);
                    payload["session_id"] = json!(r.session_id);
                }
                let (result, rx) = watch::channel(None);
                let deadline = now + CONFIRM;
                let mut answer = Answer { receipt, payload, result, deadline, handed: false, poll_id: None };
                if let Some(waiter) = q.waiter.as_mut() {
                    if waiter.send(answer.payload.clone()) { answer.poll_id = Some(waiter.id); }
                }
                q.answer = Some(answer);
                (rx, deadline)
            }
        };
        Ok(wait_result(result, deadline).await)
    }

    pub fn finish(&self, binding: &InteractionBinding, request_id: &str, winner: &str, receipt: Option<Receipt>) -> Result<(), ServiceError> {
        let mut memory = self.memory.lock().map_err(|_| unavailable())?;
        let s = session(&mut memory, binding)?;
        let Some(q) = s.questions.get(request_id) else { return Ok(()); };
        match &receipt {
            Some(r) if r.generation != binding.generation || r.session_id != binding.conversation
                || q.answer.as_ref().is_none_or(|a| a.receipt.as_ref() != Some(r)) => return Ok(()),
            // Sem recibo, o hook legado só identifica o pedido; não confirma uma publicação com recibo.
            None if q.answer.as_ref().is_some_and(|a| a.receipt.is_some()) => return Ok(()),
            _ => {},
        }
        close_question(&self.interactions, binding, request_id)?;
        let q = s.questions.remove(request_id).ok_or_else(changed)?;
        let accepted = winner == "app" && q.answer.as_ref().is_some_and(|a| a.handed);
        if accepted { s.closed.insert(request_id.into(), (q.public.interaction_id.clone(), receipt)); }
        finish_question(q, if accepted { PluginReply::Accepted } else { PluginReply::Unknown });
        self.notify(&binding.key);
        Ok(())
    }

    pub async fn publish(&self, binding: &InteractionBinding, request: PluginRequest) -> Result<PluginReply, ServiceError> {
        let (result, deadline) = {
            let mut memory = self.memory.lock().map_err(|_| unavailable())?;
            let stopping = memory.stopping;
            let s = session(&mut memory, binding)?;
            if s.publication.as_ref().is_some_and(|p| p.mode == PluginMode::Focus && Instant::now() >= p.deadline) {
                s.publication = None;
            }
            if let Some(p) = &s.publication {
                if p.receipt.publication_id == request.id { (p.result.subscribe(), p.deadline) }
                else { return Ok(PluginReply::Unknown); }
            } else {
                if stopping || s.waiter.is_none() { return Ok(PluginReply::Unavailable); }
                if s.owner.as_ref().is_none_or(|o| !o.modes.contains("receipt_v2") || request.mode == PluginMode::Focus && !o.modes.contains("focus")) {
                    return Ok(PluginReply::NotWritten);
                }
                let receipt = Receipt { publication_id: request.id, generation: binding.generation, session_id: binding.conversation.clone() };
                let payload = json!({"text":request.text,"modo":request.mode,"publication_id":receipt.publication_id,
                    "generation":receipt.generation,"session_id":receipt.session_id});
                let deadline = Instant::now() + if request.mode == PluginMode::Focus { FOCUS } else { PUBLISH };
                let (result, rx) = watch::channel(None);
                let waiter = s.waiter.as_mut().ok_or_else(unavailable)?;
                if !waiter.send(payload) { return Ok(PluginReply::NotWritten); }
                s.publication = Some(Publication { receipt, mode: request.mode, result, deadline, handed: false, poll_id: waiter.id });
                (rx, deadline)
            }
        };
        let reply = wait_result(result, deadline).await;
        let mut memory = self.memory.lock().map_err(|_| unavailable())?;
        if let Ok(s) = session(&mut memory, binding)
            && s.publication.as_ref().is_some_and(|p| p.deadline == deadline && p.mode == PluginMode::Focus) {
            s.publication = None;
        }
        Ok(reply)
    }

    pub fn acknowledge(&self, binding: &InteractionBinding, receipt: Option<&Receipt>, mode: PluginMode, ok: bool) -> Result<(), ServiceError> {
        let mut memory = self.memory.lock().map_err(|_| unavailable())?;
        let s = session(&mut memory, binding)?;
        if let Some(p) = &s.publication {
            let expected_mode = if p.mode == PluginMode::Focus { PluginMode::Fill } else { p.mode.clone() };
            if receipt == Some(&p.receipt) && expected_mode == mode && p.handed {
                p.result.send_replace(Some(if !ok { PluginReply::Unknown } else if mode == PluginMode::Fill { PluginReply::Filled } else { PluginReply::Accepted }));
                s.publication = None;
            }
        }
        Ok(())
    }

    pub fn waiting(&self, binding: &InteractionBinding) -> Result<bool, ServiceError> {
        let mut memory = self.memory.lock().map_err(|_| unavailable())?;
        Ok(session(&mut memory, binding)?.waiter.is_some())
    }
    pub fn declared_modes(&self, binding: &InteractionBinding) -> Result<HashSet<String>, ServiceError> {
        let mut memory = self.memory.lock().map_err(|_| unavailable())?;
        Ok(session(&mut memory, binding)?.owner.as_ref().map(|o| o.modes.clone()).unwrap_or_default())
    }
    pub fn alive(&self, binding: &InteractionBinding, now: Instant) -> Result<bool, ServiceError> {
        let mut memory = self.memory.lock().map_err(|_| unavailable())?;
        let s = session(&mut memory, binding)?;
        Ok(s.waiter.is_some() || s.heartbeat.is_some_and(|at| now.saturating_duration_since(at) < ALIVE))
    }
    pub fn recent_state(&self, binding: &InteractionBinding, now: Instant) -> Result<Option<(String, Option<String>)>, ServiceError> {
        let mut memory = self.memory.lock().map_err(|_| unavailable())?;
        let s = session(&mut memory, binding)?;
        Ok(s.state.as_ref().filter(|(at, _, _)| s.waiter.is_some() || now.saturating_duration_since(*at) <= Duration::from_secs(90))
            .map(|(_, state, reason)| (state.clone(), reason.clone())))
    }

    pub fn record_state(&self, binding: &InteractionBinding, state: String, reason: Option<String>, now: Instant) -> Result<(), ServiceError> {
        let mut memory = self.memory.lock().map_err(|_| unavailable())?;
        let s = session(&mut memory, binding)?;
        if state == "working" { s.suggestion.clear(); }
        s.state = Some((now, state, reason));
        self.notify(&binding.key);
        Ok(())
    }
    pub fn suggest(&self, binding: &InteractionBinding, text: String, shown: bool) -> Result<(), ServiceError> {
        let mut memory = self.memory.lock().map_err(|_| unavailable())?;
        session(&mut memory, binding)?.suggestion = if shown { text } else { String::new() };
        self.notify(&binding.key);
        Ok(())
    }
    pub fn notice_plan(&self, binding: &InteractionBinding, tool_use_id: String, plan: String, path: Option<String>) -> Result<(), ServiceError> {
        if tool_use_id.is_empty() { return Err(ServiceError("plugin_body_invalid")); }
        let mut memory = self.memory.lock().map_err(|_| unavailable())?;
        session(&mut memory, binding)?.plan = Some(PlanNotice { tool_use_id, plan, path });
        self.notify(&binding.key);
        Ok(())
    }
    pub fn plan_notice(&self, binding: &InteractionBinding) -> Result<Option<PlanNotice>, ServiceError> {
        let mut memory = self.memory.lock().map_err(|_| unavailable())?;
        Ok(session(&mut memory, binding)?.plan.clone())
    }
    /// Só o aviso da mesma chamada sai: um mais novo que chegou no meio fica.
    pub fn drop_plan(&self, binding: &InteractionBinding, tool_use_id: &str) -> Result<(), ServiceError> {
        let mut memory = self.memory.lock().map_err(|_| unavailable())?;
        let s = session(&mut memory, binding)?;
        if s.plan.as_ref().is_some_and(|p| p.tool_use_id == tool_use_id) { s.plan = None; self.notify(&binding.key); }
        Ok(())
    }
    pub fn facts(&self, binding: &InteractionBinding, now: Instant) -> Result<Value, ServiceError> {
        let mut memory = self.memory.lock().map_err(|_| unavailable())?;
        let s = session(&mut memory, binding)?;
        let questions = visible_questions(&self.interactions, s, now)?;
        let age = |at| now.saturating_duration_since(at).as_millis().min(u64::MAX as u128) as u64;
        let question = if questions.len() == 1 { questions.first().map(|q| {
            let mut value = serde_json::to_value(q).expect("campos serializáveis");
            value["seen_age_ms"] = json!(age(s.questions[&q.id].seen)); value
        }) } else { None };
        Ok(json!({"plugin_state":s.state.as_ref().map(|(at,state,reason)| json!({"state":state,"reason":reason,"age_ms":age(*at)})),
            "waiter_open":s.waiter.is_some(),"heartbeat_age_ms":s.heartbeat.map(age),"question":question,
            "questions":questions,"suggestion":s.suggestion,
            "owner_instance":s.owner.as_ref().map(|owner| &owner.instance),
            "declared_modes":s.owner.as_ref().map(|owner| { let mut modes:Vec<_>=owner.modes.iter().collect();modes.sort();modes }).unwrap_or_default()}))
    }
}

async fn wait_result(mut result: watch::Receiver<Option<PluginReply>>, deadline: Instant) -> PluginReply {
    loop {
        if let Some(reply) = result.borrow().clone() { return reply; }
        match tokio::time::timeout_at(deadline.into(), result.changed()).await {
            Ok(Ok(())) => {},
            _ => return result.borrow().clone().unwrap_or(PluginReply::Unknown),
        }
    }
}

/// A guarda acompanha a conexão: um poll antigo nunca remove a espera que o substituiu.
pub struct Poll<'a> {
    guard: Option<PollGuard<'a>>,
    receiver: Option<oneshot::Receiver<Value>>,
    ready: Option<Value>,
    timeout: Duration,
}
impl Poll<'_> {
    fn ready(value: Value) -> Self { Self { guard: None, receiver: None, ready: Some(value), timeout: Duration::ZERO } }
    pub async fn wait(mut self) -> Value {
        if let Some(value) = self.ready.take() { return value; }
        let empty = if self.guard.as_ref().is_some_and(|g| g.request_id.is_some()) { json!({"answers":null}) } else { json!({"text":null}) };
        let Some(receiver) = self.receiver.take() else { return empty; };
        match tokio::time::timeout(self.timeout, receiver).await {
            Ok(Ok(value)) => {
                if let Some(guard) = &mut self.guard { guard.handed = true; }
                value
            },
            _ => empty,
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::FutureExt;

    fn binding() -> InteractionBinding { InteractionBinding { key: "key".into(), conversation: "sid".into(), generation: 2 } }
    fn setup() -> (Store, InteractionBinding) {
        let binding = binding();
        let store = Store::new(Arc::new(InteractionStore::default()));
        store.interactions.bind(&binding).unwrap();
        store.bind(&binding).unwrap();
        (store, binding)
    }
    fn gate() -> PermissionGate { PermissionGate { app_present: true, terminal_attached: false, mode_without_dialog: false } }
    fn ask(id: &str) -> Ask { Ask { id: id.into(), questions: Some(vec![json!({"question":"Escolha","options":["A","B"]})]), tool: None, janela_ms: None, summary: None } }
    fn pull(instance: &str) -> Pull { Pull { instance: instance.into(), modos: vec!["fill".into(),"user".into(),"focus".into(),"receipt_v2".into()], estado: Some("idle".into()), session_id: Some("sid".into()) } }
    fn receipt() -> Receipt { Receipt { publication_id: "publication-1".into(), generation: 2, session_id: "sid".into() } }
    fn request(mode: PluginMode) -> PluginRequest { PluginRequest { id: "publication-1".into(), text: "teste".into(), mode } }

    #[test]
    fn conversation_held_plugin_memory_cannot_activate_the_public_identity() {
        let binding = binding();
        let store = Store::new(Arc::new(InteractionStore::default()));
        store.bind(&binding).unwrap();
        assert_eq!(store.begin_ask(&binding, ask("q"), gate(), Instant::now()).err().unwrap().0, "erro_interacao_indisponivel");
        store.interactions.bind(&binding).unwrap();
        let poll = store.begin_ask(&binding, ask("q"), gate(), Instant::now()).unwrap();
        assert!(store.pending(&binding, Instant::now()).is_some());
        drop(poll);
    }

    #[test]
    fn conversation_held_question_expires_without_poll_and_on_interrupt() {
        assert!(question_visible(false, true, Duration::from_secs(25)));
        assert!(question_visible(false, true, ALIVE));
        assert!(question_visible(false, false, NO_POLL));
        assert!(!question_visible(false, false, Duration::from_secs(6)));
        assert!(!question_visible(true, true, Duration::ZERO));
        assert!(!question_visible(false, true, Duration::from_secs(36)));
    }

    #[tokio::test]
    async fn conversation_held_permissions_require_an_app_no_terminal_and_a_dialog_mode() {
        for gate in [PermissionGate { app_present: false, ..gate() }, PermissionGate { terminal_attached: true, ..gate() }, PermissionGate { mode_without_dialog: true, ..gate() }] {
            let (store, binding) = setup();
            let poll = store.begin_ask(&binding, ask("perm:tool"), super::tests::gate(), Instant::now()).unwrap();
            let id = store.pending(&binding, Instant::now()).unwrap().interaction_id;
            assert_eq!(store.begin_ask(&binding, ask("perm:tool"), gate, Instant::now()).unwrap().wait().await, json!({"soltar":true}));
            assert_eq!(poll.wait().await, json!({"answers":null}));
            assert!(store.interactions.validate(&binding, Some(&id)).is_err());
            assert!(store.pending(&binding, Instant::now()).is_none());
        }
    }

    #[tokio::test]
    async fn conversation_held_polls_do_not_rotate_tokens_or_close_siblings() {
        let (store, binding) = setup();
        let old = store.begin_ask(&binding, ask("q"), gate(), Instant::now()).unwrap();
        let first = store.pending(&binding, Instant::now()).unwrap();
        let new = store.begin_ask(&binding, ask("q"), gate(), Instant::now()).unwrap();
        drop(old);
        assert_eq!(first, store.pending(&binding, Instant::now()).unwrap());
        let other = store.begin_ask(&binding, ask("perm:p"), gate(), Instant::now()).unwrap();
        assert!(store.pending(&binding, Instant::now()).is_none());
        assert_eq!(store.pending_all(&binding, Instant::now()).unwrap().len(), 2);
        store.interrupt(&binding, "q").unwrap();
        assert!(store.interactions.validate(&binding, Some(&first.interaction_id)).is_err());
        assert_eq!(new.wait().await, json!({"answers":null}));
        assert_eq!(store.pending(&binding, Instant::now()).unwrap().id, "perm:p");
        drop(other);
    }

    #[test]
    fn conversation_held_expired_poll_cannot_revive_the_old_public_identity() {
        let (store, binding) = setup();
        let now = Instant::now();
        let old = store.begin_ask(&binding, ask("q"), gate(), now).unwrap();
        let id = store.pending(&binding, now).unwrap().interaction_id;
        assert!(store.pending(&binding, now + ALIVE + Duration::from_secs(1)).is_none());
        drop(old);
        assert!(store.pending(&binding, Instant::now()).is_none());
        assert!(store.interactions.validate(&binding, Some(&id)).is_err());
        let poll = store.begin_ask(&binding, ask("q"), gate(), Instant::now()).unwrap();
        assert_ne!(store.pending(&binding, Instant::now()).unwrap().interaction_id, id);
        drop(poll);
    }

    #[tokio::test]
    async fn conversation_held_answer_is_single_and_requires_matching_receipt_and_winner() {
        let (store, binding) = setup();
        let poll = store.begin_ask(&binding, ask("q"), gate(), Instant::now()).unwrap();
        let id = store.pending(&binding, Instant::now()).unwrap().interaction_id;
        let mut first = Box::pin(store.answer(&binding, "q", &id, json!({"answers":{"Escolha":"A"}}), Some(receipt())));
        let mut duplicate = Box::pin(store.answer(&binding, "q", &id, json!({"answers":{"Escolha":"B"}}), Some(receipt())));
        assert!(first.as_mut().now_or_never().is_none());
        assert!(duplicate.as_mut().now_or_never().is_none());
        assert_eq!(poll.wait().await, json!({"publication_id":"publication-1","generation":2,"session_id":"sid","answers":{"Escolha":"A"}}));
        store.finish(&binding, "q", "app", Some(Receipt { generation: 1, ..receipt() })).unwrap();
        assert!(first.as_mut().now_or_never().is_none());
        store.finish(&binding, "q", "app", Some(receipt())).unwrap();
        assert_eq!(first.await.unwrap(), PluginReply::Accepted);
        assert_eq!(duplicate.await.unwrap(), PluginReply::Accepted);
        assert_eq!(store.answer(&binding, "q", &id, json!({}), Some(receipt())).await.unwrap(), PluginReply::Accepted);
        assert!(store.interactions.validate(&binding, Some(&id)).is_err());
    }

    #[tokio::test]
    async fn conversation_held_answer_preserves_the_hook_body_at_the_top_level() {
        for (request_id, body) in [
            ("perm:allow", json!({"permitir":true})),
            ("perm:deny", json!({"permitir":false})),
            ("ask:form", json!({"answers":{"Escolha":"A"}})),
            ("ask:skip", json!({"deny":"O usuário prefere conversar antes de responder."})),
        ] {
            for receipt in [None, Some(receipt())] {
                let (store, binding) = setup();
                let poll = store.begin_ask(&binding, ask(request_id), gate(), Instant::now()).unwrap();
                let id = store.pending(&binding, Instant::now()).unwrap().interaction_id;
                let mut answer = Box::pin(store.answer(&binding, request_id, &id, body.clone(), receipt.clone()));
                assert!(answer.as_mut().now_or_never().is_none());
                let mut expected = body.clone();
                if let Some(r) = &receipt {
                    expected["publication_id"] = json!(r.publication_id);
                    expected["generation"] = json!(r.generation);
                    expected["session_id"] = json!(r.session_id);
                }
                assert_eq!(poll.wait().await, expected);
                store.finish(&binding, request_id, "app", receipt).unwrap();
                assert_eq!(answer.await.unwrap(), PluginReply::Accepted);
            }
        }
    }

    #[tokio::test]
    async fn conversation_held_answer_rejects_a_non_object_before_publication() {
        let (store, binding) = setup();
        let poll = store.begin_ask(&binding, ask("q"), gate(), Instant::now()).unwrap();
        let id = store.pending(&binding, Instant::now()).unwrap().interaction_id;
        for body in [Value::Null, json!(true), json!([])] {
            assert_eq!(store.answer(&binding, "q", &id, body, Some(receipt())).await.unwrap_err().0, "plugin_answer_body_invalid");
        }
        assert!(store.memory.lock().unwrap().sessions[&binding.key].questions["q"].answer.is_none());
        drop(poll);
    }

    #[tokio::test]
    async fn conversation_held_late_receipt_cannot_finish_a_reopened_question_without_answer() {
        let (store, binding) = setup();
        let first_poll = store.begin_ask(&binding, ask("q"), gate(), Instant::now()).unwrap();
        let first_id = store.pending(&binding, Instant::now()).unwrap().interaction_id;
        let mut first = Box::pin(store.answer(&binding, "q", &first_id, json!({"answers":{"Escolha":"A"}}), Some(receipt())));
        assert!(first.as_mut().now_or_never().is_none());
        first_poll.wait().await;
        store.finish(&binding, "q", "app", Some(receipt())).unwrap();
        assert_eq!(first.await.unwrap(), PluginReply::Accepted);

        let poll = store.begin_ask(&binding, ask("q"), gate(), Instant::now()).unwrap();
        let reopened = store.pending(&binding, Instant::now()).unwrap();
        assert_ne!(reopened.interaction_id, first_id);
        assert!(store.memory.lock().unwrap().sessions[&binding.key].questions["q"].answer.is_none());
        store.finish(&binding, "q", "app", Some(receipt())).unwrap();
        store.finish(&binding, "q", "terminal", Some(receipt())).unwrap();
        assert_eq!(store.pending(&binding, Instant::now()).unwrap(), reopened);
        assert_eq!(store.interactions.validate(&binding, Some(&reopened.interaction_id)).unwrap(), target("q"));

        let second_receipt = Receipt { publication_id: "publication-2".into(), ..receipt() };
        let mut second = Box::pin(store.answer(&binding, "q", &reopened.interaction_id, json!({"answers":{"Escolha":"B"}}), Some(second_receipt.clone())));
        assert!(second.as_mut().now_or_never().is_none());
        assert_eq!(poll.wait().await["answers"], json!({"Escolha":"B"}));
        store.finish(&binding, "q", "app", Some(receipt())).unwrap();
        store.finish(&binding, "q", "app", None).unwrap();
        assert!(second.as_mut().now_or_never().is_none());
        store.finish(&binding, "q", "app", Some(second_receipt)).unwrap();
        assert_eq!(second.await.unwrap(), PluginReply::Accepted);
    }

    #[tokio::test]
    async fn conversation_held_expired_unconsumed_answer_releases_both_duplicate_waiters() {
        for refresh_first in [false, true] {
            let (store, binding) = setup();
            let poll = store.begin_ask(&binding, ask("q"), gate(), Instant::now()).unwrap();
            let id = store.pending(&binding, Instant::now()).unwrap().interaction_id;
            let mut first = Box::pin(store.answer(&binding, "q", &id, json!({"answers":{"Escolha":"A"}}), Some(receipt())));
            let mut duplicate = Box::pin(store.answer(&binding, "q", &id, json!({"answers":{"Escolha":"B"}}), Some(receipt())));
            assert!(first.as_mut().now_or_never().is_none());
            assert!(duplicate.as_mut().now_or_never().is_none());
            drop(poll);
            {
                let mut memory = store.memory.lock().unwrap();
                let q = memory.sessions.get_mut(&binding.key).unwrap().questions.get_mut("q").unwrap();
                let answer = q.answer.as_mut().unwrap();
                assert!(!answer.handed && answer.poll_id.is_none());
                answer.deadline = Instant::now() - Duration::from_millis(1);
            }
            let mut next_poll = if refresh_first {
                let poll = store.begin_ask(&binding, ask("q"), gate(), Instant::now()).unwrap();
                assert!(store.memory.lock().unwrap().sessions[&binding.key].questions["q"].answer.is_none());
                Some(poll)
            } else { None };
            let second_receipt = Receipt { publication_id: "publication-2".into(), ..receipt() };
            let mut second = Box::pin(store.answer(&binding, "q", &id, json!({"answers":{"Escolha":"B"}}), Some(second_receipt.clone())));
            assert!(second.as_mut().now_or_never().is_none());
            assert_eq!(first.await.unwrap(), PluginReply::NotWritten);
            assert_eq!(duplicate.await.unwrap(), PluginReply::NotWritten);
            if next_poll.is_none() { next_poll = Some(store.begin_ask(&binding, ask("q"), gate(), Instant::now()).unwrap()); }
            assert_eq!(store.pending(&binding, Instant::now()).unwrap().interaction_id, id);
            let payload = next_poll.unwrap().wait().await;
            assert_eq!(payload["publication_id"], "publication-2");
            assert_eq!(payload["answers"], json!({"Escolha":"B"}));
            store.finish(&binding, "q", "app", Some(second_receipt)).unwrap();
            assert_eq!(second.await.unwrap(), PluginReply::Accepted);
        }
    }

    #[tokio::test]
    async fn conversation_held_expired_possible_delivery_keeps_receipt_and_never_replays() {
        for consumed in [false, true] {
            let (store, binding) = setup();
            let mut poll = Some(store.begin_ask(&binding, ask("q"), gate(), Instant::now()).unwrap());
            let id = store.pending(&binding, Instant::now()).unwrap().interaction_id;
            let mut answer = Box::pin(store.answer(&binding, "q", &id, json!({"answers":{"Escolha":"A"}}), Some(receipt())));
            assert!(answer.as_mut().now_or_never().is_none());
            if consumed { poll.take().unwrap().wait().await; }
            {
                let mut memory = store.memory.lock().unwrap();
                let answer = memory.sessions.get_mut(&binding.key).unwrap().questions.get_mut("q").unwrap().answer.as_mut().unwrap();
                assert!(answer.handed || answer.poll_id.is_some());
                answer.deadline = Instant::now() - Duration::from_millis(1);
            }
            let next_poll = store.begin_ask(&binding, ask("q"), gate(), Instant::now()).unwrap();
            assert!(next_poll.ready.is_none());
            let other = Receipt { publication_id: "publication-2".into(), ..receipt() };
            assert_eq!(store.answer(&binding, "q", &id, json!({"answers":{"Escolha":"B"}}), Some(other)).await.unwrap_err().0, "plugin_publication_conflict");
            assert_eq!(store.answer(&binding, "q", &id, json!({}), Some(receipt())).await.unwrap(), PluginReply::Unknown);
            if let Some(poll) = poll { assert_eq!(poll.wait().await["publication_id"], "publication-1"); }
            store.finish(&binding, "q", "app", Some(receipt())).unwrap();
            assert_eq!(answer.await.unwrap(), PluginReply::Accepted);
            assert_eq!(next_poll.wait().await, json!({"answers":null}));
        }
    }

    #[tokio::test]
    async fn conversation_held_terminal_winner_and_unsolicited_finish_are_not_acceptance() {
        let (store, binding) = setup();
        let poll = store.begin_ask(&binding, ask("q"), gate(), Instant::now()).unwrap();
        let id = store.pending(&binding, Instant::now()).unwrap().interaction_id;
        let mut answer = Box::pin(store.answer(&binding, "q", &id, json!({}), None));
        assert!(answer.as_mut().now_or_never().is_none());
        poll.wait().await;
        store.finish(&binding, "q", "terminal", None).unwrap();
        assert_eq!(answer.await.unwrap(), PluginReply::Unknown);
        assert!(store.answer(&binding, "q", &id, json!({}), None).await.is_err());
    }

    #[tokio::test]
    async fn conversation_held_stored_answer_expires_and_cancel_does_not_republish() {
        let (store, binding) = setup();
        let poll = store.begin_ask(&binding, ask("q"), gate(), Instant::now()).unwrap();
        drop(poll);
        let id = store.pending(&binding, Instant::now()).unwrap().interaction_id;
        let mut answer = Box::pin(store.answer(&binding, "q", &id, json!({"answers":{"Escolha":"A"}}), Some(receipt())));
        assert!(answer.as_mut().now_or_never().is_none());
        drop(answer);
        // A desconexão do app não perde o recibo de uma resposta que ainda pode chegar ao hook.
        let poll = store.begin_ask(&binding, ask("q"), gate(), Instant::now()).unwrap();
        assert_eq!(poll.wait().await["publication_id"], "publication-1");
        let mut again = ask("q"); again.janela_ms = Some(-1);
        assert_eq!(store.begin_ask(&binding, again, gate(), Instant::now()).unwrap().wait().await, json!({"answers":null}));
        store.finish(&binding, "q", "app", Some(receipt())).unwrap();
        assert_eq!(store.answer(&binding, "q", &id, json!({}), Some(receipt())).await.unwrap(), PluginReply::Accepted);

        let poll = store.begin_ask(&binding, ask("expired"), gate(), Instant::now()).unwrap();
        drop(poll);
        let id = store.pending(&binding, Instant::now()).unwrap().interaction_id;
        let mut answer = Box::pin(store.answer(&binding, "expired", &id, json!({}), None));
        assert!(answer.as_mut().now_or_never().is_none());
        drop(answer);
        let mut again = ask("expired"); again.janela_ms = Some(-1);
        assert_eq!(store.begin_ask(&binding, again, gate(), Instant::now() + CONFIRM + Duration::from_millis(1)).unwrap().wait().await, json!({"answers":null}));
    }

    #[test]
    fn conversation_held_old_poll_never_recreates_owner_or_overwrites_new_state() {
        let (store, binding) = setup();
        let old = store.begin_pull(&binding, pull("old"), Instant::now()).unwrap();
        store.forget(&binding.key).unwrap();
        drop(old);
        assert!(store.memory.lock().unwrap().sessions.is_empty());
        store.interactions.bind(&binding).unwrap();
        store.bind(&binding).unwrap();
        let old = store.begin_pull(&binding, pull("old"), Instant::now()).unwrap();
        let new = store.begin_pull(&binding, pull("new"), Instant::now() + ALIVE).unwrap();
        store.record_state(&binding, "working".into(), None, Instant::now()).unwrap();
        drop(old);
        let memory = store.memory.lock().unwrap();
        let s = &memory.sessions[&binding.key];
        assert_eq!(s.owner.as_ref().unwrap().instance, "new");
        assert_eq!(s.state.as_ref().unwrap().1, "working");
        assert!(s.waiter.is_some());
        drop(memory);
        drop(new);
    }

    #[test]
    fn conversation_held_closing_an_old_target_never_erases_the_new_life() {
        let (store, old) = setup();
        let poll = store.begin_ask(&old, ask("old"), gate(), Instant::now()).unwrap();
        let new = InteractionBinding { generation: old.generation + 1, ..old.clone() };
        store.interactions.bind(&new).unwrap();
        let token = store.interactions.observe(&new, &target("new"), Some(json!({"question":"B"}))).unwrap().unwrap();
        assert_eq!(store.interrupt(&old, "old").unwrap_err().0, "erro_interacao_desatualizada");
        drop(poll);
        assert_eq!(store.interactions.validate(&new, Some(&token)).unwrap(), target("new"));
    }

    #[test]
    fn conversation_held_bind_and_forget_preserve_a_new_life_already_observed() {
        for forget in [false, true] {
            let (store, old) = setup();
            let poll = store.begin_ask(&old, ask("old"), gate(), Instant::now()).unwrap();
            let new = InteractionBinding { generation: old.generation + 1, ..old.clone() };
            store.interactions.bind(&new).unwrap();
            let token = store.interactions.observe(&new, &target("new"), Some(json!({"question":"B"}))).unwrap().unwrap();
            if forget { store.forget(&old.key).unwrap(); } else { store.bind(&new).unwrap(); }
            drop(poll);
            assert_eq!(store.interactions.validate(&new, Some(&token)).unwrap(), target("new"));
            assert!(store.begin_ask(&old, ask("old"), gate(), Instant::now()).is_err());
        }
    }

    #[test]
    fn conversation_held_liveness_and_state_age_use_the_monotonic_clock() {
        let (store, binding) = setup();
        let now = Instant::now();
        store.record_state(&binding, "working".into(), None, now).unwrap();
        let poll = store.begin_pull(&binding, pull("i"), now).unwrap();
        assert!(store.waiting(&binding).unwrap());
        assert!(store.declared_modes(&binding).unwrap().contains("receipt_v2"));
        assert_eq!(store.recent_state(&binding, now + Duration::from_secs(91)).unwrap().unwrap().0, "working");
        drop(poll);
        let now = Instant::now();
        assert!(!store.waiting(&binding).unwrap());
        assert!(store.alive(&binding, now).unwrap());
        assert!(!store.alive(&binding, now + ALIVE).unwrap());
        assert!(store.recent_state(&binding, now + Duration::from_secs(91)).unwrap().is_none());
    }

    #[test]
    fn conversation_held_other_conversation_or_live_instance_cannot_take_pull() {
        let (store, binding) = setup();
        let first = store.begin_pull(&binding, pull("first"), Instant::now()).unwrap();
        assert_eq!(store.begin_pull(&binding, pull("second"), Instant::now()).err().unwrap().0, "plugin_instance_conflict");
        let mut wrong = pull("first"); wrong.session_id = Some("other".into());
        assert_eq!(store.begin_pull(&binding, wrong, Instant::now()).err().unwrap().0, "plugin_conversation_mismatch");
        let future = InteractionBinding { generation: 3, ..binding.clone() };
        store.interactions.bind(&future).unwrap();
        store.bind(&future).unwrap();
        drop(first);
        assert!(store.begin_pull(&binding, pull("first"), Instant::now()).is_err());
    }

    #[tokio::test]
    async fn conversation_held_terminal_publications_track_disconnect_and_all_receipts() {
        for (mode, ack, reply) in [(PluginMode::Fill, PluginMode::Fill, PluginReply::Filled), (PluginMode::User, PluginMode::User, PluginReply::Accepted), (PluginMode::Focus, PluginMode::Fill, PluginReply::Filled)] {
            let (store, binding) = setup();
            let poll = store.begin_pull(&binding, pull("i"), Instant::now()).unwrap();
            let mut publish = Box::pin(store.publish(&binding, request(mode)));
            assert!(publish.as_mut().now_or_never().is_none());
            assert_eq!(poll.wait().await["publication_id"], "publication-1");
            store.acknowledge(&binding, Some(&Receipt { session_id: "wrong".into(), ..receipt() }), ack.clone(), true).unwrap();
            assert!(publish.as_mut().now_or_never().is_none());
            store.acknowledge(&binding, Some(&receipt()), ack, true).unwrap();
            assert_eq!(publish.await.unwrap(), reply);
        }
        let (store, binding) = setup();
        let poll = store.begin_pull(&binding, pull("i"), Instant::now()).unwrap();
        let mut publish = Box::pin(store.publish(&binding, request(PluginMode::Fill)));
        assert!(publish.as_mut().now_or_never().is_none());
        drop(poll);
        assert_eq!(publish.await.unwrap(), PluginReply::NotWritten);
    }

    #[tokio::test]
    async fn conversation_held_canceled_publication_retains_unknown_until_receipt() {
        let (store, binding) = setup();
        let old = store.begin_pull(&binding, pull("i"), Instant::now()).unwrap();
        let poll = store.begin_pull(&binding, pull("i"), Instant::now()).unwrap();
        let mut publish = Box::pin(store.publish(&binding, request(PluginMode::Fill)));
        assert!(publish.as_mut().now_or_never().is_none());
        drop(old);
        assert!(publish.as_mut().now_or_never().is_none());
        poll.wait().await;
        drop(publish);
        let next = store.begin_pull(&binding, pull("i"), Instant::now()).unwrap();
        let other = PluginRequest { id: "other".into(), ..request(PluginMode::Fill) };
        assert_eq!(store.publish(&binding, other).await.unwrap(), PluginReply::Unknown);
        store.acknowledge(&binding, Some(&receipt()), PluginMode::Fill, true).unwrap();
        assert!(store.memory.lock().unwrap().sessions[&binding.key].publication.is_none());
        drop(next);
    }

    #[tokio::test]
    async fn conversation_held_capabilities_and_shutdown_never_claim_delivery() {
        let (store, binding) = setup();
        assert_eq!(store.publish(&binding, request(PluginMode::Fill)).await.unwrap(), PluginReply::Unavailable);
        let mut old = pull("i"); old.modos = vec!["fill".into()];
        let poll = store.begin_pull(&binding, old, Instant::now()).unwrap();
        assert_eq!(store.publish(&binding, request(PluginMode::Fill)).await.unwrap(), PluginReply::NotWritten);
        store.stop().unwrap();
        assert_eq!(poll.wait().await, json!({"text":null}));
        assert_eq!(store.publish(&binding, request(PluginMode::Fill)).await.unwrap(), PluginReply::Unavailable);
    }
}

struct PollGuard<'a> { store: &'a Store, binding: InteractionBinding, request_id: Option<String>, id: u64, handed: bool }
impl Drop for PollGuard<'_> {
    fn drop(&mut self) {
        let Ok(mut memory) = self.store.memory.lock() else {
            tracing::error!(code = "plugin_store_unavailable", "não foi possível encerrar a espera do plugin"); return;
        };
        let Ok(s) = session(&mut memory, &self.binding) else { return; };
        let now = Instant::now();
        if let Some(id) = &self.request_id {
            if let Some(q) = s.questions.get_mut(id) {
                if q.waiter.as_ref().is_some_and(|w| w.id == self.id) { q.waiter = None; q.seen = now; }
                if let Some(answer) = q.answer.as_mut().filter(|a| a.poll_id == Some(self.id)) {
                    if self.handed { answer.handed = true; }
                    else { answer.poll_id = None; }
                }
            }
        } else {
            if s.waiter.as_ref().is_some_and(|w| w.id == self.id) {
                s.waiter = None;
                s.heartbeat = Some(now);
                if let Some(owner) = &mut s.owner { owner.seen = now; }
            }
            if let Some(p) = s.publication.as_mut().filter(|p| p.poll_id == self.id) {
                if self.handed { p.handed = true; }
                else if !p.handed { p.result.send_replace(Some(PluginReply::NotWritten)); s.publication = None; }
            }
        }
        self.store.notify(&self.binding.key);
    }
}
