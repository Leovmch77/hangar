//! Restaurar as sessões com terminal depois do reboot: o Rust guarda, enquanto roda, quais sessões do
//! Hangar estão abertas e em que conversa (`~/.hangar/session-restore.json`), e na subida, quando o servidor
//! do multiplexador não é mais o da fotografia (reboot, queda ou `kill-server` do tmux), reabre cada uma pelo
//! spec gravado, retomando a conversa (S-68, S-69, S-70). O comando vai no `new-session`, nunca digitado num
//! shell. Não depende do tmux-resurrect, e vale no Windows (psmux).
//!
//! Uma sessão sai da fotografia só depois de ausente por `ABSENT` com o servidor de pé: o desligamento
//! derruba as sessões e o servidor em segundos, e fechar uma sessão de propósito a tira da próxima subida.
use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::json;

use super::{AgentProvider, OpenCaller, Surface};

pub const FILE: &str = "session-restore.json";
/// Ausente por mais que isto com o servidor de pé: fechada de propósito.
pub const ABSENT: f64 = 120.0;
const EVERY: Duration = Duration::from_secs(30);

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Snapshot {
    /// Quando o servidor do multiplexador subiu (segundos desde a época), na última vez que o Rust olhou.
    #[serde(default)]
    pub mux_started: Option<u64>,
    /// Pela chave do spec.
    pub sessions: BTreeMap<String, Entry>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Entry {
    pub name: String,
    pub provider: AgentProvider,
    pub conversation: Option<String>,
    /// O modo de permissão que o Rust viu por último (o Claude troca de modo por teclas, sem regravar o spec).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permission_mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub missing_since: Option<f64>,
}

/// O spec com que a sessão volta: o gravado, com o modo da hora em que caiu (S-68, P-02). No Codex o modo
/// é o que a TUI gravou no sidecar (`record::live`); no Claude, o que a fotografia viu.
pub fn spec_for_restore(home: &Path, key: &str, entry: &Entry) -> Result<super::SessionSpec, &'static str> {
    let read = if entry.provider == AgentProvider::Codex { super::record::live(home, &entry.name) } else { super::record::read(home, key) };
    let mut spec = read.map_err(|_| "restore_spec_unreadable")?.filter(|s| s.key == key).ok_or("restore_no_spec")?;
    if spec.provider == AgentProvider::Claude && let Some(mode) = entry.permission_mode.as_deref().and_then(super::PermissionMode::claude) {
        spec.permission_mode = Some(mode);
    }
    Ok(spec)
}

/// A conversa que o transcript da lista prova: o id no nome do arquivo (Claude), depois do `_` (Pi, omp),
/// ou a pasta da sessão (Kimi, `…/<session_id>/agents/main/wire.jsonl`).
pub fn conversation_of(provider: AgentProvider, jsonl: &str) -> Option<String> {
    let path = Path::new(jsonl);
    let stem = path.file_stem()?.to_str()?;
    let id = match provider {
        AgentProvider::Claude => stem.to_owned(),
        AgentProvider::Pi | AgentProvider::Omp => stem.rsplit_once('_')?.1.to_owned(),
        AgentProvider::Kimi => path.parent()?.parent()?.parent()?.file_name()?.to_str()?.to_owned(),
        AgentProvider::Codex => return None,
    };
    (!id.is_empty()).then_some(id)
}

/// A fotografia seguinte: as vivas com a conversa de agora (a de antes, se a lista não provou); as ausentes
/// ficam até `ABSENT`.
pub fn observe(prev: &Snapshot, alive: &BTreeMap<String, Entry>, now: f64, mux_started: Option<u64>) -> Snapshot {
    let mut sessions = BTreeMap::new();
    for (key, entry) in alive {
        let conversation = entry.conversation.clone().or_else(|| prev.sessions.get(key).and_then(|e| e.conversation.clone()));
        sessions.insert(key.clone(), Entry { conversation, missing_since: None, ..entry.clone() });
    }
    for (key, entry) in &prev.sessions {
        if alive.contains_key(key) { continue; }
        let since = entry.missing_since.unwrap_or(now);
        if now - since < ABSENT { sessions.insert(key.clone(), Entry { missing_since: Some(since), ..entry.clone() }); }
    }
    Snapshot { mux_started, sessions }
}

