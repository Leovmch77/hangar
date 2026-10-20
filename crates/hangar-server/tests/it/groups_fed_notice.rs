//! Aviso de grupo e contrato num grupo entre máquinas: os dois passam pela dona (`casa`). Três
//! máquinas de verdade no processo, cada uma com pasta, id e `peers.json` próprios; os pares de fora
//! são servidores falsos que anotam cada recado.
#![cfg(unix)]
use crate::fake;
use crate::list_support;
use crate::share_pair_routes::{Other, other_machine};

use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use fake::{OWNER, SECRET, client};
use hangar_server::groups::federation;
use hangar_server::groups::orq::PythonOrq;
use hangar_server::groups::peers::{PeerBook, PeerClient};
use hangar_server::groups::service::GroupService;
use hangar_server::groups::store::PairDir;
use hangar_server::list::bridge::{ListBridge, ListEnv, parse_dirs};
use hangar_server::list::facts::FactsClient;
use hangar_server::list::mux::Mux;
use hangar_server::routes::{AppState, router};
use hangar_server::runtime::gateway::RuntimeRegistry;
use hangar_server::share::store::Kind;
use serde_json::{Value, json};

struct Machine { addr: SocketAddr, python: Arc<fake::Fake>, pair: PathBuf, root: PathBuf, state: Arc<AppState>,
    share: Arc<hangar_server::share::ShareState> }

async fn machine(root: &Path, id: &str) -> Machine {
    let script = list_support::sessions(root, 4);
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
    state.groups = Some(Arc::new(GroupService::new(PairDir::new(pair.clone(), root.join("arquivo")), Arc::new(PythonOrq::from_state(&state)), id.into())));
    state.peers = Arc::new(PeerClient::new(PeerBook::new(Some(root.join("peers.json")))));
    let share = crate::share_pair_routes::share_state(&root.join("shares.json"), &pair, Arc::new(Mutex::new(1_000.0)));
    state.share = Some(share.clone());
    let runtime = Arc::new(RuntimeRegistry::new("127.0.0.1:9".parse().unwrap(), "s".into(), "i".into()));
    assert!(state.state.runtime.set(runtime).is_ok());
    let state = Arc::new(state);
    let app = router(state.clone()).into_make_service_with_connect_info::<SocketAddr>();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    Machine { addr, python, pair, root: root.to_path_buf(), state, share }
}

fn peers(m: &Machine, others: &[(&str, SocketAddr)]) {
    let map: serde_json::Map<String, Value> = others.iter()
        .map(|(id, addr)| ((*id).to_owned(), json!({"base_url": format!("http://{addr}"), "token": OWNER}))).collect();
    std::fs::write(m.root.join("peers.json"), Value::Object(map).to_string()).unwrap();
}

