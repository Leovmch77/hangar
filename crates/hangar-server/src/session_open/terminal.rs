//! O lançador de terminal de todo provedor: `tmux new-session` (o psmux no Windows) com o `-e`
//! completo, a conta, o escopo do systemd e o comando no dialeto do multiplexador. Port do
//! `tmux.new_session` do Python; quem monta o comando do agente é o plano de cada provedor.
use std::path::{Path, PathBuf};
use std::time::Duration;

use futures_util::future::BoxFuture;

use super::AgentProvider;

/// Saída de um comando do multiplexador; `code: None` = não terminou no prazo ou não rodou.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct MuxOutput { pub code: Option<i32>, pub stdout: String, pub stderr: String }

impl MuxOutput {
    fn ok(&self) -> bool { self.code == Some(0) }
}

/// Quem roda o multiplexador: o processo de verdade ou o falso dos testes e do harness.
pub trait Mux: Send + Sync {
    /// Prefixo do escopo transiente do systemd (`systemd-run … --`); vazio sem ele. Bloqueante.
    fn scope(&self) -> Vec<String>;
    fn run(&self, argv: Vec<String>) -> BoxFuture<'_, MuxOutput>;
}

/// O que vem da máquina e não do pedido.
#[derive(Clone, Debug)]
pub struct TerminalEnv {
    pub windows: bool,
    /// O `tmux` (psmux no Windows).
    pub program: String,
    /// `WAYLAND_DISPLAY` do servidor ou o primeiro socket `wayland-*` do `XDG_RUNTIME_DIR`.
    pub wayland: Option<String>,
    /// `CLAUDE_CONFIG_DIR` do servidor, quando ele tem um.
    pub server_config_dir: Option<String>,
    /// `~/.claude`: a conta padrão, que para o Claude Code é a ausência da variável.
    pub default_config_dir: PathBuf,
    /// Quanto o pane precisa ficar de pé depois de criado para não contar como morto ao nascer (S-15).
    pub birth: Duration,
}

impl TerminalEnv {
    /// A máquina de quem chama: o servidor ou o comando de terminal.
    pub fn local(home: &Path, env: &std::collections::BTreeMap<String, String>) -> Self {
        let var = |name: &str| env.get(name).filter(|v| !v.is_empty()).cloned();
        let wayland = var("WAYLAND_DISPLAY").or_else(|| {
            let dir = var("XDG_RUNTIME_DIR")?;
            let mut sockets: Vec<String> = std::fs::read_dir(dir).ok()?.flatten()
                .filter_map(|e| e.file_name().into_string().ok())
                .filter(|n| n.starts_with("wayland-") && !n.ends_with(".lock")).collect();
            sockets.sort();
            sockets.into_iter().next()
        });
        // ponytail: janela fixa; um CLI que cai depois dela passa como vivo. Prova por provedor (o
        // agente com o id da conversa no pane) quando a reabertura vier para cá.
        let birth = Duration::from_millis(if cfg!(windows) { 1500 } else { 500 });
        Self { windows: cfg!(windows), program: "tmux".into(), wayland, server_config_dir: var("CLAUDE_CONFIG_DIR"),
            default_config_dir: home.join(".claude"), birth }
    }
}

/// O pane que se pede: a identidade, a conta e o que roda nele.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PaneSpec {
    pub name: String,
    pub cwd: String,
    pub provider: AgentProvider,
    /// `CP_SESSION_KEY`: a chave do spec, a mesma em toda vida da sessão.
    pub key: String,
    /// `-e` da sessão, depois dos de todo provedor, na ordem.
    pub env: Vec<(String, String)>,
    /// Conta Claude que o pane lê; `None` = a padrão.
    pub config_dir: Option<String>,
    /// argv do que roda no pane.
    pub command: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SpawnError {
    /// O `detalhe` do diário.
    pub code: &'static str,
    /// Última linha do stderr do multiplexador, cortada.
    pub stderr: String,
}

impl std::fmt::Display for SpawnError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { write!(f, "{}: {}", self.code, self.stderr) }
}

/// `_mesmo_dir`: mesma pasta escrita de jeitos diferentes (barra, maiúscula no Windows).
fn same_dir(a: &str, b: &Path, windows: bool) -> bool {
    let norm = |p: &str| {
        let p = p.trim_end_matches(['/', '\\']).to_owned();
        if windows { p.replace('/', "\\").to_lowercase() } else { p }
    };
    norm(a) == norm(&b.to_string_lossy())
}

