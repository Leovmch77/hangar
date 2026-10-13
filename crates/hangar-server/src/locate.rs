// crates/hangar-server/src/locate.rs
//! Qual conversa é a de cada sessão: a descoberta do próprio Rust (a da lista do dono), sem ir ao
//! Python. A reabertura da sessão em erro continua com o coordenador do Python e só é pedida.
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use axum::body::Body;
use hangar_api::session::SessionRow;
use percent_encoding::{NON_ALPHANUMERIC, utf8_percent_encode};

use crate::list::bridge::ListBridge;
use crate::proxy::HttpClient;
use crate::transcript::InternalInfo;

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// A descoberta não respondeu (multiplexador fora, pastas ausentes) ou não sabe dizer se a sessão
/// existe; o código diz qual. "Não existe" é `Ok(None)`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct InfoFailed(pub &'static str);

pub trait Locate: Send + Sync {
    fn info<'a>(&'a self, name: &'a str) -> BoxFuture<'a, Result<Option<InternalInfo>, InfoFailed>>;
}

/// Descoberta que nunca responde: o hub sem ela fica na ligação com que nasceu (testes do hub).
pub struct Unavailable;

impl Locate for Unavailable {
    fn info<'a>(&'a self, _name: &'a str) -> BoxFuture<'a, Result<Option<InternalInfo>, InfoFailed>> {
        Box::pin(async { Err(InfoFailed("locate_unavailable")) })
    }
}

/// A mesma resposta sempre (testes de unidade).
#[cfg(test)]
pub struct Fixed(pub Option<InternalInfo>);

#[cfg(test)]
impl Locate for Fixed {
    fn info<'a>(&'a self, _name: &'a str) -> BoxFuture<'a, Result<Option<InternalInfo>, InfoFailed>> {
        Box::pin(async { Ok(self.0.clone()) })
    }
}

pub struct ListLocate {
    pub list: Arc<ListBridge>,
}

/// Uma rodada da lista travada (multiplexador, fatos do Python) não pendura `/history` e `/events`.
const LOCATE_TIMEOUT: Duration = Duration::from_secs(10);

impl Locate for ListLocate {
    fn info<'a>(&'a self, name: &'a str) -> BoxFuture<'a, Result<Option<InternalInfo>, InfoFailed>> {
        Box::pin(async move {
            tokio::time::timeout(LOCATE_TIMEOUT, self.find(name)).await.unwrap_or(Err(InfoFailed("locate_timeout")))
        })
    }
}

impl ListLocate {
    async fn find(&self, name: &str) -> Result<Option<InternalInfo>, InfoFailed> {
        {
            let claude = self.list.env().dirs.as_ref().map(|d| d.claude.clone()).ok_or(InfoFailed("list_dirs_missing"))?;
            let p = self.list.snapshot().await.map_err(|e| InfoFailed(e.code))?;
            if let Some(row) = p.rows.iter().find(|r| r.name == name) {
                return Ok(Some(info_of(row, &claude)));
            }
            // Sessão criada agora: o retrato de até 2 s ainda não a tem.
            let p = self.list.refresh().await.map_err(|e| InfoFailed(e.code))?;
            match p.rows.iter().find(|r| r.name == name) {
                Some(row) => Ok(Some(info_of(row, &claude))),
                // Sem os fatos do Python as linhas de transferência e `orq` faltam: ausência não prova nada.
                None if p.facts.unknown => Err(InfoFailed("list_facts_unknown")),
                None => Ok(None),
            }
        }
    }
}

pub fn info_of(row: &SessionRow, claude: &Path) -> InternalInfo {
    let provider = if row.provider == "claude" && row.headless { "claude-headless".to_owned() } else { row.provider.clone() };
    InternalInfo {
        provider,
        jsonl: row.jsonl.as_ref().map(PathBuf::from),
        session_key: row.jsonl.as_deref().map(session_key).unwrap_or_default(),
        history: serde_json::json!({"queue": queue_path(claude, &row.name)}),
        headless: row.provider == "codex" && row.headless,
        lifecycle_id: row.lifecycle_id.clone(),
    }
}

/// `models.session_key`: o session id do transcript. Kimi grava todo transcript como `wire.jsonl`
/// (a chave é a pasta da sessão) e o rollout do Codex leva data antes do id.
pub fn session_key(jsonl: &str) -> String {
    let p = Path::new(jsonl);
    let name = |p: Option<&Path>| p.and_then(Path::file_name).map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    if name(Some(p)) == "wire.jsonl" && name(p.parent().and_then(Path::parent)) == "agents" {
        return name(p.parent().and_then(Path::parent).and_then(Path::parent));
    }
    let stem = p.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    // `^rollout-.*-<uuid>$`: depois de `rollout-` ainda vem um `-` antes do id.
    if stem.starts_with("rollout-") && stem.len() >= 36 && stem.is_char_boundary(stem.len() - 36) {
        let (head, id) = stem.split_at(stem.len() - 36);
        if head.len() > "rollout-".len() && head.ends_with('-') && is_uuid(id) {
            return id.to_owned();
        }
    }
    stem
}

