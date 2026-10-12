//! Rotas do dono para compartilhar uma sessão (`share_api.py`) e a varredura de convites e Funnel.
//!
//! Só o dono chega aqui: quem monta o roteador põe a checagem de dono na frente.
use std::panic::AssertUnwindSafe;
use std::sync::Arc;
use std::time::Duration;

use axum::{Router, extract::{Path, RawQuery, State}, http::{StatusCode, header}, response::{IntoResponse, Response}, routing::{delete, get}};
use futures_util::FutureExt;
use futures_util::future::BoxFuture;
use serde_json::{Value, json};

use super::store::Kind;
use super::tunnel::{self, DynTailscale, GUEST_PORT, Output, Tailscale, TunnelError};
use super::{ShareState, life};
use crate::share_reach::{InviteLink, Probe, check_until};

/// O Funnel sobrevive um pouco ao último convite: o convidado ainda conectado precisa alcançar
/// o servidor para receber o "encerrado" em vez de parecer que a máquina caiu.
pub const ENDED_GRACE: Duration = Duration::from_secs(120);
pub const SWEEP_EVERY: Duration = Duration::from_secs(60);

/// Rede da casa: os testes trocam por um falso, a 8766 desta máquina pode estar em uso.
pub trait LocalNet: Send + Sync {
    fn lan_ip(&self) -> String;
    fn listening<'a>(&'a self, ip: &'a str, port: u16) -> BoxFuture<'a, bool>;
}

pub struct RealNet;

impl LocalNet for RealNet {
    // Nenhum pacote sai: o `connect` em UDP só escolhe a interface de saída.
    fn lan_ip(&self) -> String {
        std::net::UdpSocket::bind("0.0.0.0:0")
            .and_then(|s| { s.connect("8.8.8.8:80")?; s.local_addr() })
            .map(|a| a.ip().to_string()).unwrap_or_else(|_| "127.0.0.1".into())
    }
    fn listening<'a>(&'a self, ip: &'a str, port: u16) -> BoxFuture<'a, bool> {
        Box::pin(async move {
            matches!(tokio::time::timeout(Duration::from_secs(1), tokio::net::TcpStream::connect((ip, port))).await, Ok(Ok(_)))
        })
    }
}

pub struct Reach { pub probe: Probe, pub every: Duration, pub deadline: Duration }

impl Reach {
    // Mesmos valores da rota `/api/share/reachability`.
    pub fn production() -> Self {
        Self { probe: Probe::production(), every: Duration::from_secs(5), deadline: Duration::from_secs(180) }
    }
}

pub struct OwnerShareState {
    pub share: Arc<ShareState>,
    /// Porta da API do dono: igual à do convite, o Funnel exporia a API na internet.
    pub owner_port: u16,
    /// Endereço de escuta configurado (`CP_LAN_BIND_IP`).
    pub bind_ip: String,
    pub net: Arc<dyn LocalNet>,
    pub reach: Reach,
}

type St = State<Arc<OwnerShareState>>;

// Pelo `impl Tailscale for Arc<dyn …>` o rustc não prova `Send` no handler do axum ("not general
// enough"); com `async fn` concreto, como o `tunnel::Real`, prova.
pub(super) struct Ts<'a>(pub(super) &'a Arc<dyn DynTailscale>);

impl Tailscale for Ts<'_> {
    // `**`: no próprio `Arc` o `DynTailscale` cai no `impl` do `Arc` e chama a si mesmo.
    async fn run(&self, args: &[&str]) -> Result<Output, String> { (**self.0).run_boxed(args).await }
    fn needs_operator(&self) -> bool { (**self.0).needs_operator_dyn() }
    fn user(&self) -> String { (**self.0).user_dyn() }
}

pub(super) fn json_response(status: StatusCode, v: Value) -> Response {
    (status, [(header::CONTENT_TYPE, "application/json")], v.to_string()).into_response()
}

pub(super) fn refused(status: StatusCode, code: &str, msg: &str, params: Value) -> Response {
    json_response(status, json!({"detail": {"code": code, "params": params, "msg": msg}}))
}

