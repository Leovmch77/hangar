//! As sessões Claude com terminal abertas pela versão antiga do Hangar não têm spec nem `CP_SESSION_KEY`:
//! o restore pelos specs não as vê, e o tmux-resurrect as devolve como shell vazio. O script antigo
//! deixou o mapa delas (`claude-sessions.tsv`: nome, agente, conversa, conta); depois da passada pelos
//! specs, cada uma volta uma vez pela retomada do Arquivo, com terminal e na conta do mapa. Depois disso
//! tem spec e entra no restore normal. Só Linux: no Windows não há resurrect.
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::Duration;

use futures_util::future::BoxFuture;
use serde_json::{Value, json};

/// As conversas já retomadas daqui, para não reabrir a mesma duas vezes.
pub const DONE: &str = "legacy-resumed.json";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Legacy { pub name: String, pub conversation: String, pub config_dir: Option<String> }

pub struct Paths {
    /// `claude-sessions.tsv` e a `last` do resurrect moram aqui.
    pub resurrect: PathBuf,
    pub done: PathBuf,
    /// `projects` da conta padrão (conta vazia no mapa).
    pub server_projects: PathBuf,
}

impl Paths {
    pub fn new(home: &Path, server_projects: PathBuf) -> Self {
        let resurrect = std::env::var_os("TMUX_RESURRECT_DIR").filter(|d| !d.is_empty()).map(PathBuf::from)
            .unwrap_or_else(|| home.join(".local/share/tmux/resurrect"));
        Self { resurrect, done: home.join(".hangar").join(DONE), server_projects }
    }
}

/// Ausente = vazio; ilegível = o código.
fn read_text(path: &Path, code: &'static str) -> Result<String, &'static str> {
    match std::fs::read_to_string(path) {
        Ok(text) => Ok(text),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(_) => Err(code),
    }
}

/// As linhas `nome, agente, conversa, conta` do mapa.
fn read_map(text: &str) -> Vec<(String, String, String, Option<String>)> {
    text.lines().filter_map(|line| {
        let mut fields = line.split('\t');
        let (name, provider, conversation) = (fields.next()?, fields.next()?, fields.next()?);
        let config_dir = fields.next().filter(|c| !c.is_empty()).map(str::to_owned);
        (!name.is_empty() && !conversation.is_empty()).then(|| (name.to_owned(), provider.to_owned(), conversation.to_owned(), config_dir))
    }).collect()
}

/// As sessões da última gravação do resurrect (`last`, linhas `pane`/`window`).
fn last_saved(text: &str) -> HashSet<String> {
    text.lines().filter_map(|line| {
        let mut fields = line.split('\t');
        matches!(fields.next(), Some("pane" | "window")).then(|| fields.next()).flatten().map(str::to_owned)
    }).collect()
}

fn read_done(path: &Path) -> Result<HashSet<String>, &'static str> {
    let text = read_text(path, "legacy_restore_done_unreadable")?;
    if text.is_empty() { return Ok(HashSet::new()); }
    serde_json::from_str::<Vec<String>>(&text).map(|l| l.into_iter().collect()).map_err(|_| "legacy_restore_done_unreadable")
}

#[derive(Debug, PartialEq)]
enum Pane { Absent, EmptyShell, Busy, Keyed, Unknown }

async fn mux(program: &std::ffi::OsStr, args: &[&str]) -> Option<std::process::Output> {
    let mut command = crate::terminal_input::child_command(program);
    command.args(args).stdin(std::process::Stdio::null()).kill_on_drop(true);
    tokio::time::timeout(Duration::from_secs(5), command.output()).await.ok()?.ok()
}

const SHELLS: [&str; 5] = ["fish", "bash", "zsh", "sh", "dash"];

