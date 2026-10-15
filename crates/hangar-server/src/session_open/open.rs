//! Abrir uma sessão Claude com terminal pelo spec: o que o `create_session` e o ramo Claude do
//! `registry.create` do Python faziam em volta do pane, na mesma ordem, com os consertos da Task 4.
//! Os efeitos de fora (processos, pontes, diário) passam pelo `OpenHost`: o servidor, o comando de
//! terminal com o servidor fora e o harness do contrato implementam cada um o seu.
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use futures_util::future::BoxFuture;
use serde_json::{Value, json};

use super::claude::{self, PluginBridge};
use super::terminal::{self, Mux, TerminalEnv};
use super::{Account, OpenCaller, OpenError, Resolved, SessionSpec};

/// Saída de um programa que a abertura roda (`hangar-conta`, a sonda do `bwrap`).
#[derive(Clone, Debug, Default)]
pub struct ProgramOutput { pub code: Option<i32>, pub stdout: String, pub stderr: String }

/// O que a sessão que acabou de nascer avisa a quem guarda estado do nome.
#[derive(Clone, Debug)]
pub struct Born { pub name: String, pub session_id: String, pub jsonl: String, pub permission_mode: Option<String>,
    pub remember_provider: bool }

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
struct Diary { events: Vec<Value>, op: String, started: Instant, name: String }

