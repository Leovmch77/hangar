//! Matriz do corte de posse (Task 12): Claude e Codex, com e sem terminal, são do Rust. Seleção e
//! resposta com ID atual, antigo e ausente, corpo torto e dono doente recebem a resposta do Rust e nunca
//! chegam ao Python. A ponte privada do Claude (`/__hangar_server/claude/<nome>/<rota>`) faz o mesmo
//! para o que entra pelas portas do Python, e o `DELETE` do Codex com terminal fecha no Rust antes da
//! limpeza do Python.
use std::sync::Arc;
use std::time::Duration;

use hangar_server::interactions::{InteractionBinding, InteractionKind, InteractionStore, native_target, plugin_target};
use hangar_server::runtime::gateway::RuntimeRegistry;
use hangar_server::runtime::protocol::{CanoBinding, RuntimeTarget};
use serde_json::{Value, json};

use crate::fake::{self, Fake, OWNER, SECRET};
use crate::session_write_control::{open_headless, registry_with_plugin, send, serve_with_interactions};

const MISSING: &str = "erro_interacao_sem_identidade";
const STALE: &str = "erro_interacao_desatualizada";

fn option() -> Value { json!({"kind": "option", "indices": [0], "labels": ["first"]}) }

/// Dois retratos do mesmo alvo: o primeiro ID fica velho, o segundo é o exibido agora.
fn shown(store: &InteractionStore, binding: &InteractionBinding, kind: InteractionKind) -> (String, String) {
    store.bind(binding).unwrap();
    let target = if kind == InteractionKind::Approval { plugin_target(kind, "perm:1") } else { native_target(kind, &binding.conversation, &json!(0)) };
    let old = store.observe(binding, &target, Some(json!({"question": "A"}))).unwrap().unwrap();
    let current = store.observe(binding, &target, Some(json!({"question": "B"}))).unwrap().unwrap();
    assert_ne!(old, current);
    (old, current)
}

async fn code(server: std::net::SocketAddr, name: &str, route: &str, body: &str) -> (u16, Value) {
    let (status, reply) = send(server, "POST", &format!("{name}/{route}"), body).await;
    (status, reply["detail"]["code"].clone())
}

