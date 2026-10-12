//! Modelo auxiliar do Jev: lista os modelos do provedor e detecta o CLIProxyAPI local.
//! O `runtime-config.json` só é lido aqui; quem grava é o `/api/config` do Python.

use crate::routes::{AppState, cors, gate, pass};
use crate::session_write::{detail_body, json_response};
use axum::extract::{ConnectInfo, Request, State};
use axum::http::{Method, StatusCode};
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use serde_json::{Value, json};
use std::net::SocketAddr;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

const CLIPROXY_URL: &str = "http://127.0.0.1:8317/v1";

#[derive(Deserialize)]
struct ModelsBody {
    base_url: String,
    #[serde(default)]
    api_key: Option<String>,
    #[serde(default)]
    use_saved_key: bool,
    #[serde(default)]
    use_cliproxy_key: bool,
}

/// `access.api-keys` no formato novo; `api-keys` na raiz no antigo (no novo, a raiz é dos provedores).
fn cliproxy_keys(home: &Path) -> Vec<String> {
    let Some(config) = std::fs::read_to_string(home.join(".cli-proxy-api").join("config.yaml")).ok()
        .and_then(|text| serde_saphyr::from_str::<Value>(&text).ok()) else { return Vec::new() };
    [&config["access"]["api-keys"], &config["api-keys"]].into_iter()
        .map(|list| list.as_array().into_iter().flatten().filter_map(Value::as_str).map(str::trim)
            .filter(|k| !k.is_empty()).map(str::to_string).collect::<Vec<_>>())
        .find(|keys| !keys.is_empty()).unwrap_or_default()
}

fn saved_key(claude_dir: &Path) -> String {
    std::fs::read(claude_dir.join("runtime-config.json")).ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        // Antes da migração gravar o auxiliar, a chave ainda está no campo do texto.
        .and_then(|v| ["jev_aux_api_key", "jev_texto_api_key"].into_iter()
            .find_map(|f| v[f].as_str().map(str::trim).filter(|k| !k.is_empty()).map(str::to_string)))
        .unwrap_or_default()
}

fn failure(status: StatusCode, code: &str, msg: &str, params: Value) -> Response {
    json_response(status, detail_body(code, msg, params))
}

pub async fn cliproxy(State(st): State<Arc<AppState>>, ConnectInfo(peer): ConnectInfo<SocketAddr>, req: Request) -> Response {
    let (fwd, owner) = gate(&st, peer, &req);
    if !owner { return pass(&st, req, &fwd).await; }
    let home = st.accounts.env.home.clone();
    let has_keys = tokio::task::spawn_blocking(move || !cliproxy_keys(&home).is_empty()).await.unwrap_or(false);
    let running = tokio::time::timeout(Duration::from_millis(500), tokio::net::TcpStream::connect("127.0.0.1:8317")).await
        .is_ok_and(|r| r.is_ok());
    let mut resp = json_response(StatusCode::OK, json!({"preset_url": CLIPROXY_URL, "running": running, "has_keys": has_keys}));
    cors(req.headers(), resp.headers_mut());
    resp
}

pub async fn models(State(st): State<Arc<AppState>>, ConnectInfo(peer): ConnectInfo<SocketAddr>, req: Request) -> Response {
    let (fwd, owner) = gate(&st, peer, &req);
    if !owner { return pass(&st, req, &fwd).await; }
    if req.method() != Method::POST { return StatusCode::METHOD_NOT_ALLOWED.into_response(); }
    let headers = req.headers().clone();
    let home = st.accounts.env.home.clone();
    let claude_dir = st.voice.claude_dir().to_path_buf();
    let mut resp = match axum::body::to_bytes(req.into_body(), 64 * 1024).await.ok()
        .and_then(|bytes| serde_json::from_slice::<ModelsBody>(&bytes).ok()) {
        None => failure(StatusCode::BAD_REQUEST, "erro_corpo_invalido", "corpo inválido", json!({})),
        Some(body) => list(body, &home, &claude_dir).await,
    };
    cors(&headers, resp.headers_mut());
    resp
}

async fn list(body: ModelsBody, home: &Path, claude_dir: &Path) -> Response {
    let base = body.base_url.trim().trim_end_matches('/');
    let base = base.strip_suffix("/chat/completions").unwrap_or(base).to_string();
    if !(base.starts_with("http://") || base.starts_with("https://")) {
        return failure(StatusCode::BAD_REQUEST, "erro_jev_aux_url", "o endereço precisa começar com http:// ou https://", json!({}));
    }
    let typed = body.api_key.as_deref().map(str::trim).unwrap_or_default().to_string();
    let key = if body.use_cliproxy_key {
        match cliproxy_keys(home).into_iter().next() {
            Some(k) => k,
            None => return failure(StatusCode::BAD_REQUEST, "erro_jev_aux_cliproxy_key",
                "o ~/.cli-proxy-api/config.yaml não tem nenhuma api-key", json!({})),
        }
    } else if body.use_saved_key || typed.is_empty() {
        saved_key(claude_dir)
    } else {
        typed
    };
    match fetch(&base, &key).await {
        Ok(models) => json_response(StatusCode::OK, json!({"models": models})),
        Err((status, error)) => failure(StatusCode::BAD_GATEWAY, "erro_jev_aux_models", &error,
            json!({"status": status, "error": error})),
    }
}

