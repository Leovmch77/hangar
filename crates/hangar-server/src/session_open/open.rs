//! Abrir uma sessão Claude com terminal pelo spec: o que o `create_session` e o ramo Claude do
//! `registry.create` do Python faziam em volta do pane, na mesma ordem, com os consertos da Task 4.
//! Os efeitos de fora (processos, pontes, diário) passam pelo `OpenHost`: o servidor, o comando de
//! terminal com o servidor fora e o harness do contrato implementam cada um o seu.
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use futures_util::future::BoxFuture;
use serde_json::{Value, json};

use super::agents::{self, Conversation};
use super::claude::{self, PluginBridge};
use super::terminal::{self, Mux, PaneSpec, TerminalEnv};
use super::{Account, AgentProvider, OpenCaller, OpenError, PermissionMode, Resolved, SessionSpec, Surface};

/// Saída de um programa que a abertura roda (`hangar-conta`, a sonda do `bwrap`).
#[derive(Clone, Debug, Default)]
pub struct ProgramOutput { pub code: Option<i32>, pub stdout: String, pub stderr: String }

/// O que a sessão que acabou de nascer avisa a quem guarda estado do nome.
#[derive(Clone, Debug)]
pub struct Born { pub name: String, pub provider: AgentProvider, pub jsonl: Option<String>, pub remember_provider: bool }

pub trait OpenHost: Send + Sync {
    /// A pasta pessoal do dono (registros, `~/.claude.json`, `~/.hangar`).
    fn home(&self) -> &Path;
    /// O ambiente do servidor (PATH, `CP_*`, `CLAUDE_CONFIG_DIR`).
    fn env(&self) -> &BTreeMap<String, String>;
    fn terminal(&self) -> &TerminalEnv;
    fn mux(&self) -> &dyn Mux;
    fn bridge(&self) -> Option<PluginBridge>;
    /// `projects` da conta do servidor.
    fn server_projects(&self) -> PathBuf;
    fn run(&self, argv: Vec<String>, timeout: Duration) -> BoxFuture<'_, ProgramOutput>;
    /// A operação `prepare` das escolhas de plugins e skills; devolve o `{"settings": …}`.
    fn customizations(&self, args: Value) -> BoxFuture<'_, Result<Value, OpenError>>;
    /// O grupo da sessão antiga de mesmo nome sai antes de qualquer efeito.
    fn leave_old_group<'a>(&'a self, name: &'a str) -> BoxFuture<'a, Result<(), OpenError>>;
    /// O nome reusado não herda nada da morta (fila, `then`, caches); antes do pane, porque depois
    /// dele o runtime já adota a sessão.
    fn release_name<'a>(&'a self, name: &'a str) -> BoxFuture<'a, Result<(), OpenError>>;
    /// Depois do pane: grupo e par externo do nome antigo, transcript semeado, lista. Devolve avisos.
    fn born<'a>(&'a self, born: &'a Born) -> BoxFuture<'a, Vec<String>>;
    fn diary(&self, events: Vec<Value>);
    /// Id da conversa (`--session-id`) e chave da ponte do plugin, novos a cada vida.
    fn new_session_id(&self) -> String;
    fn new_bridge_key(&self) -> String;
    /// A sessão sem terminal recém-criada sobe em segundo plano (os hooks de SessionStart rodam enquanto
    /// a pessoa digita), com a primeira mensagem, se veio (S-40). Não espera.
    fn wake(&self, name: &str, initial_prompt: Option<String>);
}

/// UUID v4 de 16 bytes aleatórios em hexadecimal.
pub fn uuid4(hex: &str) -> String {
    let mut h: Vec<char> = hex.chars().take(32).collect();
    h[12] = '4';
    h[16] = ['8', '9', 'a', 'b'][h[16].to_digit(16).unwrap_or(0) as usize % 4];
    let s: String = h.into_iter().collect();
    format!("{}-{}-{}-{}-{}", &s[..8], &s[8..12], &s[12..16], &s[16..20], &s[20..32])
}