fn is_uuid(s: &str) -> bool {
    let groups: Vec<&str> = s.split('-').collect();
    groups.iter().map(|g| g.len()).eq([8, 4, 4, 4, 12]) && groups.iter().all(|g| g.chars().all(|c| c.is_ascii_hexdigit()))
}

/// `PromptQueue(name).path`: `<config do Claude>/.hangar-queue/<nome sanitizado>.jsonl`.
pub fn queue_path(claude: &Path, name: &str) -> PathBuf {
    let safe: String = name.chars().map(|c| if c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-') { c } else { '-' }).collect();
    claude.join(".hangar-queue").join(format!("{safe}.jsonl"))
}

/// Abrir a conversa reabre a sessão em erro (`runtime_coordinator`, no Python). Sem esperar:
/// a leitura do histórico não depende dela. Falha vai ao log e ao diário.
pub fn request_reopen(http: &HttpClient, upstream: std::net::SocketAddr, secret: &str, diag: &crate::diag::DiagClient, name: &str) {
    const REASON: &str = "o pedido de reabertura da sessão não chegou ao backend";
    let url = format!("http://{upstream}/internal/sessions/{}/reopen", utf8_percent_encode(name, NON_ALPHANUMERIC));
    let Ok(req) = axum::http::Request::post(url).header("x-hangar-internal", secret).body(Body::empty()) else {
        tracing::warn!(session = %name, "pedido de reabertura inválido");
        diag.report("rust.reopen_failed", name, "reopen_request_invalid", REASON);
        return;
    };
    let (http, diag, name) = (http.clone(), diag.clone(), name.to_owned());
    tokio::spawn(async move {
        let code = match tokio::time::timeout(Duration::from_secs(10), http.request(req)).await {
            Ok(Ok(r)) if r.status().is_success() => return,
            Ok(Ok(r)) => {
                tracing::warn!(session = %name, status = %r.status(), "pedido de reabertura recusado");
                "reopen_refused"
            }
            Ok(Err(e)) => {
                tracing::warn!(session = %name, "pedido de reabertura falhou: {e}");
                "reopen_unreachable"
            }
            Err(_) => {
                tracing::warn!(session = %name, "pedido de reabertura sem resposta");
                "reopen_timeout"
            }
        };
        diag.report("rust.reopen_failed", &name, code, REASON);
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_key_matches_the_python_layouts() {
        assert_eq!(session_key("/c/projects/x/0c657c79-1745-406b-a97f-bbbf5402ff19.jsonl"), "0c657c79-1745-406b-a97f-bbbf5402ff19");
        assert_eq!(session_key("/k/sessions/wd/sid-1/agents/main/wire.jsonl"), "sid-1");
        assert_eq!(session_key("/x/rollout-2026-10-12T10-00-00-0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b.jsonl"),
                   "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b");
        assert_eq!(session_key("/x/rollout-sem-id.jsonl"), "rollout-sem-id");
        assert_eq!(session_key("/x/rollout-0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b.jsonl"),
                   "rollout-0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b", "sem nada entre `rollout-` e o id, como o regex do Python");
    }

    #[test]
    fn queue_path_sanitizes_like_the_python_queue() {
        assert_eq!(queue_path(Path::new("/c"), "par externo/1"), Path::new("/c/.hangar-queue/par-externo-1.jsonl"));
        assert_eq!(queue_path(Path::new("/c"), "a.b_c-d"), Path::new("/c/.hangar-queue/a.b_c-d.jsonl"));
    }

    #[test]
    fn headless_claude_gets_the_adapter_key() {
        let row: SessionRow = serde_json::from_value(serde_json::json!({"name": "s", "provider": "claude", "headless": true,
            "jsonl": "/c/projects/p/k.jsonl"})).unwrap();
        let info = info_of(&row, Path::new("/c"));
        assert_eq!((info.provider.as_str(), info.headless, info.session_key.as_str()), ("claude-headless", false, "k"));
        let codex: SessionRow = serde_json::from_value(serde_json::json!({"name": "c", "provider": "codex", "headless": true})).unwrap();
        let info = info_of(&codex, Path::new("/c"));
        assert!(info.headless && info.jsonl.is_none() && info.session_key.is_empty());
    }
}
