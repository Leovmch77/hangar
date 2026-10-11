//! `/interrupt`, `/select`, `/select/submit`, `/keys`, `/term-input` e `DELETE …/queue/{id}` de sessão
//! Claude e Codex, com a mesma resposta do Python (`api.py`). Daqui para baixo o Rust é o dono: falha é
//! erro com código, nunca repasse. A pergunta que o plugin segura é do Rust: o ator do terminal a
//! confere e a fecha no próprio Esc.
use std::net::SocketAddr;
use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::{ConnectInfo, Request, State};
use axum::http::StatusCode;
use axum::response::Response;
use percent_encoding::percent_decode_str;
use serde_json::{Value, json};

use super::input::{
    Diary, MSG_CODEX_CONTROL, MSG_CONTROL_DEFERRED, MSG_CONTROL_UNCONFIRMED, MSG_STEER_REFUSED, MSG_STEER_UNKNOWN, answer, codex_control,
    control_failed, diary_code, json_content_type, payload_code, runtime_failed, sem_turno,
};
use super::{Ctx, WriteRoute, admit, detail_body, invalid_body};
use crate::mods::state::random_hex;
use crate::interactions::{ExpectedInteraction, InteractionError};
use crate::routes::AppState;
use crate::runtime::gateway::EntryHandle;
use crate::runtime::protocol::{Disposition, OperationKind, RuntimeCommand, RuntimeError, RuntimeReply};
use crate::runtime::queue::Action;

type Answer = (StatusCode, Value);

const MSG_NO_TURN: &str = "Não há turno ativo para interromper.";
const MSG_CODEX_NO_TURN: &str = "Não há turno Codex ativo para interromper.";
const MSG_PERM_OPTION: &str = "opção fora do pedido de permissão";
const MSG_PANEL_OPEN: &str = "Terminal aberto nesta sessao. Feche o painel pra responder por aqui.";
const MSG_NOT_SENT: &str = "não consegui responder pelo terminal — opção NÃO enviada";
pub(super) const MSG_UNCONFIRMED_ANSWER: &str = "resposta enviada, mas nao deu pra confirmar a tempo — confira na sessao antes de responder de novo";
const MSG_NOT_MARKED: &str = "não consegui marcar essa opção no terminal — tente de novo";
const MSG_NOT_SUBMITTED: &str = "não consegui enviar as opções marcadas — tente de novo";
const MSG_NO_PERMISSION: &str = "nenhum pedido de permissão pendente";
const MSG_NOT_IN_QUEUE: &str = "entrada não está na fila";

fn ok() -> Answer { (StatusCode::OK, json!({"ok": true})) }

pub(super) fn interaction_failure(error: InteractionError) -> Answer {
    (error.status(), detail_body(error.code(), error.message(), json!({})))
}

pub(super) fn interaction_result(sent: &Result<RuntimeReply, RuntimeError>) -> Option<Answer> {
    let code = match sent {
        Err(error) => error.code.as_str(),
        Ok(reply) if reply.disposition == Disposition::Rejected => payload_code(reply)?,
        _ => return None,
    };
    InteractionError::from_code(code).map(interaction_failure)
}

pub(super) async fn expected(ctx: &Ctx, supplied: Option<&str>) -> Result<ExpectedInteraction, Answer> {
    if supplied.is_none_or(str::is_empty) { return Err(interaction_failure(InteractionError::Missing)); }
    let runtime = ctx.st.state.runtime.get().ok_or_else(|| interaction_failure(InteractionError::Unavailable))?;
    let binding = runtime.interaction_binding(&ctx.name).await.map_err(|_| interaction_failure(InteractionError::Unavailable))?;
    if binding.key != ctx.target.key || binding.generation != ctx.target.generation { return Err(interaction_failure(InteractionError::Changed)); }
    ctx.st.interactions.expected(&binding, supplied).map_err(interaction_failure)
}

fn failure(code: &str, msg: &str, params: Value) -> Answer { (StatusCode::CONFLICT, detail_body(code, msg, params)) }

/// O painel de terminal anexado trunca o pane: quem conta linha nele escolheria errado.
pub fn panel_open_refusal() -> Answer { failure("erro_terminal_aberto", MSG_PANEL_OPEN, json!({})) }

