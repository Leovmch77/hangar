//! Grupo entre máquinas do dono: duas ou três máquinas de verdade no processo (`casa`, `lab`, `vm`),
//! cada uma com a pasta, o id e o `peers.json` dela. A fila anda com escada curta e a dona espera
//! a confirmação por pouco tempo, para a máquina fora do ar não segurar o teste.
#![cfg(unix)]
use crate::fake;
use crate::list_support;

use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::Router;
use axum::http::Method;
use fake::{OWNER, SECRET, client};
use hangar_server::groups::federation;
use hangar_server::groups::orq::PythonOrq;
use hangar_server::groups::outbox::OutboxItem;
use hangar_server::groups::peers::{PeerBook, PeerClient};
use hangar_server::groups::service::GroupService;
use hangar_server::groups::store::PairDir;
use hangar_server::list::bridge::{ListBridge, ListEnv, parse_dirs};
use hangar_server::list::facts::FactsClient;
use hangar_server::list::mux::Mux;
use hangar_server::routes::{AppState, router};
use hangar_server::runtime::gateway::RuntimeRegistry;
use hangar_server::share::caller::{GuestGrant, guest_allowed};
use hangar_server::share::store::Kind;
use serde_json::{Value, json};

const NAMES: [&str; 4] = ["s0", "s1", "s2", "s3"];

struct Machine { addr: SocketAddr, python: Arc<fake::Fake>, pair: PathBuf, root: PathBuf, state: Arc<AppState>,
    share: Arc<hangar_server::share::ShareState>, changes: Arc<AtomicUsize>, runtime: Arc<RuntimeRegistry> }

async fn machine(root: &Path, id: &str) -> Machine {
    let script = list_support::sessions(root, NAMES.len());
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
    federation::configure(&pair, Duration::from_millis(1500), vec![Duration::from_millis(150)]);
    let changes = Arc::new(AtomicUsize::new(0));
    let counter = changes.clone();
    state.groups = Some(Arc::new(GroupService::new(PairDir::new(pair.clone(), root.join("arquivo")), Arc::new(PythonOrq::from_state(&state)), id.into())
        .with_change_hook(Arc::new(move || { counter.fetch_add(1, Ordering::SeqCst); }))));
    state.peers = Arc::new(PeerClient::new(PeerBook::new(Some(root.join("peers.json")))));
    let share = crate::share_pair_routes::share_state(&root.join("shares.json"), &pair, Arc::new(Mutex::new(1_000.0)));
    state.share = Some(share.clone());
    let runtime = Arc::new(RuntimeRegistry::new("127.0.0.1:9".parse().unwrap(), "s".into(), "i".into()));
    assert!(state.state.runtime.set(runtime.clone()).is_ok());
    let state = Arc::new(state);
    let app = router(state.clone()).into_make_service_with_connect_info::<SocketAddr>();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    Machine { addr, python, pair, root: root.to_path_buf(), state, share, changes, runtime }
}

/// Endereço que recusa conexão: a máquina fora do ar.
async fn closed_port() -> SocketAddr {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    drop(listener);
    addr
}

fn peers(m: &Machine, others: &[(&str, SocketAddr)]) {
    let map: serde_json::Map<String, Value> = others.iter()
        .map(|(id, addr)| ((*id).to_owned(), json!({"base_url": format!("http://{addr}"), "token": OWNER}))).collect();
    std::fs::write(m.root.join("peers.json"), Value::Object(map).to_string()).unwrap();
}

struct Net { casa: Machine, lab: Machine, vm: Machine, _dirs: Vec<tempfile::TempDir> }

/// `casa`, `lab` e `vm`, cada uma conhecendo as outras duas.
async fn net() -> Net {
    let dirs: Vec<tempfile::TempDir> = (0..3).map(|_| tempfile::tempdir().unwrap()).collect();
    let casa = machine(dirs[0].path(), "casa").await;
    let lab = machine(dirs[1].path(), "lab").await;
    let vm = machine(dirs[2].path(), "vm").await;
    peers(&casa, &[("lab", lab.addr), ("vm", vm.addr)]);
    peers(&lab, &[("casa", casa.addr), ("vm", vm.addr)]);
    peers(&vm, &[("casa", casa.addr), ("lab", lab.addr)]);
    Net { casa, lab, vm, _dirs: dirs }
}