/// O servidor do multiplexador agora: nenhum (as sessões morreram com ele), o horário em que subiu, ou
/// desconhecido (não respondeu).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MuxStart { NoServer, Started(u64), Unknown }

/// O que reabrir na subida: só com outro servidor que o da fotografia, e só o que não tem sessão com o nome.
/// `None`: o multiplexador não respondeu e não dá para decidir agora.
pub fn to_restore(snap: &Snapshot, current: MuxStart, live: &HashSet<String>) -> Option<Vec<(String, Entry)>> {
    match current {
        MuxStart::Unknown => return None,
        MuxStart::Started(at) if snap.mux_started == Some(at) => return Some(Vec::new()),
        _ => {}
    }
    Some(snap.sessions.iter().filter(|(_, e)| !live.contains(&e.name)).map(|(k, e)| (k.clone(), e.clone())).collect())
}

/// Uma variável de formato do servidor (`display-message -p`); `Err` = sem servidor (`Ok(None)`) ou sem resposta.
async fn mux_format(program: &std::ffi::OsStr, format: &str) -> Result<Option<String>, ()> {
    let mut command = crate::terminal_input::child_command(program);
    command.args(["display-message", "-p", format]).stdin(std::process::Stdio::null()).kill_on_drop(true);
    let out = tokio::time::timeout(Duration::from_secs(5), command.output()).await.map_err(|_| ())?.map_err(|_| ())?;
    if out.status.success() { return Ok(Some(String::from_utf8_lossy(&out.stdout).trim().to_owned())); }
    if crate::list::mux::is_absence(&String::from_utf8_lossy(&out.stderr)) { Ok(None) } else { Err(()) }
}

/// Quando o servidor do multiplexador subiu: o `#{start_time}` do tmux; sem ele (o psmux pode não ter), o
/// nascimento do processo do servidor (`#{pid}`); sem os dois, a subida da máquina.
pub async fn mux_start(program: &std::ffi::OsStr) -> MuxStart {
    let start = match mux_format(program, "#{start_time}").await {
        Err(()) => return MuxStart::Unknown,
        Ok(None) => return MuxStart::NoServer,
        Ok(Some(text)) => text.parse::<u64>().ok(),
    };
    if let Some(at) = start.filter(|at| *at > 0) { return MuxStart::Started(at); }
    let pid = mux_format(program, "#{pid}").await.ok().flatten().and_then(|p| p.parse::<u32>().ok());
    let born = pid.and_then(|pid| {
        let mut system = sysinfo::System::new();
        let pid = sysinfo::Pid::from_u32(pid);
        system.refresh_processes(sysinfo::ProcessesToUpdate::Some(&[pid]), true);
        system.process(pid).map(sysinfo::Process::start_time)
    });
    MuxStart::Started(born.unwrap_or_else(sysinfo::System::boot_time))
}

fn path(home: &Path) -> PathBuf { home.join(".hangar").join(FILE) }

/// Ausente = vazia; ilegível também, com aviso: a próxima fotografia a refaz.
pub fn read(home: &Path) -> Snapshot {
    match std::fs::read(path(home)) {
        Ok(raw) => serde_json::from_slice(&raw).unwrap_or_else(|error| {
            tracing::warn!(code = "session_restore_unreadable", %error, "fotografia das sessões ilegível; o restore desta subida não tem o que reabrir");
            Snapshot::default()
        }),
        Err(error) => {
            if error.kind() != std::io::ErrorKind::NotFound {
                tracing::warn!(code = "session_restore_unreadable", kind = ?error.kind(), "fotografia das sessões ilegível");
            }
            Snapshot::default()
        }
    }
}

fn write(home: &Path, snap: &Snapshot) -> std::io::Result<()> {
    std::fs::create_dir_all(home.join(".hangar"))?;
    crate::runtime::queue::atomic_write(&path(home), &serde_json::to_vec_pretty(snap)?)
}

