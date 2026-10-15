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
        Self { windows: cfg!(windows), program: "tmux".into(), wayland, server_config_dir: var("CLAUDE_CONFIG_DIR"),
            default_config_dir: home.join(".claude") }
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
    // no meio, e `exec` mataria o pane ao nascer.
    argv.push(match (env.windows, exported.is_some()) {
        (true, _) => command,
        (false, true) => format!("exec {command}"),
        // O pane herda o ambiente do servidor tmux, de quem o subiu: a conta padrão é a ausência.
        (false, false) => format!("exec env -u CLAUDE_CONFIG_DIR {command}"),
    });
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
    let mut output = mux.run(scoped).await;
    if !scope.is_empty() && !output.ok() && output.stderr.trim_start().starts_with("Failed to ") {
        tracing::warn!(code = "systemd_scope_refused", cause = %tail(&output.stderr), "escopo do systemd recusado; o terminal sobe sem ele");
        output = mux.run(argv).await;
    }
    if output.ok() { Ok(()) } else { Err(SpawnError { code: "terminal_nao_criado", stderr: tail(&output.stderr) }) }
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
            let mut command = tokio::process::Command::from(crate::terminal_input::child_command(program));
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
            default_config_dir: "/r/home/.claude".into() }
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
            assert_eq!(new_session_argv(&machine(), &claude(env, config_dir)), python, "{fixture}");
        }
    }

    /// Servidor com `CLAUDE_CONFIG_DIR` próprio exporta sempre, até a padrão; no psmux a padrão é a
    /// ausência sem `env -u` (o pane herda de quem chama) e o comando vai sem `exec`, citado à moda dele.
    #[test]
    fn the_account_and_the_dialect_follow_the_multiplexer() {
        let mut env = machine();
        env.server_config_dir = Some("/r/home/.claude".into());
        let argv = new_session_argv(&env, &claude(Vec::new(), None));
        assert!(argv.contains(&"CLAUDE_CONFIG_DIR=/r/home/.claude".to_owned()));
        assert!(argv.last().unwrap().starts_with("exec claude "), "{argv:?}");
        let windows = TerminalEnv { windows: true, wayland: None, default_config_dir: "C:\\Users\\j\\.claude".into(), ..machine() };
        let mut pane = claude(Vec::new(), Some("C:/Users/j/.claude/"));
        pane.command = vec!["claude".into(), "--settings".into(), "{\"a\":\"it's\"}".into()];
        let argv = new_session_argv(&windows, &pane);
        assert!(!argv.iter().any(|a| a.starts_with("CLAUDE_CONFIG_DIR=")), "a padrão escrita de outro jeito: {argv:?}");
        assert_eq!(argv.last().unwrap(), "claude --settings '{\"a\":\"it''s\"}'");
    }

    #[tokio::test]
    async fn the_scope_wraps_the_command_and_a_refused_scope_runs_once_without_it() {
        let scope: Vec<String> = ["systemd-run", "--user", "--scope", "--collect", "-q", "--"].map(str::to_owned).into();
        let mux = FakeMux { scope: scope.clone(), ..FakeMux::answering(vec![failed("Failed to start transient scope unit: Access denied\n")]) };
        spawn(&mux, &machine(), &claude(Vec::new(), None)).await.unwrap();
        let runs = mux.runs();
        assert_eq!(runs.len(), 2);
        assert_eq!(runs[0][..6], scope[..]);
        assert_eq!(runs[1][0], "tmux", "a segunda vez sem o escopo");
    }

    #[tokio::test]
    async fn a_refusal_is_an_error_with_the_stderr_tail() {
        let mux = FakeMux::answering(vec![failed("aviso\nduplicate session: s1\n\n")]);
        let error = spawn(&mux, &machine(), &claude(Vec::new(), None)).await.unwrap_err();
        assert_eq!(error, SpawnError { code: "terminal_nao_criado", stderr: "duplicate session: s1".into() });
    }
}
