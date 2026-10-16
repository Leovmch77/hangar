//! O esperado vem das fixtures do Python (`backend/tests/fixtures/contract/session-open/`), nunca
//! da saída do Rust; as diferenças dos consertos (D-001, D-011) estão nomeadas onde aparecem.
use super::*;
use proptest::prelude::*;
use regex::Regex;
use std::path::PathBuf;

fn fixture_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../backend/tests/fixtures/contract/session-open")
}

/// `(nome, fixture)` de cada cenário de criação, em ordem.
fn create_fixtures() -> Vec<(String, Value)> {
    let mut out: Vec<(String, Value)> = std::fs::read_dir(fixture_dir()).unwrap().flatten()
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().strip_suffix(".json")?.to_owned();
            name.starts_with("create_").then(|| (name, serde_json::from_slice(&std::fs::read(entry.path()).unwrap()).unwrap()))
        })
        .collect();
    out.sort_by(|a, b| a.0.cmp(&b.0));
    assert_eq!(out.len(), 81, "as 81 fixtures de criação da Task 1");
    out
}

fn request_body(fixture: &Value) -> Vec<u8> { serde_json::to_vec(&fixture["scenario"]["steps"][0]["json"]).unwrap() }

fn python_status(fixture: &Value) -> u64 { fixture["result"]["steps"][0]["status"].as_u64().unwrap() }

#[test]
fn the_bodies_python_refused_as_shape_are_refused_with_a_code() {
    for (name, fixture) in create_fixtures() {
        let parsed = SessionOpenRequest::parse(&request_body(&fixture));
        // Pydantic recusa a forma com 422 e a lista de erros; o Rust, com `erro_corpo_invalido`.
        let python_refused_shape = python_status(&fixture) == 422 && fixture["result"]["steps"][0]["body"]["detail"].is_array();
        // D-001: `inherit` é campo novo; o Python de 601bc62a0 ainda o recusava.
        let expected_refused = python_refused_shape && name != "create_inherit_flag_not_supported";
        match parsed {
            Err(error) => {
                assert!(expected_refused, "{name}: o Python aceitou o corpo e o Rust recusou: {error}");
                assert_eq!((error.status, error.code), (422, Some("erro_corpo_invalido")), "{name}");
            }
            Ok(_) => assert!(!expected_refused, "{name}: o Python recusou o corpo e o Rust aceitou"),
        }
    }
}