/// O `-e CLAUDE_CONFIG_DIR` vai quando a conta não é a padrão ou o servidor tem a variável (omitir
/// não apagaria a herança). A padrão é a ausência: exportar `~/.claude` faz o CLI ler outro `.claude.json`.
pub fn exports_config_dir(env: &TerminalEnv, config_dir: Option<&str>) -> Option<String> {
    let chosen = config_dir.map(str::to_owned).or_else(|| env.server_config_dir.clone())
        .unwrap_or_else(|| env.default_config_dir.to_string_lossy().into_owned());
    (env.server_config_dir.is_some() || !same_dir(&chosen, &env.default_config_dir, env.windows)).then_some(chosen)
}

/// `join_cmd`: o argv numa string só, no dialeto do multiplexador (POSIX: `shlex.join`; psmux:
/// aspas simples com o apóstrofo dobrado).
pub fn join(argv: &[String], windows: bool) -> String {
    argv.iter().map(|arg| crate::runtime::claude_relaunch::quote(arg, windows)).collect::<Vec<_>>().join(" ")
}

/// S-63: o que só a sessão põe (ou a configuração do servidor, relida na abertura) e o que é
/// segredo do servidor. Servidor tmux subido de dentro de outra sessão teria os dela; o pane sai sem
/// os que esta não pôs por `-e`.
pub const NOT_INHERITED: [&str; 28] = [
    "CLAUDE_CODE_SUBAGENT_MODEL", "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS", "HANGAR_PLUGIN_URL", "HANGAR_PLUGIN_TOKEN",
    "HANGAR_CLAUDE_SETTINGS", "HANGAR_JEV", "TYPESAFE_API_KEY", "JEV_ENDPOINT", "JEV_MODEL",
    "JEV_TEXTO_BASE_URL", "JEV_TEXTO_API_KEY", "JEV_TEXTO_MODELO", "JEV_TEXTO_CMD",
    "JEV_AUX_BASE_URL", "JEV_AUX_API_KEY", "JEV_AUX_MODELO", "JEV_AUX_ESFORCO",
    "CP_ENGINE", "CP_ENGINE_ACCOUNT", "CP_ENGINE_CREDENTIAL_ID", "CP_ENGINE_ACCOUNT_BASE_URL", "CP_ENGINE_SERVICE_TIER",
    "CLAUDE_CODE_MAX_CONTEXT_TOKENS", "HANGAR_ORQ_READ_ONLY", "HANGAR_CANO_KEY", "HANGAR_CANO_OWNER",
    "CP_PI_SESSION", "OMP_PROFILE",
];
/// Do servidor: nunca para o pane, nem para o cliente que pode subir o servidor tmux.
const SERVER_SECRETS: [&str; 3] = ["CP_AUTH_TOKEN", "HANGAR_INTERNAL_SECRET", "HANGAR_RUNTIME_INSTANCE"];

/// O argv do `new-session`, sem o escopo.
pub fn new_session_argv(env: &TerminalEnv, pane: &PaneSpec) -> Vec<String> {
    let mut argv: Vec<String> = [env.program.as_str(), "new-session", "-d", "-s", &pane.name, "-c", &pane.cwd, "-x", "200", "-y", "50"]
        .map(str::to_owned).into();
    let mut e = |key: &str, value: &str| argv.extend(["-e".to_owned(), format!("{key}={value}")]);
    e("COLORTERM", "truecolor");
    e("CLAUDE_CODE_TMUX_TRUECOLOR", "1");
    e("KIMI_CODE_TUI_FULL_SCREEN", "1");
    e("CP_SESSION_NAME", &pane.name);
    e("CP_PROVIDER", pane.provider.name());
    e("CP_SESSION_KEY", &pane.key);
    if let Some(wayland) = &env.wayland { e("WAYLAND_DISPLAY", wayland); }
    for (key, value) in &pane.env { e(key, value); }
    let exported = exports_config_dir(env, pane.config_dir.as_deref());
    if let Some(dir) = &exported { e("CLAUDE_CONFIG_DIR", dir); }
    let command = join(&pane.command, env.windows);
    // `exec`: o agente vira o processo do pane e recebe o teclado. No psmux o comando roda sem shell
    // no meio, e `exec` mataria o pane ao nascer; lá o pane herda de quem chama (`client_command`).
    if env.windows {
        argv.push(command);
        return argv;
    }
    // O pane herda o ambiente do servidor tmux, de quem o subiu: a conta padrão é a ausência.
    let own = |var: &&str| pane.env.iter().any(|(key, _)| key == var);
    let unset: Vec<&str> = exported.is_none().then_some("CLAUDE_CONFIG_DIR").into_iter()
        .chain(NOT_INHERITED.iter().copied().filter(|var| !own(var))).chain(SERVER_SECRETS).collect();
    argv.push(format!("exec env {} {command}", unset.iter().map(|var| format!("-u {var}")).collect::<Vec<_>>().join(" ")));
    argv
}