/// Os nomes fechados de propósito desde a última fotografia: o laço os tira da que ele tem na memória antes
/// de gravar, sob esta mesma trava, para não regravar a entrada que `forget` acabou de tirar.
static CLOSED: std::sync::Mutex<Vec<String>> = std::sync::Mutex::new(Vec::new());

/// A sessão fechada de propósito (o `DELETE`) sai da fotografia na hora: não volta no próximo reboot.
pub fn forget(home: &Path, name: &str) {
    let mut closed = CLOSED.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    closed.push(name.to_owned());
    let mut snap = read(home);
    let before = snap.sessions.len();
    snap.sessions.retain(|_, entry| entry.name != name);
    if snap.sessions.len() != before && let Err(error) = write(home, &snap) {
        tracing::warn!(code = "session_restore_unwritten", kind = ?error.kind(), "a sessão fechada ficou na fotografia até o próximo tique");
    }
}

/// Tira da fotografia os nomes fechados desde a última; chamar com `CLOSED` travada.
fn drop_closed(snap: &mut Snapshot, closed: &mut Vec<String>) {
    snap.sessions.retain(|_, entry| !closed.contains(&entry.name));
    closed.clear();
}

/// Os nomes que o restore ainda pode reabrir: a varredura de grupos os conta como vivos, senão tiraria os
/// membros do grupo antes de a sessão voltar.
static HELD: std::sync::Mutex<Vec<String>> = std::sync::Mutex::new(Vec::new());

/// Segura os nomes da fotografia enquanto o servidor dela não é o de agora; solta quando é.
fn hold(snap: &Snapshot, settled: bool) {
    let mut held = HELD.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    *held = if settled { Vec::new() } else { snap.sessions.values().map(|e| e.name.clone()).collect() };
}

/// Os nomes à espera do restore.
pub fn held() -> Vec<String> { HELD.lock().unwrap_or_else(std::sync::PoisonError::into_inner).clone() }

fn now() -> f64 { std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0.0, |d| d.as_secs_f64()) }

/// A chave do spec gravada no ambiente da sessão (`CP_SESSION_KEY`).
async fn session_key(program: &std::ffi::OsStr, name: &str) -> Option<String> {
    let target = if cfg!(windows) { name.to_owned() } else { format!("={name}") };
    let mut command = crate::terminal_input::child_command(program);
    command.args(["show-environment", "-t", &target, "CP_SESSION_KEY"]).stdin(std::process::Stdio::null()).kill_on_drop(true);
    let out = tokio::time::timeout(Duration::from_secs(5), command.output()).await.ok()?.ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    let key = text.lines().find_map(|l| l.trim().strip_prefix("CP_SESSION_KEY="))?;
    (key.len() == 32 && key.bytes().all(|b| b.is_ascii_hexdigit())).then(|| key.to_owned())
}

/// As sessões do Hangar com terminal abertas agora: a chave, o nome, o agente e a conversa que a lista prova.
async fn alive(st: &crate::routes::AppState, home: &Path, program: &std::ffi::OsStr) -> Option<BTreeMap<String, Entry>> {
    let rows = st.list.discover(None).await.ok()?;
    let mut out = BTreeMap::new();
    for row in rows.iter().filter(|r| !r.headless) {
        let Some(provider) = AgentProvider::parse(&row.provider) else { continue };
        let Some(key) = session_key(program, &row.name).await else { continue };
        let Ok(Some(spec)) = super::record::read(home, &key) else { continue };
        if spec.surface != Surface::Terminal { continue; }
        let conversation = row.jsonl.as_deref().filter(|_| row.tracked).and_then(|j| conversation_of(provider, j));
        let permission_mode = match (provider, &conversation, st.state.runtime.get()) {
            (AgentProvider::Claude, Some(sid), Some(runtime)) => runtime.observed_claude_mode(sid),
            _ => None,
        };
        out.insert(key, Entry { name: row.name.clone(), provider, conversation, permission_mode, missing_since: None });
    }
    Some(out)
}