async fn call(addr: SocketAddr, method: &str, path: &str, body: Option<&Value>) -> (u16, Value) {
    let mut req = client().request(method.parse().unwrap(), format!("http://{addr}{path}")).bearer_auth(OWNER);
    if let Some(body) = body { req = req.header("content-type", "application/json").body(body.to_string()); }
    let resp = req.send().await.unwrap();
    let status = resp.status().as_u16();
    let text = resp.text().await.unwrap();
    (status, serde_json::from_str(&text).unwrap_or(Value::String(text)))
}

async fn pair(m: &Machine, name: &str, body: Value) -> (u16, Value) { call(m.addr, "POST", &format!("/api/sessions/{name}/pair"), Some(&body)).await }

async fn push(m: &Machine, gid: &str, body: Value) -> (u16, Value) { call(m.addr, "PUT", &format!("/api/groups/{gid}"), Some(&body)).await }

fn sidecar(m: &Machine, name: &str) -> Option<Value> {
    std::fs::read(m.pair.join(format!("{name}.json"))).ok().map(|raw| serde_json::from_slice(&raw).unwrap())
}

fn record(m: &Machine, gid: &str) -> Option<Value> {
    std::fs::read(m.pair.join("groups").join(format!("{gid}.json"))).ok().map(|raw| serde_json::from_slice(&raw).unwrap())
}

/// A versão nova chega às participantes pela fila, depois da resposta.
async fn peers_become(m: &Machine, name: &str, want: &[&str]) {
    let (pair, name, want) = (m.pair.clone(), name.to_owned(), want.iter().map(|s| (*s).to_owned()).collect::<Vec<_>>());
    fake::wait_until(move || std::fs::read(pair.join(format!("{name}.json"))).ok()
        .and_then(|raw| serde_json::from_slice::<Value>(&raw).ok()).is_some_and(|v| peers_of(&v) == want)).await;
}

fn inputs(m: &Machine, name: &str) -> usize { m.python.hits_to(&format!("/api/sessions/{name}/input")) }

fn members(v: &Value) -> Vec<String> {
    let mut out: Vec<String> = v.as_array().unwrap().iter().map(|m| format!("{}::{}", m["server"].as_str().unwrap(), m["name"].as_str().unwrap())).collect();
    out.sort();
    out
}

fn peers_of(v: &Value) -> Vec<String> {
    let mut out: Vec<String> = v["peers"].as_array().unwrap().iter().map(|p| p.as_str().unwrap().to_owned()).collect();
    out.sort();
    out
}

fn member(server: &str, name: &str) -> Value { json!({"server": server, "name": name, "provider": ""}) }

#[tokio::test(flavor = "multi_thread")]
async fn three_locals_plus_one_remote() {
    let n = net().await;
    let (status, body) = pair(&n.casa, "s0", json!({"peers": ["s1", "s2", "lab::s3"], "task": "t"})).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["warning"], Value::Null);
    assert_eq!(body["owner"], "casa");
    let gid = body["gid"].as_str().unwrap();
    let rec = record(&n.casa, gid).expect("a dona grava o registro");
    assert_eq!(members(&rec["members"]), ["casa::s0", "casa::s1", "casa::s2", "lab::s3"]);
    assert_eq!(rec["version"], 1);
    for name in ["s0", "s1", "s2"] {
        let s = sidecar(&n.casa, name).unwrap();
        assert_eq!(s["fed"], json!({"owner": "casa", "local": true, "version": 1}), "{name}");
        assert_eq!(inputs(&n.casa, name), 1, "{name} recebe o protocolo");
    }
    assert_eq!(peers_of(&sidecar(&n.casa, "s0").unwrap()), ["lab::s3", "s1", "s2"]);
    let remote = sidecar(&n.lab, "s3").expect("lab grava o membro dela");
    assert_eq!(peers_of(&remote), ["casa::s0", "casa::s1", "casa::s2"]);
    assert_eq!(remote["fed"], json!({"owner": "casa", "local": false, "version": 1}));
    assert_eq!(remote["task"], "t");
    assert_eq!(inputs(&n.lab, "s3"), 1);
    assert!(record(&n.lab, gid).is_none(), "só a dona tem registro");
    assert!(n.lab.changes.load(Ordering::SeqCst) > 0, "o PUT avisa a lista");
    // O grupo como cada máquina o vê.
    let (status, seen) = call(n.lab.addr, "GET", "/api/sessions/s3/group", None).await;
    assert_eq!(status, 200, "{seen}");
    assert_eq!((seen["server_id"].clone(), seen["owner"].clone(), seen["gid"].clone()), (json!("lab"), json!("casa"), json!(gid)));
    assert_eq!(members(&seen["members"]), ["casa::s0", "casa::s1", "casa::s2", "lab::s3"]);
    let (status, none) = call(n.lab.addr, "GET", "/api/sessions/s0/group", None).await;
    assert_eq!((status, none["detail"]["code"].clone()), (404, json!("erro_sessao_sem_grupo")));
}

