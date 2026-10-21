//! Onde a voz age: este servidor pela própria API HTTP (as mesmas rotas que os apps usam) e os peers.
use super::rules::{Delivery, PairResult};
use crate::groups::peers::{PeerClient, PeerError};
use hangar_api::{chat::ChatEvent, session::SessionRow};
use percent_encoding::{NON_ALPHANUMERIC, utf8_percent_encode};
use serde_json::{Value, json};
use std::{collections::HashSet, net::{Ipv4Addr, SocketAddr}, sync::Arc, time::Duration};

/// Chave da máquina da voz.
pub const HERE: &str = "";

#[derive(Clone)]
pub struct SelfApi { base: String, token: String, http: reqwest::Client }

impl SelfApi {
    pub fn new(addr: SocketAddr, token: &str) -> Self {
        let addr = if addr.ip().is_unspecified() { SocketAddr::new(Ipv4Addr::LOCALHOST.into(), addr.port()) } else { addr };
        // Sem proxy nem redirect: o token do dono nunca sai deste servidor.
        let http = crate::http_client().no_proxy().redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(120)).build().expect("cliente http local");
        Self { base: format!("http://{addr}"), token: token.to_owned(), http }
    }

    async fn send(&self, method: reqwest::Method, path: &str, body: Option<Value>) -> Result<reqwest::Response, CallError> {
        let mut req = self.http.request(method, format!("{}{path}", self.base)).bearer_auth(&self.token);
        if let Some(body) = body {
            req = req.header(reqwest::header::CONTENT_TYPE, "application/json").body(body.to_string());
        }
        req.send().await.map_err(|_| CallError { certain: false, text: "O servidor não respondeu.".to_owned() })
    }

    /// Status e corpo JSON; corpo ilegível vira `Null`. Só a falta de resposta é erro.
    async fn raw(&self, method: reqwest::Method, path: &str, body: Option<Value>) -> Result<(reqwest::StatusCode, Value), CallError> {
        let resp = self.send(method, path, body).await?;
        let status = resp.status();
        let value: Value = resp.bytes().await.ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or(Value::Null);
        Ok((status, value))
    }

    /// Status e corpo como vieram: vazio é `Null`, não JSON vira texto; corpo que não chegou inteiro é erro.
    async fn raw_body(&self, method: reqwest::Method, path: &str, body: Option<Value>) -> Result<(reqwest::StatusCode, Value), CallError> {
        let resp = self.send(method, path, body).await?;
        let status = resp.status();
        let bytes = resp.bytes().await
            .map_err(|_| CallError { certain: false, text: format!("O servidor respondeu {status}, mas o corpo não chegou inteiro.") })?;
        let value = if bytes.iter().all(u8::is_ascii_whitespace) { Value::Null } else {
            serde_json::from_slice(&bytes).unwrap_or_else(|_| Value::String(String::from_utf8_lossy(&bytes).into_owned()))
        };
        Ok((status, value))
    }

    async fn call(&self, method: reqwest::Method, path: &str, body: Option<Value>) -> Result<Value, CallError> {
        let (status, value) = self.raw(method, path, body).await?;
        if status.is_success() { return Ok(value); }
        // `detail.msg` é o formato `erro()` do Python (código, parâmetros e frase).
        let text = value["detail"]["message"].as_str()
            .or_else(|| value["detail"]["msg"].as_str())
            .or_else(|| value["detail"].as_str())
            .or_else(|| value["message"].as_str())
            .map(str::to_owned)
            .unwrap_or_else(|| format!("O servidor recusou ({status})."));
        Err(CallError { certain: true, text })
    }

    /// Entrada do MCP `hangar` na config da thread do organizador: o bearer do dono e a assinatura da chamada vão só aqui,
    /// nunca no ambiente nem no prompt que o modelo lê. `None` quando o sistema não deu bytes aleatórios.
    /// As tools liberadas ficam em `organizer::thread_config`. `approve`: com `approvalPolicy: never` o Codex nega toda tool
    /// MCP que pediria aprovação, e as do `hangar` não declaram ser só leitura.
    pub fn voice_mcp(&self, internal_secret: &str) -> Option<Value> {
        Some(json!({"enabled": true, "url": format!("{}/mcp/", self.base), "default_tools_approval_mode": "approve",
            "http_headers": {"Authorization": format!("Bearer {}", self.token), VOICE_HEADER: voice_signature(internal_secret)?}}))
    }
}

