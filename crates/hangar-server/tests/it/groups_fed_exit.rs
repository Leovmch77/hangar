//! Sair, morrer, renomear e dissolver num grupo entre máquinas: a máquina do membro grava na hora e
//! avisa a dona pela fila; a dona tira o membro e, com uma máquina só com membros, dissolve.
//! Mesmas três máquinas no processo do `groups_federation.rs` (`casa`, `lab`, `vm`), mais a porta
//! privada para a ponte de grupos do Python.
#![cfg(unix)]
use crate::fake;
use crate::list_support;

use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

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
use hangar_server::routes::{AppState, router, terminal_router};
use hangar_server::runtime::gateway::RuntimeRegistry;
use hangar_server::share::store::Kind;
use serde_json::{Value, json};

const NAMES: [&str; 4] = ["s0", "s1", "s2", "s3"];

struct Machine { addr: SocketAddr, private: SocketAddr, pair: PathBuf, root: PathBuf, state: Arc<AppState>,
    share: Arc<hangar_server::share::ShareState> }

async fn serve(app: axum::Router) -> SocketAddr {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app.into_make_service_with_connect_info::<SocketAddr>()).await.unwrap() });
    addr
}

async fn machine(root: &Path, id: &str) -> Machine {
    let script = list_support::sessions(root, NAMES.len());
    let home = root.join("home");
    let dirs = parse_dirs(&json!({"home": home, "claude": home.join(".claude"), "codex_home": home.join(".codex"),
        "pi_sessions": home.join(".pi/agent/sessions"), "omp_config": home.join(".omp"),
        "omp_agent": home.join(".omp/agent"), "kimi_home": home.join(".kimi-code")}).to_string());
    let (_python, upstream) = fake::spawn_fake().await;
    let mut state = AppState::new(fake::config(upstream, ""));
    state.list = Arc::new(ListBridge::new(ListEnv { mux: Mux::with_program(&script, Duration::from_secs(5)),
        capture_program: script.into_os_string(), procs: Arc::new(hangar_server::list::procs::SystemProcs::default()), dirs },
        FactsClient::new(upstream, SECRET.into())));
    let pair = home.join(".claude/.hangar-pair");
    federation::configure(&pair, Duration::from_millis(1500), vec![Duration::from_millis(150)]);
    state.groups = Some(Arc::new(GroupService::new(PairDir::new(pair.clone(), root.join("arquivo")), Arc::new(PythonOrq::from_state(&state)), id.into())));
    state.peers = Arc::new(PeerClient::new(PeerBook::new(Some(root.join("peers.json")))));
    let share = crate::share_pair_routes::share_state(&root.join("shares.json"), &pair, Arc::new(Mutex::new(1_000.0)));
    state.share = Some(share.clone());
    let runtime = Arc::new(RuntimeRegistry::new("127.0.0.1:9".parse().unwrap(), "s".into(), "i".into()));
    assert!(state.state.runtime.set(runtime).is_ok());
    let state = Arc::new(state);
    let addr = serve(router(state.clone())).await;
    let private = serve(terminal_router(state.clone())).await;
    Machine { addr, private, pair, root: root.to_path_buf(), state, share }
}

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

/// Grupo criado em `m` com `name` e `others`; devolve o gid.
async fn pair(m: &Machine, name: &str, others: &[&str]) -> String {
    let (status, body) = call(m.addr, "POST", &format!("/api/sessions/{name}/pair"), Some(&json!({"peers": others}))).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["warning"], Value::Null, "{body}");
    body["gid"].as_str().unwrap().to_owned()
}

async fn unpair(m: &Machine, name: &str) {
    let (status, body) = call(m.addr, "DELETE", &format!("/api/sessions/{name}/pair"), None).await;
    assert_eq!(status, 200, "{body}");
}

/// O que o Python pede pela ponte privada de grupos (renomear a sessão).
async fn bridge(m: &Machine, op: &str, args: Value) -> Value {
    let resp = client().post(format!("http://{}/__hangar_server/groups", m.private)).header("content-type", "application/json")
        .header("x-hangar-internal", SECRET).body(json!({"op": op, "args": args}).to_string()).send().await.unwrap();
    let body: Value = serde_json::from_str(&resp.text().await.unwrap()).unwrap();
    assert_eq!(body["ok"], true, "{op}: {body}");
    body["result"].clone()
}

