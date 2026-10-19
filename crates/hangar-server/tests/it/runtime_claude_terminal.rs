//! Claude com terminal adotado pelo Rust (`Watcher::adopt_claude`): um tmux falso (panes num arquivo,
//! ambiente da sessão noutro) e um processo de verdade chamado `claude`. Nenhuma sessão viva.
use hangar_server::accounts::environment::AccountEnvironment;
use hangar_server::list::mux::Mux;
use hangar_server::runtime::codex_terminal::{WatchConfig,Watcher};
use hangar_server::runtime::gateway::RuntimeRegistry;
use serde_json::json;
use std::path::PathBuf;
use std::process::Child;
use std::sync::Arc;
use std::time::Duration;

pub(crate) struct Fixture { _dir:tempfile::TempDir, pub home:PathBuf, pub queue:PathBuf, pub panes:PathBuf, pub tmux:PathBuf, pub root:PathBuf }

/// `list-panes` lê `panes`; `show-environment`/`set-environment` leem e gravam `panes.env`; o
/// `display-message` do executor responde a linha do pane.
pub(crate) fn fixture() -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_owned();
    let (home,panes,tmux) = (root.join("home"),root.join("panes"),root.join("fake-tmux"));
    let queue = home.join(".claude").join(".hangar-queue");
    std::fs::create_dir_all(home.join(".claude/sessions")).unwrap();
    std::fs::write(&panes,"").unwrap();
    let p = panes.display();
    crate::write_executable(&tmux,format!("#!/bin/sh\nP='{p}'\ncase \"$1\" in\n  list-panes) cat \"$P\";;\n  \
        show-environment) grep \"^$4=\" \"$P.env\" || exit 1;;\n  \
        set-environment) echo \"$4=$5\" >> \"$P.env\";;\n  \
        display-message) cat \"$P.display\";;\n  *) exit 1;;\nesac\n"));
    Fixture { _dir:dir,home,queue,panes,tmux,root }
}

impl Fixture {
    pub(crate) fn watcher(&self) -> Arc<Watcher> {
        Arc::new(Watcher::new(WatchConfig { home:self.home.clone(),queue_dir:self.queue.clone(),
            mux:Mux::with_program(&self.tmux,Duration::from_secs(5)),mux_program:self.tmux.clone().into_os_string() }).with_scope_probe(Vec::new))
    }
    pub(crate) async fn registry(&self) -> Arc<RuntimeRegistry> {
        let map = [("HOME",self.home.to_string_lossy().into_owned())].into_iter().map(|(k,v)|(k.to_owned(),v)).collect();
        let registry = crate::runtime_open::registry_with(|registry|registry.with_codex_environment(AccountEnvironment::from_map(map))).await;
        registry.bind_watcher(self.watcher());
        registry
    }
    /// O pane `name` com o processo `pid` como agente, nascido em `created`.
    pub(crate) fn pane(&self,name:&str,pid:u32,created:u64) {
        std::fs::write(&self.panes,format!("{name}\t1\t{pid}\t{}\t%7\t\tclaude\t{created}\t0\t0\n",self.root.display())).unwrap();
        std::fs::write(self.panes.with_extension("display"),format!("{pid}\t{name}\t%7\t{created}\n")).unwrap();
    }
    pub(crate) fn native(&self,pid:u32,sid:&str) {
        std::fs::write(self.home.join(format!(".claude/sessions/{pid}.json")),json!({"pid":pid,"sessionId":sid}).to_string()).unwrap();
    }
    pub(crate) fn env(&self) -> String { std::fs::read_to_string(self.panes.with_extension("env")).unwrap_or_default() }
}

/// Processo cujo argv é `claude 120`: o agente que a lista reconhece. Sem a conta de quem roda os testes.
pub(crate) fn claude() -> Child {
    std::process::Command::new("bash").args(["-c","exec -a claude sleep 120"]).env_remove("CLAUDE_CONFIG_DIR").spawn().unwrap()
}

pub(crate) fn finish(child:&mut Child) { let _ = child.kill(); let _ = child.wait(); }

const SID:&str = "11111111-1111-4111-8111-111111111111";