/// Cabeçalho que identifica a assistente de voz no MCP (`mcp::identity`).
pub const VOICE_HEADER: &str = "X-Hangar-Voice";

/// `<nonce>.<hmac>`: nonce novo a cada chamada e HMAC-SHA256 dele com o segredo interno, que só este servidor e o Python
/// conhecem; o MCP deste servidor confere.
pub fn voice_signature(secret: &str) -> Option<String> {
    use ring::{hmac, rand::SecureRandom};
    let mut nonce = [0u8; 16];
    ring::rand::SystemRandom::new().fill(&mut nonce).ok()?;
    let hex = |bytes: &[u8]| bytes.iter().map(|b| format!("{b:02x}")).collect::<String>();
    let nonce = hex(&nonce);
    let tag = hmac::sign(&hmac::Key::new(hmac::HMAC_SHA256, secret.as_bytes()), format!("hangar-voice:{nonce}").as_bytes());
    Some(format!("{nonce}.{}", hex(tag.as_ref())))
}

/// `certain`: o outro lado respondeu e recusou, nada foi gravado; senão (rede, prazo, resposta ilegível) pode ter chegado.
#[derive(Clone, Debug, PartialEq)]
pub struct CallError { pub certain: bool, pub text: String }

/// `own_label`: id deste servidor, vazio quando não há.
pub struct Machines { pub own: SelfApi, pub peers: Arc<PeerClient>, pub own_label: String }

fn enc(name: &str) -> String { utf8_percent_encode(name, NON_ALPHANUMERIC).to_string() }

fn redact_str(text: &str, tokens: &[String]) -> String {
    tokens.iter().fold(text.to_owned(), |text, token| text.replace(token.as_str(), "[token]"))
}

/// Troca cada token por `[token]` em todo texto e chave do JSON.
fn redact(value: &mut Value, tokens: &[String]) {
    match value {
        Value::String(text) => *text = redact_str(text, tokens),
        Value::Array(items) => items.iter_mut().for_each(|v| redact(v, tokens)),
        Value::Object(map) => {
            *map = std::mem::take(map).into_iter().map(|(k, mut v)| { redact(&mut v, tokens); (redact_str(&k, tokens), v) }).collect();
        }
        _ => {}
    }
}

impl Machines {
    pub async fn call(&self, machine: &str, method: reqwest::Method, path: &str, body: Option<Value>) -> Result<Value, String> {
        self.call_checked(machine, method, path, body).await.map_err(|e| e.text)
    }

    async fn call_checked(&self, machine: &str, method: reqwest::Method, path: &str, body: Option<Value>) -> Result<Value, CallError> {
        if machine == HERE { return self.own.call(method, path, body).await; }
        self.peers.call(machine, method, path, body.as_ref()).await.map(|v| v.unwrap_or(Value::Null))
            .map_err(|e| CallError { certain: !e.is_transport(), text: e.text(machine) })
    }

    /// `(status, corpo)` da rota, recusa incluída, para a `hangar_api` da voz. Os tokens (do dono e dos peers) saem do
    /// que volta como `[token]`: uma rota pode devolver link com `?token=`.
    pub async fn api(&self, machine: &str, method: reqwest::Method, path: &str, body: Option<Value>) -> Result<(u16, Value), String> {
        let got = if machine == HERE {
            self.own.raw_body(method, path, body).await.map(|(s, v)| (s.as_u16(), v)).map_err(|e| e.text)
        } else {
            match self.peers.call_status(machine, method, path, body.as_ref()).await {
                Ok((status, value)) => Ok((status, value.unwrap_or(Value::Null))),
                Err(PeerError::Refused { status, detail }) => Ok((status, json!({"detail": detail}))),
                Err(e) => Err(e.text(machine)),
            }
        };
        let mut tokens = self.peers.tokens().await;
        tokens.push(self.own.token.clone());
        tokens.retain(|t| !t.is_empty());
        match got {
            Ok((status, mut value)) => { redact(&mut value, &tokens); Ok((status, value)) }
            Err(text) => Err(redact_str(&text, &tokens)),
        }
    }