/// A conversa em que a sessão volta: a do Codex mora no sidecar dele (o lançador a atualiza).
fn restore_conversation(home: &Path, entry: &Entry) -> Option<String> {
    if entry.provider != AgentProvider::Codex { return entry.conversation.clone(); }
    let meta = crate::runtime::codex_sidecar::read(&crate::runtime::codex_sidecar::path(&crate::runtime::codex_sidecar::dir(home), &entry.name)).ok()??;
    meta.get("thread_id").and_then(|t| t.as_str()).filter(|t| !t.is_empty()).map(str::to_owned).or_else(|| entry.conversation.clone())
}

/// A abertura que traz a sessão de volta: o spec dela, na conversa em que estava, como a mesma sessão
/// (grupo, fila e par do nome ficam).
pub fn resolved_for(home: &Path, server_projects: &Path, key: &str, entry: &Entry) -> Result<super::Resolved, String> {
    let mut spec = spec_for_restore(home, key, entry)?;
    if spec.surface != Surface::Terminal { return Err("restore_no_spec".into()); }
    spec.name = entry.name.clone();
    let conversation = restore_conversation(home, entry).ok_or("restore_no_conversation")?;
    if spec.provider == AgentProvider::Claude && !super::claude::transcript(&spec, &conversation, server_projects).is_file() {
        return Err("restore_transcript_missing".into());
    }
    Ok(super::Resolved { spec, warnings: Vec::new(), initial_prompt: None, remember_provider: false, previous_non_plan: None,
        resume: Some(conversation), restore: true })
}

/// Reabre uma sessão pelo spec gravado, na conversa dela; devolve o código da falha.
async fn reopen(st: &Arc<crate::routes::AppState>, key: &str, entry: &Entry) -> Result<(), String> {
    let host = super::server::ServerHost::new(st.clone()).await;
    let mut resolved = resolved_for(super::open::OpenHost::home(&host), &super::open::OpenHost::server_projects(&host), key, entry)?;
    let env = crate::accounts::environment::AccountEnvironment::from_map(super::open::OpenHost::env(&host).clone());
    let runtime = tokio::runtime::Handle::current();
    let mut spec = resolved.spec;
    resolved.spec = tokio::task::spawn_blocking(move || {
        spec.refresh_engine_window(&super::facts::LocalFacts::new(env, runtime));
        spec
    }).await.map_err(|_| "restore_spec_job".to_owned())?;
    super::open::open_session(&host, resolved, &OpenCaller::Owner).await.map(|_| ()).map_err(|e| e.code.unwrap_or("restore_open_failed").to_owned())
}

/// Tentativas de uma sessão que falhou por um motivo passageiro (conta ocupada, multiplexador calado).
const TRIES: u32 = 3;

/// O que acontece depois de uma passada: a sessão que falhou por um motivo passageiro tenta de novo até
/// `TRIES`; a que nasceu, a que falhou de vez e a que esgotou as tentativas saem (`done`). `true` = nada
/// mais a tentar, e o servidor novo pode virar o da fotografia.
fn settle(results: &[(String, Result<(), String>)], attempts: &mut std::collections::HashMap<String, u32>, done: &mut HashSet<String>) -> bool {
    let passing = |code: &str| matches!(code, "account_busy" | "erro_mux_indisponivel" | "erro_lista_indisponivel" | "restore_spec_job"
        | "erro_grupo_limpeza_falhou");
    let mut left = false;
    for (key, result) in results {
        match result {
            Err(code) if passing(code) => {
                let tried = attempts.entry(key.clone()).or_insert(0);
                *tried += 1;
                if *tried < TRIES { left = true; } else { done.insert(key.clone()); }
            }
            _ => { done.insert(key.clone()); }
        }
    }
    !left
}

