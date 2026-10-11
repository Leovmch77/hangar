//! Vigia do Codex com terminal (`codex_terminal::Watcher`): as rodadas chamadas direto, sobre um tmux falso
//! (lista de panes num arquivo), sidecars numa pasta temporária e app-servers falsos. Nenhuma sessão viva.
use crate::runtime_open::{app_server_process,fake_app_server,registry};
use hangar_server::accounts::environment::AccountEnvironment;
use hangar_server::list::mux::Mux;
use hangar_server::runtime::codex_relaunch::PermissionRead;
use hangar_server::runtime::codex_terminal::{WatchConfig,Watcher};
use hangar_server::runtime::gateway::RuntimeRegistry;
use hangar_server::runtime::protocol::{ClockSample,RuntimeError};
use hangar_server::runtime::queue::Action;
use serde_json::{Value,json};
use std::path::PathBuf;
use std::process::Child;
use std::sync::Arc;
use std::time::{Duration,Instant};

pub(crate) struct Fixture { _dir:tempfile::TempDir, home:PathBuf, queue:PathBuf, panes:PathBuf, tmux:PathBuf, root:PathBuf }

/// `list-panes` lê o arquivo (com `.down` ao lado, o multiplexador não responde); `has-session` procura o
/// nome nele e `kill-session` o tira.
pub(crate) fn fixture() -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_owned();
    let (home,queue,panes,tmux) = (root.join("home"),root.join("claude").join(".hangar-queue"),root.join("panes"),root.join("fake-tmux"));
    std::fs::write(&panes,"").unwrap();
    let p = panes.display();
    crate::write_executable(&tmux,format!("#!/bin/sh\nP='{p}'\ncase \"$1\" in\n  list-panes) [ -f \"$P.down\" ] && exit 2; cat \"$P\";;\n  \
        has-session) n=\"${{3#=}}\"; grep -q \"^$n\t\" \"$P\";;\n  \
        kill-session) n=\"${{3#=}}\"; grep -v \"^$n\t\" \"$P\" > \"$P.new\"; mv \"$P.new\" \"$P\";;\n  \
        display-message) printf 'cx-proof\t%%7\t1700000000\\n';;\n  \
        send-keys) echo \"$@\" >> \"$P.keys\";;\n  *) exit 1;;\nesac\n"));
    Fixture { _dir:dir,home,queue,panes,tmux,root }
}

impl Fixture {
    pub(crate) fn watcher(&self) -> Arc<Watcher> {
        Arc::new(Watcher::new(WatchConfig { home:self.home.clone(),queue_dir:self.queue.clone(),
            mux:Mux::with_program(&self.tmux,Duration::from_secs(5)),mux_program:self.tmux.clone().into_os_string() })
            .with_death_after(DEATH_AFTER))
    }
    fn sidecar_dir(&self) -> PathBuf { self.home.join(".hangar").join("codex-sessions") }
    fn sidecar_path(&self,name:&str) -> PathBuf { self.sidecar_dir().join(format!("{name}.json")) }
    /// Grava por rename, como o Python: a pasta muda e a leitura em cache da lista vê a versão nova.
    pub(crate) fn put_sidecar(&self,name:&str,meta:Value) {
        std::fs::create_dir_all(self.sidecar_dir()).unwrap();
        let tmp = self.sidecar_dir().join(format!("{name}.tmp"));
        std::fs::write(&tmp,meta.to_string()).unwrap();
        std::fs::rename(tmp,self.sidecar_path(name)).unwrap();
    }
    fn sidecar(&self,name:&str) -> Option<Value> { std::fs::read(self.sidecar_path(name)).ok().map(|raw|serde_json::from_slice(&raw).unwrap()) }
    pub(crate) fn panes(&self,names:&[&str]) {
        let lines:String = names.iter().map(|name|format!("{name}\t1\t4242\t/w\t%7\t\tcodex\t1700000000\t0\t0\n")).collect();
        std::fs::write(&self.panes,lines).unwrap();
    }
    /// Panes com id e nascimento escolhidos: (sessão, pane, nascimento).
    fn panes_born(&self,panes:&[(&str,&str,u64)]) {
        let lines:String = panes.iter().map(|(name,id,born)|format!("{name}\t1\t4242\t/w\t{id}\t\tcodex\t{born}\t0\t0\n")).collect();
        std::fs::write(&self.panes,lines).unwrap();
    }
    fn queue_json(&self,key:&str) -> Value { serde_json::from_slice(&std::fs::read(self.queue_state(key)).unwrap()).unwrap() }
    fn queue_state(&self,key:&str) -> PathBuf { self.queue.join("runtime").join(format!("{key}.json")) }
    pub(crate) fn meta(&self,name:&str,endpoint:&str,app_pid:Option<u32>,tui:&Child) -> Value {
        json!({"name":name,"provider":"codex","thread_id":"thread-1","rollout_path":null,"cwd":self.root,"model":null,"effort":null,
            "endpoint":endpoint,"app_pid":app_pid,"tui_pid":tui.id(),"codex_home":self.root.join("codex-home")})
    }
}

/// Prazo de ausência da vigia nos testes.
const DEATH_AFTER:Duration = Duration::from_millis(300);
const CLOCK:ClockSample = ClockSample { monotonic_s:0.0,epoch_s:1000.0 };

pub(crate) fn tui() -> Child { std::process::Command::new("sh").args(["-c","sleep 120; true","codex-tui"]).spawn().unwrap() }

fn exited(child:&mut Child) -> bool {
    let deadline = Instant::now() + Duration::from_secs(3);
    while Instant::now() < deadline {
        if child.try_wait().unwrap().is_some() { return true; }
        std::thread::sleep(Duration::from_millis(20));
    }
    false
}

pub(crate) fn finish(children:&mut [&mut Child]) { for child in children { let _ = child.kill(); let _ = child.wait(); } }

fn key_of(meta:&Value) -> String { meta["key"].as_str().expect("chave gravada na adoção").to_owned() }

