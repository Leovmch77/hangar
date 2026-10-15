//! Abertura de sessão: o despacho do `POST /api/sessions` e o comando `hangar-open`.
use std::path::Path;
use std::process::Command;

use serde_json::Value;

use crate::fake::*;

/// Claude com terminal é do Rust (a recusa também); o resto segue ao Python com o corpo intacto, e
/// só o que o Rust olhou leva a marca de "já olhei" (a do cliente não passa).
#[tokio::test]
async fn create_opens_claude_terminal_in_rust_and_forwards_the_rest() {
    let (fake, up) = spawn_fake().await;
    let srv = spawn_server(config(up, "127.0.0.1")).await;
    let post = |body: &'static [u8]| client().post(format!("http://{srv}/api/sessions")).bearer_auth(OWNER)
        .header("content-type", "application/json").header("x-hangar-open", "python").body(body.to_vec()).send();
    let resp = post(br#"{"name":"s1","cwd":"/nao/existe","provider":"claude","headless":false}"#).await.unwrap();
    assert_eq!(resp.status(), 400);
    assert_eq!(serde_json::from_str::<Value>(&resp.text().await.unwrap()).unwrap()["detail"]["code"], "erro_cwd_inexistente");
    assert_eq!(fake.hits_to("/api/sessions"), 0, "o Rust respondeu sozinho");
    let codex = br#"{"name":"s1","cwd":"/x","provider":"codex"}"#;
    assert_eq!(post(codex).await.unwrap().text().await.unwrap(), "from-python");
    assert_eq!(fake.last_body(), codex, "corpo repassado byte a byte");
    assert_eq!(fake.last_hit().1["x-hangar-open"], "python", "o Rust olhou e devolveu");
    for body in [&br#"{"name":"s1","cwd":"/x","bogus":1}"#[..], b"nem json"] {
        let resp = client().post(format!("http://{srv}/api/sessions")).bearer_auth(OWNER)
            .header("content-type", "application/json").header("x-hangar-open", "python").body(body.to_vec()).send().await.unwrap();
        assert_eq!(resp.text().await.unwrap(), "from-python");
        assert_eq!(fake.last_body(), body);
        assert!(fake.last_hit().1.get("x-hangar-open").is_none(), "a marca do cliente não passa");
    }
    assert_eq!(fake.hits_to("/api/sessions"), 3);
}

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

/// Instala o comando como numa cópia do Hangar: `<raiz>/inst/bin/hangar-open` ao lado de
/// `<raiz>/inst/backend/.env`, de onde ele lê token, porta e as opções `CP_*` do servidor.
fn install(root: &Path, env_file: &str) -> std::path::PathBuf {
    let bin = root.join("inst/bin/hangar-open");
    std::fs::create_dir_all(bin.parent().unwrap()).unwrap();
    std::fs::create_dir_all(root.join("inst/backend")).unwrap();
    std::fs::copy(env!("CARGO_BIN_EXE_hangar-open"), &bin).unwrap();
    std::fs::write(root.join("inst/backend/.env"), env_file).unwrap();
    bin
}

/// Roda fora do runtime: o servidor falso do teste continua atendendo enquanto o comando espera.
async fn hangar_open(bin: &Path, root: &Path, args: &[&str], extra_env: &[(&str, String)]) -> (i32, Value, String) {
    let mut command = Command::new(bin);
    command.args(args).env_clear().env("HOME", root.join("home")).env("PATH", root.join("bin"));
    for (key, value) in extra_env { command.env(key, value); }
    let out = tokio::task::spawn_blocking(move || command.output().unwrap()).await.unwrap();
    (out.status.code().unwrap(), serde_json::from_slice(&out.stdout).unwrap_or(Value::Null), String::from_utf8_lossy(&out.stderr).into_owned())
}

/// Com o servidor fora do ar o comando resolve dos mesmos arquivos e chega ao que o Python decidiu
/// (`create_inherit_from_headless_creator`: conta, modo e sem terminal vindos do sidecar da criadora).
/// O ambiente de quem chama não entra: conta (`CLAUDE_CONFIG_DIR`) e `CP_*` são os do servidor.
#[tokio::test]
async fn the_command_resolves_from_the_same_files_with_the_server_down() {
    let dir = tempfile::tempdir().unwrap();
    // Raiz canônica: o catálogo de contas compara o caminho resolvido.
    let root = dir.path().canonicalize().unwrap();
    let fixture = fixture("create_inherit_from_headless_creator");
    materialize(&fixture, &root);
    // PATH vazio: nem tmux nem agentes, como uma máquina sem sessão de terminal.
    std::fs::create_dir_all(root.join("bin")).unwrap();
    // Se o comando lesse a conta ou o `CP_JEV_PADRAO` de quem chama, o Jev nasceria ligado.
    std::fs::write(root.join("home/.claude-b/runtime-config.json"), r#"{"jev_padrao": true}"#).unwrap();
    let caller = [("CLAUDE_CONFIG_DIR", root.join("home/.claude-b").to_string_lossy().into_owned()), ("CP_JEV_PADRAO", "true".into())];
    // Porta 1: ninguém atende.
    let bin = install(&root, "CP_AUTH_TOKEN=x\nCP_PORT=1\n");
    let body = fixture["scenario"]["steps"][0]["json"].to_string().replace("<ROOT>", &root.to_string_lossy());
    let expected = &fixture["result"]["steps"][0]["body"];
    let launched = &fixture["result"]["records"]["<ROOT>/home/.hangar/claude-headless/filha.json"]["created"]["json"];
    for command in ["resolve", "open"] {
        let (code, out, stderr) = hangar_open(&bin, &root, &[command, &body], &caller).await;
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

#[tokio::test]
async fn the_command_refuses_with_the_open_error() {
    let dir = tempfile::tempdir().unwrap();
    let bin = install(dir.path(), "");
    let (code, _, stderr) = hangar_open(&bin, dir.path(), &["resolve", r#"{"name":"s1","cwd":"/x","bogus":1}"#], &[]).await;
    assert_eq!(code, 1);
    assert_eq!(serde_json::from_str::<Value>(&stderr).unwrap()["detail"]["code"], "erro_corpo_invalido");
    assert_eq!(hangar_open(&bin, dir.path(), &["abrir"], &[]).await.0, 2);
}

/// A recusa do servidor sai em stderr, como a recusa local; stdout fica só com a sessão criada.
#[tokio::test]
async fn a_server_refusal_goes_to_stderr() {
    let refusal = r#"{"detail":{"code":"erro_nome_em_uso","params":{},"msg":"ja existe uma sessao com esse nome"}}"#;
    let app = axum::Router::new().route("/api/sessions", axum::routing::post(move || async move {
        (axum::http::StatusCode::CONFLICT, refusal)
    }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let dir = tempfile::tempdir().unwrap();
    let bin = install(dir.path(), &format!("CP_AUTH_TOKEN=t\nCP_PORT={port}\n"));
    let out = {
        let mut command = Command::new(&bin);
        command.args(["open", r#"{"name":"dup","cwd":"/x"}"#]).env_clear().env("HOME", dir.path());
        tokio::task::spawn_blocking(move || command.output().unwrap()).await.unwrap()
    };
    assert_eq!(out.status.code(), Some(1));
    assert!(out.stdout.is_empty(), "{}", String::from_utf8_lossy(&out.stdout));
    assert_eq!(String::from_utf8_lossy(&out.stderr).trim(), refusal);
}

/// Token e porta vêm do `backend/.env`, como no `hangar-send`; sem token nada é enviado.
#[tokio::test]
async fn the_env_file_gives_token_and_port_and_no_token_sends_nothing() {
    let (fake, up) = spawn_fake().await;
    let dir = tempfile::tempdir().unwrap();
    let body = r#"{"name":"s1","cwd":"/x","provider":"claude"}"#;
    let bin = install(dir.path(), &format!("CP_PORT={}\n", up.port()));
    // Nem o token nem o endereço de quem chama valem: só o `.env` do servidor.
    let caller = [("CP_AUTH_TOKEN", "do-chamador".into()), ("HANGAR_URL", format!("http://{up}"))];
    let (code, _, stderr) = hangar_open(&bin, dir.path(), &["open", body], &caller).await;
    assert_eq!(code, 4, "{stderr}");
    assert!(stderr.contains("CP_AUTH_TOKEN"), "{stderr}");
    assert_eq!(fake.hits_to("/api/sessions"), 0, "sem token, nada foi enviado");
    let bin = install(dir.path(), &format!("CP_AUTH_TOKEN=velho\nCP_PORT={}\nCP_AUTH_TOKEN=do-env\n", up.port()));
    let (code, _, stderr) = hangar_open(&bin, dir.path(), &["open", body], &[]).await;
    assert_eq!(code, 0, "{stderr}");
    assert_eq!(fake.hits_to("/api/sessions"), 1);
    assert_eq!(fake.last_hit().1["authorization"], "Bearer do-env", "a última linha do .env vale");
    assert_eq!(fake.last_body(), body.as_bytes());
}
