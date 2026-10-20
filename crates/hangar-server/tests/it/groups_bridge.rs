//! Ponte privada dos grupos (`/__hangar_server/groups`): o que o Python pede ao Rust no modo
//! `rust`/`pending`, quando só o Rust grava `.hangar-pair`.
#![cfg(unix)]
use crate::fake;
use crate::list_support;

use std::collections::BTreeMap;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use fake::{OWNER, SECRET, client};
use hangar_server::groups::orq::PythonOrq;
use hangar_server::groups::service::{GroupService, JoinOwned};
use hangar_server::groups::store::PairDir;
use hangar_server::list::bridge::{ListBridge, ListEnv, parse_dirs};
use hangar_server::list::facts::FactsClient;
use hangar_server::list::mux::Mux;
use hangar_server::routes::{AppState, router, terminal_router};
use serde_json::{Value, json};

struct Server { public: SocketAddr, private: SocketAddr, python: Arc<fake::Fake>, groups: Arc<GroupService>, pair: PathBuf }

async fn serve(app: axum::Router) -> SocketAddr {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app.into_make_service_with_connect_info::<SocketAddr>()).await.unwrap() });
    addr
}

/// `n` sessões Claude (`s0`..), a porta pública e a privada do mesmo estado.
async fn server(root: &Path, n: usize) -> Server {
    let script = list_support::sessions(root, n);
    let home = root.join("home");
    let dirs = parse_dirs(&json!({"home": home, "claude": home.join(".claude"), "codex_home": home.join(".codex"),
        "pi_sessions": home.join(".pi/agent/sessions"), "omp_config": home.join(".omp"),
        "omp_agent": home.join(".omp/agent"), "kimi_home": home.join(".kimi-code")}).to_string());
    let (python, upstream) = fake::spawn_fake().await;
    let mut state = AppState::new(fake::config(upstream, ""));
    state.list = Arc::new(ListBridge::new(ListEnv { mux: Mux::with_program(&script, Duration::from_secs(5)),
        capture_program: script.into_os_string(), procs: Arc::new(hangar_server::list::procs::SystemProcs::default()), dirs },
        FactsClient::new(upstream, SECRET.into())));
    let pair = home.join(".claude/.hangar-pair");
    let groups = Arc::new(GroupService::new(PairDir::new(pair.clone(), root.join("arquivo")), Arc::new(PythonOrq::from_state(&state)), "casa".into()));
    state.groups = Some(groups.clone());
    let state = Arc::new(state);
    let public = serve(router(state.clone())).await;
    let private = serve(terminal_router(state)).await;
    Server { public, private, python, groups, pair }
}

async fn bridge(addr: SocketAddr, op: &str, args: Value, secret: Option<&str>) -> (u16, Value) {
    let mut req = client().post(format!("http://{addr}/__hangar_server/groups")).header("content-type", "application/json")
        .body(json!({"op": op, "args": args}).to_string());
    if let Some(secret) = secret { req = req.header("x-hangar-internal", secret); }
    let resp = req.send().await.unwrap();
    let status = resp.status().as_u16();
    (status, serde_json::from_str(&resp.text().await.unwrap()).unwrap_or(Value::Null))
}

async fn result(srv: &Server, op: &str, args: Value) -> Value {
    let (status, body) = bridge(srv.private, op, args, Some(SECRET)).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["ok"], true, "{op}: {body}");
    body["result"].clone()
}

async fn public(srv: &Server, method: &str, path: &str, body: Option<&Value>) -> Value {
    let mut req = client().request(method.parse().unwrap(), format!("http://{}/api/sessions/{path}", srv.public)).bearer_auth(OWNER);
    if let Some(body) = body { req = req.header("content-type", "application/json").body(body.to_string()); }
    let resp = req.send().await.unwrap();
    let status = resp.status().as_u16();
    let text = resp.text().await.unwrap();
    json!({"status": status, "body": serde_json::from_str::<Value>(&text).unwrap_or(Value::String(text))})
}

