//! `POST /modo-execucao` e `/recarregar` do Codex do Rust: a troca de modo e o reinício rodam no Rust do
//! começo ao fim (`runtime::codex_relaunch`), com o corpo e os códigos da rota Python (`api.py`). Sessão
//! que não é Codex do Rust segue ao Python como chegou.
use std::future::Future;
use std::net::SocketAddr;
use std::sync::Arc;

use axum::body::to_bytes;
use axum::extract::{ConnectInfo, Request, State};
use axum::http::StatusCode;
use axum::response::Response;
use serde_json::{Value, json};

use super::input::json_content_type;
use super::{BODY_LIMIT, busy_body, forward_whole, invalid_body, json_response, session_name, too_large};
use crate::routes::{AppState, cors, gate, pass};
use crate::runtime::protocol::RuntimeError;

type Outcome = Option<Result<Value, RuntimeError>>;

/// Numa tarefa própria: o cliente que desiste não corta no meio uma troca já admitida (a porta reabre
/// só quando ela termina).
async fn detached(work: impl Future<Output = Outcome> + Send + 'static) -> Outcome {
    tokio::spawn(work).await.unwrap_or_else(|_| Some(Err(RuntimeError::new("relaunch_job", "a troca foi interrompida"))))
}

/// `ModoExecucaoBody`: só `terminal`, booleano estrito.
fn terminal_field(headers: &axum::http::HeaderMap, bytes: &[u8]) -> Option<bool> {
    if !json_content_type(headers) { return None; }
    match serde_json::from_slice::<Value>(bytes).ok()? {
        Value::Object(fields) if fields.len() == 1 => fields.get("terminal")?.as_bool(),
        _ => None,
    }
}

/// O `HTTPException` do `_trocar_modo`: recusa e falha de troca são 409 `erro_troca_modo`; processo que
/// não saiu depois do kill é 500 com o código.
pub fn mode_refusal(error: &RuntimeError) -> (StatusCode, Value) {
    if error.code == "session_transfer_busy" { return (StatusCode::CONFLICT, busy_body()); }
    if crate::runtime::codex_relaunch::kill_phase(error) {
        return (StatusCode::INTERNAL_SERVER_ERROR, super::detail_body(&error.code, &error.message, json!({})));
    }
    (StatusCode::CONFLICT, super::detail_body("erro_troca_modo", &format!("não troquei de modo: {}", error.message), json!({"erro": error.message})))
}

/// O `_reload_session` do Codex: com terminal é 409; o reinício que falha é 502.
pub fn reload_refusal(error: &RuntimeError) -> (StatusCode, Value) {
    match error.code.as_str() {
        "session_transfer_busy" => (StatusCode::CONFLICT, busy_body()),
        "erro_recarregar_so_sem_terminal" => (StatusCode::CONFLICT, super::detail_body(&error.code, &error.message, json!({}))),
        _ => {
            let reason: String = error.message.chars().take(200).collect();
            (StatusCode::BAD_GATEWAY, super::detail_body("erro_codex_nao_reiniciou", &format!("o Codex não subiu de novo: {reason}"), json!({})))
        }
    }
}