// O Python não tratava falha de disco: virava o 500 cru do servidor.
pub(super) fn io_failed(e: std::io::Error) -> Response {
    tracing::warn!(%e, "[share] gravar shares.json falhou");
    (StatusCode::INTERNAL_SERVER_ERROR, "Internal Server Error").into_response()
}

/// O link só sai depois de abrir pela internet; falhou, o convite `id` é revogado e a recusa volta.
pub(super) async fn reach_or_revoke(st: &OwnerShareState, base: &str, path: String, id: &str) -> Option<Response> {
    let host = base.strip_prefix("https://").and_then(|r| r.rsplit_once(':')).map_or("", |(h, _)| h);
    let target = InviteLink { host: host.into(), path };
    let failure = check_until(&st.reach.probe, &target, st.reach.every, st.reach.deadline).await.err()?;
    if let Err(e) = st.share.store.revoke(id) { return Some(io_failed(e)) }
    let params = serde_json::to_value(&failure).unwrap_or_default();
    let msg = format!("o link não abriu pela internet: {}", params["detail"].as_str().unwrap_or(""));
    Some(refused(StatusCode::CONFLICT, "share_reach_failed", &msg, params))
}

pub(super) fn prereq_error(e: TunnelError) -> Response {
    let mut params = json!({"missing": e.missing, "fix": e.fix});
    if let Some(url) = e.enable_url {
        params["enable_url"] = url.into();
    }
    let msg = format!("falta preparar o compartilhamento: {}", e.fix);
    refused(StatusCode::CONFLICT, "erro_compartilhar_pre_requisito", &msg, params)
}

/// `bool` de query do FastAPI; o que não for booleano é 422.
fn local_flag(query: Option<&str>) -> Result<bool, Response> {
    let Some(raw) = form_urlencoded::parse(query.unwrap_or("").as_bytes())
        .filter(|(k, _)| k == "local").map(|(_, v)| v.into_owned()).last() else { return Ok(false) };
    match raw.to_ascii_lowercase().as_str() {
        "true" | "1" | "yes" | "on" | "t" | "y" => Ok(true),
        "false" | "0" | "no" | "off" | "f" | "n" => Ok(false),
        _ => Err(json_response(StatusCode::UNPROCESSABLE_ENTITY, json!({"detail": [{
            "type": "bool_parsing", "loc": ["query", "local"],
            "msg": "Input should be a valid boolean, unable to interpret input", "input": raw}]}))),
    }
}

/// Revogar nunca falha por causa do túnel: o registro já saiu e a varredura tenta de novo.
/// Quem nunca compartilhou pela internet não passa pelo tailscale: o Funnel da 8443 pode ser dele.
pub async fn sync_tunnel(share: &ShareState) {
    let store = &share.store;
    if !store.has_any(true) {
        return;
    }
    let active = store.has_active(true) || store.recently_ended(ENDED_GRACE.as_secs_f64(), true);
    if let Err(e) = tunnel::sync(&Ts(&share.tailscale), active).await {
        tracing::warn!(fix = %e.fix, "[share] sincronizar funnel falhou");
    }
}

pub async fn sweep_once(share: &ShareState) {
    if let Err(e) = life::sweep(&share.store, &share.lives).await {
        tracing::warn!(%e, "[share] varredura de convites falhou");
    }
    sync_tunnel(share).await;
}

pub async fn sweep_loop(share: Arc<ShareState>, every: Duration) {
    loop {
        // Uma rodada ruim não mata o laço.
        if AssertUnwindSafe(sweep_once(&share)).catch_unwind().await.is_err() {
            tracing::error!("[share] varredura entrou em pânico");
        }
        tokio::time::sleep(every).await;
    }
}

