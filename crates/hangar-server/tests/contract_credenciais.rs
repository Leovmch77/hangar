//! `GET /api/credenciais` servido pelo Rust: cada caso de `golden/credenciais.json` (gravado pela rota
//! Python) monta a mesma árvore num HOME temporário e tem de sair com o mesmo status e o mesmo corpo,
//! sem tocar no Python. Os fatos que a rota Python pedia ao Rust vêm daqui: `claude` e `codex` falsos
//! no PATH (login lido de `.fake-auth.json` / `.fake-account.json` da pasta da conta) e o cache de cota
//! semeado com as linhas do caso. Processo próprio porque fixa `HANGAR_RUNTIME_INSTANCE`.
#![cfg(unix)]
use axum::{Router, http::StatusCode};
use hangar_server::{auth::TrustedHosts, config::Config, routes::AppState};
use serde_json::{Value, json};
use std::path::Path;
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};

const HOME: &str = "⟦HOME⟧";

const FAKE_CLAUDE: &str = r#"#!/usr/bin/env node
const fs = require('fs'), path = require('path');
const file = path.join(process.env.CLAUDE_CONFIG_DIR, '.fake-auth.json');
if (!fs.existsSync(file)) process.exit(1);
process.stdout.write(fs.readFileSync(file));
"#;

const FAKE_CODEX: &str = r#"#!/usr/bin/env node
const fs = require('fs'), path = require('path');
const home = process.env.CODEX_HOME;
const rl = require('readline').createInterface({input: process.stdin});
rl.on('line', text => {
  const m = JSON.parse(text);
  if (m.id === undefined) return;
  if (m.method === 'account/read') {
    if (fs.existsSync(path.join(home, '.fake-delay'))) return;
    const result = JSON.parse(fs.readFileSync(path.join(home, '.fake-account.json')));
    process.stdout.write(JSON.stringify({id: m.id, result}) + '\n');
    return;
  }
  process.stdout.write(JSON.stringify({id: m.id, result: {}}) + '\n');
});
"#;

fn golden() -> Value {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../backend/tests/fixtures/contract/golden/credenciais.json");
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn executable(path: &Path, source: &str) {
    use std::os::unix::fs::PermissionsExt;
    std::fs::write(path, source).unwrap();
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
}

fn with_home(value: &Value, home: &str) -> Value {
    serde_json::from_str(&value.to_string().replace(HOME, home)).unwrap()
}

fn now() -> f64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs_f64()
}

/// O cache de cota com uma entrada fresca por linha do caso: a lista não lê a rede.
fn seed_quotas(home: &Path, rows: &Value) {
    let mut cache = serde_json::Map::new();
    for row in rows.as_array().into_iter().flatten() {
        let cota = json!({"estado": row["estado"], "janelas": row["janelas"], "ts": row["ts"],
            "motivo": row["motivo"], "reset_credits": row["reset_credits"]});
        cache.insert(row["id"].as_str().unwrap().to_owned(),
            json!({"gravado_em": now(), "cota": cota, "credential_signature": null}));
    }
    std::fs::create_dir_all(home.join(".hangar")).unwrap();
    std::fs::write(home.join(".hangar/cotas-cache.json"), Value::Object(cache).to_string()).unwrap();
}

type Answer = (u16, Option<String>, Value);

async fn answer(request: reqwest::RequestBuilder, home: &str) -> Answer {
    let response = request.send().await.unwrap();
    let status = response.status().as_u16();
    let kind = response.headers().get("content-type").map(|v| v.to_str().unwrap().to_owned());
    let text = response.text().await.unwrap();
    let body = serde_json::from_str(&text).unwrap_or(Value::String(text));
    (status, kind, serde_json::from_str(&body.to_string().replace(home, HOME)).unwrap())
}