    /// Nome falado da máquina.
    pub fn label(&self, machine: &str) -> String {
        match machine {
            HERE if self.own_label.is_empty() => "este servidor".to_owned(),
            HERE => self.own_label.clone(),
            _ => machine.to_owned(),
        }
    }

    /// `(máquina, linha)` de todas as máquinas que responderam, e o rótulo das que não.
    pub async fn sessions(&self) -> (Vec<(String, SessionRow)>, Vec<String>) {
        let (rows, unreachable, _) = self.sessions_except(&HashSet::new()).await;
        (rows, unreachable)
    }

    /// Como `sessions`, sem ler as máquinas de `skip` (contam como sem resposta); o terceiro item são os peers que falharam agora.
    pub async fn sessions_except(&self, skip: &HashSet<String>) -> (Vec<(String, SessionRow)>, Vec<String>, Vec<String>) {
        let machines: Vec<String> = std::iter::once(HERE.to_owned()).chain(self.peers.enabled_ids()).collect();
        let (read, skipped): (Vec<String>, Vec<String>) = machines.into_iter().partition(|m| !skip.contains(m));
        let reads = futures_util::future::join_all(read.iter().map(|m| self.call(m, reqwest::Method::GET, "/api/sessions", None))).await;
        let (mut rows, mut failed) = (Vec::new(), Vec::new());
        let mut unreachable: Vec<String> = skipped.iter().map(|m| self.label(m)).collect();
        for (machine, read) in read.into_iter().zip(reads) {
            match read.ok().and_then(|v| serde_json::from_value::<Vec<SessionRow>>(v).ok()) {
                Some(list) => rows.extend(list.into_iter().map(|r| (machine.clone(), r))),
                None => {
                    unreachable.push(self.label(&machine));
                    if machine != HERE { failed.push(machine); }
                }
            }
        }
        (rows, unreachable, failed)
    }

    pub async fn history(&self, machine: &str, name: &str, limit: usize) -> Result<Vec<ChatEvent>, String> {
        let path = format!("/api/sessions/{}/history?limit={limit}", enc(name));
        let value = self.call(machine, reqwest::Method::GET, &path, None).await?;
        serde_json::from_value(value).map_err(|_| "Resposta inválida do histórico.".to_owned())
    }

    pub async fn send(&self, machine: &str, name: &str, text: &str) -> Result<Delivery, CallError> {
        let path = format!("/api/sessions/{}/input", enc(name));
        let value = self.call_checked(machine, reqwest::Method::POST, &path, Some(json!({"text": text, "steer": false}))).await?;
        let delivery: Delivery = serde_json::from_value(value).map_err(|_| CallError { certain: false, text: "Resposta inválida do envio.".to_owned() })?;
        if delivery.ok { Ok(delivery) } else { Err(CallError { certain: true, text: "A sessão recusou o pedido.".to_owned() }) }
    }

    pub async fn pair(&self, machine: &str, target: &str, origin: &str) -> Result<PairResult, String> {
        let path = format!("/api/sessions/{}/pair", enc(target));
        let body = json!({"peers": [origin], "task": "", "replace_task": false});
        self.call(machine, reqwest::Method::POST, &path, Some(body)).await.map(|v| PairResult::from_value(&v))
    }

    pub async fn unpair(&self, machine: &str, name: &str) -> Result<PairResult, String> {
        let path = format!("/api/sessions/{}/pair", enc(name));
        self.call(machine, reqwest::Method::DELETE, &path, None).await.map(|v| PairResult::from_value(&v))
    }

