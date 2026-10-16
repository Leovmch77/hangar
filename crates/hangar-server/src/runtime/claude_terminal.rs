//! Claude com terminal adotado pelo Rust: o pane da sessão vira entrada no runtime na primeira escrita
//! (ou na subida, quando já tinha fila), sem o Python registrar antes (`resolve_binding`/`prepare_session`
//! de lá). A chave da fila é a `CP_SESSION_KEY` do pane, a do spec; pane sem ela (aberto antes do
//! registro) fica com a chave da fila que o Python já tinha dado a esta vida, ou ganha uma agora, gravada
//! no ambiente da sessão do multiplexador para a próxima adoção achar a mesma.
use super::codex_terminal::Watcher;
use super::gateway::RuntimeRegistry;
use super::protocol::RuntimeError;
use super::terminal::TerminalTarget;
use crate::list::mux::Pane;
use crate::list::procs::{ProcessView, SystemProcs};
use crate::terminal_facts::TerminalMetadata;
use crate::terminal_input::TerminalBinding;
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::time::Duration;

fn refused(code: &str, message: &str) -> RuntimeError { RuntimeError::new(code, message) }

/// Opções que o wrapper do Hangar põe antes dos argumentos de quem chamou (`_WRAPPER_OPTIONS`).
const WRAPPER_OPTIONS: [&str; 2] = ["--session-id", "--plugin-dir"];

/// `_claude_login`: `claude auth`, `login` ou `setup-token` não são conversa.
fn login(argv: &[String]) -> bool {
    let mut rest = argv.get(1..).unwrap_or_default();
    while let Some(first) = rest.first().filter(|a| WRAPPER_OPTIONS.iter().any(|o| a.starts_with(o))) {
        rest = rest.get(if first.contains('=') { 1 } else { 2 }..).unwrap_or_default();
    }
    rest.first().is_some_and(|a| matches!(a.as_str(), "auth" | "login" | "setup-token"))
}

/// A chave lida do ambiente da sessão (`show-environment`); ausente = `None`.
fn session_key(output: &str) -> Option<String> {
    let value = output.lines().find_map(|line| line.trim().strip_prefix("CP_SESSION_KEY="))?;
    super::codex_terminal::valid_key(value).then(|| value.to_owned())
}

/// A chave que o Python deu a esta vida do pane (o `_binding` gravado na fila), para a fila dela não
/// ficar órfã na primeira adoção pelo Rust.
fn legacy_key(queue_dir: &Path, name: &str, pane: &str, created: u64) -> Option<String> {
    std::fs::read_dir(queue_dir.join("runtime")).ok()?.flatten().find_map(|entry| {
        let path = entry.path();
        if path.extension().is_none_or(|ext| ext != "json") { return None; }
        let state: Value = serde_json::from_slice(&super::queue::read_replaced(&path).ok()?).ok()?;
        let binding = &state["runtime_state"]["_binding"];
        let terminal = &binding["meta"]["terminal"];
        (binding["name"] == name && binding["headless"] == false && terminal["pane"] == pane && terminal["created"] == created)
            .then(|| binding["key"].as_str().filter(|k| super::codex_terminal::valid_key(k)).map(str::to_owned)).flatten()
    })
}

/// Geração gravada na fila da chave; sem fila, a primeira.
fn generation(state_path: &Path) -> Result<u64, RuntimeError> {
    match super::queue::read_replaced(state_path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(1),
        Err(error) => Err(refused("queue_io", &format!("fila da sessão inacessível: {:?}", error.kind()))),
        Ok(raw) => serde_json::from_slice::<Value>(&raw).ok().and_then(|state| state["generation"].as_u64())
            .ok_or_else(|| refused("queue_io", "fila da sessão ilegível")),
    }
}

/// O que o pane prova: o agente, a conta e a conversa dele.
struct Proven { agent: u32, config_dir: PathBuf, conversation: String, transcript: PathBuf, plugin_key: Option<String>, pane_birth: Option<f64> }

