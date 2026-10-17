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

/// O fim de turno com limite de uso precisa do alvo do terminal: o restaurado sem ator é adotado, e sem
/// Claude no pane o código diz isso, nunca silêncio.
#[tokio::test]
async fn the_usage_limit_target_adopts_the_restored_claude_or_says_why_not() {
    let fx = fixture();
    let mut agent = claude();
    named(&agent).await;
    fx.pane("s1",agent.id(),1700000000);
    fx.native(agent.id(),SID);
    let key = "aa".repeat(16);
    std::fs::write(fx.panes.with_extension("env"),format!("CP_SESSION_KEY={key}\n")).unwrap();
    let registry = fx.registry().await;
    let target = registry.limit_target("s1").await.map_err(|e|e.code).expect("alvo do restaurado").expect("com terminal");
    assert_eq!(target.key,key);
    registry.close(&key,1).await.unwrap();
    finish(&mut agent);
    let mut shell = std::process::Command::new("sleep").arg("120").spawn().unwrap();
    std::fs::write(&fx.panes,format!("s2\t1\t{}\t{}\t%7\t\t\t1700000000\t0\t0\n",shell.id(),fx.root.display())).unwrap();
    assert_eq!(registry.limit_target("s2").await.map(|_|()).map_err(|e|e.code),Err("limit_switch_no_target".into()));
    finish(&mut shell);
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