// ── /select ─────────────────────────────────────────────────────────────────────────────────────

pub fn select_plan(expected: &ExpectedInteraction, option: u64, panel_open: bool) -> Result<Value, Answer> {
    if expected.target.kind == crate::interactions::InteractionKind::Question { return Err(interaction_failure(InteractionError::Changed)); }
    let permission = expected.target.request_key.starts_with("plugin:perm:");
    if permission && !matches!(option, 1 | 2) { return Err(failure("erro_opcao_nao_convergiu", MSG_PERM_OPTION, json!({}))); }
    if !permission && panel_open { return Err(panel_open_refusal()); }
    Ok(json!({"option": option, "interaction_id": expected.interaction_id}))
}

pub fn select_terminal_answer(sent: &Result<RuntimeReply, RuntimeError>) -> (Answer, Diary) {
    if let Some(failed) = interaction_result(sent) { return (failed, None); }
    let reply = match sent {
        Ok(reply) => reply,
        // Antes da entrega: nada chegou ao pane.
        Err(error) => return ((StatusCode::SERVICE_UNAVAILABLE, detail_body("erro_opcao_nao_convergiu", MSG_NOT_SENT, json!({"detalhe": error.to_string()}))), None),
    };
    match reply.disposition {
        Disposition::Accepted => (ok(), None),
        Disposition::Deferred => (control_failed(MSG_CONTROL_DEFERRED), None),
        Disposition::Unknown => (failure("erro_sem_confirmacao_resposta", MSG_UNCONFIRMED_ANSWER, json!({})), None),
        Disposition::Rejected => {
            let code = payload_code(reply).unwrap_or("rejected");
            (failure("erro_opcao_nao_convergiu", MSG_NOT_MARKED, json!({"detalhe": code})), Some(("opcao.nao_convergiu", diary_code(code))))
        }
    }
}

/// Sem terminal a opção responde ao pedido de permissão em aberto (1 permite, 2 nega).
pub fn select_headless_answer(sent: &Result<RuntimeReply, RuntimeError>) -> Answer {
    if let Some(failed) = interaction_result(sent) { return failed; }
    let not_answered = |msg: &str| (StatusCode::SERVICE_UNAVAILABLE, detail_body("erro_opcao_nao_convergiu", &format!("não consegui responder: {msg}"), json!({})));
    match sent {
        // O ator recusa a opção sem permissão em aberto com este código (não como resposta).
        Err(error) if error.code == "no_pending_permission" => failure("erro_opcao_nao_convergiu", MSG_NO_PERMISSION, json!({})),
        Err(error) => not_answered(&error.to_string()),
        Ok(reply) => match reply.disposition {
            Disposition::Accepted => ok(),
            Disposition::Unknown => failure("erro_sem_confirmacao_resposta", MSG_UNCONFIRMED_ANSWER, json!({})),
            Disposition::Rejected => not_answered(reply.payload["error"].as_str().filter(|e| !e.is_empty()).unwrap_or(MSG_STEER_REFUSED)),
            Disposition::Deferred => not_answered(MSG_STEER_REFUSED),
        },
    }
}

/// Formas normalizáveis e inválidas seguem intactas ao FastAPI, inclusive o ID recebido.
fn parse_option(bytes: &Bytes) -> Option<(u64, Option<String>)> {
    let object = serde_json::from_slice::<Value>(bytes).ok()?;
    let object = object.as_object()?;
    if object.keys().any(|key| key != "option" && key != "interaction_id") { return None; }
    let supplied = match object.get("interaction_id") {
        None | Some(Value::Null) => None,
        Some(Value::String(id)) => Some(id.clone()),
        _ => return None,
    };
    Some((object.get("option")?.as_u64().filter(|n| (1..=50).contains(n))?, supplied))
}

fn parse_submit(bytes: &Bytes) -> Option<Option<String>> {
    let object = if bytes.is_empty() { json!({}) } else { serde_json::from_slice::<Value>(bytes).ok()? };
    let object = object.as_object()?;
    if object.keys().any(|key| key != "interaction_id") { return None; }
    match object.get("interaction_id") {
        None | Some(Value::Null) => Some(None),
        Some(Value::String(id)) => Some(Some(id.clone())),
        _ => None,
    }
}

