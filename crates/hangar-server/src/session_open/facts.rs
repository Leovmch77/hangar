//! Os fatos do `resolve_open()` lidos da máquina: os mesmos arquivos que o servidor lê, por isso o
//! comando de terminal resolve igual com o servidor fora do ar. Bloqueante: o servidor chama por
//! `spawn_blocking`; as partes assíncronas (contas, catálogo do Codex, tmux) rodam no `runtime`.
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};

use regex::Regex;
use serde_json::Value;

use super::resolve::{CodexCatalogError, CodexLogin, CreatorFacts, OpenFacts, ProviderCatalog, ServerDefaults};
use super::{AgentProvider, OpenError, ServiceTier};
use crate::accounts::catalog::AccountError;
use crate::accounts::environment::AccountEnvironment;
use crate::accounts::{AccountService, Provider};
use crate::list::procs::{ProcessView, SystemProcs};

/// `engines._NOME_OK`: o nome entra num `$SHELL -c`.
static ENGINE_NAME: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\A[a-z0-9][a-z0-9_-]{0,31}\z").unwrap());
static GPT_MODEL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\Agpt-\d[^/]*\z").unwrap());

pub struct LocalFacts {
    accounts: AccountService,
    runtime: tokio::runtime::Handle,
    models: crate::dictation::catalog::Models,
    slots: tokio::sync::Semaphore,
    mux: crate::list::mux::Mux,
    procs: std::sync::Arc<dyn ProcessView>,
}

impl LocalFacts {
    pub fn new(env: AccountEnvironment, runtime: tokio::runtime::Handle) -> Self {
        Self { accounts: AccountService::new(env), runtime, models: Default::default(), slots: tokio::sync::Semaphore::new(4),
            mux: Default::default(), procs: std::sync::Arc::new(SystemProcs::default()) }
    }

    /// Só para teste: multiplexador e `/proc` de mentira, para nunca ler o tmux de quem roda o teste.
    #[doc(hidden)]
    pub fn with_terminal(mut self, mux: crate::list::mux::Mux, procs: std::sync::Arc<dyn ProcessView>) -> Self {
        self.mux = mux;
        self.procs = procs;
        self
    }

    fn env(&self) -> &AccountEnvironment { &self.accounts.env }

    fn hangar(&self) -> PathBuf { self.env().home.join(".hangar") }

    fn headless_sidecar(&self, name: &str) -> PathBuf {
        self.hangar().join("claude-headless").join(format!("{}.json", crate::list::discover_other::sanitize_session_name(name)))
    }

    fn codex_sidecar(&self, name: &str) -> PathBuf {
        crate::runtime::codex_sidecar::path(&crate::runtime::codex_sidecar::dir(&self.env().home), name)
    }

    fn panes(&self) -> Vec<crate::list::mux::Pane> {
        // Multiplexador fora é "sem sessão de terminal", como o `has_session` do Python.
        self.runtime.block_on(self.mux.list_panes()).unwrap_or_default()
    }

    fn engines_file(&self) -> Value {
        let path = self.env().base.get("CP_ENGINES_FILE").filter(|p| !p.is_empty()).map(PathBuf::from)
            .unwrap_or_else(|| self.env().home.join(".claude").join("engines.json"));
        // Ausente ou quebrado lista vazio, como o `engines.listar`: motor nenhum, nunca o de outro.
        read_json(&path).ok().flatten().filter(Value::is_object).unwrap_or(Value::Null)
    }

    fn terminal_creator(&self, name: &str) -> Option<CreatorFacts> {
        let panes = self.panes();
        let pane = panes.iter().find(|p| p.session == name && !p.hidden)?;
        let provider = pane.provider.as_deref().and_then(AgentProvider::parse).unwrap_or(AgentProvider::Claude);
        let procs = &*self.procs;
        let pid = pane.pid.filter(|pid| *pid != 0).map(i64::from);
        // `_caller_config_dir`: pane sem pid ou ambiente ilegível não confirmam a conta.
        let config_dir = match pid.map(|pid| procs.env_var(pid, "CLAUDE_CONFIG_DIR")) {
            Some(Ok(value)) => Ok(value.map(|v| v.to_string_lossy().into_owned()).filter(|v| !v.is_empty())),
            _ => Err(()),
        };
        let account = config_dir.clone().ok().flatten().map(PathBuf::from).unwrap_or_else(|| self.env().claude_base.clone());
        let transcript = procs.children(std::time::Duration::ZERO).ok().and_then(|children| {
            crate::list::discover::resolve_one(&panes, procs, &children, &account.join("projects"),
                &mut Default::default(), name, &pane.cwd, pid).jsonl
        });
        let cache = Mutex::new(crate::list::capped::Capped::new(1));
        let permission_mode = transcript.and_then(|jsonl| crate::terminal_facts::transcript_mode(Path::new(&jsonl), &cache).ok().flatten());
        Some(CreatorFacts { provider, headless: false, config_dir, permission_mode, codex_account: None })
    }
}