/// Reabre uma sessão e grava o resultado no diário.
async fn restore_one(st: &Arc<crate::routes::AppState>, key: &str, entry: &Entry) -> Result<(), String> {
    let result = reopen(st, key, entry).await;
    let mut event = json!({"evento": "sessao.restaurada", "nivel": "ok", "sessao": entry.name, "provider": entry.provider.name()});
    if let Err(code) = &result {
        tracing::warn!(session = %entry.name, code = %code, "sessão com terminal não restaurada");
        event["evento"] = json!("sessao.restauro_falhou");
        event["nivel"] = json!("erro");
        event["codigo"] = json!(code);
    }
    if let Some(dir) = crate::diag::diary_dir() && let Err(error) = crate::diag::write_diary(&dir, &[event], chrono::Local::now()) {
        tracing::warn!(kind = ?error.kind(), "diário do restore não gravado");
    }
    result
}

/// A cada `EVERY`: com outro servidor do multiplexador que o da fotografia (a subida depois do reboot, ou o
/// tmux que caiu com o Rust de pé), reabre o que ele perdeu; com o mesmo, fotografa.
pub async fn run(st: Arc<crate::routes::AppState>, home: PathBuf, program: std::ffi::OsString) {
    let mut snap = read(&home);
    let (mut attempts, mut done) = (std::collections::HashMap::new(), HashSet::new());
    loop {
        let current = mux_start(&program).await;
        let live = st.list.discover(None).await.ok().map(|rows| rows.iter().map(|r| r.name.clone()).collect::<HashSet<String>>());
        let same = matches!(current, MuxStart::Started(at) if snap.mux_started == Some(at));
        hold(&snap, same);
        match (same, live.and_then(|live| to_restore(&snap, current, &live))) {
            (true, _) => {
                if let Some(alive) = alive(&st, &home, &program).await {
                    let mut next = observe(&snap, &alive, now(), snap.mux_started);
                    let mut closed = CLOSED.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
                    drop_closed(&mut next, &mut closed);
                    if next != snap {
                        if let Err(error) = write(&home, &next) {
                            tracing::warn!(code = "session_restore_unwritten", kind = ?error.kind(), "fotografia das sessões não gravada");
                        }
                        snap = next;
                    }
                }
            }
            // Sem a lista ou sem o multiplexador não se sabe o que existe: nada é reaberto por cima.
            (false, None) => tracing::warn!(code = "session_restore_undecided", "sem a lista ou o multiplexador; o restore espera"),
            (false, Some(pending)) => {
                let pending: Vec<(String, Entry)> = pending.into_iter().filter(|(key, _)| !done.contains(key)).collect();
                if !pending.is_empty() { tracing::info!(count = pending.len(), "restaurando as sessões com terminal que o multiplexador perdeu"); }
                let mut results = Vec::new();
                for (key, entry) in &pending { results.push((key.clone(), restore_one(&st, key, entry).await)); }
                // Só com nada mais a tentar o servidor de agora (o restore pode tê-lo subido) passa a ser o da
                // fotografia; antes disso as entradas ficam, e um reinício só do Rust não reabre nada.
                if settle(&results, &mut attempts, &mut done) && let MuxStart::Started(at) = mux_start(&program).await {
                    snap.mux_started = Some(at);
                    attempts.clear();
                    done.clear();
                }
            }
        }
        tokio::time::sleep(EVERY).await;
    }
}