/// Até o `exec` trocar o nome do processo.
async fn named(child:&Child) {
    for _ in 0..100 {
        if std::fs::read_to_string(format!("/proc/{}/cmdline",child.id())).is_ok_and(|c|c.starts_with("claude\0")) { return; }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("o processo de teste não virou `claude`");
}

#[tokio::test]
async fn a_claude_pane_with_its_spec_key_is_adopted_under_that_key() {
    let fx = fixture();
    let mut agent = claude();
    named(&agent).await;
    fx.pane("s1",agent.id(),1700000000);
    fx.native(agent.id(),SID);
    let key = "ab".repeat(16);
    std::fs::write(fx.panes.with_extension("env"),format!("CP_SESSION_KEY={key}\n")).unwrap();
    let registry = fx.registry().await;
    let adopted = registry.adopt_now("s1").await.map(|r|r.map_err(|e|e.code));
    assert_eq!(adopted,Some(Ok(())));
    let (found,_) = registry.terminal_view("s1").await.expect("ator do terminal aberto");
    assert_eq!(found,key,"a fila é a da chave do spec");
    registry.close(&key,1).await.unwrap();
    finish(&mut agent);
}

#[tokio::test]
async fn a_pane_without_key_gets_one_written_into_the_session() {
    let fx = fixture();
    let mut agent = claude();
    named(&agent).await;
    fx.pane("s1",agent.id(),1700000000);
    fx.native(agent.id(),SID);
    let registry = fx.registry().await;
    assert_eq!(registry.adopt_now("s1").await.map(|r|r.map_err(|e|e.code)),Some(Ok(())));
    let (key,_) = registry.terminal_view("s1").await.unwrap();
    assert_eq!(fx.env(),format!("CP_SESSION_KEY={key}\n"),"a próxima adoção acha a mesma chave");
    registry.close(&key,1).await.unwrap();
    finish(&mut agent);
}

#[tokio::test]
async fn a_shell_pane_is_not_a_claude_session() {
    let fx = fixture();
    let mut shell = std::process::Command::new("sleep").arg("120").spawn().unwrap();
    std::fs::write(&fx.panes,format!("s1\t1\t{}\t{}\t%7\t\t\t1700000000\t0\t0\n",shell.id(),fx.root.display())).unwrap();
    let registry = fx.registry().await;
    assert!(registry.adopt_now("s1").await.is_none(),"o shell segue o caminho de sempre");
    finish(&mut shell);
}

#[tokio::test]
async fn a_claude_without_proof_of_its_conversation_is_refused_with_a_code() {
    let fx = fixture();
    let mut agent = claude();
    named(&agent).await;
    fx.pane("s1",agent.id(),1700000000);
    let registry = fx.registry().await;
    let refused = registry.adopt_now("s1").await.map(|r|r.map_err(|e|e.code));
    assert_eq!(refused,Some(Err("claude_terminal_conversation_unproved".into())));
    finish(&mut agent);
}

/// A sessão restaurada nasce depois da adoção da subida: a drenagem do `Monitor` a adota, como a escrita,
/// em vez de falhar com `runtime_binding` e deixar a fila parada.
#[tokio::test]
async fn the_drain_of_a_restored_claude_terminal_adopts_it_instead_of_failing() {
    let fx = fixture();
    let mut agent = claude();
    named(&agent).await;
    fx.pane("s1",agent.id(),1700000000);
    fx.native(agent.id(),SID);
    let key = "ef".repeat(16);
    std::fs::write(fx.panes.with_extension("env"),format!("CP_SESSION_KEY={key}\n")).unwrap();
    let registry = fx.registry().await;
    let drained = registry.drain("s1").await.map(|_|()).map_err(|e|e.code);
    assert_eq!(drained,Ok(()));
    let (found,_) = registry.terminal_view("s1").await.expect("adotada pela drenagem");
    assert_eq!(found,key);
    registry.close(&key,1).await.unwrap();
    finish(&mut agent);
}

/// A vida `old_key` adotada em `s1` morre e o nome volta com outra sessão, de chave `new_key`, nascida em
/// `created`. Devolve o registro com a entrada da vida morta ainda guardada.
async fn recreated(fx:&Fixture,created:u64) -> (Arc<RuntimeRegistry>,Child,String) {
    let mut old = claude();
    named(&old).await;
    fx.pane("s1",old.id(),1700000000);
    fx.native(old.id(),SID);
    std::fs::write(fx.panes.with_extension("env"),format!("CP_SESSION_KEY={}\n","ab".repeat(16))).unwrap();
    let registry = fx.registry().await;
    assert_eq!(registry.adopt_now("s1").await.map(|r|r.map_err(|e|e.code)),Some(Ok(())));
    finish(&mut old);
    let new = claude();
    named(&new).await;
    fx.pane("s1",new.id(),created);
    fx.native(new.id(),"22222222-2222-4222-8222-222222222222");
    let new_key = "cd".repeat(16);
    std::fs::write(fx.panes.with_extension("env"),format!("CP_SESSION_KEY={new_key}\n")).unwrap();
    (registry,new,new_key)
}

async fn adopted_key(registry:&RuntimeRegistry,new_key:&str,mut new:Child) -> String {
    let (found,_) = registry.terminal_view("s1").await.expect("a vida nova foi adotada");
    registry.close(new_key,1).await.unwrap();
    finish(&mut new);
    found
}

/// Criada pelo Hangar com o nome de uma sessão que acabou: a criação solta a vida morta, e a escrita adota
/// a nova, com a chave e a conversa dela.
#[tokio::test]
async fn creating_a_session_with_the_name_of_a_dead_one_releases_the_dead_life() {
    let fx = fixture();
    let (registry,new,new_key) = recreated(&fx,1700000500).await;
    registry.release_name("s1").await.unwrap();
    assert_eq!(registry.drain("s1").await.map(|_|()).map_err(|e|e.code),Ok(()));
    assert_eq!(adopted_key(&registry,&new_key,new).await,new_key,"a fila e a conversa são as da vida nova, não as da morta");
}

/// Recriada por fora do Hangar (o CLI no tmux): a adoção vê outra chave no pane e troca de vida.
#[tokio::test]
async fn a_session_recreated_outside_the_hangar_is_adopted_instead_of_the_dead_life() {
    let fx = fixture();
    let (registry,new,new_key) = recreated(&fx,1700000500).await;
    assert_eq!(registry.adopt_now("s1").await.map(|r|r.map_err(|e|e.code)),Some(Ok(())));
    assert_eq!(adopted_key(&registry,&new_key,new).await,new_key);
}

/// Recriada no mesmo segundo (o instante do tmux tem resolução de 1 s): a chave do pane separa as vidas.
#[tokio::test]
async fn a_session_recreated_in_the_same_second_is_told_apart_by_its_key() {
    let fx = fixture();
    let (registry,new,new_key) = recreated(&fx,1700000000).await;
    assert_eq!(registry.adopt_now("s1").await.map(|r|r.map_err(|e|e.code)),Some(Ok(())));
    assert_eq!(adopted_key(&registry,&new_key,new).await,new_key);
}

/// O fim de turno com limite de uso precisa do alvo do terminal: o restaurado sem ator é adotado, e sem
/// Claude no pane o código diz isso, nunca silêncio.
#[tokio::test]
async fn the_usage_limit_target_adopts_the_restored_claude_or_says_why_not() {
    let fx = fixture();
    let registry = fx.registry().await;
    let status = registry.terminal_status("s1");
    let mut shell = std::process::Command::new("sleep").arg("120").spawn().unwrap();
    std::fs::write(&fx.panes,format!("s1\t1\t{}\t{}\t%7\t\t\t1700000000\t0\t0\n",shell.id(),fx.root.display())).unwrap();
    assert_eq!(registry.limit_target("s1").await.map(|_|()).map_err(|e|e.code),Err("limit_switch_no_target".into()));
    assert_eq!(status.borrow().limit.as_ref().map(|(code,_)|code.as_str()),Some("limit_switch_no_target"),"problema na linha");
    finish(&mut shell);
    let mut agent = claude();
    named(&agent).await;
    fx.pane("s1",agent.id(),1700000000);
    fx.native(agent.id(),SID);
    let key = "aa".repeat(16);
    std::fs::write(fx.panes.with_extension("env"),format!("CP_SESSION_KEY={key}\n")).unwrap();
    let target = registry.limit_target("s1").await.map_err(|e|e.code).expect("alvo do restaurado").expect("com terminal");
    assert_eq!(target.key,key);
    assert_eq!(status.borrow().limit,None,"o alvo voltou: o problema sai");
    registry.close(&key,1).await.unwrap();
    finish(&mut agent);
}

/// O caso real: Claude com terminal restaurado, conta padrão, o aviso de limite semanal no fim do transcript.
/// O fim de turno lê esse transcript e entrega o aviso ao vigia da troca, com a conta da sessão.
#[tokio::test]
async fn the_turn_end_of_a_restored_claude_hands_its_weekly_limit_to_the_switcher() {
    use hangar_server::runtime::gateway::TurnLimit;
    let fx = fixture();
    let mut agent = claude();
    named(&agent).await;
    fx.pane("s1",agent.id(),1700000000);
    fx.native(agent.id(),SID);
    let key = "bb".repeat(16);
    std::fs::write(fx.panes.with_extension("env"),format!("CP_SESSION_KEY={key}\n")).unwrap();
    let projects = fx.home.join(".claude/projects").join(hangar_workspace::worktrees::sanitize_cwd(&fx.root.to_string_lossy()));
    std::fs::create_dir_all(&projects).unwrap();
    std::fs::write(projects.join(format!("{SID}.jsonl")),include_str!("fixtures/usage_limit/claude_weekly_limit_tui_2026_10.jsonl")).unwrap();
    let registry = fx.registry().await;
    let (sink,mut hits) = tokio::sync::mpsc::unbounded_channel();
    registry.set_limit_sink(sink);
    registry.adopt_now("s1").await.unwrap().unwrap();
    let binding = registry.interaction_binding_readonly("s1").await.unwrap();
    let checked = registry.turn_limit("s1",&binding,1792249428.0).await.map_err(|e|e.code).unwrap();
    assert!(matches!(checked,TurnLimit::Checked { sent:true,.. }),"{checked:?}");
    let hit = hits.try_recv().expect("o vigia recebeu");
    assert_eq!((hit.name.as_str(),hit.limit.window.as_str(),hit.limit.resets_at),("s1","seven_day",Some(1792270800.0)));
    assert_eq!(hit.account.map(std::path::PathBuf::from).map(|p|p.canonicalize().unwrap()),Some(fx.home.join(".claude").canonicalize().unwrap()));
    registry.close(&key,1).await.unwrap();
    finish(&mut agent);
}

/// O clique de mod adota o Claude com terminal ainda sem ator: a adoção liga a sessão ao `Mods`, que é o que
/// faz a rota atender no Rust em vez de mandar ao Python.
#[tokio::test]
async fn adopting_a_terminal_claude_attaches_it_to_the_mods() {
    let fx = fixture();
    let mut agent = claude();
    named(&agent).await;
    fx.pane("s1",agent.id(),1700000000);
    fx.native(agent.id(),SID);
    let key = "ab".repeat(16);
    std::fs::write(fx.panes.with_extension("env"),format!("CP_SESSION_KEY={key}\n")).unwrap();
    let mods = hangar_server::mods::state::Mods::default();
    let map = [("HOME",fx.home.to_string_lossy().into_owned())].into_iter().map(|(k,v)|(k.to_owned(),v)).collect();
    let registry = crate::runtime_open::registry_with(|r|r.with_codex_environment(AccountEnvironment::from_map(map)).with_mods(mods.clone())).await;
    registry.bind_watcher(fx.watcher());
    assert!(!mods.owns("s1"));
    registry.adopt_claude_terminal("s1").await.map_err(|e|e.code).unwrap();
    assert!(mods.owns("s1"),"adotado, o clique fica no Rust");
    registry.close(&key,1).await.unwrap();
    finish(&mut agent);
}

#[tokio::test]
async fn at_startup_only_the_claude_terminals_that_had_a_queue_are_adopted() {
    let fx = fixture();
    let mut agent = claude();
    named(&agent).await;
    fx.pane("s1",agent.id(),1700000000);
    fx.native(agent.id(),SID);
    let key = "cd".repeat(16);
    std::fs::write(fx.panes.with_extension("env"),format!("CP_SESSION_KEY={key}\n")).unwrap();
    let registry = fx.registry().await;
    let watcher = fx.watcher();
    watcher.register_claude_terminals(&registry).await;
    assert!(registry.terminal_view("s1").await.is_none(),"sem fila aqui, espera a primeira escrita");
    std::fs::create_dir_all(fx.queue.join("runtime")).unwrap();
    hangar_server::runtime::queue::Store::open(&fx.queue.join(format!("runtime/{key}.json")),&fx.queue,
        hangar_server::runtime::queue::State::new(&key,3,"s1",vec![])).unwrap();
    watcher.register_claude_terminals(&registry).await;
    let (found,_) = registry.terminal_view("s1").await.expect("a que já tinha fila é adotada");
    assert_eq!(found,key);
    registry.close(&key,3).await.unwrap();
    finish(&mut agent);
}

#[tokio::test]
async fn nothing_is_adopted_while_a_reopen_holds_the_gate() {
    let fx = fixture();
    let mut agent = claude();
    named(&agent).await;
    fx.pane("s1",agent.id(),1700000000);
    fx.native(agent.id(),SID);
    let registry = fx.registry().await;
    registry.ingress().close("s1",Duration::from_secs(1)).await.unwrap();
    let refused = registry.adopt_now("s1").await.map(|r|r.map_err(|e|e.code));
    assert_eq!(refused,Some(Err("session_transfer_busy".into())),"a vida antiga não sobe por cima da troca");
    assert!(registry.terminal_view("s1").await.is_none());
    registry.ingress().open("s1");
    assert_eq!(registry.adopt_now("s1").await.map(|r|r.map_err(|e|e.code)),Some(Ok(())));
    let (key,_) = registry.terminal_view("s1").await.unwrap();
    registry.close(&key,1).await.unwrap();
    finish(&mut agent);
}

/// `claude` digitado num pane do tmux (o CLI cru) não nasceu pelo Hangar e não tem spec: a adoção o grava,
/// lido do processo, para o restore depois do reboot reabri-lo pelo Rust. O spec que já existe não é trocado.
#[tokio::test]
async fn adopting_a_raw_claude_records_its_spec_for_the_restore() {
    let fx = fixture();
    let mut agent = claude();
    named(&agent).await;
    fx.pane("s1",agent.id(),1700000000);
    fx.native(agent.id(),SID);
    let registry = fx.registry().await;
    assert_eq!(registry.adopt_now("s1").await.map(|r|r.map_err(|e|e.code)),Some(Ok(())));
    let (key,_) = registry.terminal_view("s1").await.unwrap();
    let path = fx.home.join(format!(".hangar/session-specs/{key}.json"));
    let spec:serde_json::Value = serde_json::from_slice(&std::fs::read(&path).expect("spec gravado na adoção")).unwrap();
    assert_eq!((spec["name"].as_str(),spec["provider"].as_str(),spec["surface"].as_str(),spec["conversation"].as_str()),
        (Some("s1"),Some("claude"),Some("terminal"),Some(SID)));
    assert_eq!(spec["cwd"].as_str().map(PathBuf::from),std::env::current_dir().ok(),"a pasta do agente");
    registry.close(&key,1).await.unwrap();
    // A próxima adoção não reescreve o spec que já existe.
    std::fs::write(&path,"{\"marca\":1}").unwrap();
    assert_eq!(registry.adopt_now("s1").await.map(|r|r.map_err(|e|e.code)),Some(Ok(())));
    assert_eq!(std::fs::read_to_string(&path).unwrap(),"{\"marca\":1}");
    let (key,generation) = registry.terminal_view("s1").await.map(|(k,_)|(k,1)).unwrap();
    let _ = registry.close(&key,generation).await;
    finish(&mut agent);
}
