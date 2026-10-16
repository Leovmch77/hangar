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

/// A abertura que não nasceu tira o registro que gravou.
pub fn remove(home: &Path, key: &str) -> io::Result<()> {
    match std::fs::remove_file(path(home, key)?) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        other => other,
    }
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

/// O spec que vale para reabrir a sessão viva `name`: o registro dela (pela `key` do sidecar), senão
/// o montado do sidecar. No Codex o modo que o `hangar-codex-tui` gravou por último no sidecar (só
/// valor válido) vence o da criação: o estado observado vale, como no S-02 do Claude.
pub fn live(home: &Path, name: &str) -> io::Result<Option<SessionSpec>> {
    let Some(sidecar) = from_sidecars(home, name)? else { return Ok(None) };
    let Some(mut spec) = read(home, &sidecar.key)? else { return Ok(Some(sidecar)) };
    if spec.provider == AgentProvider::Codex && sidecar.permission_mode.is_some() {
        spec.permission_mode = sidecar.permission_mode;
    }
    spec.name = sidecar.name;
    Ok(Some(spec))
}

fn text(meta: &Value, key: &str) -> Option<String> { meta[key].as_str().filter(|s| !s.is_empty()).map(str::to_owned) }

/// O spec que relança o Claude sem terminal: o sidecar manda no que ele guarda (o modo, o modelo e o
/// esforço que a CLI mudou sozinha, S-02; a conta trocada), e o registro da `key` traz o que só ele tem
/// (escolhas de plugins e skills, worktree, criadora, de onde veio a conta).
pub fn claude_live(home: &Path, meta: &Value, name: &str) -> io::Result<SessionSpec> {
    let mut spec = claude_from_meta(meta, name, 0.0)?;
    // Chave de outro formato (`terminal_<hash>`, herdada da troca de modo) nunca teve registro.
    let recorded = match read(home, &spec.key) {
        Err(error) if error.kind() == io::ErrorKind::InvalidInput => None,
        other => other?,
    };
    let Some(recorded) = recorded else { return Ok(spec) };
    if let (Account::Engine { name, context_window_unknown, .. }, Account::Engine { name: was, context_window_unknown: unknown, .. })
        = (&mut spec.account, &recorded.account) && name == was && meta["context_window"].is_null() {
        *context_window_unknown = *unknown;
    }
    spec.customizations = recorded.customizations;
    spec.worktree = recorded.worktree;
    spec.creator = recorded.creator;
    spec.account_source = recorded.account_source;
    spec.created_at = recorded.created_at;
    Ok(spec)
}

/// Spec de uma sessão Claude sem terminal montado do sidecar dela; o sidecar sem `key` ou sem `cwd` é erro.
pub fn claude_from_meta(meta: &Value, name: &str, created_at: f64) -> io::Result<SessionSpec> {
    let missing = |field: &str| io::Error::new(io::ErrorKind::InvalidData, format!("sidecar de {name} sem {field}"));
    let cwd = text(meta, "cwd").ok_or_else(|| missing("cwd"))?;
    let key = text(meta, "key").ok_or_else(|| missing("key"))?;
    let config_dir = text(meta, "config_dir");
    let account = match text(meta, "engine") {
        Some(name) => Account::Engine { name, account: text(meta, "engine_account"), config_dir,
            context_window: meta["context_window"].as_u64(), context_window_unknown: false },
        None => config_dir.map_or(Account::Default, |config_dir| Account::Claude { config_dir }),
    };
    let tier = meta["service_tier"].as_str().and_then(|t| serde_json::from_value::<ServiceTier>(Value::from(t)).ok());
    Ok(SessionSpec {
        version: SPEC_VERSION, key, name: text(meta, "name").unwrap_or_else(|| name.into()),
        cwd, provider: AgentProvider::Claude, surface: Surface::Headless, account,
        account_source: AccountSource::Explicit, model: text(meta, "model"), effort: text(meta, "effort"), service_tier: tier,
        permission_mode: text(meta, "permission_mode").as_deref().and_then(PermissionMode::claude),
        // A seleção de plugins e skills mora no registro de customizações do Rust, pelo id da conversa.
        subagent_model: text(meta, "subagent_model"), customizations: None, jev: meta["jev"] == true,
        read_only: meta["read_only"] == true, worktree: None, creator: None, created_at,
        conversation: text(meta, "session_id"),
    })
}

/// Spec de uma sessão viva que nasceu antes do registro, montado do sidecar dela. A conta gravada
/// vale como escolhida (reabrir nunca a troca pela cota). Claude com terminal, Pi, omp, Kimi e o
/// sidecar sem `key` (Codex com terminal, CDX-9) não dão spec: `None`.
/// Sidecar ilegível, que não é objeto ou sem `cwd` é erro, nunca "sessão sem sidecar".
pub fn from_sidecars(home: &Path, name: &str) -> io::Result<Option<SessionSpec>> {
    let safe = crate::list::discover_other::sanitize_session_name(name);
    let hangar = home.join(".hangar");
    let read = |path: &Path| crate::runtime::codex_sidecar::read(path).map(|meta| meta.map(Value::Object));
    let cwd = |meta: &Value| text(meta, "cwd").ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, format!("sidecar de {name} sem cwd")));
    let created = |path: &Path| std::fs::metadata(path).and_then(|m| m.modified()).ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map_or(0.0, |d| d.as_secs_f64());
    let tier = |meta: &Value| meta["service_tier"].as_str().and_then(|t| serde_json::from_value::<ServiceTier>(Value::from(t)).ok());
    let claude_path = hangar.join("claude-headless").join(format!("{safe}.json"));
    if let Some(meta) = read(&claude_path)? {
        cwd(&meta)?;
        if text(&meta, "key").is_none() { return Ok(None) }
        return claude_from_meta(&meta, name, created(&claude_path)).map(Some);
    }
    let codex_path = crate::runtime::codex_sidecar::path(&crate::runtime::codex_sidecar::dir(home), name);
    let Some(meta) = read(&codex_path)? else { return Ok(None) };
    let cwd = cwd(&meta)?;
    let Some(key) = text(&meta, "key") else { return Ok(None) };
    Ok(Some(SessionSpec {
        version: SPEC_VERSION, key, name: text(&meta, "name").unwrap_or_else(|| name.into()),
        cwd, provider: AgentProvider::Codex,
        surface: if meta["headless"] == true { Surface::Headless } else { Surface::Terminal },
        account: Account::Codex { account_id: text(&meta, "codex_account").unwrap_or_else(|| "default".into()) },
        account_source: AccountSource::Explicit, model: text(&meta, "model"), effort: text(&meta, "effort"), service_tier: tier(&meta),
        // Modo gravado fora da lista fica ausente: quem reabre recusa em vez de abrir em Full Access (S-05).
        permission_mode: text(&meta, "permission_mode").as_deref().and_then(PermissionMode::codex),
        subagent_model: None, customizations: None, jev: meta["jev"] == true, read_only: meta["read_only"] == true,
        worktree: None, creator: None, created_at: created(&codex_path), conversation: text(&meta, "thread_id"),
    }))
}