async fn create(State(st): St, Path(name): Path<String>, RawQuery(query): RawQuery) -> Response {
    let local = match local_flag(query.as_deref()) { Ok(v) => v, Err(r) => return r };
    let share = &st.share;
    let Some(life) = share.lives.life(&name, true).await else {
        return refused(StatusCode::NOT_FOUND, "erro_sessao_inexistente", "sessão não encontrada", json!({}));
    };
    if st.owner_port == GUEST_PORT {
        let msg = format!("o app roda na porta do convite ({GUEST_PORT}): troque CP_PORT no backend/.env e reinicie");
        return refused(StatusCode::CONFLICT, "erro_compartilhar_porta_do_convite", &msg, json!({"port": GUEST_PORT}));
    }
    if local {
        // Mesma rede, sem Tailscale: só com a porta do convite de fato escutando no IP da rede.
        let ip = st.net.lan_ip();
        if !matches!(st.bind_ip.as_str(), "0.0.0.0" | "::") || !st.net.listening(&ip, GUEST_PORT).await {
            return refused(StatusCode::CONFLICT, "erro_compartilhar_sem_rede_local",
                "esta máquina só escuta em 127.0.0.1: grave CP_LAN_BIND_IP=0.0.0.0 no backend/.env e reinicie", json!({}));
        }
        let (s, code) = match share.store.create(&name, Some(life), Kind::Share, true) { Ok(v) => v, Err(e) => return io_failed(e) };
        let link = format!("http://{ip}:{GUEST_PORT}/convite/{code}");
        return json_response(StatusCode::OK, json!({"id": s.id, "link": link, "expires_at": s.code_expires_at}));
    }
    let base = match tunnel::ensure_on(&Ts(&share.tailscale)).await { Ok(b) => b, Err(e) => return prereq_error(e) };
    let (s, code) = match share.store.create(&name, Some(life), Kind::Share, false) { Ok(v) => v, Err(e) => return io_failed(e) };
    if let Some(refusal) = reach_or_revoke(&st, &base, format!("/convite/{code}"), &s.id).await { return refusal }
    json_response(StatusCode::OK, json!({"id": s.id, "link": format!("{base}/convite/{code}"), "expires_at": s.code_expires_at}))
}

async fn list(State(st): St, Path(name): Path<String>) -> Response {
    let shares: Vec<Value> = st.share.store.list_for(&name).into_iter().map(|s| json!({
        "id": s.id, "device": s.device, "created_at": s.created_at, "redeemed_at": s.redeemed_at,
        "expires_at": s.code_expires_at, "pending": s.redeemed_at.is_none(),
    })).collect();
    json_response(StatusCode::OK, json!({"shares": shares}))
}

async fn revoke_one(State(st): St, Path((name, id)): Path<(String, String)>) -> Response {
    let store = &st.share.store;
    let revoked = if store.list_for(&name).iter().any(|s| s.id == id) {
        match store.revoke(&id) { Ok(v) => v, Err(e) => return io_failed(e) }
    } else { false };
    if !revoked {
        return refused(StatusCode::NOT_FOUND, "erro_compartilhamento_inexistente", "compartilhamento não encontrado", json!({}));
    }
    sync_tunnel(&st.share).await;
    json_response(StatusCode::OK, json!({"ok": true}))
}

async fn revoke_all(State(st): St, Path(name): Path<String>) -> Response {
    // O botão não derruba um par.
    let n = match st.share.store.revoke_session(&name, Some(Kind::Share)) { Ok(n) => n, Err(e) => return io_failed(e) };
    sync_tunnel(&st.share).await;
    json_response(StatusCode::OK, json!({"ok": true, "revoked": n}))
}

async fn prereqs(State(st): St) -> Response {
    match tunnel::prereqs(&Ts(&st.share.tailscale)).await {
        Ok(p) => json_response(StatusCode::OK, json!({"missing": p.missing, "fix": p.fix, "enable_url": p.enable_url})),
        // Sem tailscale ou deslogado: mesma resposta do gerar, e quem confere segue esperando.
        Err(fix) => prereq_error(TunnelError { missing: vec![], fix, enable_url: None }),
    }
}

pub fn owner_router(state: Arc<OwnerShareState>) -> Router {
    Router::new()
        .route("/api/share/prereqs", get(prereqs))
        .route("/api/sessions/{name}/share", get(list).post(create).delete(revoke_all))
        .route("/api/sessions/{name}/share/{id}", delete(revoke_one))
        .with_state(state)
}