#[tokio::test(flavor = "multi_thread")]
async fn same_name_on_two_servers_are_two_members() {
    let n = net().await;
    let (status, body) = pair(&n.casa, "s0", json!({"peers": ["lab::s0"]})).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(members(&record(&n.casa, body["gid"].as_str().unwrap()).unwrap()["members"]), ["casa::s0", "lab::s0"]);
    assert_eq!(peers_of(&sidecar(&n.casa, "s0").unwrap()), ["lab::s0"]);
    assert_eq!(peers_of(&sidecar(&n.lab, "s0").unwrap()), ["casa::s0"]);
}

/// Review Focus 1: `lab` confirma, `vm` não responde; quando `vm` volta, não sobra sidecar lá.
#[tokio::test(flavor = "multi_thread")]
async fn join_partial_when_one_server_is_down() {
    let n = net().await;
    peers(&n.casa, &[("lab", n.lab.addr), ("vm", closed_port().await)]);
    let (status, body) = pair(&n.casa, "s0", json!({"peers": ["lab::s1", "vm::s2"]})).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["warning"]["code"], "erro_grupo_membro_nao_confirmado");
    assert_eq!(body["warning"]["params"]["membros"], json!(["vm::s2"]));
    assert_eq!(body["members"], json!(["s0", "lab::s1"]));
    let gid = body["gid"].as_str().unwrap().to_owned();
    assert_eq!(members(&record(&n.casa, &gid).unwrap()["members"]), ["casa::s0", "lab::s1"]);
    peers_become(&n.lab, "s1", &["casa::s0"]).await;
    // vm volta: a fila entrega o grupo atual, sem `s2`.
    peers(&n.casa, &[("lab", n.lab.addr), ("vm", n.vm.addr)]);
    let fed = federation::existing(&n.casa.pair).unwrap();
    let pending = { let fed = fed.clone(); move || fed.outbox().pending().is_empty() };
    fake::wait_until(pending).await;
    assert!(sidecar(&n.vm, "s2").is_none(), "nada nasce em vm");
}

#[tokio::test(flavor = "multi_thread")]
async fn removed_member_is_cancelled_in_pending_push() {
    let n = net().await;
    peers(&n.casa, &[("lab", n.lab.addr), ("vm", closed_port().await)]);
    let (status, body) = pair(&n.casa, "s0", json!({"peers": ["lab::s1", "vm::s2"]})).await;
    assert_eq!(status, 200, "{body}");
    let fed = federation::existing(&n.casa.pair).unwrap();
    let to_vm: Vec<OutboxItem> = fed.outbox().pending().into_iter().filter(|i| i.destination() == "vm").collect();
    assert!(!to_vm.is_empty(), "o envio a vm continua na fila");
    for item in to_vm {
        let OutboxItem::Push { joining, .. } = item else { panic!("só Push para vm: {item:?}") };
        assert!(joining.is_empty(), "s2 saiu do joining: {joining:?}");
    }
}