async fn push(m: &Machine, gid: &str, body: Value) -> (u16, Value) { call(m.addr, "PUT", &format!("/api/groups/{gid}"), Some(&body)).await }

fn read_json(path: PathBuf) -> Option<Value> { std::fs::read(path).ok().and_then(|raw| serde_json::from_slice(&raw).ok()) }

fn sidecar(m: &Machine, name: &str) -> Option<Value> { read_json(m.pair.join(format!("{name}.json"))) }

fn record(m: &Machine, gid: &str) -> Option<Value> { read_json(m.pair.join("groups").join(format!("{gid}.json"))) }

fn sorted(v: &Value, f: impl Fn(&Value) -> String) -> Vec<String> {
    let mut out: Vec<String> = v.as_array().unwrap().iter().map(f).collect();
    out.sort();
    out
}

fn members(rec: &Value) -> Vec<String> { sorted(&rec["members"], |m| format!("{}::{}", m["server"].as_str().unwrap(), m["name"].as_str().unwrap())) }

fn peers_of(s: &Value) -> Vec<String> { sorted(&s["peers"], |p| p.as_str().unwrap().to_owned()) }

fn member(server: &str, name: &str) -> Value { json!({"server": server, "name": name, "provider": ""}) }

/// O sidecar de `name` em `m` chega a `want` (a fila entrega depois da resposta).
async fn sidecar_becomes(m: &Machine, name: &str, want: impl Fn(Option<Value>) -> bool + Send + 'static) {
    let path = m.pair.join(format!("{name}.json"));
    fake::wait_until(move || want(read_json(path.clone()))).await;
}

async fn record_becomes(m: &Machine, gid: &str, want: impl Fn(Option<Value>) -> bool + Send + 'static) {
    let path = m.pair.join("groups").join(format!("{gid}.json"));
    fake::wait_until(move || want(read_json(path.clone()))).await;
}

fn has_members(want: &'static [&'static str]) -> impl Fn(Option<Value>) -> bool + Send + 'static {
    move |r| r.is_some_and(|r| members(&r) == want)
}

fn has_peers(want: &'static [&'static str]) -> impl Fn(Option<Value>) -> bool + Send + 'static {
    move |s| s.is_some_and(|s| peers_of(&s) == want)
}

/// Par externo de `local` antes de tudo (o mesmo do `groups_federation.rs`).
fn outside_pair(m: &Machine, local: &str, alias: &str, peer: &str) {
    let (s, _) = m.share.store.create_redeemed(local, Some("t:1".into()), Kind::Pair).unwrap();
    m.share.pairs.add(hangar_server::share::pairs::ExternalPair { share_id: s.id.clone(), local_session: local.into(),
        alias: alias.into(), peer_owner: "Ana".into(), peer_session: peer.into(), peer_address: "http://127.0.0.1:1".into(),
        peer_token: "tok".into(), created_at: 1.0 }).unwrap();
    std::fs::create_dir_all(&m.pair).unwrap();
    std::fs::write(m.pair.join(format!("{local}.json")), json!({"peers": [format!("{alias}::{peer}")], "task": "", "gid": "abababab", "harness": {}}).to_string()).unwrap();
}

/// Dona fora do ar: a saída vale na hora em lab, e o `Leave` espera na fila.
#[tokio::test(flavor = "multi_thread")]
async fn leave_never_waits_for_the_owner() {
    let n = net().await;
    let gid = pair(&n.casa, "s0", &["lab::s1", "lab::s2"]).await;
    sidecar_becomes(&n.lab, "s2", has_peers(&["casa::s0", "s1"])).await;
    peers(&n.lab, &[("casa", closed_port().await), ("vm", n.vm.addr)]);
    unpair(&n.lab, "s1").await;
    assert!(sidecar(&n.lab, "s1").is_none());
    assert_eq!(peers_of(&sidecar(&n.lab, "s2").unwrap()), ["casa::s0"], "o companheiro da mesma máquina já não vê s1");
    let fed = federation::existing(&n.lab.pair).unwrap();
    let leave = OutboxItem::Leave { owner: "casa".into(), gid: gid.clone(), member: "s1".into(), origin: "lab".into() };
    assert!(fed.outbox().pending().contains(&leave), "{:?}", fed.outbox().pending());
    // A dona volta: tira s1 e empurra o grupo novo.
    peers(&n.lab, &[("casa", n.casa.addr), ("vm", n.vm.addr)]);
    record_becomes(&n.casa, &gid, has_members(&["casa::s0", "lab::s2"])).await;
    sidecar_becomes(&n.casa, "s0", has_peers(&["lab::s2"])).await;
}