// ── /select/submit ──────────────────────────────────────────────────────────────────────────────

pub fn submit_answer(sent: &Result<RuntimeReply, RuntimeError>) -> (Answer, Diary) {
    if let Some(failed) = interaction_result(sent) { return (failed, None); }
    let reply = match sent {
        Ok(reply) => reply,
        Err(error) => return (runtime_failed(error), None),
    };
    match reply.disposition {
        Disposition::Accepted => (ok(), None),
        Disposition::Deferred => (control_failed(MSG_CONTROL_DEFERRED), None),
        Disposition::Unknown => (failure("erro_sem_confirmacao_resposta", MSG_UNCONFIRMED_ANSWER, json!({})), None),
        Disposition::Rejected => {
            let code = payload_code(reply).unwrap_or("rejected");
            (failure("erro_opcao_nao_convergiu", MSG_NOT_SUBMITTED, json!({"detalhe": code})), Some(("opcao.envio_falhou", diary_code(code))))
        }
    }
}

// ── /interrupt, /keys, /term-input ──────────────────────────────────────────────────────────────

/// Um controle de terminal que só responde ok ou recusa; a tecla ou o texto que o ator recusa é a
/// validação do Python (`ValueError` → 400 com texto puro).
pub fn control_step_answer(sent: &Result<RuntimeReply, RuntimeError>) -> Result<(), Answer> {
    let reply = sent.as_ref().map_err(runtime_failed)?;
    match reply.disposition {
        Disposition::Accepted => Ok(()),
        Disposition::Deferred => Err(control_failed(MSG_CONTROL_DEFERRED)),
        Disposition::Rejected if payload_code(reply) == Some("key_not_allowed") => Err((StatusCode::BAD_REQUEST, json!({"detail": "tecla não permitida"}))),
        Disposition::Rejected if payload_code(reply) == Some("invalid_text") => Err((StatusCode::BAD_REQUEST, json!({"detail": "texto inválido para terminal"}))),
        _ => Err(control_failed(MSG_CONTROL_UNCONFIRMED)),
    }
}

/// O desfecho do escritor de pane do Codex com terminal, com as mesmas respostas do `control_step_answer`.
pub fn pane_step_answer(result: &crate::terminal_input::DeliveryResult) -> Result<(), Answer> {
    use crate::terminal_input::Disposition as Pane;
    match (result.disposition, result.code.as_str()) {
        (Pane::Accepted, _) => Ok(()),
        (Pane::Rejected, "key_not_allowed") => Err((StatusCode::BAD_REQUEST, json!({"detail": "tecla não permitida"}))),
        (Pane::Rejected, "invalid_text") => Err((StatusCode::BAD_REQUEST, json!({"detail": "texto inválido para terminal"}))),
        (Pane::Deferred, _) => Err(control_failed(MSG_CONTROL_DEFERRED)),
        _ => Err(control_failed(MSG_CONTROL_UNCONFIRMED)),
    }
}

pub fn interrupt_terminal_answer(sent: &Result<RuntimeReply, RuntimeError>) -> Answer {
    control_step_answer(sent).map_or_else(|refused| refused, |()| ok())
}

/// Sem turno em voo não há o que interromper; responder ok seria fingir. O Codex responde com o
/// código e a frase dele (`api.interrupt`).
pub fn interrupt_headless_answer(codex: bool, sent: &Result<RuntimeReply, RuntimeError>) -> Answer {
    if codex {
        return match sent {
            Ok(reply) if reply.disposition == Disposition::Accepted && reply.payload["interrupted"] == false => codex_control(MSG_CODEX_NO_TURN),
            Ok(reply) if reply.disposition == Disposition::Accepted => ok(),
            _ => codex_control(MSG_CODEX_CONTROL),
        };
    }
    let reply = match sent {
        Ok(reply) => reply,
        Err(error) => return sem_turno(&error.to_string()),
    };
    match reply.disposition {
        Disposition::Accepted if reply.payload["interrupted"] == false => sem_turno(MSG_NO_TURN),
        Disposition::Accepted => ok(),
        Disposition::Unknown => sem_turno(MSG_STEER_UNKNOWN),
        _ => sem_turno(reply.payload["error"].as_str().filter(|e| !e.is_empty()).unwrap_or(MSG_STEER_REFUSED)),
    }
}