/// Ninguém de outra máquina confirma: 502 e nada fica.
#[tokio::test(flavor = "multi_thread")]
async fn nobody_confirmed_is_502_and_undone() {
    let n = net().await;
    peers(&n.casa, &[("lab", closed_port().await), ("vm", n.vm.addr)]);
    let (status, body) = pair(&n.casa, "s0", json!({"peers": ["lab::s1"]})).await;
    assert_eq!((status, body["detail"]["code"].clone()), (502, json!("erro_grupo_membro_nao_confirmado")), "{body}");
    assert!(sidecar(&n.casa, "s0").is_none());
    assert!(std::fs::read_dir(n.casa.pair.join("groups")).unwrap().all(|e| {
        let name = e.unwrap().file_name().into_string().unwrap();
        name.starts_with("outbox") || name.starts_with("self")
    }), "registro apagado");
}

#[tokio::test(flavor = "multi_thread")]
async fn push_never_creates_sidecar_outside_joining() {
    let n = net().await;
    let body = json!({"protocol": 1, "owner": "casa", "version": 1, "task": "", "members": [member("casa", "s0"), member("lab", "s1"), member("lab", "s2")],
        "joining": ["s1"]});
    let (status, answer) = push(&n.lab, "g1", body).await;
    assert_eq!(status, 200, "{answer}");
    assert_eq!(answer["server_id"], "lab");
    assert!(sidecar(&n.lab, "s1").is_some());
    assert!(sidecar(&n.lab, "s2").is_none(), "fora do joining não nasce");
    assert_eq!(peers_of(&sidecar(&n.lab, "s1").unwrap()), ["casa::s0", "s2"]);
}

#[tokio::test(flavor = "multi_thread")]
async fn late_push_does_not_resurrect_pending_leave() {
    let n = net().await;
    // A dona fora do ar: o `Leave` fica na fila de lab.
    peers(&n.lab, &[("casa", closed_port().await)]);
    let all = json!([member("casa", "s0"), member("lab", "s1"), member("lab", "s2")]);
    let (status, answer) = push(&n.lab, "g1", json!({"protocol": 1, "owner": "casa", "version": 1, "members": all, "joining": ["s1", "s2"]})).await;
    assert_eq!(status, 200, "{answer}");
    let fed = federation::existing(&n.lab.pair).unwrap();
    // s2 saiu (o que a saída da Task 9 faz): sidecar apagado e `Leave` à dona.
    std::fs::remove_file(n.lab.pair.join("s2.json")).unwrap();
    fed.outbox().enqueue(vec![OutboxItem::Leave { owner: "casa".into(), gid: "g1".into(), member: "s2".into(), origin: "lab".into() }]).unwrap();
    let (status, answer) = push(&n.lab, "g1", json!({"protocol": 1, "owner": "casa", "version": 2, "members": all, "joining": ["s2"]})).await;
    assert_eq!(status, 200, "{answer}");
    assert!(sidecar(&n.lab, "s2").is_none(), "quem saiu não volta");
    assert_eq!(peers_of(&sidecar(&n.lab, "s1").unwrap()), ["casa::s0"], "s2 também some da lista dos outros");
}

#[tokio::test(flavor = "multi_thread")]
async fn stale_push_after_dissolve_is_ignored() {
    let n = net().await;
    let all = json!([member("casa", "s0"), member("lab", "s1")]);
    assert_eq!(push(&n.lab, "g1", json!({"protocol": 1, "owner": "casa", "version": 1, "members": all, "joining": ["s1"]})).await.0, 200);
    assert!(sidecar(&n.lab, "s1").is_some());
    let (status, answer) = push(&n.lab, "g1", json!({"protocol": 1, "owner": "casa", "version": 3, "dissolved": true})).await;
    assert_eq!(status, 200, "{answer}");
    assert!(sidecar(&n.lab, "s1").is_none(), "sem ninguém daqui, o grupo some");
    let (status, answer) = push(&n.lab, "g1", json!({"protocol": 1, "owner": "casa", "version": 2, "members": all, "joining": ["s1"]})).await;
    assert_eq!((status, answer["ignored"].clone()), (200, json!(true)), "{answer}");
    assert!(sidecar(&n.lab, "s1").is_none(), "envio velho não recria");
}