/// Última linha não vazia, cortada: vai ao diário sem trazer a saída inteira.
fn tail(stderr: &str) -> String {
    stderr.lines().map(str::trim).rfind(|line| !line.is_empty()).unwrap_or("").chars().take(200).collect()
}

/// Cria o pane. Escopo que o systemd recusa (o gerenciador parou de criar escopo depois da sonda)
/// repete uma vez sem ele, como o `_scope_lost` do Python.
pub async fn spawn(mux: &dyn Mux, env: &TerminalEnv, pane: &PaneSpec) -> Result<(), SpawnError> {
    let argv = new_session_argv(env, pane);
    let scope = if env.windows { Vec::new() } else { mux.scope() };
    let mut scoped = scope.clone();
    scoped.extend(argv.iter().cloned());
    let mut output = mux.run(scoped.clone()).await;
    // S-31: escopos criados juntos (o `orq` cria em rajada) recebem do systemd uma recusa passageira;
    // ela se repete, com o escopo e com espera; esgotada, é erro com o código dela.
    let mut waits = crate::runtime::process::SCOPE_RETRY.iter();
    while !scope.is_empty() && !output.ok() && crate::runtime::process::scope_unit_missing(output.stderr.as_bytes()).is_some() {
        let Some(wait) = waits.next() else {
            return Err(SpawnError { code: crate::runtime::process::SCOPE_UNIT_MISSING, stderr: tail(&output.stderr) });
        };
        tokio::time::sleep(crate::runtime::process::scope_wait(*wait)).await;
        output = mux.run(scoped.clone()).await;
    }
    if !scope.is_empty() && !output.ok() && output.stderr.trim_start().starts_with("Failed to ") {
        tracing::warn!(code = "systemd_scope_refused", cause = %tail(&output.stderr), "escopo do systemd recusado; o terminal sobe sem ele");
        output = mux.run(argv).await;
    }
    // S-32: sem resposta, a sessão pode ter nascido (e o psmux devolve diferente de zero com ela de
    // pé). Só vale se for esta: outra de mesmo nome ganhou a corrida e o pedido é recusado.
    if !output.ok() && !is_this_one(mux, env, pane).await {
        return Err(SpawnError { code: "terminal_nao_criado", stderr: tail(&output.stderr) });
    }
    born(mux, env, &pane.name).await
}

/// S-15: o `new-session` devolve 0 com o comando morto ao nascer (binário ausente, flag recusada):
/// sem `remain-on-exit` a sessão some com ele. Conferida a cada 100 ms durante a janela.
async fn born(mux: &dyn Mux, env: &TerminalEnv, name: &str) -> Result<(), SpawnError> {
    let step = Duration::from_millis(100);
    let mut waited = Duration::ZERO;
    while waited < env.birth {
        tokio::time::sleep(step).await;
        waited += step;
        let alive = mux.run(vec![env.program.clone(), "has-session".into(), "-t".into(), format!("={name}")]).await;
        if !alive.ok() {
            return Err(SpawnError { code: "terminal_morreu_ao_nascer", stderr: tail(&alive.stderr) });
        }
    }
    Ok(())
}

/// O alvo da sessão: `=nome` casa exato (sem ele o tmux cai em prefixo).
fn target(env: &TerminalEnv, name: &str) -> String { if env.windows { name.into() } else { format!("={name}") } }

/// A sessão `pane.name` existe e carrega a chave deste pedido.
async fn is_this_one(mux: &dyn Mux, env: &TerminalEnv, pane: &PaneSpec) -> bool {
    let target = target(env, &pane.name);
    let exists = mux.run(vec![env.program.clone(), "has-session".into(), "-t".into(), format!("={}", pane.name)]).await;
    if !exists.ok() { return false; }
    let key = mux.run(vec![env.program.clone(), "show-environment".into(), "-t".into(), target, "CP_SESSION_KEY".into()]).await;
    key.ok() && key.stdout.trim() == format!("CP_SESSION_KEY={}", pane.key)
}