/// A mesma lista pelo dono (8765) e pela ponte do Connect (8768 → `/__hangar_server/accounts/public`).
async fn run(case: &Value, python: std::net::SocketAddr) -> (Answer, Answer) {
    let root = tempfile::tempdir().unwrap();
    let home = root.path().canonicalize().unwrap();
    let home_text = home.to_string_lossy().into_owned();
    for (rel, content) in with_home(&case["files"], &home_text).as_object().unwrap() {
        let path = home.join(rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, content.as_str().unwrap()).unwrap();
    }
    for (rel, raw) in case["files_hex"].as_object().into_iter().flatten() {
        let raw = raw.as_str().unwrap();
        let bytes: Vec<u8> = (0..raw.len()).step_by(2).map(|i| u8::from_str_radix(&raw[i..i + 2], 16).unwrap()).collect();
        std::fs::write(home.join(rel), bytes).unwrap();
    }
    let facts = with_home(&case["fatos"], &home_text);
    if facts["quotas"].is_array() {
        seed_quotas(&home, &facts["quotas"]);
    }
    let bin = root.path().join("bin");
    std::fs::create_dir(&bin).unwrap();
    executable(&bin.join("claude"), FAKE_CLAUDE);
    if case["codex_cli"] == true {
        executable(&bin.join("codex"), FAKE_CODEX);
    }
    let state = |listen| {
        let mut state = AppState::new(Config {
            listen,
            upstream: python,
            internal_secret: "contract-internal".into(),
            auth_token: "contract-only".into(),
            log_path: None,
            trusted: TrustedHosts::parse("127.0.0.1"),
        });
        state.accounts = hangar_server::accounts::AccountService::new(
            hangar_server::accounts::environment::AccountEnvironment::from_map([
                ("HOME".into(), home_text.clone()),
                ("USERPROFILE".into(), home_text.clone()),
                ("PATH".into(), format!("{}:/usr/bin:/bin", bin.display())),
            ].into()),
        );
        state
    };
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let server = tokio::spawn(hangar_server::routes::serve_with_state(listener, state(addr)));
    let private = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let private_addr = private.local_addr().unwrap();
    let app = hangar_server::routes::terminal_router(Arc::new(state(private_addr)));
    let bridge = tokio::spawn(async move {
        axum::serve(private, app.into_make_service_with_connect_info::<std::net::SocketAddr>()).await.unwrap()
    });
    let client = reqwest::Client::new();
    let query = case["query"].as_str().unwrap();
    let (owner, connect) = tokio::join!(
        answer(client.get(format!("http://{addr}/api/credenciais{query}")).bearer_auth("contract-only"), &home_text),
        answer(client.get(format!("http://{private_addr}/__hangar_server/accounts/public{query}"))
            .header("x-hangar-internal", "contract-internal").header("x-hangar-path", "/api/credenciais"), &home_text),
    );
    server.abort();
    bridge.abort();
    (owner, connect)
}

#[tokio::test(flavor = "multi_thread")]
async fn credentials_match_python() {
    // SAFETY: processo de teste próprio; nenhuma outra thread lê o ambiente antes deste ponto.
    unsafe { std::env::set_var("HANGAR_RUNTIME_INSTANCE", "contract-instance") };
    let hits = Arc::new(AtomicUsize::new(0));
    let recorded = hits.clone();
    let upstream = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let python = upstream.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(upstream, Router::new().fallback(move |request: axum::extract::Request| {
            let uri = request.uri().clone();
            // O diário exportável é do Python, e o `HEAD /` é a sonda de subida do servidor: fora disso, nada.
            if uri.path() != "/internal/diag" && !(request.method() == axum::http::Method::HEAD && uri.path() == "/") {
                eprintln!("pedido ao Python: {} {uri} {:?}", request.method(), request.headers());
                recorded.fetch_add(1, Ordering::SeqCst);
            }
            async { (StatusCode::SERVICE_UNAVAILABLE, "handler Python bloqueado") }
        }))
        .await
        .unwrap();
    });
    let golden = golden();
    let mut failures = vec![];
    for case in golden["casos"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let expected = &case["esperado"];
        let ((status, kind, body), connect) = run(case, python).await;
        if connect != (status, kind.clone(), body.clone()) {
            failures.push(format!("{name}: a ponte do Connect respondeu diferente do dono: {connect:?}"));
        }
        // D1: a parte com problema sai sozinha (motor torto, engines.json ilegível, cota indisponível);
        // a conta Claude continua na lista.
        if matches!(name, "engines_fora_do_utf8" | "motor_nao_objeto" | "motor_label_numero" | "motor_base_url_lista") {
            let ids: Vec<&Value> = body.as_array().into_iter().flatten().map(|row| &row["id"]).collect();
            if status != 200 || ids != [&json!(format!("claude:{HOME}/.claude"))] {
                failures.push(format!("{name}: D1 esperava 200 só com a conta Claude, rust {status} {body}"));
            }
            continue;
        }
        if status != expected["status"].as_u64().unwrap() as u16 {
            failures.push(format!("{name}: status {status} != {}: {body}", expected["status"]));
            continue;
        }
        if kind.as_deref() != expected["content_type"].as_str() {
            failures.push(format!("{name}: content-type {kind:?} != {}", expected["content_type"]));
        }
        // R#9 (usuário, 13/10): login Codex indisponível leva a causa na linha; o Python dava `null`.
        let mut expected_body = expected["body"].clone();
        if name == "codex_estoura_prazo" {
            for row in expected_body.as_array_mut().into_iter().flatten().filter(|row| row["tipo"] == "codex") {
                row["login"]["motivo"] = json!("prazo");
            }
        }
        if body != expected_body {
            failures.push(format!("{name}:\n rust   {body}\n python {expected_body}"));
        }
    }
    assert_eq!(hits.load(Ordering::SeqCst), 0, "a lista chegou ao Python");
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[test]
fn only_the_exact_get_is_rust_owned() {
    use axum::http::Method;
    use hangar_server::migration_status::rust_route;
    assert!(rust_route(&Method::GET, "/api/credenciais"));
    for (method, path) in [(Method::PUT, "/api/credenciais/apelido"), (Method::PUT, "/api/credenciais/cookie"),
        (Method::POST, "/api/credenciais/sincronizar"), (Method::DELETE, "/api/credenciais/kimi/x"),
        (Method::POST, "/api/credenciais")] {
        assert!(!rust_route(&method, path), "{method} {path} deveria seguir ao Python");
    }
}