#[tokio::test(flavor = "multi_thread")]
async fn older_version_is_ignored() {
    let n = net().await;
    let all = json!([member("casa", "s0"), member("lab", "s1")]);
    assert_eq!(push(&n.lab, "g1", json!({"protocol": 1, "owner": "casa", "version": 3, "task": "nova", "members": all, "joining": ["s1"]})).await.0, 200);
    let (status, answer) = push(&n.lab, "g1", json!({"protocol": 1, "owner": "casa", "version": 2, "task": "velha", "members": all, "joining": ["s1"]})).await;
    assert_eq!((status, answer["version"].clone()), (200, json!(3)), "{answer}");
    let s = sidecar(&n.lab, "s1").unwrap();
    assert_eq!((s["task"].clone(), s["fed"]["version"].clone()), (json!("nova"), json!(3)));
}

#[tokio::test(flavor = "multi_thread")]
async fn asymmetric_peers_refuses_put() {
    let n = net().await;
    peers(&n.lab, &[("casa", n.casa.addr)]);
    let (status, answer) = push(&n.lab, "g1", json!({"protocol": 1, "owner": "vm", "version": 1, "members": [member("vm", "s0"), member("lab", "s1")],
        "joining": ["s1"]})).await;
    assert_eq!((status, answer["detail"]["code"].clone()), (409, json!("erro_grupo_peer_nao_registrado")), "{answer}");
    assert!(sidecar(&n.lab, "s1").is_none());
}

#[tokio::test(flavor = "multi_thread")]
async fn merge_with_different_owners_is_refused() {
    let n = net().await;
    assert_eq!(pair(&n.casa, "s0", json!({"peers": ["lab::s1"]})).await.0, 200);
    assert_eq!(pair(&n.lab, "s2", json!({"peers": ["s3"]})).await.0, 200);
    let lab_before = sidecar(&n.lab, "s2").unwrap();
    let casa_before = sidecar(&n.casa, "s0").unwrap();
    let (status, body) = pair(&n.casa, "s0", json!({"peers": ["lab::s2"]})).await;
    assert_eq!((status, body["detail"]["code"].clone()), (409, json!("erro_grupo_fusao_entre_donos")), "{body}");
    assert_eq!(sidecar(&n.lab, "s2").unwrap(), lab_before);
    assert_eq!(sidecar(&n.casa, "s0").unwrap(), casa_before);
}

/// Par externo de `casa::s0` antes de tudo: devolve o id do convite.
fn outside_pair(m: &Machine, local: &str, alias: &str, peer: &str) -> String {
    let (s, _) = m.share.store.create_redeemed(local, Some("t:1".into()), Kind::Pair).unwrap();
    m.share.pairs.add(hangar_server::share::pairs::ExternalPair { share_id: s.id.clone(), local_session: local.into(),
        alias: alias.into(), peer_owner: "Ana".into(), peer_session: peer.into(), peer_address: "http://127.0.0.1:1".into(),
        peer_token: "tok".into(), created_at: 1.0 }).unwrap();
    std::fs::create_dir_all(&m.pair).unwrap();
    std::fs::write(m.pair.join(format!("{local}.json")), json!({"peers": [format!("{alias}::{peer}")], "task": "", "gid": "abababab", "harness": {}}).to_string()).unwrap();
    s.id
}

#[tokio::test(flavor = "multi_thread")]
async fn local_group_with_outside_member_becomes_federated() {
    let n = net().await;
    outside_pair(&n.casa, "s0", "pc-ana", "Y");
    let (status, body) = pair(&n.casa, "s0", json!({"peers": ["lab::s2"]})).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["gid"], "abababab", "o grupo local vira o grupo entre máquinas");
    let rec = record(&n.casa, "abababab").unwrap();
    assert_eq!(rec["outside"], json!([{"server": "casa", "address": "pc-ana::Y"}]));
    let s0 = sidecar(&n.casa, "s0").unwrap();
    assert_eq!(peers_of(&s0), ["lab::s2", "pc-ana::Y"]);
    assert_eq!(s0["fed"]["owner"], "casa");
}