#[tokio::test]
async fn a_round_adopts_follows_a_new_app_server_and_buries_the_dead_pane() {
    let fx = fixture();
    let (first,second) = (fake_app_server(true).await,fake_app_server(true).await);
    let (mut app1,mut app2,mut tui) = (app_server_process(&first.endpoint),app_server_process(&second.endpoint),tui());
    fx.put_sidecar("cx-proof",fx.meta("cx-proof",&first.endpoint,Some(app1.id()),&tui));
    fx.panes(&["cx-proof"]);
    let registry = registry().await;
    let watcher = fx.watcher();
    watcher.round(&registry).await;
    assert!(registry.owns_codex_terminal("cx-proof"),"pane vivo e sidecar pronto: adotado sem o Python");
    first.wait_method(1,"initialize").await;
    let key = key_of(&fx.sidecar("cx-proof").unwrap());
    let state:Value = serde_json::from_slice(&std::fs::read(fx.queue_state(&key)).unwrap()).unwrap();
    assert_eq!(state["generation"],1);
    assert_eq!(state["runtime_state"]["codex_life"]["tui_pid"],tui.id());
    watcher.round(&registry).await;
    assert_eq!(first.connections.load(std::sync::atomic::Ordering::SeqCst),1,"a mesma vida não reabre");

    // O lançador ressubiu o app-server: mesma chave, geração nova, e o antigo não é morto pela vigia.
    let mut meta = fx.meta("cx-proof",&second.endpoint,Some(app2.id()),&tui);
    meta["key"] = json!(key);
    fx.put_sidecar("cx-proof",meta);
    watcher.round(&registry).await;
    assert!(registry.handle(&key,1).await.is_err(),"a vida antiga saiu");
    assert!(registry.handle(&key,2).await.is_ok(),"a vida nova abriu na mesma chave");
    second.wait_method(1,"initialize").await;
    assert!(app1.try_wait().unwrap().is_none());

    // Pane morto e TUI morta pelo prazo, depois ator, app-server, sidecar e fila desta vida.
    fx.panes(&[]);
    tui.kill().unwrap(); tui.wait().unwrap();
    watcher.round(&registry).await;
    watcher.round(&registry).await;
    assert!(registry.handle(&key,2).await.is_ok(),"rodadas seguidas (o `wake`) não encerram antes do prazo");
    tokio::time::sleep(DEATH_AFTER + Duration::from_millis(50)).await;
    watcher.round(&registry).await;
    assert!(registry.handle(&key,2).await.is_err());
    assert!(!registry.owns_codex_terminal("cx-proof"));
    assert!(exited(&mut app2),"o app-server desta vida recebeu o SIGTERM");
    assert!(fx.sidecar("cx-proof").is_none(),"sidecar da vida apagado");
    assert!(!fx.queue_state(&key).exists(),"fila da vida apagada");
    finish(&mut [&mut app1,&mut app2]);
}

#[tokio::test]
async fn rename_and_mode_switch_close_the_actor_without_killing() {
    let fx = fixture();
    let server = fake_app_server(true).await;
    let (mut app,mut tui) = (app_server_process(&server.endpoint),tui());
    fx.put_sidecar("cx-proof",fx.meta("cx-proof",&server.endpoint,Some(app.id()),&tui));
    fx.panes(&["cx-proof"]);
    let registry = registry().await;
    let watcher = fx.watcher();
    watcher.round(&registry).await;
    let key = key_of(&fx.sidecar("cx-proof").unwrap());

    // Renomear: o Python move tmux e sidecar; a mesma chave com nome novo fecha uma e abre a outra.
    let mut renamed = fx.sidecar("cx-proof").unwrap();
    renamed["name"] = json!("cx-renamed");
    fx.put_sidecar("cx-renamed",renamed);
    std::fs::remove_file(fx.sidecar_path("cx-proof")).unwrap();
    fx.panes(&["cx-renamed"]);
    watcher.round(&registry).await;
    assert!(!registry.owns_codex_terminal("cx-proof"));
    assert!(registry.owns_codex_terminal("cx-renamed"),"a mesma chave segue com o nome novo");
    assert_eq!(registry.codex_terminals().await.iter().map(|t|t.key.clone()).collect::<Vec<_>>(),vec![key.clone()]);

    // Troca de modo em curso (`app_pid` nulo): o ator sai, nada morre e nada é apagado.
    let mut switching = fx.sidecar("cx-renamed").unwrap();
    switching["app_pid"] = Value::Null;
    fx.put_sidecar("cx-renamed",switching);
    watcher.round(&registry).await;
    assert!(!registry.owns_codex_terminal("cx-renamed"));
    assert!(app.try_wait().unwrap().is_none(),"o app-server segue vivo");
    assert!(fx.sidecar("cx-renamed").is_some(),"o sidecar é do Python durante a troca");
    finish(&mut [&mut app,&mut tui]);
}

#[tokio::test]
async fn no_answer_from_the_multiplexer_decides_nothing() {
    let fx = fixture();
    let server = fake_app_server(true).await;
    let (mut app,mut tui) = (app_server_process(&server.endpoint),tui());
    fx.put_sidecar("cx-proof",fx.meta("cx-proof",&server.endpoint,Some(app.id()),&tui));
    fx.panes(&["cx-proof"]);
    std::fs::write(fx.panes.with_extension("down"),"").unwrap();
    let registry = registry().await;
    let watcher = fx.watcher();
    watcher.round(&registry).await;
    assert!(!registry.owns_codex_terminal("cx-proof"),"sem lista de panes não adota");
    std::fs::remove_file(fx.panes.with_extension("down")).unwrap();
    watcher.round(&registry).await;
    assert!(registry.owns_codex_terminal("cx-proof"));
    // Pane some com o multiplexador mudo: nunca conta como morte.
    tui.kill().unwrap(); tui.wait().unwrap();
    std::fs::write(fx.panes.with_extension("down"),"").unwrap();
    for _ in 0..3 { watcher.round(&registry).await; }
    assert!(registry.owns_codex_terminal("cx-proof"));
    assert!(app.try_wait().unwrap().is_none());
    finish(&mut [&mut app]);
}

#[tokio::test]
async fn closing_from_the_app_kills_the_pane_first_then_the_whole_life() {
    let fx = fixture();
    let server = fake_app_server(true).await;
    let (mut app,mut tui) = (app_server_process(&server.endpoint),tui());
    fx.put_sidecar("cx-proof",fx.meta("cx-proof",&server.endpoint,Some(app.id()),&tui));
    fx.panes(&["cx-proof"]);
    let registry = registry().await;
    let watcher = fx.watcher();
    assert_eq!(registry.adopt_now("cx-proof").await.map(|r|r.is_ok()),None,"sem a vigia ligada, nada adota pela escrita");
    registry.bind_watcher(watcher.clone());
    assert_eq!(registry.adopt_now("other").await.map(|r|r.is_ok()),None,"sem sidecar Codex: o caminho de sempre");
    assert_eq!(registry.adopt_now("cx-proof").await.map(|r|r.is_ok()),Some(true),"a escrita adota na hora");
    assert!(registry.owns_codex_terminal("cx-proof"));
    let key = key_of(&fx.sidecar("cx-proof").unwrap());
    let closed = registry.close_with_kill(&key,1).await.unwrap();
    assert_eq!(closed,json!({"closed":true,"killed":true}));
    assert!(std::fs::read_to_string(&fx.panes).unwrap().is_empty(),"o kill-session saiu e foi conferido");
    assert!(!registry.owns_codex_terminal("cx-proof"));
    assert!(exited(&mut app));
    assert!(fx.sidecar("cx-proof").is_none());
    assert!(!fx.queue_state(&key).exists());
    finish(&mut [&mut app,&mut tui]);
}