/// `Ok(None)` = arquivo ausente; `Err` = existe e não se lê como JSON.
fn read_json(path: &Path) -> Result<Option<Value>, String> {
    match crate::runtime::queue::read_replaced(path) {
        Ok(bytes) => serde_json::from_slice(&bytes).map(Some).map_err(|e| format!("{}: {e}", path.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("{}: {e}", path.display())),
    }
}

fn text(value: &Value) -> Option<String> { value.as_str().filter(|s| !s.is_empty()).map(str::to_owned) }

/// `bool(x)` do Python sobre um valor do `runtime-config.json`.
fn truthy(value: &Value) -> Option<bool> {
    match value {
        Value::Null => None,
        Value::Bool(b) => Some(*b),
        Value::Number(n) => Some(n.as_f64() != Some(0.0)),
        Value::String(s) => Some(!s.is_empty()),
        Value::Array(a) => Some(!a.is_empty()),
        Value::Object(o) => Some(!o.is_empty()),
    }
}

/// Booleano do pydantic-settings (`CP_HEADLESS_DEFAULT`, `CP_JEV_PADRAO`).
fn env_bool(env: &BTreeMap<String, String>, name: &str) -> Option<bool> {
    match env.get(name)?.trim().to_ascii_lowercase().as_str() {
        "1" | "true" | "t" | "yes" | "y" | "on" => Some(true),
        "0" | "false" | "f" | "no" | "n" | "off" => Some(false),
        _ => None,
    }
}

fn expand_home(path: &str, home: &Path) -> PathBuf {
    match path.strip_prefix('~') {
        Some("") => home.to_owned(),
        Some(rest) if rest.starts_with('/') || rest.starts_with('\\') => home.join(&rest[1..]),
        _ => PathBuf::from(path),
    }
}

fn codex_error(error: AccountError) -> OpenError {
    OpenError::new(error.status, error.code, "conta Codex inválida").with_params(error.params)
}

/// `cliproxy.local()`: endereço do CLIProxyAPI desta máquina; `None` sem config utilizável.
fn cliproxy_base(home: &Path) -> Option<String> {
    let text = std::fs::read_to_string(home.join(".cli-proxy-api").join("config.yaml")).ok()?;
    let config: Value = serde_saphyr::from_str(&text).ok()?;
    let keys = config["api-keys"].as_array()?;
    keys.iter().filter_map(Value::as_str).any(|k| !k.trim().is_empty()).then_some(())?;
    let mut host = config["host"].as_str().unwrap_or("").trim().to_owned();
    if matches!(host.as_str(), "" | "0.0.0.0" | "::") { host = "127.0.0.1".into(); }
    if host.contains(':') && !host.starts_with('[') { host = format!("[{host}]"); }
    let port = match &config["port"] {
        Value::Null => 8317,
        value => value.as_u64().or_else(|| value.as_str()?.trim().parse().ok())?,
    };
    (1..65536).contains(&port).then_some(())?;
    let scheme = if config["tls"]["enable"] == true { "https" } else { "http" };
    Some(format!("{scheme}://{host}:{port}"))
}

fn normalize_base(url: &str) -> String {
    let url = url.trim().trim_end_matches('/');
    url.strip_suffix("/v1").map_or(url, |u| u.trim_end_matches('/')).to_owned()
}

impl OpenFacts for LocalFacts {
    fn providers(&self) -> ProviderCatalog {
        let path: Vec<(String, String)> = self.env().base.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
        let available: Vec<AgentProvider> = AgentProvider::ALL.into_iter()
            .filter(|p| crate::runtime::process::resolve_program(p.name(), &path).is_some()).collect();
        // ponytail: login Claude pela credencial em disco e Codex pela leitura rápida da conta; o
        // Python também pergunta o `loggedIn` do CLI. Trocar quando a rota do Rust criar sessão.
        let mut connected = Vec::new();
        let claude_logged = self.config_dirs().unwrap_or_default().iter().any(|dir| Path::new(dir).join(".credentials.json").is_file());
        if available.contains(&AgentProvider::Claude) && (claude_logged || self.engines_file().as_object().is_some_and(|e| !e.is_empty())) {
            connected.push(AgentProvider::Claude);
        }
        if available.contains(&AgentProvider::Codex) && !self.codex_logins().is_empty() {
            connected.push(AgentProvider::Codex);
        }
        let runtime = crate::runtime::codex_launch::runtime_config(self.env());
        ProviderCatalog { available, connected, disconnected: Vec::new(), remembered: text(&runtime["last_session_provider"]) }
    }

    fn creator(&self, name: &str) -> Result<Option<CreatorFacts>, OpenError> {
        // Registro existente e ilegível não é "criadora não encontrada": herdar nada calado erraria conta e modo.
        let read = |path: &Path| crate::runtime::codex_sidecar::read(path).map_err(|_| OpenError::new(409, "erro_criadora_ilegivel",
            format!("não consegui ler o registro da sessão criadora '{name}'; escolha a conta e o modo")));
        if let Some(meta) = read(&self.headless_sidecar(name))?.map(Value::Object) {
            let mut mode = text(&meta["permission_mode"]);
            if mode.as_deref() == Some("plan") { mode = text(&meta["previous_non_plan"]); }
            return Ok(Some(CreatorFacts { provider: AgentProvider::Claude, headless: true, config_dir: Ok(text(&meta["config_dir"])),
                permission_mode: mode, codex_account: None }));
        }
        if let Some(meta) = read(&self.codex_sidecar(name))? {
            return Ok(Some(CreatorFacts { provider: AgentProvider::Codex, headless: meta.get("headless") == Some(&Value::Bool(true)),
                config_dir: Ok(None), permission_mode: meta.get("permission_mode").and_then(text),
                codex_account: meta.get("codex_account").and_then(text) }));
        }
        Ok(self.terminal_creator(name))
    }

    fn defaults(&self) -> ServerDefaults {
        let runtime = crate::runtime::codex_launch::runtime_config(self.env());
        let field = |name: &str, env: &str, default: bool| truthy(&runtime[name]).or_else(|| env_bool(&self.env().base, env)).unwrap_or(default);
        ServerDefaults { headless: field("headless_default", "CP_HEADLESS_DEFAULT", true), jev: field("jev_padrao", "CP_JEV_PADRAO", false) }
    }

    fn codex_logins(&self) -> Vec<CodexLogin> {
        let accounts = self.accounts.visible_codex_accounts().unwrap_or_default();
        accounts.into_iter()
            .filter(|account| self.runtime.block_on(self.accounts.read_codex_auth_fast(account))["status"] == "connected")
            .map(|account| CodexLogin { id: account.id, is_default: account.is_default })
            .collect()
    }

    fn claude_quotas(&self) -> Vec<Value> {
        // Sem leitura, nada muda: a conta fica como estava (como o Python sem o Rust).
        let rows = self.runtime.block_on(self.accounts.quotas(None, false, true)).unwrap_or(Value::Null);
        rows.as_array().into_iter().flatten().filter(|row| row["provedor"] == "claude").cloned().collect()
    }

    fn existing_dir(&self, cwd: &str) -> Option<String> {
        let path = expand_home(cwd, &self.env().home);
        path.is_dir().then(|| path.to_string_lossy().into_owned())
    }

    fn config_dirs(&self) -> Result<Vec<String>, OpenError> {
        let catalog = self.accounts.claude_catalog()
            .map_err(|e| OpenError::new(e.status, e.code, e.message))?;
        Ok(catalog.as_array().into_iter().flatten().filter_map(|row| text(&row["path"])).collect())
    }

    fn engines(&self) -> Vec<String> {
        self.engines_file().as_object().into_iter().flatten().map(|(name, _)| name.clone())
            .filter(|name| ENGINE_NAME.is_match(name)).collect()
    }

    fn supports_fast(&self, engine: Option<&str>, model: Option<&str>) -> bool {
        let engines = self.engines_file();
        let Some(cfg) = engine.filter(|e| self.engines().iter().any(|n| n == e)).map(|e| &engines[e]) else { return false };
        // `model or cfg.model`: texto vazio também cai no modelo do motor.
        let base = model.filter(|m| !m.is_empty()).or_else(|| cfg["model"].as_str()).unwrap_or("").rsplit('/').next().unwrap_or("");
        GPT_MODEL.is_match(base)
            && cliproxy_base(&self.env().home).is_some_and(|local| normalize_base(cfg["base_url"].as_str().unwrap_or("")) == local)
    }

    fn fixed_engine_model(&self, _engine: &str, _account: &str, _model: Option<&str>) -> Result<String, OpenError> {
        // ponytail: a conta ChatGPT fixa (`cliproxy_accounts`) ainda é só do Python; recusa visível
        // até a Task do Claude com motor portar `_fixed_engine_account`.
        Err(OpenError::new(503, "session_open_fact_unavailable", "a conta ChatGPT fixa do motor ainda não é conferida pelo Rust"))
    }

    fn engine_window(&self, _engine: &str, _model: &str, _account: Option<&str>) -> Option<u64> {
        // ponytail: o catálogo do motor (`_engine_models`) ainda é do Python; sem ele a sessão sobe
        // sem a janela, como o Python faz com o provedor fora do ar.
        None
    }

    fn codex_home(&self, account_id: &str) -> Result<String, OpenError> {
        let account = self.accounts.resolve(Provider::Codex, account_id).map_err(codex_error)?;
        Ok(std::path::absolute(&account.home).unwrap_or(account.home).to_string_lossy().into_owned())
    }

    fn codex_choice(&self, home: Option<&str>, model: Option<&str>, effort: Option<&str>, tier: Option<ServiceTier>)
        -> Result<(), CodexCatalogError> {
        let models = match model {
            None => Vec::new(),
            Some(_) => {
                let home = home.map(PathBuf::from).unwrap_or_else(|| self.env().codex_default.clone());
                match self.runtime.block_on(self.models.get(&self.accounts, &self.slots, "codex", &home, false)) {
                    Ok((models, _)) => models,
                    Err(code) => {
                        let detail = format!("Não foi possível consultar o catálogo da conta selecionada ({code}).");
                        return Err(if code == "dictation_catalog_refused" { CodexCatalogError::Refused(detail) } else { CodexCatalogError::Unavailable(detail) });
                    }
                }
            }
        };
        crate::dictation::catalog::validate(&models, model, effort, tier.map(ServiceTier::name)).map_err(CodexCatalogError::Invalid)
    }

    fn account_mode(&self, config_dir: Option<&str>) -> Result<Option<String>, String> {
        // A conta padrão é a do servidor (`CLAUDE_CONFIG_DIR`), não `~/.claude` fixo (S-07).
        let dir = config_dir.map_or_else(|| self.env().claude_base.clone(), |dir| expand_home(dir, &self.env().home));
        Ok(read_json(&dir.join("settings.json"))?.and_then(|settings| text(&settings["permissions"]["defaultMode"])))
    }

    fn name_in_use(&self, name: &str) -> bool {
        self.headless_sidecar(name).exists() || self.codex_sidecar(name).exists() || self.panes().iter().any(|p| p.session == name)
    }

    /// `transfer_active`: registro do índice da sessão com o mesmo nome e fase não terminal.
    // ponytail: sem o `_belongs` do Python (vida da sessão); para um nome que nasce agora a vida
    // antiga não existe e o registro em curso é dele. Portar junto quando a troca vier ao Rust.
    fn transfer_busy(&self, name: &str) -> Result<bool, OpenError> {
        let base = self.hangar().join("conversation-transfers");
        let digest: String = ring::digest::digest(&ring::digest::SHA256, name.as_bytes()).as_ref().iter().map(|b| format!("{b:02x}")).collect();
        let invalid = || OpenError::new(409, "erro_criacao_sessao", "índice de transferência inválido");
        let ids = match read_json(&base.join("indexes").join(format!("session-{digest}.json"))) {
            Ok(None) => return Ok(false),
            Ok(Some(Value::Array(ids))) => ids,
            _ => return Err(invalid()),
        };
        Ok(ids.iter().filter_map(Value::as_str).filter(|id| id.len() == 36 && id.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-'))
            .filter_map(|id| read_json(&base.join(format!("{id}.json"))).ok().flatten())
            .any(|record| record["name"] == name && !matches!(record["phase"].as_str(), Some("complete" | "rejected" | "rolled_back"))))
    }

    /// Cada parte que existe é resolvida (link incluído); `..` depois do que não existe é lexical.
    fn real_path(&self, path: &str) -> PathBuf {
        let path = expand_home(path, &self.env().home);
        let path = std::path::absolute(&path).unwrap_or(path);
        let mut out = PathBuf::new();
        for part in path.components() {
            match part {
                std::path::Component::ParentDir => { out.pop(); }
                std::path::Component::CurDir => {}
                part => {
                    out.push(part);
                    if let Ok(real) = out.canonicalize() { out = real; }
                }
            }
        }
        out
    }

    fn new_key(&self) -> String { crate::mods::state::random_hex(16) }

    fn now(&self) -> f64 { crate::accounts::quotas::now() }
}