    pub async fn close(&self, machine: &str, name: &str) -> Result<(), String> {
        let path = format!("/api/sessions/{}", enc(name));
        self.call(machine, reqwest::Method::DELETE, &path, None).await.map(|_| ())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::groups::peers::PeerBook;
    use axum::{Router, http::header::CONTENT_TYPE, response::IntoResponse, routing::{get, post}};

    // O axum daqui é sem a feature `json`.
    fn js(v: Value) -> axum::response::Response { ([(CONTENT_TYPE, "application/json")], v.to_string()).into_response() }

    async fn fake_api() -> SocketAddr {
        let app = Router::new()
            .route("/api/sessions", get(|| async { js(json!([{"name": "hangar", "provider": "claude", "state": "idle"}])) }))
            .route("/api/sessions/{n}/input", post(|b: String| async move {
                assert_eq!(serde_json::from_str::<Value>(&b).unwrap()["steer"], false);
                js(json!({"ok": true, "delivered": true}))
            }))
            .route("/api/sessions/{n}/history", get(|| async { js(json!([{"id": "1", "kind": "assistant_msg", "text": "feito"}])) }));
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = l.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(l, app).await.unwrap() });
        addr
    }

    fn machines(addr: SocketAddr) -> Machines {
        Machines { own: SelfApi::new(addr, "t"), peers: Arc::new(PeerClient::new(PeerBook::new(None))), own_label: "casa".into() }
    }

    #[tokio::test]
    async fn here_lists_sends_and_reads_history() {
        let m = machines(fake_api().await);
        let (rows, unreachable) = m.sessions().await;
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].0, HERE);
        assert!(unreachable.is_empty());
        assert_eq!(m.send(HERE, "hangar", "oi").await.unwrap(), Delivery { ok: true, delivered: true });
        assert_eq!(m.history(HERE, "hangar", 20).await.unwrap()[0].text.as_deref(), Some("feito"));
        assert_eq!(m.label(HERE), "casa");
        let unnamed = Machines { own_label: String::new(), ..m };
        assert_eq!(unnamed.label(HERE), "este servidor", "sem id, a fala ainda nomeia a máquina");
    }

    #[test]
    fn voice_mcp_carries_bearer_and_a_fresh_signature() {
        let api = SelfApi::new("127.0.0.1:8765".parse().unwrap(), "tok");
        let (a, b) = (api.voice_mcp("segredo").unwrap(), api.voice_mcp("segredo").unwrap());
        assert_eq!(a["url"], "http://127.0.0.1:8765/mcp/");
        assert_eq!(a["enabled"], true);
        assert_eq!(a["default_tools_approval_mode"], "approve", "com approvalPolicy never, sem isto toda tool do hangar é negada");
        assert_eq!(a["http_headers"]["Authorization"], "Bearer tok");
        let signature = a["http_headers"][VOICE_HEADER].as_str().unwrap();
        assert_ne!(signature, b["http_headers"][VOICE_HEADER].as_str().unwrap(), "uma por chamada");
        let (nonce, tag) = signature.split_once('.').unwrap();
        assert_eq!((nonce.len(), tag.len()), (32, 64));
        // Mesma conta do Python: HMAC-SHA256(segredo, "hangar-voice:" + nonce) em hex.
        let key = ring::hmac::Key::new(ring::hmac::HMAC_SHA256, b"segredo");
        let expected: String = ring::hmac::sign(&key, format!("hangar-voice:{nonce}").as_bytes()).as_ref().iter().map(|b| format!("{b:02x}")).collect();
        assert_eq!(tag, expected);
    }

    #[tokio::test]
    async fn api_hides_tokens_and_keeps_text_and_empty_bodies() {
        let app = Router::new()
            .route("/api/link", get(|| async { js(json!({"url": "http://x/?token=dono-123", "peer": ["vps segredo-peer"]})) }))
            .route("/api/texto", get(|| async { "texto puro" }))
            .route("/api/vazio", post(|| async { "" }));
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = l.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(l, app).await.unwrap() });
        let dir = tempfile::tempdir().unwrap();
        let book = dir.path().join("peers.json");
        std::fs::write(&book, json!({"vps": {"base_url": "http://127.0.0.1:9", "token": "segredo-peer"}}).to_string()).unwrap();
        let m = Machines { own: SelfApi::new(addr, "dono-123"), peers: Arc::new(PeerClient::new(PeerBook::new(Some(book)))), own_label: "casa".into() };
        let (status, body) = m.api(HERE, reqwest::Method::GET, "/api/link", None).await.unwrap();
        assert_eq!(status, 200);
        assert_eq!(body, json!({"url": "http://x/?token=[token]", "peer": ["vps [token]"]}));
        assert_eq!(m.api(HERE, reqwest::Method::GET, "/api/texto", None).await.unwrap().1, json!("texto puro"));
        assert_eq!(m.api(HERE, reqwest::Method::POST, "/api/vazio", None).await.unwrap().1, Value::Null);
    }

    #[tokio::test]
    async fn unknown_peer_is_an_error_text_not_a_panic() {
        let m = machines("127.0.0.1:9".parse().unwrap());
        assert!(m.send("vps", "x", "oi").await.is_err());
    }
}