/// A morte (o que a varredura chama) sai pelo mesmo caminho: a fila, nunca `/unpair-remote`.
#[tokio::test(flavor = "multi_thread")]
async fn dead_member_leaves_through_the_queue() {
    let n = net().await;
    let gid = pair(&n.casa, "s0", &["lab::s1", "vm::s2"]).await;
    sidecar_becomes(&n.vm, "s2", has_peers(&["casa::s0", "lab::s1"])).await;
    let groups = n.lab.state.groups.clone().unwrap();
    let (ex, warnings) = hangar_server::groups::exit::leave_and_notify(&n.lab.state, &groups, "s1").await.unwrap();
    assert_eq!(warnings, Vec::<Value>::new());
    assert_eq!(sorted(&json!(ex), |p| p.as_str().unwrap().to_owned()), ["casa::s0", "vm::s2"]);
    record_becomes(&n.casa, &gid, has_members(&["casa::s0", "vm::s2"])).await;
    sidecar_becomes(&n.vm, "s2", has_peers(&["casa::s0"])).await;
    assert_eq!(peers_of(&sidecar(&n.casa, "s0").unwrap()), ["vm::s2"], "os outros continuam no grupo");
}

#[tokio::test(flavor = "multi_thread")]
async fn rename_reaches_the_owner() {
    let n = net().await;
    let gid = pair(&n.casa, "s0", &["lab::s1", "vm::s2"]).await;
    sidecar_becomes(&n.lab, "s1", |s| s.is_some()).await;
    bridge(&n.lab, "group.rename", json!({"old": "s1", "new": "s3"})).await;
    assert!(sidecar(&n.lab, "s1").is_none());
    assert!(sidecar(&n.lab, "s3").is_some());
    record_becomes(&n.casa, &gid, has_members(&["casa::s0", "lab::s3", "vm::s2"])).await;
    sidecar_becomes(&n.casa, "s0", has_peers(&["lab::s3", "vm::s2"])).await;
    sidecar_becomes(&n.vm, "s2", has_peers(&["casa::s0", "lab::s3"])).await;
    let s3 = sidecar(&n.lab, "s3").unwrap();
    assert_eq!((s3["fed"]["owner"].clone(), peers_of(&s3)), (json!("casa"), vec!["casa::s0".to_owned(), "vm::s2".to_owned()]));
}

/// O `Push` com o nome velho chega antes de a dona aplicar o `Rename`: o membro novo fica.
#[tokio::test(flavor = "multi_thread")]
async fn push_before_rename_keeps_new_name() {
    let n = net().await;
    let gid = pair(&n.casa, "s0", &["lab::s1"]).await;
    sidecar_becomes(&n.lab, "s1", |s| s.is_some()).await;
    peers(&n.lab, &[("casa", closed_port().await), ("vm", n.vm.addr)]);
    bridge(&n.lab, "group.rename", json!({"old": "s1", "new": "s3"})).await;
    let (status, answer) = push(&n.lab, &gid, json!({"protocol": 1, "owner": "casa", "version": 2, "members": [member("casa", "s0"), member("lab", "s1")]})).await;
    assert_eq!(status, 200, "{answer}");
    let s3 = sidecar(&n.lab, "s3").expect("o nome novo continua no grupo");
    assert_eq!((s3["fed"]["version"].clone(), peers_of(&s3)), (json!(2), vec!["casa::s0".to_owned()]));
    assert!(sidecar(&n.lab, "s1").is_none());
}

/// Sobrou uma máquina com membros (a dona): o grupo vira local comum, com o par de fora.
#[tokio::test(flavor = "multi_thread")]
async fn dissolve_keeps_a_local_group_with_outside_pairs() {
    let n = net().await;
    outside_pair(&n.casa, "s0", "pc-ana", "Y");
    let gid = pair(&n.casa, "s0", &["s1", "lab::s2"]).await;
    sidecar_becomes(&n.lab, "s2", |s| s.is_some()).await;
    unpair(&n.lab, "s2").await;
    record_becomes(&n.casa, &gid, |r| r.is_none()).await;
    sidecar_becomes(&n.casa, "s0", |s| s.is_some_and(|s| s.get("fed").is_none())).await;
    let s0 = sidecar(&n.casa, "s0").unwrap();
    assert_eq!((s0["gid"].clone(), peers_of(&s0)), (json!(gid), vec!["pc-ana::Y".to_owned(), "s1".to_owned()]));
    let s1 = sidecar(&n.casa, "s1").unwrap();
    assert!(s1.get("fed").is_none());
    assert_eq!(peers_of(&s1), ["pc-ana::Y", "s0"]);
}

