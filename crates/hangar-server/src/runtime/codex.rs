use super::{LiveBuffer,protocol::*};
use hangar_api::state::StateEvent;
use hangar_codex::proto::{self as wire,ClientRequest};
use serde::Deserialize;
use serde_json::{Value,json};
use std::collections::{BTreeMap,BTreeSet};
use std::sync::Arc;
use crate::interactions::{ExpectedInteraction,InteractionBinding,InteractionError,InteractionKind,InteractionStore,native_target,runtime_error};
use super::queue::Status;

struct Rpc {
    operation_id:String,
    method:String,
    params:Value,
    deadline:f64,
    timed_out:bool,
    continuation:Option<Value>,
    state_revision:u64,
    settings_revision:u64,
}

struct ServiceTierChange {
    operation_id:String,
    thread_id:String,
    model:Option<String>,
    tier:String,
    deadline:f64,
    acknowledged:bool,
    candidate:bool,
    verifying:bool,
}

struct Wire {
    interaction:Option<ExpectedInteraction>,
    request_id:Option<RequestId>,
    server_request:Option<RequestId>,
    server_epoch:Option<u64>,
    final_result:bool,
}

#[derive(Default)]
struct Voice {
    thread_id:Option<String>,
    starting:bool,
    closed:bool,
    requests:BTreeMap<RequestId,(Value,u64)>,
    answering:BTreeSet<RequestId>,
    unsubscribed:bool,
}

#[derive(Clone,Copy,Debug,PartialEq,Eq)]
enum ReservationState {
    /// A gravação na fila ainda não voltou.
    Reserving,
    Reserved,
    Dispatching,
    /// Pode ter sido escrita: nunca sai de novo.
    Uncertain,
}

struct Reservation { reservation:ReservedAsyncAnswer, state:ReservationState }

#[derive(Default)]
struct AsyncQuestions {
    pending:Vec<(String,Value)>,
    seen:BTreeSet<String>,
    resolved:BTreeSet<String>,
    skipped:BTreeSet<String>,
    local_answers:BTreeMap<String,String>,
    echoes:BTreeMap<String,usize>,
    during_load:Option<Vec<Value>>,
}