pub async fn mode(State(st): State<Arc<AppState>>, ConnectInfo(peer): ConnectInfo<SocketAddr>, req: Request) -> Response {
    let (fwd, owner) = gate(&st, peer, &req);
    let runtime = st.state.runtime.get().cloned();
    let (Some(runtime), true, Some(name)) = (runtime, owner, session_name(req.uri().path()))
        else { return pass(&st, req, &fwd).await };
    let (parts, body) = req.into_parts();
    let Ok(bytes) = to_bytes(body, BODY_LIMIT).await else { return too_large(&parts.headers) };
    let Some(terminal) = terminal_field(&parts.headers, &bytes) else {
        // Corpo torto de Codex do Rust é recusado aqui; o de outra sessão segue ao Python.
        if runtime.owns_codex_terminal(&name) || runtime.owns_codex_headless(&name).await { return invalid_body(&parts.headers); }
        return forward_whole(&st, parts, bytes, &fwd).await;
    };
    let panels = Some(st.term.clone());
    let outcome = detached(async move { runtime.relaunch_codex(&name, terminal, panels).await }).await;
    let (status, body) = match outcome {
        None => return forward_whole(&st, parts, bytes, &fwd).await,
        Some(Ok(value)) => (StatusCode::OK, value),
        Some(Err(error)) => mode_refusal(&error),
    };
    // A identidade da sessão mudou (ou pode ter mudado no meio de uma falha).
    st.list.invalidate();
    let mut response = json_response(status, body);
    cors(&parts.headers, response.headers_mut());
    response
}

pub async fn reload(State(st): State<Arc<AppState>>, ConnectInfo(peer): ConnectInfo<SocketAddr>, req: Request) -> Response {
    let (fwd, owner) = gate(&st, peer, &req);
    let runtime = st.state.runtime.get().cloned();
    let (Some(runtime), true, Some(name)) = (runtime, owner, session_name(req.uri().path()))
        else { return pass(&st, req, &fwd).await };
    let outcome = detached(async move { runtime.restart_codex(&name).await }).await;
    let (status, body) = match outcome {
        None => return pass(&st, req, &fwd).await,
        Some(Ok(value)) => (StatusCode::OK, value),
        Some(Err(error)) => reload_refusal(&error),
    };
    let mut response = json_response(status, body);
    cors(req.headers(), response.headers_mut());
    response
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mode_refusals_keep_the_python_codes() {
        let (status, body) = mode_refusal(&RuntimeError::new("erro_troca_modo", "Esta política de permissões não é suportada sem terminal; a sessão foi mantida."));
        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(body["detail"]["code"], "erro_troca_modo");
        assert!(body["detail"]["msg"].as_str().unwrap().starts_with("não troquei de modo: Esta política"));
        assert_eq!(mode_refusal(&RuntimeError::new("session_transfer_busy", "x")).1["detail"]["code"], "session_transfer_busy");
        let (status, body) = mode_refusal(&RuntimeError::new("relaunch_process_alive", "O terminal ainda está encerrando; não abri outro processo."));
        assert_eq!((status, body["detail"]["code"].as_str()), (StatusCode::INTERNAL_SERVER_ERROR, Some("relaunch_process_alive")));
    }

    #[test]
    fn reload_refusals_keep_the_python_codes() {
        assert_eq!(reload_refusal(&RuntimeError::new("erro_recarregar_so_sem_terminal", "x")).0, StatusCode::CONFLICT);
        let (status, body) = reload_refusal(&RuntimeError::new("cano_nao_subiu", "binário não encontrado: codex"));
        assert_eq!((status, body["detail"]["code"].as_str()), (StatusCode::BAD_GATEWAY, Some("erro_codex_nao_reiniciou")));
    }

    #[test]
    fn only_the_strict_body_is_served_here() {
        let mut headers = axum::http::HeaderMap::new();
        headers.insert(axum::http::header::CONTENT_TYPE, "application/json".parse().unwrap());
        assert_eq!(terminal_field(&headers, br#"{"terminal":true}"#), Some(true));
        for bad in [&br#"{"terminal":1}"#[..], br#"{"terminal":true,"x":1}"#, b"[]", b"{}"] {
            assert_eq!(terminal_field(&headers, bad), None);
        }
        // Como o FastAPI: sem `Content-Type` o corpo é JSON; outro tipo não é.
        assert_eq!(terminal_field(&axum::http::HeaderMap::new(), br#"{"terminal":true}"#), Some(true));
        headers.insert(axum::http::header::CONTENT_TYPE, "text/plain".parse().unwrap());
        assert_eq!(terminal_field(&headers, br#"{"terminal":true}"#), None);
    }
}