/// A matriz de uma sessão aberta: `/answer` e `/select` com ID ausente, antigo e atual e corpo torto.
/// `open`: o ator tem a pergunta aberta. Sem terminal o motor confere o ID contra a pergunta que ele
/// mesmo segura; sem nenhuma, o ID atual do retrato fabricado é de pergunta encerrada (desatualizada).
async fn identity_matrix(server: std::net::SocketAddr, python: &Fake, store: &InteractionStore, binding: &InteractionBinding, name: &str, open: bool) {
    let (old_q, current_q) = shown(store, binding, InteractionKind::Question);
    let (old_s, current_s) = shown(store, binding, InteractionKind::Approval);
    for (route, body, want) in [
        ("answer", json!({"answers": [option()]}), MISSING),
        ("answer", json!({"answers": [option()], "interaction_id": old_q}), STALE),
        ("select", json!({"option": 1}), MISSING),
        ("select", json!({"option": 1, "interaction_id": old_s}), STALE),
    ] {
        assert_eq!(code(server, name, route, &body.to_string()).await, (409, json!(want)), "{name} {route} {body}");
    }
    // O ID atual passa da identidade: o Rust escreve ou recusa por outro motivo, nunca como ausente/velho.
    for (route, body) in [("answer", json!({"answers": [option()], "interaction_id": current_q})),
        ("select", json!({"option": 1, "interaction_id": current_s}))] {
        let (status, reply) = send(server, "POST", &format!("{name}/{route}"), &body.to_string()).await;
        assert_ne!(reply, json!("from-python"), "{name} {route}");
        if open {
            assert!(![MISSING, STALE].contains(&reply["detail"]["code"].as_str().unwrap_or("")), "{name} {route}: {status} {reply}");
        } else {
            assert_eq!((status, reply["detail"]["code"].clone()), (409, json!(STALE)), "{name} {route}: sem pergunta aberta no motor");
        }
    }
    for (route, body) in [("answer", r#"{"answers":"x"}"#), ("answer", r#"{"answers":[],"interaction_id":5}"#), ("select", r#"{"option":"1"}"#)] {
        assert_eq!(code(server, name, route, body).await, (422, json!("erro_corpo_invalido")), "{name} {route} {body}");
    }
    for route in ["answer", "select"] {
        assert_eq!(python.hits_to(&format!("/api/sessions/{name}/{route}")), 0, "{name} {route}: nunca ao Python");
    }
}

/// Dono doente: a escrita é a recusa do Rust, nunca o Python relançando.
async fn unhealthy(server: std::net::SocketAddr, python: &Fake, name: &str) {
    for (route, body) in [("answer", json!({"answers": [option()], "interaction_id": "x"})), ("select", json!({"option": 1, "interaction_id": "x"}))] {
        assert_eq!(code(server, name, route, &body.to_string()).await, (503, json!("runtime_unhealthy")), "{name} {route}");
        assert_eq!(python.hits_to(&format!("/api/sessions/{name}/{route}")), 0);
    }
}

async fn until_sick(registry: &RuntimeRegistry, name: &str) {
    for _ in 0..100 {
        if !registry.writable(name).await.unwrap().healthy { return; }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("{name}: a entrada não ficou doente");
}

/// Entrada sem terminal cujo cano cai quando avisado.
async fn open_dying(registry: &RuntimeRegistry, dir: &std::path::Path, name: &str, provider: &str) -> Arc<tokio::sync::Notify> {
    let kill = Arc::new(tokio::sync::Notify::new());
    let metadata = if provider == "codex" { json!({"name": name, "headless": true, "thread_id": "thread-1", "initialized": true, "ready": true}) }
        else { json!({"name": name, "headless": true, "session_id": "sid-1", "initialized": true}) };
    registry.open(RuntimeTarget { key: format!("k-{name}"), generation: 1, name: name.into(), provider: provider.into(), metadata,
        binding: CanoBinding { pid: 42, escuta: crate::session_write_routes::cano_with(Some(kill.clone())).await, token: "secret-test".into(), versao: 2 },
        lease_path: dir.join(format!("{name}.lock")), state_path: dir.join(format!("{name}.queue-state.json")),
        projection_dir: dir.join(format!("{name}-projection")), transcript: dir.join(format!("{name}.jsonl")), created: 0.0 }).await.unwrap();
    kill
}

#[tokio::test]
async fn claude_headless_answers_and_refuses_in_rust() {
    let (dir, store) = (tempfile::tempdir().unwrap(), Arc::new(InteractionStore::default()));
    let (registry, _plugin) = registry_with_plugin(&store).await;
    open_headless(&registry, dir.path(), "s").await;
    let binding = registry.interaction_binding("s").await.unwrap();
    open_dying(&registry, dir.path(), "d", "claude").await.notify_one();
    until_sick(&registry, "d").await;
    let (python, server) = serve_with_interactions(registry, store.clone()).await;
    identity_matrix(server, &python, &store, &binding, "s", false).await;
    unhealthy(server, &python, "d").await;
}

#[tokio::test]
async fn codex_headless_answers_and_refuses_in_rust() {
    let (dir, store) = (tempfile::tempdir().unwrap(), Arc::new(InteractionStore::default()));
    let (registry, _plugin) = registry_with_plugin(&store).await;
    crate::groups_deliver::open_codex_headless(&registry, dir.path(), "c", Arc::default()).await;
    let binding = registry.interaction_binding("c").await.unwrap();
    open_dying(&registry, dir.path(), "d", "codex").await.notify_one();
    until_sick(&registry, "d").await;
    let (python, server) = serve_with_interactions(registry, store.clone()).await;
    identity_matrix(server, &python, &store, &binding, "c", false).await;
    unhealthy(server, &python, "d").await;
}

#[cfg(unix)]
#[tokio::test]
async fn claude_terminal_answers_and_refuses_in_rust() {
    let (dir, store) = (tempfile::tempdir().unwrap(), Arc::new(InteractionStore::default()));
    let (registry, _plugin) = registry_with_plugin(&store).await;
    crate::session_write_control::open_terminal(&registry, dir.path(), "t").await;
    let binding = registry.interaction_binding("t").await.unwrap();
    let (python, server) = serve_with_interactions(registry, store.clone()).await;
    identity_matrix(server, &python, &store, &binding, "t", true).await;
    // Entrada com o vínculo trocado: doente, e a recusa é do Rust.
    let sick_dir = tempfile::tempdir().unwrap();
    let sick = crate::session_write_input::registry().await;
    crate::session_write_input::open_sick_terminal(&sick, sick_dir.path(), "t").await;
    let (python, server) = serve_with_interactions(sick, Arc::new(InteractionStore::default())).await;
    unhealthy(server, &python, "t").await;
}

/// Codex com terminal adotado pela vigia: ID ausente, desconhecido e corpo torto são recusas do Rust.
/// O dono doente segue o mesmo ramo de `route_write` dos outros três (sem fake que derrube só a vista).
#[cfg(unix)]
#[tokio::test]
async fn codex_terminal_answers_and_refuses_in_rust() {
    use crate::runtime_codex_watch::{finish, fixture, serve_owner, tui};
    use crate::runtime_open::{app_server_process, fake_app_server, registry};
    let fx = fixture();
    let app_server = fake_app_server(true).await;
    let (mut app, mut tui) = (app_server_process(&app_server.endpoint), tui());
    fx.put_sidecar("cx-proof", fx.meta("cx-proof", &app_server.endpoint, Some(app.id()), &tui));
    fx.panes(&["cx-proof"]);
    let registry = registry().await;
    let watcher = fx.watcher();
    registry.bind_watcher(watcher.clone());
    watcher.round(&registry).await;
    assert!(registry.owns_codex_terminal("cx-proof"));
    let (python, server) = serve_owner(registry.clone()).await;
    for route in ["answer", "select"] {
        let missing = if route == "answer" { json!({"answers": [option()]}) } else { json!({"option": 1}) };
        assert_eq!(code(server, "cx-proof", route, &missing.to_string()).await, (409, json!(MISSING)), "{route}");
        let mut unknown = missing.clone();
        unknown["interaction_id"] = json!("nunca-exibido");
        let (status, reply) = code(server, "cx-proof", route, &unknown.to_string()).await;
        assert!(matches!((status, reply.as_str()), (409, Some(STALE)) | (503, Some("erro_interacao_indisponivel"))), "{route}: {status} {reply}");
        assert_eq!(code(server, "cx-proof", route, r#"{"x":1}"#).await, (422, json!("erro_corpo_invalido")), "{route}");
        assert_eq!(python.hits_to(&format!("/api/sessions/cx-proof/{route}")), 0, "{route}: nunca ao Python");
    }
    // O relançamento é do Rust: corpo torto recusado aqui, nunca o 422 do FastAPI pelo repasse.
    let (status, reply) = send(server, "POST", "cx-proof/modo-execucao", r#"{"terminal":"sim"}"#).await;
    assert_eq!((status, reply["detail"]["code"].as_str()), (422, Some("erro_corpo_invalido")));
    assert_eq!(python.hits_to("/api/sessions/cx-proof/modo-execucao"), 0);
    // DELETE: fecha no Rust e repassa marcado uma vez; o repetido chega sem a marca, e nada o devolve ao Rust.
    let delete = || fake::client().delete(format!("http://{server}/api/sessions/cx-proof")).header("authorization", format!("Bearer {OWNER}")).send();
    assert_eq!(delete().await.unwrap().status().as_u16(), 200);
    assert_eq!(python.last_hit().1.get("x-hangar-rust-closed").and_then(|v| v.to_str().ok()), Some(SECRET));
    assert!(!registry.owns_codex_terminal("cx-proof"));
    assert_eq!(delete().await.unwrap().status().as_u16(), 200);
    assert_eq!(python.hits_to("/api/sessions/cx-proof"), 2);
    assert!(python.last_hit().1.get("x-hangar-rust-closed").is_none(), "o repetido não foi encerrado aqui");
    finish(&mut [&mut app, &mut tui]);
}

/// A ponte privada do Claude: corpo intacto (o `interaction_id` chega à conferência do Rust), resposta e
/// código do Rust, 421 para o que ele não atende, e a rota de personalizações intacta.
#[tokio::test]
async fn claude_bridge_serves_input_answers_and_queue_of_a_rust_claude() {
    let (dir, store) = (tempfile::tempdir().unwrap(), Arc::new(InteractionStore::default()));
    let (registry, _plugin) = registry_with_plugin(&store).await;
    open_headless(&registry, dir.path(), "s").await;
    let binding = registry.interaction_binding("s").await.unwrap();
    let (old_s, _) = shown(&store, &binding, InteractionKind::Approval);
    let (python, upstream) = fake::spawn_fake().await;
    let mut state = hangar_server::routes::AppState::new(fake::config(upstream, "127.0.0.1"));
    state.interactions = store.clone();
    assert!(state.state.runtime.set(registry).is_ok());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let private = listener.local_addr().unwrap();
    let router = hangar_server::routes::terminal_router(Arc::new(state));
    tokio::spawn(async move { axum::serve(listener, router.into_make_service_with_connect_info::<std::net::SocketAddr>()).await.unwrap() });
    let call = |method: reqwest::Method, path: &str, body: &str, secret: bool| {
        let request = fake::client().request(method, format!("http://{private}/__hangar_server/claude/{path}"))
            .header("content-type", "application/json").body(body.to_owned());
        let request = if secret { request.header("x-hangar-internal", SECRET) } else { request };
        async move {
            let response = request.send().await.unwrap();
            let status = response.status().as_u16();
            (status, serde_json::from_str::<Value>(&response.text().await.unwrap()).unwrap_or(Value::Null))
        }
    };
    let post = |path: &'static str, body: String| call(reqwest::Method::POST, path, &body, true);
    let (status, reply) = post("s/answer", json!({"answers": [option()]}).to_string()).await;
    assert_eq!((status, reply["detail"]["code"].as_str()), (409, Some(MISSING)));
    let (status, reply) = post("s/select", json!({"option": 1, "interaction_id": old_s}).to_string()).await;
    assert_eq!((status, reply["detail"]["code"].as_str()), (409, Some(STALE)), "o ID do corpo chegou intacto");
    let (status, reply) = post("s/answer", r#"{"answers":"x"}"#.into()).await;
    assert_eq!((status, reply["detail"]["code"].as_str()), (422, Some("erro_corpo_invalido")));
    let (status, reply) = post("s/input", json!({"text":"oi","jev_task":"","jev_message":"oi"}).to_string()).await;
    assert_eq!((status, reply["ok"].as_bool(), reply["timing_note"].as_str()), (200, Some(true), Some("delivered")), "{reply}");
    assert_eq!(reply["steered"], false, "sem contexto não há orientação automática");
    let (status, reply) = post("s/input", json!({"text":"oi","jev_task":"t"}).to_string()).await;
    assert_eq!((status, reply["detail"]["code"].as_str()), (422, Some("erro_corpo_invalido")));
    assert_eq!(call(reqwest::Method::POST, "s/input", r#"{"text":"oi"}"#, false).await.0, 404);
    // Sessão que o Rust não tem não entra pela ponte.
    assert_eq!(post("nada/input", json!({"text": "oi"}).to_string()).await.0, 421);
    // Fora do recorte: aba Submit sem pane, outra rota, outro método, sessão desconhecida.
    assert_eq!(post("s/select/submit", "{}".into()).await.0, 421);
    assert_eq!(post("s/not-a-route", "{}".into()).await.0, 421);
    assert_eq!(call(reqwest::Method::GET, "s/answer", "", true).await.0, 421);
    assert_eq!(post("nada/answer", json!({"answers": [option()]}).to_string()).await.0, 421);
    // O painel da fila: corpo fora de forma é do Rust (422); id com barra e leitura não são rotas dele.
    let (status, reply) = call(reqwest::Method::PATCH, "s/queue/a", r#"{"text":1}"#, true).await;
    assert_eq!((status, reply["detail"]["code"].as_str()), (422, Some("erro_corpo_invalido")), "{reply}");
    assert_eq!(post("s/queue/a/b/steer", String::new()).await.0, 421);
    assert_eq!(call(reqwest::Method::GET, "s/queue/a", "", true).await.0, 421);
    assert_eq!(call(reqwest::Method::POST, "s/answer", "{}", false).await.0, 404, "sem o segredo a ponte não existe");
    // Parity M1: o modo pedido pelo convidado ou pelo Connect é do Rust, como o do dono.
    let (status, reply) = call(reqwest::Method::GET, "s/permission-modes", "", true).await;
    assert_eq!((status, reply["sondavel"].as_bool()), (200, Some(false)), "{reply}");
    assert_eq!(post("s/permission-modes", "{}".into()).await.0, 421, "lista só por GET");
    assert_eq!(python.hits_to("/api/sessions/s/permission-modes"), 0);
    // Btw: a pergunta lateral do Connect chega à rota do Rust, que responde até o corpo errado.
    let (status, reply) = post("s/btw", r#"{"question":"q","x":1}"#.into()).await;
    assert_eq!((status, reply["detail"][0]["type"].as_str()), (422, Some("extra_forbidden")), "{reply}");
    assert_eq!(python.hits_to("/api/sessions/s/btw"), 0);
    // A rota irmã das personalizações não é engolida pela ponte.
    assert_ne!(post("customizations", "{}".into()).await.0, 421);
    for route in ["answer", "select", "select/submit", "input"] {
        assert_eq!(python.hits_to(&format!("/api/sessions/s/{route}")), 0, "{route}: nunca volta ao Python");
    }
}