impl AsyncQuestions {
    /// Decide pelo item tipado; o cru é o que fica guardado para o snapshot.
    fn observe(&mut self,thread:&str,item:&wire::ThreadItem,raw:&Value) {
        let (id,questions) = match item {
            wire::ThreadItem::AgentMessage { id,delivery:Some(delivery),questions:Some(questions),.. }
                if delivery == "async" && !questions.is_empty() => (id,Some(questions)),
            wire::ThreadItem::UserMessage { id,.. } => (id,None),
            _ => return,
        };
        if id.is_empty() || self.seen.contains(id) { return; }
        self.seen.insert(id.clone());
        if let Some(items) = self.during_load.as_mut() { items.push(raw.clone()); }
        if let Some(questions) = questions {
            for (index,question) in questions.iter().enumerate() {
                let title = question.title.as_str();
                if title.trim().is_empty() { continue; }
                let request_id = format!("async:{thread}:{id}:{index}");
                if self.resolved.contains(&request_id) { continue; }
                let options:Vec<_> = question.options.iter().flatten().filter_map(Value::as_str)
                    .map(|label|json!({"label":label,"description":""})).collect();
                self.pending.push((request_id.clone(),json!({"provider":"codex","request_id":request_id,"is_async":true,
                    "questions":[{"id":"answer","header":(index+1).to_string(),"question":title,"multiSelect":false,
                    "isOther":true,"isSecret":false,"options":options}]})));
            }
        } else if let wire::ThreadItem::UserMessage { content,.. } = item {
            let text = content.iter().filter_map(|block|match block { wire::UserInput::Text { text }=>Some(text.as_str()),_=>None }).collect::<String>();
            if let Some(count) = self.echoes.get_mut(&text).filter(|c|**c > 0) { *count -= 1; return; }
            let text = text.trim();
            if let Some(body) = text.strip_prefix("<send_user_message_question_reply>").and_then(|s|s.strip_suffix("</send_user_message_question_reply>")) {
                if let Ok(Value::Array(replies)) = serde_json::from_str::<Value>(body) {
                    for reply in replies {
                        if !reply["answer"].as_str().is_some_and(|s|!s.trim().is_empty()) { continue; }
                        if let Some(encoded) = reply["questionItemId"].as_str() {
                            if let Ok(Value::Array(identity)) = serde_json::from_str::<Value>(encoded) {
                                if identity.len() == 3 && identity[0] == "request_user_input_async" && identity[1].is_string() && identity[2].is_u64() {
                                    self.resolve(&format!("async:{thread}:{}:{}",identity[1].as_str().unwrap(),identity[2].as_u64().unwrap()));
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    fn hydrate(&mut self,thread_id:&str,thread:&Value) {
        let mut restored = Self { skipped:self.skipped.clone(),resolved:self.skipped.clone(),..Self::default() };
        let typed = |item:&Value|wire::ThreadItem::deserialize(item).unwrap_or(wire::ThreadItem::Unknown);
        if let Some(turns) = thread["turns"].as_array() {
            for turn in turns { if let Some(items) = turn["items"].as_array() { for item in items { restored.observe(thread_id,&typed(item),item); } } }
        }
        for item in self.during_load.take().unwrap_or_default() { restored.observe(thread_id,&typed(&item),&item); }
        for (id,text) in &self.local_answers { restored.record_answer(id,text); }
        *self = restored;
    }

    fn resolve(&mut self,id:&str) { self.pending.retain(|(key,_)|key != id); self.resolved.insert(id.into()); }
    fn record_answer(&mut self,id:&str,text:&str) {
        self.local_answers.insert(id.into(),text.into());
        if self.pending.iter().any(|(key,_)|key == id) { self.resolve(id); *self.echoes.entry(text.into()).or_default() += 1; }
    }
}

pub struct Engine {
    interactions:Option<(String,Arc<InteractionStore>)>,
    metadata:Value,
    generation:u64,
    clock:ClockSample,
    counter:u64,
    headless:bool,
    alive:bool,
    initialized:bool,
    ready:bool,
    /// Terminal: inicializado na conexão com a thread da TUI; o primeiro turno já pode sair.
    connected:bool,
    /// Terminal: o `thread/resume` colou e os eventos da thread chegam. Sem terminal `ready` cobre os dois.
    subscribed:bool,
    /// Próxima tentativa de assinar (relógio monotônico); só a ausência do rollout agenda outra.
    subscribe_due:Option<f64>,
    subscribe_wait:f64,
    /// Terminal: quando o último `turn/start` foi aceito. Sem assinatura não chega `turn/completed`.
    in_progress_since:Option<f64>,
    rollout_path:Option<String>,
    reconnect:bool,
    fresh_process:bool,
    thread_id:String,
    turn_id:Option<String>,
    in_progress:bool,
    state:StateEvent,
    state_revision:u64,
    settings_revision:u64,
    model:Option<String>,
    effort:Option<String>,
    mode:Option<String>,
    service_tier:Option<String>,
    service_tier_pending:Option<ServiceTierChange>,
    permission_mode:String,
    token_usage:Value,
    rate_limits:Value,
    preview:LiveBuffer,
    response_started:bool,
    first_response_start:Option<(String,f64)>,
    compacting:bool,
    /// item → (turno, `processId`) dos comandos ainda rodando; o Stop os encerra.
    running_commands:BTreeMap<String,(String,String)>,
    thinking:LiveBuffer,
    /// A vida anterior desta sessão estava no meio de um turno.
    was_working:bool,
    rpc:BTreeMap<RequestId,Rpc>,
    server_requests:Vec<(RequestId,Value)>,
    request_epochs:BTreeMap<RequestId,u64>,
    answering:BTreeSet<RequestId>,
    /// Terminal: pedidos que a conexão que caiu levou sem resolução. Sem token respondível; só seguram
    /// o aviso de "responda na TUI" até voltarem, serem resolvidos ou o turno acabar.
    lost_requests:BTreeSet<RequestId>,
    wires:BTreeMap<String,Wire>,
    policies:BTreeMap<RequestId,String>,
    last_format_request:Option<RequestId>,
    format_gate:FormatGate,
    /// Formatos tortos já mandados ao Python: falha sistemática não vira um aviso por linha.
    reported_formats:BTreeSet<String>,
    async_questions:AsyncQuestions,
    /// Terminal: respostas assíncronas reservadas na fila, na ordem em que entraram.
    reservations:Vec<Reservation>,
    voices:BTreeMap<String,Voice>,
    voice_wires:BTreeMap<String,(String,RequestId,u64)>,
    skill_preparations:BTreeMap<RequestId,RuntimeCommand>,
    early_voice:BTreeMap<String,Vec<Value>>,
    early_voice_bytes:usize,
}

fn error(message:&str) -> RuntimeError { RuntimeError::new("codex_command",message) }
fn string(value:&Value) -> Option<String> { value.as_str().map(str::to_owned) }
fn service_tier(value:&Value) -> Option<String> {
    if value.is_null() { Some("default".into()) }
    else { value.as_str().filter(|tier|["priority","default"].contains(tier)).map(str::to_owned) }
}
/// Os modos da tela, como em `sem_terminal.MODOS`.
const MODES:[&str;3] = ["Ask for approval","Approve for me","Full Access"];
/// Nome canônico do modo (sem caixa nem espaços, como `sem_terminal.politica`); desconhecido cai em Full Access.
fn canonical_mode(mode:&str) -> &'static str {
    let mode = mode.trim();
    MODES.iter().copied().find(|known|known.eq_ignore_ascii_case(mode)).unwrap_or("Full Access")
}
/// Modo gravado na sessão: desconhecido vira Full Access (como no Python), mas aparece no log.
fn stored_mode(session:&str,raw:&str) -> &'static str {
    let mode = canonical_mode(raw);
    if !raw.trim().is_empty() && !mode.eq_ignore_ascii_case(raw.trim()) && crate::warn_limit::allow(Some(session),"codex_unknown_mode") {
        tracing::warn!(session,mode = raw,"modo de permissão do Codex desconhecido; usando Full Access");
    }
    mode
}
fn approval(mode:&str) -> &'static str { if canonical_mode(mode) == "Full Access" { "never" } else { "on-request" } }
fn sandbox(mode:&str) -> &'static str { match canonical_mode(mode) { "Ask for approval"=>"read-only","Approve for me"=>"workspace-write",_=>"danger-full-access" } }

/// Código do problema pelo `codexErrorInfo` (texto, ou objeto de chave única); None = sem classe própria.
fn error_class(info:&Value) -> Option<&'static str> {
    let info = info.as_str().or_else(||info.as_object().and_then(|fields|fields.keys().next()).map(String::as_str))?;
    match info { "usageLimitExceeded" | "rateLimitExceeded"=>Some("codex_limite_uso"),"unauthorized"=>Some("codex_sem_login"),_=>None }
}
/// `item/agentMessage/delta` → `item_agentmessage_delta` (o diário aceita `[a-z0-9_]{1,64}`).
fn decode_code(method:&str) -> String {
    method.chars().map(|c|if c.is_ascii_alphanumeric() { c.to_ascii_lowercase() } else { '_' }).take(64).collect()
}

/// Texto de entrada da pessoa: a lista que o `prepare_prompt` montou, ou só o texto.
fn input_of(payload:&Value,text:&str) -> Vec<Value> {
    payload["input"].as_array().cloned().unwrap_or_else(||vec![json!({"type":"text","text":text})])
}

/// Espera crescente da assinatura enquanto a thread não tem rollout, a mesma do adapter Python.
const SUBSCRIBE_RETRY_BASE:f64 = 1.0;
const SUBSCRIBE_RETRY_MAX:f64 = 10.0;

/// Teto do turno numa sessão terminal não assinada, o `UNSUBSCRIBED_TURN_TTL` do adapter Python.
const UNSUBSCRIBED_TURN_TTL:f64 = 300.0;

/// Thread sem turno ainda não tem rollout: o `resume` a recusa até o primeiro turno gravar o arquivo.
fn missing_rollout(message:&str) -> bool { message.contains("no rollout found") }

/// Thread principal aberta pela TUI, como `sessions.primary_thread` do Python: subagente e outra pasta não trocam o vínculo.
fn primary_thread(thread:&Value,cwd:Option<&str>) -> bool {
    cwd.is_some() && thread["cwd"].as_str() == cwd && matches!(thread["source"].as_str(),Some("cli" | "vscode"))
        && thread["parentThreadId"].as_str().is_none_or(str::is_empty) && thread["threadSource"] != "subagent"
        && thread["canAcceptDirectInput"] != false
        && thread["id"].as_str().is_some_and(|id|!id.is_empty()) && thread["path"].as_str().is_some_and(|path|!path.is_empty())
}

fn retry_problem(problem:Option<&str>) -> bool { matches!(problem,Some("codex_sem_conexao" | "codex_limite_uso")) }

/// Pedido do servidor guardado cru (vai ao snapshot como veio), lido pelo tipo na hora de mostrar.
fn decoded(request:&Value) -> wire::ServerRequest {
    wire::ServerRequest::decode(request["method"].as_str().unwrap_or(""),&request["params"]).unwrap_or(wire::ServerRequest::Unknown)
}

/// Só os campos que mudam o estado, lidos crus quando a notificação de ciclo de vida não decodifica.
fn lifecycle_from_raw(method:&str,params:&Value) -> Option<wire::ServerNotification> {
    let text = |value:&Value|value.as_str().unwrap_or("").to_owned();
    let turn = || wire::Turn { id:text(&params["turn"]["id"]),status:text(&params["turn"]["status"]),
        error:wire::TurnError::deserialize(&params["turn"]["error"]).ok() };
    Some(match method {
        "turn/started" => wire::ServerNotification::TurnStarted(wire::TurnStartedNotification { turn:turn(),..Default::default() }),
        "turn/completed" => wire::ServerNotification::TurnCompleted(wire::TurnCompletedNotification { turn:turn(),..Default::default() }),
        "thread/status/changed" => wire::ServerNotification::ThreadStatusChanged(wire::ThreadStatusChangedNotification {
            status:match params["status"]["type"].as_str() { Some("active") => wire::ThreadStatus::Active, Some("idle") => wire::ThreadStatus::Idle, _ => wire::ThreadStatus::Unknown },
            ..Default::default() }),
        _ => return None,
    })
}

/// Comando, pasta e motivo do pedido de aprovação; fora do formato saem da linha crua, e comando que não é texto fica None.
fn command_approval(request:&Value) -> (Option<String>,Option<String>,Option<String>) {
    let raw = |key:&str|request["params"][key].as_str().map(str::to_owned);
    let (command,cwd,reason) = match decoded(request) {
        wire::ServerRequest::CommandExecutionApproval(p) => (p.command,p.cwd,p.reason),
        _ => (raw("command"),raw("cwd"),raw("reason")),
    };
    // Comando em branco não diz o que vai rodar: tratado como ilegível.
    (command.filter(|c|!c.trim().is_empty()),cwd,reason)
}

/// "Sempre permitir" um comando que ninguém leu liberaria qualquer coisa pelo resto da sessão.
fn unreadable_command(request:&Value) -> bool {
    request["method"] == "item/commandExecution/requestApproval" && command_approval(request).0.is_none()
}

const ELICITATION:&str = "mcpServer/elicitation/request";

fn is_url_elicitation(request:&Value) -> bool { request["method"] == ELICITATION && request["params"]["mode"] == "url" }

/// Pedidos que viram cartão de opções (permitir/negar); o resto é pergunta nativa ou resposta automática.
fn is_card(request:&Value) -> bool {
    matches!(request["method"].as_str(),Some("item/commandExecution/requestApproval" | "item/fileChange/requestApproval" | "item/permissions/requestApproval"))
        || is_url_elicitation(request)
}

enum FieldKind { Choice(Vec<(String,Value)>), Bool, Number(bool), Text }
struct Field { id:String, header:String, question:String, kind:FieldKind }

/// Campos do formulário MCP; `None` quando o pedido não é um formulário ou alguma propriedade foge do que a tela mostra.
fn form_fields(request:&Value) -> Option<Vec<Field>> {
    if request["method"] != ELICITATION || is_url_elicitation(request) { return None; }
    let properties = request["params"]["requestedSchema"]["properties"].as_object().filter(|p|!p.is_empty())?;
    let message = request["params"]["message"].as_str().unwrap_or("");
    properties.iter().map(|(id,prop)| {
        let label = |value:&Value|value.as_str().map_or_else(||value.to_string(),str::to_owned);
        let choices:Vec<(String,Value)> = if let Some(values) = prop["enum"].as_array() {
            values.iter().map(|v|(label(v),v.clone())).collect()
        } else if let Some(options) = prop["oneOf"].as_array() {
            options.iter().filter_map(|o|o.get("const").map(|c|(o["title"].as_str().map_or_else(||label(c),str::to_owned),c.clone()))).collect()
        } else { Vec::new() };
        let kind = if !choices.is_empty() { FieldKind::Choice(choices) } else { match prop["type"].as_str()? {
            "boolean" => FieldKind::Bool, "string" => FieldKind::Text,
            "integer" => FieldKind::Number(true), "number" => FieldKind::Number(false), _ => return None } };
        Some(Field { id:id.clone(),header:prop["title"].as_str().unwrap_or(id).into(),
            question:prop["description"].as_str().unwrap_or(message).into(),kind })
    }).collect()
}

fn field_question(field:&Field) -> Value {
    let option = |label:&str|json!({"label":label,"description":""});
    let options:Vec<Value> = match &field.kind {
        FieldKind::Choice(choices) => choices.iter().map(|(label,_)|option(label)).collect(),
        FieldKind::Bool => vec![option("sim"),option("não")],
        _ => Vec::new(),
    };
    json!({"id":field.id,"header":field.header,"question":field.question,"multiSelect":false,
        "isOther":matches!(field.kind,FieldKind::Text | FieldKind::Number(_)),"isSecret":false,"options":options})
}

/// Resposta já validada (`question_response`) → `content` do formulário, com número e booleano de volta ao tipo.
fn form_content(fields:&[Field],response:&Value) -> Result<Value,RuntimeError> {
    let mut content = serde_json::Map::new();
    for field in fields {
        let text = response["answers"][&field.id]["answers"][0].as_str().ok_or_else(||error("responda a todas as perguntas"))?;
        let value = match &field.kind {
            FieldKind::Choice(choices) => choices.iter().find(|(label,_)|label == text).map(|(_,v)|v.clone()).ok_or_else(||error("opção inválida"))?,
            FieldKind::Bool => json!(text == "sim"),
            FieldKind::Number(true) => json!(text.trim().parse::<i64>().map_err(|_|error("informe um número inteiro"))?),
            FieldKind::Number(false) => json!(text.trim().parse::<f64>().ok().filter(|n|n.is_finite()).ok_or_else(||error("informe um número"))?),
            FieldKind::Text => json!(text),
        };
        content.insert(field.id.clone(),value);
    }
    Ok(Value::Object(content))
}

/// Texto do cartão de permissões: o que pede (leitura, escrita, rede) e o motivo.
fn permissions_text(request:&Value) -> String {
    let params = &request["params"];
    let list = |key:&str|params["permissions"]["fileSystem"][key].as_array().map(|items|items.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(", ")).filter(|l|!l.is_empty());
    let mut parts = Vec::new();
    if let Some(read) = list("read") { parts.push(format!("leitura de {read}")); }
    if let Some(write) = list("write") { parts.push(format!("escrita em {write}")); }
    if params["permissions"]["network"]["enabled"] == true { parts.push("rede".into()); }
    let what = if parts.is_empty() { "acesso extra".into() } else { parts.join("; ") };
    let reason = params["reason"].as_str().map_or(String::new(),|r|format!(" {r}"));
    format!("Permitir {what}?{reason}")
}

fn unsupported_notice(request:&Value) -> Option<String> {
    let method = request["method"].as_str()?;
    if matches!(method,"item/commandExecution/requestApproval" | "item/fileChange/requestApproval" | "item/tool/requestUserInput"
        | "item/permissions/requestApproval" | ELICITATION | "currentTime/read") { return None; }
    Some(format!("O Codex pediu `{method}`, que a sessão sem terminal não atende; o pedido foi recusado."))
}

impl Engine {
    pub fn new(metadata:Value,generation:u64,clock:ClockSample) -> Self {
        let mut async_questions = AsyncQuestions { during_load:Some(Vec::new()),..AsyncQuestions::default() };
        if let Some(skipped) = metadata["skipped_async_questions"].as_array() {
            async_questions.skipped = skipped.iter().filter_map(Value::as_str).map(str::to_owned).collect();
            async_questions.resolved = async_questions.skipped.clone();
        }
        if let Some(pending) = metadata["async_questions"].as_array() {
            async_questions.pending = pending.iter().filter_map(|pair|
                Some((pair.get(0)?.as_str()?.to_owned(),pair.get(1)?.clone()))).collect();
            async_questions.seen = metadata["async_seen"].as_array().into_iter().flatten().filter_map(Value::as_str).map(str::to_owned).collect();
            async_questions.resolved.extend(metadata["async_resolved"].as_array().into_iter().flatten().filter_map(Value::as_str).map(str::to_owned));
            async_questions.local_answers = metadata["async_local_answers"].as_object().into_iter().flatten()
                .filter_map(|(id,text)|Some((id.clone(),text.as_str()?.to_owned()))).collect();
            async_questions.echoes = metadata["async_echoes"].as_object().into_iter().flatten()
                .filter_map(|(text,count)|Some((text.clone(),usize::try_from(count.as_u64()?).ok()?))).collect();
            async_questions.during_load = metadata["async_during_load"].as_array().cloned();
        }
        let voices = metadata["voice_calls"].as_array().map(|calls|calls.iter().filter_map(|call|
            Some((call["call_id"].as_str()?.into(),Voice { thread_id:string(&call["thread_id"]),starting:call["starting"] == true,
                unsubscribed:call["unsubscribed"] == true,closed:true,..Voice::default() }))).collect()).unwrap_or_default();
        let headless = metadata["headless"] != false;
        let subscribed = !headless && metadata["subscribed"] == true;
        Self { interactions:None,generation,clock,counter:metadata["runtime_counter"].as_u64().unwrap_or(0),headless,
            alive:true,initialized:metadata["initialized"] == true,ready:if headless { metadata["ready"] == true } else { subscribed },
            connected:!headless && metadata["connected"] == true,subscribed,subscribe_due:None,subscribe_wait:SUBSCRIBE_RETRY_BASE,in_progress_since:None,
            rollout_path:string(&metadata["rollout_path"]),reconnect:false,fresh_process:false,
            thread_id:metadata["thread_id"].as_str().unwrap_or("").into(),turn_id:None,in_progress:false,
            state:StateEvent { session:metadata["name"].as_str().unwrap_or("").into(),state:"idle".into(),headless,
                status_line:string(&metadata["status_line"]),..StateEvent::default() },state_revision:metadata["state_revision"].as_u64().unwrap_or(0),settings_revision:metadata["settings_revision"].as_u64().unwrap_or(0),
            model:string(&metadata["model"]),effort:string(&metadata["effort"]),mode:string(&metadata["mode"]),
            service_tier:metadata.get("service_tier").and_then(service_tier),service_tier_pending:None,
            permission_mode:stored_mode(metadata["name"].as_str().unwrap_or(""),metadata["permission_mode"].as_str().unwrap_or("Full Access")).into(),token_usage:Value::Null,rate_limits:Value::Null,
            preview:LiveBuffer::default(),response_started:false,first_response_start:None,compacting:false,
            running_commands:BTreeMap::new(),thinking:LiveBuffer::default(),was_working:metadata["in_progress"] == true,
            rpc:BTreeMap::new(),server_requests:Vec::new(),
            request_epochs:BTreeMap::new(),answering:BTreeSet::new(),lost_requests:BTreeSet::new(),wires:BTreeMap::new(),policies:BTreeMap::new(),last_format_request:None,format_gate:FormatGate::default(),reported_formats:BTreeSet::new(),async_questions,reservations:Vec::new(),voices,voice_wires:BTreeMap::new(),skill_preparations:BTreeMap::new(),early_voice:BTreeMap::new(),early_voice_bytes:0,metadata }
    }

    pub fn view(&self) -> Value {
        let mut state = self.state.clone();
        let question = self.blocking_question().or_else(||self.async_questions.pending.first().map(|(_,q)|q.clone()));
        let pending_approval = self.server_requests.iter().find(|(_,r)|is_card(r));
        state.state = if !self.alive { "dead" } else if self.blocking_question().is_some() || pending_approval.is_some()
            || question.is_some() && !self.in_progress { "awaiting_input" } else if self.in_progress { "working" } else { "idle" }.into();
        state.codex_question = question.and_then(|q|q.as_object().cloned());
        state.codex_mode = self.mode.clone();
        state.codex_service_tier = self.service_tier.clone();
        state.label = self.compacting.then(||"Compactando…".into());
        state.question = None; state.options = None;
        // Pedido que só a TUI atende (ou que a conexão que caiu levou) segura a fila: a sessão não pode
        // parecer ociosa enquanto ele espera.
        if !self.headless && self.alive && pending_approval.is_none() && self.blocking_question().is_none() && state.codex_question.is_none()
            && (!self.server_requests.is_empty() || !self.lost_requests.is_empty()) {
            state.state = "awaiting_input".into();
            state.question = Some("O Codex pediu algo que só o terminal responde; responda na TUI.".into());
            return serde_json::to_value(state).unwrap();
        }
        if let Some((_,request)) = pending_approval {
            let place = |path:Option<String>|path.map_or(String::new(),|p|format!(" em {p}"));
            // Fora do formato os detalhes saem da linha crua: aprovar às cegas não é opção.
            let raw = |key:&str|request["params"][key].as_str().map(str::to_owned);
            let method = request["method"].as_str().unwrap_or("");
            if method == "item/permissions/requestApproval" {
                state.question = Some(permissions_text(request));
                state.options = Some(["Permitir neste turno","Permitir na sessão","Negar"].map(String::from).to_vec());
                return serde_json::to_value(state).unwrap();
            }
            if method == ELICITATION {
                let p = &request["params"];
                state.question = Some(format!("{} pede para abrir {}: {}",p["serverName"].as_str().unwrap_or("Um servidor MCP"),
                    p["url"].as_str().unwrap_or(""),p["message"].as_str().unwrap_or("")));
                state.options = Some(["Concluí","Cancelar"].map(String::from).to_vec());
                return serde_json::to_value(state).unwrap();
            }
            let (target,reason) = if request["method"] == "item/fileChange/requestApproval" {
                let (root,reason) = match decoded(request) {
                    wire::ServerRequest::FileChangeApproval(p) => (p.grant_root,p.reason),
                    _ => (raw("grantRoot"),raw("reason")),
                };
                (format!("Editar arquivos{}",place(root)),reason)
            } else {
                let (command,cwd,reason) = command_approval(request);
                let action = command.map_or_else(||"Rodar um comando que o Hangar não conseguiu ler".into(),|c|format!("Rodar `{c}`"));
                (format!("{action}{}",place(cwd)),reason)
            };
            state.question = Some(format!("{target}?{}",reason.map_or(String::new(),|r|format!(" {r}"))));
            let mut options = vec!["Permitir".into(),"Negar".into()];
            if !unreadable_command(request) { options.push("Sempre permitir".into()); }
            state.options = Some(options);
        }
        serde_json::to_value(state).unwrap()
    }

    pub fn control_view(&self) -> Value {
        json!({"alive":self.alive,"initialized":self.initialized,"ready":self.ready,"in_progress":self.in_progress,
            "headless":self.headless,"connected":self.connected,"subscribed":self.subscribed,"rollout_path":self.rollout_path,
            "thread_id":self.thread_id,"turn_id":self.turn_id,"model":self.model,"effort":self.effort,"mode":self.mode,"service_tier":self.service_tier,
            "permission_mode":self.permission_mode,"token_usage":self.token_usage,"rate_limits":self.rate_limits,
            "runtime_counter":self.counter,"state_revision":self.state_revision,"settings_revision":self.settings_revision,"deliverable":self.deliverable(),"pending":self.server_requests.iter()
                .map(|(id,request)|json!({"request_id":id,"request":request})).collect::<Vec<_>>(),
            "async_questions":self.async_questions.pending,"async_local_answers":self.async_questions.local_answers,
            "async_seen":self.async_questions.seen,"async_resolved":self.async_questions.resolved,
            "async_echoes":self.async_questions.echoes,"async_during_load":self.async_questions.during_load,
            "skipped_async_questions":self.async_questions.skipped,"voice_calls":self.voices.iter().map(|(call_id,voice)|
                json!({"call_id":call_id,"thread_id":voice.thread_id,"closed":voice.closed,"starting":voice.starting,"unsubscribed":voice.unsubscribed})).collect::<Vec<_>>()})
    }

    fn blocking_question(&self) -> Option<Value> {
        let (id,request) = self.server_requests.iter().find(|(_,r)|r["method"] == "item/tool/requestUserInput" || form_fields(r).is_some())?;
        Self::question_for(id,request)
    }

    fn question_for(id:&RequestId,request:&Value) -> Option<Value> {
        if let Some(fields) = form_fields(request) {
            return Some(json!({"provider":"codex","request_id":id,"questions":fields.iter().map(field_question).collect::<Vec<_>>()}));
        }
        let raw = request["params"]["questions"].as_array()?;
        let questions:Vec<_> = match decoded(request) {
            wire::ServerRequest::ToolRequestUserInput(params) => params.questions.into_iter().map(|q|json!({
                "id":q.id,"header":q.header,"question":q.question,"multiSelect":false,
                "isOther":q.is_other.unwrap_or(false),"isSecret":q.is_secret.unwrap_or(false),
                "options":q.options.unwrap_or_default()})).collect(),
            // Fora do formato a pergunta é lida crua, para não sumir da tela e travar a sessão.
            _ => raw.iter().map(|q|json!({
                "id":q["id"],"header":q["header"],"question":q["question"],"multiSelect":false,
                "isOther":q["isOther"].as_bool().unwrap_or(false),"isSecret":q["isSecret"].as_bool().unwrap_or(false),
                "options":q.get("options").cloned().unwrap_or_else(||json!([]))})).collect(),
        };
        Some(json!({"provider":"codex","request_id":id,"questions":questions}))
    }

    /// Terminal envia conectado, antes de assinar: o rollout que a assinatura exige nasce desse primeiro turno.
    fn sendable(&self) -> bool { if self.headless { self.ready } else { self.initialized && self.connected && !self.thread_id.is_empty() } }

    fn deliverable(&self) -> bool { self.async_dispatch_ready() && self.async_questions.pending.is_empty() }

    /// Tudo o que segura um turno novo, menos as perguntas assíncronas: a resposta reservada de uma
    /// delas não pode esperar a si mesma.
    fn async_dispatch_ready(&self) -> bool {
        self.alive && self.sendable() && !self.in_progress && self.server_requests.is_empty() && self.lost_requests.is_empty() && self.skill_preparations.is_empty()
            && !self.rpc.values().any(|rpc|!voice_rpc(rpc) && (matches!(rpc.method.as_str(),"turn/start" | "turn/steer" | "thread/compact/start")
                || rpc.continuation.as_ref().is_some_and(|next|next["kind"] == "skill_lookup")))
    }

    fn async_pending(&self,request_id:&str) -> bool { self.async_questions.pending.iter().any(|(id,_)|id == request_id) }

    /// Só a primeira reserva apta, pela ordem da fila; mensagem comum continua barrada pelo `deliverable`.
    pub fn ready_async_answer_entry(&self) -> Option<String> {
        if self.headless || !self.async_dispatch_ready() { return None; }
        self.reservations.iter().find(|r|r.state == ReservationState::Reserved && self.async_pending(&r.reservation.request_id))
            .map(|r|r.reservation.entry_id.clone())
    }

    /// Comando que a fila guarda junto da entrada reservada; o ator o devolve tal qual ao reivindicá-la.
    pub fn async_answer_command(reservation:&ReservedAsyncAnswer,thread_id:&str,generation:u64) -> RuntimeCommand {
        let mut payload = serde_json::to_value(reservation).unwrap_or_default();
        payload["thread_id"] = json!(thread_id); payload["generation"] = json!(generation);
        RuntimeCommand { operation_id:reservation.operation_id.clone(),kind:OperationKind::DispatchAsyncAnswer,payload }
    }

    /// Resultado da gravação da reserva: sem ela gravada, a reserva some e a pergunta segue aberta.
    pub fn settle_async_answer(&mut self,entry_id:&str,reserved:bool) -> Vec<Effect> {
        let Some(index) = self.reservations.iter().position(|r|r.reservation.entry_id == entry_id && r.state == ReservationState::Reserving) else { return Vec::new() };
        if reserved { self.reservations[index].state = ReservationState::Reserved; vec![Effect::WakeQueue] }
        else { self.reservations.remove(index); Vec::new() }
    }

    /// Gravação da reserva sem desfecho conhecido: não sai nesta vida; a repetição recebe a mesma entrada.
    pub fn uncertain_async_answer(&mut self,entry_id:&str) {
        if let Some(r) = self.reservations.iter_mut().find(|r|r.reservation.entry_id == entry_id && r.state == ReservationState::Reserving) {
            r.state = ReservationState::Uncertain;
        }
    }

    /// Retomada: a reserva volta do estado da operação persistida. Só a nunca despachada (ou devolvida
    /// sem escrita) pode sair; a que pode ter sido escrita fica incerta, e a aceita fecha a pergunta.
    pub fn restore_async_answer(&mut self,reservation:ReservedAsyncAnswer,thread_id:&str,status:Status,written:bool) {
        if self.headless || thread_id != self.thread_id || self.reservations.iter().any(|r|r.reservation.request_id == reservation.request_id) { return; }
        let state = match status {
            Status::Prepared if !written => ReservationState::Reserved,
            Status::Deferred => ReservationState::Reserved,
            Status::Prepared | Status::Dispatching | Status::Unknown => ReservationState::Uncertain,
            Status::Accepted | Status::Confirmed => { self.async_questions.record_answer(&reservation.request_id,&reservation.text); return; }
            Status::Rejected => return,
        };
        self.reservations.push(Reservation { reservation,state });
    }

    fn set_reservation(&mut self,entry_id:&str,state:ReservationState) {
        if let Some(r) = self.reservations.iter_mut().find(|r|r.reservation.entry_id == entry_id) { r.state = state; }
    }

    /// Protocolo ou recibo comprovou a entrada: a pergunta respondida sai, e só ela.
    fn finish_reservation(&mut self,entry_id:&str) {
        if let Some(index) = self.reservations.iter().position(|r|r.reservation.entry_id == entry_id) {
            let done = self.reservations.remove(index).reservation;
            self.async_questions.record_answer(&done.request_id,&done.text);
        }
    }

    fn idle(&self) -> bool { self.deliverable() && !self.rpc.values().any(|rpc|!voice_rpc(rpc)) && self.answering.is_empty() && self.async_questions.pending.is_empty() }

    pub fn forget_policy(&mut self,request_id:&RequestId) {
        // Pedido de status que falhou não pode barrar o próximo igual.
        if self.policies.remove(request_id).as_deref() == Some("format_status") { self.format_gate.reset(); }
    }

    fn policy(&mut self,kind:&str,payload:Value,effects:&mut Vec<Effect>) {
        self.counter += 1;
        let request_id = RequestId::String(format!("policy:{}:{}",self.generation,self.counter));
        self.policies.insert(request_id.clone(),kind.into());
        if kind == "format_status" { self.last_format_request = Some(request_id.clone()); }
        effects.push(Effect::Policy { kind:kind.into(),request_id,payload });
    }

    fn changed(&mut self,effects:&mut Vec<Effect>,format:bool) {
        effects.push(Effect::StateChanged);
        if !format { return; }
        let payload = json!({"model":self.model,"effort":self.effort,"token_usage":self.token_usage,"rate_limits":self.rate_limits});
        if self.format_gate.due(&payload,self.clock.monotonic_s) { self.policy("format_status",payload,effects); }
    }

    /// Resposta lida pelo tipo sem copiar a linha; fora do formato vai ao diário e segue com o padrão.
    fn decode_reply<T:for<'de> Deserialize<'de> + Default>(&mut self,method:&str,result:&Value,effects:&mut Vec<Effect>) -> T {
        match T::deserialize(result) {
            Ok(response) => response,
            Err(failure) => {
                tracing::warn!(session=%self.state.session,method,error=wire::error_kind(&failure),"resposta do Codex fora do formato");
                effects.push(Effect::Diag { event:DiagEvent::CodexDecode,code:decode_code(method) });
                // Só a forma do topo: o resultado pode ser o histórico inteiro, e o Python exige objeto.
                let shape = match result {
                    Value::Object(fields) => json!({"method":method,"result_keys":fields.keys().collect::<Vec<_>>()}),
                    Value::Null => json!({"method":method,"result_type":"null"}),
                    Value::Bool(_) => json!({"method":method,"result_type":"bool"}),
                    Value::Number(_) => json!({"method":method,"result_type":"number"}),
                    Value::String(_) => json!({"method":method,"result_type":"string"}),
                    Value::Array(_) => json!({"method":method,"result_type":"array"}),
                };
                self.report_format(format!("decode:{method}"),||shape,effects);
                T::default()
            }
        }
    }

    fn report_format(&mut self,kind:String,event:impl FnOnce() -> Value,effects:&mut Vec<Effect>) {
        if self.reported_formats.insert(kind.clone()) { self.policy("unknown_private",json!({"kind":kind,"event":event()}),effects); }
    }

    fn send(&mut self,operation_id:String,request:ClientRequest,continuation:Option<Value>,effects:&mut Vec<Effect>) {
        let (method,params) = request.into_parts();
        self.rpc(operation_id,method,params,continuation,effects);
    }

    fn rpc(&mut self,operation_id:String,method:&str,params:Value,continuation:Option<Value>,effects:&mut Vec<Effect>) {
        self.counter += 1;
        let request_id = RequestId::String(format!("hangar:{}:{}",self.generation,self.counter));
        if method == "thread/read" && params["includeTurns"] == true { self.async_questions.during_load = Some(Vec::new()); }
        self.rpc.insert(request_id.clone(),Rpc { operation_id:operation_id.clone(),method:method.into(),params:params.clone(),
            deadline:self.clock.monotonic_s+30.0,timed_out:false,continuation,state_revision:self.state_revision,settings_revision:self.settings_revision });
        self.wires.insert(operation_id.clone(),Wire { interaction:None,request_id:Some(request_id.clone()),server_request:None,server_epoch:None,final_result:false });
        effects.push(Effect::Write { operation_id:Some(operation_id),frame:json!({"jsonrpc":"2.0","id":request_id,"method":method,"params":params}) });
    }

    fn finish_service_tier(&mut self,disposition:Disposition,payload:Value,effects:&mut Vec<Effect>) {
        let Some(pending) = self.service_tier_pending.take() else { return };
        let wires = &mut self.wires;
        self.rpc.retain(|_,rpc| {
            let related = rpc.continuation.as_ref().is_some_and(|next|next["parent"] == pending.operation_id
                && next["kind"].as_str().is_some_and(|kind|kind.starts_with("service_tier")));
            if related { if let Some(wire) = wires.get_mut(&rpc.operation_id) { wire.final_result = true; } }
            if related && rpc.operation_id != pending.operation_id {
                effects.push(Effect::Reply { operation_id:rpc.operation_id.clone(),disposition:Disposition::Unknown,payload:payload.clone() });
            }
            !related
        });
        if let Some(wire) = self.wires.get_mut(&pending.operation_id) { wire.final_result = true; }
        effects.push(Effect::Reply { operation_id:pending.operation_id,disposition,payload });
    }

    fn expire_service_tier(&mut self,effects:&mut Vec<Effect>) {
        if self.service_tier_pending.as_ref().is_some_and(|pending|self.clock.monotonic_s >= pending.deadline) {
            self.finish_service_tier(Disposition::Unknown,json!({"error":"O Codex não confirmou a escolha Fast no prazo"}),effects);
        }
    }

    fn verify_service_tier(&mut self,effects:&mut Vec<Effect>) {
        let Some(pending) = self.service_tier_pending.as_mut() else { return };
        if !pending.acknowledged || !pending.candidate || pending.verifying { return; }
        pending.candidate = false; pending.verifying = true;
        let parent = pending.operation_id.clone(); let thread = pending.thread_id.clone();
        self.send(format!("{parent}:verify:{}",self.counter+1),ClientRequest::ThreadResume(wire::ThreadResumeParams { thread_id:thread,..Default::default() }),
            Some(json!({"kind":"service_tier_confirm","parent":parent})),effects);
    }

    fn send_service_tier(&mut self,effects:&mut Vec<Effect>) {
        let Some(pending) = self.service_tier_pending.as_ref() else { return };
        let (id,parent) = (pending.operation_id.clone(),json!({"kind":"service_tier_update","parent":pending.operation_id}));
        let request = ClientRequest::ThreadSettingsUpdate(wire::ThreadSettingsUpdateParams { thread_id:pending.thread_id.clone(),
            service_tier:Some(pending.tier.clone()),..Default::default() });
        self.send(id,request,Some(parent),effects);
    }

    fn restore_service_tier(&mut self,result:&Value,revision:u64,effects:&mut Vec<Effect>) {
        if revision != self.settings_revision { return; }
        if let Some(tier) = result.get("serviceTier").and_then(service_tier) {
            self.service_tier = Some(tier);
            self.policy("session.patch_meta",json!({"service_tier":self.service_tier}),effects);
        }
    }

    fn service_tier_reply(&mut self,rpc:&Rpc,line:&Value,effects:&mut Vec<Effect>) {
        let next = rpc.continuation.as_ref().unwrap();
        if next["kind"] == "service_tier_recovered" {
            // A resposta vazia de uma escrita antiga não prova a configuração atual.
            effects.push(Effect::Reply { operation_id:rpc.operation_id.clone(),disposition:Disposition::Unknown,
                payload:json!({"error":"Escolha Fast anterior sem confirmação"}) });
            return;
        }
        if !self.service_tier_pending.as_ref().is_some_and(|pending|next["parent"] == pending.operation_id) { return; }
        if rpc.operation_id != next["parent"].as_str().unwrap_or("") {
            effects.push(Effect::Reply { operation_id:rpc.operation_id.clone(),
                disposition:if line["error"].is_null() { Disposition::Accepted } else { Disposition::Rejected },
                payload:if line["error"].is_null() { line["result"].clone() } else { json!({"error":line["error"]}) } });
        }
        if !line["error"].is_null() {
            self.finish_service_tier(Disposition::Rejected,json!({"error":line["error"]}),effects); return;
        }
        if !self.alive || self.service_tier_pending.as_ref().is_some_and(|pending|pending.thread_id != self.thread_id) {
            self.finish_service_tier(Disposition::Unknown,json!({"error":"A sessão mudou antes de confirmar Fast"}),effects); return;
        }
        let result = &line["result"];
        match next["kind"].as_str() {
            Some("service_tier_catalog") => {
                let catalog:wire::ModelListResponse = self.decode_reply("model/list",result,effects);
                let pending = self.service_tier_pending.as_ref().unwrap();
                let supported = pending.model == self.model && self.model.is_some() && catalog.data.iter()
                    .any(|model|Some(model.model.as_str()) == self.model.as_deref() && !model.hidden
                        && model.service_tiers.as_ref().is_some_and(|tiers|tiers.iter().any(|tier|tier["id"] == "priority" && tier["hidden"] != true)));
                if !supported { self.finish_service_tier(Disposition::Rejected,json!({"error":"Fast não está disponível para o modelo atual"}),effects); }
                else { self.send_service_tier(effects); }
            }
            Some("service_tier_update") => {
                self.service_tier_pending.as_mut().unwrap().acknowledged = true;
                self.verify_service_tier(effects);
            }
            Some("service_tier_confirm") => {
                if result["thread"]["id"] != self.thread_id {
                    self.finish_service_tier(Disposition::Unknown,json!({"error":"O Codex confirmou outra conversa"}),effects); return;
                }
                self.restore_service_tier(result,rpc.settings_revision,effects);
                let pending = self.service_tier_pending.as_mut().unwrap();
                pending.verifying = false;
                let confirmed = rpc.settings_revision == self.settings_revision
                    && result.get("serviceTier").and_then(service_tier).as_deref() == Some(pending.tier.as_str())
                    && self.service_tier.as_deref() == Some(pending.tier.as_str());
                if confirmed {
                    let tier = pending.tier.clone();
                    self.finish_service_tier(Disposition::Accepted,json!({"service_tier":tier}),effects);
                } else { self.verify_service_tier(effects); }
            }
            _ => {},
        }
    }

    pub fn restore_rpc(&mut self,operation_id:String,frame:&Value,state_revision:u64,settings_revision:u64) {
        let Ok(request_id) = serde_json::from_value::<RequestId>(frame["id"].clone()) else { return };
        let Some(method) = frame["method"].as_str() else {
            if frame.get("result").is_some() || frame.get("error").is_some() {
                self.wires.insert(operation_id,Wire { interaction:None,request_id:None,server_request:Some(request_id),server_epoch:None,final_result:false });
            }
            return;
        };
        if self.rpc.contains_key(&request_id) { return; }
        let voice_call = self.voices.iter().find(|(_,voice)|voice.thread_id.as_deref().is_some_and(|thread|frame["params"]["threadId"] == thread))
            .map(|(call_id,_)|call_id.clone()).or_else(||(method == "thread/start" && frame["params"]["ephemeral"] == true).then(||"orphan".into()));
        // Assinatura do terminal volta como assinatura: nunca cai no `thread/resume` do sem-terminal (que grava `patch_meta`).
        let reserved = self.reservations.iter().find(|r|r.reservation.operation_id == operation_id).map(|r|r.reservation.clone());
        let continuation = if !self.headless && method == "thread/resume" && subscribe_operation(&operation_id) {
            Some(json!({"kind":"subscribe"}))
        } else if let Some(reserved) = reserved.filter(|_|!self.headless && method == "turn/start") {
            // A resposta tardia ainda fecha a reserva certa, nunca outra pergunta.
            Some(json!({"kind":"async_answer","reserved":true,"request_id":reserved.request_id,"text":reserved.text,"entry_id":reserved.entry_id}))
        } else if method == "thread/settings/update" && frame["params"].get("serviceTier").is_some() {
            Some(json!({"kind":"service_tier_recovered"}))
        } else { voice_call.map(|call_id|json!({"kind":"voice","call_id":call_id})) };
        self.rpc.insert(request_id.clone(),Rpc { operation_id:operation_id.clone(),method:method.into(),params:frame["params"].clone(),
            deadline:self.clock.monotonic_s,timed_out:true,continuation,state_revision,settings_revision });
        self.wires.insert(operation_id,Wire { interaction:None,request_id:Some(request_id),server_request:None,server_epoch:None,final_result:false });
    }

    pub fn restore_voice_scope(&mut self,operation_id:&str,call_id:&str) {
        if let Some(rpc) = self.rpc.values_mut().find(|rpc|rpc.operation_id == operation_id) {
            rpc.continuation = Some(json!({"kind":"voice","call_id":call_id}));
        }
    }

    /// Processo recém-criado pelo Rust: a subida repete a política e tem os recuos do Python.
    /// Anexar a um cano vivo mantém o resume só com `threadId`.
    pub fn set_fresh_process(&mut self,fresh:bool) { self.fresh_process = fresh; }

    pub fn problem(&self) -> Option<&str> { self.state.problema.as_deref() }
    /// Problema que o ator conhece e o motor não (a religação desistiu, o processo não subiu).
    pub fn set_problem(&mut self,code:&str,detail:Option<String>) -> Vec<Effect> {
        self.state.problema = Some(code.into());
        self.state.problema_detalhe = detail.map(|detail|detail.chars().take(300).collect());
        let mut effects = Vec::new();
        self.changed(&mut effects,false);
        effects
    }

    /// Terminal: só o WebSocket de controle caiu; TUI e app-server seguem vivos. A fila fica segura até
    /// reconectar, e o que era desta conexão encerra sem resposta inventada: RPC em voo vira incerto (nunca
    /// reenviado) e pedido que o servidor não reapresentar não ganha token respondível.
    /// `handed`: operações cujo quadro já foi entregue ao socket que caiu. As outras nunca saíram: viram
    /// `NotWritten` (o mesmo desfecho de uma escrita recusada), não incertas.
    pub fn transport_lost(&mut self,detail:&str,handed:&BTreeSet<String>) -> Vec<Effect> {
        let mut effects = Vec::new();
        if self.headless { return effects; }
        let unsent:Vec<String> = self.rpc.values().filter(|rpc|!rpc.timed_out && !handed.contains(&rpc.operation_id)).map(|rpc|rpc.operation_id.clone()).collect();
        for operation_id in unsent {
            match self.apply_input(EngineInput::WriteAck { operation_id,outcome:WriteOutcome::NotWritten },self.clock) {
                Ok(next) => effects.extend(next),
                Err(failure) => tracing::warn!(session=%self.state.session,code=%failure.code,"escrita não enviada sem desfecho na queda"),
            }
        }
        self.connected = false; self.subscribed = false; self.ready = false; self.subscribe_due = None;
        self.clear_preview(&mut effects);
        self.lost_requests.extend(self.server_requests.iter().map(|(id,_)|id.clone()));
        self.server_requests.clear(); self.answering.clear(); self.request_epochs.clear();
        self.finish_service_tier(Disposition::Unknown,json!({"error":"O Codex desconectou antes de confirmar Fast"}),&mut effects);
        let mut uncertain = Vec::new();
        for (_,rpc) in std::mem::take(&mut self.rpc) {
            uncertain.extend(reserved_entry(&rpc));
            if let Some(wire) = self.wires.get_mut(&rpc.operation_id) { wire.final_result = true; }
            if rpc.timed_out { continue; }
            effects.push(Effect::Reply { operation_id:rpc.operation_id.clone(),disposition:Disposition::Unknown,payload:json!({"error":"a conexão com o Codex caiu"}) });
            if let Some(parent) = rpc.continuation.as_ref().and_then(|next|next["parent"].as_str()) {
                effects.push(Effect::Reply { operation_id:parent.into(),disposition:Disposition::Unknown,payload:json!({"error":"a conexão com o Codex caiu"}) });
            }
        }
        for entry in uncertain { self.set_reservation(&entry,ReservationState::Uncertain); }
        self.state.problema = Some(super::codex_terminal::DISCONNECTED.into());
        self.state.problema_detalhe = Some(detail.chars().take(300).collect());
        self.changed(&mut effects,false);
        effects
    }

    pub fn bootstrap(&mut self,reconnect:bool,operation_id:String) -> Result<Vec<Effect>,RuntimeError> {
        // Terminal adota a thread que a TUI abriu: nunca cria conversa nem sobe outro processo.
        if !self.headless && self.thread_id.is_empty() { return Err(error("Codex com terminal sem conversa identificada")); }
        self.reconnect = reconnect;
        self.ready = false;
        self.connected = false; self.subscribed = false; self.subscribe_due = None; self.subscribe_wait = SUBSCRIBE_RETRY_BASE;
        let mut effects = Vec::new();
        let request = ClientRequest::Initialize(wire::InitializeParams {
            client_info:wire::ClientInfo { name:"hangar".into(),title:None,version:"0.1.0".into() },
            capabilities:Some(wire::InitializeCapabilities { experimental_api:true }) });
        let kind = if self.headless { "bootstrap" } else { "terminal_bootstrap" };
        self.send(format!("{operation_id}:initialize"),request,Some(json!({"kind":kind,"parent":operation_id})),&mut effects);
        self.stamp_turn();
        self.changed(&mut effects,true);
        Ok(effects)
    }

    /// Assinar só com `threadId` (e `cwd` fora de transferência): aprovação e sandbox são da TUI.
    fn subscribe(&mut self,effects:&mut Vec<Effect>) {
        self.subscribe_due = None;
        if self.headless || !self.connected || self.subscribed
            || self.rpc.values().any(|rpc|subscribe_rpc(rpc) && !rpc.timed_out && rpc.params["threadId"] == self.thread_id.as_str()) { return; }
        let transfer = self.metadata["transfer_id"].as_str().is_some_and(|id|!id.is_empty());
        let request = ClientRequest::ThreadResume(wire::ThreadResumeParams { thread_id:self.thread_id.clone(),
            cwd:if transfer { None } else { string(&self.metadata["cwd"]) },..Default::default() });
        self.counter += 1;
        self.send(format!("subscribe:{}:{}",self.generation,self.counter),request,Some(json!({"kind":"subscribe"})),effects);
    }

    fn schedule_subscribe(&mut self) {
        if self.headless || !self.connected || self.subscribed { return; }
        self.subscribe_due = Some(self.clock.monotonic_s + self.subscribe_wait);
        self.subscribe_wait = (self.subscribe_wait * 1.5).min(SUBSCRIBE_RETRY_MAX);
    }

    fn subscription_failed(&mut self,detail:&str,effects:&mut Vec<Effect>) {
        self.subscribe_due = None;
        tracing::warn!(session = %self.metadata["name"].as_str().unwrap_or("-"), reason = %detail, "o Codex recusou assinar a thread da TUI");
        effects.push(Effect::Diag { event:DiagEvent::CodexBootstrap,code:"thread/resume".into() });
        self.state.problema = Some("codex_conversa_nao_abriu".into());
        self.state.problema_detalhe = Some(detail.chars().take(300).collect());
    }

    /// Só `no rollout found` é "ainda não": thread inválida, recusa e falha de protocolo ficam visíveis e param.
    fn subscribe_reply(&mut self,rpc:&Rpc,line:&Value,effects:&mut Vec<Effect>) {
        let failed = !line["error"].is_null();
        effects.push(Effect::Reply { operation_id:rpc.operation_id.clone(),
            disposition:if failed { Disposition::Rejected } else { Disposition::Accepted },
            payload:if failed { json!({"error":line["error"]}) } else { json!({"subscribed":true}) } });
        // Resposta de uma conexão ou thread que já não é a atual não muda o vínculo.
        if self.headless || !self.connected || self.subscribed || rpc.params["threadId"] != self.thread_id.as_str() { return; }
        if failed {
            let message = line["error"]["message"].as_str().unwrap_or("");
            if missing_rollout(message) { self.schedule_subscribe(); } else { self.subscription_failed(message,effects); }
            self.changed(effects,false);
            return;
        }
        let result = line.get("result").cloned().unwrap_or_else(||json!({}));
        let response:wire::ThreadResumeResponse = self.decode_reply(&rpc.method,&result,effects);
        self.subscribed = true; self.ready = true; self.subscribe_due = None; self.subscribe_wait = SUBSCRIBE_RETRY_BASE;
        if self.state.problema.as_deref() == Some("codex_conversa_nao_abriu") { self.state.problema = None; self.state.problema_detalhe = None; }
        if let Some(path) = response.thread.path.clone().filter(|path|!path.is_empty()) { self.rollout_path = Some(path); }
        if rpc.settings_revision == self.settings_revision {
            self.model = self.model.clone().or(response.model.clone());
            self.effort = self.effort.clone().or(response.reasoning_effort.clone());
        }
        self.restore_thread(&response.thread,rpc);
        self.async_questions.hydrate(&self.thread_id,&result["thread"]);
        self.changed(effects,true);
        effects.push(Effect::WakeQueue);
    }

    /// A TUI abriu outra conversa principal: o vínculo a segue, e pedidos, perguntas e turno da anterior perdem a validade.
    fn thread_started(&mut self,params:&Value,effects:&mut Vec<Effect>) {
        let thread = &params["thread"];
        let Some(id) = thread["id"].as_str().filter(|id|*id != self.thread_id) else { return };
        if !primary_thread(thread,self.metadata["cwd"].as_str()) { return; }
        let previous = std::mem::replace(&mut self.thread_id,id.to_owned());
        // O vínculo das identidades segue a conversa principal: as da anterior deixam de valer.
        if let Err(failure) = self.bind_interactions() {
            tracing::warn!(session=%self.state.session,code=%failure.code,"identidades não religadas à conversa nova da TUI");
        }
        self.rollout_path = string(&thread["path"]);
        self.clear_preview(effects);
        self.in_progress = false; self.turn_id = None; self.compacting = false; self.state_revision += 1;
        self.first_response_start = None; self.response_started = false; self.state.codex_buffering = false;
        self.running_commands.clear();
        // Pedido de subagente não é da conversa anterior: continua pendente.
        let stale:Vec<RequestId> = self.server_requests.iter().filter(|(_,request)|request["params"]["threadId"] == previous.as_str())
            .map(|(id,_)|id.clone()).collect();
        for id in &stale { self.answering.remove(id); self.request_epochs.remove(id); }
        self.lost_requests.clear();
        self.server_requests.retain(|(id,_)|!stale.contains(id));
        let skipped = std::mem::take(&mut self.async_questions.skipped);
        self.async_questions = AsyncQuestions { resolved:skipped.clone(),skipped,..AsyncQuestions::default() };
        // Reserva da conversa anterior não vira turno na nova: a entrada dela é recusada ao ser reivindicada.
        self.reservations.clear();
        self.state.problema = None; self.state.problema_detalhe = None;
        // A conversa nova também nasce sem rollout: assina de novo, e o envio segue liberado pela mesma conexão.
        self.subscribed = false; self.ready = false; self.subscribe_wait = SUBSCRIBE_RETRY_BASE;
        self.policy("session.patch_meta",json!({"thread_id":self.thread_id,"rollout_path":self.rollout_path}),effects);
        self.subscribe(effects);
        self.changed(effects,true);
    }

    pub fn hydrate(&mut self,snapshot:CanoSnapshot) -> Result<Vec<Effect>,RuntimeError> {
        let mut effects = Vec::new();
        self.alive = snapshot.saiu.is_none();
        if !self.alive { self.finish_service_tier(Disposition::Unknown,json!({"error":"O Codex desconectou antes de confirmar Fast"}),&mut effects); }
        for raw in snapshot.pendentes {
            effects.extend(self.apply(EngineInput::Line(serde_json::from_str(&raw).map_err(|_|error("pedido do snapshot inválido"))?),self.clock)?);
        }
        let prefix = &snapshot.inflight["codex"][&self.thread_id];
        if prefix.is_object() {
            self.turn_id = string(&prefix["turnId"]);
            self.in_progress = self.turn_id.is_some() || prefix["text"].as_str().is_some_and(|s|!s.is_empty());
            if prefix["complete"] == false { self.preview.block(); }
            else if let Some(text) = self.preview.append(prefix["text"].as_str().unwrap_or(""),self.clock.monotonic_s) { self.publish(text,&mut effects); }
        }
        self.changed(&mut effects,true);
        for (call_id,thread_id) in self.voices.iter().filter(|(_,voice)|voice.closed).filter_map(|(call_id,voice)|
            Some((call_id.clone(),voice.thread_id.clone()?))).collect::<Vec<_>>() {
            self.close_voice_thread(&call_id,&thread_id,&mut effects);
        }
        Ok(effects)
    }

    fn publish(&self,text:String,effects:&mut Vec<Effect>) { self.publish_on("preview",text,effects); }

    fn publish_on(&self,channel:&str,text:String,effects:&mut Vec<Effect>) {
        effects.push(Effect::Publish { channel:channel.into(),data:json!({"session":self.state.session,"text":text,"md":true,"full":true,"vivo":true}) });
    }

    fn clear_preview(&mut self,effects:&mut Vec<Effect>) {
        if let Some(text) = self.preview.clear() { self.publish(text,effects); }
        if let Some(text) = self.thinking.clear() { self.publish_on("thinking",text,effects); }
    }

    fn bootstrap_start(&self) -> ClientRequest {
        ClientRequest::ThreadStart(wire::ThreadStartParams { cwd:string(&self.metadata["cwd"]),model:self.model.clone(),
            approval_policy:Some(approval(&self.permission_mode).into()),sandbox:Some(sandbox(&self.permission_mode).into()),
            service_tier:self.service_tier.clone() })
    }

    fn thread_opened(&mut self,parent:&str,effects:&mut Vec<Effect>) {
        if self.reconnect && std::mem::take(&mut self.was_working) {
            // A vida anterior estava no meio de um turno: se ele voltou `interrupted`, foi cortado.
            self.counter += 1;
            let operation_id = format!("cut-check:{}:{}",self.generation,self.counter);
            self.send(operation_id,self.thread_read(true),Some(json!({"kind":"cut_check"})),effects);
        }
        // Cano vivo já tem o esforço que a vida anterior aplicou: como no Python, religar não o reenvia.
        if let Some(effort) = self.metadata["effort"].as_str().filter(|_|self.fresh_process).map(str::to_owned) {
            let request = ClientRequest::ThreadSettingsUpdate(wire::ThreadSettingsUpdateParams { thread_id:self.thread_id.clone(),
                effort:Some(Some(effort)),..Default::default() });
            self.send(format!("{parent}:effort"),request,Some(json!({"kind":"bootstrap_ready","parent":parent})),effects);
        } else { self.ready = true; effects.push(Effect::Reply { operation_id:parent.into(),disposition:Disposition::Accepted,payload:json!({"ready":true}) }); effects.push(Effect::WakeQueue); }
    }

    /// Mesmos recuos da subida do Python: provedor sumido da config e conversa sem rollout. Transferência nunca recua.
    fn bootstrap_fallback(&mut self,rpc:&Rpc,message:&str,effects:&mut Vec<Effect>) -> bool {
        let Some(next) = rpc.continuation.as_ref().filter(|next|next["kind"] == "bootstrap_thread") else { return false };
        // Cano vivo com thread ainda sem turno: ela já está carregada nele, e o `resume` só a recusa por não ter rollout.
        if !self.fresh_process && rpc.method == "thread/resume" && message.contains("no rollout found") {
            self.async_questions.hydrate(&self.thread_id,&json!({}));
            self.thread_opened(next["parent"].as_str().unwrap_or(""),effects);
            self.changed(effects,true);
            return true;
        }
        if !self.fresh_process || rpc.method != "thread/resume" || self.metadata["transfer_id"].as_str().is_some_and(|id|!id.is_empty()) { return false }
        let parent = next["parent"].as_str().unwrap_or("");
        let request = if message.contains("Model provider") && message.contains("not found") && rpc.params.get("modelProvider").is_none() {
            let mut params = rpc.params.clone();
            params["modelProvider"] = json!("openai");
            self.rpc(format!("{parent}:thread"),"thread/resume",params,Some(next.clone()),effects);
            return true;
        } else if message.contains("no rollout found") {
            tracing::warn!(session = %self.metadata["name"].as_str().unwrap_or("-"), thread_id = %self.thread_id, "Codex sem rollout para retomar; abrindo conversa nova (thread/start)");
            self.bootstrap_start()
        } else { return false };
        self.send(format!("{parent}:thread"),request,Some(next.clone()),effects);
        true
    }

    fn thread_read(&self,include_turns:bool) -> ClientRequest {
        ClientRequest::ThreadRead(wire::ThreadReadParams { thread_id:self.thread_id.clone(),include_turns })
    }

    /// Sem `cwd` a lista vai vazia, e o Codex usa a pasta da sessão.
    fn skills_list(&self) -> ClientRequest {
        ClientRequest::SkillsList(wire::SkillsListParams { cwds:string(&self.metadata["cwd"]).into_iter().collect() })
    }

    fn terminate_after(&self,turn:&str) -> Option<Value> {
        let processes:Vec<_> = self.running_commands.values().filter(|(owner,_)|owner == turn).map(|(_,process)|process.clone()).collect();
        (!processes.is_empty()).then(||json!({"kind":"terminate_after","processes":processes}))
    }

    pub fn write_interaction(&self,id:&str) -> Option<&ExpectedInteraction> { self.wires.get(id)?.interaction.as_ref() }

    pub fn interaction_source(&self,expected:&ExpectedInteraction) -> Option<ExpectedInteraction> {
        let native = expected.native_id(None).ok()?;
        let (semantic,thread,revision) = if let Some(native) = native.as_str().filter(|id|id.starts_with("async:")) {
            let (_,question) = self.async_questions.pending.iter().find(|(id,_)|id == native)?;
            (question.clone(),self.thread_id.as_str(),None)
        } else {
            let (id,request) = self.server_requests.iter().find(|(id,_)|json!(id) == native)?;
            (request.clone(),request["params"]["threadId"].as_str()?,Some(self.request_epochs.get(id)?.to_string()))
        };
        let (key,_) = self.interactions.as_ref()?;
        Some(ExpectedInteraction { binding:InteractionBinding { key:key.clone(),conversation:self.thread_id.clone(),generation:self.generation },
            target:native_target(expected.target.kind.clone(),thread,&native),interaction_id:expected.interaction_id.clone(),
            semantic,source_revision:revision })
    }

    pub fn interaction_write_error(&self,id:&str) -> Option<RuntimeError> {
        let expected = self.wires.get(id)?.interaction.as_ref()?;
        let check = || -> Result<(),RuntimeError> {
            if self.expected(&json!({"interaction_id":expected.interaction_id}))? != *expected { return Err(runtime_error(InteractionError::Changed)); }
            let native = expected.native_id(None).map_err(runtime_error)?;
            if let Some(native) = native.as_str().filter(|id|id.starts_with("async:")) {
                let (_,question) = self.async_questions.pending.iter().find(|(id,_)|id == native).ok_or_else(||runtime_error(InteractionError::Changed))?;
                return expected.check(&native_target(InteractionKind::Question,&self.thread_id,&json!(native)),question,None).map_err(runtime_error);
            }
            let (id,request) = self.server_requests.iter().find(|(id,_)|json!(id) == native).ok_or_else(||runtime_error(InteractionError::Changed))?;
            let thread = request["params"]["threadId"].as_str().filter(|id|!id.is_empty()).ok_or_else(||runtime_error(InteractionError::Unavailable))?;
            let revision = self.request_epochs.get(id).ok_or_else(||runtime_error(InteractionError::Changed))?.to_string();
            expected.check(&native_target(expected.target.kind.clone(),thread,&native),request,Some(&revision)).map_err(runtime_error)
        };
        check().err()
    }

    pub fn set_interactions(&mut self,key:String,store:Arc<InteractionStore>) -> Result<(),RuntimeError> {
        self.interactions = Some((key,store));
        self.bind_interactions()
    }

    fn bind_interactions(&self) -> Result<(),RuntimeError> {
        if !self.thread_id.is_empty() && let Some((key,store)) = &self.interactions {
            store.bind(&InteractionBinding { key:key.clone(),conversation:self.thread_id.clone(),generation:self.generation }).map_err(runtime_error)?;
        }
        Ok(())
    }

    fn expected(&self,payload:&Value) -> Result<ExpectedInteraction,RuntimeError> {
        let supplied = payload["interaction_id"].as_str().filter(|id|!id.is_empty()).ok_or_else(||runtime_error(InteractionError::Missing))?;
        let (key,store) = self.interactions.as_ref().filter(|_|!self.thread_id.is_empty()).ok_or_else(||runtime_error(InteractionError::Unavailable))?;
        store.expected(&InteractionBinding { key:key.clone(),conversation:self.thread_id.clone(),generation:self.generation },Some(supplied)).map_err(runtime_error)
    }

    pub fn request_revision(&self,id:&RequestId) -> Option<String> { self.request_epochs.get(id).map(u64::to_string) }

    fn check_request(&self,expected:&ExpectedInteraction,kind:InteractionKind,id:&RequestId,request:&Value) -> Result<(),RuntimeError> {
        if self.answering.contains(id) { return Err(runtime_error(InteractionError::Changed)); }
        let revision = self.request_epochs.get(id).ok_or_else(||runtime_error(InteractionError::Unavailable))?.to_string();
        let thread = request["params"]["threadId"].as_str().filter(|id|!id.is_empty()).ok_or_else(||runtime_error(InteractionError::Unavailable))?;
        expected.check(&native_target(kind,thread,&json!(id)),request,Some(&revision)).map_err(runtime_error)
    }

    pub fn command(&mut self,command:RuntimeCommand,clock:ClockSample) -> Result<Vec<Effect>,RuntimeError> {
        self.clock = clock;
        // Reiniciar é a saída de um turno que nunca fecha e de um processo caído: vale trabalhando e morto.
        if self.headless && matches!(command.kind,OperationKind::Restart | OperationKind::Reload) {
            return Ok(vec![Effect::Respawn { operation_id:command.operation_id,reason:"restart".into(),patch:Value::Null,reply:json!({}) }]);
        }
        if !self.alive { return Err(error("runtime sem terminal indisponível")); }
        // Com terminal só passa o que tem execução terminal completa; o resto continua com a TUI.
        // Orientar e interromper vão pelo app-server como no adapter Python, sem nada da tabela sem terminal.
        if !self.headless && !matches!(command.kind,OperationKind::Input | OperationKind::Steer | OperationKind::Interrupt
            | OperationKind::Select | OperationKind::AnswerQuestions | OperationKind::SkipQuestion | OperationKind::DispatchAsyncAnswer) {
            return Err(error("operação ainda não atendida no Codex com terminal"));
        }
        let id = command.operation_id;
        let payload = command.payload;
        let mut effects = Vec::new();
        match command.kind {
            OperationKind::VoiceOpen | OperationKind::VoiceRpc | OperationKind::VoiceRespond | OperationKind::VoiceClose => {
                return self.voice_command(id,command.kind,payload);
            }
            OperationKind::Input => {
                if !self.deliverable() { return Ok(vec![Effect::Reply { operation_id:id,disposition:Disposition::Deferred,payload:json!({}) }]); }
                if payload["skill_name"].is_string() && payload["skill_lookup_done"] != true {
                    let next = json!({"kind":"skill_lookup","parent":id,"command":{"operation_id":id,"kind":"input","payload":payload}});
                    self.send(format!("{id}:skills"),self.skills_list(),Some(next),&mut effects);
                    self.changed(&mut effects,false);
                    return Ok(effects);
                }
                let text = payload["text"].as_str().ok_or_else(||error("mensagem sem texto"))?;
                // Sem `summary` o pensamento sai cifrado no rollout e não há o que mostrar. Com terminal
                // aprovação e resumo são da TUI: reenviar a tabela do sem-terminal sobrescreveria o `/permissions` dela.
                let headless = self.headless;
                let request = ClientRequest::TurnStart(wire::TurnStartParams { thread_id:self.thread_id.clone(),
                    approval_policy:headless.then(||approval(&self.permission_mode).into()),summary:headless.then(||"detailed".into()),
                    input:input_of(&payload,text) });
                self.send(id,request,None,&mut effects);
            }
            OperationKind::Steer => {
                if payload["skill_name"].is_string() && payload["skill_lookup_done"] != true {
                    let next = json!({"kind":"skill_lookup","parent":id,"command":{"operation_id":id,"kind":"steer","payload":payload}});
                    self.send(format!("{id}:skills"),self.skills_list(),Some(next),&mut effects);
                    self.changed(&mut effects,false);
                    return Ok(effects);
                }
                let text = payload["text"].as_str().filter(|s|!s.trim().is_empty()).ok_or_else(||error("a orientação não pode estar vazia"))?;
                let turn = payload["turn_id"].as_str().or(self.turn_id.as_deref()).ok_or_else(||error("não há turno em andamento para orientar"))?;
                if !self.in_progress { return Err(error("não há turno em andamento para orientar")); }
                let request = ClientRequest::TurnSteer(wire::TurnSteerParams { thread_id:self.thread_id.clone(),
                    expected_turn_id:turn.into(),input:input_of(&payload,text) });
                self.send(id,request,None,&mut effects);
            }
            OperationKind::Interrupt => {
                if let Some(turn) = self.turn_id.clone() {
                    let next = self.terminate_after(&turn);
                    self.send(id,ClientRequest::TurnInterrupt(wire::TurnInterruptParams { thread_id:self.thread_id.clone(),turn_id:turn }),next,&mut effects);
                } else {
                    self.send(format!("{id}:read"),self.thread_read(true),Some(json!({"kind":"interrupt","parent":id})),&mut effects);
                }
            }
            OperationKind::Compact => {
                if !self.idle() { return Err(error("espere o Codex terminar e responda às perguntas antes de compactar")); }
                self.send(id,ClientRequest::ThreadCompactStart(wire::ThreadCompactStartParams { thread_id:self.thread_id.clone() }),None,&mut effects);
            }
            OperationKind::ListModels => self.send(id,ClientRequest::ModelList(Default::default()),None,&mut effects),
            OperationKind::ListSkills => self.send(id,self.skills_list(),None,&mut effects),
            OperationKind::ReadRateLimits => self.send(id,ClientRequest::AccountRateLimitsRead,None,&mut effects),
            OperationKind::ReadSettings => self.send(id,self.thread_read(payload["include_turns"].as_bool().unwrap_or(false)),None,&mut effects),
            OperationKind::SetModel | OperationKind::SetEffort => {
                // Campo presente no pedido vence o atual; `null` no pedido limpa.
                let pick = |key:&str,current:&Option<String>|payload.get(key).map_or_else(||current.clone(),|value|string(value));
                let request = ClientRequest::ThreadSettingsUpdate(wire::ThreadSettingsUpdateParams { thread_id:self.thread_id.clone(),
                    model:Some(pick("model",&self.model)),effort:Some(pick("effort",&self.effort)),..Default::default() });
                self.send(id,request,None,&mut effects);
            }
            OperationKind::SetServiceTier => {
                let tier = payload["service_tier"].as_str().filter(|tier|["priority","default"].contains(tier))
                    .ok_or_else(||error("Escolha Fast inválida"))?;
                if !payload.as_object().is_some_and(|fields|fields.len() == 1) { return Err(error("Escolha Fast inválida")); }
                if !self.ready || self.thread_id.is_empty() { return Err(error("Sessão Codex indisponível")); }
                if self.service_tier_pending.is_some() { return Err(error("Uma escolha Fast ainda está aguardando confirmação")); }
                // Sem mudança o Codex não avisa nada e a espera só estouraria o prazo; None ainda não foi lido.
                if self.service_tier.as_deref() == Some(tier) {
                    return Ok(vec![Effect::Reply { operation_id:id,disposition:Disposition::Accepted,payload:json!({"service_tier":tier}) }]);
                }
                self.service_tier_pending = Some(ServiceTierChange { operation_id:id.clone(),thread_id:self.thread_id.clone(),model:self.model.clone(),
                    tier:tier.into(),deadline:clock.monotonic_s+10.0,acknowledged:false,candidate:false,verifying:false });
                if tier == "priority" {
                    self.send(format!("{id}:catalog"),ClientRequest::ModelList(Default::default()),Some(json!({"kind":"service_tier_catalog","parent":id})),&mut effects);
                } else { self.send_service_tier(&mut effects); }
            }
            OperationKind::SetMode => {
                let mode = payload["mode"].as_str().filter(|mode|["default","plan"].contains(mode)).ok_or_else(||error("modo Codex inválido"))?;
                self.send(format!("{id}:settings"),self.thread_read(false),Some(json!({"kind":"set_mode","parent":id,"mode":mode})),&mut effects);
            }
            OperationKind::Select => {
                let expected = self.expected(&payload)?;
                let (request_id,request) = self.server_requests.iter().find(|(id,request)|is_card(request)
                    && request["params"]["threadId"].as_str().is_some_and(|thread| native_target(InteractionKind::Approval,thread,&json!(id)) == expected.target))
                    .cloned().ok_or_else(||runtime_error(InteractionError::Changed))?;
                self.check_request(&expected,InteractionKind::Approval,&request_id,&request)?;
                let option = payload["option"].as_u64().ok_or_else(||error("opção inválida"))?;
                let invalid = || error("opção inválida");
                let result = match request["method"].as_str().unwrap_or("") {
                    "item/permissions/requestApproval" => {
                        let granted = request["params"]["permissions"].clone();
                        match option {
                            1 => json!({"permissions":granted,"scope":"turn"}),
                            2 => json!({"permissions":granted,"scope":"session"}),
                            3 => json!({"permissions":{},"scope":"turn"}),
                            _ => return Err(invalid()),
                        }
                    }
                    ELICITATION => match option { 1=>json!({"action":"accept"}),2=>json!({"action":"cancel"}),_=>return Err(invalid()) },
                    _ => json!({"decision":match option { 1=>"accept",2=>"decline",3 if !unreadable_command(&request)=>"acceptForSession",_=>return Err(invalid()) }}),
                };
                self.answer(id.clone(),request_id,result,None,&mut effects)?;
                self.wires.get_mut(&id).unwrap().interaction = Some(expected);
            }
            OperationKind::AnswerQuestions => {
                let expected = self.expected(&payload)?;
                let request_id:RequestId = serde_json::from_value(expected.native_id(payload.get("request_id")).map_err(runtime_error)?)
                    .map_err(|_|runtime_error(InteractionError::Changed))?;
                if let RequestId::String(request) = &request_id {
                    if request.starts_with("async:") {
                        let question = self.async_questions.pending.iter().find(|(key,_)|key == request).map(|(_,q)|q.clone()).ok_or_else(||error("a pergunta já foi respondida ou pertence a outra conversa"))?;
                        expected.check(&native_target(InteractionKind::Question,&self.thread_id,&json!(request_id)),&question,None).map_err(runtime_error)?;
                        let response = question_response(&question,&payload["answers"])?;
                        let answer = response["answers"]["answer"]["answers"][0].as_str().unwrap_or("");
                        let text = format!("> {}\n\n{answer}",question["questions"][0]["question"].as_str().unwrap_or(""));
                        if !self.headless {
                            // Com terminal a resposta vira entrada reservada na fila: sai quando nada segura um turno novo.
                            if let Some(existing) = self.reservations.iter().find(|r|r.reservation.request_id == *request) {
                                if existing.state == ReservationState::Reserving { return Err(error("a resposta anterior ainda está sendo registrada")); }
                                return Ok(vec![Effect::Reply { operation_id:id,disposition:Disposition::Unknown,payload:existing.reservation.reply_payload() }]);
                            }
                            self.counter += 1;
                            let entry_id = format!("async-answer:{}:{}",self.generation,self.counter);
                            let reservation = ReservedAsyncAnswer { request_id:request.clone(),interaction_id:expected.interaction_id.clone(),
                                entry_id:entry_id.clone(),operation_id:entry_id,text };
                            let command = Self::async_answer_command(&reservation,&self.thread_id,self.generation);
                            self.reservations.push(Reservation { reservation:reservation.clone(),state:ReservationState::Reserving });
                            effects.push(Effect::ReserveAsyncAnswer { operation_id:id,reservation,command });
                            self.changed(&mut effects,false);
                            return Ok(effects);
                        }
                        let next = json!({"kind":"async_answer","request_id":request,"text":text});
                        let request = ClientRequest::TurnStart(wire::TurnStartParams { thread_id:self.thread_id.clone(),
                            approval_policy:None,summary:None,input:vec![json!({"type":"text","text":text})] });
                        self.send(id.clone(),request,Some(next),&mut effects);
                        self.wires.get_mut(&id).unwrap().interaction = Some(expected);
                        self.changed(&mut effects,true);
                        return Ok(effects);
                    }
                }
                let (_,request) = self.server_requests.iter().find(|(key,_)|key == &request_id)
                    .ok_or_else(||runtime_error(InteractionError::Changed))?;
                self.check_request(&expected,InteractionKind::Question,&request_id,request)?;
                let question = Self::question_for(&request_id,request).ok_or_else(||runtime_error(InteractionError::Changed))?;
                let mut response = question_response(&question,&payload["answers"])?;
                if let Some(fields) = self.server_requests.iter().find(|(key,_)|key == &request_id).and_then(|(_,r)|form_fields(r)) {
                    response = json!({"action":"accept","content":form_content(&fields,&response)?});
                }
                self.answer(id.clone(),request_id,response,None,&mut effects)?;
                self.wires.get_mut(&id).unwrap().interaction = Some(expected);
            }
            OperationKind::SkipQuestion => {
                let expected = self.expected(&payload)?;
                let request_id:RequestId = serde_json::from_value(expected.native_id(payload.get("request_id")).map_err(runtime_error)?)
                    .map_err(|_|runtime_error(InteractionError::Changed))?;
                if let Some((_,request)) = self.server_requests.iter().find(|(key,request)|key == &request_id && form_fields(request).is_some()) {
                    self.check_request(&expected,InteractionKind::Question,&request_id,request)?;
                    self.answer(id.clone(),request_id,json!({"action":"cancel"}),None,&mut effects)?;
                    self.wires.get_mut(&id).unwrap().interaction = Some(expected);
                } else {
                    let RequestId::String(request) = request_id else { return Err(runtime_error(InteractionError::Changed)); };
                    let (_,question) = self.async_questions.pending.iter().find(|(key,_)|key == &request).ok_or_else(||runtime_error(InteractionError::Changed))?;
                    expected.check(&native_target(InteractionKind::Question,&self.thread_id,&json!(request)),question,None).map_err(runtime_error)?;
                    // Sem escrita nativa: validação e retirada ficam na mesma rodada do dono.
                    self.async_questions.skipped.insert(request.clone()); self.async_questions.resolve(&request);
                    self.policy("session.patch_meta",json!({"skipped_async_questions":self.async_questions.skipped}),&mut effects);
                    effects.push(Effect::Reply { operation_id:id,disposition:Disposition::Accepted,payload:json!({}) });
                }
            }
            OperationKind::DispatchAsyncAnswer => {
                if self.headless { return Err(error("operação interna do Codex com terminal")); }
                let supplied:ReservedAsyncAnswer = serde_json::from_value(payload.clone()).map_err(|_|error("reserva de resposta inválida"))?;
                let found = self.reservations.iter().position(|r|r.reservation == supplied);
                let usable = found.filter(|&index|self.reservations[index].state == ReservationState::Reserved && id == supplied.operation_id
                    && payload["thread_id"] == self.thread_id.as_str() && payload["generation"].as_u64() == Some(self.generation)
                    && self.async_pending(&supplied.request_id));
                let Some(_) = usable else {
                    // Pergunta encerrada, outra conversa ou reserva desconhecida: a entrada sai da fila sem turno.
                    if let Some(index) = found.filter(|&index|self.reservations[index].state == ReservationState::Reserved) { self.reservations.remove(index); }
                    return Ok(vec![Effect::Reply { operation_id:id,disposition:Disposition::Rejected,
                        payload:json!({"error":"a pergunta já foi respondida ou pertence a outra conversa","reservation":"invalid"}) }]);
                };
                if !self.async_dispatch_ready() { return Ok(vec![Effect::Reply { operation_id:id,disposition:Disposition::Deferred,payload:json!({}) }]); }
                self.set_reservation(&supplied.entry_id,ReservationState::Dispatching);
                let next = json!({"kind":"async_answer","reserved":true,"request_id":supplied.request_id,"text":supplied.text,"entry_id":supplied.entry_id});
                let request = ClientRequest::TurnStart(wire::TurnStartParams { thread_id:self.thread_id.clone(),
                    approval_policy:None,summary:None,input:vec![json!({"type":"text","text":supplied.text})] });
                self.send(id,request,Some(next),&mut effects);
            }
            OperationKind::SetPermissionMode => {
                let wanted = payload["mode"].as_str().unwrap_or("").trim();
                let mode = *MODES.iter().find(|mode|mode.eq_ignore_ascii_case(wanted)).ok_or_else(||RuntimeError::new("erro_modo_desconhecido",
                    &format!("modo desconhecido: {wanted} (os modos são: {})",MODES.join(", "))))?;
                // O `approvalPolicy` vale no próximo turno; o sandbox só muda subindo o processo de novo.
                if sandbox(mode) != sandbox(&self.permission_mode) {
                    if !self.ready { return Err(error("não foi possível confirmar o estado do turno; permissão mantida")); }
                    if self.in_progress || !self.server_requests.is_empty() {
                        return Err(RuntimeError::new("erro_permissao_ocupada","a sessão está trabalhando; mudar o sandbox reiniciaria o Codex — espere ela terminar"));
                    }
                    // O modo novo entra na vida nova; a falha antes dela deixa tudo como estava.
                    return Ok(vec![Effect::Respawn { operation_id:id,reason:"permission".into(),
                        patch:json!({"permission_mode":mode}),reply:json!({"current":mode}) }]);
                }
                self.permission_mode = mode.into();
                self.policy("session.patch_meta",json!({"permission_mode":mode}),&mut effects);
                effects.push(Effect::Reply { operation_id:id,disposition:Disposition::Accepted,payload:json!({"current":mode}) });
            }
            OperationKind::OpenTerminal => {
                if !self.idle() { return Err(error("aguarde a sessão ficar ociosa antes de mudar o sandbox ou o modo")); }
                return Err(RuntimeError::new("lifecycle_required","operação exige a barreira de lifecycle sob a mesma posse"));
            }
            OperationKind::Cwd => effects.push(Effect::Reply { operation_id:id,disposition:Disposition::Accepted,payload:self.metadata["cwd"].clone() }),
            OperationKind::Detach => effects.push(Effect::Stop { reason:"detach".into() }),
            _ => return Err(error("operação não suportada pelo Codex")),
        }
        self.changed(&mut effects,true);
        Ok(effects)
    }

    fn answer(&mut self,operation_id:String,request_id:RequestId,result:Value,rpc_error:Option<Value>,effects:&mut Vec<Effect>) -> Result<(),RuntimeError> {
        if !self.answering.insert(request_id.clone()) { return Err(error("pedido já está sendo respondido")); }
        self.wires.insert(operation_id.clone(),Wire { interaction:None,request_id:None,server_request:Some(request_id.clone()),
            server_epoch:self.request_epochs.get(&request_id).copied(),final_result:false });
        let frame = if let Some(error) = rpc_error { json!({"jsonrpc":"2.0","id":request_id,"error":error}) }
            else { json!({"jsonrpc":"2.0","id":request_id,"result":result}) };
        effects.push(Effect::Write { operation_id:Some(operation_id),frame });
        Ok(())
    }

    pub fn apply(&mut self,input:EngineInput,clock:ClockSample) -> Result<Vec<Effect>,RuntimeError> {
        let result = self.apply_input(input,clock);
        self.stamp_turn();
        result
    }

    /// Como o Python ao ver `working` vindo do stream ou da retomada: turno sem início conhecido conta
    /// a partir de agora, senão seguraria o envio para sempre (ou expiraria na hora).
    fn stamp_turn(&mut self) {
        if !self.in_progress { self.in_progress_since = None; }
        else if !self.headless && self.in_progress_since.is_none() { self.in_progress_since = Some(self.clock.monotonic_s); }
    }

    fn apply_input(&mut self,input:EngineInput,clock:ClockSample) -> Result<Vec<Effect>,RuntimeError> {
        self.clock = clock;
        let mut effects = Vec::new();
        self.expire_service_tier(&mut effects);
        match input {
            EngineInput::Line(line) => {
                if line.get("method").is_some() { self.notification(line,&mut effects)?; }
                else if line.get("id").is_some() { self.reply(line,&mut effects)?; }
                else if line["type"] == "cano_saiu" {
                    self.alive = false; self.in_progress = false; self.ready = false; self.clear_preview(&mut effects);
                    self.connected = false; self.subscribed = false; self.subscribe_due = None;
                    // Fim da vida da conexão terminal: resposta tardia a pedido desta vida não é transplantada.
                    if !self.headless { self.server_requests.clear(); self.answering.clear(); self.request_epochs.clear(); }
                    self.finish_service_tier(Disposition::Unknown,json!({"error":"O Codex desconectou antes de confirmar Fast"}),&mut effects);
                    self.state.problema = Some("headless_caiu".into()); self.changed(&mut effects,true);
                }
            }
            EngineInput::WriteAck { operation_id,outcome } => {
                if outcome != WriteOutcome::Written && self.service_tier_pending.as_ref().is_some_and(|pending|
                    pending.operation_id == operation_id || self.rpc.values().any(|rpc|rpc.operation_id == operation_id
                        && rpc.continuation.as_ref().is_some_and(|next|next["parent"] == pending.operation_id))) {
                    self.finish_service_tier(if outcome == WriteOutcome::NotWritten { Disposition::Rejected } else { Disposition::Unknown },
                        json!({"write_outcome":outcome}),&mut effects);
                }
                if let Some((call_id,id,epoch)) = self.voice_wires.get(&operation_id).cloned() {
                    if let Some(voice) = self.voices.get_mut(&call_id) {
                        if outcome == WriteOutcome::Written && voice.requests.get(&id).is_some_and(|(_,current)|*current == epoch) {
                            voice.requests.remove(&id); voice.answering.remove(&id);
                        } else if outcome == WriteOutcome::NotWritten { voice.answering.remove(&id); }
                    }
                }
                if let Some(wire) = self.wires.get_mut(&operation_id) {
                    if wire.final_result { return Ok(effects); }
                    if wire.request_id.is_some() && outcome == WriteOutcome::Written { return Ok(effects); }
                    let server = wire.server_request.clone();
                    let server_epoch = wire.server_epoch;
                    let request_id = wire.request_id.clone();
                    wire.final_result = outcome != WriteOutcome::Unknown;
                    let answered = server.is_some();
                    if let Some(id) = server {
                        if outcome == WriteOutcome::NotWritten && self.request_epochs.get(&id).copied() == server_epoch { self.answering.remove(&id); }
                        // Com terminal a escrita não decide nada: a TUI pode ter respondido antes, e o pedido só sai no `serverRequest/resolved`.
                        if self.headless && outcome == WriteOutcome::Written && self.request_epochs.get(&id).copied() == server_epoch {
                            let notice = self.server_requests.iter().find(|(key,_)|key == &id).and_then(|(_,request)|unsupported_notice(request));
                            self.server_requests.retain(|(key,_)|key != &id); self.answering.remove(&id); self.request_epochs.remove(&id);
                            if let Some(text) = notice { self.policy("local_output",json!({"text":text}),&mut effects); }
                        }
                    }
                    let reserved = request_id.as_ref().and_then(|id|self.rpc.get(id)).and_then(reserved_entry);
                    if outcome == WriteOutcome::NotWritten {
                        // Assinatura que nem saiu tenta de novo na espera crescente, senão a sessão ficaria surda calada.
                        if let Some(id) = request_id { if self.rpc.remove(&id).is_some_and(|rpc|subscribe_rpc(&rpc)) { self.schedule_subscribe(); } }
                    }
                    let disposition = if answered {
                        match (outcome,self.headless) {
                            (WriteOutcome::NotWritten,_) => Disposition::Rejected,
                            (WriteOutcome::Unknown,_) => Disposition::Unknown,
                            (WriteOutcome::Written,false) => Disposition::Unknown,
                            (WriteOutcome::Written,true) => Disposition::Accepted,
                        }
                    } else {
                        match outcome { WriteOutcome::Written=>Disposition::Accepted,
                            // Reserva que não saiu volta à fila pela mesma operação; a pergunta é conferida de novo.
                            WriteOutcome::NotWritten if reserved.is_some() => Disposition::Deferred,
                            WriteOutcome::NotWritten=>Disposition::Rejected,WriteOutcome::Unknown=>Disposition::Unknown }
                    };
                    if let Some(entry) = &reserved {
                        self.set_reservation(entry,if outcome == WriteOutcome::NotWritten { ReservationState::Reserved } else { ReservationState::Uncertain });
                    }
                    let mut payload = json!({"write_outcome":outcome});
                    if answered && !self.headless { payload["decision_confirmed"] = json!(false); }
                    effects.push(Effect::Reply { operation_id,disposition,payload });
                    self.changed(&mut effects,true);
                }
            }
            EngineInput::Tick => {
                if let Some(text) = self.preview.tick(clock.monotonic_s) { self.publish(text,&mut effects); }
                if let Some(text) = self.thinking.tick(clock.monotonic_s) { self.publish_on("thinking",text,&mut effects); }
                let mut subscribe_lost = false;
                let mut uncertain = Vec::new();
                for rpc in self.rpc.values_mut() {
                    if !rpc.timed_out && clock.monotonic_s >= rpc.deadline {
                        rpc.timed_out = true;
                        subscribe_lost |= subscribe_rpc(rpc) && rpc.params["threadId"] == self.thread_id.as_str();
                        uncertain.extend(reserved_entry(rpc));
                        effects.push(Effect::Reply { operation_id:rpc.operation_id.clone(),disposition:Disposition::Unknown,payload:json!({"error":"RPC sem resposta"}) });
                        if let Some(parent) = rpc.continuation.as_ref().and_then(|next|next["parent"].as_str()) {
                            effects.push(Effect::Reply { operation_id:parent.into(),disposition:Disposition::Unknown,payload:json!({"error":"preparação sem resposta"}) });
                        }
                    }
                }
                for entry in uncertain { self.set_reservation(&entry,ReservationState::Uncertain); }
                // Assinatura sem resposta é falha de protocolo, não "ainda sem rollout": aparece em vez de ficar ociosa.
                if subscribe_lost && !self.subscribed {
                    self.subscription_failed("thread/resume sem resposta",&mut effects);
                    self.changed(&mut effects,false);
                }
                if self.subscribe_due.is_some_and(|due|clock.monotonic_s >= due) {
                    self.subscribe(&mut effects);
                    self.changed(&mut effects,false);
                }
                // Como o Python: só libera o envio, sem dar o turno por concluído nem reenviar; `>=` evita prazo que nunca vence.
                if self.unsubscribed_turn_due().is_some_and(|due|clock.monotonic_s >= due) {
                    tracing::warn!(session = %self.metadata["name"].as_str().unwrap_or("-"),
                        "codex: turno sem confirmação há 300s numa sessão NÃO assinada — liberando envio (sem rastreio de turno)");
                    self.in_progress = false; self.in_progress_since = None; self.lost_requests.clear();
                    self.changed(&mut effects,true);
                    effects.push(Effect::WakeQueue);
                }
            }
            EngineInput::PolicyResult { request_id,payload } => {
                if let Some(mut command) = self.skill_preparations.remove(&request_id) {
                    if let Some(skill) = payload["skill"].as_object() {
                        command.payload["input"].as_array_mut().ok_or_else(||error("entrada de skill inválida"))?
                            .push(json!({"type":"skill","name":skill.get("native_name"),"path":skill.get("path")}));
                    }
                    command.payload["skill_lookup_done"] = json!(true);
                    effects.extend(self.command(command,clock)?);
                    return Ok(effects);
                }
                if let Some(kind) = self.policies.remove(&request_id) {
                    if kind == "format_status" && self.last_format_request.as_ref() == Some(&request_id) {
                        self.state.status_line = string(&payload["status_line"]); self.changed(&mut effects,false);
                    }
                }
            }
        }
        Ok(effects)
    }

    fn reply(&mut self,line:Value,effects:&mut Vec<Effect>) -> Result<(),RuntimeError> {
        let id:RequestId = serde_json::from_value(line["id"].clone()).map_err(|_|error("ID RPC inválido"))?;
        let Some(rpc) = self.rpc.remove(&id) else { return Ok(()) };
        let already_initialized = rpc.method == "initialize" && line["error"]["message"].as_str()
            .is_some_and(|message|message.to_lowercase().contains("already initialized"));
        if let Some(wire) = self.wires.get_mut(&rpc.operation_id) { wire.final_result = true; }
        if rpc.continuation.as_ref().is_some_and(|next|next["kind"].as_str().is_some_and(|kind|kind.starts_with("service_tier"))) {
            self.service_tier_reply(&rpc,&line,effects);
            self.changed(effects,false);
            return Ok(());
        }
        if subscribe_rpc(&rpc) { self.subscribe_reply(&rpc,&line,effects); return Ok(()); }
        if !line["error"].is_null() && !already_initialized {
            if rpc.method == "thread/backgroundTerminals/terminate" {
                let text = format!("O comando do turno interrompido não foi encerrado ({}): {}",
                    rpc.params["processId"].as_str().unwrap_or("?"),line["error"]["message"].as_str().unwrap_or("erro do Codex"));
                self.policy("local_output",json!({"text":text}),effects);
            }
            if voice_rpc(&rpc) && rpc.method == "thread/start" {
                if let Some(voice) = rpc.continuation.as_ref().and_then(|next|next["call_id"].as_str()).and_then(|call|self.voices.get_mut(call)) {
                    voice.starting = false;
                }
                self.release_early_voice(effects)?;
            }
            // Turno recusado pelo Codex: a reserva acaba e a pergunta continua aberta para outra resposta.
            if let Some(entry) = reserved_entry(&rpc) { self.reservations.retain(|r|r.reservation.entry_id != entry); }
            let message = line["error"]["message"].as_str().unwrap_or("");
            if self.bootstrap_fallback(&rpc,message,effects) { return Ok(()); }
            let transfer = self.metadata["transfer_id"].as_str().is_some_and(|id|!id.is_empty());
            if let Some(parent) = rpc.continuation.as_ref().filter(|next|next["kind"] == "bootstrap_ready" && !transfer).and_then(|next|next["parent"].as_str()) {
                // A conversa já está aberta: perder o nível escolhido é melhor que perder a sessão, mas aparece.
                self.state.problema = Some("codex_esforco_nao_aplicado".into());
                self.state.problema_detalhe = Some(message.chars().take(300).collect());
                self.ready = true;
                effects.push(Effect::Reply { operation_id:parent.into(),disposition:Disposition::Accepted,payload:json!({"ready":true}) });
                effects.push(Effect::WakeQueue);
                self.changed(effects,true);
                return Ok(());
            }
            // Subida recusada: a sessão nunca fica pronta, então a recusa aparece com o motivo em vez de ficar ociosa.
            if let Some(parent) = rpc.continuation.as_ref().filter(|next|matches!(next["kind"].as_str(),Some("bootstrap" | "terminal_bootstrap" | "bootstrap_thread" | "bootstrap_ready")))
                .and_then(|next|next["parent"].as_str()) {
                tracing::warn!(session = %self.metadata["name"].as_str().unwrap_or("-"), method = %rpc.method, reason = %message, "o Codex recusou abrir a conversa");
                effects.push(Effect::Diag { event:DiagEvent::CodexBootstrap,code:rpc.method.clone() });
                self.state.problema = Some("codex_conversa_nao_abriu".into());
                self.state.problema_detalhe = Some(message.chars().take(300).collect());
                effects.push(Effect::Reply { operation_id:parent.into(),disposition:Disposition::Rejected,payload:json!({"error":line["error"]}) });
                self.changed(effects,true);
                return Ok(());
            }
            // A leitura que antecede a troca de modo ou o Stop falhou: quem espera é a operação de cima.
            let operation_id = rpc.continuation.as_ref().filter(|next|next["kind"] == "set_mode" || next["kind"] == "interrupt")
                .and_then(|next|next["parent"].as_str()).map_or(rpc.operation_id,str::to_owned);
            effects.push(Effect::Reply { operation_id,disposition:Disposition::Rejected,payload:json!({"error":line["error"]}) });
            return Ok(());
        }
        let result = line.get("result").cloned().unwrap_or_else(||json!({}));
        // Turno cortado: lido da mesma decodificação do `thread/read`, uma só por linha.
        let mut cut = false;
        if voice_rpc(&rpc) {
            let call_id = rpc.continuation.as_ref().and_then(|next|next["call_id"].as_str()).unwrap_or("").to_owned();
            if rpc.method == "thread/start" {
                let thread_id = result["thread"]["id"].as_str().filter(|id|*id != self.thread_id)
                    .ok_or_else(||error("thread do organizador inválida"))?.to_owned();
                let closed = if let Some(voice) = self.voices.get_mut(&call_id) {
                    voice.thread_id = Some(thread_id.clone()); voice.starting = false; voice.closed
                } else { true };
                self.release_early_voice(effects)?;
                if closed && !rpc.timed_out { self.close_voice_thread(&call_id,&thread_id,effects); }
            } else if rpc.method == "thread/unsubscribe" {
                if let Some(voice) = self.voices.get_mut(&call_id) { voice.unsubscribed = true; }
            }
            effects.push(Effect::Reply { operation_id:rpc.operation_id,disposition:Disposition::Accepted,payload:result });
            self.changed(effects,false);
            return Ok(());
        }
        match rpc.method.as_str() {
            "initialize" => {
                self.initialized = true;
                let response:wire::InitializeResponse = self.decode_reply(&rpc.method,&result,effects);
                match hangar_codex::version::from_user_agent(&response.user_agent) {
                    Some(installed) if hangar_codex::version::differs(installed) => {
                        effects.push(Effect::Diag { event:DiagEvent::CodexVersion,code:hangar_codex::version::diag_code(installed) });
                        self.state.problema = Some("codex_versao_nao_conferida".into());
                        self.state.problema_detalhe = Some(format!("instalado {installed}, conferido {}",hangar_codex::version::CHECKED));
                    }
                    Some(installed) if hangar_codex::version::readable(installed) => {}
                    // Sem versão legível o aviso não tem com o que comparar, mas a falta fica no diário.
                    _ => effects.push(Effect::Diag { event:DiagEvent::CodexVersion,code:"codex_desconhecida".into() }),
                }
            }
            "thread/resume" | "thread/start" => {
                let response:wire::ThreadStartResponse = self.decode_reply(&rpc.method,&result,effects);
                if !response.thread.id.is_empty() && response.thread.id != self.thread_id {
                    self.finish_service_tier(Disposition::Unknown,json!({"error":"A conversa mudou antes de confirmar Fast"}),effects);
                    self.clear_preview(effects); self.thread_id = response.thread.id.clone();
                    self.bind_interactions()?;
                }
                // A vista leva o rollout: o Python recusa como velho o patch que difere dela.
                self.rollout_path = response.thread.path.clone();
                let mut patch = json!({"thread_id":self.thread_id,"rollout_path":response.thread.path});
                if rpc.settings_revision == self.settings_revision {
                    self.model = response.model.clone().or(self.model.clone());
                    self.effort = response.reasoning_effort.clone().or(self.effort.clone());
                    // Fast vai no patch da thread: sozinho, o Python o recusa enquanto o arquivo tem a thread anterior.
                    if let Some(tier) = result.get("serviceTier").and_then(service_tier) {
                        patch["service_tier"] = json!(tier); self.service_tier = Some(tier);
                    }
                }
                self.restore_thread(&response.thread,&rpc);
                self.async_questions.hydrate(&self.thread_id,&result["thread"]);
                self.policy("session.patch_meta",patch,effects);
            }
            "turn/start" => {
                // Mesmo tardia (prazo vencido), a aceitação comprova a entrada reservada.
                if let Some(entry) = reserved_entry(&rpc) { self.finish_reservation(&entry); }
                if rpc.state_revision == self.state_revision {
                    let response:wire::TurnStartResponse = self.decode_reply(&rpc.method,&result,effects);
                    self.turn_id = Some(response.turn.id).filter(|id|!id.is_empty()); self.in_progress = true; self.state_revision += 1;
                    if !self.headless { self.in_progress_since = Some(self.clock.monotonic_s); }
                }
            }
            "thread/compact/start" => {
                if rpc.state_revision == self.state_revision { self.in_progress = true; self.compacting = true; self.state_revision += 1; }
            }
            "thread/read" => {
                let response:wire::ThreadReadResponse = self.decode_reply(&rpc.method,&result,effects);
                cut = response.thread.status == wire::ThreadStatus::Idle && response.thread.turns.last().is_some_and(|turn|turn.status == "interrupted");
                self.restore_thread(&response.thread,&rpc);
                if rpc.params["includeTurns"] == true { self.async_questions.hydrate(&self.thread_id,&result["thread"]); }
            }
            "thread/settings/update" => {
                if rpc.settings_revision == self.settings_revision {
                    if rpc.params.get("model").is_some() { self.model = string(&rpc.params["model"]); }
                    if rpc.params.get("effort").is_some() { self.effort = string(&rpc.params["effort"]); }
                    let mut patch = json!({"model":self.model,"effort":self.effort});
                    // O modo vai ao arquivo da sessão: a vida nova do processo nasce dele.
                    if let Some(mode) = rpc.params["collaborationMode"]["mode"].as_str() { self.mode = Some(mode.into()); patch["mode"] = json!(mode); }
                    self.settings_revision += 1;
                    self.policy("session.patch_meta",patch,effects);
                }
            }
            "account/rateLimits/read" => {
                let response:wire::GetAccountRateLimitsResponse = self.decode_reply(&rpc.method,&result,effects);
                if response.rate_limits.limit_id.as_deref().is_none_or(|id|id == "codex") { self.rate_limits = result["rateLimits"].clone(); }
            }
            _ => {},
        }
        if let Some(next) = rpc.continuation.clone() {
            if rpc.timed_out {
                effects.push(Effect::Reply { operation_id:rpc.operation_id,disposition:Disposition::Accepted,payload:result });
                self.changed(effects,true); return Ok(());
            }
            match next["kind"].as_str() {
                Some("bootstrap") if rpc.method == "initialize" => {
                    let parent = next["parent"].as_str().unwrap_or("");
                    let notification = format!("{parent}:initialized");
                    self.wires.insert(notification.clone(),Wire { interaction:None,request_id:None,server_request:None,server_epoch:None,final_result:false });
                    effects.push(Effect::Write { operation_id:Some(notification),
                        frame:json!({"jsonrpc":"2.0","method":"initialized","params":{}}) });
                    let request = if self.reconnect && !self.thread_id.is_empty() {
                        if self.fresh_process {
                            ClientRequest::ThreadResume(wire::ThreadResumeParams { thread_id:self.thread_id.clone(),cwd:string(&self.metadata["cwd"]),
                                approval_policy:Some(approval(&self.permission_mode).into()),sandbox:Some(sandbox(&self.permission_mode).into()),
                                service_tier:self.service_tier.clone(),model_provider:None })
                        } else { ClientRequest::ThreadResume(wire::ThreadResumeParams { thread_id:self.thread_id.clone(),..Default::default() }) }
                    } else { self.bootstrap_start() };
                    self.send(format!("{parent}:thread"),request,Some(json!({"kind":"bootstrap_thread","parent":parent})),effects);
                }
                Some("terminal_bootstrap") if rpc.method == "initialize" => {
                    let parent = next["parent"].as_str().unwrap_or("");
                    let notification = format!("{parent}:initialized");
                    self.wires.insert(notification.clone(),Wire { interaction:None,request_id:None,server_request:None,server_epoch:None,final_result:false });
                    effects.push(Effect::Write { operation_id:Some(notification),
                        frame:json!({"jsonrpc":"2.0","method":"initialized","params":{}}) });
                    // Conectado já envia: a assinatura corre ao lado e não segura o primeiro turno.
                    self.connected = true;
                    if self.state.problema.as_deref() == Some(super::codex_terminal::DISCONNECTED) { self.state.problema = None; self.state.problema_detalhe = None; }
                    effects.push(Effect::Reply { operation_id:parent.into(),disposition:Disposition::Accepted,payload:json!({"connected":true,"subscribed":false}) });
                    effects.push(Effect::WakeQueue);
                    self.subscribe(effects);
                }
                Some("bootstrap_thread") => self.thread_opened(next["parent"].as_str().unwrap_or(""),effects),
                Some("bootstrap_ready") => {
                    self.ready = true;
                    effects.push(Effect::Reply { operation_id:next["parent"].as_str().unwrap_or("").into(),disposition:Disposition::Accepted,payload:json!({"ready":true}) });
                    effects.push(Effect::WakeQueue);
                }
                Some("set_mode") => {
                    let Some(model) = self.model.clone() else { return Err(error("modelo atual indisponível")); };
                    let mode = wire::CollaborationMode { mode:next["mode"].as_str().unwrap_or("").into(),
                        settings:wire::CollaborationSettings { model,reasoning_effort:self.effort.clone(),developer_instructions:None } };
                    let request = ClientRequest::ThreadSettingsUpdate(wire::ThreadSettingsUpdateParams { thread_id:self.thread_id.clone(),
                        collaboration_mode:Some(mode),..Default::default() });
                    self.send(next["parent"].as_str().unwrap_or("").into(),request,None,effects);
                }
                Some("interrupt") => {
                    let parent = next["parent"].as_str().unwrap_or("");
                    if let Some(turn) = self.turn_id.clone() {
                        let after = self.terminate_after(&turn);
                        self.send(parent.into(),ClientRequest::TurnInterrupt(wire::TurnInterruptParams { thread_id:self.thread_id.clone(),turn_id:turn }),after,effects);
                    }
                    else { effects.push(Effect::Reply { operation_id:parent.into(),disposition:Disposition::Accepted,payload:json!({"interrupted":false}) }); }
                }
                Some("terminate_after") => {
                    // O interrupt fecha o turno mas deixa vivo o comando que ele rodava.
                    for process in next["processes"].as_array().into_iter().flatten().filter_map(Value::as_str) {
                        self.running_commands.retain(|_,(_,running)|running != process);
                        self.counter += 1;
                        let operation_id = format!("terminate:{}:{}",self.generation,self.counter);
                        let request = ClientRequest::ThreadBackgroundTerminalsTerminate(wire::ThreadBackgroundTerminalsTerminateParams {
                            thread_id:self.thread_id.clone(),process_id:process.into() });
                        self.send(operation_id,request,None,effects);
                    }
                }
                Some("cut_check") => {
                    if cut {
                        self.state.problema = Some("codex_turno_cortado".into()); self.state.problema_detalhe = None;
                    }
                }
                Some("async_answer") if next["reserved"] != true => self.async_questions.record_answer(next["request_id"].as_str().unwrap_or(""),next["text"].as_str().unwrap_or("")),
                Some("skill_lookup") => {
                    let command:RuntimeCommand = serde_json::from_value(next["command"].clone()).map_err(|_|error("preparação de skill inválida"))?;
                    self.counter += 1;
                    let request_id = RequestId::String(format!("policy:{}:{}",self.generation,self.counter));
                    let name = command.payload["skill_name"].clone();
                    self.skill_preparations.insert(request_id.clone(),command);
                    effects.push(Effect::Policy { kind:"skill_catalog".into(),request_id,payload:json!({"catalog":result,"name":name}) });
                    effects.push(Effect::Reply { operation_id:rpc.operation_id,disposition:Disposition::Accepted,payload:json!({"prepared":true}) });
                    self.changed(effects,false);
                    return Ok(());
                }
                _ => {},
            }
        }
        let payload = if rpc.method == "model/list" {
            json!(self.decode_reply::<wire::ModelListResponse>(&rpc.method,&result,effects).data.into_iter().filter(|model|!model.hidden).map(|model|json!({
                "model":model.model,"displayName":model.display_name,"description":model.description,
                "efforts":model.supported_reasoning_efforts.into_iter().map(|e|json!({"value":e.reasoning_effort,"description":e.description})).collect::<Vec<_>>(),
                "defaultEffort":model.default_reasoning_effort,"serviceTiers":model.service_tiers.unwrap_or_default(),
                "defaultServiceTier":model.default_service_tier})).collect::<Vec<_>>())
        } else if rpc.continuation.is_none() && matches!(rpc.method.as_str(),"thread/read" | "thread/settings/update") {
            // Ler ou trocar a configuração responde com a configuração que vale depois dela, como o adapter Python.
            json!({"model":self.model,"effort":self.effort,"service_tier":self.service_tier,"mode":self.mode})
        } else { result };
        effects.push(Effect::Reply { operation_id:rpc.operation_id,disposition:Disposition::Accepted,payload });
        self.changed(effects,true);
        Ok(())
    }

    fn restore_thread(&mut self,thread:&wire::Thread,rpc:&Rpc) {
        if rpc.state_revision == self.state_revision {
            match thread.status {
                wire::ThreadStatus::Active => {
                    self.in_progress = true;
                    if rpc.params["includeTurns"] == true {
                        self.turn_id = thread.turns.iter().rev().find(|turn|turn.status == "inProgress").map(|turn|turn.id.clone());
                    }
                }
                wire::ThreadStatus::Idle => { self.in_progress = false; self.turn_id = None; self.state.codex_buffering = false; },
                _ => {},
            }
        }
        if rpc.settings_revision == self.settings_revision {
            if let Some(Some(model)) = &thread.model { self.model = Some(model.clone()); }
            if let Some(effort) = &thread.reasoning_effort { self.effort = effort.clone(); }
        }
    }

    fn voice_command(&mut self,id:String,kind:OperationKind,payload:Value) -> Result<Vec<Effect>,RuntimeError> {
        let call_id = payload["call_id"].as_str().filter(|id|!id.is_empty() && id.len() <= 128)
            .ok_or_else(||error("chamada de voz inválida"))?.to_owned();
        let mut effects = Vec::new();
        if kind == OperationKind::VoiceOpen {
            if !self.ready || self.voices.values().any(|voice|!voice.closed) || self.voices.contains_key(&call_id) {
                return Err(error("voz ocupada ou sessão indisponível"));
            }
            self.voices.insert(call_id.clone(),Voice::default());
            effects.push(Effect::Reply { operation_id:id,disposition:Disposition::Accepted,
                payload:json!({"call_id":call_id,"thread_id":self.thread_id,"model":self.model}) });
        } else {
            let voice = self.voices.get_mut(&call_id).ok_or_else(||error("chamada de outra geração"))?;
            if kind != OperationKind::VoiceClose && voice.closed { return Err(error("chamada encerrada")); }
            match kind {
                OperationKind::VoiceClose => {
                    voice.closed = true;
                    let thread = voice.thread_id.clone();
                    let pending = voice.starting || self.rpc.values().any(|rpc|voice_rpc(rpc)
                        && rpc.continuation.as_ref().is_some_and(|next|next["call_id"] == call_id) && rpc.method == "thread/unsubscribe");
                    if pending {
                        effects.push(Effect::Reply { operation_id:id,disposition:Disposition::Unknown,payload:json!({"closed":false}) });
                    } else if let Some(thread_id) = thread.filter(|_|!voice.unsubscribed) {
                        self.send(id,ClientRequest::ThreadUnsubscribe(wire::ThreadUnsubscribeParams { thread_id }),Some(json!({"kind":"voice","call_id":call_id})),&mut effects);
                    } else {
                        effects.push(Effect::Reply { operation_id:id,disposition:Disposition::Accepted,payload:json!({"closed":true}) });
                    }
                }
                OperationKind::VoiceRpc => {
                    let method = payload["method"].as_str().ok_or_else(||error("método de voz inválido"))?;
                    let params = payload["params"].clone();
                    if !params.is_object() { return Err(error("parâmetros de voz inválidos")); }
                    if method == "initialize" {
                        effects.push(Effect::Reply { operation_id:id,disposition:Disposition::Accepted,payload:json!({}) });
                    } else {
                        match method {
                            "config/read" if params["includeLayers"] != true => {},
                            "thread/start" if !voice.starting && voice.thread_id.is_none() && params["ephemeral"] == true
                                && params["sandbox"] == "read-only" && params["approvalPolicy"] == "never" => { voice.starting = true; },
                            "thread/realtime/start" | "thread/realtime/appendSpeech" | "thread/realtime/stop" | "turn/start" | "turn/interrupt" | "thread/unsubscribe"
                                if voice.thread_id.as_deref().is_some_and(|thread|params["threadId"] == thread) => {},
                            _=>return Err(error("RPC fora da thread organizadora")),
                        }
                        self.rpc(id,method,params,Some(json!({"kind":"voice","call_id":call_id})),&mut effects);
                    }
                }
                OperationKind::VoiceRespond => {
                    let request_id:RequestId = serde_json::from_value(payload["request_id"].clone()).map_err(|_|error("ID da ferramenta de voz inválido"))?;
                    let (_,epoch) = voice.requests.get(&request_id).ok_or_else(||error("pedido de voz já encerrado"))?;
                    if !voice.answering.insert(request_id.clone()) { return Err(error("resposta de voz já enviada")); }
                    self.voice_wires.insert(id.clone(),(call_id,request_id.clone(),*epoch));
                    self.wires.insert(id.clone(),Wire { interaction:None,request_id:None,server_request:None,server_epoch:None,final_result:false });
                    let frame = if payload.get("error").is_some_and(|error|!error.is_null()) { json!({"id":request_id,"error":payload["error"]}) }
                        else { json!({"id":request_id,"result":payload["result"]}) };
                    effects.push(Effect::Write { operation_id:Some(id),frame });
                }
                _=>return Err(error("controle de voz inválido")),
            }
        }
        self.changed(&mut effects,false);
        Ok(effects)
    }

    /// Pedidos guardados durante a abertura da voz: os da thread dela entram pelo ramo da voz, os de outras
    /// threads (subagente) seguem o fluxo normal, que não descarta pedido.
    fn release_early_voice(&mut self,effects:&mut Vec<Effect>) -> Result<(),RuntimeError> {
        let held = std::mem::take(&mut self.early_voice);
        self.early_voice_bytes = 0;
        for event in held.into_values().flatten() { self.notification(event,effects)?; }
        Ok(())
    }

    fn close_voice_thread(&mut self,call_id:&str,thread_id:&str,effects:&mut Vec<Effect>) {
        if self.rpc.values().any(|rpc|voice_rpc(rpc) && rpc.method == "thread/unsubscribe"
            && rpc.continuation.as_ref().is_some_and(|next|next["call_id"] == call_id)) { return; }
        self.counter += 1;
        let operation_id = format!("voice-cleanup:{}:{}",self.generation,self.counter);
        self.send(operation_id,ClientRequest::ThreadUnsubscribe(wire::ThreadUnsubscribeParams { thread_id:thread_id.into() }),
            Some(json!({"kind":"voice","call_id":call_id})),effects);
    }

    fn notification(&mut self,line:Value,effects:&mut Vec<Effect>) -> Result<(),RuntimeError> {
        let method = line["method"].as_str().unwrap_or("");
        let params = &line["params"];
        if method == "serverRequest/resolved" {
            if let Ok(id) = serde_json::from_value::<RequestId>(params["requestId"].clone()) {
                for voice in self.voices.values_mut() { voice.requests.remove(&id); voice.answering.remove(&id); }
            }
        }
        if let Some(call_id) = self.voices.iter().find(|(_,voice)|voice.thread_id.as_deref() == params["threadId"].as_str()
            && voice.thread_id.is_some()).map(|(call_id,_)|call_id.clone()) {
            if let Some(id) = line.get("id") {
                let id:RequestId = serde_json::from_value(id.clone()).map_err(|_|error("ID do organizador inválido"))?;
                if self.voices[&call_id].requests.get(&id).is_some_and(|(request,_)|request == &line) { return Ok(()); }
            }
            self.counter += 1;
            let epoch = self.counter;
            let voice = self.voices.get_mut(&call_id).unwrap();
            if voice.closed {
                if let Some(id) = line.get("id") {
                    let id:RequestId = serde_json::from_value(id.clone()).map_err(|_|error("ID do organizador inválido"))?;
                    let operation_id = format!("voice-ended:{}:{}",self.generation,epoch);
                    self.wires.insert(operation_id.clone(),Wire { interaction:None,request_id:None,server_request:None,server_epoch:None,final_result:false });
                    effects.push(Effect::Write { operation_id:Some(operation_id),frame:json!({"id":id,"error":{"code":-32000,"message":"chamada encerrada"}}) });
                }
                return Ok(());
            }
            if let Some(id) = line.get("id") {
                let id:RequestId = serde_json::from_value(id.clone()).map_err(|_|error("ID do organizador inválido"))?;
                voice.requests.insert(id.clone(),(line.clone(),epoch)); voice.answering.remove(&id);
            }
            effects.push(Effect::Publish { channel:"voice".into(),data:json!({"call_id":call_id,"event":line}) });
            return Ok(());
        }
        // Pedido de outra thread (subagente) entra na fila como os da principal; só o "resolvido" dele
        // também passa, para o pedido sair da fila. O resto vindo de outra thread é descartado.
        let foreign = params["threadId"].as_str().filter(|thread|*thread != self.thread_id);
        if let Some(thread) = foreign {
            if line.get("id").is_some() && self.voices.values().any(|voice|voice.starting) {
                let size = line.to_string().len();
                if self.early_voice_bytes + size > MAX_FRAME { return Err(error("pedidos iniciais da voz excederam o orçamento")); }
                let pending = self.early_voice.entry(thread.into()).or_default();
                if !pending.contains(&line) { pending.push(line.clone()); self.early_voice_bytes += size; }
                return Ok(());
            }
            if !line.get("id").is_some_and(|id|!id.is_null()) && method != "serverRequest/resolved" { return Ok(()); }
        }
        let item = &params["item"];
        if foreign.is_none() && (method == "turn/completed" || ["item/started","item/completed"].contains(&method) && ["userMessage","agentMessage"].contains(&item["type"].as_str().unwrap_or(""))
            || method == "item/tool/requestUserInput" || method.ends_with("/requestApproval")) {
            for (call_id,_) in self.voices.iter().filter(|(_,voice)|!voice.closed) {
                effects.push(Effect::Publish { channel:"voice_target".into(),data:json!({"call_id":call_id,"event":line}) });
            }
        }
        if let Some(id) = line.get("id").filter(|id|!id.is_null()) {
            let request_id:RequestId = serde_json::from_value(id.clone()).map_err(|_|error("ID de pedido do servidor inválido"))?;
            if self.server_requests.iter().any(|(id,request)|id == &request_id && request == &line) { return Ok(()); }
            self.counter += 1;
            self.request_epochs.insert(request_id.clone(),self.counter);
            self.answering.remove(&request_id);
            // Reapresentado pela conexão nova: volta a ser pedido mostrável, com identidade nova.
            self.lost_requests.remove(&request_id);
            if let Some((_,request)) = self.server_requests.iter_mut().find(|(id,_)|id == &request_id) { *request = line.clone(); }
            else { self.server_requests.push((request_id.clone(),line.clone())); }
            // Avisa aqui, uma vez por pedido: a tela relê o pedido a cada estado.
            if let Err(failure) = wire::ServerRequest::decode(method,params) {
                tracing::warn!(session=%self.state.session,method=%failure.method,error=wire::error_kind(&failure.error),"pedido do Codex fora do formato");
                effects.push(Effect::Diag { event:DiagEvent::CodexDecode,code:decode_code(&failure.method) });
            }
            let operation_id = format!("server:{}:{}",self.generation,self.counter);
            if !self.headless {
                // Com terminal a TUI também recebe o pedido: o Hangar não responde sozinho nem recusa. Do que
                // ele não mostra, só o método vai ao log, nunca os parâmetros.
                if !is_card(&line) && method != "item/tool/requestUserInput" && form_fields(&line).is_none()
                    && crate::warn_limit::allow(Some(&self.state.session),&format!("codex_tui_request:{}",decode_code(method))) {
                    tracing::info!(session=%self.state.session,method,"pedido do Codex fica com a TUI");
                }
            } else if method == "currentTime/read" {
                self.answer(operation_id,request_id,json!({"currentTimeAt":self.clock.epoch_s as i64}),None,effects)?;
            } else if method == ELICITATION {
                if !is_url_elicitation(&line) && form_fields(&line).is_none() {
                    self.answer(operation_id,request_id,json!({"action":"decline"}),None,effects)?;
                    let server = params["serverName"].as_str().unwrap_or("");
                    self.policy("local_output",json!({"text":format!("O servidor MCP `{server}` pediu um formulário que o Hangar não sabe mostrar; o pedido foi recusado.")}),effects);
                }
            } else if !is_card(&line) && method != "item/tool/requestUserInput" {
                self.answer(operation_id,request_id,Value::Null,
                    Some(json!({"code":-32601,"message":format!("{method} não é atendido pelo Hangar sem terminal")})),effects)?;
                self.policy("unknown_private",json!({"kind":method,"event":line}),effects);
            }
            self.changed(effects,true); return Ok(());
        }
        if method == "thread/started" && !self.headless { self.thread_started(params,effects); return Ok(()); }
        let mut from_raw = false;
        let notification = match wire::ServerNotification::decode(method,params) {
            Ok(notification) => notification,
            Err(failure) => {
                // Formato inesperado num método conhecido: a linha é ignorada e fica registrada.
                tracing::warn!(session=%self.state.session,method=%failure.method,error=wire::error_kind(&failure.error),"notificação do Codex fora do formato");
                effects.push(Effect::Diag { event:DiagEvent::CodexDecode,code:decode_code(&failure.method) });
                self.report_format(format!("decode:{}",failure.method),||line.clone(),effects);
                // Ciclo de vida não pode ser ignorado: a sessão ficaria `working` para sempre.
                from_raw = true;
                match lifecycle_from_raw(method,params) { Some(notification) => notification, None => return Ok(()) }
            }
        };
        use wire::ServerNotification as N;
        match notification {
            N::ServerRequestResolved(n) => {
                let request_id = n.request_id.ok_or_else(||error("ID de resolução inválido"))?;
                // Com terminal ninguém aqui recusou: o aviso de recusa é só do sem-terminal.
                let notice = self.server_requests.iter().find(|(key,_)|key == &request_id).filter(|_|self.headless).and_then(|(_,request)|unsupported_notice(request));
                if let Some(text) = notice { self.policy("local_output",json!({"text":text}),effects); }
                // Encerra só a pendência indicada; a resolução não diz quem respondeu nem o quê.
                self.server_requests.retain(|(id,_)|id != &request_id); self.answering.remove(&request_id); self.request_epochs.remove(&request_id);
                self.lost_requests.remove(&request_id);
                if self.ready_async_answer_entry().is_some() { effects.push(Effect::WakeQueue); }
            }
            N::TurnStarted(n) => {
                self.in_progress = true; self.turn_id = Some(n.turn.id).filter(|id|!id.is_empty()); self.state_revision += 1;
                self.first_response_start = self.turn_id.clone().map(|id|(id,self.clock.monotonic_s));
                self.response_started = false; self.state.codex_buffering = false; self.clear_preview(effects);
                self.state.problema = None; self.state.problema_detalhe = None;
                self.running_commands.clear();
                self.lost_requests.clear();
            }
            N::TurnCompleted(n) => {
                if !n.turn.id.is_empty() && self.turn_id.as_deref().is_some_and(|current|current != n.turn.id) { return Ok(()); }
                self.in_progress = false; self.turn_id = None; self.state_revision += 1; self.compacting = false;
                self.lost_requests.clear();
                self.first_response_start = None;
                self.state.codex_buffering = false; self.response_started = false; self.clear_preview(effects);
                self.server_requests.clear(); self.answering.clear(); self.request_epochs.clear();
                // Status lido cru não é confiável: não apaga nem cria problema, só fecha o turno.
                if from_raw {
                    // Sem o detalhe (não decodificou), mas um turno que falhou não pode parecer concluído.
                    if n.turn.status == "failed" && !matches!(self.state.problema.as_deref(),Some("codex_limite_uso" | "codex_sem_login")) {
                        self.state.problema = Some("headless_turno_erro".into()); self.state.problema_detalhe = None;
                    }
                } else if n.turn.status == "failed" {
                    let error = n.turn.error.unwrap_or_default();
                    let class = error.codex_error_info.as_ref().and_then(error_class);
                    // O `turn.error` pode vir sem `codexErrorInfo`; a causa já veio no `error` anterior.
                    if class.is_some() || !matches!(self.state.problema.as_deref(),Some("codex_limite_uso" | "codex_sem_login")) {
                        self.state.problema = Some(class.unwrap_or("headless_turno_erro").into());
                        self.state.problema_detalhe = Some(error.message).filter(|m|!m.is_empty());
                    }
                } else if retry_problem(self.state.problema.as_deref()) { self.state.problema = None; self.state.problema_detalhe = None; }
                self.changed(effects,true); effects.push(Effect::WakeQueue); return Ok(());
            }
            N::ThreadStatusChanged(n) => {
                match n.status {
                    wire::ThreadStatus::Active => self.in_progress = true,
                    wire::ThreadStatus::Idle => { self.in_progress = false; self.turn_id = None; self.state.codex_buffering = false; },
                    _ => return Ok(()),
                }
                self.state_revision += 1;
            }
            N::ThreadSettingsUpdated(n) => {
                if n.thread_id != self.thread_id { return Ok(()); }
                let settings = n.thread_settings;
                if let Some(model) = settings.model { self.model = Some(model); }
                if let Some(effort) = settings.effort { self.effort = effort; }
                if let Some(mode) = settings.collaboration_mode {
                    self.mode = Some(mode.map(|m|m.mode).filter(|m|!m.is_empty()).unwrap_or_else(||"default".into()));
                }
                self.settings_revision += 1;
                if let Some(tier) = settings.service_tier.map(|t|t.unwrap_or_else(||"default".into())).filter(|t|["priority","default"].contains(&t.as_str())) {
                    self.service_tier = Some(tier.clone());
                    self.policy("session.patch_meta",json!({"service_tier":tier}),effects);
                    if let Some(pending) = self.service_tier_pending.as_mut() {
                        if pending.tier == tier { pending.candidate = true; }
                    }
                    self.verify_service_tier(effects);
                }
            }
            N::AgentMessageDelta(n) => {
                if !n.turn_id.is_empty() && self.turn_id.as_deref().is_some_and(|current|current != n.turn_id) { return Ok(()); }
                if !n.delta.is_empty() && self.first_response_start.as_ref().is_some_and(|(id,_)|*id == n.turn_id) {
                    if let Some((_,started)) = self.first_response_start.take() {
                        effects.push(Effect::Publish { channel:"rate".into(),data:json!({"first_response":true,
                            "seconds":self.clock.monotonic_s-started,"conversation":self.thread_id}) });
                    }
                }
                self.response_started = true; self.state.codex_buffering = false;
                if let Some(text) = self.preview.append(&n.delta,self.clock.monotonic_s) { self.publish(text,effects); }
                return Ok(());
            }
            N::ReasoningSummaryTextDelta(wire::ReasoningSummaryTextDeltaNotification { turn_id,delta,.. })
            | N::ReasoningTextDelta(wire::ReasoningTextDeltaNotification { turn_id,delta,.. }) => {
                if !turn_id.is_empty() && self.turn_id.as_deref().is_some_and(|current|current != turn_id) { return Ok(()); }
                if let Some(text) = self.thinking.append(&delta,self.clock.monotonic_s) { self.publish_on("thinking",text,effects); }
                return Ok(());
            }
            N::ReasoningSummaryPartAdded(n) => {
                if !n.turn_id.is_empty() && self.turn_id.as_deref().is_some_and(|current|current != n.turn_id) { return Ok(()); }
                let piece = if n.summary_index > 0 { "\n\n" } else { "" };
                if let Some(text) = self.thinking.append(piece,self.clock.monotonic_s) { self.publish_on("thinking",text,effects); }
                return Ok(());
            }
            N::ModelRerouted(n) => {
                if n.thread_id != self.thread_id { return Ok(()); }
                self.model = n.to_model.or(self.model.clone());
                self.settings_revision += 1;
            }
            N::ItemStarted(n) | N::ItemCompleted(n) => {
                let started = method == "item/started";
                self.async_questions.observe(&self.thread_id,&n.item,&params["item"]);
                match &n.item {
                    wire::ThreadItem::ContextCompaction { .. } => self.compacting = started,
                    wire::ThreadItem::AgentMessage { .. } => self.clear_preview(effects),
                    wire::ThreadItem::Reasoning { .. } if started => {
                        if let Some(text) = self.thinking.clear() { self.publish_on("thinking",text,effects); }
                    }
                    wire::ThreadItem::CommandExecution { id,process_id } => match (started,process_id,n.turn_id.is_empty()) {
                        (true,Some(process),false) => { self.running_commands.insert(id.clone(),(n.turn_id.clone(),process.clone())); }
                        _ => { self.running_commands.remove(id); }
                    },
                    _ => {},
                }
                if !matches!(n.item,wire::ThreadItem::UserMessage { .. }) && retry_problem(self.state.problema.as_deref()) {
                    self.state.problema = None; self.state.problema_detalhe = None;
                }
            }
            N::ModelSafetyBufferingUpdated(n) => {
                if !self.in_progress || self.response_started || n.thread_id != self.thread_id { return Ok(()); }
                if self.turn_id.as_deref().is_some_and(|turn|n.turn_id != turn) { return Ok(()); }
                if let Some(buffering) = n.show_buffering_ui { self.state.codex_buffering = buffering; }
            }
            // Uso e cota seguem crus para a linha de status; o tipo só confere o formato.
            N::ThreadTokenUsageUpdated(_) => { if params["tokenUsage"].is_object() { self.token_usage = params["tokenUsage"].clone(); } }
            N::AccountRateLimitsUpdated(n) => {
                if n.rate_limits.as_ref().is_some_and(|r|r.limit_id.as_deref().is_none_or(|id|id == "codex")) { self.rate_limits = params["rateLimits"].clone(); }
                else { return Ok(()); }
            }
            N::Error(n) => {
                self.state.problema = Some(n.error.codex_error_info.as_ref().and_then(error_class)
                    .unwrap_or(if n.will_retry { "codex_sem_conexao" } else { "headless_turno_erro" }).into());
                self.state.problema_detalhe = Some(n.error.message).filter(|m|!m.is_empty());
            }
            N::HookCompleted(n) if n.run.event_name == "userPromptSubmit" && ["blocked","stopped"].contains(&n.run.status.as_str()) => {
                let source = n.run.source_path.as_deref().unwrap_or("hook");
                let normalized = source.replace('\\',"/");
                let parts:Vec<_> = normalized.split('/').collect();
                let origin = parts.iter().position(|part|*part == "cache").and_then(|index|parts.get(index+2)).copied().unwrap_or(source);
                let reason = n.run.entries.iter().find(|entry|["stop","feedback","error"].contains(&entry.kind.as_str()) && entry.text.is_some())
                    .and_then(|entry|entry.text.as_deref()).unwrap_or("");
                self.state.problema = Some("codex_prompt_bloqueado".into());
                self.state.problema_detalhe = Some(format!("{origin}: {reason}").trim_matches([' ',':']).chars().take(300).collect());
            }
            _ => return Ok(()),
        }
        self.changed(effects,true);
        Ok(())
    }

    pub fn next_deadline(&self) -> Option<f64> {
        self.preview.deadline().into_iter().chain(self.thinking.deadline()).chain(self.rpc.values().filter(|rpc|!rpc.timed_out).map(|rpc|rpc.deadline))
            .chain(self.service_tier_pending.as_ref().map(|pending|pending.deadline)).chain(self.subscribe_due).chain(self.unsubscribed_turn_due()).min_by(f64::total_cmp)
    }

    /// Só vale sem assinatura: assinada, quem fecha o turno é o `turn/completed`.
    fn unsubscribed_turn_due(&self) -> Option<f64> {
        if self.headless || self.subscribed || !self.in_progress { return None; }
        self.in_progress_since.map(|since|since + UNSUBSCRIBED_TURN_TTL)
    }

    pub fn confirm_input(&mut self,operation_id:&str) -> Vec<Effect> {
        let ids:Vec<_> = self.rpc.iter().filter(|(_,rpc)|rpc.operation_id == operation_id
            && ["turn/start","turn/steer"].contains(&rpc.method.as_str())).map(|(id,_)|id.clone()).collect();
        for id in ids { self.rpc.remove(&id); }
        if let Some(wire) = self.wires.get_mut(operation_id) { wire.final_result = true; }
        let mut effects = vec![Effect::Reply { operation_id:operation_id.into(),disposition:Disposition::Accepted,payload:json!({"confirmed":true}) }];
        // O recibo no transcript prova a resposta reservada, inclusive a que ficou incerta.
        if let Some(entry) = self.reservations.iter().find(|r|r.reservation.operation_id == operation_id).map(|r|r.reservation.entry_id.clone()) {
            self.finish_reservation(&entry);
            effects.push(Effect::StateChanged);
        }
        effects
    }

    /// Pergunta da resposta reservada que esta operação escreve; a guarda do escritor só confere se ela segue aberta.
    pub fn reserved_question(&self,operation_id:&str) -> Option<String> {
        self.rpc.values().find(|rpc|rpc.operation_id == operation_id).and_then(|rpc|rpc.continuation.as_ref())
            .filter(|next|next["kind"] == "async_answer" && next["reserved"] == true)
            .and_then(|next|next["request_id"].as_str()).map(str::to_owned)
    }

    pub fn async_question_pending(&self,request_id:&str) -> bool { self.async_pending(request_id) }

    pub fn write_is_current(&self,operation_id:&str) -> bool {
        self.wires.get(operation_id).is_none_or(|wire|(wire.request_id.is_none() || !wire.final_result)
            && wire.server_request.as_ref().is_none_or(|id|self.request_epochs.get(id).copied() == wire.server_epoch)
            // Resposta reservada só sai enquanto a pergunta dela continua aberta.
            && wire.request_id.as_ref().and_then(|id|self.rpc.get(id)).and_then(|rpc|rpc.continuation.as_ref())
                .filter(|next|next["kind"] == "async_answer" && next["reserved"] == true)
                .is_none_or(|next|next["request_id"].as_str().is_some_and(|id|self.async_pending(id))))
    }
}

fn voice_rpc(rpc:&Rpc) -> bool { rpc.continuation.as_ref().is_some_and(|next|next["kind"] == "voice") }
fn subscribe_rpc(rpc:&Rpc) -> bool { rpc.continuation.as_ref().is_some_and(|next|next["kind"] == "subscribe") }
fn reserved_entry(rpc:&Rpc) -> Option<String> {
    rpc.continuation.as_ref().filter(|next|next["kind"] == "async_answer" && next["reserved"] == true)
        .and_then(|next|next["entry_id"].as_str()).map(str::to_owned)
}

/// O id da operação é o marcador gravado na fila: `subscribe:<geração>:<n>`, formato que só `subscribe` produz.
/// Registro anterior a ele não tem esse id e continua sendo restaurado como antes.
fn subscribe_operation(operation_id:&str) -> bool {
    let mut parts = operation_id.split(':');
    parts.next() == Some("subscribe") && parts.next().is_some_and(|n|n.parse::<u64>().is_ok())
        && parts.next().is_some_and(|n|n.parse::<u64>().is_ok()) && parts.next().is_none()
}

fn question_response(question:&Value,answers:&Value) -> Result<Value,RuntimeError> {
    let questions = question["questions"].as_array().ok_or_else(||error("perguntas inválidas"))?;
    let answers = answers.as_array().filter(|answers|answers.len() == questions.len()).ok_or_else(||error("responda a todas as perguntas"))?;
    let mut result = serde_json::Map::new();
    for answer in answers {
        let id = answer["question_id"].as_str().ok_or_else(||error("a resposta não corresponde às perguntas pendentes"))?;
        let question = questions.iter().find(|q|q["id"] == id).ok_or_else(||error("a resposta não corresponde às perguntas pendentes"))?;
        if result.contains_key(id) { return Err(error("pergunta respondida duas vezes")); }
        let value = match answer["kind"].as_str() {
            Some("text") => {
                if question["options"].as_array().is_some_and(|o|!o.is_empty()) && question["isOther"] != true { return Err(error("esta pergunta não aceita resposta em texto")); }
                answer["value"].as_str().filter(|s|!s.trim().is_empty()).ok_or_else(||error("resposta vazia"))?.to_owned()
            }
            Some("option") => {
                let indices = answer["indices"].as_array().filter(|i|i.len() == 1).ok_or_else(||error("escolha uma opção válida"))?;
                let index = indices[0].as_u64().ok_or_else(||error("opção inválida"))?;
                question["options"].as_array().and_then(|options|options.get(index as usize)).and_then(|option|option["label"].as_str()).ok_or_else(||error("opção inválida"))?.into()
            }
            _ => return Err(error("responda à pergunta antes de enviar")),
        };
        result.insert(id.into(),json!({"answers":[value]}));
    }
    Ok(json!({"answers":result}))
}
