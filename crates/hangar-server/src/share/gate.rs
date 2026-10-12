//! Porteiro da porta do convidado (8766) e vigia das conexões longas.
//!
//! O filtro delimita a INTERFACE do convidado, não é fronteira de segurança: quem entra numa
//! sessão em bypass já roda comando como o dono.
use std::net::SocketAddr;
use std::sync::Arc;
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::Duration;

use axum::body::Body;
use axum::extract::connect_info::Connected;
use axum::extract::ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade};
use axum::extract::{ConnectInfo, FromRequestParts, Request, State};
use axum::http::{HeaderValue, Method, StatusCode, header};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::serve::IncomingStream;
use futures_util::StreamExt;
use tokio::net::TcpListener;

use super::ShareState;
use super::caller::{Caller, GuestGrant, guest_allowed, path_session};
use super::life::{Verdict, verdict};

pub const WATCH_EVERY: Duration = Duration::from_secs(5);
/// Funnel não manda X-Forwarded-For: todo convidado chega de loopback, então o limite é da
/// conexão, nunca do IP (nem o bloqueio do dono).
pub const MAX_FAILS: u32 = 8;
/// Fecha o WebSocket quando o acesso acaba: espelho do HTTP 410, o cliente não reconecta.
pub const CLOSE_ENDED: u16 = 4410;

/// Dado de cada conexão TCP: a contagem de tokens errados morre com ela.
/// Servir com `into_make_service_with_connect_info::<GuestConn>()` num `TcpListener` puro.
#[derive(Clone, Debug)]
pub struct GuestConn {
    pub peer: SocketAddr,
    fails: Arc<AtomicU32>,
}

impl Connected<IncomingStream<'_, TcpListener>> for GuestConn {
    fn connect_info(stream: IncomingStream<'_, TcpListener>) -> Self {
        Self { peer: *stream.remote_addr(), fails: Arc::default() }
    }
}

pub struct Gate {
    pub share: Arc<ShareState>,
    pub watch_every: Duration,
}

impl Gate {
    pub fn new(share: Arc<ShareState>) -> Self {
        Self { share, watch_every: WATCH_EVERY }
    }
}

/// O que o handler de WebSocket precisa para o vigia; o porteiro põe nas extensões.
#[derive(Clone)]
pub struct Watcher {
    share: Arc<ShareState>,
    token: String,
    session: Option<String>,
    every: Duration,
}

impl Watcher {
    /// Resolve só num fim de verdade: "não sei" (troca de modo, tmux mudo) mantém aberto.
    pub async fn until_ended(&self) {
        loop {
            tokio::time::sleep(self.every).await;
            let ended = match self.share.store.lookup_token(&self.token) {
                None => true,
                Some(guest) => verdict(&guest, self.session.as_deref(), &self.share.lives).await == Verdict::Ended,
            };
            if ended {
                return;
            }
        }
    }
}

fn is_open(method: &Method, path: &str) -> bool {
    method == Method::OPTIONS || path.starts_with("/convite/") || path.starts_with("/par/")
        || (method == Method::POST && (path == "/api/guest/redeem" || path == "/api/pair/redeem"))
}

/// Só Bearer ou `?token=`: cookie nunca, porque a origem do convidado não é a do dono.
fn token_of(req: &Request) -> String {
    if let Some(t) = req.headers().get(header::AUTHORIZATION).and_then(|v| v.as_bytes().strip_prefix(b"Bearer ")) {
        return String::from_utf8_lossy(t).into_owned();
    }
    // `parse_qs` descarta valor vazio e fica com o primeiro.
    req.uri().query().and_then(|q| {
        form_urlencoded::parse(q.as_bytes()).find(|(k, v)| k == "token" && !v.is_empty()).map(|(_, v)| v.into_owned())
    }).unwrap_or_default()
}

fn is_websocket(req: &Request) -> bool {
    req.headers().get(header::UPGRADE).is_some_and(|v| v.as_bytes().eq_ignore_ascii_case(b"websocket"))
}

async fn deny(req: Request, status: StatusCode, code: &str, msg: &str) -> Response {
    if is_websocket(&req) {
        let (mut parts, _) = req.into_parts();
        if let Ok(ws) = WebSocketUpgrade::from_request_parts(&mut parts, &()).await {
            // Aceita só para fechar com código: 1013 é "tente de novo", e o cliente precisa lê-lo.
            let code = if status == StatusCode::SERVICE_UNAVAILABLE { 1013 } else { 1008 };
            return ws.on_upgrade(move |mut socket| async move {
                let _ = socket.send(Message::Close(Some(CloseFrame { code, reason: "".into() }))).await;
            });
        }
        return status.into_response();
    }
    let body = serde_json::json!({"detail": {"code": code, "params": {}, "msg": msg}}).to_string();
    let mut resp = (status, [(header::CONTENT_TYPE, "application/json")], body).into_response();
    if status == StatusCode::SERVICE_UNAVAILABLE {
        resp.headers_mut().insert(header::RETRY_AFTER, HeaderValue::from_static("5"));
    }
    // O CORS do Python fica por fora do porteiro: a recusa também leva o cabeçalho.
    crate::routes::cors(req.headers(), resp.headers_mut());
    resp
}