/// Todo pane da sessão é um shell, e o que roda debaixo dele nasceu até `init` depois dele: o
/// `config.fish` e afins. ponytail: pela hora de nascimento; o comando digitado nesse intervalo conta como
/// inicialização.
fn empty_shells(pids: &[u32], init: Duration) -> bool {
    let mut system = sysinfo::System::new();
    system.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
    pids.iter().all(|&pid| {
        let Some(root) = system.process(sysinfo::Pid::from_u32(pid)) else { return false };
        if !SHELLS.contains(&root.name().to_string_lossy().as_ref()) { return false; }
        let limit = root.start_time() + init.as_secs();
        let mut stack = vec![root.pid()];
        while let Some(parent) = stack.pop() {
            for child in system.processes().values().filter(|p| p.parent() == Some(parent)) {
                if child.start_time() > limit { return false; }
                stack.push(child.pid());
            }
        }
        true
    })
}

async fn pane(program: &std::ffi::OsStr, name: &str, init: Duration) -> Pane {
    let target = format!("={name}");
    let Some(has) = mux(program, &["has-session", "-t", &target]).await else { return Pane::Unknown };
    if !has.status.success() {
        return if crate::list::mux::is_absence(&String::from_utf8_lossy(&has.stderr)) { Pane::Absent } else { Pane::Unknown };
    }
    let Some(out) = mux(program, &["list-panes", "-s", "-t", &target, "-F", "#{pane_pid}"]).await.filter(|o| o.status.success())
        else { return Pane::Unknown };
    let pids: Vec<u32> = String::from_utf8_lossy(&out.stdout).lines().filter_map(|l| l.trim().parse().ok()).collect();
    let Some(env) = mux(program, &["show-environment", "-t", &target]).await.filter(|o| o.status.success()) else { return Pane::Unknown };
    if String::from_utf8_lossy(&env.stdout).lines().any(|l| l.starts_with("CP_SESSION_KEY=")) { return Pane::Keyed; }
    if pids.is_empty() { return Pane::Unknown; }
    if empty_shells(&pids, init) { Pane::EmptyShell } else { Pane::Busy }
}

/// A pasta de projeto onde a conversa mora na conta.
fn project_of(projects: &Path, conversation: &str) -> Result<String, &'static str> {
    const MISSING: &str = "legacy_restore_transcript_missing";
    let uuid = conversation.len() == 36 && conversation.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-');
    if !uuid { return Err(MISSING); }
    let file = format!("{conversation}.jsonl");
    let entries = match std::fs::read_dir(projects) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Err(MISSING),
        Err(_) => return Err("legacy_restore_projects_unreadable"),
    };
    entries.flatten().find(|e| e.path().join(&file).is_file()).and_then(|e| e.file_name().into_string().ok()).ok_or(MISSING)
}

fn line(name: &str, code: &str) -> Value {
    let (evento, nivel) = match code {
        "legacy_restore_resumed" => ("sessao.legado_retomada", "ok"),
        "legacy_restore_done_unwritten" => ("sessao.legado_retomada", "aviso"),
        "legacy_restore_has_key" | "legacy_restore_pane_busy" | "legacy_restore_not_in_last_save" | "legacy_restore_already_resumed"
            | "legacy_restore_provider_unsupported" => ("sessao.legado_pulada", "aviso"),
        _ => ("sessao.legado_falhou", "erro"),
    };
    json!({"evento": evento, "nivel": nivel, "sessao": name, "codigo": code})
}

