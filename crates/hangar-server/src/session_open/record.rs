//! Registro do spec: `~/.hangar/session-specs/<key>.json`, um por sessão, gravado só pelo Rust
//! (tmp + troca). Pela `key` e não pelo nome porque o rename (ainda do Python,
//! `runtime_coordinator.py`) troca o nome e não conhece este arquivo: o `name` gravado é o de quando
//! a sessão nasceu, e quem reabre toma o nome atual da lista.
//!
//! Os sidecars de hoje (`claude-headless/`, `codex-sessions/`) seguem com todos os campos nesta
//! entrega, para um revert não reabrir sessão em modo errado. O `hangar-codex-tui` lê e grava
//! `permission_mode` no sidecar Codex (`scripts/hangar-codex-tui`, relançar e retomar importado):
//! por isso o modo do Codex continua morando lá, e `from_sidecars` o lê de lá para as sessões que
//! nasceram antes do registro.
use std::io;
use std::path::{Path, PathBuf};

use serde_json::Value;

use super::{Account, AccountSource, AgentProvider, PermissionMode, SPEC_VERSION, ServiceTier, SessionSpec, Surface};

pub fn dir(home: &Path) -> PathBuf { home.join(".hangar").join("session-specs") }

/// A `key` vira nome de arquivo: só o formato que o Hangar gera (hex de 32).
fn path(home: &Path, key: &str) -> io::Result<PathBuf> {
    if key.len() != 32 || !key.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "chave de sessão fora do formato"));
    }
    Ok(dir(home).join(format!("{key}.json")))
}

pub fn write(home: &Path, spec: &SessionSpec) -> io::Result<()> {
    let path = path(home, &spec.key)?;
    std::fs::create_dir_all(dir(home))?;
    crate::runtime::queue::atomic_write(&path, &serde_json::to_vec_pretty(spec)?)
}

/// `Ok(None)` só quando não existe; arquivo ilegível ou de outra versão é erro, nunca um spec inventado.
pub fn read(home: &Path, key: &str) -> io::Result<Option<SessionSpec>> {
    let bytes = match crate::runtime::queue::read_replaced(&path(home, key)?) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    let spec: SessionSpec = serde_json::from_slice(&bytes).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    if spec.version != SPEC_VERSION {
        return Err(io::Error::new(io::ErrorKind::InvalidData, format!("registro de versão {}", spec.version)));
    }
    Ok(Some(spec))
}

fn text(meta: &Value, key: &str) -> Option<String> { meta[key].as_str().filter(|s| !s.is_empty()).map(str::to_owned) }

/// Spec de uma sessão viva que nasceu antes do registro, montado do sidecar dela. A conta gravada
/// vale como escolhida (reabrir nunca a troca pela cota). Claude com terminal, Pi, omp, Kimi e o
/// sidecar sem `key` (Codex com terminal, CDX-9) não dão spec: `None`.
pub fn from_sidecars(home: &Path, name: &str) -> Option<SessionSpec> {
    let safe = crate::list::discover_other::sanitize_session_name(name);
    let hangar = home.join(".hangar");
    let read = |path: PathBuf| crate::runtime::codex_sidecar::load(&path).map(Value::Object);
    let created = |path: &Path| std::fs::metadata(path).and_then(|m| m.modified()).ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map_or(0.0, |d| d.as_secs_f64());
    let tier = |meta: &Value| meta["service_tier"].as_str().and_then(|t| serde_json::from_value::<ServiceTier>(Value::from(t)).ok());
    let claude_path = hangar.join("claude-headless").join(format!("{safe}.json"));
    if let Some(meta) = read(claude_path.clone()) {
        let config_dir = text(&meta, "config_dir");
        let account = match text(&meta, "engine") {
            Some(name) => Account::Engine { name, account: text(&meta, "engine_account"), config_dir,
                context_window: meta["context_window"].as_u64() },
            None => config_dir.map_or(Account::Default, |config_dir| Account::Claude { config_dir }),
        };
        return Some(SessionSpec {
            version: SPEC_VERSION, key: text(&meta, "key")?, name: text(&meta, "name").unwrap_or_else(|| name.into()),
            cwd: text(&meta, "cwd")?, provider: AgentProvider::Claude, surface: Surface::Headless, account,
            account_source: AccountSource::Explicit, model: text(&meta, "model"), effort: text(&meta, "effort"), service_tier: tier(&meta),
            permission_mode: text(&meta, "permission_mode").as_deref().and_then(PermissionMode::claude),
            // A seleção de plugins e skills mora no registro de customizações do Rust, pelo id da conversa.
            subagent_model: text(&meta, "subagent_model"), customizations: None, jev: meta["jev"] == true,
            read_only: meta["read_only"] == true, worktree: None, creator: None, created_at: created(&claude_path),
        });
    }
    let codex_path = crate::runtime::codex_sidecar::path(&crate::runtime::codex_sidecar::dir(home), name);
    let meta = read(codex_path.clone())?;
    Some(SessionSpec {
        version: SPEC_VERSION, key: text(&meta, "key")?, name: text(&meta, "name").unwrap_or_else(|| name.into()),
        cwd: text(&meta, "cwd")?, provider: AgentProvider::Codex,
        surface: if meta["headless"] == true { Surface::Headless } else { Surface::Terminal },
        account: Account::Codex { account_id: text(&meta, "codex_account").unwrap_or_else(|| "default".into()) },
        account_source: AccountSource::Explicit, model: text(&meta, "model"), effort: text(&meta, "effort"), service_tier: tier(&meta),
        // Modo gravado fora da lista fica ausente: quem reabre recusa em vez de abrir em Full Access (S-05).
        permission_mode: text(&meta, "permission_mode").as_deref().and_then(PermissionMode::codex),
        subagent_model: None, customizations: None, jev: meta["jev"] == true, read_only: meta["read_only"] == true,
        worktree: None, creator: None, created_at: created(&codex_path),
    })
}