/// Middleware da 8766. Ordem das recusas: 401 → 403 sessão fora → 410/503 → 403 por rota.
pub async fn guard(State(gate): State<Arc<Gate>>, ConnectInfo(conn): ConnectInfo<GuestConn>, mut req: Request, next: Next) -> Response {
    // Os handlers continuam lendo o par TCP como na 8765.
    req.extensions_mut().insert(ConnectInfo(conn.peer));
    // Só o Rust assina esse cabeçalho; vindo de fora é forjado.
    req.headers_mut().remove("x-hangar-guest");
    let method = req.method().clone();
    let path = req.uri().path().to_owned();
    if is_open(&method, &path) {
        return next.run(req).await;
    }
    // Conexão bloqueada nem avalia o token: a diferença entre 200 e 429 entregaria o palpite certo.
    if conn.fails.load(Ordering::Relaxed) >= MAX_FAILS {
        return deny(req, StatusCode::TOO_MANY_REQUESTS, "erro_muitas_tentativas", "muitas tentativas — aguarde").await;
    }
    let token = token_of(&req);
    let Some(guest) = gate.share.store.lookup_token(&token) else {
        if !token.is_empty() {
            conn.fails.fetch_add(1, Ordering::Relaxed);
        }
        return deny(req, StatusCode::UNAUTHORIZED, "erro_nao_autorizado", "unauthorized").await;
    };
    let session = path_session(&path);
    if session.as_deref().is_some_and(|s| guest.share_for(s).is_none()) {
        return deny(req, StatusCode::FORBIDDEN, "erro_fora_do_convite", "fora da sessao compartilhada").await;
    }
    match verdict(&guest, session.as_deref(), &gate.share.lives).await {
        Verdict::Ended => {
            return deny(req, StatusCode::GONE, "erro_convite_encerrado", "compartilhamento encerrado").await;
        }
        Verdict::Unsure => {
            return deny(req, StatusCode::SERVICE_UNAVAILABLE, "erro_sessao_indisponivel", "sessao indisponivel por instantes").await;
        }
        Verdict::Ok => {}
    }
    let grant = Arc::new(GuestGrant::new(&token, &guest));
    if !guest_allowed(&method, &path, &grant) {
        return deny(req, StatusCode::FORBIDDEN, "erro_fora_do_convite", "fora da sessao compartilhada").await;
    }
    req.extensions_mut().insert(Caller::Guest(grant));
    let websocket = is_websocket(&req);
    if !websocket && !path.ends_with("/events") {
        return next.run(req).await;
    }
    // Stream e WebSocket passam pelo porteiro uma vez só: sem o vigia, revogar não derrubaria
    // um terminal ou uma lista já abertos.
    let watcher = Watcher { share: gate.share.clone(), token, session, every: gate.watch_every };
    if websocket {
        req.extensions_mut().insert(watcher);
        return next.run(req).await;
    }
    next.run(req).await.map(|body| watch(body, watcher))
}

/// Corpo que termina quando o acesso acaba de verdade.
pub fn watch(body: Body, watcher: Watcher) -> Body {
    let (mut tx, rx) = tokio::sync::oneshot::channel::<()>();
    tokio::spawn(async move {
        // Sai sozinho quando o corpo é largado (cliente foi embora ou stream acabou).
        let ended = tokio::select! {
            _ = watcher.until_ended() => true,
            _ = tx.closed() => false,
        };
        if ended {
            let _ = tx.send(());
        }
    });
    let stream = futures_util::stream::unfold((body.into_data_stream(), rx), |(mut data, mut rx)| async move {
        tokio::select! {
            biased;
            _ = &mut rx => None,
            item = data.next() => item.map(|item| (item, (data, rx))),
        }
    });
    Body::from_stream(stream)
}

/// Roda o handler do WebSocket e fecha com 4410 quando o acesso acaba de verdade.
pub async fn watch_ws(mut socket: WebSocket, watcher: &Watcher, run: impl AsyncFnOnce(&mut WebSocket)) {
    let ended = tokio::select! {
        _ = run(&mut socket) => false,
        _ = watcher.until_ended() => true,
    };
    if ended {
        let _ = socket.send(Message::Close(Some(CloseFrame { code: CLOSE_ENDED, reason: "".into() }))).await;
    }
}