/// Texto do terminal interativo: qualquer coisa, menos caractere de controle (fora `\n` e `\t`).
fn terminal_text_ok(text: &str) -> bool { !text.chars().any(|c| c.is_control() && !matches!(c, '\n' | '\t')) }

/// Os controles do `/term-input` na ordem do Python: texto, depois tecla. Texto inválido recusa antes
/// de enviar qualquer coisa.
pub fn term_input_steps(text: Option<&str>, key: Option<&str>) -> Result<Vec<(&'static str, Value)>, Answer> {
    let mut steps = Vec::new();
    if let Some(text) = text.filter(|t| !t.is_empty()) {
        if !terminal_text_ok(text) { return Err((StatusCode::BAD_REQUEST, json!({"detail": "texto inválido para terminal"}))); }
        steps.push(("terminal_input", json!({"text": text})));
    }
    if let Some(key) = key.filter(|k| !k.is_empty()) { steps.push(("interactive_key", json!({"key": key}))); }
    Ok(steps)
}

/// `clear` como o FastAPI lê um booleano de query; `None` = valor que ele recusa (422 dele).
fn parse_clear(query: Option<&str>) -> Option<bool> {
    let mut clear = Some(false);
    for pair in query.unwrap_or_default().split('&') {
        let Some(("clear", value)) = pair.split_once('=').or(Some((pair, ""))) else { continue };
        clear = match percent_decode_str(value).decode_utf8().ok()?.to_ascii_lowercase().as_str() {
            "1" | "true" | "t" | "yes" | "y" | "on" => Some(true),
            "0" | "false" | "f" | "no" | "n" | "off" => Some(false),
            _ => None,
        };
    }
    clear
}

/// `{"key": texto}` do `KeyBody` estrito.
fn parse_key(bytes: &Bytes) -> Option<String> {
    let object = serde_json::from_slice::<Value>(bytes).ok()?;
    let object = object.as_object()?;
    if object.len() != 1 { return None; }
    object.get("key")?.as_str().map(str::to_owned)
}

/// `{"text": texto|null, "key": texto|null}` do `TermInputBody` estrito, os dois opcionais.
fn parse_term_input(bytes: &Bytes) -> Option<(Option<String>, Option<String>)> {
    let object = serde_json::from_slice::<Value>(bytes).ok()?;
    let object = object.as_object()?;
    if object.keys().any(|k| k != "text" && k != "key") { return None; }
    let field = |name: &str| match object.get(name) { None | Some(Value::Null) => Some(None), Some(Value::String(s)) => Some(Some(s.clone())), Some(_) => None };
    Some((field("text")?, field("key")?))
}

// ── DELETE …/queue/{id} ─────────────────────────────────────────────────────────────────────────

pub fn queue_answer(removed: &Result<Value, RuntimeError>) -> Answer {
    match removed {
        Ok(done) if *done == json!(true) => ok(),
        Ok(_) => (StatusCode::NOT_FOUND, detail_body("erro_fila_entrada_nao_encontrada", MSG_NOT_IN_QUEUE, json!({}))),
        Err(error) => runtime_failed(error),
    }
}

// ── rotas ───────────────────────────────────────────────────────────────────────────────────────

fn report(ctx: &Ctx, diary: Diary) {
    let Some((event, code)) = diary else { return };
    let reason = if event == "opcao.nao_convergiu" { "o terminal não confirmou a opção marcada" } else { "o terminal não aceitou o envio das opções marcadas" };
    ctx.st.diag.report(event, &ctx.name, &code, reason);
}