/// Sobrou uma máquina com membros (a participante): lá fica um grupo local comum.
#[tokio::test(flavor = "multi_thread")]
async fn dissolve_leaves_a_local_group_on_the_remaining_machine() {
    let n = net().await;
    let gid = pair(&n.casa, "s0", &["lab::s1", "lab::s2"]).await;
    sidecar_becomes(&n.lab, "s2", has_peers(&["casa::s0", "s1"])).await;
    unpair(&n.casa, "s0").await;
    assert!(record(&n.casa, &gid).is_none(), "a dona dissolve no mesmo passo");
    sidecar_becomes(&n.lab, "s1", |s| s.is_some_and(|s| s.get("fed").is_none() && peers_of(&s) == ["s2"])).await;
    let s2 = sidecar(&n.lab, "s2").unwrap();
    assert!(s2.get("fed").is_none());
    assert_eq!((s2["gid"].clone(), peers_of(&s2)), (json!(gid), vec!["s1".to_owned()]));
}

/// O par de fora de quem sai acaba como hoje; o grupo entre máquinas segue sem ele.
#[tokio::test(flavor = "multi_thread")]
async fn leave_ends_outside_pairs_as_today() {
    let n = net().await;
    outside_pair(&n.casa, "s0", "pc-ana", "Y");
    let gid = pair(&n.casa, "s0", &["lab::s1", "vm::s2"]).await;
    sidecar_becomes(&n.vm, "s2", |s| s.is_some()).await;
    unpair(&n.casa, "s0").await;
    assert!(n.casa.share.pairs.all().is_empty(), "o par de fora acabou");
    assert!(sidecar(&n.casa, "s0").is_none());
    assert_eq!(members(&record(&n.casa, &gid).unwrap()), ["lab::s1", "vm::s2"]);
    sidecar_becomes(&n.lab, "s1", has_peers(&["vm::s2"])).await;
}

/// Dona sem membro próprio continua dona enquanto houver membros em duas máquinas.
#[tokio::test(flavor = "multi_thread")]
async fn owner_without_own_members_stays_owner() {
    let n = net().await;
    let gid = pair(&n.casa, "s0", &["lab::s1", "vm::s2"]).await;
    sidecar_becomes(&n.vm, "s2", |s| s.is_some()).await;
    unpair(&n.casa, "s0").await;
    let rec = record(&n.casa, &gid).expect("a dona mantém o registro");
    assert_eq!((rec["owner"].clone(), members(&rec)), (json!("casa"), vec!["lab::s1".to_owned(), "vm::s2".to_owned()]));
    sidecar_becomes(&n.lab, "s1", has_peers(&["vm::s2"])).await;
    sidecar_becomes(&n.vm, "s2", has_peers(&["lab::s1"])).await;
    assert_eq!(sidecar(&n.lab, "s1").unwrap()["fed"]["owner"], "casa");
}

/// Máquina antiga ainda manda `/unpair-remote` a um grupo que a dona já tem como entre máquinas:
/// passa pelo `remove_member` da dona, e o grupo de dois dissolve.
#[tokio::test(flavor = "multi_thread")]
async fn old_peer_unpair_after_owner_converted() {
    let n = net().await;
    let gid = pair(&n.casa, "s0", &["s1", "lab::s2"]).await;
    sidecar_becomes(&n.lab, "s2", |s| s.is_some()).await;
    let (status, body) = call(n.casa.addr, "POST", "/api/sessions/s0/unpair-remote", Some(&json!({"peer": "lab::s2"}))).await;
    assert_eq!(status, 200, "{body}");
    assert!(record(&n.casa, &gid).is_none(), "uma máquina só com membros: dissolve");
    let s0 = sidecar(&n.casa, "s0").expect("s0 continua com s1");
    assert_eq!(peers_of(&s0), ["s1"]);
    assert!(s0.get("fed").is_none());
    sidecar_becomes(&n.lab, "s2", |s| s.is_none()).await;
}
