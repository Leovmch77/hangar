//! Pontes privadas do Rust para o que entra pelo Python (convidado 8766, Connect 8768, broadcast, grupo,
//! par, MCP): a do Codex (com e sem terminal), que também recebe o `DELETE` que ele administra, e a das
//! respostas de pergunta do Claude. O Python já autenticou e só repassa, num sentido: aqui a escrita roda
//! como a do dono, com o corpo intacto, e o que o Rust não atende volta como 421, para o Python tratar
//! sozinho (nunca outro repasse ao Rust).
use std::net::SocketAddr;
use std::sync::Arc;

use axum::extract::{ConnectInfo, Request, State};
use axum::http::{Method, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use percent_encoding::{NON_ALPHANUMERIC, percent_decode_str, utf8_percent_encode};
use serde_json::json;

use crate::routes::AppState;

/// Marca do pedido repassado pela ponte: o `gate` o trata como do dono e o `pass` nunca o devolve ao Python.
#[derive(Clone, Copy, Debug)]
pub(crate) struct BridgedOwner;

fn not_ours() -> Response { StatusCode::MISDIRECTED_REQUEST.into_response() }

/// Nome (sem o escape) e rota de `<prefixo><nome>/<rota>`.
fn split(req: &Request, prefix: &str) -> Option<(String, String)> {
    let (raw, rest) = req.uri().path().strip_prefix(prefix)?.split_once('/')?;
    Some((percent_decode_str(raw).decode_utf8().ok()?.into_owned(), rest.to_owned()))
}

/// Vira o pedido do dono em `/api/sessions/<nome>/<rota>`, com a mesma consulta e sem as credenciais de
/// quem chegou ao Python.
fn as_owner(req: &mut Request, name: &str, rest: &str) -> bool {
    let query = req.uri().query().map(|q| format!("?{q}")).unwrap_or_default();
    let Ok(uri) = format!("/api/sessions/{}/{rest}{query}", utf8_percent_encode(name, NON_ALPHANUMERIC)).parse::<Uri>() else { return false };
    *req.uri_mut() = uri;
    for header in ["x-hangar-internal", "x-forwarded-for", "authorization", "cookie"] { req.headers_mut().remove(header); }
    req.extensions_mut().insert(BridgedOwner);
    true
}

/// `/__hangar_server/claude/<nome>/<rota>`: `POST` em `answer`, `select`, `select/submit` e
/// `permission-mode`, e `GET` em `permission-modes`, de sessão Claude com entrada no Rust, pela mesma rota
/// do dono. Outra rota, método ou sessão: 421.
pub async fn claude(State(st): State<Arc<AppState>>, ConnectInfo(peer): ConnectInfo<SocketAddr>, mut req: Request) -> Response {
    use super::{answer, control, permissions};
    if !crate::workspace_routes::private_ok(&st, peer, req.headers()) { return StatusCode::NOT_FOUND.into_response(); }
    let Some((name, rest)) = split(&req, "/__hangar_server/claude/") else { return not_ours() };
    let allowed = match *req.method() {
        Method::POST => matches!(rest.as_str(), "answer" | "select" | "select/submit" | "permission-mode"),
        Method::GET => rest == "permission-modes",
        _ => false,
    };
    if !allowed { return not_ours(); }
    let Some(runtime) = st.state.runtime.get().cloned() else { return not_ours() };
    if !runtime.writable(&name).await.is_some_and(|target| target.provider == "claude") { return not_ours(); }
    if !as_owner(&mut req, &name, &rest) { return not_ours(); }
    let (s, c) = (State(st), ConnectInfo(peer));
    match rest.as_str() {
        "answer" => answer::answer(s, c, req).await,
        "select" => control::select(s, c, req).await,
        "permission-mode" => permissions::set_mode(s, c, req).await,
        "permission-modes" => permissions::modes(s, c, req).await,
        _ => control::select_submit(s, c, req).await,
    }
}

/// `/__hangar_server/codex/<nome>/<rota>`: `kill` (POST) encerra a vida; o resto é a rota de
/// `/api/sessions/<nome>/<rota>`, com o mesmo método, corpo e consulta.
pub async fn codex(State(st): State<Arc<AppState>>, ConnectInfo(peer): ConnectInfo<SocketAddr>, mut req: Request) -> Response {
    if !crate::workspace_routes::private_ok(&st, peer, req.headers()) { return StatusCode::NOT_FOUND.into_response(); }
    let Some((name, rest)) = split(&req, "/__hangar_server/codex/") else { return not_ours() };
    let Some(runtime) = st.state.runtime.get().cloned() else { return not_ours() };
    let method = req.method().as_str().to_owned();
    let outcome = match (method.as_str(), rest.as_str()) {
        ("POST", "kill") => runtime.kill_codex_terminal(&name).await,
        _ => {
            if !runtime.owns_codex_terminal(&name) && !runtime.owns_codex_headless(&name).await {
                match runtime.adopt_now(&name).await {
                    None => return not_ours(),
                    Some(Err(error)) => return super::detail(StatusCode::SERVICE_UNAVAILABLE, &error.code, &error.message, json!({})),
                    Some(Ok(())) => {}
                }
            }
            if !as_owner(&mut req, &name, &rest) { return not_ours(); }
            return dispatch(st, peer, &method, &rest, req).await;
        }
    };
    match outcome {
        None => not_ours(),
        Some(Ok(value)) => super::json_response(StatusCode::OK, value),
        Some(Err(error)) => super::detail(StatusCode::CONFLICT, &error.code, &error.message, json!({})),
    }
}

/// Marca do `DELETE` que o Rust já encerrou e repassa: o valor é o segredo interno, e o Python, ao vê-la,
/// limpa só as lojas dele, sem voltar ao Rust.
pub const RUST_CLOSED: &str = "x-hangar-rust-closed";
/// Transcript (percent-encoded) da sessão que o Rust encerrou, junto da marca.
pub const CLOSED_TRANSCRIPT: &str = "x-hangar-closed-transcript";

/// `DELETE /api/sessions/{name}` do dono. Codex com terminal do Rust: encerra aqui (pane, ator, app-server,
/// sidecar, fila e saída do grupo) e só então repassa o pedido marcado ao Python, para convites, "then",
/// terminais de atalho e caches dele. Falha no encerramento responde com o código e não repassa. Outra
/// sessão segue ao Python como chegou.
pub async fn delete(State(st): State<Arc<AppState>>, ConnectInfo(peer): ConnectInfo<SocketAddr>, mut req: Request) -> Response {
    let (fwd, owner) = crate::routes::gate(&st, peer, &req);
    // Só o próprio Rust põe a marca: a que vier de fora sai antes de qualquer decisão.
    req.headers_mut().remove(RUST_CLOSED);
    req.headers_mut().remove(CLOSED_TRANSCRIPT);
    let name = super::session_name(req.uri().path());
    // Sem vigia (sem as pastas da lista), `kill_codex_terminal` é `None`.
    let (Some(runtime), true, Some(name)) = (st.state.runtime.get().cloned(), owner, name)
        else { return crate::routes::pass(&st, req, &fwd).await };
    match runtime.kill_codex_terminal(&name).await {
        None => return crate::routes::pass(&st, req, &fwd).await,
        Some(Err(error)) => {
            let mut response = super::detail(StatusCode::INTERNAL_SERVER_ERROR, &error.code, &error.message, json!({}));
            crate::routes::cors(req.headers(), response.headers_mut());
            return response;
        }
        Some(Ok(closed)) => {
            // Só o caminho da conversa, para o Python guardar o nome fechado; sem ele, o Python registra a falta.
            if let Some(path) = closed["transcript"].as_str() {
                let encoded = percent_encoding::utf8_percent_encode(path, percent_encoding::NON_ALPHANUMERIC).to_string();
                if let Ok(value) = axum::http::HeaderValue::from_str(&encoded) { req.headers_mut().insert(CLOSED_TRANSCRIPT, value); }
            }
        }
    }
    if let Some(groups) = st.groups.clone() {
        match crate::groups::exit::leave_and_notify(&st, &groups, &name).await {
            Ok((_, warnings)) if !warnings.is_empty() => tracing::warn!(session = %name, avisos = warnings.len(), "aviso de saída do grupo falhou ao encerrar"),
            Err(error) => tracing::warn!(session = %name, error = %error, "saída do grupo falhou ao encerrar o Codex com terminal"),
            _ => {}
        }
    }
    // Convites e par da sessão são do Rust: o Python marcado não volta a pedir a revogação.
    if let Some(share) = st.share.clone() {
        match share.store.revoke_session(&name, None) {
            Ok(0) => {}
            Ok(_) => crate::share::owner_routes::sync_tunnel(&share).await,
            Err(error) => tracing::error!(session = %name, code = "share_store_failed", "convites da sessão encerrada não revogados: {error}"),
        }
    }
    st.list.forget(&name);
    st.list.invalidate();
    match axum::http::HeaderValue::from_str(&st.cfg.internal_secret) {
        Ok(mark) => { req.headers_mut().insert(RUST_CLOSED, mark); }
        // Sem a marca o Python tentaria encerrar de novo pela ponte: não repassa, e a limpeza dele que
        // não rodou vai no aviso.
        Err(_) => {
            tracing::error!(session = %name, code = "close_python_cleanup_skipped", "segredo interno não vira cabeçalho; limpeza do Python não rodou");
            let warning = json!({"code": "close_python_cleanup_skipped", "params": {},
                "msg": "Sessão encerrada, mas convites, atalhos e caches dela não foram limpos."});
            let mut response = super::json_response(StatusCode::OK, json!({"ok": true, "warning": warning}));
            crate::routes::cors(req.headers(), response.headers_mut());
            return response;
        }
    }
    crate::routes::pass(&st, req, &fwd).await
}

/// As rotas que o Rust atende para o Codex dele; outra cai no Python (421).
async fn dispatch(st: Arc<AppState>, peer: SocketAddr, method: &str, rest: &str, req: Request) -> Response {
    use super::{answer, codex, control, input, relaunch};
    let (s, c) = (State(st), ConnectInfo(peer));
    match (method, rest) {
        ("POST", "input") => input::input(s, c, req).await,
        ("POST", "steer") => input::steer(s, c, req).await,
        ("POST", "interrupt") => control::interrupt(s, c, req).await,
        ("POST", "select") => control::select(s, c, req).await,
        ("POST", "select/submit") => control::select_submit(s, c, req).await,
        ("POST", "answer") => answer::answer(s, c, req).await,
        ("POST", "keys") => control::keys(s, c, req).await,
        ("POST", "term-input") => control::term_input(s, c, req).await,
        ("DELETE", queue) if queue.starts_with("queue/") => control::queue_remove(s, c, req).await,
        ("GET", "models") => codex::models(s, c, req).await,
        ("POST", "model") => codex::model(s, c, req).await,
        ("POST", "service-tier") => codex::service_tier(s, c, req).await,
        ("POST", "codex/mode") => codex::mode(s, c, req).await,
        ("POST", "codex/plan/implement") => codex::plan_implement(s, c, req).await,
        ("GET", "limits") => codex::limits(s, c, req).await,
        ("POST", "question/skip") => codex::skip_question(s, c, req).await,
        ("GET", "commands") => codex::commands(s, c, req).await,
        ("GET", "codex-permissions") => codex::permissions(s, c, req).await,
        ("POST", "codex-permissions") => codex::set_permission(s, c, req).await,
        ("POST", "modo-execucao") => relaunch::mode(s, c, req).await,
        ("POST", "recarregar") => relaunch::reload(s, c, req).await,
        _ => not_ours(),
    }
}