pub async fn select(State(st): State<Arc<AppState>>, ConnectInfo(peer): ConnectInfo<SocketAddr>, req: Request) -> Response {
    let (ctx, bytes) = match admit(&st, peer, req, WriteRoute::Select).await {
        Ok(admitted) => admitted,
        Err(response) => return response,
    };
    let Some((option, supplied)) = parse_option(&bytes).filter(|_| json_content_type(ctx.headers())) else { return invalid_body(ctx.headers()) };
    let expected = match expected(&ctx, supplied.as_deref()).await { Ok(expected) => expected, Err(failed) => return answer(&ctx, failed) };
    let operation_id = random_hex(16);
    let result = match &ctx.target.handle {
        EntryHandle::Terminal { handle, .. } => match select_plan(&expected, option, st.term.is_active(&ctx.name)) {
            Err(refused) => refused,
            Ok(payload) => {
                let (answered, diary) = select_terminal_answer(&handle.control(operation_id, "select".into(), payload).await);
                report(&ctx, diary);
                answered
            }
        },
        headless => select_headless_answer(&headless.command(RuntimeCommand { operation_id, kind: OperationKind::Select,
            payload: json!({"option": option, "interaction_id": supplied}) }).await),
    };
    answer(&ctx, result)
}

pub async fn select_submit(State(st): State<Arc<AppState>>, ConnectInfo(peer): ConnectInfo<SocketAddr>, req: Request) -> Response {
    let (ctx, bytes) = match admit(&st, peer, req, WriteRoute::SelectSubmit).await {
        Ok(admitted) => admitted,
        Err(response) => return response,
    };
    let Some(supplied) = parse_submit(&bytes).filter(|_| bytes.is_empty() || json_content_type(ctx.headers())) else { return invalid_body(ctx.headers()) };
    let expected = match expected(&ctx, supplied.as_deref()).await { Ok(expected) => expected, Err(failed) => return answer(&ctx, failed) };
    // A TUI do Codex não tem a aba Submit do Claude: a pergunta dele se responde pelo `/answer`.
    if matches!(ctx.target.handle, EntryHandle::CodexTerminal { .. }) { return answer(&ctx, interaction_failure(InteractionError::Changed)); }
    let EntryHandle::Terminal { handle, .. } = &ctx.target.handle else { unreachable!("a tabela manda o sem terminal ao Python") };
    if expected.target.kind != crate::interactions::InteractionKind::Menu { return answer(&ctx, interaction_failure(InteractionError::Changed)); }
    let result = if st.term.is_active(&ctx.name) { panel_open_refusal() } else {
        let (answered, diary) = submit_answer(&handle.control(random_hex(16), "submit_selected".into(), json!({"interaction_id": supplied})).await);
        report(&ctx, diary);
        answered
    };
    answer(&ctx, result)
}

pub async fn interrupt(State(st): State<Arc<AppState>>, ConnectInfo(peer): ConnectInfo<SocketAddr>, req: Request) -> Response {
    let query = req.uri().query().map(str::to_owned);
    let (ctx, _) = match admit(&st, peer, req, WriteRoute::Interrupt).await {
        Ok(admitted) => admitted,
        Err(response) => return response,
    };
    let Some(clear) = parse_clear(query.as_deref()) else { return invalid_body(ctx.headers()) };
    let operation_id = random_hex(16);
    let result = match &ctx.target.handle {
        // O ator lê a pergunta do plugin antes do Esc e a fecha só se o Esc saiu.
        EntryHandle::Terminal { handle, .. } => interrupt_terminal_answer(&handle.control(operation_id, "interrupt".into(), json!({"clear": clear})).await),
        headless => {
            let sent = headless.command(RuntimeCommand { operation_id, kind: OperationKind::Interrupt, payload: json!({}) }).await;
            let codex = ctx.target.provider == "codex";
            if codex { super::codex::log_outcome(&ctx.name, "interrupt", &sent, "interrupção do Codex não confirmada; a rota responde 409 erro_codex_controle"); }
            interrupt_headless_answer(codex, &sent)
        }
    };
    answer(&ctx, result)
}

