//! Abertura de sessão: o despacho provisório do `POST /api/sessions` e o comando `hangar-open`.
use std::path::Path;
use std::process::Command;

use serde_json::Value;


fn fixture(name: &str) -> Value {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../backend/tests/fixtures/contract/session-open").join(format!("{name}.json"));
    serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap()
}

/// O estado inicial do cenário numa raiz de verdade, como o harness o monta para o Python.
fn materialize(fixture: &Value, root: &Path) {
    let root_text = root.to_string_lossy();
    let place = |raw: &str| raw.replace("<ROOT>", &root_text);
    let state = &fixture["scenario"]["state"];
    for dir in state["dirs"].as_array().into_iter().flatten() {
        std::fs::create_dir_all(place(dir.as_str().unwrap())).unwrap();
    }
    for (path, content) in state["files"].as_object().into_iter().flatten() {
        let path = place(path);
        std::fs::create_dir_all(Path::new(&path).parent().unwrap()).unwrap();
        let text = match content { Value::String(text) => text.clone(), json => json.to_string() };
        std::fs::write(path, place(&text)).unwrap();
    }
}

fn hangar_open(root: &Path, args: &[&str]) -> (i32, Value, String) {
    let out = Command::new(env!("CARGO_BIN_EXE_hangar-open")).args(args).env_clear()
        .env("HOME", root.join("home")).env("PATH", root.join("bin")).env("HANGAR_URL", "http://127.0.0.1:1")
        .env("CP_AUTH_TOKEN", "x").output().unwrap();
    (out.status.code().unwrap(), serde_json::from_slice(&out.stdout).unwrap_or(Value::Null), String::from_utf8_lossy(&out.stderr).into_owned())
}

/// Com o servidor fora do ar o comando resolve dos mesmos arquivos e chega ao que o Python decidiu
/// (`create_inherit_from_headless_creator`: conta, modo e sem terminal vindos do sidecar da criadora).
#[test]
fn the_command_resolves_from_the_same_files_with_the_server_down() {
    let dir = tempfile::tempdir().unwrap();
    // Raiz canônica: o catálogo de contas compara o caminho resolvido.
    let root = dir.path().canonicalize().unwrap();
    let fixture = fixture("create_inherit_from_headless_creator");
    materialize(&fixture, &root);
    // PATH vazio: nem tmux nem agentes, como uma máquina sem sessão de terminal.
    std::fs::create_dir_all(root.join("bin")).unwrap();
    let body = fixture["scenario"]["steps"][0]["json"].to_string().replace("<ROOT>", &root.to_string_lossy());
    let expected = &fixture["result"]["steps"][0]["body"];
    let launched = &fixture["result"]["records"]["<ROOT>/home/.hangar/claude-headless/filha.json"]["created"]["json"];
    for command in ["resolve", "open"] {
        let (code, out, stderr) = hangar_open(&root, &[command, &body]);
        assert_eq!(code, if command == "open" { 3 } else { 0 }, "{command}: {stderr}");
        let spec = &out["spec"];
        assert_eq!(spec["name"], expected["name"]);
        assert_eq!(spec["surface"] == "headless", expected["headless"] == true);
        assert_eq!(spec["account"]["config_dir"].as_str().map(|d| d.replace(&*root.to_string_lossy(), "<ROOT>")).as_deref(),
            expected["config_dir"].as_str(), "{command}: {out}");
        assert_eq!(spec["account_source"], expected["account_source"]);
        assert_eq!(out["warnings"], expected["avisos"]);
        assert_eq!(spec["permission_mode"], launched["permission_mode"]);
        assert_eq!(spec["jev"], launched["jev"]);
    }
}

#[test]
fn the_command_refuses_with_the_open_error() {
    let dir = tempfile::tempdir().unwrap();
    let (code, _, stderr) = hangar_open(dir.path(), &["resolve", r#"{"name":"s1","cwd":"/x","bogus":1}"#]);
    assert_eq!(code, 1);
    assert_eq!(serde_json::from_str::<Value>(&stderr).unwrap()["detail"]["code"], "erro_corpo_invalido");
    assert_eq!(hangar_open(dir.path(), &["abrir"]).0, 2);
}