/// Endereço que recusa conexão: a máquina fora do ar.
async fn closed_port() -> SocketAddr {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    drop(listener);
    addr
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

async fn say(m: &Machine, name: &str, text: &str) -> (u16, Value) {
    call(m.addr, "POST", &format!("/api/sessions/{name}/group-message"), Some(&json!({"text": text}))).await
}

fn inputs(m: &Machine, name: &str) -> usize { m.python.hits_to(&format!("/api/sessions/{name}/input")) }

fn last_text(m: &Machine) -> String {
    serde_json::from_slice::<Value>(&m.python.last_body()).unwrap()["text"].as_str().unwrap().to_owned()
}

/// Espera cada sessão de `m` em `names` chegar a `n` recados.
async fn reach(m: &Machine, names: &[&str], n: usize) {
    let (python, names): (_, Vec<String>) = (m.python.clone(), names.iter().map(|s| (*s).to_owned()).collect());
    fake::wait_until(move || names.iter().all(|s| python.hits_to(&format!("/api/sessions/{s}/input")) >= n)).await;
}

/// `casa::s0` + `casa::s1` + `lab::s2` + `vm::s3`, dona `casa`, com o protocolo já entregue.
async fn group(n: &Net) -> String {
    let (status, body) = call(n.casa.addr, "POST", "/api/sessions/s0/pair", Some(&json!({"peers": ["s1", "lab::s2", "vm::s3"]}))).await;
    assert_eq!(status, 200, "{body}");
    reach(&n.lab, &["s2"], 1).await;
    reach(&n.vm, &["s3"], 1).await;
    body["gid"].as_str().unwrap().to_owned()
}

/// Par de fora de `local` em `m`, apontando para o servidor falso `base`; o sidecar ganha o endereço.
fn outside(m: &Machine, local: &str, alias: &str, peer: &str, base: &str) {
    let (s, _) = m.share.store.create_redeemed(local, Some("t:1".into()), Kind::Pair).unwrap();
    m.share.pairs.add(hangar_server::share::pairs::ExternalPair { share_id: s.id, local_session: local.into(), alias: alias.into(),
        peer_owner: alias.into(), peer_session: peer.into(), peer_address: base.into(), peer_token: format!("tok-{alias}-{}", "t".repeat(30)),
        created_at: 1.0 }).unwrap();
    let path = m.pair.join(format!("{local}.json"));
    let mut side: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    side["peers"].as_array_mut().unwrap().push(json!(format!("{alias}::{peer}")));
    std::fs::write(path, side.to_string()).unwrap();
}

fn group_notices(o: &Other) -> Vec<Value> {
    o.calls().into_iter().filter(|c| c["path"] == "/api/pair/message" && c["body"]["group"] == true).map(|c| c["body"].clone()).collect()
}

#[tokio::test(flavor = "multi_thread")]
async fn notice_reaches_every_machine() {
    let n = net().await;
    group(&n).await;
    let (status, body) = say(&n.lab, "s2", "oi de lab").await;
    assert_eq!(status, 200, "{body}");
    assert_eq!((body["pulados"].clone(), body["warning"].clone()), (json!([]), Value::Null), "{body}");
    reach(&n.casa, &["s0", "s1"], 2).await;
    reach(&n.vm, &["s3"], 2).await;
    assert_eq!(last_text(&n.vm), "[grupo: lab::s2] oi de lab");
    assert_eq!(last_text(&n.casa), "[grupo: lab::s2] oi de lab");
    assert_eq!(inputs(&n.lab, "s2"), 1, "quem mandou não recebe o próprio aviso");

    let (status, body) = say(&n.casa, "s0", "oi da dona").await;
    assert_eq!((status, body["pulados"].clone()), (200, json!([])), "{body}");
    reach(&n.lab, &["s2"], 2).await;
    assert_eq!(last_text(&n.lab), "[grupo: casa::s0] oi da dona");
    reach(&n.casa, &["s1"], 3).await;
    assert_eq!(inputs(&n.casa, "s0"), 2);
}

/// Review Focus 6: o membro de fora recebe uma vez, pela máquina do par, com o `notice` da dona.
#[tokio::test(flavor = "multi_thread")]
async fn notice_reaches_outside_once() {
    let n = net().await;
    group(&n).await;
    let (ana, base) = other_machine().await;
    outside(&n.casa, "s0", "pc-ana", "Y", &base);
    assert_eq!(say(&n.lab, "s2", "oi").await.0, 200);
    let got = group_notices(&ana);
    assert_eq!(got.len(), 1, "{got:?}");
    assert_eq!((got[0]["text"].clone(), got[0]["session"].clone()), (json!("oi"), json!("Y")));
    assert!(got[0]["notice"].as_str().is_some_and(|s| !s.is_empty()), "{got:?}");
}

/// Duas máquinas próprias com par para a mesma máquina de fora mandam o mesmo `notice`: lá ele entra
/// uma vez só (`share_pair_routes::outside_notice_deduped_across_own_machines`).
#[tokio::test(flavor = "multi_thread")]
async fn own_machines_send_the_same_notice_outside() {
    let n = net().await;
    group(&n).await;
    let (ana, base) = other_machine().await;
    outside(&n.casa, "s0", "pc-ana", "Y", &base);
    outside(&n.lab, "s2", "pc-ana", "Y", &base);
    assert_eq!(say(&n.vm, "s3", "oi").await.0, 200);
    let got = group_notices(&ana);
    assert_eq!(got.len(), 2, "{got:?}");
    assert_eq!(got[0]["notice"], got[1]["notice"], "{got:?}");
}

#[tokio::test(flavor = "multi_thread")]
async fn storm_counts_only_at_the_owner() {
    let n = net().await;
    group(&n).await;
    for (m, name) in [(&n.lab, "s2"), (&n.vm, "s3"), (&n.lab, "s2"), (&n.casa, "s0"), (&n.vm, "s3")] {
        let (status, body) = say(m, name, "marco").await;
        assert_eq!(status, 200, "{body}");
    }
    let (status, body) = say(&n.lab, "s2", "marco").await;
    assert_eq!((status, body["detail"]["code"].clone()), (429, json!("erro_group_message_tempestade")), "{body}");
}

/// Aviso que chegou de fora em `lab` sobe à dona e alcança as outras máquinas, sem sair a nenhum par
/// de fora (nem ao de `casa`, nem de volta ao de `lab`).
#[tokio::test(flavor = "multi_thread")]
async fn outside_notice_never_leaves_to_third_parties() {
    let n = net().await;
    group(&n).await;
    let (ana, ana_base) = other_machine().await;
    let (bia, bia_base) = other_machine().await;
    outside(&n.casa, "s0", "pc-ana", "Y", &ana_base);
    outside(&n.lab, "s2", "pc-bia", "W", &bia_base);
    hangar_server::groups::fed_notice::relay_outside(n.lab.state.clone(), "s2".into(), "pc-bia::W".into(), "oi de fora".into(), "n-1".into());
    reach(&n.casa, &["s0", "s1"], 2).await;
    reach(&n.vm, &["s3"], 2).await;
    assert_eq!(last_text(&n.vm), "[de fora: pc-bia::W via lab] oi de fora");
    assert_eq!(last_text(&n.casa), "[de fora: pc-bia::W via lab] oi de fora");
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(group_notices(&ana).is_empty() && group_notices(&bia).is_empty(), "nenhum par de fora recebe de novo");
    assert_eq!(inputs(&n.lab, "s2"), 1, "a ponta já entregou aos dela no recado");
}

#[tokio::test(flavor = "multi_thread")]
async fn contract_put_conflict_is_409() {
    let n = net().await;
    let gid = group(&n).await;
    let (status, got) = call(n.lab.addr, "GET", "/api/sessions/s2/pair/contract", None).await;
    assert_eq!(status, 200, "{got}");
    assert_eq!((got["path"].clone(), got["owner"].clone(), got["content"].clone(), got["mtime"].clone()), (json!(""), json!("casa"), json!(""), Value::Null));
    let put = |content: &str, mtime: &Value| json!({"content": content, "mtime": mtime});
    let (status, first) = call(n.lab.addr, "PUT", "/api/sessions/s2/pair/contract", Some(&put("decisão A\n", &Value::Null))).await;
    assert_eq!(status, 200, "{first}");
    let contract = n.casa.state.groups.as_ref().unwrap().contract_path(&gid);
    assert_eq!(std::fs::read_to_string(&contract).unwrap(), "decisão A\n", "o arquivo mora na dona");
    let (status, body) = call(n.vm.addr, "PUT", "/api/sessions/s3/pair/contract", Some(&put("outra\n", &Value::Null))).await;
    assert_eq!((status, body["detail"]["code"].clone()), (409, json!("erro_contrato_mudou")), "criação é exclusiva: {body}");
    let (status, second) = call(n.vm.addr, "PUT", "/api/sessions/s3/pair/contract", Some(&put("decisão B\n", &first["mtime"]))).await;
    assert_eq!(status, 200, "{second}");
    let (status, body) = call(n.lab.addr, "PUT", "/api/sessions/s2/pair/contract", Some(&put("velho\n", &first["mtime"]))).await;
    assert_eq!((status, body["detail"]["code"].clone()), (409, json!("erro_contrato_mudou")), "{body}");
    let (status, here) = call(n.casa.addr, "GET", "/api/sessions/s0/pair/contract", None).await;
    assert_eq!(status, 200, "{here}");
    assert_eq!((here["path"].clone(), here["content"].clone(), here["owner"].clone(), here["mtime"].clone()),
        (json!(contract.to_string_lossy()), json!("decisão B\n"), json!("casa"), second["mtime"].clone()));
}

#[tokio::test(flavor = "multi_thread")]
async fn owner_down_contract_is_503() {
    let n = net().await;
    group(&n).await;
    peers(&n.lab, &[("casa", closed_port().await), ("vm", n.vm.addr)]);
    let (status, body) = call(n.lab.addr, "GET", "/api/sessions/s2/pair/contract", None).await;
    assert_eq!((status, body["detail"]["code"].clone()), (503, json!("erro_grupo_dono_indisponivel")), "{body}");
    let (status, body) = call(n.lab.addr, "PUT", "/api/sessions/s2/pair/contract", Some(&json!({"content": "x", "mtime": null}))).await;
    assert_eq!((status, body["detail"]["code"].clone()), (503, json!("erro_grupo_dono_indisponivel")), "{body}");
}

/// Dona fora: os membros da mesma máquina continuam se avisando e as outras vêm em `pulados`.
#[tokio::test(flavor = "multi_thread")]
async fn owner_down_same_machine_still_delivers() {
    let n = net().await;
    let (status, body) = call(n.casa.addr, "POST", "/api/sessions/s0/pair", Some(&json!({"peers": ["lab::s2", "lab::s3"]}))).await;
    assert_eq!(status, 200, "{body}");
    reach(&n.lab, &["s2", "s3"], 1).await;
    peers(&n.lab, &[("casa", closed_port().await), ("vm", n.vm.addr)]);
    let (status, body) = say(&n.lab, "s2", "oi").await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["pulados"], json!(["casa::s0"]), "{body}");
    assert_eq!(body["warning"]["code"], "erro_grupo_dono_indisponivel", "{body}");
    reach(&n.lab, &["s3"], 2).await;
    assert_eq!(last_text(&n.lab), "[grupo: s2] oi");
    assert_eq!(inputs(&n.casa, "s0"), 1);
}