#[tokio::test]
async fn another_tui_with_an_inherited_key_gets_a_fresh_queue() {
    let fx = fixture();
    let server = fake_app_server(true).await;
    let (mut app,mut tui) = (app_server_process(&server.endpoint),tui());
    // Fila de outra vida de mesmo nome e mesma chave (o `sessions.save` conserva a chave).
    {
        let path = fx.queue_state("old-key");
        let lease = hangar_server::runtime::queue::acquire_lease(&path.with_extension("lock")).unwrap();
        let mut store = hangar_server::runtime::queue::Store::open(&path,&fx.queue,
            hangar_server::runtime::queue::State::new("old-key",3,"cx-proof",Vec::new())).unwrap();
        store.exec(3,"life",CLOCK,Action::AdvanceLifecycle { generation:3,
            state:json!({"codex_life":{"created":1,"tui_pid":1,"endpoint":"ws://127.0.0.1:1","app_pid":1},"name":"cx-proof"}) }).unwrap();
        drop(lease);
    }
    let mut meta = fx.meta("cx-proof",&server.endpoint,Some(app.id()),&tui);
    meta["key"] = json!("old-key");
    fx.put_sidecar("cx-proof",meta);
    fx.panes(&["cx-proof"]);
    let registry = registry().await;
    fx.watcher().round(&registry).await;
    let key = key_of(&fx.sidecar("cx-proof").unwrap());
    assert_ne!(key,"old-key","outra TUI gira a chave");
    assert!(!fx.queue_state("old-key").exists(),"a fila da vida anterior não é entregue nesta");
    assert!(registry.handle(&key,1).await.is_ok());
    finish(&mut [&mut app,&mut tui]);
}

/// Registro com o ambiente do Codex na pasta do teste: conta padrão em `<home>/.codex`, PATH só com `bin/`.
async fn relaunch_registry(fx:&Fixture) -> Arc<RuntimeRegistry> {
    let bin = fx.root.join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    let map = [("HOME",fx.home.to_string_lossy().into_owned()),("PATH",bin.to_string_lossy().into_owned())]
        .into_iter().map(|(k,v)|(k.to_owned(),v)).collect();
    crate::runtime_open::registry_with(|registry|registry.with_codex_environment(AccountEnvironment::from_map(map))).await
}

/// Sidecar adotável com o rollout no disco e a conta padrão do ambiente do teste.
fn relaunch_meta(fx:&Fixture,endpoint:&str,app:&Child,tui:&Child) -> Value {
    let rollout = fx.root.join("rollout.jsonl");
    std::fs::write(&rollout,"{}\n").unwrap();
    let mut meta = fx.meta("cx-proof",endpoint,Some(app.id()),tui);
    meta["rollout_path"] = json!(rollout);
    meta["codex_home"] = json!(fx.home.join(".codex"));
    meta
}

/// Troca para sem terminal repetida enquanto o motor recém-adotado ainda não assentou: a recusa de
/// "ociosa" não mexe em nada e pode repetir.
async fn switch_until_settled(watcher:&Watcher,registry:&RuntimeRegistry,read:impl Fn() -> PermissionRead) -> RuntimeError {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        match watcher.switch_mode(registry,"cx-proof",false,read()).await.expect("Codex com terminal do Rust") {
            Err(error) if error.message.contains("ociosa") && Instant::now() < deadline => {
                assert!(registry.owns_codex_terminal("cx-proof"),"recusa não solta a sessão");
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            Err(error) => return error,
            Ok(value) => panic!("a troca não devia passar: {value}"),
        }
    }
}

fn untouched(fx:&Fixture,registry:&RuntimeRegistry,before:&Value,app:&mut Child,tui:&mut Child) {
    assert!(registry.owns_codex_terminal("cx-proof"),"a sessão segue adotada");
    assert!(std::fs::read_to_string(&fx.panes).unwrap().starts_with("cx-proof\t"),"nenhum kill-session");
    assert!(app.try_wait().unwrap().is_none() && tui.try_wait().unwrap().is_none(),"nada morreu");
    assert_eq!(&fx.sidecar("cx-proof").unwrap(),before,"sidecar intacto: nem app_pid nulo nem modo gravado");
}

#[tokio::test]
async fn to_headless_refuses_an_unread_permission_mode_and_kills_nothing() {
    let fx = fixture();
    let server = fake_app_server(true).await;
    let (mut app,mut tui) = (app_server_process(&server.endpoint),tui());
    fx.put_sidecar("cx-proof",relaunch_meta(&fx,&server.endpoint,&app,&tui));
    fx.panes(&["cx-proof"]);
    let registry = relaunch_registry(&fx).await;
    let watcher = fx.watcher();
    registry.bind_watcher(watcher.clone());
    watcher.round(&registry).await;
    let before = fx.sidecar("cx-proof").unwrap();
    // O tmux falso não tem `capture-pane`: o seletor não lê modo nenhum.
    let error = switch_until_settled(&watcher,&registry,||PermissionRead::Pane(None)).await;
    assert_eq!(error.code,"erro_troca_modo");
    assert!(error.message.contains("não é suportada sem terminal"),"{}",error.message);
    untouched(&fx,&registry,&before,&mut app,&mut tui);
    assert!(registry.ingress().enter("cx-proof",Duration::ZERO).await.is_ok(),"a porta reabriu");
    // Lido, mas fora dos três modos do sem terminal: a mesma recusa, nunca Full Access.
    let error = switch_until_settled(&watcher,&registry,||PermissionRead::Known("Custom (config.toml)".into())).await;
    assert!(error.message.contains("não é suportada sem terminal"),"{}",error.message);
    untouched(&fx,&registry,&before,&mut app,&mut tui);
    finish(&mut [&mut app,&mut tui]);
}

#[tokio::test]
async fn refused_preconditions_leave_the_terminal_owned_and_untouched() {
    let fx = fixture();
    let server = fake_app_server(true).await;
    let (mut app,mut tui) = (app_server_process(&server.endpoint),tui());
    let mut meta = relaunch_meta(&fx,&server.endpoint,&app,&tui);
    meta["rollout_path"] = json!(fx.root.join("sem-rollout.jsonl"));
    fx.put_sidecar("cx-proof",meta);
    fx.panes(&["cx-proof"]);
    let registry = relaunch_registry(&fx).await;
    let watcher = fx.watcher();
    registry.bind_watcher(watcher.clone());
    watcher.round(&registry).await;
    let known = ||PermissionRead::Known("Full Access".into());

    let before = fx.sidecar("cx-proof").unwrap();
    let error = switch_until_settled(&watcher,&registry,known).await;
    assert!(error.message.contains("Envie a primeira mensagem"),"{}",error.message);
    untouched(&fx,&registry,&before,&mut app,&mut tui);

    // Conta do sidecar diferente da que o catálogo resolve.
    let mut moved = before.clone();
    moved["rollout_path"] = json!(fx.root.join("rollout.jsonl"));
    moved["codex_home"] = json!(fx.root.join("outra-conta"));
    fx.put_sidecar("cx-proof",moved.clone());
    let error = switch_until_settled(&watcher,&registry,known).await;
    assert!(error.message.contains("A conta Codex mudou"),"{}",error.message);
    untouched(&fx,&registry,&moved,&mut app,&mut tui);

    // Transferência de conversa em curso para o nome.
    let mut ready = moved.clone();
    ready["codex_home"] = json!(fx.home.join(".codex"));
    let transfer = "0000000a-0000-0000-0000-000000000001";
    ready["transfer_id"] = json!(transfer);
    fx.put_sidecar("cx-proof",ready.clone());
    let records = fx.home.join(".hangar").join("conversation-transfers");
    std::fs::create_dir_all(&records).unwrap();
    std::fs::write(records.join(format!("{transfer}.json")),json!({"name":"cx-proof","phase":"publishing"}).to_string()).unwrap();
    let error = watcher.switch_mode(&registry,"cx-proof",false,known()).await.expect("Codex do Rust").unwrap_err();
    assert_eq!(error.code,"session_transfer_busy");
    untouched(&fx,&registry,&ready,&mut app,&mut tui);
    finish(&mut [&mut app,&mut tui]);
}