/// Os eventos do diário de uma criação, na ordem do `registry.create` (`@diag.rastrear`).
struct Diary { events: Vec<Value>, op: String, started: Instant, name: String, provider: &'static str }

impl Diary {
    fn new(op: String, name: &str, provider: &'static str) -> Self {
        Self { events: vec![json!({"evento": "sessao.criar.inicio", "nivel": "ok", "operacao": op})], op, started: Instant::now(), name: name.into(), provider }
    }
    fn session(&self) -> Value { if self.name.is_empty() { Value::Null } else { Value::from(self.name.clone()) } }
    fn step(&mut self, etapa: &str) {
        let mut e = json!({"evento": "sessao.criar_etapa", "nivel": "ok", "sessao": self.session(), "provider": self.provider, "etapa": etapa, "operacao": self.op});
        if e["sessao"].is_null() { e.as_object_mut().unwrap().remove("sessao"); }
        self.events.push(e);
    }
    fn refused(&mut self, level: &str, code: &str, etapa: Option<&str>, detail: Option<&str>) {
        let mut e = json!({"evento": "sessao.criar_recusada", "nivel": level, "sessao": self.session(), "provider": self.provider, "operacao": self.op});
        match (etapa, detail) {
            // S-15: falha de lançamento leva a etapa, o código e o stderr resumido.
            (Some(etapa), detail) => { e["etapa"] = etapa.into(); e["codigo"] = code.into(); e["detalhe"] = detail.unwrap_or("").into(); }
            (None, _) => e["detalhe"] = code.into(),
        }
        self.events.push(e);
    }
    fn end(mut self, error: Option<&OpenError>) -> Vec<Value> {
        let ms = self.started.elapsed().as_millis() as u64;
        self.events.push(match error {
            None => json!({"evento": "sessao.criar.fim", "nivel": "ok", "codigo": "retornou", "ms": ms, "operacao": self.op}),
            Some(e) => json!({"evento": "sessao.criar.fim", "nivel": "erro", "codigo": "excecao", "ms": ms,
                "erro_tipo": e.code.unwrap_or("recusa"), "operacao": self.op}),
        });
        self.events
    }
}

/// Recusas que o Python dava dentro do `registry.create` (depois do `sessao.criar.inicio`): o
/// diário as registra igual. As de antes (validação da API) não deixam evento de criação.
pub fn refusal_diary(op: String, name: &str, provider: &'static str, error: &OpenError) -> Option<Vec<Value>> {
    let in_use = error.code == Some("erro_nome_em_uso");
    let invalid = error.code == Some("erro_criacao_sessao") && error.msg.starts_with("nome invalido");
    let agent = error.code == Some("erro_criacao_sessao")
        && ["sessao sem terminal so vale para provider claude ou codex", "Nome de perfil OMP inválido", "sessao sem terminal nao aceita read_only"]
            .contains(&error.msg.as_str());
    if !(in_use || invalid || agent) { return None; }
    let mut diary = Diary::new(op, if invalid { "" } else { name }, provider);
    diary.step("validar");
    if in_use { diary.refused("aviso", "nome_ja_em_uso", None, None); }
    Some(diary.end(Some(error)))
}

/// `resolve_scan_roots`: o `scan_roots` do `runtime-config.json`, senão `CP_SCAN_ROOTS`, senão o
/// padrão do sistema; cada um com `~` expandido e o caminho real, só as pastas que existem.
pub fn scan_roots(home: &Path, env: &BTreeMap<String, String>, runtime: &Value) -> Vec<PathBuf> {
    let raw = runtime["scan_roots"].as_str().filter(|r| !r.trim().is_empty()).map(str::to_owned)
        .or_else(|| env.get("CP_SCAN_ROOTS").cloned())
        .unwrap_or_else(|| (if cfg!(windows) { "~,~/Documents,~/Desktop" } else { "~/pessoal,~/sistemas" }).into());
    let mut out: Vec<PathBuf> = Vec::new();
    for entry in raw.split(',').map(str::trim).filter(|e| !e.is_empty()) {
        let path = match entry.strip_prefix('~') {
            Some("") => home.to_owned(),
            Some(rest) if rest.starts_with(['/', '\\']) => home.join(&rest[1..]),
            _ => PathBuf::from(entry),
        };
        let Ok(real) = path.canonicalize() else { continue };
        if real.is_dir() && !out.contains(&real) { out.push(real); }
    }
    out
}

/// `_allowed_scan_root`: a pasta da worktree mora numa raiz liberada (a do convidado, para ele).
fn allowed_root(host: &dyn OpenHost, caller: &OpenCaller, cwd: &str, runtime: &Value) -> Result<PathBuf, OpenError> {
    let roots = match caller {
        OpenCaller::Guest { root } => vec![root.clone()],
        OpenCaller::Owner => scan_roots(host.home(), host.env(), runtime),
    };
    let target = Path::new(cwd).canonicalize().unwrap_or_else(|_| PathBuf::from(cwd));
    roots.into_iter().find(|root| target.starts_with(root))
        .ok_or_else(|| OpenError::new(403, "erro_criacao_sessao", "root not allowed"))
}

fn creation(msg: impl Into<String>) -> OpenError { OpenError::new(409, "erro_criacao_sessao", msg) }

fn name_in_use() -> OpenError { OpenError::new(409, "erro_nome_em_uso", "ja existe uma sessao com esse nome") }

/// O tmux que não respondeu: não dá para saber se o nome está livre.
pub(crate) fn mux_unavailable(detail: &str) -> OpenError {
    OpenError::new(503, "erro_mux_indisponivel", "o tmux não respondeu — a lista de sessões está indisponível")
        .with_params(json!({"detalhe": detail}))
}

/// O pane pode ter nascido sem o multiplexador confirmar: nada em volta dele é desfeito.
const UNCERTAIN: &str = "session_open_uncertain";

/// O passo de cada criação em curso, pelo nome sanitizado da sessão nova (`GET
/// /api/sessions/creation-progress`): a tela de criar consulta enquanto espera e sabe que não travou.
static PROGRESS: std::sync::Mutex<BTreeMap<String, Value>> = std::sync::Mutex::new(BTreeMap::new());

fn progress_map() -> std::sync::MutexGuard<'static, BTreeMap<String, Value>> {
    PROGRESS.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// O registro do passo de uma criação: só quem o abriu o apaga (o bastão acompanha a criação por dentro dele).
pub struct Progress(Option<String>);

impl Progress {
    pub fn track(name: &str) -> Self {
        let key = crate::list::discover_other::sanitize_session_name(name);
        let mut map = progress_map();
        if key.is_empty() || map.contains_key(&key) { return Self(None); }
        map.insert(key.clone(), json!({"step": "preparando", "params": {}}));
        Self(Some(key))
    }
}

impl Drop for Progress {
    fn drop(&mut self) { if let Some(key) = &self.0 { progress_map().remove(key); } }
}

/// O passo de agora, se há criação em curso com esse nome.
pub fn progress_step(name: &str, step: &str, params: Value) {
    if let Some(entry) = progress_map().get_mut(&crate::list::discover_other::sanitize_session_name(name)) {
        *entry = json!({"step": step, "params": params});
    }
}

pub fn progress(name: &str) -> Value {
    progress_map().get(&crate::list::discover_other::sanitize_session_name(name)).cloned().unwrap_or_else(|| json!({"step": null, "params": {}}))
}

/// Nomes com abertura em curso neste processo, por casa (`home`).
static OPENING: std::sync::Mutex<std::collections::BTreeSet<(PathBuf, String)>> = std::sync::Mutex::new(std::collections::BTreeSet::new());

/// A reserva do nome enquanto a abertura corre: a segunda abertura do mesmo nome é recusada.
pub(crate) struct NameClaim((PathBuf, String));

impl NameClaim {
    pub(crate) fn take(home: &Path, name: &str) -> Result<Self, OpenError> {
        let key = (home.to_owned(), name.to_owned());
        if !OPENING.lock().unwrap_or_else(std::sync::PoisonError::into_inner).insert(key.clone()) {
            return Err(name_in_use());
        }
        Ok(Self(key))
    }
}

impl Drop for NameClaim {
    fn drop(&mut self) { OPENING.lock().unwrap_or_else(std::sync::PoisonError::into_inner).remove(&self.0); }
}

/// `orq_readonly.prepare`: o envelope `bwrap` que deixa o código só leitura, provado com `/bin/true`.
async fn read_only_prefix(host: &dyn OpenHost, cwd: &str, config_dir: Option<&str>) -> Result<Vec<String>, OpenError> {
    let refuse = |msg: String| OpenError::new(400, "erro_criacao_sessao", msg);
    if !cfg!(target_os = "linux") { return Err(refuse("read-only exige Linux com bubblewrap (bwrap)".into())); }
    let path: Vec<(String, String)> = host.env().iter().map(|(k, v)| (k.clone(), v.clone())).collect();
    let bwrap = crate::runtime::process::resolve_program("bwrap", &path)
        .ok_or_else(|| refuse("read-only exige bubblewrap: instale bwrap antes de criar a sessão".into()))?;
    let root = Path::new(cwd).canonicalize().map_err(|e| refuse(format!("read-only não pôde preparar a proteção: {e}")))?;
    let mut paths = vec![root.clone()];
    let git = host.run(["git", "-C", &root.to_string_lossy(), "rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir",
        "--show-toplevel"].map(str::to_owned).into(), Duration::from_secs(5)).await;
    if git.code == Some(0) {
        for line in git.stdout.lines().filter(|l| !l.is_empty()) {
            let real = Path::new(line).canonicalize().map_err(|e| refuse(format!("read-only não pôde preparar a proteção: {e}")))?;
            if !paths.contains(&real) { paths.push(real); }
        }
    } else if root.ancestors().any(|p| p.join(".git").exists()) {
        return Err(refuse("read-only não conseguiu localizar os metadados Git".into()));
    }
    let home = host.home().canonicalize().unwrap_or_else(|_| host.home().to_owned());
    if paths.iter().any(|p| home.starts_with(p)) {
        return Err(refuse("read-only não pode proteger a HOME inteira ou um diretório acima dela".into()));
    }
    let mut runtimes: Vec<PathBuf> = [".claude", ".codex", ".pi", ".omp", ".kimi-code", ".hangar"].iter().map(|n| host.home().join(n)).collect();
    runtimes.extend(config_dir.map(PathBuf::from));
    runtimes.extend(["CLAUDE_CONFIG_DIR", "CODEX_HOME", "PI_CODING_AGENT_DIR", "PI_CODING_AGENT_SESSION_DIR", "PI_CONFIG_DIR", "KIMI_CODE_HOME"]
        .iter().filter_map(|k| host.env().get(*k).filter(|v| !v.is_empty())).map(PathBuf::from));
    let resolved = |p: &PathBuf| p.canonicalize().unwrap_or_else(|_| p.clone());
    if runtimes.iter().any(|r| paths.iter().any(|p| resolved(r).starts_with(p))) {
        return Err(refuse("read-only recusado: o código protegido contém o runtime de um agente".into()));
    }
    paths.sort_by_key(|p| (p.components().count(), p.to_string_lossy().into_owned()));
    let mut argv: Vec<String> = [bwrap.to_string_lossy().as_ref(), "--bind", "/", "/", "--dev-bind", "/dev", "/dev", "--setenv", "HANGAR_ORQ_READ_ONLY", "1"]
        .map(str::to_owned).into();
    for p in &paths { argv.extend(["--ro-bind".into(), p.to_string_lossy().into_owned(), p.to_string_lossy().into_owned()]); }
    argv.push("--".into());
    let mut probe = argv.clone();
    probe.push("/bin/true".into());
    let out = host.run(probe, Duration::from_secs(5)).await;
    match out.code {
        Some(0) => Ok(argv),
        None => Err(refuse(format!("read-only não pôde preparar a proteção: {}", out.stderr.trim()))),
        Some(_) => Err(refuse(format!("read-only recusado pelo bubblewrap: {}", out.stderr.trim()))),
    }
}

/// O corpo de `CreatedSessionInfo` da sessão que acabou de nascer.
fn created_body(spec: &SessionSpec, jsonl: Option<&str>, warnings: Vec<String>, route: Option<&claude::EngineRoute>) -> Value {
    let engine = match &spec.account { Account::Engine { name, .. } => Value::from(name.clone()), _ => Value::Null };
    // Worktree ligada: o `.git` dela é arquivo. A branch que já era a da pasta fica na pasta.
    let linked = spec.worktree.is_some() && Path::new(&spec.cwd).join(".git").is_file();
    let head = json!({
        "name": spec.name, "lifecycle_id": null, "transfer_id": null, "transfer_phase": null, "cwd": spec.cwd,
        "jsonl": jsonl, "provider": spec.provider.name(), "headless": spec.surface == Surface::Headless, "engine": engine, "engine_account": route.map(|r| r.account.clone()),
        "codex_home": null, "codex_service_tier": null, "conta": route.map(|r| r.credential_id.clone()), "state": "idle", "last_activity": null,
        "last_reply": null, "last_reply_at": null, "tracked": jsonl.is_some(),
        "branch": spec.worktree.as_ref().map(|w| w.branch.clone()),
        "worktree": linked,
        "worktree_path": linked.then(|| spec.cwd.clone()),
        "worktree_gone": false, "git_cwd": null, "git_dirty": null, "git_ahead": null, "git_behind": null,
    });
    let rest = json!({
        "git_added": null, "git_removed": null, "avisos": warnings, "label": null, "startup_steps": [], "question": null,
        "pending_questions": 0, "options": null, "stalled": false, "problema": null, "limited": false, "limit_reset": null,
        "shared": false, "guest_kind": null, "owner": null, "then_target": null, "status_line": null, "context": null,
        "model": null, "pair_peers": null, "pair_external": null, "pair_gid": null, "pair_task": null, "orq_arbiter": null,
        "loop_status": null, "loop_iter": null, "loop_max": null, "plan_name": null, "plan_task": null,
        "plan_task_total": null, "plan_done": null, "plan_total": null, "plan_complete": null, "plan_tasks": null,
        "plan_hidden": null, "config_dir": spec.account.config_dir(), "account_source": spec.account_source.wire(),
    });
    let mut body = head;
    body.as_object_mut().unwrap().extend(rest.as_object().unwrap().clone());
    body
}

/// A worktree que esta abertura criou, para desfazer se ela falhar (ou se o registro do convidado falhar).
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct WorktreeUndo { pub source: String, pub path: String, pub branch: String, pub branch_created: bool }

impl WorktreeUndo {
    /// O `git` roda fora do runtime.
    pub async fn undo(self) -> Result<(), OpenError> {
        let failed = |detail: String| OpenError::new(500, "erro_criacao_sessao", format!("falha ao desfazer a worktree: {detail}"));
        tokio::task::spawn_blocking(move || {
            let made = hangar_workspace::git::Worktree { path: self.path.clone(), created: true, branch_created: self.branch_created };
            hangar_workspace::git::undo_worktree(Path::new(&self.source), &made, &self.branch)
                .map_err(|e| e.detail.as_str().map_or_else(|| e.detail.to_string(), str::to_owned))
        }).await.map_err(|e| failed(e.to_string()))?.map_err(failed)
    }
}

/// O que a abertura devolve: o corpo da resposta e a worktree criada (quem registra o convidado a
/// desfaz se o registro falhar).
pub struct Opened { pub body: Value, pub undo: Option<WorktreeUndo>, pub key: String }

/// O provedor pedido, para o diário das recusas de antes da resolução.
pub fn requested_provider(request: &super::SessionOpenRequest) -> &'static str {
    request.provider.as_deref().and_then(AgentProvider::parse).map_or("claude", AgentProvider::name)
}