#[test]
fn omitted_and_null_are_different_cases() {
    let parse = |body: &str| SessionOpenRequest::parse(body.as_bytes());
    let request = parse(r#"{"name":"s","cwd":"/x"}"#).unwrap();
    assert_eq!((request.provider, request.headless, request.jev, request.new_branch), (None, None, None, false));
    // `provider: str = "claude"`: `null` não é ausência.
    assert!(parse(r#"{"name":"s","cwd":"/x","provider":null}"#).is_err());
    assert!(parse(r#"{"name":"s","cwd":"/x","new_branch":null}"#).is_err());
    assert!(parse(r#"{"name":"s","cwd":"/x","read_only":null}"#).is_err());
    let request = parse(r#"{"name":"s","cwd":"/x","jev":null,"headless":null,"config_dir":null,"inherit":false}"#).unwrap();
    assert_eq!((request.jev, request.headless, request.config_dir, request.inherit), (None, None, None, Some(false)));
    // StrictBool: nem 1 nem "true".
    assert!(parse(r#"{"name":"s","cwd":"/x","jev":1}"#).is_err());
    assert!(parse(r#"{"name":"s","cwd":"/x","name":1}"#).is_err());
    // `min_length=1`: vazio cai, espaço passa.
    assert!(parse(r#"{"name":"s","cwd":"/x","creator":""}"#).is_err());
    assert!(parse(r#"{"name":" ","cwd":"/x"}"#).is_ok());
    assert!(parse(r#"{"name":"s"}"#).is_err());
    // Chave repetida: vale a última, como o `json.loads`.
    assert_eq!(parse(r#"{"name":"a","cwd":"/x","name":"b"}"#).unwrap().name, "b");
}

#[test]
fn customizations_only_take_plugins_skills_and_blocked_skills() {
    let parse = |c: &str| SessionOpenRequest::parse(format!(r#"{{"name":"s","cwd":"/x","claude_customizations":{c}}}"#).as_bytes());
    let request = parse(r#"{"plugins":{"b@l":false,"a@l":true}}"#).unwrap();
    let selection = request.claude_customizations.unwrap();
    assert_eq!(selection.plugins.keys().collect::<Vec<_>>(), ["b@l", "a@l"], "ordem do pedido");
    assert!(selection.skills.is_empty() && selection.blocked_skills.is_empty());
    assert!(parse(r#"{"env":{"X":"1"}}"#).is_err());
    assert!(parse(r#"{"plugins":{"a":"true"}}"#).is_err());
    assert!(parse(r#"{"plugins":null}"#).is_err());
}

#[test]
fn the_request_serializes_back_without_the_defaults() {
    let body = r#"{"name":"s","cwd":"/x","provider":"pi","jev":false,"inherit":false}"#;
    let request = SessionOpenRequest::parse(body.as_bytes()).unwrap();
    assert_eq!(serde_json::to_value(&request).unwrap(), serde_json::from_str::<Value>(body).unwrap());
}

#[test]
fn modes_and_providers_round_trip_by_name() {
    for provider in AgentProvider::ALL { assert_eq!(AgentProvider::parse(provider.name()), Some(provider)); }
    assert_eq!(AgentProvider::parse("gemini"), None);
    for mode in PermissionMode::CLAUDE { assert_eq!(PermissionMode::claude(mode.name()), Some(mode)); }
    assert_eq!(PermissionMode::claude("default"), None);
    assert_eq!(PermissionMode::codex(" ask FOR approval "), Some(PermissionMode::AskForApproval));
    assert_eq!(PermissionMode::codex("Tudo"), None);
    assert_eq!(serde_json::to_value(PermissionMode::FullAccess).unwrap(), "Full Access");
}

#[test]
fn reopen_keeps_what_the_change_does_not_name() {
    let spec = SessionSpec {
        version: SPEC_VERSION, key: "k".into(), name: "s".into(), cwd: "/x".into(), provider: AgentProvider::Claude,
        surface: Surface::Terminal, account: Account::Default, account_source: AccountSource::Default,
        model: Some("opus".into()), effort: Some("high".into()), service_tier: None,
        permission_mode: Some(PermissionMode::Manual), subagent_model: None, customizations: None, jev: true,
        read_only: false, worktree: None, creator: None, created_at: 1.0,
    };
    let change = SessionChange { reason: ChangeReason::Bypass, surface: None, account: None,
        permission_mode: Some(PermissionMode::BypassPermissions), model: None, effort: None, service_tier: None };
    let next = spec.with(&change);
    assert_eq!(next.permission_mode, Some(PermissionMode::BypassPermissions));
    assert_eq!((next.model.as_deref(), next.effort.as_deref(), next.jev), (Some("opus"), Some("high"), true));
}

// ── resolve_open ─────────────────────────────────────────────────────────────────────────────

/// Os fatos do cenário: o estado inicial (`state`) e as respostas das bordas (`fakes`) que o
/// harness deu ao Python (`session_open_contract.py`), lidos do mesmo jeito que o Python os lê.
struct FixtureFacts {
    files: serde_json::Map<String, Value>, dirs: Vec<String>, tmux: Vec<Value>, fakes: Value,
    /// Desvios que o teste pede e o cenário não tem: settings ilegível, contas Codex conectadas,
    /// troca de agente em curso e o catálogo do motor (o harness recusa a rede: `Err`).
    broken_mode: bool, connected: Vec<resolve::CodexLogin>, busy: bool, window: Result<Option<u64>, ()>,
}

/// A ponte do ditado com o Rust fora, como o harness a responde (`session_open_contract.py:941`).
const HARNESS_BRIDGE_DOWN: &str = "O servidor Rust de organização está indisponível.";
const HOME: &str = "<ROOT>/home";
const OWNER: resolve::OpenCaller = resolve::OpenCaller::Owner;

impl FixtureFacts {
    fn of(fixture: &Value) -> Self {
        let state = &fixture["scenario"]["state"];
        Self {
            files: state["files"].as_object().cloned().unwrap_or_default(),
            dirs: state["dirs"].as_array().into_iter().flatten().filter_map(Value::as_str).map(str::to_owned).collect(),
            tmux: state["tmux_sessions"].as_array().cloned().unwrap_or_default(),
            fakes: fixture["scenario"]["fakes"].clone(),
            broken_mode: false,
            connected: Vec::new(),
            busy: false,
            window: Err(()),
        }
    }

    fn file(&self, path: &str) -> Option<&Value> { self.files.get(path) }

    fn sidecar(&self, kind: &str, name: &str) -> Option<&Value> { self.file(&format!("{HOME}/.hangar/{kind}/{name}.json")) }

    fn runtime(&self) -> Value { self.file(&format!("{HOME}/.claude/runtime-config.json")).cloned().unwrap_or(Value::Null) }

    /// Último modo fora de `plan` gravado no transcript da sessão `sid`.
    fn transcript_mode(&self, sid: &str) -> Option<String> {
        let (_, text) = self.files.iter().find(|(path, _)| path.ends_with(&format!("/{sid}.jsonl")))?;
        text.as_str()?.lines().rev().filter_map(|line| serde_json::from_str::<Value>(line).ok())
            .find_map(|event| event["permissionMode"].as_str().filter(|m| *m != "plan").map(str::to_owned))
    }

    fn bridge(&self, op: &str) -> Option<&Value> { self.fakes["rust_bridge"].get(format!("dictation.{op}")) }

    fn find_creator(&self, name: &str) -> Option<resolve::CreatorFacts> {
        if let Some(meta) = self.sidecar("claude-headless", name) {
            let mut mode = meta["permission_mode"].as_str().map(str::to_owned);
            if mode.as_deref() == Some("plan") { mode = meta["previous_non_plan"].as_str().map(str::to_owned); }
            let mode = mode.or_else(|| self.transcript_mode(meta["session_id"].as_str()?));
            return Some(resolve::CreatorFacts { provider: AgentProvider::Claude, headless: true,
                config_dir: Ok(meta["config_dir"].as_str().map(str::to_owned)), permission_mode: mode, codex_account: None });
        }
        if let Some(meta) = self.sidecar("codex-sessions", name) {
            return Some(resolve::CreatorFacts { provider: AgentProvider::Codex, headless: meta["headless"] == true,
                config_dir: Ok(None), permission_mode: meta["permission_mode"].as_str().map(str::to_owned),
                codex_account: meta["codex_account"].as_str().map(str::to_owned) });
        }
        let pane = self.tmux.iter().find(|s| s["name"] == name)?;
        let env = &pane["env"];
        let sid = pane["command"].as_str()?.split("--session-id ").nth(1)?.split_whitespace().next()?;
        Some(resolve::CreatorFacts {
            provider: env["CP_PROVIDER"].as_str().and_then(AgentProvider::parse).unwrap_or(AgentProvider::Claude),
            headless: false,
            config_dir: if pane["environ_unreadable"] == true { Err(()) } else { Ok(env["CLAUDE_CONFIG_DIR"].as_str().map(str::to_owned)) },
            permission_mode: self.transcript_mode(sid), codex_account: None,
        })
    }
}

impl resolve::OpenFacts for FixtureFacts {
    /// O harness põe os cinco binários no PATH; sem o Rust o login Claude é ilegível e sem o serviço
    /// de contas não há estado do Codex.
    fn providers(&self) -> Result<resolve::ProviderCatalog, OpenError> {
        let logins = vec![None; self.config_dirs()?.len()];
        Ok(facts::provider_catalog(AgentProvider::ALL.to_vec(), &logins, !self.engines().is_empty(), &[],
            self.runtime()["last_session_provider"].as_str().map(str::to_owned)))
    }

    fn creator(&self, name: &str) -> Result<Option<resolve::CreatorFacts>, OpenError> { Ok(self.find_creator(name)) }

    fn defaults(&self) -> resolve::ServerDefaults {
        let runtime = self.runtime();
        resolve::ServerDefaults { headless: runtime["headless_default"].as_bool().unwrap_or(true), jev: runtime["jev_padrao"].as_bool().unwrap_or(false) }
    }

    // Sem serviço de contas Codex no harness: nenhuma conta conectada.
    fn codex_logins(&self) -> Result<Vec<resolve::CodexLogin>, OpenError> { Ok(self.connected.clone()) }

    fn claude_quotas(&self) -> Vec<Value> {
        self.fakes["quotas"].as_array().into_iter().flatten().filter(|row| row["provedor"] == "claude").cloned().collect()
    }

    fn existing_dir(&self, cwd: &str) -> Option<String> {
        let prefix = format!("{cwd}/");
        let repos = self.files.keys().chain(self.dirs.iter()).any(|p| p == cwd || p.starts_with(&prefix));
        let git = cwd == "<ROOT>/home/pessoal/repo";
        (repos || git).then(|| cwd.to_owned())
    }

    /// `list_config_dirs`: `~/.claude*` com login ou marca do Hangar e `projects/`, mais a base.
    fn config_dirs(&self) -> Result<Vec<String>, OpenError> {
        let mut out = vec![format!("{HOME}/.claude")];
        for dir in &self.dirs {
            let Some(account) = dir.strip_suffix("/projects").filter(|d| d.starts_with(&format!("{HOME}/.claude"))) else { continue };
            let login = self.file(&format!("{account}/.credentials.json")).is_some() || self.file(&format!("{account}/.hangar-conta")).is_some();
            if login && !out.iter().any(|known| known == account) { out.push(account.to_owned()); }
        }
        Ok(out)
    }

    fn engines(&self) -> Vec<String> {
        self.file(&format!("{HOME}/.claude/engines.json")).and_then(Value::as_object).map(|e| e.keys().cloned().collect()).unwrap_or_default()
    }

    fn supports_fast(&self, _engine: Option<&str>, _model: Option<&str>) -> bool { false }

    // Nenhum cenário fixa conta ChatGPT; o gerador do proptest pode pedir.
    fn fixed_engine_model(&self, _engine: &str, _account: &str, _model: Option<&str>) -> Result<String, OpenError> {
        Err(OpenError::new(503, "session_open_fact_unavailable", "sem conta ChatGPT no cenário"))
    }

    fn engine_window(&self, engine: &str, _model: &str, _account: Option<&str>) -> Result<Option<u64>, OpenError> {
        self.window.map_err(|()| OpenError::new(503, "session_open_fact_unavailable", format!("o catálogo do motor '{engine}' não respondeu: rede recusada")))
    }

    fn codex_home(&self, account_id: &str) -> Result<String, OpenError> {
        if account_id == "default" { return Ok(format!("{HOME}/.codex")); }
        if self.connected.iter().any(|login| login.id == account_id) { return Ok(format!("{HOME}/.codex-{account_id}")); }
        Err(OpenError::new(404, "codex_account_not_found", "conta Codex inválida").with_params(json!({"account_id": account_id})))
    }

    fn codex_choice(&self, _home: Option<&str>, model: Option<&str>, _effort: Option<&str>, _tier: Option<ServiceTier>)
        -> Result<(), resolve::CodexCatalogError> {
        let reply = |op: &str| match self.bridge(op) {
            None => Err(resolve::CodexCatalogError::Unavailable(HARNESS_BRIDGE_DOWN.into())),
            Some(reply) if reply["error"]["status"] == 400 => Err(resolve::CodexCatalogError::Invalid(reply["error"]["detail"].as_str().unwrap().into())),
            Some(reply) if reply.get("error").is_some() => Err(resolve::CodexCatalogError::Unavailable(reply["error"]["detail"].as_str().unwrap().into())),
            Some(_) => Ok(()),
        };
        if model.is_some() { reply("catalog_models")?; }
        reply("validate_model")
    }

    fn account_mode(&self, config_dir: Option<&str>) -> Result<Option<String>, String> {
        if self.broken_mode { return Err("settings.json: JSON inválido".into()); }
        let settings = self.file(&format!("{}/settings.json", config_dir.unwrap_or(&format!("{HOME}/.claude"))));
        Ok(settings.and_then(|s| s["permissions"]["defaultMode"].as_str()).map(str::to_owned))
    }

    fn name_in_use(&self, name: &str) -> Result<bool, OpenError> {
        Ok(self.tmux.iter().any(|s| s["name"] == name) || self.sidecar("claude-headless", name).is_some() || self.sidecar("codex-sessions", name).is_some())
    }

    fn transfer_busy(&self, _name: &str) -> Result<bool, OpenError> { Ok(self.busy) }

    fn real_path(&self, path: &str) -> std::path::PathBuf { path.into() }

    fn new_key(&self) -> String { "k".repeat(32) }
    fn now(&self) -> f64 { 0.0 }
}

/// O que o Python lançou: argv e `-e` do `new-session`, ou o sidecar da sessão sem terminal.
#[derive(Debug, Default, PartialEq)]
struct Launched {
    permission: Option<String>, model: Option<String>, effort: Option<String>, jev: bool, subagent: Option<String>,
    engine: Option<String>, codex_account: Option<String>, tier: Option<String>, read_only: bool,
}

fn launched(fixture: &Value) -> Option<Launched> {
    let result = &fixture["result"];
    let name = result["steps"][0]["body"]["name"].as_str()?;
    let tmux = result["subprocesses"].as_array()?.iter()
        .find(|p| p["prog"] == "tmux" && p["argv"][0] == "new-session" && p["rc"] == 0);
    if let Some(tmux) = tmux {
        let argv: Vec<&str> = tmux["argv"].as_array()?.iter().filter_map(Value::as_str).collect();
        let command = argv.last()?.replace('\'', "");
        let env = |key: &str| argv.iter().find_map(|a| a.strip_prefix(&format!("{key}="))).map(str::to_owned);
        let flag = |name: &str| command.split(&format!("{name} ")).nth(1).and_then(|rest| rest.split_whitespace().next()).map(str::to_owned);
        return Some(Launched {
            permission: flag("--permission-mode"), model: flag("--model"), effort: flag("--effort").or_else(|| flag("--thinking")),
            jev: env("HANGAR_JEV").as_deref() == Some("on"), subagent: env("CLAUDE_CODE_SUBAGENT_MODEL"),
            engine: flag("hangar-engine --exec"), codex_account: flag("--codex-account"), tier: flag("--service-tier"),
            read_only: command.contains("bwrap"),
        });
    }
    let records = result["records"].as_object()?;
    let meta = records.iter().find(|(path, _)| path.ends_with(&format!("/{name}.json")) && !path.contains("account-locks"))?.1;
    let meta = &meta["created"]["json"];
    let text = |key: &str| meta[key].as_str().map(str::to_owned);
    Some(Launched { permission: text("permission_mode"), model: text("model"), effort: text("effort"), jev: meta["jev"] == true,
        subagent: text("subagent_model"), engine: text("engine"), codex_account: text("codex_account"),
        tier: text("service_tier"), read_only: meta["read_only"] == true })
}

/// Recusas que o Python dá depois de decidir a sessão (tmux, worktree): pertencem ao lançamento
/// (Task 4), e o `resolve_open()` as deixa passar.
const LAUNCH_REFUSALS: [&str; 3] = ["create_claude_terminal_tmux_fails", "create_worktree_outside_roots", "create_worktree_rollback_on_tmux_failure"];

/// Recusas do Python que o Rust já nasce sem (D-011, D-001), com o que vale no lugar.
const FIXED: [&str; 2] = [
    // S-40: o prompt inicial é entregue em todo provedor, também sem terminal.
    "create_claude_headless_initial_prompt_refused",
    // D-001: `inherit: false` é aceito (o Python de 601bc62a0 dava 422).
    "create_inherit_flag_not_supported",
];

fn resolve_fixture(fixture: &Value) -> Result<resolve::Resolved, OpenError> {
    let request = SessionOpenRequest::parse(&request_body(fixture)).unwrap();
    resolve::resolve_open(&request, &OWNER, &FixtureFacts::of(fixture))
}

/// O que o `resolve_open()` precisa dar para o cenário.
enum Expected { Created, Resolves, Refused { status: u64, code: Option<String>, msg: Option<String>, params: Option<Value> }, Skip }

fn expected(name: &str, fixture: &Value, local: bool) -> Expected {
    let refused = |status: u64, code: &str| Expected::Refused { status, code: Some(code.into()), msg: None, params: None };
    let status = python_status(fixture);
    let detail = &fixture["result"]["steps"][0]["body"]["detail"];
    match name {
        // A forma do corpo é do `SessionOpenRequest::parse` (teste próprio).
        _ if detail.is_array() && !FIXED.contains(&name) => Expected::Skip,
        _ if LAUNCH_REFUSALS.contains(&name) || FIXED.contains(&name) => Expected::Resolves,
        // O catálogo do Codex vem do app-server falso do cenário: a frase da recusa é a do Rust, não
        // a que o harness inventou para a ponte.
        "create_codex_catalog_refuses_choice" if local => refused(422, "erro_codex_escolha_invalida"),
        // Fast sem modelo: o Python recebeu "Rust fora" da ponte que valida (502); o `LocalFacts`
        // valida aqui mesmo e recusa porque o Fast exige modelo explícito.
        "create_codex_priority_catalog_unavailable" if local => refused(422, "erro_codex_escolha_invalida"),
        _ if status == 200 => Expected::Created,
        _ => Expected::Refused {
            status, code: detail["code"].as_str().map(str::to_owned),
            // S-40: sem o prompt inicial na regra, a frase da recusa do só leitura sem terminal perde o "nem prompt inicial".
            msg: Some(detail["msg"].as_str().or(detail.as_str()).unwrap()
                .replace("sessao sem terminal nao aceita read_only nem prompt inicial", "sessao sem terminal nao aceita read_only")),
            params: Some(if detail.is_object() { detail["params"].clone() } else { json!({}) }),
        },
    }
}

/// Compara com o que o Python fez; devolve o que comparou (criadas, lançamentos, recusas).
fn check(name: &str, fixture: &Value, result: Result<resolve::Resolved, OpenError>, local: bool) -> (u32, u32, u32) {
    match (expected(name, fixture, local), result) {
        (Expected::Skip, _) => (0, 0, 0),
        (Expected::Resolves, result) => {
            let resolved = result.unwrap_or_else(|e| panic!("{name}: {e}"));
            assert!(resolved.warnings.is_empty(), "{name}: {:?}", resolved.warnings);
            (0, 0, 0)
        }
        (Expected::Refused { status, code, msg, params }, result) => {
            let error = result.err().unwrap_or_else(|| panic!("{name}: era para recusar com {status}"));
            assert_eq!((error.status as u64, error.code.map(str::to_owned)), (status, code), "{name}: {}", error.msg);
            if let Some(msg) = msg { assert_eq!(error.msg, msg, "{name}"); }
            if let Some(params) = params { assert_eq!(error.params, params, "{name}"); }
            (0, 0, 1)
        }
        (Expected::Created, result) => check_created(name, fixture, result),
    }
}

fn check_created(name: &str, fixture: &Value, result: Result<resolve::Resolved, OpenError>) -> (u32, u32, u32) {
    {
        let body = &fixture["result"]["steps"][0]["body"];
        let resolved = result.unwrap_or_else(|e| panic!("{name}: o Python criou e o Rust recusou: {e}"));
        let spec = &resolved.spec;
        assert_eq!(spec.name, body["name"].as_str().unwrap(), "{name}");
        assert_eq!(spec.provider.name(), body["provider"].as_str().unwrap(), "{name}");
        assert_eq!(spec.surface == Surface::Headless, body["headless"] == true, "{name}");
        assert_eq!(spec.account.config_dir(), body["config_dir"].as_str(), "{name}");
        assert_eq!(spec.account_source.wire(), body["account_source"].as_str(), "{name}");
        assert_eq!(resolved.warnings, serde_json::from_value::<Vec<String>>(body["avisos"].clone()).unwrap(), "{name}");
        let Some(launched) = launched(fixture) else { return (1, 0, 0) };
        let mode = spec.permission_mode.map(|m| m.name().to_owned());
        match spec.provider {
            AgentProvider::Claude => assert_eq!(mode, launched.permission, "{name}"),
            // O Codex sem modo abre em Full Access: o spec diz isso por extenso (D-012).
            AgentProvider::Codex => assert_eq!(mode.as_deref(), Some(launched.permission.as_deref().unwrap_or("Full Access")), "{name}"),
            _ => assert_eq!(mode, None, "{name}"),
        }
        assert_eq!(spec.model, launched.model, "{name}: modelo");
        assert_eq!(spec.effort, launched.effort, "{name}: esforço");
        assert_eq!(spec.jev, launched.jev, "{name}: Jev");
        assert_eq!(spec.subagent_model, launched.subagent, "{name}: subagente");
        assert_eq!(spec.service_tier.map(|t| t.name().to_owned()), launched.tier, "{name}: Fast");
        assert_eq!(spec.read_only, launched.read_only, "{name}: só leitura");
        match &spec.account {
            Account::Engine { name: engine, .. } => assert_eq!(Some(engine.clone()), launched.engine, "{name}"),
            Account::Codex { account_id } => assert_eq!(account_id, launched.codex_account.as_deref().unwrap_or("default"), "{name}"),
            _ => assert_eq!(launched.engine, None, "{name}"),
        }
    }
    (1, 1, 0)
}

fn sum(a: (u32, u32, u32), b: (u32, u32, u32)) -> (u32, u32, u32) { (a.0 + b.0, a.1 + b.1, a.2 + b.2) }

/// As 81 criações com os fatos montados do cenário como o harness os deu ao Python.
#[test]
fn every_creation_fixture_resolves_like_python() {
    let total = create_fixtures().iter()
        .filter(|(name, fixture)| !matches!(expected(name, fixture, false), Expected::Skip))
        .map(|(name, fixture)| check(name, fixture, resolve_fixture(fixture), false)).fold((0, 0, 0), sum);
    // Todo 200 tem o que o Python lançou (argv do pane ou o sidecar); recusas antes do lançamento.
    assert_eq!(total, (43, 43, 29));
}

/// As mesmas 81 pelo `LocalFacts` de produção, lendo um cenário montado em disco.
#[cfg(target_os = "linux")]
#[test]
fn every_creation_fixture_resolves_like_python_with_the_real_facts() {
    let runtime = test_runtime();
    let mut total = (0, 0, 0);
    for (name, fixture) in create_fixtures() {
        if matches!(expected(&name, &fixture, true), Expected::Skip) { continue; }
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        materialize(&fixture, &root);
        let body = String::from_utf8(request_body(&fixture)).unwrap().replace("<ROOT>", &root.to_string_lossy());
        let request = SessionOpenRequest::parse(body.as_bytes()).unwrap();
        let env = [("HOME", root.join("home")), ("PATH", root.join("bin"))].map(|(k, v)| (k.to_owned(), v.to_string_lossy().into_owned()));
        let facts = facts::LocalFacts::new(crate::accounts::environment::AccountEnvironment::from_map(env.into_iter().collect()), runtime.handle().clone())
            .with_terminal(crate::list::mux::Mux::with_program(root.join("bin/tmux"), std::time::Duration::from_secs(2)),
                std::sync::Arc::new(crate::list::procs::ProcFs::with_root(root.join("proc"))));
        total = sum(total, check(&name, &fixture, unroot(resolve::resolve_open(&request, &OWNER, &facts), &root), true));
    }
    // As mesmas contas da `FixtureFacts`: o Fast sem modelo recusa com outro status, mas recusa.
    assert_eq!(total, (43, 43, 29));
}

/// O caminho da raiz de teste volta a ser `<ROOT>`, como nas fixtures.
fn unroot(result: Result<resolve::Resolved, OpenError>, root: &std::path::Path) -> Result<resolve::Resolved, OpenError> {
    let root = root.to_string_lossy();
    let place = |value: Value| serde_json::from_str::<Value>(&value.to_string().replace(&*root, "<ROOT>")).unwrap();
    match result {
        Ok(mut resolved) => {
            resolved.spec = serde_json::from_value(place(serde_json::to_value(&resolved.spec).unwrap())).unwrap();
            resolved.warnings = serde_json::from_value(place(json!(resolved.warnings))).unwrap();
            Ok(resolved)
        }
        Err(mut error) => {
            error.msg = error.msg.replace(&*root, "<ROOT>");
            error.params = place(error.params);
            Err(error)
        }
    }
}

/// O cenário numa raiz de verdade, para o `LocalFacts` ler como lê a máquina: arquivos e pastas, os
/// programas do harness no PATH (todos saem com erro), um tmux de mentira com os panes do cenário e
/// o `/proc` deles, as cotas no cache do Rust e o motor numa porta fechada (o harness recusa a rede).
#[cfg(target_os = "linux")]
fn materialize(fixture: &Value, root: &std::path::Path) {
    use std::os::unix::fs::PermissionsExt;
    let root_text = root.to_string_lossy().into_owned();
    let sanitized = hangar_workspace::worktrees::sanitize_cwd(&root_text);
    let place = |raw: &str| raw.replace("<ROOT_SANITIZED>", &sanitized).replace("<ROOT>", &root_text);
    let write = |path: &std::path::Path, bytes: &[u8]| {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, bytes).unwrap();
    };
    let state = &fixture["scenario"]["state"];
    for dir in state["dirs"].as_array().into_iter().flatten() {
        std::fs::create_dir_all(place(dir.as_str().unwrap())).unwrap();
    }
    for repo in state["git_repos"].as_array().into_iter().flatten() {
        std::fs::create_dir_all(place(repo["path"].as_str().unwrap())).unwrap();
    }
    for (path, content) in state["files"].as_object().into_iter().flatten() {
        let mut content = content.clone();
        if path.ends_with("/engines.json") {
            for engine in content.as_object_mut().unwrap().values_mut() { engine["base_url"] = json!("http://127.0.0.1:9"); }
        }
        let text = match content { Value::String(text) => text, json => json.to_string() };
        write(std::path::Path::new(&place(path)), place(&text).as_bytes());
    }
    let bin = root.join("bin");
    for program in ["claude", "codex", "pi", "omp", "kimi", "hangar-codex-tui", "hangar-engine", "bwrap"] {
        write(&bin.join(program), b"#!/bin/sh\nexit 1\n");
        std::fs::set_permissions(bin.join(program), std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    // O catálogo do Codex que o harness deu à ponte vira o `model/list` de um app-server falso; sem
    // ele no cenário o `codex` segue saindo com erro (catálogo fora do ar).
    let catalog = &fixture["scenario"]["fakes"]["rust_bridge"]["dictation.catalog_models"]["result"]["models"];
    if let Some(models) = catalog.as_array() {
        let efforts: Vec<Value> = ["low", "medium", "high"].iter().map(|e| json!({"reasoningEffort": e})).collect();
        let rows: Vec<Value> = models.iter().map(|m| json!({"model": m["model"], "serviceTiers": [{"id": "priority"}],
            "supportedReasoningEfforts": efforts})).collect();
        let script = format!(concat!("#!/usr/bin/python3\nimport json, sys\n",
            "if '--version' in sys.argv: print('codex-cli 0.162.1'); sys.exit(0)\n",
            "if 'app-server' not in sys.argv: sys.exit(1)\n",
            "for line in sys.stdin:\n",
            "    msg = json.loads(line)\n",
            "    if 'id' not in msg: continue\n",
            "    result = {{'data': {}, 'nextCursor': None}} if msg.get('method') == 'model/list' else {{}}\n",
            "    print(json.dumps({{'id': msg['id'], 'result': result}}), flush=True)\n"), Value::from(rows));
        write(&bin.join("codex"), script.as_bytes());
        std::fs::create_dir_all(root.join("home/.codex")).unwrap();
    }
    let mut panes = String::new();
    for (index, session) in state["tmux_sessions"].as_array().into_iter().flatten().enumerate() {
        let pid = 9_000_001 + index;
        let name = session["name"].as_str().unwrap();
        let env = session["env"].as_object().unwrap();
        let provider = env.get("CP_PROVIDER").and_then(Value::as_str).unwrap_or("");
        panes += &format!("{name}\t1\t{pid}\t{}\t%{index}\t\t{provider}\t\t0\t0\n", place(session["cwd"].as_str().unwrap()));
        let argv: Vec<String> = session["command"].as_str().unwrap().trim_start_matches("exec ").split_whitespace().map(str::to_owned).collect();
        let proc = root.join("proc").join(pid.to_string());
        write(&proc.join("stat"), format!("{pid} ({}) S 1 {}", argv[0], "0 ".repeat(20)).as_bytes());
        write(&proc.join("cmdline"), (argv.join("\0") + "\0").as_bytes());
        let environ: String = env.iter().map(|(k, v)| format!("{k}={}\0", place(v.as_str().unwrap()))).collect();
        write(&proc.join("environ"), environ.as_bytes());
        if session["environ_unreadable"] == true {
            std::fs::set_permissions(proc.join("environ"), std::fs::Permissions::from_mode(0o000)).unwrap();
        }
    }
    write(&bin.join("panes.txt"), panes.as_bytes());
    write(&bin.join("tmux"), b"#!/bin/sh\n[ \"$1\" = list-panes ] || exit 1\ncat \"$(dirname \"$0\")/panes.txt\"\n");
    std::fs::set_permissions(bin.join("tmux"), std::fs::Permissions::from_mode(0o755)).unwrap();
    // As cotas que o harness deu ao Python vinham do Rust: o cache dele em disco. Conta fora da
    // padrão só é fonte de cota com a marca do Hangar.
    let now = crate::accounts::quotas::now();
    let mut cache = serde_json::Map::new();
    for row in fixture["scenario"]["fakes"]["quotas"].as_array().into_iter().flatten() {
        let id = place(row["id"].as_str().unwrap());
        let home = std::path::PathBuf::from(id.strip_prefix("claude:").unwrap());
        if row["ativa"] != true { write(&home.join(crate::accounts::storage::CLAUDE_MARKER), b"{}"); }
        let signature = std::fs::read(home.join(".credentials.json")).ok()
            .map(|bytes| json!(ring::digest::digest(&ring::digest::SHA256, &bytes).as_ref())).unwrap_or(Value::Null);
        cache.insert(id, json!({"gravado_em": now, "credential_signature": signature,
            "cota": {"estado": row["estado"], "janelas": row["janelas"], "ts": now, "motivo": null}}));
    }
    if !cache.is_empty() { write(&root.join("home/.hangar/cotas-cache.json"), Value::Object(cache).to_string().as_bytes()); }
}

#[test]
fn launch_refusals_and_fixed_refusals_resolve() {
    for name in LAUNCH_REFUSALS.iter().chain(FIXED.iter()) {
        let (_, fixture) = create_fixtures().into_iter().find(|(n, _)| n == name).unwrap();
        let resolved = resolve_fixture(&fixture).unwrap_or_else(|e| panic!("{name}: {e}"));
        assert!(resolved.warnings.is_empty(), "{name}");
    }
    // S-40: o prompt inicial viaja até o lançamento em todo provedor, também sem terminal.
    let (_, fixture) = create_fixtures().into_iter().find(|(n, _)| n == "create_claude_headless_initial_prompt_refused").unwrap();
    assert_eq!(resolve_fixture(&fixture).unwrap().initial_prompt.as_deref(), Some("olá"));
}

/// D-001 `inherit: false`: o mesmo que pedir sem criadora (fixture irmã com o corpo sem `creator`).
#[test]
fn inherit_false_resolves_like_no_creator() {
    let fixtures = create_fixtures();
    let get = |name: &str| fixtures.iter().find(|(n, _)| n == name).unwrap().1.clone();
    let opted_out = resolve_fixture(&get("create_inherit_flag_not_supported")).unwrap().spec;
    let mut alone = get("create_inherit_flag_not_supported");
    alone["scenario"]["steps"][0]["json"].as_object_mut().unwrap().retain(|k, _| k != "creator" && k != "inherit");
    let alone = resolve_fixture(&alone).unwrap().spec;
    assert_eq!(SessionSpec { creator: None, ..opted_out.clone() }, alone);
    // O mesmo pedido herdando teria a conta e o modo da criadora (`create_inherit_from_headless_creator`).
    let inherited = resolve_fixture(&get("create_inherit_from_headless_creator")).unwrap().spec;
    assert_ne!(inherited.account, opted_out.account);
    assert_eq!(opted_out.account, Account::Default);
    assert_eq!(opted_out.permission_mode, Some(PermissionMode::BypassPermissions));
}

/// D-001 para o Codex: o modo da criadora vale também numa sessão Codex, com e sem terminal, e a
/// nova nunca é mais permissiva que ela.
#[test]
fn a_codex_session_inherits_the_creator_mode_never_more_permissive() {
    let (_, base) = create_fixtures().into_iter().find(|(n, _)| n == "create_inherit_from_headless_creator").unwrap();
    let sidecar = "<ROOT>/home/.hangar/claude-headless/mae.json";
    let table = [("acceptEdits", "Approve for me"), ("auto", "Ask for approval"), ("bypassPermissions", "Full Access"),
        ("manual", "Ask for approval"), ("dontAsk", "Ask for approval"), ("plan", "Ask for approval"), ("default", "Ask for approval")];
    for (claude, codex) in table {
        for headless in [false, true] {
            let mut fixture = base.clone();
            fixture["scenario"]["state"]["files"][sidecar]["permission_mode"] = json!(claude);
            // `plan` no sidecar volta ao modo de antes dele; aqui, ele também é `plan`.
            fixture["scenario"]["state"]["files"][sidecar]["previous_non_plan"] = json!(claude);
            fixture["scenario"]["steps"][0]["json"]["provider"] = json!("codex");
            fixture["scenario"]["steps"][0]["json"]["headless"] = json!(headless);
            let resolved = resolve_fixture(&fixture).unwrap_or_else(|e| panic!("{claude}: {e}"));
            assert_eq!(resolved.spec.permission_mode.map(PermissionMode::name), Some(codex), "{claude} headless={headless}");
            assert!(resolved.warnings.is_empty(), "{claude}: {:?}", resolved.warnings);
        }
    }
    // Codex para Codex, pelo nome.
    let (_, mut fixture) = create_fixtures().into_iter().find(|(n, _)| n == "create_inherit_from_codex_creator").unwrap();
    fixture["scenario"]["steps"][0]["json"]["provider"] = json!("codex");
    fixture["scenario"]["steps"][0]["json"]["headless"] = json!(false);
    assert_eq!(resolve_fixture(&fixture).unwrap().spec.permission_mode, Some(PermissionMode::ApproveForMe));
}

fn resolve_as(name: &str, caller: &resolve::OpenCaller, patch: impl FnOnce(&mut Value), facts: impl FnOnce(FixtureFacts) -> FixtureFacts)
    -> Result<resolve::Resolved, OpenError> {
    let (_, mut fixture) = create_fixtures().into_iter().find(|(n, _)| n == name).unwrap();
    patch(&mut fixture["scenario"]["steps"][0]["json"]);
    let request = SessionOpenRequest::parse(&request_body(&fixture)).unwrap();
    resolve::resolve_open(&request, caller, &facts(FixtureFacts::of(&fixture)))
}

/// CRI-022 e CRI-071: o convidado só abre dentro da pasta dele, não herda de sessão do dono, não usa
/// plugins do dono, fica na conta Codex padrão e não muda o provedor lembrado.
#[test]
fn a_guest_opens_only_inside_its_folder_and_without_the_owner_choices() {
    let guest = resolve::OpenCaller::Guest { root: "<ROOT>/work".into() };
    let code = |r: Result<resolve::Resolved, OpenError>| r.err().map(|e| (e.status, e.code, e.msg));
    let outside = resolve::OpenCaller::Guest { root: "<ROOT>/outra".into() };
    assert_eq!(code(resolve_as("create_claude_terminal_default", &outside, |_| {}, |f| f)),
        Some((403, Some("erro_fora_da_pasta"), "o convidado só abre sessão dentro da pasta dele".into())));
    assert_eq!(code(resolve_as("create_claude_customizations", &guest, |_| {}, |f| f)),
        Some((403, Some("claude_customizations_owner_only"), "a seleção de plugins pertence ao dono".into())));
    let alone = resolve_as("create_inherit_from_headless_creator", &guest, |_| {}, |f| f).unwrap();
    assert_eq!((alone.spec.account, alone.spec.account_source, alone.warnings.len()), (Account::Default, AccountSource::Default, 0));
    assert_eq!(alone.spec.permission_mode, Some(PermissionMode::BypassPermissions), "modo da conta, não o da criadora");
    let connected = |mut f: FixtureFacts| { f.connected = vec![resolve::CodexLogin { id: "trabalho".into(), is_default: false }]; f };
    let codex = resolve_as("create_codex_terminal_default", &guest, |_| {}, connected).unwrap();
    assert_eq!((codex.spec.account, codex.warnings.len()), (Account::Codex { account_id: "default".into() }, 0));
    assert!(!resolve_as("create_remember_provider", &guest, |_| {}, |f| f).unwrap().remember_provider);
    assert!(resolve_as("create_remember_provider", &OWNER, |_| {}, |f| f).unwrap().remember_provider);
}

/// Troca de agente em curso no nome: recusa com o código dela (S-35c), não `erro_criacao_sessao`.
#[test]
fn a_transfer_in_progress_refuses_with_its_own_code() {
    let busy = resolve_as("create_claude_terminal_default", &OWNER, |_| {}, |mut f| { f.busy = true; f });
    assert_eq!(busy.err().map(|e| (e.status, e.code)), Some((409, Some("session_transfer_busy"))));
}

/// Os fatos de verdade: índice de transferências do Python e caminho real (link para fora da pasta).
#[cfg(unix)]
#[test]
fn local_facts_read_transfers_and_real_paths() {
    let runtime = test_runtime();
    let home = tempfile::tempdir().unwrap();
    let home = home.path().canonicalize().unwrap();
    std::fs::create_dir_all(home.join("work/proj")).unwrap();
    let body = |cwd: &std::path::Path| json!({"name": "s1", "cwd": cwd, "provider": "claude", "headless": false}).to_string();
    let open = |cwd: &std::path::Path, caller: &resolve::OpenCaller| {
        let request = SessionOpenRequest::parse(body(cwd).as_bytes()).unwrap();
        resolve::resolve_open(&request, caller, &local_facts(&home, &runtime)).err().map(|e| (e.status, e.code))
    };
    let base = home.join(".hangar/conversation-transfers");
    std::fs::create_dir_all(base.join("indexes")).unwrap();
    let digest: String = ring::digest::digest(&ring::digest::SHA256, b"s1").as_ref().iter().map(|b| format!("{b:02x}")).collect();
    let id = "4b7c4a1e-0000-4000-8000-000000000001";
    std::fs::write(base.join(format!("indexes/session-{digest}.json")), json!([id]).to_string()).unwrap();
    std::fs::write(base.join(format!("{id}.json")), json!({"id": id, "name": "s1", "phase": "imported"}).to_string()).unwrap();
    assert_eq!(open(&home.join("work/proj"), &OWNER), Some((409, Some("session_transfer_busy"))));
    std::fs::write(base.join(format!("{id}.json")), json!({"id": id, "name": "s1", "phase": "complete"}).to_string()).unwrap();
    assert_eq!(open(&home.join("work/proj"), &OWNER), None);
    // O link dentro da pasta do convidado aponta para fora dela: o caminho real decide.
    std::fs::create_dir_all(home.join("guest")).unwrap();
    std::os::unix::fs::symlink(home.join("work"), home.join("guest/fora")).unwrap();
    let guest = resolve::OpenCaller::Guest { root: home.join("guest") };
    assert_eq!(open(&home.join("guest/fora/proj"), &guest), Some((403, Some("erro_fora_da_pasta"))));
}

/// `model: ""` com Fast cai no modelo do motor como o `or` do Python: o Fast passa, e quem recusa é
/// a regra do modelo, com o código e o texto de lá.
#[test]
fn an_empty_model_with_fast_falls_back_to_the_engine_model() {
    let runtime = test_runtime();
    let home = tempfile::tempdir().unwrap();
    let home = home.path().canonicalize().unwrap();
    std::fs::create_dir_all(home.join("work")).unwrap();
    std::fs::create_dir_all(home.join(".claude")).unwrap();
    std::fs::create_dir_all(home.join(".cli-proxy-api")).unwrap();
    std::fs::write(home.join(".cli-proxy-api/config.yaml"), "port: 8317\napi-keys:\n  - k\n").unwrap();
    std::fs::write(home.join(".claude/engines.json"),
        json!({"gpt": {"base_url": "http://127.0.0.1:8317/v1", "api_key": "k", "model": "gpt-5.5"}}).to_string()).unwrap();
    let body = json!({"name": "s1", "cwd": home.join("work"), "provider": "claude", "headless": false, "engine": "gpt",
        "model": "", "service_tier": "priority"});
    let request = SessionOpenRequest::parse(body.to_string().as_bytes()).unwrap();
    let error = resolve::resolve_open(&request, &OWNER, &local_facts(&home, &runtime)).err();
    assert_eq!(error.map(|e| (e.status, e.code, e.msg)),
        Some((400, None, "model: use letras, números e . _ : / - ~ [ ] (até 128 caracteres, sem começar com -)".into())));
}

/// `_session_provider_catalog` + `choose_provider` (api.py, session_defaults.py): desconectado só
/// quando todo login lido diz que não; ilegível não conta para nenhum lado.
#[test]
fn the_provider_catalog_marks_disconnected_like_python() {
    use AgentProvider::{Claude, Codex, Pi};
    let all = AgentProvider::ALL.to_vec();
    let states = |s: &[&str]| s.iter().map(|s| s.to_string()).collect::<Vec<_>>();
    let c = facts::provider_catalog(all.clone(), &[Some(false), Some(false)], false, &states(&["disconnected"]), None);
    assert_eq!((c.connected, c.disconnected), (vec![], vec![Claude, Codex]));
    let c = facts::provider_catalog(all.clone(), &[Some(false), None], false, &states(&["disconnected", "unavailable"]), None);
    assert_eq!((c.connected, c.disconnected), (vec![], vec![]));
    let c = facts::provider_catalog(all.clone(), &[Some(false)], true, &[], None);
    assert_eq!((c.connected, c.disconnected), (vec![Claude], vec![]), "motor configurado conta como Claude conectado");
    let c = facts::provider_catalog(vec![Pi], &[Some(false)], false, &states(&["disconnected"]), None);
    assert_eq!((c.connected, c.disconnected), (vec![], vec![]), "só o disponível é lido");
    // O lembrado desconectado perde para o conectado.
    let c = facts::provider_catalog(all, &[Some(false)], false, &states(&["connected"]), Some("claude".into()));
    assert_eq!(resolve::choose_provider(&c), Codex);
}

/// Criadora sem terminal sem modo no sidecar: vale o do transcript dela (api.py `_creator_permission_mode`).
#[test]
fn a_headless_creator_without_a_mode_falls_back_to_its_transcript() {
    let runtime = test_runtime();
    let home = tempfile::tempdir().unwrap();
    let home = home.path().canonicalize().unwrap();
    let work = home.join("work");
    std::fs::create_dir_all(&work).unwrap();
    let sid = "11111111-1111-4111-8111-111111111111";
    let sidecar = json!({"name": "mae", "provider": "claude", "headless": true, "key": "a".repeat(32), "cwd": work,
        "session_id": sid, "config_dir": null, "permission_mode": null, "previous_non_plan": null});
    std::fs::create_dir_all(home.join(".hangar/claude-headless")).unwrap();
    std::fs::write(home.join(".hangar/claude-headless/mae.json"), sidecar.to_string()).unwrap();
    let projects = home.join(".claude/projects").join(hangar_workspace::worktrees::sanitize_cwd(&work.to_string_lossy()));
    std::fs::create_dir_all(&projects).unwrap();
    std::fs::write(projects.join(format!("{sid}.jsonl")), "{\"permissionMode\":\"acceptEdits\"}\n{\"permissionMode\":\"plan\"}\n").unwrap();
    let body = json!({"name": "filha", "cwd": work, "provider": "claude", "creator": "mae", "headless": false});
    let request = SessionOpenRequest::parse(body.to_string().as_bytes()).unwrap();
    let resolved = resolve::resolve_open(&request, &OWNER, &local_facts(&home, &runtime)).unwrap();
    assert_eq!((resolved.spec.permission_mode, resolved.warnings.len()), (Some(PermissionMode::AcceptEdits), 0), "{:?}", resolved.warnings);
}

/// Não dar para listar as contas Codex é erro visível, não "nenhuma conta".
#[test]
fn unlisted_codex_accounts_refuse_instead_of_counting_as_none() {
    let runtime = test_runtime();
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(dir.path().join("work")).unwrap();
    let body = json!({"name": "cx", "cwd": dir.path().join("work"), "provider": "codex", "headless": false});
    let request = SessionOpenRequest::parse(body.to_string().as_bytes()).unwrap();
    let result = resolve::resolve_open(&request, &OWNER, &local_facts(&dir.path().join("sem-casa"), &runtime));
    assert_eq!(result.err().map(|e| (e.status, e.code)), Some((503, Some("account_storage_unavailable"))));
}

/// Janela do motor como o Python: `context_length` (ou `context_window`) do catálogo do provedor,
/// 1M para `gpt-…[1m]`; catálogo fora do ar abre sem a janela, marcada desconhecida (T-004).
#[test]
fn the_engine_window_comes_from_the_provider_catalog() {
    let runtime = test_runtime();
    let catalog = json!({"data": [{"id": "gpt-5.5", "context_length": 400000}, {"id": "k3", "context_window": 262144}, {"id": "sem"}]});
    let listener = runtime.block_on(tokio::net::TcpListener::bind("127.0.0.1:0")).unwrap();
    let port = listener.local_addr().unwrap().port();
    let app = axum::Router::new().route("/v1/models", axum::routing::get(move || async move {
        ([(axum::http::header::CONTENT_TYPE, "application/json")], catalog.to_string())
    }));
    runtime.spawn(async move { axum::serve(listener, app).await.unwrap() });
    let home = tempfile::tempdir().unwrap();
    let home = home.path().canonicalize().unwrap();
    std::fs::create_dir_all(home.join("work")).unwrap();
    std::fs::create_dir_all(home.join(".claude")).unwrap();
    std::fs::write(home.join(".claude/engines.json"), json!({
        "e": {"base_url": format!("http://127.0.0.1:{port}/v1"), "api_key": "chave", "model": "k3"},
        "fora": {"base_url": "http://127.0.0.1:9", "api_key": "chave", "model": "k3"}}).to_string()).unwrap();
    let open = |engine: &str, model: &str| {
        let body = json!({"name": "s1", "cwd": home.join("work"), "provider": "claude", "headless": false, "engine": engine, "model": model});
        let request = SessionOpenRequest::parse(body.to_string().as_bytes()).unwrap();
        resolve::resolve_open(&request, &OWNER, &local_facts(&home, &runtime))
            .map(|r| match r.spec.account {
                Account::Engine { context_window, context_window_unknown, .. } => (context_window, context_window_unknown),
                other => panic!("{other:?}"),
            })
            .map_err(|e| (e.status, e.code))
    };
    assert_eq!(open("e", "k3"), Ok((Some(262144), false)));
    assert_eq!(open("e", "gpt-5.5[1m]"), Ok((Some(1_000_000), false)));
    assert_eq!(open("e", "gpt-5.5"), Ok((Some(400000), false)));
    assert_eq!(open("e", "sem"), Ok((None, false)), "o catálogo não traz o número");
    assert_eq!(open("e", "nao-existe"), Ok((None, false)), "o catálogo não traz o modelo");
    assert_eq!(open("fora", "k3"), Ok((None, true)), "provedor fora: abre, janela desconhecida");
}

/// T-004: a janela desconhecida é lida de novo a cada reabertura e só sai de desconhecida quando o
/// catálogo responde.
#[test]
fn an_unknown_engine_window_is_read_again_on_reopen() {
    let (_, fixture) = create_fixtures().into_iter().find(|(n, _)| n == "create_claude_terminal_default").unwrap();
    for (window, expected) in [(Err(()), (None, true)), (Ok(Some(262144)), (Some(262144), false)), (Ok(None), (None, false))] {
        let facts = FixtureFacts { window, ..FixtureFacts::of(&fixture) };
        let mut spec = SessionSpec { model: Some("k3".into()), account: Account::Engine { name: "e".into(), account: None,
            config_dir: None, context_window: None, context_window_unknown: true }, ..fixture_spec("create_claude_terminal_default") };
        spec.refresh_engine_window(&facts);
        let Account::Engine { context_window, context_window_unknown, .. } = spec.account else { unreachable!() };
        assert_eq!((context_window, context_window_unknown), expected);
    }
}

/// Herdar a conta Codex padrão desconectada é como não pedir conta: a conectada entra no lugar.
#[test]
fn an_inherited_default_codex_account_still_moves_to_the_connected_one() {
    let (_, mut fixture) = create_fixtures().into_iter().find(|(n, _)| n == "create_inherit_from_codex_creator").unwrap();
    fixture["scenario"]["steps"][0]["json"]["provider"] = json!("codex");
    let request = SessionOpenRequest::parse(&request_body(&fixture)).unwrap();
    let facts = FixtureFacts { connected: vec![resolve::CodexLogin { id: "trabalho".into(), is_default: false }], ..FixtureFacts::of(&fixture) };
    let resolved = resolve::resolve_open(&request, &OWNER, &facts).unwrap();
    assert_eq!(resolved.spec.account, Account::Codex { account_id: "trabalho".into() });
    assert_eq!(resolved.warnings, ["A conta Codex padrão não está conectada; a sessão usa a conta trabalho."]);
}

/// D-001 para o Codex: a criadora Codex passa a conta Codex dela.
#[test]
fn a_codex_creator_passes_its_codex_account_to_a_codex_session() {
    let (_, mut fixture) = create_fixtures().into_iter().find(|(n, _)| n == "create_inherit_from_codex_creator").unwrap();
    fixture["scenario"]["state"]["files"]["<ROOT>/home/.hangar/codex-sessions/mae-codex.json"]["codex_account"] = json!("trabalho");
    fixture["scenario"]["steps"][0]["json"]["provider"] = json!("codex");
    let error = resolve_fixture(&fixture).unwrap_err();
    // A conta herdada é resolvida como a pedida: a do cenário não existe.
    assert_eq!((error.status, error.code, error.params), (404, Some("codex_account_not_found"), json!({"account_id": "trabalho"})));
}

/// `names.sanitize_session_name`, executado (`python3 -c 'from app.names import …'`): NFKD e o que
/// sobra fora do ASCII some (S-54).
#[test]
fn session_names_fold_like_python() {
    let python = [("Łódź-ńś ž", "odz-ns-z"), ("Área de trabalho", "Area-de-trabalho"), ("São Paulo/ação", "Sao-Paulo-acao"),
        ("会话", ""), ("ﬁle①", "file1"), ("  -x- ", "x"), ("Ǆemal", "DZemal"), ("a\u{301}b", "ab")];
    for (raw, expected) in python {
        assert_eq!(crate::list::discover_other::sanitize_session_name(raw), expected, "{raw:?}");
    }
}

/// S-53: o nome tem teto (o tmux e a reabertura do Rust recusam acima disso).
#[test]
fn names_longer_than_the_terminal_accepts_are_refused() {
    let (_, mut fixture) = create_fixtures().into_iter().find(|(n, _)| n == "create_claude_terminal_default").unwrap();
    fixture["scenario"]["steps"][0]["json"]["name"] = json!("a".repeat(65));
    let error = resolve_fixture(&fixture).unwrap_err();
    assert_eq!((error.status, error.code), (409, Some("erro_criacao_sessao")));
    fixture["scenario"]["steps"][0]["json"]["name"] = json!("a".repeat(64));
    assert!(resolve_fixture(&fixture).is_ok());
}

/// Settings da conta ilegível sem modo pedido: recusa com código, nunca o modo mais permissivo
/// calado. Com o modo pedido, abre.
#[test]
fn an_unreadable_account_mode_refuses_unless_a_mode_was_asked() {
    let (_, mut fixture) = create_fixtures().into_iter().find(|(n, _)| n == "create_claude_terminal_default").unwrap();
    let facts = FixtureFacts { broken_mode: true, ..FixtureFacts::of(&fixture) };
    let request = SessionOpenRequest::parse(&request_body(&fixture)).unwrap();
    let result = resolve::resolve_open(&request, &OWNER, &facts);
    assert_eq!(result.err().map(|e| (e.status, e.code)), Some((409, Some("erro_modo_padrao_ilegivel"))));
    fixture["scenario"]["steps"][0]["json"]["permission_mode"] = json!("manual");
    let request = SessionOpenRequest::parse(&request_body(&fixture)).unwrap();
    let resolved = resolve::resolve_open(&request, &OWNER, &facts).unwrap();
    assert_eq!((resolved.spec.permission_mode, resolved.warnings.len()), (Some(PermissionMode::Manual), 0));
}

// ── plano do Claude com terminal ─────────────────────────────────────────────────────────────

/// Palavras de uma linha de comando POSIX (aspas simples e duplas, como o `shlex.split`).
fn shell_words(line: &str) -> Vec<String> {
    let (mut words, mut word, mut quote, mut started) = (Vec::new(), String::new(), None, false);
    for c in line.chars() {
        match (quote, c) {
            (None, ' ') => { if started { words.push(std::mem::take(&mut word)); started = false; } }
            (None, '\'' | '"') => { quote = Some(c); started = true; }
            (Some(q), c) if c == q => quote = None,
            (_, c) => { word.push(c); started = true; }
        }
    }
    if started { words.push(word); }
    words
}

/// O que o Python passou ao `new-session`: o `-e` (sem os de todo provedor) e as palavras do comando.
fn launched_pane(argv: &[String]) -> (Vec<(String, String)>, Vec<String>) {
    let token = Regex::new(r"\A[0-9a-f]{32}\.[0-9a-f]{32}\z").unwrap();
    let env = argv.windows(2).filter(|w| w[0] == "-e").filter_map(|w| w[1].split_once('='))
        .filter(|(k, _)| *k != "CP_SESSION_KEY")
        .map(|(k, v)| (k.to_owned(), if token.is_match(v) { "<hex:1>.<hex:2>".to_owned() } else { v.to_owned() })).collect();
    (env, shell_words(argv.last().unwrap()))
}

/// Os Claude com terminal que o Python lançou: o pane do `claude::pane` sobre o spec do
/// `resolve_open()` dá o mesmo `-e` e o mesmo comando, menos o que o S-63 tira e a chave da sessão
/// (matriz, item 2). O `-c` vem do `new-session` (a worktree troca a pasta na abertura).
#[test]
fn the_claude_pane_is_the_one_python_launched() {
    let mut compared = 0;
    for (name, fixture) in create_fixtures() {
        let Some(tmux) = fixture["result"]["subprocesses"].as_array().into_iter().flatten()
            .find(|p| p["prog"] == "tmux" && p["argv"][0] == "new-session") else { continue };
        let python: Vec<String> = tmux["argv"].as_array().unwrap().iter().map(|a| a.as_str().unwrap().to_owned()).collect();
        if !python.iter().any(|a| a == "CP_PROVIDER=claude") { continue; }
        let mut spec = resolve_fixture(&fixture).unwrap_or_else(|e| panic!("{name}: {e}")).spec;
        spec.cwd = python[python.iter().position(|a| a == "-c").unwrap() + 1].clone();
        let state = &fixture["scenario"]["state"]["files"];
        let runtime = state["<ROOT>/home/.claude/runtime-config.json"].clone();
        let settings = fixture["scenario"]["fakes"]["rust_bridge"]["claude_customizations.prepare"]["result"]["settings"].clone();
        let probe = fixture["result"]["probes"].as_array().into_iter().flatten().find(|p| p["prog"] == "bwrap");
        let read_only: Option<Vec<String>> = probe.map(|p| std::iter::once("<ROOT>/bin/bwrap".to_owned())
            .chain(p["argv"].as_array().unwrap().iter().map(|a| a.as_str().unwrap().to_owned()).filter(|a| a != "/bin/true")).collect());
        let roots = ["<REPO>/plugins/hangar".to_owned(), "<REPO>/plugins/github-actions".to_owned()];
        let bridge = claude::PluginBridge { port: 8765, secret: "segredo".into() };
        let ctx = claude::ClaudeContext { plugin_roots: &roots, bridge: Some(&bridge), bridge_key: &"a".repeat(32),
            runtime_config: &runtime, server_env: &Default::default(), settings: Some(&settings).filter(|s| !s.is_null()),
            read_only: read_only.as_deref(), windows: false, initial_prompt: None, engine_route: None };
        let ours = terminal::new_session_argv(&terminal::tests::machine_at("<ROOT>/home/.claude"), &claude::pane(&spec, "<uuid:1>", &ctx));
        // O comando de dentro do `sh -c` do só leitura também é comparado por palavra.
        let inner = |words: Vec<String>| words.iter().enumerate()
            .flat_map(|(i, w)| if i > 0 && words[i - 1] == "-c" { shell_words(w) } else { vec![w.clone()] }).collect::<Vec<_>>();
        let (env, words) = launched_pane(&python);
        let words = inner(words);
        let (our_env, _) = launched_pane(&ours);
        let our_words = inner(shell_words(&terminal::tests::undo_not_inherited(ours.last().unwrap())));
        assert_eq!(our_env, env, "{name}: -e");
        assert_eq!(our_words, words, "{name}: comando");
        compared += 1;
    }
    assert_eq!(compared, 26);
}

/// Pi, omp e Kimi que o Python lançou: o pane do `agents::pane` sobre o spec dá o mesmo `-e` e o
/// mesmo comando, menos o S-63 e a chave. S-58/S-73: o `env CP_PI_SESSION=… OMP_PROFILE=…` do
/// comando do omp vira `-e`, e o Pi ganha o `CP_PI_SESSION` que não tinha.
#[test]
fn the_pi_omp_and_kimi_panes_are_the_ones_python_launched() {
    let stamp = Regex::new(r"\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z_").unwrap();
    let mut compared = 0;
    for (name, fixture) in create_fixtures() {
        let Some(tmux) = fixture["result"]["subprocesses"].as_array().into_iter().flatten()
            .find(|p| p["prog"] == "tmux" && p["argv"][0] == "new-session") else { continue };
        let python: Vec<String> = tmux["argv"].as_array().unwrap().iter().map(|a| a.as_str().unwrap().to_owned()).collect();
        let Some(agent) = ["pi", "omp", "kimi"].into_iter().find(|p| python.contains(&format!("CP_PROVIDER={p}"))) else { continue };
        let mut spec = resolve_fixture(&fixture).unwrap_or_else(|e| panic!("{name}: {e}")).spec;
        // A pasta do Pi é a do caminho absoluto: a raiz do cenário vira `/r`.
        spec.cwd = spec.cwd.replace("<ROOT>", "/r");
        let runtime = fixture["scenario"]["state"]["files"]["<ROOT>/home/.claude/runtime-config.json"].clone();
        let ctx = agents::AgentContext { home: std::path::Path::new("/r/home"), server_env: &Default::default(), runtime_config: &runtime,
            read_only: None, windows: false };
        let pane = agents::pane(&spec, agents::Conversation::New("<uuid:1>"), &ctx).unwrap_or_else(|e| panic!("{name}: {e}"));
        let ours = terminal::new_session_argv(&terminal::tests::machine_at("<ROOT>/home/.claude"), &pane);
        let (mut env, mut words) = launched_pane(&python);
        let at = words.iter().position(|w| w == agent).unwrap();
        let first = (0..at).rev().take_while(|&i| words[i].contains('=')).last().unwrap_or(at);
        let moved: Vec<String> = words.drain(first..at).collect();
        if !moved.is_empty() { assert_eq!(words.remove(first - 1), "env", "{name}"); }
        env.extend(moved.iter().filter_map(|w| w.split_once('=')).map(|(k, v)| (k.to_owned(), v.to_owned())));
        if agent == "pi" { env.push(("CP_PI_SESSION".into(), "<uuid:1>".into())); }
        let (our_env, _) = launched_pane(&ours);
        let our_words: Vec<String> = shell_words(&terminal::tests::undo_not_inherited(ours.last().unwrap())).into_iter()
            .map(|w| stamp.replace(&w.replace("/--r-", "/-<ROOT_SANITIZED>-").replace("/r/", "<ROOT>/"), "<iso-file>_").into_owned()).collect();
        assert_eq!(our_env, env, "{name}: -e");
        assert_eq!(our_words, words, "{name}: comando");
        compared += 1;
    }
    assert_eq!(compared, 6);
}

/// Retomar com o verbo de cada agente (test_omp_adapter, test_pi_registry, `registry.create`): Pi pelo
/// mesmo `--session-id`, omp pelo caminho (`-r`), Kimi por `--session <session_…>`; id torto recusado.
#[test]
fn pi_omp_and_kimi_resume_with_their_own_verb() {
    const ID: &str = "11111111-1111-4111-8111-111111111111";
    let home = tempfile::tempdir().unwrap();
    let base = resolve_fixture(&create_fixtures().into_iter().find(|(n, _)| n == "create_pi_terminal").unwrap().1).unwrap().spec;
    let runtime = json!({});
    let ctx = agents::AgentContext { home: home.path(), server_env: &Default::default(), runtime_config: &runtime, read_only: None, windows: false };
    let command = |spec: &SessionSpec, conversation| agents::pane(spec, conversation, &ctx).map(|p| (p.command, p.env));
    let words = |w: &[&str]| w.iter().map(|s| s.to_string()).collect::<Vec<_>>();

    let (pi, env) = command(&base, agents::Conversation::Resume(ID)).unwrap();
    assert_eq!(pi, words(&["pi", "--session-id", ID, "--model", "anthropic/claude-sonnet-4", "--thinking", "low"]));
    assert!(env.contains(&("CP_PI_SESSION".into(), ID.into())));
    assert_eq!(command(&base, agents::Conversation::Resume("x; rm -rf /")).unwrap_err().msg, "session_id invalido");

    let omp = SessionSpec { provider: AgentProvider::Omp, cwd: "/w".into(), model: None, effort: None,
        account: Account::Omp { profile: "trabalho".into(), config_dir: None }, ..base.clone() };
    let dir = home.path().join(".omp/profiles/trabalho/agent/sessions/--w--");
    std::fs::create_dir_all(&dir).unwrap();
    let file = dir.join(format!("2026-09-06T15-51-00-640Z_{ID}.jsonl"));
    std::fs::write(&file, "").unwrap();
    let (resumed, env) = command(&omp, agents::Conversation::Resume(ID)).unwrap();
    assert_eq!(resumed, words(&["omp", "-r", &file.to_string_lossy()]));
    assert!(env.contains(&("CP_PI_SESSION".into(), ID.into())) && env.contains(&("OMP_PROFILE".into(), "trabalho".into())));
    let bare = SessionSpec { account: Account::Default, ..omp.clone() };
    assert_eq!(command(&bare, agents::Conversation::Resume(ID)).unwrap_err().msg, "transcript do omp nao encontrado para retomar");
    // O omp grava o principal em `sessions/-/`: o mesmo nome em outra pasta da raiz também vale.
    let elsewhere = home.path().join(".omp/agent/sessions/-");
    std::fs::create_dir_all(&elsewhere).unwrap();
    std::fs::write(elsewhere.join(format!("2026-09-07T10-00-00-000Z_{ID}.jsonl")), "").unwrap();
    assert_eq!(command(&bare, agents::Conversation::Resume(ID)).unwrap().0[2], elsewhere.join(format!("2026-09-07T10-00-00-000Z_{ID}.jsonl")).to_string_lossy());

    let kimi = SessionSpec { provider: AgentProvider::Kimi, model: Some("kimi-k3".into()), effort: None, ..base };
    let (new, env) = command(&kimi, agents::Conversation::New(ID)).unwrap();
    assert_eq!(new, words(&["kimi", "--model", "kimi-k3"]));
    assert!(!env.iter().any(|(k, _)| k == "CP_PI_SESSION"), "o Kimi não aceita id escolhido");
    let sid = format!("session_{ID}");
    assert_eq!(command(&kimi, agents::Conversation::Resume(&sid)).unwrap().0, words(&["kimi", "--session", &sid, "--model", "kimi-k3"]));
    assert_eq!(command(&kimi, agents::Conversation::Resume(ID)).unwrap_err().msg, "session_id invalido");
}

/// `kimi_sessions.pretrust_cwd` (test_kimi_sessions::test_pretrust_writes_workspace_trust_once): grava
/// `{root, trustedAt}` na chave do CLI uma vez; já confiada não reescreve.
#[test]
fn the_kimi_folder_is_pretrusted_once() {
    let home = tempfile::tempdir().unwrap();
    let file = home.path().join("workspace-trust").join(crate::list::discover_other::kimi_workdir_key("/w/proj"));
    agents::kimi_pretrust(home.path(), "/w/proj", 1000);
    agents::kimi_pretrust(home.path(), "/w/proj", 2000);
    let written: Value = serde_json::from_slice(&std::fs::read(&file).unwrap()).unwrap();
    assert_eq!(written, json!({"root": "/w/proj", "trustedAt": 1000}));
}

/// `_pretrust_cwd` e `default_model.drop_foreign` (test_registry, test_default_model): a pasta
/// confiada no arquivo, já confiada sem reescrever; modelo de motor fora dos dois `settings.json`.
#[test]
fn the_folder_is_pretrusted_and_a_foreign_default_model_is_dropped() {
    let home = tempfile::tempdir().unwrap();
    let file = home.path().join(".claude.json");
    std::fs::write(&file, r#"{"numStartups": 3, "projects": {"/x": {"allowedTools": []}}}"#).unwrap();
    claude::pretrust(&file, "/x", false);
    let data: Value = serde_json::from_slice(&std::fs::read(&file).unwrap()).unwrap();
    assert_eq!(data, json!({"numStartups": 3, "projects": {"/x": {"allowedTools": [], "hasTrustDialogAccepted": true}}}));
    let before = std::fs::metadata(&file).unwrap().modified().unwrap();
    std::thread::sleep(std::time::Duration::from_millis(20));
    claude::pretrust(&file, "/x", false);
    assert_eq!(std::fs::metadata(&file).unwrap().modified().unwrap(), before, "já confiada não reescreve");
    claude::pretrust(&file, "C:\\x\\y", true);
    let data: Value = serde_json::from_slice(&std::fs::read(&file).unwrap()).unwrap();
    assert_eq!(data["projects"]["C:/x/y"]["hasTrustDialogAccepted"], true, "barra normal no Windows");

    let account = home.path().join(".claude-b");
    std::fs::create_dir_all(&account).unwrap();
    std::fs::create_dir_all(home.path().join(".claude")).unwrap();
    std::fs::write(account.join("settings.json"), r#"{"model": "claude-200-2/gpt-6.1-sol", "theme": "dark"}"#).unwrap();
    std::fs::write(home.path().join(".claude/settings.json"), r#"{"model": "opus[1m]"}"#).unwrap();
    let warnings = claude::drop_foreign_model(home.path(), Some(&account.to_string_lossy()));
    assert_eq!(warnings, ["O modelo padrão 'claude-200-2/gpt-6.1-sol' do settings.json não é da Anthropic (provavelmente veio de um /model numa sessão de motor) e foi removido."]);
    assert_eq!(serde_json::from_slice::<Value>(&std::fs::read(account.join("settings.json")).unwrap()).unwrap(), json!({"theme": "dark"}));
    assert_eq!(std::fs::read_to_string(home.path().join(".claude/settings.json")).unwrap(), r#"{"model": "opus[1m]"}"#);
}

/// O auxiliar do Jev de antes da configuração única vem do `jev_texto_*` sem o `/chat/completions`.
#[test]
fn the_jev_auxiliary_model_falls_back_to_the_browser_one() {
    let runtime = json!({"jev_api_key": "sk-or-x", "jev_texto_base_url": "https://h/v1/chat/completions?api-version=2",
        "jev_texto_modelo": "m", "jev_texto_cmd": "texto"});
    let pairs = claude::jev_pairs(true, &runtime);
    let keys: Vec<&str> = pairs.iter().map(|(k, _)| k.as_str()).collect();
    assert_eq!(keys, ["HANGAR_JEV", "TYPESAFE_API_KEY", "JEV_ENDPOINT", "JEV_MODEL", "JEV_AUX_BASE_URL", "JEV_AUX_MODELO", "JEV_TEXTO_CMD"]);
    assert_eq!(pairs[4].1, "https://h/v1?api-version=2");
    assert_eq!(claude::jev_pairs(false, &runtime), [("HANGAR_JEV".to_owned(), "off".to_owned())]);
}

/// S-40: o prompt inicial do Claude com terminal é entregue (o Python o perdia calado): vai como o
/// prompt posicional do `claude`, depois das opções, e com `--` quando começa com `-`.
#[test]
fn the_initial_prompt_is_the_first_message_of_the_claude_terminal() {
    let (_, fixture) = create_fixtures().into_iter().find(|(n, _)| n == "create_claude_terminal_initial_prompt_ignored").unwrap();
    let resolved = resolve_fixture(&fixture).unwrap();
    assert_eq!(resolved.initial_prompt.as_deref(), Some("olá"));
    let roots = ["<REPO>/plugins/hangar".to_owned()];
    for (prompt, tail) in [("olá", vec!["--permission-mode", "bypassPermissions", "olá"]),
                           ("-v e depois", vec!["--permission-mode", "bypassPermissions", "--", "-v e depois"])] {
        let ctx = claude::ClaudeContext { plugin_roots: &roots, bridge: None, bridge_key: "k", runtime_config: &Value::Null,
            server_env: &Default::default(), settings: None, read_only: None, windows: false, initial_prompt: Some(prompt), engine_route: None };
        let command = claude::pane(&resolved.spec, "sid", &ctx).command;
        assert_eq!(command[command.len() - tail.len()..], tail.iter().map(|s| s.to_string()).collect::<Vec<_>>()[..]);
    }
}

/// S-45: pasta pedida com `~` é normalizada na entrada; o pane, a pré-confiança e o transcript usam o
/// caminho absoluto (o Python registrava o texto cru: chave da confiança e pasta do transcript com `~`).
#[test]
fn a_tilde_folder_is_absolute_everywhere_in_the_launch() {
    let runtime = test_runtime();
    let home = tempfile::tempdir().unwrap();
    let home = home.path().canonicalize().unwrap();
    std::fs::create_dir_all(home.join("work/proj")).unwrap();
    std::fs::create_dir_all(home.join(".claude")).unwrap();
    let body = json!({"name": "s1", "cwd": "~/work/proj", "provider": "claude", "headless": false, "permission_mode": "manual"});
    let request = SessionOpenRequest::parse(body.to_string().as_bytes()).unwrap();
    let spec = resolve::resolve_open(&request, &OWNER, &local_facts(&home, &runtime)).unwrap().spec;
    let absolute = home.join("work/proj").to_string_lossy().into_owned();
    assert_eq!(spec.cwd, absolute);
    let ctx = claude::ClaudeContext { plugin_roots: &[], bridge: None, bridge_key: "k", runtime_config: &Value::Null,
        server_env: &Default::default(), settings: None, read_only: None, windows: false, initial_prompt: None, engine_route: None };
    let argv = terminal::new_session_argv(&terminal::tests::machine_at(&home.join(".claude").to_string_lossy()), &claude::pane(&spec, "sid", &ctx));
    assert_eq!(argv[argv.iter().position(|a| a == "-c").unwrap() + 1], absolute);
    let transcript = claude::transcript(&spec, "sid", &home.join(".claude/projects"));
    assert_eq!(transcript.parent().unwrap().file_name().unwrap().to_string_lossy(), hangar_workspace::worktrees::sanitize_cwd(&absolute));
    claude::pretrust(&home.join(".claude.json"), &spec.cwd, false);
    let trusted: Value = serde_json::from_slice(&std::fs::read(home.join(".claude.json")).unwrap()).unwrap();
    assert_eq!(trusted["projects"][&absolute]["hasTrustDialogAccepted"], true);
}

/// Conta ChatGPT fixa do motor (`_fixed_engine_account`, `cliproxy.engine_env`): a credencial do
/// CLIProxyAPI local da conta Codex, o modelo sem o prefixo dela, a janela do catálogo dela e a rota
/// no `hangar-engine` (`--account`, `--account-home`, `--account-base-url`).
#[test]
fn a_fixed_chatgpt_account_resolves_and_routes_the_engine() {
    let runtime = test_runtime();
    let catalog = json!({"data": [{"id": "work/gpt-5.5", "context_length": 400000}, {"id": "other/gpt-5.5", "context_length": 1}]});
    let listener = runtime.block_on(tokio::net::TcpListener::bind("127.0.0.1:0")).unwrap();
    let port = listener.local_addr().unwrap().port();
    let app = axum::Router::new().route("/v1/models", axum::routing::get(move || async move {
        ([(axum::http::header::CONTENT_TYPE, "application/json")], catalog.to_string())
    }));
    runtime.spawn(async move { axum::serve(listener, app).await.unwrap() });
    let home = tempfile::tempdir().unwrap();
    let home = home.path().canonicalize().unwrap();
    for dir in ["work", ".claude", ".cli-proxy-api", ".codex", ".codex-work"] { std::fs::create_dir_all(home.join(dir)).unwrap(); }
    std::fs::write(home.join(".cli-proxy-api/config.yaml"), format!("port: {port}\napi-keys:\n  - k\n")).unwrap();
    std::fs::write(home.join(".cli-proxy-api/codex-work.json"), json!({"type": "codex", "account_id": "acc1", "prefix": "work"}).to_string()).unwrap();
    std::fs::write(home.join(".codex-work/.hangar-codex-conta"), json!({"version": 1, "id": "work"}).to_string()).unwrap();
    std::fs::write(home.join(".codex-work/auth.json"), json!({"tokens": {"account_id": "acc1"}}).to_string()).unwrap();
    std::fs::write(home.join(".claude/engines.json"),
        json!({"gpt": {"base_url": format!("http://127.0.0.1:{port}/v1"), "api_key": "k", "model": "gpt-5.5"}}).to_string()).unwrap();
    let open = |account: &str| {
        let body = json!({"name": "s1", "cwd": home.join("work"), "provider": "claude", "headless": false, "engine": "gpt",
            "engine_account": account, "model": "work/gpt-5.5", "permission_mode": "manual"});
        resolve::resolve_open(&SessionOpenRequest::parse(body.to_string().as_bytes()).unwrap(), &OWNER, &local_facts(&home, &runtime))
    };
    let spec = open("work").unwrap().spec;
    assert_eq!(spec.model.as_deref(), Some("gpt-5.5"), "sem o prefixo da conta");
    assert_eq!(spec.account, Account::Engine { name: "gpt".into(), account: Some("work".into()), config_dir: None,
        context_window: Some(400000), context_window_unknown: false });
    let refused = open("outra").unwrap_err();
    assert_eq!((refused.status, refused.code), (400, Some("erro_cliproxy_conta")), "{}", refused.msg);
    let route = facts::fixed_account(&crate::accounts::AccountService::new(crate::accounts::environment::AccountEnvironment::from_map(
        [("HOME".to_owned(), home.to_string_lossy().into_owned())].into())), "gpt", "work").unwrap();
    let ctx = claude::ClaudeContext { plugin_roots: &[], bridge: None, bridge_key: "k", runtime_config: &Value::Null,
        server_env: &Default::default(), settings: None, read_only: None, windows: false, initial_prompt: None, engine_route: None };
    let command = claude::pane(&spec, "sid", &claude::ClaudeContext { engine_route: Some(&route), ..ctx }).command;
    let home_text = home.join(".codex-work").to_string_lossy().into_owned();
    assert_eq!(command[..12], ["hangar-engine", "--exec", "gpt", "--account", "work", "--account-home", &home_text,
        "--account-base-url", &format!("http://127.0.0.1:{port}"), "--model", "gpt-5.5", "--context"]);
    assert_eq!(route.credential_id, format!("codex:{home_text}"));
}

/// A abertura inteira pelo lado Rust do harness: nasceu, a ordem do diário é a do Python e o spec
/// fica gravado; o pane recusado não chega ao "criada" nem grava o spec.
#[cfg(target_os = "linux")]
#[test]
fn the_claude_terminal_open_runs_in_the_python_order() {
    let runtime = test_runtime();
    for (name, status, last) in [("create_claude_terminal_default", 200, "sessao.criada"), ("create_claude_terminal_tmux_fails", 409, "sessao.criar_recusada")] {
        let (_, fixture) = create_fixtures().into_iter().find(|(n, _)| n == name).unwrap();
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        materialize(&fixture, &root);
        let repo = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        contract::prepare(&fixture["scenario"], &root, &repo).unwrap();
        let env = [("HOME", root.join("home")), ("PATH", root.join("bin")), ("CP_AUTH_TOKEN", "t".into())]
            .map(|(k, v)| (k.to_owned(), v.to_string_lossy().into_owned())).into_iter().collect();
        let raw = runtime.block_on(contract::run(&fixture["scenario"], &root, env));
        assert_eq!(raw["steps"][0]["status"], status, "{name}: {}", raw["steps"][0]["body"]);
        let events: Vec<String> = raw["diary"].as_array().unwrap().iter().map(|e| format!("{}:{}", e["evento"].as_str().unwrap(), e["etapa"].as_str().unwrap_or(""))).collect();
        let at = |e: &str| events.iter().position(|x| x == e).unwrap_or_else(|| panic!("{name}: {e} em {events:?}"));
        assert!(at("sessao.criar.inicio:") < at("sessao.criar_etapa:validar") && at("sessao.criar_etapa:confiar_pasta") < at("sessao.criar_etapa:criar_terminal"));
        assert_eq!(events[events.len() - 2].split(':').next().unwrap(), last, "{name}: {events:?}");
        let specs = root.join("home/.hangar/session-specs");
        assert_eq!(std::fs::read_dir(&specs).map(|d| d.count()).unwrap_or(0), usize::from(status == 200), "{name}: spec gravado só ao nascer");
    }
}

/// Com o servidor fora, `hangar-open` não tem como limpar o que o nome reusado deixou (grupo, `then`,
/// fila): recusa, em vez de a sessão nova nascer com o grupo e a fila da antiga.
#[test]
fn the_terminal_command_refuses_a_name_with_leftovers() {
    use open::OpenHost;
    let runtime = test_runtime();
    let home = tempfile::tempdir().unwrap();
    let host = local::LocalHost::new([("HOME".to_owned(), home.path().to_string_lossy().into_owned())].into(), None);
    runtime.block_on(host.leave_old_group("par externo")).expect("nada ficou: abre");
    for left in [".hangar-pair/par-externo.json", ".hangar-chain/par-externo.json", ".hangar-queue/par-externo.jsonl"] {
        let path = home.path().join(".claude").join(left);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, "{}").unwrap();
        let error = runtime.block_on(host.leave_old_group("par externo")).err().unwrap_or_else(|| panic!("{left} ficou e abriu"));
        assert_eq!((error.status, error.code), (409, Some("session_open_name_needs_server")), "{left}");
        std::fs::remove_file(&path).unwrap();
    }
}

/// O passo da criação, pelo nome sanitizado da sessão nova: só quem abriu o registro o apaga (o
/// bastão acompanha a criação por dentro dele), e sem criação em curso não há passo.
#[test]
fn the_creation_progress_belongs_to_whoever_opened_it() {
    let name = "progresso teste";
    {
        let _outer = open::Progress::track(name);
        assert_eq!(open::progress("progresso-teste"), json!({"step": "preparando", "params": {}}));
        {
            let _inner = open::Progress::track(name);
            open::progress_step(name, "conta", json!({"conta": "b"}));
        }
        assert_eq!(open::progress(name), json!({"step": "conta", "params": {"conta": "b"}}), "o de dentro não apaga");
    }
    assert_eq!(open::progress(name), json!({"step": null, "params": {}}));
    open::progress_step(name, "criando", json!({}));
    assert_eq!(open::progress(name)["step"], Value::Null, "passo sem criação em curso não fica");
}

/// Duas aberturas do mesmo nome não correm juntas: a segunda é "nome em uso" até a primeira acabar.
#[test]
fn a_name_being_opened_is_in_use_until_the_open_ends() {
    let home = std::path::Path::new("/casa/de/teste/reserva");
    let first = open::NameClaim::take(home, "s1").unwrap();
    let error = open::NameClaim::take(home, "s1").err().expect("o mesmo nome em curso");
    assert_eq!((error.status, error.code), (409, Some("erro_nome_em_uso")));
    let _other_home = open::NameClaim::take(std::path::Path::new("/outra/casa"), "s1").expect("outra casa é outro nome");
    drop(first);
    open::NameClaim::take(home, "s1").expect("livre de novo depois");
}

/// Multiplexador que não responde não é "nome livre": a resolução recusa com o código do tmux fora.
#[cfg(target_os = "linux")]
#[test]
fn a_silent_multiplexer_does_not_free_the_name() {
    use std::os::unix::fs::PermissionsExt;
    let runtime = test_runtime();
    let home = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(home.path().join("bin")).unwrap();
    std::fs::write(home.path().join("bin/tmux"), "#!/bin/sh\necho 'lost server' >&2\nexit 2\n").unwrap();
    std::fs::set_permissions(home.path().join("bin/tmux"), std::fs::Permissions::from_mode(0o755)).unwrap();
    let error = local_facts(home.path(), &runtime).name_in_use("s1").unwrap_err();
    assert_eq!((error.status, error.code), (503, Some("erro_mux_indisponivel")));
}

/// O nome é conferido de novo no tmux logo antes de sair do grupo antigo: a sessão que nasceu
/// depois da resolução recusa sem efeito, e o tmux calado é 503, nunca "livre".
#[cfg(target_os = "linux")]
#[test]
fn the_name_is_checked_again_in_tmux_before_any_effect() {
    let (raw, _dir, _root) = run_contract("create_claude_terminal_default", |s| s["fakes"]["tmux_late_sessions"] = json!(["s1"]));
    assert_eq!(raw["steps"][0]["body"]["detail"]["code"], "erro_nome_em_uso", "{}", raw["steps"][0]["body"]);
    assert_eq!(raw["steps"][0]["status"], 409);
    let (raw, _dir, _root) = run_contract("create_claude_terminal_default", |s| s["fakes"]["tmux_new_session"] = json!({"silent": "all"}));
    assert_eq!((raw["steps"][0]["status"].clone(), raw["steps"][0]["body"]["detail"]["code"].clone()),
        (json!(503), json!("erro_mux_indisponivel")), "{}", raw["steps"][0]["body"]);
    let spawned = raw["subprocesses"].as_array().unwrap().iter().any(|p| p["argv"][0] == "new-session");
    assert!(!spawned, "nenhum new-session sem a conferência");
}

/// O convidado com login é achado pelo hash do token no `guests.json` (que é do Python), como no
/// `lookup_token`; arquivo ausente, ilegível ou com um convidado torto não deixa ninguém entrar.
#[test]
fn a_login_guest_is_found_by_the_token_hash() {
    let base = tempfile::tempdir().unwrap();
    let hash = |t: &str| ring::digest::digest(&ring::digest::SHA256, t.as_bytes()).as_ref().iter().map(|b| format!("{b:02x}")).collect::<String>();
    assert_eq!(server::login_guest(base.path(), b"tok"), None);
    let guests = json!({"guests": [{"id": "g1", "name": "Ana", "token_hash": hash("tok"), "root": "/casa/ana", "sees_owner": false,
        "owner_sees": true}], "sessions": {}});
    std::fs::write(base.path().join("guests.json"), guests.to_string()).unwrap();
    assert_eq!(server::login_guest(base.path(), b"tok"), Some(server::LoginGuest { id: "g1".into(), name: "Ana".into(), root: "/casa/ana".into() }));
    assert_eq!(server::login_guest(base.path(), b"outro"), None);
    let mut broken = guests.clone();
    broken["guests"].as_array_mut().unwrap().push(json!({"id": "g2"}));
    std::fs::write(base.path().join("guests.json"), broken.to_string()).unwrap();
    assert_eq!(server::login_guest(base.path(), b"tok"), None, "um torto deixa o arquivo ilegível, como no Python");
}

/// O dono da sessão do convidado vai ao `guests.json` como o `claim` do Python grava: entrada
/// `{"guest", "life"}`, o resto do arquivo intacto, 0600; ilegível não é sobrescrito; e espera a
/// `guests.lock` que o Python segura.
#[test]
fn the_guest_claim_writes_guests_json_under_the_shared_lock() {
    let base = tempfile::tempdir().unwrap();
    let file = base.path().join("guests.json");
    server::claim_guest(base.path(), "s1", "g1", None).unwrap();
    let written: Value = serde_json::from_slice(&std::fs::read(&file).unwrap()).unwrap();
    assert_eq!(written, json!({"guests": [], "sessions": {"s1": {"guest": "g1", "life": null}}}));
    let ana = json!({"id": "g1", "name": "Ana", "token_hash": "h", "root": "/casa/ana", "sees_owner": false, "owner_sees": true});
    std::fs::write(&file, json!({"guests": [ana], "sessions": {"velho": {"guest": "g1", "life": "t:1"}}}).to_string()).unwrap();
    server::claim_guest(base.path(), "s2", "g1", Some("t:5")).unwrap();
    let written: Value = serde_json::from_slice(&std::fs::read(&file).unwrap()).unwrap();
    assert_eq!(written, json!({"guests": [ana], "sessions": {"velho": {"guest": "g1", "life": "t:1"}, "s2": {"guest": "g1", "life": "t:5"}}}));
    #[cfg(unix)] {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(std::fs::metadata(&file).unwrap().permissions().mode() & 0o777, 0o600);
    }
    std::fs::write(&file, b"{torto").unwrap();
    assert!(server::claim_guest(base.path(), "s3", "g1", None).is_err());
    assert_eq!(std::fs::read(&file).unwrap(), b"{torto", "ilegível fica como está");

    std::fs::write(&file, b"{}").unwrap();
    let lock = std::fs::OpenOptions::new().read(true).append(true).create(true).open(base.path().join("guests.lock")).unwrap();
    lock.lock().unwrap();
    let (done, wait) = std::sync::mpsc::channel();
    let dir = base.path().to_path_buf();
    let writer = std::thread::spawn(move || done.send(server::claim_guest(&dir, "s4", "g1", None).is_ok()).unwrap());
    assert!(wait.recv_timeout(std::time::Duration::from_millis(200)).is_err(), "gravou com a trava do Python presa");
    drop(lock);
    assert_eq!(wait.recv_timeout(std::time::Duration::from_secs(30)), Ok(true));
    writer.join().unwrap();
    let written: Value = serde_json::from_slice(&std::fs::read(&file).unwrap()).unwrap();
    assert_eq!(written["sessions"]["s4"], json!({"guest": "g1", "life": null}));
}

/// A ponte só aceita o id de um convidado que existe, ou nada (o dono); qualquer outra forma,
/// inclusive o `guest_root` antigo, é recusada em vez de virar o dono.
#[test]
fn the_bridge_refuses_a_guest_field_that_is_not_an_id() {
    let base = tempfile::tempdir().unwrap();
    std::fs::write(base.path().join("guests.json"), json!({"guests": [{"id": "g1", "name": "Ana", "token_hash": "h", "root": "/casa/ana",
        "sees_owner": false, "owner_sees": true}], "sessions": {}}).to_string()).unwrap();
    let guest = |envelope: Value| server::bridge_guest(&envelope, base.path());
    assert_eq!(guest(json!({"request": {}})).ok(), Some(None));
    assert_eq!(guest(json!({"guest": null})).ok(), Some(None));
    assert_eq!(guest(json!({"guest": "g1"})).ok().flatten().map(|g| g.root), Some(PathBuf::from("/casa/ana")));
    assert_eq!(guest(json!({"guest": "nada"})).err().map(|e| e.status), Some(403));
    for bad in [json!({"guest": 1}), json!({"guest": {"id": "g1"}}), json!({"guest": ""}), json!({"guest_root": "/casa/ana"})] {
        assert_eq!(guest(bad.clone()).err().map(|e| e.status), Some(400), "{bad}");
    }
}

/// O Rust espera a trava que o próprio `atomico.locked` do Python segura no `guests.lock`.
#[cfg(unix)]
#[test]
fn the_rust_claim_waits_for_the_lock_python_holds() {
    use std::io::BufRead;
    let base = tempfile::tempdir().unwrap();
    let backend = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../backend");
    let script = "import sys\nfrom app import atomico\nwith atomico.locked(sys.argv[1]):\n    print('preso', flush=True)\n    sys.stdin.read()\n";
    let mut python = std::process::Command::new("python3").args(["-c", script]).arg(base.path().join("guests.lock")).current_dir(&backend)
        .stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped()).spawn().unwrap();
    let mut line = String::new();
    std::io::BufReader::new(python.stdout.take().unwrap()).read_line(&mut line).unwrap();
    assert_eq!(line.trim(), "preso");
    let (done, wait) = std::sync::mpsc::channel();
    let dir = base.path().to_path_buf();
    let writer = std::thread::spawn(move || done.send(server::claim_guest(&dir, "s1", "g1", None).is_ok()).unwrap());
    assert!(wait.recv_timeout(std::time::Duration::from_millis(300)).is_err(), "gravou com a trava do Python presa");
    drop(python.stdin.take());
    assert_eq!(wait.recv_timeout(std::time::Duration::from_secs(30)), Ok(true));
    writer.join().unwrap();
    assert!(python.wait().unwrap().success());
}

/// A fila que a sessão morta deixou no nome sai antes do pane novo (o histórico do Rust a mostraria
/// como mensagens dela); a de outro nome fica.
#[test]
fn a_reused_name_does_not_inherit_the_dead_session_queue() {
    let base = tempfile::tempdir().unwrap();
    let queue = base.path().join(".hangar-queue");
    std::fs::create_dir_all(&queue).unwrap();
    for file in ["par-externo.jsonl", "par-externo.jsonl.tmp", "outra.jsonl"] { std::fs::write(queue.join(file), "{}\n").unwrap(); }
    server::forget_queue(base.path(), "par externo").unwrap();
    let left: Vec<String> = std::fs::read_dir(&queue).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
    assert_eq!(left, ["outra.jsonl"]);
    server::forget_queue(base.path(), "nenhuma").expect("sem fila é nada a apagar");
}

/// O vínculo `then` (`ThenLink`, `.hangar-chain/<nome>.json`) da sessão morta sai com o nome reusado,
/// como `ThenLink(name).clear()`; o de outro nome fica.
#[test]
fn a_reused_name_does_not_inherit_the_dead_session_then_link() {
    let base = tempfile::tempdir().unwrap();
    let chain = base.path().join(".hangar-chain");
    std::fs::create_dir_all(&chain).unwrap();
    for file in ["par-externo.json", "par-externo.json.tmp", "outra.json"] { std::fs::write(chain.join(file), "{}").unwrap(); }
    server::forget_queue(base.path(), "par externo").unwrap();
    let left: Vec<String> = std::fs::read_dir(&chain).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
    assert_eq!(left, ["outra.json"]);
}

/// O provedor lembrado vai ao `runtime-config.json` sem mexer no resto dele; o mesmo valor não regrava
/// e o arquivo ilegível fica como está, com a falha devolvida.
#[test]
fn the_remembered_provider_keeps_the_rest_of_the_runtime_config() {
    let home = tempfile::tempdir().unwrap();
    let file = home.path().join("runtime-config.json");
    server::remember_provider(home.path(), "claude").unwrap();
    assert_eq!(serde_json::from_slice::<Value>(&std::fs::read(&file).unwrap()).unwrap(), json!({"last_session_provider": "claude"}));
    std::fs::write(&file, json!({"scan_roots": "~/a", "last_session_provider": "codex", "nested": {"x": [1]}}).to_string()).unwrap();
    server::remember_provider(home.path(), "claude").unwrap();
    assert_eq!(serde_json::from_slice::<Value>(&std::fs::read(&file).unwrap()).unwrap(),
        json!({"scan_roots": "~/a", "last_session_provider": "claude", "nested": {"x": [1]}}));
    std::fs::write(&file, "{quebrado").unwrap();
    assert!(server::remember_provider(home.path(), "claude").is_err());
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "{quebrado");
}

/// O `backend/.env` que o pydantic do Python lê (sem exportar) vale para a abertura do Rust: a
/// variável do processo vence a do arquivo, e só as `CP_*` entram.
#[test]
fn the_server_env_reads_the_backend_dotenv_like_python() {
    use std::collections::BTreeMap;
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join(".env");
    std::fs::write(&file, "CP_SCAN_ROOTS=~/a,~/b\nexport CP_CLAUDE_FUNCTION_HOOKS=\"on\"\nCP_AUTH_TOKEN=velho\nOUTRA=x\n# CP_X=y\n").unwrap();
    let process: BTreeMap<String, String> = [("CP_AUTH_TOKEN", "novo"), ("HOME", "/h")].map(|(k, v)| (k.to_owned(), v.to_owned())).into();
    let env = server::server_env(process, &file);
    assert_eq!(env.get("CP_SCAN_ROOTS").map(String::as_str), Some("~/a,~/b"));
    assert_eq!(env.get("CP_CLAUDE_FUNCTION_HOOKS").map(String::as_str), Some("on"));
    assert_eq!(env.get("CP_AUTH_TOKEN").map(String::as_str), Some("novo"), "o processo vence o arquivo");
    assert!(!env.contains_key("OUTRA") && !env.contains_key("CP_X"), "{env:?}");
    assert_eq!(server::server_env(BTreeMap::new(), &dir.path().join("ausente")), BTreeMap::new());
}

/// Um cenário de criação pelo lado Rust do harness, com `patch` no cenário e os repositórios Git dele
/// inicializados. Devolve o resultado e a raiz (viva enquanto o `TempDir` viver).
#[cfg(target_os = "linux")]
fn run_contract(name: &str, patch: impl FnOnce(&mut Value)) -> (Value, tempfile::TempDir, PathBuf) {
    run_contract_with(name, patch, |_| {})
}

/// `run_contract` com `before` mexendo na raiz pronta, logo antes da abertura.
#[cfg(target_os = "linux")]
fn run_contract_with(name: &str, patch: impl FnOnce(&mut Value), before: impl FnOnce(&std::path::Path)) -> (Value, tempfile::TempDir, PathBuf) {
    let (_, mut fixture) = create_fixtures().into_iter().find(|(n, _)| n == name).unwrap();
    patch(&mut fixture["scenario"]);
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    materialize(&fixture, &root);
    for repo in fixture["scenario"]["state"]["git_repos"].as_array().into_iter().flatten() {
        let path = contract::place(repo["path"].as_str().unwrap(), &root);
        for (file, text) in repo["files"].as_object().into_iter().flatten() {
            std::fs::write(std::path::Path::new(&path).join(file), text.as_str().unwrap()).unwrap();
        }
        for args in [&["init", "-q", "-b", "main"][..], &["add", "-A"], &["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"]] {
            assert!(std::process::Command::new("git").arg("-C").arg(&path).args(args).status().unwrap().success());
        }
    }
    let repo = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    contract::prepare(&fixture["scenario"], &root, &repo).unwrap();
    before(&root);
    let env = [("HOME", root.join("home")), ("PATH", root.join("bin")), ("CP_AUTH_TOKEN", "t".into())]
        .map(|(k, v)| (k.to_owned(), v.to_string_lossy().into_owned())).into_iter().collect();
    let raw = test_runtime().block_on(contract::run(&fixture["scenario"], &root, env));
    (raw, dir, root)
}

/// S-40 em Pi, omp e Kimi: o prompt inicial entra na fila durável da sessão (a do `PromptQueue`, que
/// entrega quando o agente fica pronto), carimbado antes da conversa existir, como o bastão fazia.
/// Pane que não nasce não deixa a entrada para trás.
#[cfg(target_os = "linux")]
#[test]
fn the_initial_prompt_of_pi_omp_and_kimi_waits_in_the_durable_queue() {
    for name in ["create_pi_terminal", "create_omp_terminal", "create_kimi_terminal"] {
        let (raw, _dir, root) = run_contract(name, |s| s["steps"][0]["json"]["initial_prompt"] = json!("-leia o plano"));
        assert_eq!(raw["steps"][0]["status"], 200, "{name}: {}", raw["steps"][0]["body"]);
        let session = raw["steps"][0]["body"]["name"].as_str().unwrap();
        let text = std::fs::read_to_string(root.join(format!("home/.claude/.hangar-queue/{session}.jsonl"))).unwrap_or_default();
        let rows: Vec<Value> = text.lines().map(|l| serde_json::from_str(l).unwrap()).collect();
        assert_eq!(rows.len(), 1, "{name}: {text}");
        assert_eq!((&rows[0]["text"], &rows[0]["delivered"], &rows[0]["pre_transcript"]), (&json!("-leia o plano"), &json!(false), &json!(true)), "{name}");
        assert!(rows[0]["id"].as_str().is_some_and(|id| id.len() == 32) && rows[0]["ts"].as_f64().is_some(), "{name}: {}", rows[0]);
        assert!(raw["steps"][0]["body"]["avisos"].as_array().unwrap().is_empty(), "{name}: entregue não avisa");
    }
    let (raw, _dir, root) = run_contract("create_pi_terminal", |s| {
        s["steps"][0]["json"]["initial_prompt"] = json!("oi");
        s["fakes"]["tmux_new_session"] = json!({"rc": 1, "stderr": "boom"});
    });
    assert_ne!(raw["steps"][0]["status"], 200);
    assert!(!root.join("home/.claude/.hangar-queue/p1.jsonl").exists(), "pane que não nasceu deixou a fila");
}

/// Sem o registro a sessão não tem como ser reaberta nem reconhecida pela chave: falhar ao gravá-lo é
/// falha da abertura, antes do pane, e a worktree que ela criou é desfeita.
#[cfg(target_os = "linux")]
#[test]
fn an_unwritten_record_fails_the_open_before_the_pane() {
    let block = |root: &std::path::Path| {
        std::fs::create_dir_all(root.join("home/.hangar")).unwrap();
        std::fs::write(root.join("home/.hangar/session-specs"), "não é pasta").unwrap();
    };
    let (raw, _dir, _root) = run_contract_with("create_claude_terminal_default", |_| {}, block);
    assert_eq!((raw["steps"][0]["status"].clone(), raw["steps"][0]["body"]["detail"]["code"].clone()),
        (json!(500), json!("erro_criacao_sessao")), "{}", raw["steps"][0]["body"]);
    assert!(!raw["subprocesses"].as_array().unwrap().iter().any(|p| p["argv"][0] == "new-session"), "nenhum pane sem registro");
    let (raw, _dir, root) = run_contract_with("create_worktree_new_branch", |_| {}, block);
    assert_eq!(raw["steps"][0]["status"], 500, "{}", raw["steps"][0]["body"]);
    let repo = contract::place("<ROOT>/home/pessoal/repo", &root);
    let branches = std::process::Command::new("git").args(["-C", &repo, "branch", "--list"]).output().unwrap();
    assert_eq!(String::from_utf8_lossy(&branches.stdout).trim(), "* main", "a branch criada sai junto");
}

/// A conta do Hangar fica sob a guarda compartilhada desde o `hangar-conta --prep` até o pane: a
/// exclusão da conta (exclusiva) não passa no meio.
#[cfg(target_os = "linux")]
#[test]
fn the_account_guard_covers_the_preparation() {
    let (raw, _dir, _root) = run_contract_with("create_claude_terminal_hangar_account", |_| {}, |root| {
        use std::os::unix::fs::PermissionsExt;
        let script = concat!("#!/bin/sh\nheld=0\nfor f in \"$HOME\"/.hangar/account-locks/*.lock; do\n",
            "  [ -e \"$f\" ] && ! flock -n -x \"$f\" true && held=1\ndone\n",
            "[ $held = 1 ] || { echo 'hangar-conta: a guarda da conta estava livre' >&2; exit 1; }\n");
        std::fs::write(root.join("bin/hangar-conta"), script).unwrap();
        std::fs::set_permissions(root.join("bin/hangar-conta"), std::fs::Permissions::from_mode(0o755)).unwrap();
    });
    assert_eq!(raw["steps"][0]["status"], 200, "{}", raw["steps"][0]["body"]);
}

/// Sem resposta do tmux a sessão pode ter nascido: a abertura responde incerta e não desfaz a
/// worktree (desfazer apagaria a pasta e a branch debaixo de um pane vivo).
#[cfg(target_os = "linux")]
#[test]
fn an_uncertain_terminal_keeps_the_worktree() {
    let (raw, _dir, root) = run_contract("create_worktree_rollback_on_tmux_failure",
        |s| s["fakes"]["tmux_new_session"] = json!({"silent": true}));
    assert_eq!((raw["steps"][0]["status"].clone(), raw["steps"][0]["body"]["detail"]["code"].clone()),
        (json!(504), json!("session_open_uncertain")), "{}", raw["steps"][0]["body"]);
    let branches = std::process::Command::new("git").arg("-C").arg(root.join("home/pessoal/repo")).args(["branch", "--list", "feat/y"]).output().unwrap();
    assert!(String::from_utf8_lossy(&branches.stdout).contains("feat/y"), "a branch criada fica");
}

// ── registro ─────────────────────────────────────────────────────────────────────────────────

fn fixture_spec(name: &str) -> SessionSpec {
    let (_, fixture) = create_fixtures().into_iter().find(|(n, _)| n == name).unwrap();
    SessionSpec { key: "0123456789abcdef0123456789abcdef".into(), ..resolve_fixture(&fixture).unwrap().spec }
}

#[test]
fn the_record_round_trips_by_key_and_refuses_what_it_cannot_read() {
    let home = tempfile::tempdir().unwrap();
    let spec = fixture_spec("create_claude_headless_then_launch");
    record::write(home.path(), &spec).unwrap();
    assert_eq!(record::read(home.path(), &spec.key).unwrap(), Some(spec.clone()));
    // Troca atômica: nada de temporário sobrando ao lado.
    let files: Vec<_> = std::fs::read_dir(record::dir(home.path())).unwrap().flatten().map(|e| e.file_name()).collect();
    assert_eq!(files, [std::ffi::OsString::from(format!("{}.json", spec.key))]);
    assert_eq!(record::read(home.path(), &"f".repeat(32)).unwrap(), None);
    assert_eq!(record::read(home.path(), "../x").unwrap_err().kind(), std::io::ErrorKind::InvalidInput);
    let path = record::dir(home.path()).join(format!("{}.json", spec.key));
    let mut newer = serde_json::to_value(&spec).unwrap();
    newer["version"] = json!(2);
    std::fs::write(&path, newer.to_string()).unwrap();
    assert_eq!(record::read(home.path(), &spec.key).unwrap_err().kind(), std::io::ErrorKind::InvalidData);
    std::fs::write(&path, "{").unwrap();
    assert_eq!(record::read(home.path(), &spec.key).unwrap_err().kind(), std::io::ErrorKind::InvalidData);
}

/// O sidecar que o Python grava (o `state` das fixtures) vira spec para a sessão viva sem registro.
fn sidecar_home(fixture: &str, kind: &str, name: &str, patch: impl FnOnce(&mut Value)) -> tempfile::TempDir {
    let (_, fixture) = create_fixtures().into_iter().find(|(n, _)| n == fixture).unwrap();
    let mut meta = fixture["scenario"]["state"]["files"][format!("<ROOT>/home/.hangar/{kind}/{name}.json")].clone();
    patch(&mut meta);
    let home = tempfile::tempdir().unwrap();
    let dir = home.path().join(".hangar").join(kind);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join(format!("{name}.json")), meta.to_string()).unwrap();
    home
}

#[test]
fn live_sessions_without_a_record_get_their_spec_from_the_sidecar() {
    let home = sidecar_home("create_inherit_from_headless_creator", "claude-headless", "mae", |_| {});
    let spec = record::from_sidecars(home.path(), "mae").unwrap().unwrap();
    assert_eq!((spec.provider, spec.surface, spec.key.as_str()), (AgentProvider::Claude, Surface::Headless, "a".repeat(32).as_str()));
    assert_eq!(spec.account, Account::Claude { config_dir: "<ROOT>/home/.claude-b".into() });
    assert_eq!((spec.account_source, spec.permission_mode, spec.jev), (AccountSource::Explicit, Some(PermissionMode::AcceptEdits), false));

    let home = sidecar_home("create_inherit_from_codex_creator", "codex-sessions", "mae-codex", |_| {});
    let spec = record::from_sidecars(home.path(), "mae-codex").unwrap().unwrap();
    assert_eq!((spec.provider, spec.surface), (AgentProvider::Codex, Surface::Headless));
    assert_eq!(spec.account, Account::Codex { account_id: "default".into() });
    assert_eq!(spec.permission_mode, Some(PermissionMode::ApproveForMe));
    // S-05: modo que o Hangar não conhece fica ausente; quem reabre recusa em vez de abrir em Full Access.
    let home = sidecar_home("create_inherit_from_codex_creator", "codex-sessions", "mae-codex", |m| m["permission_mode"] = json!("Tudo"));
    assert_eq!(record::from_sidecars(home.path(), "mae-codex").unwrap().unwrap().permission_mode, None);
    // CDX-9: sidecar Codex sem `key` não dá spec.
    let home = sidecar_home("create_inherit_from_codex_creator", "codex-sessions", "mae-codex", |m| { m.as_object_mut().unwrap().remove("key"); });
    assert_eq!(record::from_sidecars(home.path(), "mae-codex").unwrap(), None);
    assert_eq!(record::from_sidecars(home.path(), "pi-sem-sidecar").unwrap(), None);
}

/// Codex vivo: o modo que o `hangar-codex-tui` gravou por último no sidecar vence o da criação
/// (valor válido só); o resto vem do registro, e sem registro, do sidecar.
#[test]
fn a_live_codex_session_keeps_the_mode_its_terminal_last_wrote() {
    let key = "b".repeat(32);
    let written = |mode: &str| sidecar_home("create_inherit_from_codex_creator", "codex-sessions", "mae-codex", |m| m["permission_mode"] = json!(mode));
    let born = SessionSpec { key: key.clone(), name: "mae-codex".into(), model: Some("gpt-5.5".into()),
        permission_mode: Some(PermissionMode::AskForApproval), ..fixture_spec("create_codex_headless_default") };
    let home = written("Full Access");
    assert_eq!(record::live(home.path(), "mae-codex").unwrap().unwrap().permission_mode, Some(PermissionMode::FullAccess), "sem registro, o sidecar");
    record::write(home.path(), &born).unwrap();
    let spec = record::live(home.path(), "mae-codex").unwrap().unwrap();
    assert_eq!((spec.permission_mode, spec.model.as_deref()), (Some(PermissionMode::FullAccess), Some("gpt-5.5")));
    let home = written("Tudo");
    record::write(home.path(), &born).unwrap();
    assert_eq!(record::live(home.path(), "mae-codex").unwrap().unwrap().permission_mode, Some(PermissionMode::AskForApproval), "valor inválido não vence");
}

/// Sidecar quebrado não é "sessão sem sidecar": quem reabre ou herda precisa saber que não leu.
#[test]
fn unreadable_sidecars_are_errors_not_absent() {
    let cases = [("claude-headless", "{"), ("codex-sessions", "[]"), ("claude-headless", r#"{"key":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}"#)];
    for (kind, content) in cases {
        let home = tempfile::tempdir().unwrap();
        let dir = home.path().join(".hangar").join(kind);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("s.json"), content).unwrap();
        let read = record::from_sidecars(home.path(), "s");
        assert_eq!(read.as_ref().map_err(std::io::Error::kind).err(), Some(std::io::ErrorKind::InvalidData), "{kind} {content}: {read:?}");
    }
}

/// Os fatos de verdade numa casa de teste, sem tmux de quem roda o teste: o da casa responde "sem
/// servidor" (nenhum pane e nenhum `/proc` é lido), a não ser que o teste já tenha posto outro. Casa
/// que não existe fica sem existir.
fn local_facts(home: &std::path::Path, runtime: &tokio::runtime::Runtime) -> facts::LocalFacts {
    #[cfg(unix)]
    if home.is_dir() && !home.join("bin/tmux").exists() {
        use std::os::unix::fs::PermissionsExt;
        std::fs::create_dir_all(home.join("bin")).unwrap();
        std::fs::write(home.join("bin/tmux"), "#!/bin/sh\necho 'no server running on /tmp/tmux-teste/default' >&2\nexit 1\n").unwrap();
        std::fs::set_permissions(home.join("bin/tmux"), std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    let env = [("HOME", home), ("PATH", &home.join("bin"))].map(|(k, v)| (k.to_owned(), v.to_string_lossy().into_owned()));
    facts::LocalFacts::new(crate::accounts::environment::AccountEnvironment::from_map(env.into_iter().collect()), runtime.handle().clone())
        .with_terminal(crate::list::mux::Mux::with_program(home.join("bin/tmux"), std::time::Duration::from_secs(2)),
            std::sync::Arc::new(crate::list::procs::SystemProcs::default()))
}

fn test_runtime() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().unwrap()
}

#[test]
fn an_unreadable_creator_record_refuses_instead_of_inheriting_nothing() {
    let runtime = test_runtime();
    let home = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(home.path().join("work")).unwrap();
    std::fs::create_dir_all(home.path().join(".hangar/codex-sessions")).unwrap();
    std::fs::write(home.path().join(".hangar/codex-sessions/mae.json"), "{quebrado").unwrap();
    let body = json!({"name": "filha", "cwd": home.path().join("work"), "provider": "claude", "creator": "mae"});
    let request = SessionOpenRequest::parse(body.to_string().as_bytes()).unwrap();
    let result = resolve::resolve_open(&request, &OWNER, &local_facts(home.path(), &runtime));
    assert_eq!(result.err().map(|e| (e.status, e.code)), Some((409, Some("erro_criadora_ilegivel"))));
}

proptest! {
    /// Sidecar e registro são arquivos de fora: conteúdo qualquer nunca derruba a leitura.
    #[test]
    fn records_and_sidecars_never_panic(value in prop_oneof![
        Just(Value::Null), any::<i64>().prop_map(Value::from), ".{0,12}".prop_map(Value::from),
        proptest::collection::vec((prop::sample::select(vec!["key", "cwd", "name", "config_dir", "engine", "permission_mode",
            "headless", "jev", "service_tier", "codex_account", "context_window", "version", "provider"]),
            prop_oneof![Just(Value::Null), any::<bool>().prop_map(Value::from), "[a-f0-9]{0,40}".prop_map(Value::from),
                any::<i64>().prop_map(Value::from)]), 0..10)
            .prop_map(|fields| Value::Object(fields.into_iter().map(|(k, v)| (k.to_owned(), v)).collect())),
    ]) {
        let home = tempfile::tempdir().unwrap();
        for kind in ["claude-headless", "codex-sessions", "session-specs"] {
            let dir = home.path().join(".hangar").join(kind);
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join(if kind == "session-specs" { "0123456789abcdef0123456789abcdef.json" } else { "s.json" }), value.to_string()).unwrap();
        }
        let _ = record::from_sidecars(home.path(), "s");
        let _ = record::read(home.path(), "0123456789abcdef0123456789abcdef");
    }
}

proptest! {
    /// Pedido qualquer que passa a forma nunca derruba a resolução.
    #[test]
    fn resolve_never_panics(fields in proptest::collection::vec((
        prop::sample::select(vec!["provider", "headless", "jev", "inherit", "config_dir", "engine", "model", "effort",
            "permission_mode", "subagent_model", "codex_account", "omp_profile", "service_tier", "creator", "read_only",
            "engine_account", "branch", "new_branch", "initial_prompt", "name"]),
        prop_oneof![any::<bool>().prop_map(Value::from), "[a-zA-Z0-9 ./~-]{1,8}".prop_map(Value::from),
            prop::sample::select(vec!["claude", "codex", "pi", "omp", "kimi", "mae", "mae-codex", "priority", "plan",
                "Full Access", "<ROOT>/home/.claude-b", "kimi-k3", "high", "会话"]).prop_map(Value::from)],
    ), 0..8)) {
        let (_, fixture) = create_fixtures().into_iter().find(|(n, _)| n == "create_inherit_from_terminal_creator").unwrap();
        let mut object = json!({"name": "s1", "cwd": "<ROOT>/work/proj"});
        for (key, value) in fields { object[key] = value; }
        if let Ok(request) = SessionOpenRequest::parse(&serde_json::to_vec(&object).unwrap()) {
            let mut facts = FixtureFacts::of(&fixture);
            facts.fakes = json!({});
            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| resolve::resolve_open(&request, &OWNER, &facts)))
                .map_err(|_| TestCaseError::fail("resolve_open entrou em pânico"))?;
        }
    }
}

proptest! {
    #[test]
    fn parse_never_panics_on_bytes(body in proptest::collection::vec(any::<u8>(), 0..256)) {
        let _ = SessionOpenRequest::parse(&body);
    }

    #[test]
    fn parse_never_panics_on_objects(fields in proptest::collection::vec((
        prop::sample::select(vec!["name", "cwd", "provider", "headless", "jev", "inherit", "claude_customizations",
            "service_tier", "creator", "branch", "new_branch", "x"]),
        prop_oneof![Just(Value::Null), any::<bool>().prop_map(Value::from), ".{0,6}".prop_map(Value::from),
            any::<i64>().prop_map(Value::from), Just(json!({"plugins": {"a": true}})), Just(json!([1]))],
    ), 0..10)) {
        let object: serde_json::Map<String, Value> = fields.into_iter().map(|(k, v)| (k.to_owned(), v)).collect();
        let _ = SessionOpenRequest::parse(&serde_json::to_vec(&object).unwrap());
    }
}
