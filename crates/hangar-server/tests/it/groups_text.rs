//! Texto do protocolo no Rust contra o que o Python devolvia (`fixtures/contract/pair_text`), mais as
//! diferenças decididas: grupo com par de fora (I-3A) e a linha do contrato por tipo de membro (I-4A).
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use hangar_server::groups::text::{ContractLine, Kind, OutsideRef, TextArgs, render};
use serde_json::Value;

fn fixtures() -> BTreeMap<String, Value> {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../backend/tests/fixtures/contract/pair_text");
    std::fs::read_dir(&dir).unwrap().map(|e| e.unwrap().path()).filter(|p| p.extension().is_some_and(|x| x == "json"))
        .map(|p| (p.file_stem().unwrap().to_string_lossy().into_owned(), serde_json::from_str(&std::fs::read_to_string(&p).unwrap()).unwrap()))
        .collect()
}

fn expected(name: &str) -> String {
    fixtures()[name]["response"]["text"].as_str().unwrap().to_owned()
}

fn kind_of(body: &Value) -> Kind {
    match body["kind"].as_str().unwrap() {
        "group" => Kind::Group,
        "orq" => Kind::Orq,
        "external" => Kind::External,
        other => panic!("kind {other}"),
    }
}

/// O corpo do `/internal/pair/text` como `TextArgs`. `contract_remote` não carregava dono e o Python o
/// ignorava (TXT-14): o caminho segue como contrato local.
fn args_of(body: &Value) -> TextArgs {
    let s = |k: &str| body[k].as_str().unwrap_or_default().to_owned();
    TextArgs {
        me: s("me"),
        others: body["others"].as_array().map(|a| a.iter().map(|v| v.as_str().unwrap().to_owned()).collect()).unwrap_or_default(),
        task: s("task"),
        harness: body["harness"].as_object().map(|m| m.iter().map(|(k, v)| (k.clone(), v.as_str().unwrap().to_owned())).collect()).unwrap_or_default(),
        contract: ContractLine { path: body["contract"].as_str().map(PathBuf::from), remote_owner: None },
        peer: s("peer"),
        owner: s("owner"),
        ..Default::default()
    }
}

#[test]
fn render_matches_every_python_text() {
    let mut checked = 0;
    let mut skipped = Vec::new();
    for (name, fx) in fixtures() {
        if fx["status"] != 200 { skipped.push(name); continue; }
        let body = &fx["request"]["body"];
        assert_eq!(render(kind_of(body), &args_of(body)), fx["response"]["text"].as_str().unwrap(), "{name}");
        checked += 1;
    }
    assert_eq!(checked, 18);
    // Recusas da rota interna, que deixa de existir: corpo, segredo e surrogate não chegam a `render`.
    // `group` sem outro membro fica com `protocol_text` (deliver).
    assert_eq!(skipped, ["group_task_surrogate", "refused_bad_kind", "refused_extra_field", "refused_group_without_others", "refused_without_secret"]);
}

/// `str.strip()` do Python também tira os separadores \x1c..\x1f, que `char::is_whitespace` não conhece.
#[test]
fn task_is_trimmed_like_python() {
    let fx = fixtures();
    let body = &fx["group_with_task"]["request"]["body"];
    let mut args = args_of(body);
    args.task = "\u{1f}\u{3000} T-1 filtro\u{a0}\u{1c}".into();
    assert_eq!(render(Kind::Group, &args), expected("group_with_task"));
}

/// I-3A: membro local de grupo que tem par de fora recebe o texto de grupo seguido do bloco externo.
#[test]
fn mixed_group_gets_group_and_external_text() {
    let fx = fixtures();
    let mut args = args_of(&fx["group_with_contract"]["request"]["body"]);
    args.outside = vec![OutsideRef { address: "ana::rev".into(), owner: "Ana".into() }];
    assert_eq!(render(Kind::Group, &args), format!("{}\n{}", expected("group_with_contract"), expected("external")));
}

/// I-4A: na dona, o caminho; em outra máquina do dono, a dona pela tool `contract`/`hangar-send
/// --contrato`; membro de fora, sem linha.
#[test]
fn contract_line_by_member_kind() {
    let fx = fixtures();
    let mut args = args_of(&fx["group_with_contract"]["request"]["body"]);
    assert_eq!(render(Kind::Group, &args), expected("group_with_contract"), "dona");

    args.contract = ContractLine { path: None, remote_owner: Some("casa".into()) };
    let remote = "- Decisões que o grupo consulta ficam com a máquina `casa`: leia e grave pela tool `contract` do MCP ou `hangar-send --contrato`.\n";
    let invite = "- Convite de par";
    assert_eq!(render(Kind::Group, &args), expected("group_without_contract").replacen(invite, &format!("{remote}{invite}"), 1), "máquina própria");

    args.contract = ContractLine::default();
    assert_eq!(render(Kind::Group, &args), expected("group_without_contract"), "de fora");
}

proptest::proptest! {
    #[test]
    fn render_never_panics(me in "\\PC*", others in proptest::collection::vec("\\PC*", 0..3), task in "\\PC*",
                           peer in "\\PC*", provider in "\\PC*") {
        let harness: BTreeMap<String, String> = [(me.clone(), provider)].into();
        let args = TextArgs { me, others, task, harness, peer: peer.clone(), owner: peer.clone(),
            outside: vec![OutsideRef { address: peer.clone(), owner: peer }], ..Default::default() };
        for kind in [Kind::Group, Kind::Orq, Kind::External] {
            proptest::prop_assert!(render(kind, &args).starts_with("[painel: grupo de trabalho] "));
        }
    }
}