/// O cliente do multiplexador: no psmux o pane herda o ambiente dele, e no tmux ele vira o do
/// servidor quando é ele quem o sobe. A conta vai só pelo `-e`.
pub fn client_command(program: &str) -> tokio::process::Command {
    let mut command = tokio::process::Command::from(crate::terminal_input::child_command(program));
    for var in ["CLAUDE_CONFIG_DIR"].into_iter().chain(NOT_INHERITED).chain(SERVER_SECRETS) { command.env_remove(var); }
    command
}

/// O processo de verdade, sem os segredos do servidor no ambiente do cliente (que vira o do
/// servidor tmux quando é ele quem o sobe).
pub struct ProcessMux { pub timeout: Duration }

impl Default for ProcessMux { fn default() -> Self { Self { timeout: Duration::from_secs(5) } } }

impl Mux for ProcessMux {
    fn scope(&self) -> Vec<String> {
        #[cfg(unix)]
        { crate::runtime::process::scope_prefix().iter().map(|a| a.to_string_lossy().into_owned()).collect() }
        #[cfg(not(unix))]
        { Vec::new() }
    }

    fn run(&self, argv: Vec<String>) -> BoxFuture<'_, MuxOutput> {
        Box::pin(async move {
            let Some((program, args)) = argv.split_first() else { return MuxOutput::default() };
            let mut command = client_command(program);
            command.args(args).stdin(std::process::Stdio::null()).kill_on_drop(true);
            match tokio::time::timeout(self.timeout, command.output()).await {
                Ok(Ok(out)) => MuxOutput { code: out.status.code(), stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
                    stderr: String::from_utf8_lossy(&out.stderr).into_owned() },
                Ok(Err(error)) => MuxOutput { code: None, stdout: String::new(), stderr: error.to_string() },
                Err(_) => MuxOutput { code: None, stdout: String::new(), stderr: "o multiplexador não respondeu no prazo".into() },
            }
        })
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use serde_json::Value;
    use std::sync::Mutex;

    /// Multiplexador falso: responde na ordem as saídas dadas e guarda cada argv.
    #[derive(Default)]
    pub(crate) struct FakeMux { pub scope: Vec<String>, pub replies: Mutex<Vec<MuxOutput>>, pub seen: Mutex<Vec<Vec<String>>> }

    impl FakeMux {
        pub(crate) fn answering(replies: Vec<MuxOutput>) -> Self { Self { replies: Mutex::new(replies), ..Default::default() } }
        pub(crate) fn runs(&self) -> Vec<Vec<String>> { self.seen.lock().unwrap().clone() }
        /// Só os `new-session`: a prova de vida acrescenta consultas.
        pub(crate) fn creations(&self) -> Vec<Vec<String>> { self.runs().into_iter().filter(|run| run.iter().any(|a| a == "new-session")).collect() }
    }