/// `resume(sessão, projeto)` reabre pelo Arquivo e devolve o código da falha. Devolve as linhas do diário.
pub async fn run(program: &std::ffi::OsStr, paths: &Paths, init: Duration,
                 resume: &(dyn Fn(Legacy, String) -> BoxFuture<'static, Result<(), String>> + Send + Sync)) -> Vec<Value> {
    let read = read_text(&paths.resurrect.join("claude-sessions.tsv"), "legacy_restore_map_unreadable").and_then(|map| {
        let last = read_text(&paths.resurrect.join("last"), "legacy_restore_last_save_unreadable")?;
        Ok((read_map(&map), last_saved(&last), read_done(&paths.done)?))
    });
    let (map, last, mut done) = match read {
        Ok(read) => read,
        Err(code) => return vec![line("-", code)],
    };
    let mut out = Vec::new();
    for (name, provider, conversation, config_dir) in map {
        let skip = |code: &str| line(&name, code);
        if provider != "claude" { out.push(skip("legacy_restore_provider_unsupported")); continue; }
        if done.contains(&conversation) { out.push(skip("legacy_restore_already_resumed")); continue; }
        let state = pane(program, &name, init).await;
        let code = match state {
            Pane::Keyed => Some("legacy_restore_has_key"),
            Pane::Busy => Some("legacy_restore_pane_busy"),
            Pane::Unknown => Some("legacy_restore_mux_unavailable"),
            Pane::Absent if !last.contains(&name) => Some("legacy_restore_not_in_last_save"),
            Pane::Absent | Pane::EmptyShell => None,
        };
        if let Some(code) = code { out.push(skip(code)); continue; }
        let projects = config_dir.as_ref().map_or_else(|| paths.server_projects.clone(), |d| Path::new(d).join("projects"));
        let project = match project_of(&projects, &conversation) {
            Ok(project) => project,
            Err(code) => { out.push(skip(code)); continue; }
        };
        // O shell vazio ocupa o nome.
        if state == Pane::EmptyShell && !mux(program, &["kill-session", "-t", &format!("={name}")]).await.is_some_and(|o| o.status.success()) {
            out.push(skip("legacy_restore_kill_failed"));
            continue;
        }
        let legacy = Legacy { name: name.clone(), conversation: conversation.clone(), config_dir };
        match resume(legacy, project).await {
            Ok(()) => {
                done.insert(conversation);
                let mut list: Vec<&String> = done.iter().collect();
                list.sort();
                let written = serde_json::to_vec(&list).map_err(std::io::Error::other)
                    .and_then(|raw| { std::fs::create_dir_all(paths.done.parent().unwrap_or(Path::new("."))).and_then(|()| crate::runtime::queue::atomic_write(&paths.done, &raw)) });
                out.push(skip(if written.is_ok() { "legacy_restore_resumed" } else { "legacy_restore_done_unwritten" }));
            }
            Err(code) => out.push(skip(&code)),
        }
    }
    out
}

/// A passada no servidor: retoma pelo Arquivo, com terminal, e grava o diário.
pub async fn after_restore(st: &std::sync::Arc<crate::routes::AppState>, home: &Path, program: &std::ffi::OsStr) {
    let server_projects = super::open::OpenHost::server_projects(&super::server::ServerHost::new(st.clone()).await);
    let st = st.clone();
    let resume = move |legacy: Legacy, project: String| -> BoxFuture<'static, Result<(), String>> {
        let st = st.clone();
        Box::pin(async move {
            let body = super::archive::ArchiveBody { provider: "claude".into(), name: Some(legacy.name), config_dir: legacy.config_dir,
                headless: Some(false), ..Default::default() };
            super::server::resume_archived(&st, &project, &legacy.conversation, body).await
                .map(|_| ()).map_err(|e| e.code.unwrap_or("legacy_open_failed").to_owned())
        })
    };
    let lines = run(program, &Paths::new(home, server_projects), INIT, &resume).await;
    if !lines.is_empty() { crate::diag::record_blocking(crate::diag::diary_dir().as_deref(), &lines, "restore da versão antiga"); }
}