/// O agente Claude do pane e a conversa que ele roda. `Ok(None)`: o pane não é de uma conversa Claude
/// (shell, outro agente, `claude login`), e a escrita segue o caminho de sempre.
fn prove(panes: &[Pane], name: &str, claude_base: &Path) -> Result<Option<Proven>, RuntimeError> {
    let procs = SystemProcs::default();
    let children = procs.children(Duration::ZERO).map_err(|_| refused("claude_terminal_process_unavailable", "os processos da máquina não puderam ser lidos"))?;
    let mut resolver = crate::list::discover::Resolver::default();
    let mine: Vec<Pane> = panes.iter().filter(|p| p.session == name).cloned().collect();
    // Primeiro sem a conta: o agente diz qual é a dele.
    let rows = crate::list::discover::discover_panes(&mine, &procs, &children, &claude_base.join("projects"), &mut resolver, &|_| false);
    let Some(row) = rows.into_iter().next() else { return Ok(None) };
    let Some(agent) = row.agent_pid.and_then(|pid| u32::try_from(pid).ok()).filter(|pid| *pid > 0) else {
        // Só shell no pane: aberto pelo Hangar (CP_PROVIDER=claude) é o Claude ainda nascendo.
        if mine.iter().any(|p| p.provider.as_deref() == Some("claude")) {
            return Err(refused("claude_terminal_not_ready", "o Claude ainda não abriu no terminal desta sessão"));
        }
        return Ok(None);
    };
    if row.provider != "claude" { return Ok(None); }
    let argv = procs.argv_checked(i64::from(agent)).map_err(|_| refused("claude_terminal_process_unavailable", "o processo do Claude não pôde ser lido"))?;
    if login(&argv) { return Ok(None); }
    let env = |var: &str| procs.env_var(i64::from(agent), var).ok().flatten().map(|v| v.to_string_lossy().into_owned()).filter(|v| !v.is_empty());
    let config_dir = env("CLAUDE_CONFIG_DIR").map_or_else(|| claude_base.to_owned(), PathBuf::from);
    let record = config_dir.join("sessions").join(format!("{agent}.json"));
    let native = match std::fs::read(&record) {
        Ok(raw) => {
            let native: Value = serde_json::from_slice(&raw).map_err(|_| refused("terminal_native_record_unavailable", "o registro do Claude no terminal está ilegível"))?;
            if native["pid"].as_u64() != Some(u64::from(agent)) { return Err(refused("terminal_native_record_changed", "o registro do Claude no terminal é de outro processo")); }
            native["sessionId"].as_str().filter(|s| !s.is_empty()).map(str::to_owned)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(_) => return Err(refused("terminal_native_record_unavailable", "o registro do Claude no terminal não pôde ser lido")),
    };
    let (conversation, transcript) = match native {
        Some(sid) => {
            let transcript = config_dir.join("projects").join(hangar_workspace::worktrees::sanitize_cwd(&row.cwd)).join(format!("{sid}.jsonl"));
            (sid, transcript)
        }
        None => {
            // Sem o registro nativo: o transcript que a lista prova para o pane, na conta do agente.
            let mut resolver = crate::list::discover::Resolver::default();
            let source = crate::list::discover::resolve_one(&mine, &procs, &children, &config_dir.join("projects"), &mut resolver, name, &row.cwd, row.pane_pid);
            let Some(jsonl) = source.jsonl.filter(|_| source.tracked) else {
                return Err(refused("claude_terminal_conversation_unproved", "não há prova de qual conversa o Claude deste terminal roda"));
            };
            let path = PathBuf::from(jsonl);
            let sid = path.file_stem().and_then(|s| s.to_str()).map(str::to_owned).unwrap_or_default();
            if sid.is_empty() || row.repl_sid.as_deref().is_some_and(|repl| repl != sid) {
                return Err(refused("claude_terminal_conversation_unproved", "não há prova de qual conversa o Claude deste terminal roda"));
            }
            (sid, path)
        }
    };
    let plugin_key = env("HANGAR_PLUGIN_TOKEN").and_then(|token| token.split_once('.').map(|(key, _)| key.to_owned())).filter(|k| !k.is_empty());
    let pane_birth = row.pane_pid.and_then(|pid| procs.start_time(pid));
    Ok(Some(Proven { agent, config_dir, conversation, transcript, plugin_key, pane_birth }))
}

impl Watcher {
    /// Escrita para um Claude com terminal sem ator aqui: o Rust o adota. `None` = não há conversa Claude
    /// no pane com esse nome.
    pub async fn adopt_claude(&self, registry: &RuntimeRegistry, name: &str) -> Option<Result<(), RuntimeError>> {
        let _round = self.misses.lock().await;
        if registry.has_entry(None, name).await { return Some(Ok(())); }
        let panes = match self.cfg.mux.list_panes().await {
            Ok(panes) => panes,
            Err(_) => return None,
        };
        let pane = panes.iter().filter(|p| p.session == name).max_by_key(|p| p.active)?.clone();
        let claude_base = registry.codex_environment().claude_base;
        let found = {
            let (panes, name, base) = (panes.clone(), name.to_owned(), claude_base.clone());
            tokio::task::spawn_blocking(move || prove(&panes, &name, &base)).await
                .unwrap_or_else(|_| Err(refused("claude_terminal_process_unavailable", "a leitura dos processos parou no meio")))
        };
        let proven = match found {
            Ok(Some(proven)) => proven,
            Ok(None) => return None,
            Err(error) => return Some(Err(error)),
        };
        Some(self.open_claude(registry, name, &pane, proven).await)
    }

    async fn open_claude(&self, registry: &RuntimeRegistry, name: &str, pane: &Pane, proven: Proven) -> Result<(), RuntimeError> {
        let created = pane.session_created.ok_or_else(|| refused("claude_terminal_pane", "o multiplexador não informou quando a sessão nasceu"))?;
        let target_pane = pane.target().unwrap_or_else(|| format!("={name}:"));
        let program = self.cfg.mux_program.to_string_lossy().into_owned();
        let shown = self.mux_text(&["show-environment", "-t", &format!("={name}"), "CP_SESSION_KEY"]).await.unwrap_or_default();
        let key = match session_key(&shown) {
            Some(key) => key,
            None => {
                let (queue, owned, pane_id) = (self.cfg.queue_dir.clone(), name.to_owned(), target_pane.clone());
                let legacy = tokio::task::spawn_blocking(move || legacy_key(&queue, &owned, &pane_id, created)).await.ok().flatten();
                let key = legacy.unwrap_or_else(|| crate::mods::state::random_hex(16));
                // Gravada na sessão: a próxima adoção (outro processo do Rust) acha a mesma fila.
                if self.mux_text(&["set-environment", "-t", &format!("={name}"), "CP_SESSION_KEY", &key]).await.is_none() {
                    return Err(refused("claude_terminal_key", "a chave da sessão não foi gravada no terminal"));
                }
                key
            }
        };
        let (state_path, lease_path) = super::codex_terminal::queue_files(&self.cfg.queue_dir, &key);
        let generation = { let path = state_path.clone(); tokio::task::spawn_blocking(move || generation(&path)).await.map_err(|_| refused("queue_io", "fila da sessão inacessível"))?? };
        let binding = TerminalBinding { name: name.to_owned(), pane: target_pane, conversation: proven.conversation.clone(), generation, created,
            mux_argv: vec![program], windows: cfg!(windows), clipboard_lock_path: Some(self.cfg.queue_dir.join("runtime").join("clipboard.lock")) };
        let meta = json!({"key": key, "config_dir": proven.config_dir, "agent_pid": proven.agent, "legacy_import_after": proven.pane_birth});
        let metadata = TerminalMetadata::resolve(&meta, &binding, &proven.transcript).await.map_err(|error| refused(error.0, "o Claude do terminal não provou a vida dele"))?;
        let target = TerminalTarget { key, generation, name: name.to_owned(), binding, lease_path, state_path, projection_dir: self.cfg.queue_dir.clone(),
            transcript: proven.transcript, created: proven.pane_birth.unwrap_or(created as f64).max(created as f64), plugin_key: proven.plugin_key, metadata };
        registry.open_terminal(target).await.map(|_| ())
    }

    /// Saída de um comando do multiplexador que deu certo.
    async fn mux_text(&self, args: &[&str]) -> Option<String> {
        let mut command = crate::terminal_input::child_command(&self.cfg.mux_program);
        command.args(args).stdin(std::process::Stdio::null()).kill_on_drop(true);
        let out = tokio::time::timeout(Duration::from_secs(5), command.output()).await.ok()?.ok()?;
        out.status.success().then(|| String::from_utf8_lossy(&out.stdout).into_owned())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn login_skips_the_wrapper_options() {
        let v = |a: &[&str]| a.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert!(login(&v(&["claude", "--session-id", "x", "auth", "status"])));
        assert!(login(&v(&["claude", "--plugin-dir=/p", "login"])));
        assert!(!login(&v(&["claude", "--session-id", "x"])));
        assert!(!login(&v(&["claude", "--model", "login"])), "valor de outra opção não é subcomando");
    }

    #[test]
    fn session_key_reads_only_a_valid_value() {
        assert_eq!(session_key("CP_SESSION_KEY=abc_1\n").as_deref(), Some("abc_1"));
        assert_eq!(session_key("-CP_SESSION_KEY\n"), None);
        assert_eq!(session_key("CP_SESSION_KEY=a/b\n"), None);
    }

    #[test]
    fn legacy_key_is_the_python_binding_of_the_same_pane_life() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("runtime")).unwrap();
        let state = |key: &str, created: u64| json!({"runtime_state": {"_binding": {"name": "s1", "key": key, "headless": false,
            "meta": {"terminal": {"pane": "%3", "created": created}}}}});
        std::fs::write(dir.path().join("runtime/terminal_old.json"), state("terminal_old", 10).to_string()).unwrap();
        std::fs::write(dir.path().join("runtime/terminal_now.json"), state("terminal_now", 20).to_string()).unwrap();
        assert_eq!(legacy_key(dir.path(), "s1", "%3", 20).as_deref(), Some("terminal_now"));
        assert_eq!(legacy_key(dir.path(), "s1", "%4", 20), None, "outro pane é outra vida");
    }
}