    impl Mux for FakeMux {
        fn scope(&self) -> Vec<String> { self.scope.clone() }
        fn run(&self, argv: Vec<String>) -> BoxFuture<'_, MuxOutput> {
            self.seen.lock().unwrap().push(argv);
            let mut replies = self.replies.lock().unwrap();
            let reply = if replies.is_empty() { ok() } else { replies.remove(0) };
            Box::pin(async move { reply })
        }
    }

    pub(crate) fn ok() -> MuxOutput { MuxOutput { code: Some(0), ..Default::default() } }
    pub(crate) fn failed(stderr: &str) -> MuxOutput { MuxOutput { code: Some(1), stdout: String::new(), stderr: stderr.into() } }

    pub(crate) fn machine() -> TerminalEnv {
        TerminalEnv { windows: false, program: "tmux".into(), wayland: Some("wayland-1".into()), server_config_dir: None,
            default_config_dir: "/r/home/.claude".into(), birth: Duration::from_millis(500) }
    }

    fn fixture(name: &str) -> Value {
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../backend/tests/fixtures/contract/session-open").join(format!("{name}.json"));
        serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap()
    }

    /// O argv que o Python passou ao `new-session` no cenário e o `-e` da sessão (depois de `CP_PROVIDER`
    /// e do `WAYLAND_DISPLAY`, antes da conta).
    fn python_argv(name: &str) -> (Vec<String>, Vec<(String, String)>) {
        let fixture = fixture(name);
        let tmux = fixture["result"]["subprocesses"].as_array().unwrap().iter().find(|p| p["prog"] == "tmux").unwrap();
        let concrete = |a: &str| a.replace("<ROOT>", "/r").replace("<REPO>", "/repo").replace("<uuid:1>", "11111111-1111-4111-8111-111111111111");
        let argv: Vec<String> = tmux["argv"].as_array().unwrap().iter().map(|a| concrete(a.as_str().unwrap())).collect();
        let env: Vec<(String, String)> = argv.windows(2).filter(|w| w[0] == "-e").filter_map(|w| w[1].split_once('='))
            .filter(|(k, _)| !["COLORTERM", "CLAUDE_CODE_TMUX_TRUECOLOR", "KIMI_CODE_TUI_FULL_SCREEN", "CP_SESSION_NAME",
                "CP_PROVIDER", "WAYLAND_DISPLAY", "CLAUDE_CONFIG_DIR"].contains(k))
            .map(|(k, v)| (k.to_owned(), v.to_owned())).collect();
        (argv, env)
    }

    fn claude(env: Vec<(String, String)>, config_dir: Option<&str>) -> PaneSpec {
        PaneSpec { name: "s1".into(), cwd: "/r/work/proj".into(), provider: AgentProvider::Claude, key: "k".repeat(32), env,
            config_dir: config_dir.map(str::to_owned),
            command: ["claude", "--session-id", "11111111-1111-4111-8111-111111111111", "--plugin-dir", "/repo/plugins/hangar", "--plugin-dir",
                "/repo/plugins/github-actions", "--permission-mode", "bypassPermissions"].map(str::to_owned).into() }
    }

    /// O mesmo argv do Python, mais o `CP_SESSION_KEY` (matriz, item 2): conta padrão com `env -u`,
    /// conta escolhida por `-e`.
    #[test]
    fn the_new_session_argv_is_the_python_one_plus_the_session_key() {
        for (fixture, config_dir) in [("create_claude_terminal_default", None), ("create_claude_terminal_account_b", Some("/r/home/.claude-b"))] {
            let (mut python, env) = python_argv(fixture);
            let at = python.iter().position(|a| a == "CP_PROVIDER=claude").unwrap() + 1;
            python.splice(at..at, ["-e".to_owned(), format!("CP_SESSION_KEY={}", "k".repeat(32))]);
            python.insert(0, "tmux".into());
            let mut ours = new_session_argv(&machine(), &claude(env, config_dir));
            let command = ours.pop().unwrap();
            ours.push(undo_not_inherited(&command));
            assert_eq!(ours, python, "{fixture}");
        }
    }

    /// O comando sem o `env -u` do S-63, como o Python o montava.
    pub(crate) fn undo_not_inherited(command: &str) -> String {
        let words: Vec<&str> = command.split(' ').collect();
        let mut out = Vec::new();
        let mut i = 0;
        while i < words.len() {
            if words[i] == "-u" && words.get(i + 1).is_some_and(|var| NOT_INHERITED.contains(var) || SERVER_SECRETS.contains(var)) {
                i += 2;
                continue;
            }
            out.push(words[i]);
            i += 1;
        }
        let out = out.join(" ");
        out.strip_prefix("exec env ").filter(|rest| !rest.starts_with("-u ")).map_or(out.clone(), |rest| format!("exec {rest}"))
    }

    /// Servidor com `CLAUDE_CONFIG_DIR` próprio exporta sempre, até a padrão; no psmux a padrão é a
    /// ausência sem `env -u` (o pane herda de quem chama) e o comando vai sem `exec`, citado à moda dele.
    #[test]
    fn the_account_and_the_dialect_follow_the_multiplexer() {
        let mut env = machine();
        env.server_config_dir = Some("/r/home/.claude".into());
        let argv = new_session_argv(&env, &claude(Vec::new(), None));
        assert!(argv.contains(&"CLAUDE_CONFIG_DIR=/r/home/.claude".to_owned()));
        assert!(undo_not_inherited(argv.last().unwrap()).starts_with("exec claude "), "{argv:?}");
        let windows = TerminalEnv { windows: true, wayland: None, default_config_dir: "C:\\Users\\j\\.claude".into(), ..machine() };
        let mut pane = claude(Vec::new(), Some("C:/Users/j/.claude/"));
        pane.command = vec!["claude".into(), "--settings".into(), "{\"a\":\"it's\"}".into()];
        let argv = new_session_argv(&windows, &pane);
        assert!(!argv.iter().any(|a| a.starts_with("CLAUDE_CONFIG_DIR=")), "a padrão escrita de outro jeito: {argv:?}");
        assert_eq!(argv.last().unwrap(), "claude --settings '{\"a\":\"it''s\"}'");
    }

    /// S-63: nada que o servidor tmux herdou de outra sessão (subagente, Jev, ponte, portão de hooks,
    /// motor, cano) nem segredo do servidor chega ao pane; o que a sessão põe por `-e` fica.
    #[test]
    fn the_pane_does_not_inherit_what_belongs_to_another_session() {
        let pane = claude(vec![("HANGAR_JEV".into(), "on".into()), ("TYPESAFE_API_KEY".into(), "k".into()),
            ("CLAUDE_CODE_SUBAGENT_MODEL".into(), "sonnet".into())], None);
        let command = new_session_argv(&machine(), &pane).pop().unwrap();
        let unset: Vec<&str> = command.split(" -u ").skip(1).map(|rest| rest.split(' ').next().unwrap()).collect();
        for var in ["CLAUDE_CONFIG_DIR", "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS", "HANGAR_PLUGIN_URL", "HANGAR_PLUGIN_TOKEN",
            "JEV_ENDPOINT", "JEV_MODEL", "JEV_AUX_API_KEY", "JEV_TEXTO_CMD", "CP_ENGINE", "CP_ENGINE_SERVICE_TIER",
            "CLAUDE_CODE_MAX_CONTEXT_TOKENS", "HANGAR_CANO_KEY", "CP_PI_SESSION", "CP_AUTH_TOKEN", "HANGAR_INTERNAL_SECRET"] {
            assert!(unset.contains(&var), "{var} não sai: {command}");
        }
        for var in ["HANGAR_JEV", "TYPESAFE_API_KEY", "CLAUDE_CODE_SUBAGENT_MODEL", "CP_SESSION_KEY"] {
            assert!(!unset.contains(&var), "{var} é da sessão: {command}");
        }
        assert!(command.starts_with("exec env -u CLAUDE_CONFIG_DIR -u "), "{command}");
        // No psmux o pane herda de quem chama: o cliente sai sem eles.
        let client = client_command("tmux");
        let removed: Vec<String> = client.as_std().get_envs().filter(|(_, v)| v.is_none())
            .map(|(k, _)| k.to_string_lossy().into_owned()).collect();
        for var in ["CLAUDE_CONFIG_DIR", "CLAUDE_CODE_SUBAGENT_MODEL", "HANGAR_PLUGIN_TOKEN", "TYPESAFE_API_KEY", "CP_AUTH_TOKEN"] {
            assert!(removed.iter().any(|r| r == var), "{var} fica no cliente: {removed:?}");
        }
    }

    #[tokio::test]
    async fn the_scope_wraps_the_command_and_a_refused_scope_runs_once_without_it() {
        let scope: Vec<String> = ["systemd-run", "--user", "--scope", "--collect", "-q", "--"].map(str::to_owned).into();
        let mux = FakeMux { scope: scope.clone(), ..FakeMux::answering(vec![failed("Failed to start transient scope unit: Access denied\n")]) };
        spawn(&mux, &machine(), &claude(Vec::new(), None)).await.unwrap();
        let runs = mux.creations();
        assert_eq!(runs.len(), 2);
        assert_eq!(runs[0][..6], scope[..]);
        assert_eq!(runs[1][0], "tmux", "a segunda vez sem o escopo");
    }

    /// S-31: a recusa passageira do systemd a escopos criados juntos se repete, com espera, até três
    /// vezes, sempre com o escopo; esgotada, é erro com o código dela.
    #[tokio::test(start_paused = true)]
    async fn the_transient_scope_refusal_is_retried_with_the_scope() {
        let scope: Vec<String> = ["systemd-run", "--user", "--scope", "--collect", "-q", "--"].map(str::to_owned).into();
        let missing = || failed("Failed to start transient scope unit: Unit run-p4242.scope not found.\n");
        let mux = FakeMux { scope: scope.clone(), ..FakeMux::answering(vec![missing(), missing()]) };
        spawn(&mux, &machine(), &claude(Vec::new(), None)).await.unwrap();
        assert_eq!(mux.creations().len(), 3);
        assert!(mux.creations().iter().all(|run| run[..6] == scope[..]), "todas com o escopo");
        let mux = FakeMux { scope: scope.clone(), ..FakeMux::answering(vec![missing(), missing(), missing(), missing()]) };
        let error = spawn(&mux, &machine(), &claude(Vec::new(), None)).await.unwrap_err();
        assert_eq!((error.code, mux.creations().len()), ("systemd_scope_unit_missing", 4));
        assert_eq!(error.stderr, "Failed to start transient scope unit: Unit run-p4242.scope not found.");
    }

    /// S-32: sem resposta no prazo (ou o psmux com código diferente de zero), a sessão pode ter nascido;
    /// ela só vale se for esta (a chave dela), e uma de mesmo nome que não é esta é recusa.
    #[tokio::test]
    async fn an_unanswered_new_session_counts_only_when_the_session_is_this_one() {
        let key = format!("CP_SESSION_KEY={}\n", "k".repeat(32));
        let timeout = MuxOutput { code: None, stdout: String::new(), stderr: "o multiplexador não respondeu no prazo".into() };
        let answered = |stdout: &str| MuxOutput { code: Some(0), stdout: stdout.into(), stderr: String::new() };
        let mux = FakeMux::answering(vec![timeout.clone(), ok(), answered(&key)]);
        spawn(&mux, &machine(), &claude(Vec::new(), None)).await.unwrap();
        assert_eq!(mux.runs()[1], ["tmux", "has-session", "-t", "=s1"]);
        assert_eq!(mux.runs()[2], ["tmux", "show-environment", "-t", "=s1", "CP_SESSION_KEY"]);
        let other = FakeMux::answering(vec![failed("duplicate session: s1\n"), ok(), answered("CP_SESSION_KEY=outra\n")]);
        assert_eq!(spawn(&other, &machine(), &claude(Vec::new(), None)).await.unwrap_err().stderr, "duplicate session: s1");
        let gone = FakeMux::answering(vec![timeout, failed("can't find session: s1\n")]);
        assert_eq!(spawn(&gone, &machine(), &claude(Vec::new(), None)).await.unwrap_err().code, "terminal_nao_criado");
    }

    /// S-15: o `new-session` devolve 0 com o comando morto ao nascer (binário ausente, flag que o CLI
    /// recusa); o pane é conferido até o fim da janela de nascimento e a morte é erro com código.
    #[tokio::test(start_paused = true)]
    async fn a_pane_that_dies_at_birth_is_an_error() {
        let mux = FakeMux::answering(vec![ok(), ok(), failed("can't find session: s1\n")]);
        let error = spawn(&mux, &machine(), &claude(Vec::new(), None)).await.unwrap_err();
        assert_eq!(error, SpawnError { code: "terminal_morreu_ao_nascer", stderr: "can't find session: s1".into() });
        let alive = FakeMux::answering(Vec::new());
        spawn(&alive, &machine(), &claude(Vec::new(), None)).await.unwrap();
        let polls = alive.runs().iter().filter(|run| run[1] == "has-session").count();
        assert_eq!(polls, 5, "conferido a cada 100 ms durante a janela");
    }

    /// S-55: todo pane nasce com o provedor dele em `CP_PROVIDER` (o `/resume` do Python o deixava
    /// vazio); o tipo não tem o vazio, e o `-e` vem antes de qualquer outro da sessão.
    #[test]
    fn every_pane_carries_its_provider() {
        for provider in AgentProvider::ALL {
            let argv = new_session_argv(&machine(), &PaneSpec { provider, ..claude(Vec::new(), None) });
            let at = argv.iter().position(|a| a == &format!("CP_PROVIDER={}", provider.name())).unwrap();
            assert_eq!((argv[at - 1].as_str(), argv[at - 2].as_str()), ("-e", "CP_SESSION_NAME=s1"));
        }
    }

    #[tokio::test]
    async fn a_refusal_is_an_error_with_the_stderr_tail() {
        let mux = FakeMux::answering(vec![failed("aviso\nduplicate session: s1\n\n")]);
        let error = spawn(&mux, &machine(), &claude(Vec::new(), None)).await.unwrap_err();
        assert_eq!(error, SpawnError { code: "terminal_nao_criado", stderr: "duplicate session: s1".into() });
    }
}