pub async fn keys(State(st): State<Arc<AppState>>, ConnectInfo(peer): ConnectInfo<SocketAddr>, req: Request) -> Response {
    let (ctx, bytes) = match admit(&st, peer, req, WriteRoute::Keys).await {
        Ok(admitted) => admitted,
        Err(response) => return response,
    };
    let Some(key) = parse_key(&bytes).filter(|_| json_content_type(ctx.headers())) else { return invalid_body(ctx.headers()) };
    let result = match &ctx.target.handle {
        EntryHandle::Terminal { handle, .. } => control_step_answer(&handle.control(random_hex(16), "navigation_key".into(), json!({"key": key})).await),
        // Codex com terminal: o pane é do Rust também, pelo mesmo escritor de teclas.
        EntryHandle::CodexTerminal { target, cell, .. } => pane_step_answer(&crate::runtime::codex_terminal::pane_driver(&target.terminal, cell.pane_serial(), None).key(&key, false).await),
        EntryHandle::Headless(_) => unreachable!("a tabela manda o sem terminal ao Python"),
    };
    answer(&ctx, result.map_or_else(|refused| refused, |()| ok()))
}

pub async fn term_input(State(st): State<Arc<AppState>>, ConnectInfo(peer): ConnectInfo<SocketAddr>, req: Request) -> Response {
    let (ctx, bytes) = match admit(&st, peer, req, WriteRoute::TermInput).await {
        Ok(admitted) => admitted,
        Err(response) => return response,
    };
    let Some((text, key)) = parse_term_input(&bytes).filter(|_| json_content_type(ctx.headers())) else { return invalid_body(ctx.headers()) };
    let result = match term_input_steps(text.as_deref(), key.as_deref()) {
        Err(refused) => refused,
        Ok(steps) => {
            let mut done = ok();
            for (control, payload) in steps {
                let step = match &ctx.target.handle {
                    EntryHandle::Terminal { handle, .. } => control_step_answer(&handle.control(random_hex(16), control.into(), payload).await),
                    EntryHandle::CodexTerminal { target, cell, .. } => {
                        let driver = crate::runtime::codex_terminal::pane_driver(&target.terminal, cell.pane_serial(), None);
                        pane_step_answer(&if control == "terminal_input" { driver.text(payload["text"].as_str().unwrap_or("")).await }
                            else { driver.key(payload["key"].as_str().unwrap_or(""), true).await })
                    }
                    EntryHandle::Headless(_) => unreachable!("a tabela manda o sem terminal ao Python"),
                };
                if let Err(refused) = step { done = refused; break; }
            }
            done
        }
    };
    answer(&ctx, result)
}

pub async fn queue_remove(State(st): State<Arc<AppState>>, ConnectInfo(peer): ConnectInfo<SocketAddr>, req: Request) -> Response {
    let (ctx, _) = match admit(&st, peer, req, WriteRoute::QueueRemove).await {
        Ok(admitted) => admitted,
        Err(response) => return response,
    };
    // `/api/sessions/{name}/queue/{id}`: o id é um segmento só.
    let path = ctx.parts.uri.path().to_owned();
    let segments: Vec<&str> = path.trim_start_matches("/api/sessions/").split('/').collect();
    let Some(entry_id) = (segments.len() == 3 && segments[1] == "queue").then(|| percent_decode_str(segments[2]).decode_utf8().ok()).flatten().filter(|id| !id.is_empty()) else { return invalid_body(ctx.headers()) };
    let removed = ctx.target.handle.queue(random_hex(16), Action::Remove { entry_id: entry_id.into_owned() }).await;
    answer(&ctx, queue_answer(&removed))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clear_reads_like_a_fastapi_bool() {
        assert_eq!(parse_clear(None), Some(false));
        assert_eq!(parse_clear(Some("clear=true")), Some(true));
        assert_eq!(parse_clear(Some("x=1&clear=No")), Some(false));
        assert_eq!(parse_clear(Some("clear=0&clear=on")), Some(true), "o último vale");
        assert_eq!(parse_clear(Some("clear=talvez")), None);
        assert_eq!(parse_clear(Some("clear=")), None);
        assert_eq!(parse_clear(Some("clear")), None);
    }

    #[test]
    fn terminal_text_refuses_control_characters_but_not_newline_or_tab() {
        assert!(terminal_text_ok("ls\n\tx"));
        assert!(!terminal_text_ok("a\u{1}b"));
    }
}