/// Colhe os filhos mortos pelo `kill-session` falso: zumbi segue com `/proc` e pareceria vivo.
fn reap(children:Vec<Child>) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        let mut children = children;
        let deadline = Instant::now() + Duration::from_secs(60);
        while !children.is_empty() && Instant::now() < deadline {
            children.retain_mut(|child|child.try_wait().ok().flatten().is_none());
            std::thread::sleep(Duration::from_millis(20));
        }
        for mut child in children { let _ = child.kill(); let _ = child.wait(); }
    })
}

#[tokio::test]
async fn a_failure_after_the_kill_puts_the_terminal_mode_back_and_leaves_no_headless_entry() {
    let fx = fixture();
    let server = fake_app_server(true).await;
    let (app,tui) = (app_server_process(&server.endpoint),tui());
    let (app_pid,tui_pid) = (app.id(),tui.id());
    // Sidecar atrasado: a TUI já está em "Ask for approval" (o seletor lê isso), o arquivo ainda diz Full Access.
    let mut stale = relaunch_meta(&fx,&server.endpoint,&app,&tui);
    stale["permission_mode"] = json!("Full Access");
    fx.put_sidecar("cx-proof",stale);
    // O pid do pane é o da TUI: nenhum pid alheio entra na espera de saída.
    std::fs::write(&fx.panes,format!("cx-proof\t1\t{tui_pid}\t/w\t%7\t\tcodex\t1700000000\t0\t0\n")).unwrap();
    std::fs::write(fx.panes.with_extension("pids"),format!("{app_pid} {tui_pid}")).unwrap();
    let reaper = reap(vec![app,tui]);
    let registry = relaunch_registry(&fx).await;
    let bin = fx.root.join("bin");
    // Lançador presente (a volta existe antes do kill) e um `codex` que não sobe: o sem terminal falha.
    crate::write_executable(&bin.join("hangar-codex-tui"),"#!/bin/sh\nexit 0\n");
    crate::write_executable(&bin.join("codex"),"#!/bin/sh\nexit 1\n");
    // tmux falso que derruba os processos do pane no kill-session (o SIGHUP de verdade) e não cria sessão.
    let tmux = fx.root.join("tmux-relaunch");
    let p = fx.panes.display();
    crate::write_executable(&tmux,format!("#!/bin/sh\nP='{p}'\ncase \"$1\" in\n  list-panes) cat \"$P\";;\n  \
        has-session) n=\"${{3#=}}\"; grep -q \"^$n\t\" \"$P\";;\n  \
        kill-session) n=\"${{3#=}}\"; for p in $(cat \"$P.pids\"); do pkill -P $p; kill $p; done 2>/dev/null; grep -v \"^$n\t\" \"$P\" > \"$P.new\"; mv \"$P.new\" \"$P\";;\n  \
        display-message) printf 'cx-proof\t%%7\t1700000000\\n';;\n  *) exit 1;;\nesac\n"));
    let watcher = Arc::new(Watcher::new(WatchConfig { home:fx.home.clone(),queue_dir:fx.queue.clone(),
        mux:Mux::with_program(&tmux,Duration::from_secs(5)),mux_program:tmux.clone().into_os_string() }));
    registry.bind_watcher(watcher.clone());
    watcher.round(&registry).await;
    assert!(registry.owns_codex_terminal("cx-proof"));

    let error = switch_until_settled(&watcher,&registry,||PermissionRead::Known("Ask for approval".into())).await;
    assert_eq!(error.code,"erro_troca_modo");
    // O pane novo não nasce com este tmux: a volta é tentada e a falha aparece inteira, nunca calada.
    assert!(error.message.contains("e o terminal não voltou"),"{}",error.message);
    let meta = fx.sidecar("cx-proof").expect("o sidecar volta mesmo que o lançador o tenha apagado");
    assert_eq!(meta["headless"],false,"o modo anterior (terminal) volta ao sidecar");
    assert_eq!(meta["permission_mode"],"Ask for approval","a volta relança com o modo lido, nunca com o Full Access velho do sidecar");
    assert!(meta["app_pid"].is_null() && meta["cano"].is_null(),"sem processo de nenhuma das tentativas");
    assert!(registry.writable("cx-proof").await.is_none(),"nenhum sem terminal órfão ficou aberto");
    assert!(registry.ingress().enter("cx-proof",Duration::ZERO).await.is_ok(),"a porta reabriu");
    reaper.join().unwrap();
}

/// tmux falso da troca: `kill-session` tira o pane e manda SIGTERM nos pids de `<panes>.pids` e nos filhos
/// deles (o SIGHUP do grupo do pane de verdade); não cria sessão. Filho que sobra seguraria a troca (N1).
fn relaunch_tmux(fx:&Fixture) -> PathBuf {
    let tmux = fx.root.join("tmux-relaunch");
    let p = fx.panes.display();
    crate::write_executable(&tmux,format!("#!/bin/sh\nP='{p}'\ncase \"$1\" in\n  list-panes) cat \"$P\";;\n  \
        has-session) n=\"${{3#=}}\"; grep -q \"^$n\t\" \"$P\";;\n  \
        kill-session) n=\"${{3#=}}\"; for p in $(cat \"$P.pids\"); do pkill -P $p; kill $p; done 2>/dev/null; grep -v \"^$n\t\" \"$P\" > \"$P.new\"; mv \"$P.new\" \"$P\";;\n  \
        display-message) printf 'cx-proof\t%%7\t1700000000\\n';;\n  *) exit 1;;\nesac\n"));
    tmux
}

fn relaunch_watcher(fx:&Fixture,tmux:&std::path::Path) -> Arc<Watcher> {
    Arc::new(Watcher::new(WatchConfig { home:fx.home.clone(),queue_dir:fx.queue.clone(),
        mux:Mux::with_program(tmux,Duration::from_secs(5)),mux_program:tmux.to_owned().into_os_string() }).with_death_after(DEATH_AFTER))
}

/// App-server falso que ignora o SIGTERM (o `sleep` filho morre, o laço segue).
fn stubborn_app_server(endpoint:&str) -> Child {
    std::process::Command::new("sh").args(["-c","trap '' TERM; while :; do sleep 1; done","app-server",endpoint]).spawn().unwrap()
}