/// O que nasce debaixo do shell até aqui é inicialização dele.
const INIT: Duration = Duration::from_secs(15);

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;
    use std::collections::BTreeMap;
    use std::process::Command;
    use std::sync::{Arc, Mutex};

    const A: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const B: &str = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const C: &str = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const D: &str = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const E: &str = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    const F: &str = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    const G: &str = "11111111-1111-4111-8111-111111111111";

    struct Tmux { program: PathBuf, _dir: tempfile::TempDir }
    impl Tmux {
        fn new() -> Self {
            let dir = tempfile::tempdir().unwrap();
            let program = dir.path().join("tmux");
            let socket = format!("hangar-legacy-{}", std::process::id());
            std::fs::write(&program, format!("#!/bin/sh\nSHELL=/bin/sh exec tmux -L {socket} -f /dev/null \"$@\"\n")).unwrap();
            std::fs::set_permissions(&program, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
            Self { program, _dir: dir }
        }
        fn run(&self, args: &[&str]) -> bool { Command::new(&self.program).args(args).status().unwrap().success() }
        fn alive(&self, name: &str) -> bool { self.run(&["has-session", "-t", &format!("={name}")]) }
        fn pane_pid(&self, name: &str) -> u32 {
            let out = Command::new(&self.program).args(["display-message", "-p", "-t", &format!("={name}:"), "#{pane_pid}"]).output().unwrap();
            String::from_utf8_lossy(&out.stdout).trim().parse().unwrap()
        }
    }
    impl Drop for Tmux { fn drop(&mut self) { let _ = self.run(&["kill-server"]); } }

    fn children(pid: u32) -> usize {
        std::fs::read_to_string(format!("/proc/{pid}/task/{pid}/children")).unwrap_or_default().split_whitespace().count()
    }

    fn wait(what: &str, mut ok: impl FnMut() -> bool) {
        let end = std::time::Instant::now() + Duration::from_secs(15);
        while !ok() { assert!(std::time::Instant::now() < end, "{what}"); std::thread::sleep(Duration::from_millis(50)); }
    }

    fn transcript(projects: &Path, sid: &str) {
        std::fs::create_dir_all(projects.join("-w")).unwrap();
        std::fs::write(projects.join("-w").join(format!("{sid}.jsonl")), "{}\n").unwrap();
    }

    /// O mapa da versão antiga volta pela retomada: o shell vazio é fechado antes e a sessão sumida que
    /// estava na última foto volta; pane com outro processo, com chave ou fora da foto não é tocado; sem a
    /// conversa no disco, pula. Uma vez por conversa.
    #[tokio::test]
    async fn the_old_version_sessions_come_back_once_through_the_archive_resume() {
        let tmux = Tmux::new();
        let root = tempfile::tempdir().unwrap();
        let account = root.path().join("acct");
        let server_projects = root.path().join("default/projects");
        let resurrect = root.path().join("resurrect");
        std::fs::create_dir_all(&resurrect).unwrap();
        transcript(&account.join("projects"), A);
        for sid in [B, C, D, G] { transcript(&server_projects, sid); }
        let cfg = account.to_string_lossy().into_owned();
        std::fs::write(resurrect.join("claude-sessions.tsv"), format!(
            "vazia\tclaude\t{A}\t{cfg}\t\nocupada\tclaude\t{B}\t\t\ncom-chave\tclaude\t{C}\t\t\nsumida\tclaude\t{D}\t\t\n\
             fora\tclaude\t{E}\t\t\nsem-conversa\tclaude\t{F}\t\t\nkimi-x\tkimi\tsession_{A}\t\t\ntarde\tclaude\t{G}\t\t\n")).unwrap();
        std::fs::write(resurrect.join("tmux_resurrect_20261017T000000.txt"),
            "pane\tsumida\t0\t1\t:*\t0\t:/w\t1\tfish\t:\npane\tsem-conversa\t0\t1\t:*\t0\t:/w\t1\tfish\t:\nwindow\tfora-w\t0\n").unwrap();
        std::os::unix::fs::symlink("tmux_resurrect_20261017T000000.txt", resurrect.join("last")).unwrap();

        assert!(tmux.run(&["new-session", "-d", "-s", "tarde", "sh"]));
        let tarde = tmux.pane_pid("tarde");
        assert!(tmux.run(&["new-session", "-d", "-s", "vazia", "sleep 300 & exec sh"]));
        assert!(tmux.run(&["new-session", "-d", "-s", "ocupada", "sleep 300"]));
        assert!(tmux.run(&["new-session", "-d", "-s", "com-chave", "sh"]));
        assert!(tmux.run(&["set-environment", "-t", "=com-chave", "CP_SESSION_KEY", &"ab".repeat(16)]));
        let vazia = tmux.pane_pid("vazia");
        wait("o processo de inicialização da vazia", || children(vazia) == 1);
        // O comando digitado depois da inicialização é do usuário.
        let born = std::fs::metadata(format!("/proc/{tarde}")).unwrap().modified().unwrap();
        wait("passar a janela de inicialização", || born.elapsed().unwrap_or_default() > Duration::from_secs(2));
        assert!(tmux.run(&["send-keys", "-t", "=tarde:","sleep 300", "Enter"]));
        wait("o comando da tarde", || children(tarde) == 1);

        let paths = Paths { resurrect: resurrect.clone(), done: root.path().join(".hangar").join(DONE), server_projects: server_projects.clone() };
        let calls: Arc<Mutex<Vec<(Legacy, String, bool)>>> = Arc::default();
        let program = tmux.program.clone();
        let seen = calls.clone();
        let resume = move |legacy: Legacy, project: String| -> BoxFuture<'static, Result<(), String>> {
            let alive = Command::new(&program).args(["has-session", "-t", &format!("={}", legacy.name)]).status().unwrap().success();
            seen.lock().unwrap().push((legacy, project, alive));
            Box::pin(async { Ok(()) })
        };
        let codes = |lines: Vec<Value>| -> BTreeMap<String, String> {
            lines.iter().map(|l| (l["sessao"].as_str().unwrap().to_owned(), l["codigo"].as_str().unwrap().to_owned())).collect()
        };

        let first = codes(run(tmux.program.as_os_str(), &paths, Duration::from_secs(1), &resume).await);
        let expected: BTreeMap<String, String> = [("vazia", "legacy_restore_resumed"), ("ocupada", "legacy_restore_pane_busy"),
            ("com-chave", "legacy_restore_has_key"), ("sumida", "legacy_restore_resumed"), ("fora", "legacy_restore_not_in_last_save"),
            ("sem-conversa", "legacy_restore_transcript_missing"), ("kimi-x", "legacy_restore_provider_unsupported"),
            ("tarde", "legacy_restore_pane_busy")].into_iter().map(|(a, b)| (a.to_owned(), b.to_owned())).collect();
        assert_eq!(first, expected);
        assert_eq!(*calls.lock().unwrap(), vec![
            (Legacy { name: "vazia".into(), conversation: A.into(), config_dir: Some(cfg.clone()) }, "-w".to_owned(), false),
            (Legacy { name: "sumida".into(), conversation: D.into(), config_dir: None }, "-w".to_owned(), false),
        ], "a vazia é fechada antes da retomada");
        assert!(tmux.alive("ocupada") && tmux.alive("com-chave") && tmux.alive("tarde"), "o resto não é tocado");

        let second = codes(run(tmux.program.as_os_str(), &paths, Duration::from_secs(1), &resume).await);
        assert_eq!(second["vazia"], "legacy_restore_already_resumed");
        assert_eq!(second["sumida"], "legacy_restore_already_resumed");
        assert_eq!(calls.lock().unwrap().len(), 2, "a mesma conversa não volta duas vezes");

        std::fs::write(&paths.done, "{torto").unwrap();
        let broken = codes(run(tmux.program.as_os_str(), &paths, Duration::from_secs(1), &resume).await);
        assert_eq!(broken, BTreeMap::from([("-".to_owned(), "legacy_restore_done_unreadable".to_owned())]), "sem a lista, nada volta");
        assert_eq!(calls.lock().unwrap().len(), 2);
    }
}
