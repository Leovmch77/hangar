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