#[tokio::test]
async fn an_app_server_that_outlives_the_kill_leaves_the_session_parked_not_buried() {
    let fx = fixture();
    let server = fake_app_server(true).await;
    let (mut app,tui) = (stubborn_app_server(&server.endpoint),tui());
    let tui_pid = tui.id();
    fx.put_sidecar("cx-proof",relaunch_meta(&fx,&server.endpoint,&app,&tui));
    std::fs::write(&fx.panes,format!("cx-proof\t1\t{tui_pid}\t/w\t%7\t\tcodex\t1700000000\t0\t0\n")).unwrap();
    // O kill-session derruba só a TUI: o app-server sobrevive ao kill e ao SIGTERM da troca.
    std::fs::write(fx.panes.with_extension("pids"),tui_pid.to_string()).unwrap();
    let reaper = reap(vec![tui]);
    let registry = relaunch_registry(&fx).await;
    let bin = fx.root.join("bin");
    crate::write_executable(&bin.join("hangar-codex-tui"),"#!/bin/sh\nexit 0\n");
    crate::write_executable(&bin.join("codex"),"#!/bin/sh\nexit 1\n");
    let watcher = relaunch_watcher(&fx,&relaunch_tmux(&fx));
    registry.bind_watcher(watcher.clone());
    watcher.round(&registry).await;
    let key = key_of(&fx.sidecar("cx-proof").unwrap());

    let error = switch_until_settled(&watcher,&registry,||PermissionRead::Known("Ask for approval".into())).await;
    assert_eq!(error.code,"relaunch_process_alive","processo antigo vivo: 500, e nada novo sobe ao lado");
    assert!(error.message.contains(&app.id().to_string()),"a resposta nomeia o pid vivo: {}",error.message);
    assert!(error.message.contains("feche-a e abra a conversa de novo"),"a resposta diz o que fazer: {}",error.message);
    let parked = fx.sidecar("cx-proof").expect("sidecar no disco");
    assert_eq!(parked["headless"],false);
    assert!(parked["app_pid"].is_null(),"sem `unpark`: a vigia não enterra uma sessão sem pane");
    assert!(registry.writable("cx-proof").await.is_none(),"nenhum sem terminal subiu");
    // Rodadas depois do prazo de morte: nada é apagado.
    watcher.round(&registry).await;
    tokio::time::sleep(DEATH_AFTER + Duration::from_millis(50)).await;
    watcher.round(&registry).await;
    assert!(fx.sidecar("cx-proof").is_some(),"sidecar segue no disco");
    assert!(fx.queue_state(&key).exists(),"fila segue no disco");
    assert!(app.try_wait().unwrap().is_none(),"o app-server teimoso segue vivo (e a resposta disse isso)");
    assert!(registry.ingress().enter("cx-proof",Duration::ZERO).await.is_ok(),"a porta reabriu");
    finish(&mut [&mut app]);
    reaper.join().unwrap();
}