/// I-6A: o par de fora só vale na máquina dele.
#[tokio::test(flavor = "multi_thread")]
async fn outside_member_access_stays_on_its_machine() {
    let n = net().await;
    let share_id = outside_pair(&n.casa, "s0", "pc-ana", "Y");
    let (status, body) = pair(&n.casa, "s0", json!({"peers": ["s1", "lab::s2"]})).await;
    assert_eq!(status, 200, "{body}");
    let granted: Vec<String> = n.casa.share.store.children(&share_id).into_iter().map(|c| c.session).collect();
    assert!(granted.contains(&"s1".to_owned()), "membro daqui ganha ver e recado: {granted:?}");
    assert!(peers_of(&sidecar(&n.casa, "s1").unwrap()).contains(&"pc-ana::Y".to_owned()));
    let lab = sidecar(&n.lab, "s2").unwrap();
    assert!(!peers_of(&lab).contains(&"pc-ana::Y".to_owned()), "lab não grava o par de fora");
    assert!(n.lab.share.store.all().is_empty() && n.lab.share.pairs.all().is_empty(), "nenhum acesso em lab");
}

#[tokio::test(flavor = "multi_thread")]
async fn join_keeps_fed_and_linked_by() {
    let n = net().await;
    assert_eq!(pair(&n.casa, "s0", json!({"peers": ["lab::s3"]})).await.0, 200);
    let (status, body) = pair(&n.casa, "s0", json!({"peers": ["s1"]})).await;
    assert_eq!(status, 200, "{body}");
    let mut s1 = sidecar(&n.casa, "s1").unwrap();
    s1["linked_by"] = json!("s0");
    std::fs::write(n.casa.pair.join("s1.json"), s1.to_string()).unwrap();
    let (status, body) = pair(&n.casa, "s0", json!({"peers": ["s2"]})).await;
    assert_eq!(status, 200, "{body}");
    let s1 = sidecar(&n.casa, "s1").unwrap();
    assert_eq!(s1["linked_by"], "s0");
    assert_eq!(s1["fed"], json!({"owner": "casa", "local": true, "version": 3}));
    peers_become(&n.lab, "s3", &["casa::s0", "casa::s1", "casa::s2"]).await;
}

/// Quem inicia não é a dona: a dona (lab) empurra para casa, que não segura o passe de `s0`.
#[tokio::test(flavor = "multi_thread")]
async fn join_from_participant_does_not_deadlock() {
    let n = net().await;
    assert_eq!(pair(&n.lab, "s1", json!({"peers": ["s2"]})).await.0, 200);
    let (status, body) = pair(&n.casa, "s0", json!({"peers": ["lab::s1"]})).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["warning"], Value::Null, "confirmado, sem esperar o prazo");
    assert_eq!(body["owner"], "lab");
    let mut got: Vec<String> = body["members"].as_array().unwrap().iter().map(|m| m.as_str().unwrap().to_owned()).collect();
    got.sort();
    assert_eq!(got, ["lab::s1", "lab::s2", "s0"]);
    let s0 = sidecar(&n.casa, "s0").unwrap();
    assert_eq!(s0["fed"], json!({"owner": "lab", "local": false, "version": 1}));
    assert_eq!(inputs(&n.casa, "s0"), 1, "o protocolo chega pela máquina dela");
    assert!(record(&n.lab, body["gid"].as_str().unwrap()).is_some());
}