impl Diary {
    fn new(op: String, name: &str) -> Self {
        Self { events: vec![json!({"evento": "sessao.criar.inicio", "nivel": "ok", "operacao": op})], op, started: Instant::now(), name: name.into() }
    }
    fn session(&self) -> Value { if self.name.is_empty() { Value::Null } else { Value::from(self.name.clone()) } }
    fn step(&mut self, etapa: &str) {
        let mut e = json!({"evento": "sessao.criar_etapa", "nivel": "ok", "sessao": self.session(), "provider": "claude", "etapa": etapa, "operacao": self.op});
        if e["sessao"].is_null() { e.as_object_mut().unwrap().remove("sessao"); }
        self.events.push(e);
    }
    fn refused(&mut self, level: &str, code: &str, etapa: Option<&str>, detail: Option<&str>) {
        let mut e = json!({"evento": "sessao.criar_recusada", "nivel": level, "sessao": self.session(), "provider": "claude", "operacao": self.op});
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
pub fn refusal_diary(op: String, name: &str, error: &OpenError) -> Option<Vec<Value>> {
    let in_use = error.code == Some("erro_nome_em_uso");
    let invalid = error.code == Some("erro_criacao_sessao") && error.msg.starts_with("nome invalido");
    if !(in_use || invalid) { return None; }
    let mut diary = Diary::new(op, if invalid { "" } else { name });
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

/// O corpo de `CreatedSessionInfo` de uma sessão Claude com terminal que acabou de nascer.
fn created_body(spec: &SessionSpec, jsonl: &str, warnings: Vec<String>) -> Value {
    let engine = match &spec.account { Account::Engine { name, .. } => Value::from(name.clone()), _ => Value::Null };
    // Worktree ligada: o `.git` dela é arquivo. A branch que já era a da pasta fica na pasta.
    let linked = spec.worktree.is_some() && Path::new(&spec.cwd).join(".git").is_file();
    let head = json!({
        "name": spec.name, "lifecycle_id": null, "transfer_id": null, "transfer_phase": null, "cwd": spec.cwd,
        "jsonl": jsonl, "provider": "claude", "headless": false, "engine": engine, "engine_account": null,
        "codex_home": null, "codex_service_tier": null, "conta": null, "state": "idle", "last_activity": null,
        "last_reply": null, "last_reply_at": null, "tracked": true,
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
    pub fn undo(&self) -> Result<(), OpenError> {
        let made = hangar_workspace::git::Worktree { path: self.path.clone(), created: true, branch_created: self.branch_created };
        hangar_workspace::git::undo_worktree(Path::new(&self.source), &made, &self.branch).map_err(|e| OpenError::new(500,
            "erro_criacao_sessao", format!("falha ao desfazer a worktree: {}", e.detail.as_str().map_or_else(|| e.detail.to_string(), str::to_owned))))
    }
}

/// O que a abertura devolve: o corpo da resposta e a worktree criada (quem registra o convidado a
/// desfaz se o registro falhar).
pub struct Opened { pub body: Value, pub undo: Option<WorktreeUndo> }

/// Abre a sessão Claude com terminal do spec resolvido.
pub async fn open_claude_terminal(host: &dyn OpenHost, resolved: Resolved, caller: &OpenCaller) -> Result<Opened, OpenError> {
    let Resolved { mut spec, mut warnings, initial_prompt, remember_provider } = resolved;
    let runtime = crate::runtime::codex_launch::runtime_config(&crate::accounts::environment::AccountEnvironment::from_map(host.env().clone()));
    let engine = matches!(spec.account, Account::Engine { .. });
    // CRI-025: modelo de motor deixado no `settings.json` faria a sessão Anthropic nascer nele.
    if !engine { warnings.extend(claude::drop_foreign_model(host.home(), spec.account.config_dir())); }
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
    match launch(host, &mut spec, warnings, initial_prompt.as_deref(), remember_provider, &runtime).await {
        Ok((jsonl, warnings)) => Ok(Opened { body: created_body(&spec, &jsonl, warnings), undo }),
        Err(error) => {
            if let Some(undo) = undo { undo.undo()?; }
            Err(error)
        }
    }
}

async fn launch(host: &dyn OpenHost, spec: &mut SessionSpec, warnings: Vec<String>, _initial_prompt: Option<&str>,
                remember_provider: bool, runtime: &Value) -> Result<(String, Vec<String>), OpenError> {
    let config_dir = spec.account.config_dir().map(str::to_owned);
    let read_only = if spec.read_only { Some(read_only_prefix(host, &spec.cwd, config_dir.as_deref()).await?) } else { None };
    // A conta do Hangar se reconcilia antes de abrir; os avisos dela vêm antes dos da abertura.
    let mut avisos = Vec::new();
    if let Some(dir) = config_dir.as_deref() && let Some(account) = claude::hangar_account(Path::new(dir)) {
        let out = host.run(claude::prep_argv(&account, &spec.cwd), Duration::from_secs(120)).await;
        avisos = claude::prep_result(&account, out.code, &out.stderr)?;
    }
    avisos.extend(warnings);
    // A guarda compartilhada da conta: a exclusão dela espera a sessão que está subindo.
    let account_home = config_dir.clone().map(PathBuf::from).or_else(|| host.env().get("CLAUDE_CONFIG_DIR").filter(|v| !v.is_empty()).map(PathBuf::from))
        .unwrap_or_else(|| host.home().join(".claude"));
    let locks = crate::accounts::AccountLocks::new(host.home().join(".hangar").join("account-locks"));
    let key = crate::accounts::AccountKey::new(crate::accounts::Provider::Claude, &account_home)
        .map_err(|e| creation(format!("conta inválida: {e}")))?;
    let _guard = locks.acquire(&key, crate::accounts::GuardMode::Shared, Instant::now() + Duration::from_secs(5)).await
        .map_err(|e| match e {
            crate::accounts::LockError::Busy => OpenError::new(409, "account_busy", "a conta está ocupada por outra operação"),
            crate::accounts::LockError::Io(e) => creation(format!("trava da conta: {e}")),
        })?;
    let mut diary = Diary::new(crate::mods::state::random_hex(8), &spec.name);
    let result = terminal_life(host, spec, read_only.as_deref(), &mut diary, remember_provider, runtime).await;
    let events = diary.end(result.as_ref().err());
    host.diary(events);
    let (jsonl, mut born_warnings) = result?;
    avisos.append(&mut born_warnings);
    Ok((jsonl, avisos))
}

/// Do `validar` ao `sessao.criada`: o pane e o que muda em volta dele.
async fn terminal_life(host: &dyn OpenHost, spec: &mut SessionSpec, read_only: Option<&[String]>, diary: &mut Diary,
                       remember_provider: bool, runtime: &Value) -> Result<(String, Vec<String>), OpenError> {
    diary.step("validar");
    host.leave_old_group(&spec.name).await?;
    diary.step("preparar_comando");
    let sid = host.new_session_id();
    let config_dir = spec.account.config_dir().map(str::to_owned);
    let effective_dir = config_dir.clone().or_else(|| host.env().get("CLAUDE_CONFIG_DIR").filter(|v| !v.is_empty()).cloned())
        .unwrap_or_else(|| host.home().join(".claude").to_string_lossy().into_owned());
    let settings = match &spec.customizations {
        Some(selection) => Some(host.customizations(json!({"session_id": sid, "cwd": spec.cwd, "config_dir": effective_dir,
            "selection": selection, "resume": false})).await?["settings"].clone()),
        None => None,
    };
    if let Account::Engine { .. } = spec.account {
        let path: Vec<(String, String)> = host.env().iter().map(|(k, v)| (k.clone(), v.clone())).collect();
        if crate::runtime::process::resolve_program("hangar-engine", &path).is_none() {
            return Err(creation("hangar-engine nao esta no PATH deste servidor — sem ele a sessao com motor nasce e morre na \
                hora, sem erro. Instale o lancador: no Linux, scripts/install-claude-wrapper.sh; no Windows, install.ps1."));
        }
    }
    let roots = claude::plugin_roots(host.home());
    let bridge = host.bridge();
    let key = host.new_bridge_key();
    let ctx = claude::ClaudeContext { plugin_roots: &roots, bridge: bridge.as_ref(), bridge_key: &key, runtime_config: runtime,
        server_env: host.env(), settings: settings.as_ref(), read_only, windows: host.terminal().windows };
    let pane = claude::pane(spec, &sid, &ctx);
    let jsonl = claude::transcript(spec, &sid, &host.server_projects()).to_string_lossy().into_owned();
    diary.step("confiar_pasta");
    claude::pretrust(&claude::claude_json(host.terminal(), host.home(), config_dir.as_deref()), &spec.cwd, host.terminal().windows);
    diary.step("criar_terminal");
    host.release_name(&spec.name).await?;
    if let Err(error) = terminal::spawn(host.mux(), host.terminal(), &pane).await {
        diary.refused("erro", error.code, Some("criar_terminal"), Some(&error.stderr));
        return Err(creation(match error.code {
            "terminal_morreu_ao_nascer" => format!("o terminal fechou logo depois de abrir: {}", error.stderr),
            _ => "falha ao criar sessao no tmux".to_owned(),
        }));
    }
    diary.step("limpar_estado_anterior");
    let born = Born { name: spec.name.clone(), session_id: sid, jsonl: jsonl.clone(),
        permission_mode: spec.permission_mode.map(|m| m.name().to_owned()), remember_provider };
    let warnings = host.born(&born).await;
    if let Err(error) = super::record::write(host.home(), spec) {
        tracing::warn!(kind = ?error.kind(), "registro da sessão não gravado; a sessão segue pelo sidecar");
    }
    diary.events.push(json!({"evento": "sessao.criada", "nivel": "ok", "sessao": spec.name, "provider": "claude",
        "etapa": "terminal_criado", "operacao": diary.op}));
    Ok((jsonl, warnings))
}