/// Anthropic pede `x-api-key`; os compatíveis com a OpenAI (CLIProxyAPI, OpenRouter), Bearer.
async fn fetch(base: &str, key: &str) -> Result<Vec<String>, (Option<u16>, String)> {
    let client = reqwest::Client::builder().timeout(Duration::from_secs(8)).build().map_err(|e| (None, e.to_string()))?;
    let anthropic = base.contains("anthropic.com");
    // A Anthropic pagina a lista (20 por padrão): sem o teto, modelos somem calados.
    let mut request = client.get(format!("{base}/models{}", if anthropic { "?limit=1000" } else { "" }));
    if anthropic {
        request = request.header("x-api-key", key).header("anthropic-version", "2023-06-01");
    } else if !key.is_empty() {
        request = request.bearer_auth(key);
    }
    let response = request.send().await.map_err(|e| (None, without_key(&e.to_string(), key)))?;
    let status = response.status();
    let text = response.text().await.map_err(|e| (Some(status.as_u16()), without_key(&e.to_string(), key)))?;
    let parsed = serde_json::from_str::<Value>(&text).unwrap_or(Value::Null);
    if !status.is_success() {
        return Err((Some(status.as_u16()), without_key(&provider_phrase(&parsed, &text, status.as_u16()), key)));
    }
    let Some(data) = parsed["data"].as_array() else {
        return Err((Some(status.as_u16()), "o endereço respondeu, mas não é uma lista de modelos (confira a base, ex. .../v1)".to_string()));
    };
    let mut ids: Vec<String> = data.iter().filter_map(|m| m["id"].as_str().map(str::to_string)).collect();
    ids.sort();
    ids.dedup();
    Ok(ids)
}

fn provider_phrase(parsed: &Value, text: &str, status: u16) -> String {
    let phrase = parsed["error"]["message"].as_str().or_else(|| parsed["error"].as_str()).or_else(|| parsed["message"].as_str())
        .map(str::to_string).unwrap_or_else(|| text.trim().chars().take(300).collect());
    if phrase.is_empty() { format!("o provedor respondeu {status}") } else { phrase }
}

fn without_key(text: &str, key: &str) -> String {
    if key.is_empty() { text.to_string() } else { text.replace(key, "***") }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cliproxy_keys_come_from_the_yaml_list() {
        let home = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(home.path().join(".cli-proxy-api")).unwrap();
        std::fs::write(home.path().join(".cli-proxy-api/config.yaml"),
            "port: 8317\napi-keys:\n  - \"hangar-abc\"\n  - other\nremote-management:\n  secret-key: x\n").unwrap();
        assert_eq!(cliproxy_keys(home.path()), ["hangar-abc", "other"]);
        std::fs::write(home.path().join(".cli-proxy-api/config.yaml"),
            "access:\n  api-keys:\n    - \"new-key\"\napi-keys:\n  gemini:\n    - name: g\n").unwrap();
        assert_eq!(cliproxy_keys(home.path()), ["new-key"]);
        assert!(cliproxy_keys(Path::new("/nonexistent")).is_empty());
    }

    #[test]
    fn provider_phrase_prefers_the_error_message() {
        let parsed = json!({"error": {"type": "authentication_error", "message": "invalid x-api-key"}});
        assert_eq!(provider_phrase(&parsed, "", 401), "invalid x-api-key");
        assert_eq!(provider_phrase(&Value::Null, "", 502), "o provedor respondeu 502");
        assert_eq!(without_key("bad key sk-1 here", "sk-1"), "bad key *** here");
    }

    #[tokio::test]
    async fn fetch_lists_sorted_ids_and_returns_the_provider_phrase() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            for (status, body) in [
                ("200 OK", r#"{"data":[{"id":"b"},{"id":"a"},{"x":1}]}"#),
                ("401 Unauthorized", r#"{"error":{"message":"bad key k1"}}"#),
                ("200 OK", "<html>login</html>"),
            ] {
                let reply = format!("HTTP/1.1 {status}\r\ncontent-type: application/json\r\ncontent-length: {}\r\n\r\n{body}", body.len());
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut buf = [0u8; 4096];
                let _ = tokio::io::AsyncReadExt::read(&mut socket, &mut buf).await;
                tokio::io::AsyncWriteExt::write_all(&mut socket, reply.as_bytes()).await.unwrap();
            }
        });
        let base = format!("http://{addr}/v1");
        assert_eq!(fetch(&base, "k1").await.unwrap(), ["a", "b"]);
        assert_eq!(fetch(&base, "k1").await.unwrap_err(), (Some(401), "bad key ***".to_string()));
        assert!(fetch(&base, "k1").await.unwrap_err().1.contains("não é uma lista de modelos"));
    }
}