#[tokio::test(flavor = "multi_thread")]
async fn old_version_peer_is_refused_with_code() {
    let n = net().await;
    // Hangar antigo: rota que não existe responde o 404 do FastAPI, sem código.
    let old = Router::new().fallback(|| async { (axum::http::StatusCode::NOT_FOUND, [("content-type", "application/json")], r#"{"detail":"Not Found"}"#) });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, old).await.unwrap() });
    peers(&n.casa, &[("old", addr)]);
    let (status, body) = pair(&n.casa, "s0", json!({"peers": ["old::x"]})).await;
    assert_eq!((status, body["detail"]["code"].clone()), (409, json!("erro_grupo_peer_versao_antiga")), "{body}");
    assert!(sidecar(&n.casa, "s0").is_none());
}

#[tokio::test(flavor = "multi_thread")]
async fn outside_pair_on_fed_group_links_at_owner() {
    let n = net().await;
    let (status, body) = pair(&n.casa, "s0", json!({"peers": ["lab::s1"]})).await;
    assert_eq!(status, 200, "{body}");
    let gid = body["gid"].as_str().unwrap().to_owned();
    // O par de fora de lab entra no grupo daqui (antes recusado como mistura com máquina própria).
    let groups = n.lab.state.groups.clone().unwrap();
    let outside = std::collections::HashSet::from(["pc-bia::Z".to_owned()]);
    groups.external_link("s1", "pc-bia::Z", Default::default(), outside).await.expect("grupo entre máquinas aceita par de fora");
    let side = groups.link("s1").await.unwrap().unwrap();
    federation::outside_changed(&n.lab.state, &side, "pc-bia::Z", true).await;
    let casa = n.casa.pair.clone();
    fake::wait_until(move || std::fs::read(casa.join("groups").join(format!("{gid}.json"))).ok()
        .and_then(|raw| serde_json::from_slice::<Value>(&raw).ok())
        .is_some_and(|r| r["outside"] == json!([{"server": "lab", "address": "pc-bia::Z"}]))).await;
}

fn grant(kind: Kind) -> GuestGrant {
    GuestGrant { token: "t".into(), token_hash: "h".into(), sessions: HashMap::from([("s0".to_string(), kind)]), pair_roots: vec![], invite: true }
}

#[test]
fn guest_cannot_read_group() {
    for kind in [Kind::Share, Kind::Pair] {
        assert!(!guest_allowed(&Method::GET, "/api/sessions/s0/group", &grant(kind)), "{kind:?}");
    }
}

/// Rotas entre máquinas fora da porta do convidado; a recusa do porteiro leva código
/// (`erro_fora_do_convite`), nunca o 404 sem código que outra máquina leria como versão antiga.
#[test]
fn guest_groups_routes_refused_with_code() {
    for (method, path) in [(Method::GET, "/api/groups/g1"), (Method::PUT, "/api/groups/g1"), (Method::POST, "/api/groups/g1/ops")] {
        assert!(!guest_allowed(&method, path, &grant(Kind::Share)), "{method} {path}");
    }
}

/// Sem o token de dono, as rotas entre máquinas recusam com código.
#[tokio::test(flavor = "multi_thread")]
async fn groups_routes_without_owner_token_have_a_code() {
    let n = net().await;
    let resp = client().get(format!("http://{}/api/groups/g1", n.casa.addr)).send().await.unwrap();
    assert_eq!(resp.status().as_u16(), 401);
    let body: Value = serde_json::from_str(&resp.text().await.unwrap()).unwrap();
    assert_eq!(body["detail"]["code"], "erro_nao_autorizado");
    let (status, body) = call(n.casa.addr, "GET", "/api/groups/nada", None).await;
    assert_eq!((status, body["detail"]["code"].clone(), body["server_id"].clone()), (404, json!("erro_grupo_inexistente"), json!("casa")));
}

/// Porta do Connect: o Python autentica o dono e repassa pela ponte privada; a resposta leva código
/// e `server_id`. Convidado repassado é recusado com código.
#[tokio::test(flavor = "multi_thread")]
async fn connect_forwarded_groups_routes_answer_with_code() {
    let n = net().await;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let private = listener.local_addr().unwrap();
    let app = hangar_server::routes::terminal_router(n.casa.state.clone()).into_make_service_with_connect_info::<SocketAddr>();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let bridged = |method: reqwest::Method, path: &str| client().request(method, format!("http://{private}/__hangar_server/forwarded"))
        .header("x-hangar-path", path).header("x-hangar-internal", SECRET);
    let body = |r: reqwest::Response| async move { (r.status().as_u16(), serde_json::from_str::<Value>(&r.text().await.unwrap()).unwrap()) };
    let (status, got) = body(bridged(reqwest::Method::GET, "/api/groups/nada").send().await.unwrap()).await;
    assert_eq!((status, got["detail"]["code"].clone(), got["server_id"].clone()), (404, json!("erro_grupo_inexistente"), json!("casa")));
    let (status, got) = body(bridged(reqwest::Method::GET, "/api/sessions/s0/group").send().await.unwrap()).await;
    assert_eq!((status, got["detail"]["code"].clone()), (404, json!("erro_sessao_sem_grupo")));
    let (status, got) = body(bridged(reqwest::Method::GET, "/api/groups/nada").header("x-hangar-forwarded-guest", "1").send().await.unwrap()).await;
    assert_eq!((status, got["detail"]["code"].clone()), (403, json!("erro_fora_do_convite")));
}

/// Renomear pendente nesta máquina vence o envio da dona com o nome velho.
#[tokio::test(flavor = "multi_thread")]
async fn pending_rename_wins_over_old_push() {
    let n = net().await;
    peers(&n.lab, &[("casa", closed_port().await)]);
    let old = json!([member("casa", "s0"), member("lab", "s1")]);
    assert_eq!(push(&n.lab, "g1", json!({"protocol": 1, "owner": "casa", "version": 1, "members": old, "joining": ["s1"]})).await.0, 200);
    // O que o renomear da Task 9 faz: aplica aqui e deixa o `Rename` na fila da dona.
    n.lab.state.groups.clone().unwrap().rename("s1", "s2").await.unwrap();
    federation::existing(&n.lab.pair).unwrap().outbox().enqueue(vec![OutboxItem::Rename { owner: "casa".into(), gid: "g1".into(),
        from: "s1".into(), to: "s2".into(), origin: "lab".into() }]).unwrap();
    let (status, answer) = push(&n.lab, "g1", json!({"protocol": 1, "owner": "casa", "version": 2, "task": "t2", "members": old, "joining": []})).await;
    assert_eq!(status, 200, "{answer}");
    let s2 = sidecar(&n.lab, "s2").expect("o nome novo continua no grupo");
    assert_eq!((s2["task"].clone(), s2["fed"]["version"].clone()), (json!("t2"), json!(2)));
    assert!(sidecar(&n.lab, "s1").is_none(), "o nome velho não volta");
}

/// Quem inicia solta o passe de `s0` antes de esperar a dona: um fechamento da porta (rename,
/// troca de conta) não fica preso atrás de outra máquina.
#[tokio::test(flavor = "multi_thread")]
async fn initiator_releases_ingress_before_calling_the_owner() {
    let n = net().await;
    peers(&n.casa, &[("lab", n.lab.addr), ("vm", closed_port().await)]);
    let addr = n.casa.addr;
    let asked = tokio::spawn(async move { call(addr, "POST", "/api/sessions/s0/pair", Some(&json!({"peers": ["lab::s1", "vm::s2"]}))).await });
    // O registro gravado = a dona já espera vm (1,5 s).
    let pair_dir = n.casa.pair.clone();
    fake::wait_until(move || std::fs::read_dir(pair_dir.join("groups")).is_ok_and(|d| d.flatten()
        .any(|e| { let f = e.file_name().into_string().unwrap(); f.ends_with(".json") && !f.starts_with("outbox") && !f.starts_with("self") }))).await;
    n.casa.runtime.ingress().close("s0", Duration::from_millis(300)).await.expect("o passe de s0 já saiu");
    n.casa.runtime.ingress().open("s0");
    assert_eq!(asked.await.unwrap().0, 200);
}

/// O `PUT` da dona não passa pela porta da sessão: com ela retida, o membro entra mesmo assim.
#[tokio::test(flavor = "multi_thread")]
async fn participant_put_does_not_enter_the_session_gate() {
    let n = net().await;
    n.lab.runtime.ingress().hold("s1", Duration::from_millis(10)).await.unwrap();
    let (status, answer) = push(&n.lab, "g1", json!({"protocol": 1, "owner": "casa", "version": 1, "members": [member("casa", "s0"), member("lab", "s1")],
        "joining": ["s1"]})).await;
    assert_eq!(status, 200, "{answer}");
    assert!(sidecar(&n.lab, "s1").is_some());
}