/// `codex app-server --stdio` falso para o sem terminal: retoma a conversa pedida e anota cada método em `log`.
fn fake_headless_codex(bin:&std::path::Path,log:&std::path::Path) {
    let python = std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()).map(|p|p.join("python3")).find(|p|p.is_file()).expect("python3 no PATH");
    if let Err(error) = std::os::unix::fs::symlink(python,bin.join("python3")) { assert_eq!(error.kind(),std::io::ErrorKind::AlreadyExists); }
    crate::write_executable(&bin.join("codex"),format!(r#"#!/usr/bin/env python3
import json, sys
log = open({log:?}, "a")
thread = "thread-1"
for line in sys.stdin:
    msg = json.loads(line)
    if "id" not in msg or "method" not in msg:
        continue
    method, params = msg["method"], msg.get("params") or {{}}
    log.write(json.dumps({{"method": method, "params": params}}) + "\n"); log.flush()
    if method == "initialize":
        result = {{"userAgent": "hangar/{} (x)"}}
    elif method in ("thread/start", "thread/resume"):
        thread = params.get("threadId") or thread
        result = {{"thread": {{"id": thread, "path": "/tmp/rollout.jsonl"}}, "model": "gpt-test"}}
    elif method == "thread/read":
        result = {{"thread": {{"id": thread, "status": {{"type": "idle"}}, "turns": []}}}}
    else:
        result = {{}}
    print(json.dumps({{"id": msg["id"], "result": result}}), flush=True)
"#,hangar_codex::version::CHECKED,log=log.display().to_string()));
}

#[tokio::test]
async fn to_headless_brings_up_the_headless_with_the_read_mode_restores_plan_and_restarts() {
    crate::use_cano_bin();
    let fx = fixture();
    let server = fake_app_server(true).await;
    let (app,tui) = (app_server_process(&server.endpoint),tui());
    let (app_pid,tui_pid) = (app.id(),tui.id());
    let mut meta = relaunch_meta(&fx,&server.endpoint,&app,&tui);
    // Sidecar velho em Full Access; o seletor leu "Approve for me". O modo plan volta depois da troca.
    meta["permission_mode"] = json!("Full Access");
    meta["mode"] = json!("plan");
    meta["model"] = json!("gpt-test");
    fx.put_sidecar("cx-proof",meta);
    std::fs::write(&fx.panes,format!("cx-proof\t1\t{tui_pid}\t/w\t%7\t\tcodex\t1700000000\t0\t0\n")).unwrap();
    std::fs::write(fx.panes.with_extension("pids"),format!("{app_pid} {tui_pid}")).unwrap();
    let reaper = reap(vec![app,tui]);
    let registry = relaunch_registry(&fx).await;
    let bin = fx.root.join("bin");
    crate::write_executable(&bin.join("hangar-codex-tui"),"#!/bin/sh\nexit 0\n");
    let log = fx.root.join("codex-methods.jsonl");
    fake_headless_codex(&bin,&log);
    let watcher = relaunch_watcher(&fx,&relaunch_tmux(&fx));
    registry.bind_watcher(watcher.clone());
    watcher.round(&registry).await;
    let key = key_of(&fx.sidecar("cx-proof").unwrap());
    let generation = fx.queue_json(&key)["generation"].as_u64().unwrap();

    // Com terminal, reiniciar é a recusa do Python.
    let refused = registry.restart_codex("cx-proof").await.expect("Codex do Rust").unwrap_err();
    assert_eq!(refused.code,"erro_recarregar_so_sem_terminal");

    let deadline = Instant::now() + Duration::from_secs(20);
    let switched = loop {
        match watcher.switch_mode(&registry,"cx-proof",false,PermissionRead::Known("Approve for me".into())).await.expect("Codex do Rust") {
            Err(error) if error.message.contains("ociosa") && Instant::now() < deadline => tokio::time::sleep(Duration::from_millis(50)).await,
            other => break other,
        }
    };
    assert_eq!(switched.unwrap(),json!({"ok":true,"terminal":false}));
    let sidecar = fx.sidecar("cx-proof").unwrap();
    assert_eq!(sidecar["headless"],true);
    assert_eq!(sidecar["permission_mode"],"Approve for me","o modo lido, não o do sidecar velho");
    assert_eq!(sidecar["key"],json!(key),"a mesma chave: a vida segue a fila");
    assert!(sidecar["cano"]["pid"].as_u64().is_some(),"o cano novo foi gravado");
    assert!(sidecar["endpoint"].is_null() && sidecar["app_pid"].is_null(),"nada do terminal antigo");
    assert_eq!(fx.queue_json(&key)["generation"].as_u64(),Some(generation + 1),"vida nova na mesma fila, que não foi apagada");
    assert!(registry.owns_codex_headless("cx-proof").await);
    assert!(!registry.owns_codex_terminal("cx-proof"));
    let methods:Vec<Value> = std::fs::read_to_string(&log).unwrap().lines().map(|l|serde_json::from_str(l).unwrap()).collect();
    let resume = methods.iter().find(|m|m["method"] == "thread/resume").expect("retomou a conversa");
    assert_eq!(resume["params"]["threadId"],"thread-1");
    assert!(methods.iter().any(|m|m["method"] == "thread/settings/update" && m["params"]["collaborationMode"]["mode"] == "plan"),"SetMode depois do assentamento");
    let generation_now = generation + 1;
    let handle = registry.handle(&key,generation_now).await.unwrap();
    assert_eq!(handle.view().await.unwrap()["mode"],"plan","a vista confirma o modo restaurado");
    assert!(registry.ingress().enter("cx-proof",Duration::ZERO).await.is_ok(),"a porta reabriu");

    // Sem terminal do Rust: reiniciar é aceito aqui, sem ir ao Python.
    assert_eq!(registry.restart_codex("cx-proof").await.expect("Codex do Rust").unwrap(),json!({"ok":true}));
    registry.close_with_kill(&key,generation_now).await.unwrap();
    reaper.join().unwrap();
}

#[tokio::test]
async fn relaunch_routes_go_to_python_when_the_session_is_not_a_codex_of_the_rust() {
    let (python, server) = serve_owner(registry().await).await;
    for (route, body) in [("modo-execucao", json!({"terminal": true})), ("recarregar", json!({}))] {
        crate::fake::client().post(format!("http://{server}/api/sessions/claude-x/{route}"))
            .header("authorization", format!("Bearer {}", crate::fake::OWNER)).header("content-type", "application/json")
            .body(body.to_string()).send().await.unwrap();
        assert_eq!(python.hits_to(&format!("/api/sessions/claude-x/{route}")), 1, "{route} sem vigia vai ao Python");
    }
    // Com a vigia ligada: sem sidecar Codex, ou sem terminal que o Rust não abriu, a vez é do Python.
    let fx = fixture();
    let registry = registry().await;
    registry.bind_watcher(fx.watcher());
    assert!(registry.relaunch_codex("claude-x", true, None).await.is_none());
    assert!(registry.restart_codex("claude-x").await.is_none());
    fx.put_sidecar("cx-h", json!({"name": "cx-h", "provider": "codex", "headless": true, "key": "k-h", "thread_id": "t"}));
    assert!(registry.relaunch_codex("cx-h", true, None).await.is_none(), "sem terminal aberto pelo Python");
    assert!(registry.restart_codex("cx-h").await.is_none());
}

#[tokio::test]
async fn the_hand_over_route_is_gone() {
    let fx = fixture();
    let server_app = fake_app_server(true).await;
    let (mut app,mut tui) = (app_server_process(&server_app.endpoint),tui());
    fx.put_sidecar("cx-proof",fx.meta("cx-proof",&server_app.endpoint,Some(app.id()),&tui));
    fx.panes(&["cx-proof"]);
    let registry = registry().await;
    let watcher = fx.watcher();
    registry.bind_watcher(watcher.clone());
    watcher.round(&registry).await;
    let (python, upstream) = crate::fake::spawn_fake().await;
    let state = hangar_server::routes::AppState::new(crate::fake::config(upstream, "127.0.0.1"));
    assert!(state.state.runtime.set(registry.clone()).is_ok());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let private = listener.local_addr().unwrap();
    let app_router = hangar_server::routes::terminal_router(Arc::new(state));
    tokio::spawn(async move { axum::serve(listener, app_router.into_make_service_with_connect_info::<std::net::SocketAddr>()).await.unwrap() });
    let response = crate::fake::client().post(format!("http://{private}/__hangar_server/codex/cx-proof/hand-over"))
        .header("x-hangar-internal", crate::fake::SECRET).send().await.unwrap();
    assert_eq!(response.status().as_u16(), 421, "o Rust não solta a sessão para o Python relançar");
    assert!(registry.owns_codex_terminal("cx-proof"), "nada foi solto");
    assert_eq!(python.hits_to("/api/sessions/cx-proof/hand-over"), 0);
    finish(&mut [&mut app,&mut tui]);
}

#[tokio::test]
async fn kill_by_name_closes_a_life_the_rust_has_not_adopted_yet() {
    let fx = fixture();
    let server = fake_app_server(true).await;
    let (mut app,mut tui) = (app_server_process(&server.endpoint),tui());
    let mut meta = fx.meta("cx-proof",&server.endpoint,Some(app.id()),&tui);
    meta["key"] = json!("k-unadopted");
    fx.put_sidecar("cx-proof",meta);
    fx.panes(&["cx-proof"]);
    let registry = registry().await;
    registry.bind_watcher(fx.watcher());
    assert!(registry.kill_codex_terminal("other").await.is_none(),"sem sidecar Codex: o Python encerra como hoje");
    let killed = registry.kill_codex_terminal("cx-proof").await.unwrap().unwrap();
    assert_eq!(killed,json!({"closed":true,"killed":true}));
    assert!(std::fs::read_to_string(&fx.panes).unwrap().is_empty());
    assert!(exited(&mut app));
    assert!(fx.sidecar("cx-proof").is_none());
    assert_eq!(server.connections.load(std::sync::atomic::Ordering::SeqCst),0,"nada foi adotado só para encerrar");
    finish(&mut [&mut app,&mut tui]);
}

/// Servidor com o registro (e a vigia ligada nele), diante de um Python falso.
pub(crate) async fn serve_owner(registry: Arc<hangar_server::runtime::gateway::RuntimeRegistry>) -> (Arc<crate::fake::Fake>, std::net::SocketAddr) {
    let (python, upstream) = crate::fake::spawn_fake().await;
    let state = hangar_server::routes::AppState::new(crate::fake::config(upstream, "127.0.0.1"));
    assert!(state.state.runtime.set(registry).is_ok());
    (python, crate::fake::spawn_state(state).await)
}

async fn delete_session(server: std::net::SocketAddr, name: &str) -> (u16, Value) {
    let response = crate::fake::client().delete(format!("http://{server}/api/sessions/{name}"))
        .header("authorization", format!("Bearer {}", crate::fake::OWNER)).header("x-hangar-rust-closed", "forjado").send().await.unwrap();
    let status = response.status().as_u16();
    (status, serde_json::from_str(&response.text().await.unwrap()).unwrap_or(Value::Null))
}

#[tokio::test]
async fn owner_delete_kills_in_rust_then_forwards_marked_to_python() {
    let fx = fixture();
    let server_app = fake_app_server(true).await;
    let (mut app,mut tui) = (app_server_process(&server_app.endpoint),tui());
    fx.put_sidecar("cx-proof",fx.meta("cx-proof",&server_app.endpoint,Some(app.id()),&tui));
    fx.panes(&["cx-proof"]);
    let registry = registry().await;
    let watcher = fx.watcher();
    registry.bind_watcher(watcher.clone());
    watcher.round(&registry).await;
    assert!(registry.owns_codex_terminal("cx-proof"));
    let (python, server) = serve_owner(registry.clone()).await;
    let (status, _) = delete_session(server, "cx-proof").await;
    assert_eq!(status, 200, "a resposta é a do Python, depois do encerramento");
    assert!(!registry.owns_codex_terminal("cx-proof"));
    assert!(std::fs::read_to_string(&fx.panes).unwrap().is_empty(),"pane encerrado pelo Rust");
    assert!(exited(&mut app));
    assert!(fx.sidecar("cx-proof").is_none());
    assert_eq!(python.hits_to("/api/sessions/cx-proof"), 1, "o mesmo pedido segue ao Python, uma vez");
    let (_, headers) = python.last_hit();
    assert_eq!(headers.get("x-hangar-rust-closed").and_then(|v| v.to_str().ok()), Some(crate::fake::SECRET),
        "a marca é a do Rust, nunca a que veio de fora");
    // Outra sessão (sem sidecar Codex) vai ao Python como chegou, sem marca.
    let _ = delete_session(server, "claude-x").await;
    let (_, headers) = python.last_hit();
    assert!(headers.get("x-hangar-rust-closed").is_none());
    finish(&mut [&mut app,&mut tui]);
}

#[tokio::test]
async fn owner_delete_that_fails_in_rust_answers_its_code_and_never_reaches_python() {
    let fx = fixture();
    let server_app = fake_app_server(true).await;
    let (mut app,mut tui) = (app_server_process(&server_app.endpoint),tui());
    fx.put_sidecar("cx-proof",fx.meta("cx-proof",&server_app.endpoint,Some(app.id()),&tui));
    fx.panes(&["cx-proof"]);
    // O multiplexador aceita o kill-session e a sessão segue de pé (o psmux às vezes faz isso).
    let survivor = fx.root.join("tmux-survivor");
    crate::write_executable(&survivor, format!("#!/bin/sh\nP='{}'\ncase \"$1\" in\n  list-panes) cat \"$P\";;\n  has-session) exit 0;;\n  *) exit 0;;\nesac\n",
        fx.panes.display()));
    let watcher = Arc::new(Watcher::new(WatchConfig { home:fx.home.clone(),queue_dir:fx.queue.clone(),
        mux:Mux::with_program(&survivor,Duration::from_secs(5)),mux_program:survivor.clone().into_os_string() }));
    let registry = registry().await;
    registry.bind_watcher(watcher.clone());
    watcher.round(&registry).await;
    let (python, server) = serve_owner(registry.clone()).await;
    let (status, body) = delete_session(server, "cx-proof").await;
    assert_eq!((status, body["detail"]["code"].as_str()), (500, Some("close_kill_survived")));
    assert_eq!(python.hits_to("/api/sessions/cx-proof"), 0, "encerramento falho não repassa");
    assert!(registry.owns_codex_terminal("cx-proof"),"nada foi encerrado");
    assert!(fx.sidecar("cx-proof").is_some());
    assert!(app.try_wait().unwrap().is_none());
    finish(&mut [&mut app,&mut tui]);
}

#[tokio::test]
async fn pane_only_routes_drive_the_codex_pane_with_the_terminal_writer() {
    let fx = fixture();
    fx.panes(&["cx-proof"]);
    let binding = hangar_server::terminal_input::TerminalBinding { name:"cx-proof".into(),pane:"%7".into(),conversation:"thread-1".into(),
        generation:1,created:1_700_000_000,mux_argv:vec![fx.tmux.to_string_lossy().into_owned()],windows:false,clipboard_lock_path:None };
    let driver = hangar_server::runtime::codex_terminal::pane_driver(&binding,Default::default(),None);
    let sent = driver.key("Up",false).await;
    assert_eq!(hangar_server::session_write::control::pane_step_answer(&sent).map_err(|(status,_)|status),Ok(()));
    let refused = driver.key("C-c",false).await;
    assert_eq!(hangar_server::session_write::control::pane_step_answer(&refused).map_err(|(status,_)|status.as_u16()),Err(400),"fora das teclas permitidas");
    assert_eq!(hangar_server::session_write::control::pane_step_answer(&driver.text("ls").await).map_err(|(status,_)|status),Ok(()));
    let keys = std::fs::read_to_string(fx.panes.with_extension("keys")).unwrap();
    assert!(keys.contains("send-keys -t %7 Up") && keys.contains("-l -- ls"),"{keys}");
    // Outro nascimento do pane (sessão recriada com o mesmo nome): nada é escrito.
    let stale = hangar_server::terminal_input::TerminalBinding { created:1,..binding };
    let before = keys.lines().count();
    assert!(hangar_server::session_write::control::pane_step_answer(&hangar_server::runtime::codex_terminal::pane_driver(&stale,Default::default(),None).key("Up",false).await).is_err());
    assert_eq!(std::fs::read_to_string(fx.panes.with_extension("keys")).unwrap().lines().count(),before);
}

#[tokio::test]
async fn a_tui_pid_missing_on_one_side_never_rotates_the_key_nor_wipes_the_queue() {
    let fx = fixture();
    let server = fake_app_server(true).await;
    let (mut app,mut tui) = (app_server_process(&server.endpoint),tui());
    // O lançador grava o `tui_pid` antes de o sidecar existir: a adoção nasce sem ele.
    let mut meta = fx.meta("cx-proof",&server.endpoint,Some(app.id()),&tui);
    meta["tui_pid"] = Value::Null;
    fx.put_sidecar("cx-proof",meta);
    fx.panes(&["cx-proof"]);
    let first = registry().await;
    fx.watcher().round(&first).await;
    let key = key_of(&fx.sidecar("cx-proof").unwrap());
    assert!(fx.queue_json(&key)["runtime_state"]["codex_life"]["tui_pid"].is_null());
    first.close(&key,1).await.unwrap();

    // O pid aparece depois; o Rust reinicia e readota: mesma chave, mesma geração, a vida aprende o pid.
    let mut later = fx.sidecar("cx-proof").unwrap();
    later["tui_pid"] = json!(tui.id());
    fx.put_sidecar("cx-proof",later);
    let second = registry().await;
    fx.watcher().round(&second).await;
    assert_eq!(key_of(&fx.sidecar("cx-proof").unwrap()),key,"a chave não gira");
    assert_eq!(fx.queue_json(&key)["generation"],1);
    assert_eq!(fx.queue_json(&key)["runtime_state"]["codex_life"]["tui_pid"],tui.id());
    assert!(second.handle(&key,1).await.is_ok());
    second.close(&key,1).await.unwrap();

    // O `sessions.save` regrava o sidecar sem o pid: a vida gravada o conserva.
    let mut saved = fx.sidecar("cx-proof").unwrap();
    saved["tui_pid"] = Value::Null;
    fx.put_sidecar("cx-proof",saved);
    let third = registry().await;
    fx.watcher().round(&third).await;
    assert_eq!(key_of(&fx.sidecar("cx-proof").unwrap()),key);
    assert_eq!(fx.queue_json(&key)["runtime_state"]["codex_life"]["tui_pid"],tui.id());
    assert!(third.handle(&key,1).await.is_ok());
    finish(&mut [&mut app,&mut tui]);
}

#[tokio::test]
async fn a_new_pane_life_without_tui_pid_on_either_side_gets_a_fresh_queue() {
    let fx = fixture();
    let server = fake_app_server(true).await;
    let (mut app,mut tui) = (app_server_process(&server.endpoint),tui());
    // Vida anterior de mesmo nome e chave, sem pid da TUI (o `null == null` que no Windows herdava a fila).
    {
        let path = fx.queue_state("old-key");
        let lease = hangar_server::runtime::queue::acquire_lease(&path.with_extension("lock")).unwrap();
        let mut store = hangar_server::runtime::queue::Store::open(&path,&fx.queue,
            hangar_server::runtime::queue::State::new("old-key",2,"cx-proof",Vec::new())).unwrap();
        store.exec(2,"life",CLOCK,Action::AdvanceLifecycle { generation:2,
            state:json!({"codex_life":{"created":1_700_000_000u64,"pane":"%7","tui_pid":null,"endpoint":server.endpoint,"app_pid":app.id()},"name":"cx-proof"}) }).unwrap();
        drop(lease);
    }
    let mut meta = fx.meta("cx-proof",&server.endpoint,Some(app.id()),&tui);
    meta["key"] = json!("old-key");
    meta["tui_pid"] = Value::Null;
    fx.put_sidecar("cx-proof",meta);
    fx.panes_born(&[("cx-proof","%8",1_700_000_999)]);
    let registry = registry().await;
    fx.watcher().round(&registry).await;
    let key = key_of(&fx.sidecar("cx-proof").unwrap());
    assert_ne!(key,"old-key","outro nascimento do terminal gira a chave");
    assert!(!fx.queue_state("old-key").exists());
    assert!(registry.handle(&key,1).await.is_ok());
    finish(&mut [&mut app,&mut tui]);
}

#[tokio::test]
async fn closing_by_a_name_that_is_no_longer_this_life_kills_nothing() {
    let fx = fixture();
    let server = fake_app_server(true).await;
    let (mut app,mut tui) = (app_server_process(&server.endpoint),tui());
    fx.put_sidecar("cx-proof",fx.meta("cx-proof",&server.endpoint,Some(app.id()),&tui));
    fx.panes(&["cx-proof"]);
    let registry = registry().await;
    let watcher = fx.watcher();
    registry.bind_watcher(watcher.clone());
    watcher.round(&registry).await;
    let key = key_of(&fx.sidecar("cx-proof").unwrap());
    let original = fx.sidecar("cx-proof").unwrap();

    // Renomeada pelo Python e a rodada ainda não viu: o DELETE com o nome antigo não derruba a sessão viva.
    let mut renamed = original.clone();
    renamed["name"] = json!("cx-renamed");
    fx.put_sidecar("cx-renamed",renamed);
    std::fs::remove_file(fx.sidecar_path("cx-proof")).unwrap();
    fx.panes(&["cx-renamed"]);
    let refused = registry.kill_codex_terminal("cx-proof").await.expect("vida aberta aqui").unwrap_err();
    assert_eq!(refused.code,"close_kill_stale");
    assert!(app.try_wait().unwrap().is_none(),"o app-server da sessão renomeada segue vivo");
    assert!(fx.queue_state(&key).exists(),"a fila dela segue");
    assert!(std::fs::read_to_string(&fx.panes).unwrap().starts_with("cx-renamed\t"));

    // Sidecar desta vida, mas o pane do nome é de outro nascimento (outra sessão com o mesmo nome).
    std::fs::remove_file(fx.sidecar_path("cx-renamed")).unwrap();
    fx.put_sidecar("cx-proof",original);
    fx.panes_born(&[("cx-proof","%9",1_700_000_999)]);
    let refused = registry.kill_codex_terminal("cx-proof").await.expect("vida aberta aqui").unwrap_err();
    assert_eq!(refused.code,"close_kill_stale");
    assert!(app.try_wait().unwrap().is_none());
    assert!(fx.sidecar("cx-proof").is_some() && fx.queue_state(&key).exists());
    finish(&mut [&mut app,&mut tui]);
}

#[tokio::test]
async fn owner_broadcast_answers_the_rust_code_for_a_codex_terminal_it_cannot_adopt() {
    let fx = fixture();
    let server_app = fake_app_server(true).await;
    let (mut app,mut tui) = (app_server_process(&server_app.endpoint),tui());
    // Sidecar pronto e nenhum pane: a adoção na hora falha com o código do Rust.
    fx.put_sidecar("cx-proof",fx.meta("cx-proof",&server_app.endpoint,Some(app.id()),&tui));
    let registry = registry().await;
    registry.bind_watcher(fx.watcher());
    let (python, server) = serve_owner(registry.clone()).await;
    let response = crate::fake::client().post(format!("http://{server}/api/broadcast"))
        .header("authorization", format!("Bearer {}", crate::fake::OWNER)).header("content-type","application/json")
        .body(json!({"names":["cx-proof","claude-x"],"text":"oi"}).to_string()).send().await.unwrap();
    assert_eq!(response.status().as_u16(),200);
    let body:Value = serde_json::from_str(&response.text().await.unwrap()).unwrap();
    assert_eq!(body["results"]["cx-proof"]["error"]["code"],"codex_terminal_absent");
    assert_eq!(body["results"]["cx-proof"]["delivered"],false);
    assert_eq!(python.hits_to("/api/broadcast"),1,"só os outros nomes vão ao Python");
    let sent:Value = serde_json::from_slice(&python.last_body()).unwrap();
    assert_eq!(sent["names"],json!(["claude-x"]),"o Codex com terminal do Rust nunca é repassado");
    assert_eq!(python.hits_to("/api/sessions/cx-proof/input"),0);
    finish(&mut [&mut app,&mut tui]);
}

#[tokio::test]
async fn clear_of_a_codex_terminal_of_the_rust_stays_in_the_rust() {
    let fx = fixture();
    let server = fake_app_server(true).await;
    let (mut app,mut tui) = (app_server_process(&server.endpoint),tui());
    fx.put_sidecar("cx-proof",fx.meta("cx-proof",&server.endpoint,Some(app.id()),&tui));
    fx.panes(&["cx-proof"]);
    let registry = registry().await;
    fx.watcher().round(&registry).await;
    assert!(registry.is_terminal("cx-proof").await);
    let (python, owner) = serve_owner(registry.clone()).await;
    let response = crate::fake::client().post(format!("http://{owner}/api/sessions/cx-proof/input"))
        .header("authorization", format!("Bearer {}", crate::fake::OWNER)).header("content-type","application/json")
        .body(r#"{"text":"/clear"}"#).send().await.unwrap();
    assert_ne!(response.text().await.unwrap(), "from-python");
    assert_eq!(python.hits_to("/api/sessions/cx-proof/input"), 0, "a fila do Codex com terminal é do Rust: o /clear nunca vai ao Python");
    finish(&mut [&mut app,&mut tui]);
}
