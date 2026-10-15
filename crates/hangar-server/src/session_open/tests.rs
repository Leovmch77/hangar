//! O esperado vem das fixtures do Python (`backend/tests/fixtures/contract/session-open/`), nunca
//! da saída do Rust; as diferenças dos consertos (D-001, D-011) estão nomeadas onde aparecem.
use super::*;
use proptest::prelude::*;
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
struct FixtureFacts { files: serde_json::Map<String, Value>, dirs: Vec<String>, tmux: Vec<Value>, fakes: Value }

/// A ponte do ditado com o Rust fora, como o harness a responde (`session_open_contract.py:941`).
const HARNESS_BRIDGE_DOWN: &str = "O servidor Rust de organização está indisponível.";
const HOME: &str = "<ROOT>/home";

impl FixtureFacts {
    fn of(fixture: &Value) -> Self {
        let state = &fixture["scenario"]["state"];
        Self {
            files: state["files"].as_object().cloned().unwrap_or_default(),
            dirs: state["dirs"].as_array().into_iter().flatten().filter_map(Value::as_str).map(str::to_owned).collect(),
            tmux: state["tmux_sessions"].as_array().cloned().unwrap_or_default(),
            fakes: fixture["scenario"]["fakes"].clone(),
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
}

impl resolve::OpenFacts for FixtureFacts {
    fn providers(&self) -> resolve::ProviderCatalog {
        // O harness põe os cinco binários no PATH; login Claude é a credencial gravada.
        let logged = self.files.keys().any(|path| path.ends_with("/.credentials.json"));
        resolve::ProviderCatalog { available: AgentProvider::ALL.to_vec(),
            connected: if logged { vec![AgentProvider::Claude] } else { vec![] }, disconnected: vec![],
            remembered: self.runtime()["last_session_provider"].as_str().map(str::to_owned) }
    }

    fn creator(&self, name: &str) -> Option<resolve::CreatorFacts> {
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

    fn defaults(&self) -> resolve::ServerDefaults {
        let runtime = self.runtime();
        resolve::ServerDefaults { headless: runtime["headless_default"].as_bool().unwrap_or(true), jev: runtime["jev_padrao"].as_bool().unwrap_or(false) }
    }

    // Sem serviço de contas Codex no harness: nenhuma conta conectada.
    fn codex_logins(&self) -> Vec<resolve::CodexLogin> { vec![] }

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

    // O harness recusa a rede: o catálogo do motor não responde e a janela fica desconhecida.
    fn engine_window(&self, _engine: &str, _model: &str, _account: Option<&str>) -> Option<u64> { None }

    fn codex_home(&self, account_id: &str) -> Result<String, OpenError> {
        if account_id == "default" { return Ok(format!("{HOME}/.codex")); }
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
        let settings = self.file(&format!("{}/settings.json", config_dir.unwrap_or(&format!("{HOME}/.claude"))));
        Ok(settings.and_then(|s| s["permissions"]["defaultMode"].as_str()).map(str::to_owned))
    }

    fn name_in_use(&self, name: &str) -> bool {
        self.tmux.iter().any(|s| s["name"] == name) || self.sidecar("claude-headless", name).is_some() || self.sidecar("codex-sessions", name).is_some()
    }

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
    resolve::resolve_open(&request, &FixtureFacts::of(fixture))
}

#[test]
fn every_refusal_before_launch_has_python_status_code_and_text() {
    let mut compared = 0;
    for (name, fixture) in create_fixtures() {
        let status = python_status(&fixture);
        let detail = &fixture["result"]["steps"][0]["body"]["detail"];
        if status == 200 || detail.is_array() || LAUNCH_REFUSALS.contains(&name.as_str()) || FIXED.contains(&name.as_str()) {
            continue;
        }
        let error = resolve_fixture(&fixture).err().unwrap_or_else(|| panic!("{name}: o Python recusou com {status} e o Rust resolveu"));
        // S-40: sem o prompt inicial na regra, a frase da recusa do só leitura sem terminal perde o "nem prompt inicial".
        let python_msg = detail["msg"].as_str().or(detail.as_str()).unwrap()
            .replace("sessao sem terminal nao aceita read_only nem prompt inicial", "sessao sem terminal nao aceita read_only");
        assert_eq!(error.status as u64, status, "{name}");
        assert_eq!(error.code, detail["code"].as_str(), "{name}");
        assert_eq!(error.msg, python_msg, "{name}");
        assert_eq!(error.params, if detail.is_object() { detail["params"].clone() } else { json!({}) }, "{name}");
        compared += 1;
    }
    assert_eq!(compared, 29, "recusas antes do lançamento nas fixtures");
}

#[test]
fn every_created_session_resolves_to_what_python_launched() {
    let (mut created, mut launches) = (0, 0);
    for (name, fixture) in create_fixtures() {
        let status = python_status(&fixture);
        if status != 200 { continue; }
        let body = &fixture["result"]["steps"][0]["body"];
        let resolved = resolve_fixture(&fixture).unwrap_or_else(|e| panic!("{name}: o Python criou e o Rust recusou: {e}"));
        let spec = &resolved.spec;
        assert_eq!(spec.name, body["name"].as_str().unwrap(), "{name}");
        assert_eq!(spec.provider.name(), body["provider"].as_str().unwrap(), "{name}");
        assert_eq!(spec.surface == Surface::Headless, body["headless"] == true, "{name}");
        assert_eq!(spec.account.config_dir(), body["config_dir"].as_str(), "{name}");
        assert_eq!(spec.account_source.wire(), body["account_source"].as_str(), "{name}");
        assert_eq!(resolved.warnings, serde_json::from_value::<Vec<String>>(body["avisos"].clone()).unwrap(), "{name}");
        created += 1;
        let Some(launched) = launched(&fixture) else { continue };
        launches += 1;
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
    // Todo 200 tem o que o Python lançou: argv do pane ou o sidecar.
    assert_eq!((created, launches), (43, 43));
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

/// S-07 e a falha visível: settings ilegível não vira bypass calado.
#[test]
fn an_unreadable_account_mode_is_a_warning() {
    let (_, fixture) = create_fixtures().into_iter().find(|(n, _)| n == "create_claude_terminal_default").unwrap();
    let request = SessionOpenRequest::parse(&request_body(&fixture)).unwrap();
    let facts = BrokenMode(FixtureFacts::of(&fixture));
    let resolved = resolve::resolve_open(&request, &facts).unwrap();
    assert_eq!(resolved.spec.permission_mode, Some(PermissionMode::BypassPermissions));
    assert_eq!(resolved.warnings.len(), 1, "{:?}", resolved.warnings);
}

struct BrokenMode(FixtureFacts);

impl resolve::OpenFacts for BrokenMode {
    fn providers(&self) -> resolve::ProviderCatalog { self.0.providers() }
    fn creator(&self, name: &str) -> Option<resolve::CreatorFacts> { self.0.creator(name) }
    fn defaults(&self) -> resolve::ServerDefaults { self.0.defaults() }
    fn codex_logins(&self) -> Vec<resolve::CodexLogin> { self.0.codex_logins() }
    fn claude_quotas(&self) -> Vec<Value> { self.0.claude_quotas() }
    fn existing_dir(&self, cwd: &str) -> Option<String> { self.0.existing_dir(cwd) }
    fn config_dirs(&self) -> Result<Vec<String>, OpenError> { self.0.config_dirs() }
    fn engines(&self) -> Vec<String> { self.0.engines() }
    fn supports_fast(&self, e: Option<&str>, m: Option<&str>) -> bool { self.0.supports_fast(e, m) }
    fn fixed_engine_model(&self, e: &str, a: &str, m: Option<&str>) -> Result<String, OpenError> { self.0.fixed_engine_model(e, a, m) }
    fn engine_window(&self, e: &str, m: &str, a: Option<&str>) -> Option<u64> { self.0.engine_window(e, m, a) }
    fn codex_home(&self, id: &str) -> Result<String, OpenError> { self.0.codex_home(id) }
    fn codex_choice(&self, h: Option<&str>, m: Option<&str>, e: Option<&str>, t: Option<ServiceTier>) -> Result<(), resolve::CodexCatalogError> { self.0.codex_choice(h, m, e, t) }
    fn account_mode(&self, _: Option<&str>) -> Result<Option<String>, String> { Err("settings.json: JSON inválido".into()) }
    fn name_in_use(&self, name: &str) -> bool { self.0.name_in_use(name) }
    fn new_key(&self) -> String { self.0.new_key() }
    fn now(&self) -> f64 { self.0.now() }
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
            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| resolve::resolve_open(&request, &facts)))
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