/// O que esta abertura atende: sessão com terminal de todo provedor menos o Codex, e o Claude sem terminal.
pub fn opens_here(spec: &SessionSpec) -> bool {
    spec.provider != AgentProvider::Codex && (spec.surface == Surface::Terminal || spec.provider == AgentProvider::Claude)
}

/// Abre a sessão do spec resolvido: com terminal (Claude, Pi, omp e Kimi) ou o Claude sem terminal.
pub async fn open_session(host: &dyn OpenHost, resolved: Resolved, caller: &OpenCaller) -> Result<Opened, OpenError> {
    let Resolved { mut spec, mut warnings, initial_prompt, remember_provider, previous_non_plan } = resolved;
    let _claim = NameClaim::take(host.home(), &spec.name)?;
    let runtime =crate::runtime::codex_launch::runtime_config(&crate::accounts::environment::AccountEnvironment::from_map(host.env().clone()));
    let engine = matches!(spec.account, Account::Engine { .. });
    // CRI-025: modelo de motor deixado no `settings.json` faria a sessão Anthropic nascer nele.
    if !engine && spec.provider == AgentProvider::Claude { warnings.extend(claude::drop_foreign_model(host.home(), spec.account.config_dir())); }
    let mut undo = None;
    if let Some(wt) = spec.worktree.clone() {
        let root = allowed_root(host, caller, &spec.cwd, &runtime)?;
        let stem = crate::list::discover_other::sanitize_session_name(&wt.branch);
        let stem = if stem.is_empty() { "worktree".to_owned() } else { stem };
        let source = spec.cwd.clone();
        let made = tokio::task::spawn_blocking(move || hangar_workspace::git::create_branch_worktree(Path::new(&source), &wt.branch, &stem,
            &root, wt.new_branch, wt.base.as_deref())).await.map_err(|_| creation("a criação da worktree não terminou"))?
            .map_err(|e| OpenError::new(e.status, "erro_criacao_sessao", e.detail.as_str().map_or_else(|| e.detail.to_string(), str::to_owned)))?;
        if made.created {
            undo = Some(WorktreeUndo { source: spec.cwd.clone(), path: made.path.clone(), branch: spec.worktree.as_ref().unwrap().branch.clone(),
                branch_created: made.branch_created });
        }
        spec.cwd = made.path.clone();
        if let Some(w) = spec.worktree.as_mut() { w.path = Some(made.path); }
    }
    match launch(host, &mut spec, warnings, initial_prompt.as_deref(), remember_provider, previous_non_plan, &runtime).await {
        Ok((jsonl, warnings, route)) => {
            if spec.surface == Surface::Headless { host.wake(&spec.name, initial_prompt.filter(|p| !p.is_empty())); }
            Ok(Opened { body: created_body(&spec, jsonl.as_deref(), warnings, route.as_ref()), undo, key: spec.key.clone() })
        }
        // Incerta, a sessão pode estar de pé na worktree: desfazer apagaria a pasta debaixo dela.
        Err(error) => {
            if let Some(undo) = undo && error.code != Some(UNCERTAIN) { undo.undo().await?; }
            Err(error)
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn launch(host: &dyn OpenHost, spec: &mut SessionSpec, warnings: Vec<String>, initial_prompt: Option<&str>,
                remember_provider: bool, previous_non_plan: Option<PermissionMode>, runtime: &Value)
                -> Result<(Option<String>, Vec<String>, Option<claude::EngineRoute>), OpenError> {
    let config_dir = spec.account.config_dir().map(str::to_owned);
    let read_only = if spec.read_only { Some(read_only_prefix(host, &spec.cwd, config_dir.as_deref()).await?) } else { None };
    // `ciclo_conta`: a guarda compartilhada da conta vale da reconciliação ao pane, e a exclusão dela
    // (exclusiva) espera a sessão que está subindo.
    let account_home = config_dir.clone().map(PathBuf::from).or_else(|| host.env().get("CLAUDE_CONFIG_DIR").filter(|v| !v.is_empty()).map(PathBuf::from))
        .unwrap_or_else(|| host.home().join(".claude"));
    let locks = crate::accounts::AccountLocks::new(host.home().join(".hangar").join("account-locks"));
    let key = crate::accounts::AccountKey::new(crate::accounts::Provider::Claude, &account_home)
        .map_err(|e| creation(format!("conta inválida: {e}")))?;
    let hangar_account = config_dir.as_deref().filter(|dir| claude::hangar_account(Path::new(dir)).is_some());
    // O Kimi não lê a conta Claude: nem trava nem reconciliação.
    let reads_account = spec.provider != AgentProvider::Kimi;
    let hangar_account = hangar_account.filter(|_| reads_account);
    let _guard = match reads_account {
        true => Some(locks.acquire(&key, crate::accounts::GuardMode::Shared, Instant::now() + Duration::from_secs(5)).await
            .map_err(|e| match e {
                crate::accounts::LockError::Busy => OpenError::new(409, "account_busy", "a conta está ocupada por outra operação"),
                crate::accounts::LockError::Io(e) => creation(format!("trava da conta: {e}")),
            })?),
        false => None,
    };
    // A conta do Hangar se reconcilia antes de abrir; os avisos dela vêm antes dos da abertura.
    let mut avisos = Vec::new();
    if let Some(dir) = hangar_account {
        // Conferida de novo sob a guarda: a exclusão pode ter passado antes dela.
        let account = claude::hangar_account(Path::new(dir))
            .ok_or_else(|| OpenError::plain(404, format!("{dir} não é uma conta criada pelo hangar")))?;
        progress_step(&spec.name, "conta", json!({"conta": account}));
        let out = host.run(claude::prep_argv(&account, &spec.cwd), Duration::from_secs(120)).await;
        avisos = claude::prep_result(&account, out.code, &out.stderr)?;
    }
    avisos.extend(warnings);
    progress_step(&spec.name, "criando", json!({}));
    let mut diary = Diary::new(crate::mods::state::random_hex(8), &spec.name, spec.provider.name());
    let result = match spec.surface {
        Surface::Terminal => terminal_life(host, spec, read_only.as_deref(), initial_prompt, &mut diary, remember_provider, runtime).await,
        Surface::Headless => headless_life(host, spec, previous_non_plan, &mut diary, remember_provider).await,
    };
    let events = diary.end(result.as_ref().err());
    host.diary(events);
    let (jsonl, mut born_warnings, route) = result?;
    avisos.append(&mut born_warnings);
    Ok((jsonl, avisos, route))
}

/// Com motor: o `hangar-engine` no PATH (sem ele a sessão nasce e morre calada) e a conta ChatGPT fixa,
/// a mesma rota que a abertura conferiu, relida agora.
fn engine_route(host: &dyn OpenHost, spec: &SessionSpec) -> Result<Option<claude::EngineRoute>, OpenError> {
    if let Account::Engine { .. } = spec.account {
        let path: Vec<(String, String)> = host.env().iter().map(|(k, v)| (k.clone(), v.clone())).collect();
        if crate::runtime::process::resolve_program("hangar-engine", &path).is_none() {
            return Err(creation("hangar-engine nao esta no PATH deste servidor — sem ele a sessao com motor nasce e morre na \
                hora, sem erro. Instale o lancador: no Linux, scripts/install-claude-wrapper.sh; no Windows, install.ps1."));
        }
    }
    match &spec.account {
        Account::Engine { name, account: Some(account), .. } => Ok(Some(super::facts::fixed_account(
            &crate::accounts::AccountService::new(crate::accounts::environment::AccountEnvironment::from_map(host.env().clone())), name, account)?)),
        _ => Ok(None),
    }
}

/// O pane do Claude, o transcript da conversa nova e a rota da conta ChatGPT fixa do motor.
async fn claude_plan(host: &dyn OpenHost, spec: &SessionSpec, sid: &str, read_only: Option<&[String]>, initial_prompt: Option<&str>,
                     runtime: &Value) -> Result<(PaneSpec, String, Option<claude::EngineRoute>), OpenError> {
    let config_dir = spec.account.config_dir().map(str::to_owned);
    let effective_dir = config_dir.clone().or_else(|| host.env().get("CLAUDE_CONFIG_DIR").filter(|v| !v.is_empty()).cloned())
        .unwrap_or_else(|| host.home().join(".claude").to_string_lossy().into_owned());
    let settings = match &spec.customizations {
        Some(selection) => Some(host.customizations(json!({"session_id": sid, "cwd": spec.cwd, "config_dir": effective_dir,
            "selection": selection, "resume": false})).await?["settings"].clone()),
        None => None,
    };
    let route = engine_route(host, spec)?;
    let roots = claude::plugin_roots(host.home());
    let bridge = host.bridge();
    let key = host.new_bridge_key();
    let ctx = claude::ClaudeContext { plugin_roots: &roots, bridge: bridge.as_ref(), bridge_key: &key, runtime_config: runtime,
        server_env: host.env(), settings: settings.as_ref(), read_only, windows: host.terminal().windows, initial_prompt, engine_route: route.as_ref() };
    let pane = claude::pane(spec, sid, &ctx);
    let jsonl = claude::transcript(spec, sid, &host.server_projects()).to_string_lossy().into_owned();
    Ok((pane, jsonl, route))
}

/// `hangar-skills-sync`: a skill instalada no Claude vale já nesta sessão de Pi, omp ou Kimi. Nunca
/// impede a abertura.
async fn sync_skills(host: &dyn OpenHost) {
    let out = host.run(vec!["hangar-skills-sync".into()], Duration::from_secs(30)).await;
    if out.code != Some(0) {
        tracing::warn!(code = ?out.code, stderr = %out.stderr.trim(), "ponte de skills não refeita antes de abrir a sessão");
    }
}

/// O sidecar do Claude sem terminal com os campos que o Python grava (`sessions.save`): os dois lados
/// ainda o leem, e um revert não pode reabrir a sessão em modo errado.
fn headless_sidecar(spec: &SessionSpec, sid: &str, previous_non_plan: Option<PermissionMode>, settings: Option<&Value>,
                    route: Option<&claude::EngineRoute>) -> Value {
    let (engine, context_window) = match &spec.account {
        Account::Engine { name, context_window, .. } => (Some(name.clone()), *context_window),
        _ => (None, None),
    };
    let mut meta = json!({
        "name": spec.name, "provider": "claude", "headless": true, "key": spec.key, "cwd": spec.cwd, "session_id": sid,
        "config_dir": spec.account.config_dir(), "engine": engine, "model": spec.model, "effort": spec.effort,
        "context_window": context_window, "permission_mode": spec.permission_mode.map(PermissionMode::name),
        "previous_non_plan": previous_non_plan.map(PermissionMode::name), "subagent_model": spec.subagent_model, "jev": spec.jev,
    });
    if let Some(tier) = spec.service_tier { meta["service_tier"] = json!(tier.name()); }
    if let Some(settings) = settings { meta["claude_settings"] = settings.clone(); }
    if let Some(route) = route {
        meta["engine_account"] = json!(route.account);
        meta["engine_credential_id"] = json!(route.credential_id);
        meta["engine_account_base_url"] = json!(route.base_url);
    }
    meta
}

/// Do `validar` ao `sessao.criada` do Claude sem terminal: grava registro e sidecar. O processo sobe
/// depois (`OpenHost::wake`), pelo spec.
async fn headless_life(host: &dyn OpenHost, spec: &SessionSpec, previous_non_plan: Option<PermissionMode>, diary: &mut Diary,
                       remember_provider: bool) -> Result<(Option<String>, Vec<String>, Option<claude::EngineRoute>), OpenError> {
    diary.step("validar");
    let sidecars = host.home().join(".hangar");
    let taken = |kind: &str| crate::runtime::codex_sidecar::path(&sidecars.join(kind), &spec.name).exists();
    // A resolução conferiu o nome antes de conta e worktree: outra sessão pode ter nascido desde então.
    // Sem pane, o multiplexador que não responde (ou não existe) não impede, como no `_create_headless`.
    let pane = terminal::presence(host.mux(), host.terminal(), &spec.name).await.0 == terminal::Presence::Present;
    if pane || taken("claude-headless") || taken("codex-sessions") {
        diary.refused("aviso", "nome_ja_em_uso", None, None);
        return Err(name_in_use());
    }
    host.leave_old_group(&spec.name).await?;
    let sid = host.new_session_id();
    let config_dir = spec.account.config_dir().map(str::to_owned);
    let effective_dir = config_dir.clone().or_else(|| host.env().get("CLAUDE_CONFIG_DIR").filter(|v| !v.is_empty()).cloned())
        .unwrap_or_else(|| host.home().join(".claude").to_string_lossy().into_owned());
    let settings = match &spec.customizations {
        Some(selection) => Some(host.customizations(json!({"session_id": sid, "cwd": spec.cwd, "config_dir": effective_dir,
            "selection": selection, "resume": false})).await?["settings"].clone()),
        None => None,
    };
    let route = engine_route(host, spec)?;
    diary.step("confiar_pasta");
    claude::pretrust(&claude::claude_json(host.terminal(), host.home(), spec.account.config_dir()), &spec.cwd, host.terminal().windows);
    // Antes do sidecar: depois dele o runtime pode adotar a sessão nova no meio da limpeza.
    host.release_name(&spec.name).await?;
    if let Err(error) = super::record::write(host.home(), spec) {
        diary.refused("erro", "registro_nao_gravado", Some("sidecar_gravado"), Some(&error.kind().to_string()));
        return Err(OpenError::new(500, "erro_criacao_sessao", format!("o registro da sessão não foi gravado: {error}")));
    }
    let meta = headless_sidecar(spec, &sid, previous_non_plan, settings.as_ref(), route.as_ref()).as_object().cloned().unwrap_or_default();
    if let Err(error) = crate::runtime::codex_sidecar::put(&sidecars.join("claude-headless"), &spec.name, &meta) {
        diary.refused("erro", "sidecar_nao_gravado", Some("sidecar_gravado"), Some(&error.kind().to_string()));
        if let Err(error) = super::record::remove(host.home(), &spec.key) {
            tracing::warn!(kind = ?error.kind(), "registro da abertura que não nasceu ficou para trás");
        }
        return Err(OpenError::new(500, "erro_criacao_sessao", format!("o arquivo da sessão não foi gravado: {error}")));
    }
    let jsonl = claude::transcript(spec, &sid, &host.server_projects()).to_string_lossy().into_owned();
    let born = Born { name: spec.name.clone(), provider: spec.provider, jsonl: Some(jsonl.clone()), remember_provider };
    let warnings = host.born(&born).await;
    diary.events.push(json!({"evento": "sessao.criada", "nivel": "ok", "sessao": spec.name, "provider": spec.provider.name(),
        "etapa": "sidecar_gravado", "operacao": diary.op}));
    Ok((Some(jsonl), warnings, route))
}

/// Do `validar` ao `sessao.criada`: o pane e o que muda em volta dele.
async fn terminal_life(host: &dyn OpenHost, spec: &mut SessionSpec, read_only: Option<&[String]>, initial_prompt: Option<&str>, diary: &mut Diary,
                       remember_provider: bool, runtime: &Value) -> Result<(Option<String>, Vec<String>, Option<claude::EngineRoute>), OpenError> {
    diary.step("validar");
    let claude = spec.provider == AgentProvider::Claude;
    if !claude { sync_skills(host).await; }
    // A resolução conferiu o nome antes de conta e worktree: outro pane pode ter nascido desde então.
    match terminal::presence(host.mux(), host.terminal(), &spec.name).await {
        (terminal::Presence::Absent, _) => {}
        (terminal::Presence::Present, _) => {
            diary.refused("aviso", "nome_ja_em_uso", None, None);
            return Err(name_in_use());
        }
        (terminal::Presence::Unknown, stderr) => return Err(mux_unavailable(&stderr)),
    }
    host.leave_old_group(&spec.name).await?;
    diary.step("preparar_comando");
    let sid = host.new_session_id();
    let mut warnings = Vec::new();
    let (pane, jsonl, route) = if claude {
        let (pane, jsonl, route) = claude_plan(host, spec, &sid, read_only, initial_prompt, runtime).await?;
        (pane, Some(jsonl), route)
    } else {
        let ctx = agents::AgentContext { home: host.home(), server_env: host.env(), runtime_config: runtime, read_only,
            windows: host.terminal().windows };
        if initial_prompt.is_some_and(|p| !p.is_empty()) {
            warnings.push(format!("O prompt inicial não vai no comando do {}: mande-o como a primeira mensagem.", spec.provider.name()));
        }
        // O transcript nasce no 1º turno, num layout próprio: nada a semear.
        (agents::pane(spec, Conversation::New(&sid), &ctx)?, None, None)
    };
    diary.step("confiar_pasta");
    match spec.provider {
        AgentProvider::Claude => claude::pretrust(&claude::claude_json(host.terminal(), host.home(), spec.account.config_dir()), &spec.cwd,
            host.terminal().windows),
        AgentProvider::Kimi => {
            let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64);
            agents::kimi_pretrust(&agents::kimi_home(host.home(), host.env()), &spec.cwd, now);
        }
        _ => {}
    }
    diary.step("criar_terminal");
    host.release_name(&spec.name).await?;
    // O registro antes do pane: sem ele a sessão não é reaberta nem reconhecida pela chave.
    if let Err(error) = super::record::write(host.home(), spec) {
        diary.refused("erro", "registro_nao_gravado", Some("criar_terminal"), Some(&error.kind().to_string()));
        return Err(OpenError::new(500, "erro_criacao_sessao", format!("o registro da sessão não foi gravado: {error}")));
    }
    if let Err(error) = terminal::spawn(host.mux(), host.terminal(), &pane).await {
        diary.refused("erro", error.code, Some("criar_terminal"), Some(&error.stderr));
        if error.code == terminal::UNCERTAIN {
            return Err(OpenError::new(504, UNCERTAIN, "o tmux não respondeu e a sessão pode ter nascido; confira a lista antes de tentar de novo"));
        }
        if let Err(error) = super::record::remove(host.home(), &spec.key) {
            tracing::warn!(kind = ?error.kind(), "registro da abertura que não nasceu ficou para trás");
        }
        return Err(creation(match error.code {
            "terminal_morreu_ao_nascer" => format!("o terminal fechou logo depois de abrir: {}", error.stderr),
            _ => "falha ao criar sessao no tmux".to_owned(),
        }));
    }
    diary.step("limpar_estado_anterior");
    let born = Born { name: spec.name.clone(), provider: spec.provider, jsonl: jsonl.clone(), remember_provider };
    warnings.extend(host.born(&born).await);
    diary.events.push(json!({"evento": "sessao.criada", "nivel": "ok", "sessao": spec.name, "provider": spec.provider.name(),
        "etapa": "terminal_criado", "operacao": diary.op}));
    Ok((jsonl, warnings, route))
}