async fn group(srv: &Server, name: &str, others: &[&str]) {
    let harness: BTreeMap<String, String> = std::iter::once(name).chain(others.iter().copied()).map(|n| (n.to_owned(), "claude".to_owned())).collect();
    srv.groups.join(JoinOwned { name: name.into(), others: others.iter().map(|o| (*o).to_owned()).collect(), task: String::new(),
        replace_task: false, harness, orq: false, outside: Default::default(), linked: false }).await.ok().unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn bridge_needs_the_secret_and_the_private_port() {
    let dir = tempfile::tempdir().unwrap();
    let srv = server(dir.path(), 1).await;
    assert_eq!(bridge(srv.private, "group.rename", json!({"old": "s0", "new": "s1"}), None).await.0, 404);
    assert_eq!(bridge(srv.private, "group.rename", json!({"old": "s0", "new": "s1"}), Some("outro")).await.0, 404);
    assert_eq!(bridge(srv.public, "group.rename", json!({"old": "s0", "new": "s1"}), Some(SECRET)).await.0, 404, "a porta pública não tem a ponte");
    assert_eq!(bridge(srv.private, "group.nada", json!({}), Some(SECRET)).await.0, 400);
    let health: Value = serde_json::from_str(&client().get(format!("http://{}/__hangar_server/health", srv.public)).send().await.unwrap()
        .text().await.unwrap()).unwrap();
    assert_eq!(health["groups"], true);
}

#[tokio::test(flavor = "multi_thread")]
async fn route_answers_like_the_public_route() {
    let dir = tempfile::tempdir().unwrap();
    let srv = server(dir.path(), 3).await;
    let refused = json!({"peer": "s0"});
    let via_bridge = result(&srv, "group.route", json!({"method": "POST", "name": "s0", "route": "pair", "body": refused})).await;
    assert_eq!(via_bridge, public(&srv, "POST", "s0/pair", Some(&refused)).await);
    assert_eq!(via_bridge["status"], 400);
    let paired = result(&srv, "group.route", json!({"method": "POST", "name": "s0", "route": "pair",
        "body": {"peer": "s1", "peers": [], "task": "t", "replace_task": false, "notify_members": true, "orq": false}})).await;
    assert_eq!(paired["status"], 200, "{paired}");
    assert_eq!(paired["body"]["members"], json!(["s0", "s1"]));
    let contract = result(&srv, "group.route", json!({"method": "GET", "name": "s1", "route": "contract", "body": null})).await;
    assert_eq!(contract, public(&srv, "GET", "s1/pair/contract", None).await);
    let left = result(&srv, "group.route", json!({"method": "DELETE", "name": "s1", "route": "pair", "body": null})).await;
    assert_eq!(left["status"], 200, "{left}");
    assert!(!srv.pair.join("s0.json").exists());
}

/// Corpo que a rota recusa é 422 daqui: o Python, ao receber, pediria à ponte de novo.
#[tokio::test(flavor = "multi_thread")]
async fn bridged_request_never_goes_back_to_python() {
    let dir = tempfile::tempdir().unwrap();
    let srv = server(dir.path(), 2).await;
    for (route, body) in [("pair", json!({"peer": 1})), ("group-message", json!({"texto": "x"})), ("pair-remote", json!({})), ("unpair-remote", json!(null))] {
        let out = result(&srv, "group.route", json!({"method": "POST", "name": "s0", "route": route, "body": body})).await;
        assert_eq!(out["status"], 422, "{route}: {out}");
        assert_eq!(out["body"]["detail"]["code"], "erro_corpo_invalido", "{route}");
    }
    assert_eq!(srv.python.hits_to("/api/sessions/s0/pair") + srv.python.hits_to("/api/sessions/s0/group-message")
        + srv.python.hits_to("/api/sessions/s0/pair-remote") + srv.python.hits_to("/api/sessions/s0/unpair-remote"), 0);
    let (status, body) = bridge(srv.private, "group.route", json!({"method": "PUT", "name": "s0", "route": "pair", "body": null}), Some(SECRET)).await;
    assert_eq!((status, body["ok"].clone(), body["error"]["code"].clone()), (200, json!(false), json!("groups_bridge_invalid_request")));
}

#[tokio::test(flavor = "multi_thread")]
async fn rename_op() {
    let dir = tempfile::tempdir().unwrap();
    let srv = server(dir.path(), 3).await;
    group(&srv, "s0", &["s1"]).await;
    assert_eq!(result(&srv, "group.rename", json!({"old": "s0", "new": "s9"})).await, json!({}));
    let s1: Value = serde_json::from_str(&std::fs::read_to_string(srv.pair.join("s1.json")).unwrap()).unwrap();
    assert_eq!(s1["peers"], json!(["s9"]));
}

fn mtime(path: &Path) -> f64 {
    std::fs::metadata(path).unwrap().modified().unwrap().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs_f64()
}

/// BRG-20 (I-5A): o Python manda os fatos do `orq` no corpo e o Rust associa o time sob o lock de
/// grupo, sem chamar o Python de volta.
#[tokio::test(flavor = "multi_thread")]
async fn orq_associate_never_calls_python() {
    let dir = tempfile::tempdir().unwrap();
    let srv = server(dir.path(), 1).await;
    std::fs::create_dir_all(&srv.pair).unwrap();
    std::fs::write(srv.pair.join("arbiter.json"), json!({"peers": [], "task": "obra", "gid": "real", "harness": {}, "orq": true}).to_string()).unwrap();
    let (draft, real) = (srv.pair.join("regras-draft-p.md"), srv.pair.join("regras-real.md"));
    std::fs::write(&draft, "| papel | conta |\n").unwrap();
    let facts = |gid: &str| json!({"active_gid": null, "draft_gid": "draft-p", "groups": {gid: {"phase": null, "archived": false}}});
    let args = |gid: &str, mtime: f64| json!({"name": "planner", "gid": gid, "mtime": mtime, "facts": facts(gid)});

    let missing = result(&srv, "group.orq_associate", args("missing", mtime(&draft))).await;
    assert_eq!((missing["status"].clone(), missing["body"]["detail"]["code"].clone()), (json!(409), json!("erro_orq_celula_invalida")));
    let stale = result(&srv, "group.orq_associate", args("real", 1.5)).await;
    assert_eq!((stale["status"].clone(), stale["body"]["detail"]["code"].clone()), (json!(409), json!("erro_orq_arquivo_mudou")));
    assert!(!real.exists(), "a recusa não move o time");

    // O lock de grupo segura a associação: uma saída ou um join concorrente não a vê pela metade.
    let (release, held) = tokio::sync::oneshot::channel::<()>();
    let groups = srv.groups.clone();
    let holder = tokio::spawn(async move { groups.locked(async { held.await.ok() }).await });
    tokio::time::sleep(Duration::from_millis(50)).await;
    let private = srv.private;
    let ask = args("real", mtime(&draft));
    let mut associating = tokio::spawn(async move { bridge(private, "group.orq_associate", ask, Some(SECRET)).await });
    assert!(tokio::time::timeout(Duration::from_millis(200), &mut associating).await.is_err(), "a associação espera o lock");
    release.send(()).unwrap();
    holder.await.unwrap();
    let (status, body) = associating.await.unwrap();
    assert_eq!(status, 200, "{body}");
    let done = &body["result"];
    assert_eq!(done["status"], 200, "{done}");
    assert_eq!((done["body"]["ok"].clone(), done["body"]["gid"].clone(), done["body"]["grouped"].clone(), done["body"]["session_prefix"].clone()),
        (json!(true), json!("real"), json!(true), json!("planner")));
    assert_eq!(done["body"]["arquivo"], json!(real.to_str().unwrap()));
    assert!(done["body"]["mtime"].as_f64().unwrap() > 0.0);
    assert_eq!(std::fs::read_to_string(&real).unwrap(), "| papel | conta |\n");
    assert_eq!(std::fs::read_to_string(&draft).unwrap(), "<!-- hangar-orq-group: real -->\n");
    assert!(srv.python.internal_bodies("orq/associate").is_empty() && srv.python.internal_bodies("orq/group-phase").is_empty(),
        "nenhuma pergunta de volta ao Python");
}