/// A tarefa do restore, com o runtime e as pastas da lista de pé.
pub fn spawn(st: Arc<crate::routes::AppState>) -> Option<tokio::task::JoinHandle<()>> {
    let dirs = st.list.env().dirs.clone()?;
    st.state.runtime.get()?;
    let program = st.list.env().capture_program.clone();
    // Antes da primeira rodada da varredura de grupos: até o restore decidir, a fotografia segura os nomes.
    hold(&read(&dirs.home), false);
    Some(tokio::spawn(run(st, dirs.home, program)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(name: &str, conversation: Option<&str>) -> Entry {
        Entry { name: name.into(), provider: AgentProvider::Claude, conversation: conversation.map(str::to_owned), permission_mode: None, missing_since: None }
    }

    fn recorded(home: &Path, key: &str, provider: AgentProvider, mode: super::super::PermissionMode) {
        let spec = super::super::SessionSpec { version: super::super::SPEC_VERSION, key: key.into(), name: "s1".into(), cwd: "/w".into(), provider,
            surface: Surface::Terminal, account: if provider == AgentProvider::Codex { super::super::Account::Codex { account_id: "default".into() } }
            else { super::super::Account::Default }, account_source: super::super::AccountSource::Default, model: None, effort: None,
            service_tier: None, permission_mode: Some(mode), subagent_model: None, customizations: None, jev: false, read_only: false,
            worktree: None, creator: None, created_at: 1.0, conversation: Some("c1".into()) };
        super::super::record::write(home, &spec).unwrap();
    }

    #[test]
    fn the_restore_comes_back_in_the_mode_the_session_had_when_it_fell() {
        use super::super::PermissionMode;
        let dir = tempfile::tempdir().unwrap();
        let key = "ab".repeat(16);
        recorded(dir.path(), &key, AgentProvider::Claude, PermissionMode::BypassPermissions);
        let lowered = Entry { permission_mode: Some("acceptEdits".into()), ..entry("s1", Some("c1")) };
        assert_eq!(spec_for_restore(dir.path(), &key, &lowered).unwrap().permission_mode, Some(PermissionMode::AcceptEdits), "Claude baixado por teclas");
        assert_eq!(spec_for_restore(dir.path(), &key, &entry("s1", Some("c1"))).unwrap().permission_mode, Some(PermissionMode::BypassPermissions),
            "sem modo visto, o do spec");
        let codex = "cd".repeat(16);
        recorded(dir.path(), &codex, AgentProvider::Codex, PermissionMode::FullAccess);
        let sidecars = crate::runtime::codex_sidecar::dir(dir.path());
        std::fs::create_dir_all(&sidecars).unwrap();
        std::fs::write(crate::runtime::codex_sidecar::path(&sidecars, "s1"), json!({"name": "s1", "provider": "codex", "key": codex, "cwd": "/w",
            "thread_id": "t1", "permission_mode": "Ask for approval"}).to_string()).unwrap();
        let entry = Entry { provider: AgentProvider::Codex, ..entry("s1", None) };
        assert_eq!(spec_for_restore(dir.path(), &codex, &entry).unwrap().permission_mode, Some(PermissionMode::AskForApproval), "o modo que a TUI gravou");
    }

    #[test]
    fn a_session_leaves_the_snapshot_only_after_being_absent_with_the_server_up() {
        let alive: BTreeMap<String, Entry> = [("k1".into(), entry("a", Some("c1"))), ("k2".into(), entry("b", None))].into();
        let first = observe(&Snapshot::default(), &alive, 1000.0, Some(7));
        assert_eq!(first.sessions.len(), 2);
        let only_a: BTreeMap<String, Entry> = [("k1".into(), entry("a", None))].into();
        let second = observe(&first, &only_a, 1010.0, Some(7));
        assert_eq!(second.sessions["k1"].conversation.as_deref(), Some("c1"), "a conversa provada antes fica quando a lista não a prova");
        assert_eq!(second.sessions["k2"].missing_since, Some(1010.0), "ausente fica, marcada");
        assert!(observe(&second, &only_a, 1010.0 + ABSENT - 1.0, Some(7)).sessions.contains_key("k2"), "o desligamento derruba tudo em segundos");
        assert!(!observe(&second, &only_a, 1010.0 + ABSENT, Some(7)).sessions.contains_key("k2"), "fechada de propósito sai");
        let back = observe(&second, &alive, 1020.0, Some(7));
        assert_eq!(back.sessions["k2"].missing_since, None, "voltou");
    }

    #[test]
    fn only_another_multiplexer_server_restores_and_never_over_a_live_name() {
        let snap = Snapshot { mux_started: Some(1000), sessions: [("k1".into(), entry("a", Some("c1"))), ("k2".into(), entry("b", Some("c2")))].into() };
        let keys = |p: Option<Vec<(String, Entry)>>| p.map(|v| v.into_iter().map(|(k, _)| k).collect::<Vec<_>>());
        assert_eq!(keys(to_restore(&snap, MuxStart::Started(1000), &HashSet::new())), Some(vec![]), "o mesmo servidor: só o Rust reiniciou");
        let live: HashSet<String> = ["a".to_owned()].into();
        assert_eq!(keys(to_restore(&snap, MuxStart::Started(5000), &live)), Some(vec!["k2".to_owned()]), "outro servidor (reboot, kill-server)");
        assert_eq!(keys(to_restore(&snap, MuxStart::NoServer, &HashSet::new())), Some(vec!["k1".to_owned(), "k2".to_owned()]), "nenhum servidor");
        assert_eq!(keys(to_restore(&snap, MuxStart::Unknown, &HashSet::new())), None, "multiplexador calado: decide depois");
    }

    #[test]
    fn a_passing_failure_is_tried_again_and_the_new_server_waits_for_it() {
        let (mut attempts, mut done) = (std::collections::HashMap::new(), HashSet::new());
        let results = |code: &str| vec![("ok".to_owned(), Ok(())), ("bad".to_owned(), Err("restore_no_spec".to_owned())), ("busy".to_owned(), Err(code.to_owned()))];
        assert!(!settle(&results("account_busy"), &mut attempts, &mut done), "a conta ocupada tenta de novo");
        assert!(done.contains("ok") && done.contains("bad") && !done.contains("busy"), "{done:?}");
        assert!(!settle(&[("busy".to_owned(), Err("erro_mux_indisponivel".to_owned()))], &mut attempts, &mut done));
        assert!(settle(&[("busy".to_owned(), Err("account_busy".to_owned()))], &mut attempts, &mut done), "esgotou: o servidor novo é adotado");
        assert!(done.contains("busy"));
    }

    #[test]
    fn a_session_closed_on_purpose_leaves_the_snapshot_at_once() {
        let dir = tempfile::tempdir().unwrap();
        let snap = Snapshot { mux_started: Some(1), sessions: [("k1".into(), entry("a", Some("c1"))), ("k2".into(), entry("b", Some("c2")))].into() };
        write(dir.path(), &snap).unwrap();
        forget(dir.path(), "a");
        assert_eq!(read(dir.path()).sessions.keys().collect::<Vec<_>>(), ["k2"], "o arquivo, já");
        let mut memory = snap.clone();
        let mut closed = CLOSED.lock().unwrap();
        drop_closed(&mut memory, &mut closed);
        assert!(!memory.sessions.contains_key("k1") && memory.sessions.contains_key("k2"), "a do laço também, antes de gravar");
        assert!(closed.is_empty());
    }

    #[test]
    fn the_names_waiting_for_the_restore_count_as_alive_until_it_settles() {
        let snap = Snapshot { mux_started: Some(1), sessions: [("k1".into(), entry("a", Some("c1"))), ("k2".into(), entry("b", None))].into() };
        hold(&snap, false);
        assert_eq!(held(), ["a", "b"]);
        hold(&snap, true);
        assert!(held().is_empty());
    }

    #[test]
    fn the_conversation_comes_from_each_agent_transcript() {
        let id = "33333333-3333-4333-8333-333333333333";
        assert_eq!(conversation_of(AgentProvider::Claude, &format!("/h/.claude/projects/-w/{id}.jsonl")).as_deref(), Some(id));
        assert_eq!(conversation_of(AgentProvider::Pi, &format!("/h/.pi/agent/sessions/--w--/2026-10-01T00-00-00-000Z_{id}.jsonl")).as_deref(), Some(id));
        assert_eq!(conversation_of(AgentProvider::Omp, &format!("/h/.omp/agent/sessions/-/2026-10-01T00-00-00-000Z_{id}.jsonl")).as_deref(), Some(id));
        assert_eq!(conversation_of(AgentProvider::Kimi, &format!("/h/.kimi-code/sessions/w/session_{id}/agents/main/wire.jsonl")).as_deref(),
            Some(format!("session_{id}").as_str()));
        assert_eq!(conversation_of(AgentProvider::Codex, "/h/.codex/sessions/rollout-x.jsonl"), None, "o Codex volta pelo sidecar");
    }
}
