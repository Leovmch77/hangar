//! Reabrir o Claude pelo spec (`reopen_claude_session`): um tmux falso que, no `new-session`, sobe um
//! processo de verdade chamado `claude` e responde como o tmux sobre ele. Nenhuma sessão viva, nenhum
//! `claude` real, nenhum `systemd-run`.
use hangar_server::accounts::environment::AccountEnvironment;
use hangar_server::list::mux::Mux;
use hangar_server::runtime::codex_terminal::{WatchConfig,Watcher};
use hangar_server::runtime::gateway::RuntimeRegistry;
use hangar_server::session_open::{ChangeReason,SessionChange,Surface};
use serde_json::{Value,json};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

const SID:&str = "11111111-1111-4111-8111-111111111111";
const FOOTER:&str = "\n❯ \n  ⏵⏵ accept edits on (shift+tab to cycle)\n";

struct Fixture { _dir:tempfile::TempDir, home:PathBuf, queue:PathBuf, state:PathBuf, tmux:PathBuf, cwd:PathBuf }

/// O tmux guarda a sessão em `state` (nome, pid, nascimento) e o ambiente em `state.env`; o `new-session`
/// grava os argumentos em `state.args`, sobe o `claude` e grava o registro nativo dele com a conversa.
fn fixture() -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_owned();
    let (home,state,tmux,cwd) = (root.join("home"),root.join("state"),root.join("fake-tmux"),root.join("work"));
    let queue = home.join(".claude/.hangar-queue");
    std::fs::create_dir_all(home.join(".claude/sessions")).unwrap();
    std::fs::create_dir_all(&cwd).unwrap();
    std::fs::write(state.with_extension("screen"),FOOTER).unwrap();
    let (s,sessions,c) = (state.display(),home.join(".claude/sessions").display().to_string(),cwd.display());
    crate::write_executable(&tmux,format!(r#"#!/bin/bash
S='{s}'
read_state() {{ [ -f "$S" ] && read -r NAME PID BORN < "$S"; }}
case "$1" in
  new-session)
    printf '%s\n' "$@" > "$S.args"
    : > "$S.env"; prev=""; for a in "$@"; do [ "$prev" = "-e" ] && echo "$a" >> "$S.env"; prev="$a"; done
    env -u CLAUDE_CONFIG_DIR bash -c 'exec -a claude sleep 120' </dev/null >/dev/null 2>&1 &
    pid=$!; for i in $(seq 100); do tr '\0' ' ' < /proc/$pid/cmdline | grep -q '^claude ' && break; sleep 0.01; done
    echo "$4 $pid 1700000100" > "$S"
    sid=$(printf '%s\n' "$@" | grep -oE -- '--(resume|session-id) [0-9a-f-]{{36}}' | head -1 | cut -d' ' -f2); [ -n "$sid" ] || sid='{SID}'
    echo "{{\"pid\":$pid,\"sessionId\":\"$sid\"}}" > '{sessions}'/$pid.json;;
  has-session) read_state && [ "$3" = "=$NAME" ];;
  kill-session) read_state && kill "$PID" 2>/dev/null; rm -f "$S";;
  list-panes) read_state && printf '%s\t1\t%s\t%s\t%%7\t\tclaude\t%s\t0\t0\n' "$NAME" "$PID" '{c}' "$BORN";;
  show-environment) grep "^$4=" "$S.env" || exit 1;;
  set-environment) echo "$4=$5" >> "$S.env";;
  display-message)
    read_state || exit 1
    case "$5" in
      '#{{pane_pid}}') echo "$PID";;
      '#{{session_name}}'*) printf '%s\t%%7\t%s\t%s\t0\t0\t0\n' "$NAME" "$BORN" "$PID";;
      '#{{pane_pid}}'*) printf '%s\t%s\t%%7\t%s\n' "$PID" "$NAME" "$BORN";;
      *) exit 1;;
    esac;;
  capture-pane) cat "$S.screen";;
  *) exit 1;;
esac
"#));
    Fixture { _dir:dir,home,queue,state,tmux,cwd }
}

impl Fixture {
    async fn registry(&self) -> Arc<RuntimeRegistry> {
        let map = [("HOME",self.home.to_string_lossy().into_owned()),("PATH",std::env::var("PATH").unwrap())].into_iter().map(|(k,v)|(k.to_owned(),v)).collect();
        let registry = crate::runtime_open::registry_with(|registry|registry.with_codex_environment(AccountEnvironment::from_map(map))).await;
        registry.bind_watcher(Arc::new(Watcher::new(WatchConfig { home:self.home.clone(),queue_dir:self.queue.clone(),
            mux:Mux::with_program(&self.tmux,Duration::from_secs(5)),mux_program:self.tmux.clone().into_os_string() }).with_scope_probe(Vec::new)));
        registry
    }
    fn sidecar_path(&self,name:&str) -> PathBuf { self.home.join(format!(".hangar/claude-headless/{name}.json")) }
    fn put_sidecar(&self,meta:Value) {
        std::fs::create_dir_all(self.home.join(".hangar/claude-headless")).unwrap();
        std::fs::write(self.sidecar_path(meta["name"].as_str().unwrap()),meta.to_string()).unwrap();
    }
    fn transcript(&self) {
        let dir = self.home.join(".claude/projects").join(hangar_workspace::worktrees::sanitize_cwd(&self.cwd.to_string_lossy()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(format!("{SID}.jsonl")),"{\"type\":\"user\"}\n").unwrap();
    }
    fn args(&self) -> Vec<String> { std::fs::read_to_string(self.state.with_extension("args")).unwrap_or_default().lines().map(str::to_owned).collect() }
    fn agent(&self) -> Option<u32> { std::fs::read_to_string(&self.state).ok()?.split_whitespace().nth(1)?.parse().ok() }
    fn finish(&self) { if let Some(pid) = self.agent() { let _ = std::process::Command::new("kill").arg(pid.to_string()).status(); } }
}

fn mode_switch(terminal:bool) -> SessionChange {
    SessionChange { reason:ChangeReason::ModeSwitch,surface:Some(if terminal {Surface::Terminal} else {Surface::Headless}),
        account:None,permission_mode:None,model:None,effort:None,service_tier:None }
}

#[tokio::test]
async fn a_parked_headless_session_goes_to_a_terminal_resuming_the_same_conversation_and_mode() {
    let fx = fixture();
    let key = "ab".repeat(16);
    fx.transcript();
    fx.put_sidecar(json!({"name":"s1","provider":"claude","headless":true,"key":key,"cwd":fx.cwd,"session_id":SID,
        "permission_mode":"acceptEdits","cano":null}));
    let registry = fx.registry().await;
    let reopened = registry.reopen_claude_session("s1",mode_switch(true),None).await.expect("é sessão Claude daqui");
    let reopened = reopened.map_err(|f|(f.error.code,f.error.message,f.stopped)).unwrap();
    assert!(reopened.changed);
    let args = fx.args();
    let command = args.last().unwrap();
    assert!(command.contains(&format!("claude --resume {SID}")),"a mesma conversa: {command}");
    assert!(command.contains("--permission-mode acceptEdits"),"o modo gravado: {command}");
    assert!(args.windows(2).any(|w|w[0]=="-e" && w[1]==format!("CP_SESSION_KEY={key}")),"a chave do spec: {args:?}");
    assert!(!fx.sidecar_path("s1").exists(),"o sidecar sai: nada sobe o processo sem terminal por cima");
    let (found,_) = registry.terminal_view("s1").await.expect("o terminal novo foi adotado");
    assert_eq!(found,key);
    let state:Value = serde_json::from_slice(&std::fs::read(fx.queue.join(format!("runtime/{key}.json"))).unwrap()).unwrap();
    assert_eq!(state["generation"],2,"a vida nova é a geração seguinte");
    let spec:Value = serde_json::from_slice(&std::fs::read(fx.home.join(format!(".hangar/session-specs/{key}.json"))).unwrap()).unwrap();
    assert_eq!((spec["surface"].as_str(),spec["permission_mode"].as_str()),(Some("terminal"),Some("acceptEdits")),"o spec gravado é o da vida nova");
    registry.close(&key,2).await.unwrap();
    fx.finish();
}

#[tokio::test]
async fn switching_to_the_mode_the_session_is_in_changes_nothing() {
    let fx = fixture();
    fx.put_sidecar(json!({"name":"s1","provider":"claude","headless":true,"key":"ab".repeat(16),"cwd":fx.cwd,"session_id":SID,"permission_mode":"manual"}));
    let registry = fx.registry().await;
    let same = registry.reopen_claude_session("s1",mode_switch(false),None).await.unwrap().map_err(|f|f.error.code).unwrap();
    assert!(!same.changed);
    assert!(fx.args().is_empty(),"nenhum terminal pedido");
    assert!(fx.sidecar_path("s1").exists());
}

#[tokio::test]
async fn a_terminal_whose_mode_was_never_known_is_refused_before_anything_stops() {
    let fx = fixture();
    // Pane aberto sem o registro do spec e sem `--permission-mode` no comando: ninguém sabe o modo.
    std::process::Command::new(&fx.tmux).args(["new-session","-d","-s","s1","-c"]).arg(&fx.cwd).status().unwrap();
    std::fs::write(fx.state.with_extension("env"),"").unwrap();
    let agent = fx.agent().unwrap();
    let registry = fx.registry().await;
    let refused = registry.reopen_claude_session("s1",mode_switch(false),None).await.expect("é sessão Claude daqui").unwrap_err();
    assert_eq!((refused.error.code.as_str(),refused.stopped),("permission_mode_unknown",false));
    assert!(std::path::Path::new(&format!("/proc/{agent}")).exists(),"o Claude do terminal segue vivo");
    assert!(!fx.sidecar_path("s1").exists());
    fx.finish();
}

async fn post(server:std::net::SocketAddr,route:&str,body:Value) -> (u16,Value) {
    let response = crate::fake::client().post(format!("http://{server}/api/sessions/s1/{route}"))
        .header("authorization", format!("Bearer {}", crate::fake::OWNER)).header("content-type", "application/json")
        .body(body.to_string()).send().await.unwrap();
    let status = response.status().as_u16();
    (status, serde_json::from_str(&response.text().await.unwrap()).unwrap_or(Value::Null))
}

#[tokio::test]
async fn the_mode_route_answers_like_python_and_never_reaches_it() {
    let fx = fixture();
    let key = "cd".repeat(16);
    fx.transcript();
    fx.put_sidecar(json!({"name":"s1","provider":"claude","headless":true,"key":key,"cwd":fx.cwd,"session_id":SID,"permission_mode":"acceptEdits","cano":null}));
    let registry = fx.registry().await;
    let (python, server) = crate::runtime_codex_watch::serve_owner(registry.clone()).await;
    assert_eq!(post(server,"modo-execucao",json!({"terminal":false})).await,(200,json!({"ok":true,"terminal":false})),"o modo em que já está");
    assert_eq!(post(server,"modo-execucao",json!({"terminal":true})).await,(200,json!({"ok":true,"terminal":true})));
    assert_eq!(python.hits_to("/api/sessions/s1/modo-execucao"),0,"o Python não troca o modo do Claude");
    registry.close(&key,2).await.unwrap();
    fx.finish();
}

#[tokio::test]
async fn a_message_waiting_in_the_queue_holds_the_reload_with_the_python_code() {
    let fx = fixture();
    let key = "ef".repeat(16);
    fx.put_sidecar(json!({"name":"s1","provider":"claude","headless":true,"key":key,"cwd":fx.cwd,"session_id":SID,"permission_mode":"manual","cano":null}));
    std::fs::create_dir_all(fx.queue.join("runtime")).unwrap();
    std::fs::write(fx.queue.join(format!("runtime/{key}.json")),json!({"key":key,"owner_key":key,"generation":1,"name":"s1",
        "rows":[{"id":"1","text":"oi","delivered":false}]}).to_string()).unwrap();
    let registry = fx.registry().await;
    let (_python, server) = crate::runtime_codex_watch::serve_owner(registry).await;
    let (status,body) = post(server,"recarregar",json!({})).await;
    assert_eq!((status,body["detail"]["code"].as_str()),(409,Some("erro_fila_pendente")));
    assert_eq!(body["detail"]["msg"],"há mensagens na fila esperando entrega");
    assert!(fx.sidecar_path("s1").exists(),"nada mudou");
}

/// O servidor com as contas desta casa de teste (nunca as do HOME de quem roda os testes).
async fn serve_with_accounts(fx:&Fixture,registry:Arc<RuntimeRegistry>) -> std::net::SocketAddr {
    let (_python, upstream) = crate::fake::spawn_fake().await;
    let mut state = hangar_server::routes::AppState::new(crate::fake::config(upstream, "127.0.0.1"));
    let map = [("HOME",fx.home.to_string_lossy().into_owned())].into_iter().map(|(k,v)|(k.to_owned(),v)).collect();
    state.accounts = hangar_server::accounts::AccountService::new(AccountEnvironment::from_map(map));
    assert!(state.state.runtime.set(registry).is_ok());
    crate::fake::spawn_state(state).await
}

/// Conta B de verdade: login e `projects/`.
fn account_b(fx:&Fixture) -> PathBuf {
    let b = fx.home.join(".claude-b");
    std::fs::create_dir_all(b.join("projects")).unwrap();
    std::fs::write(b.join(".credentials.json"),"{\"claudeAiOauth\":{\"accessToken\":\"b\"}}").unwrap();
    b
}

#[tokio::test]
async fn the_account_route_moves_a_terminal_conversation_to_the_new_account_and_reopens_there() {
    let fx = fixture();
    let b = account_b(&fx);
    std::fs::write(fx.home.join(".claude/.credentials.json"),"{\"claudeAiOauth\":{\"accessToken\":\"a\"}}").unwrap();
    fx.transcript();
    let key = "12".repeat(16);
    // O terminal da sessão na conta padrão, aberto pelo Rust (com a chave e o registro do spec).
    std::process::Command::new(&fx.tmux).args(["new-session","-d","-s","s1","-c"]).arg(&fx.cwd).arg("-e").arg(format!("CP_SESSION_KEY={key}")).status().unwrap();
    let old_agent = fx.agent().unwrap();
    let spec = json!({"version":1,"key":key,"name":"s1","cwd":fx.cwd,"provider":"claude","surface":"terminal","account":{"kind":"default"},
        "account_source":"default","model":null,"effort":null,"service_tier":null,"permission_mode":"acceptEdits","subagent_model":null,
        "customizations":null,"jev":false,"read_only":false,"worktree":null,"creator":null,"created_at":1.0});
    std::fs::create_dir_all(fx.home.join(".hangar/session-specs")).unwrap();
    std::fs::write(fx.home.join(format!(".hangar/session-specs/{key}.json")),spec.to_string()).unwrap();
    let registry = crate::runtime_open::registry_with(|registry|registry
        .with_codex_environment(AccountEnvironment::from_map([("HOME".to_owned(),fx.home.to_string_lossy().into_owned()),("PATH".to_owned(),std::env::var("PATH").unwrap())].into()))
        .with_terms(Arc::new(hangar_server::term::Terms::default()))).await;
    registry.bind_watcher(Arc::new(Watcher::new(WatchConfig { home:fx.home.clone(),queue_dir:fx.queue.clone(),
        mux:Mux::with_program(&fx.tmux,Duration::from_secs(5)),mux_program:fx.tmux.clone().into_os_string() }).with_scope_probe(Vec::new)));
    let server = serve_with_accounts(&fx,registry.clone()).await;
    let (status,body) = post(server,"conta",json!({"config_dir":b})).await;
    assert_eq!((status,&body),(200,&json!({"ok":true,"config_dir":b})),"{body}");
    assert!(!std::path::Path::new(&format!("/proc/{old_agent}/cmdline")).exists() || std::fs::read_to_string(format!("/proc/{old_agent}/cmdline")).unwrap_or_default().is_empty(),"o Claude antigo saiu");
    let project = hangar_workspace::worktrees::sanitize_cwd(&fx.cwd.to_string_lossy());
    assert!(b.join(format!("projects/{project}/{SID}.jsonl")).exists(),"a conversa foi para a conta B");
    assert!(!fx.home.join(format!(".claude/projects/{project}/{SID}.jsonl")).exists(),"nada ficou na conta de antes");
    let args = fx.args();
    assert!(args.windows(2).any(|w|w[0]=="-e" && w[1]==format!("CLAUDE_CONFIG_DIR={}",b.display())),"o terminal novo lê a conta B: {args:?}");
    assert!(args.last().unwrap().contains(&format!("--resume {SID}")));
    let written:Value = serde_json::from_slice(&std::fs::read(fx.home.join(format!(".hangar/session-specs/{key}.json"))).unwrap()).unwrap();
    assert_eq!(written["account"],json!({"kind":"claude","config_dir":b}));
    let trusted:Value = serde_json::from_slice(&std::fs::read(b.join(".claude.json")).unwrap()).unwrap();
    assert_eq!(trusted["projects"][fx.cwd.to_string_lossy().as_ref()]["hasTrustDialogAccepted"],true,"a pasta confiada na conta nova");
    let (found,_) = registry.terminal_view("s1").await.unwrap();
    registry.close(&found,2).await.unwrap();
    fx.finish();
}

/// `/resume` numa sessão aberta sem id (o pane roda `claude` sem o registro nativo, ninguém prova a
/// conversa): pelo caminho das outras reaberturas (S-22), a vida nova é montada antes, a antiga sai inteira
/// antes de a nova subir (S-17) e a nova é conferida na conversa pedida; o spec grava a conversa.
#[tokio::test]
async fn a_session_opened_without_an_id_resumes_the_chosen_conversation() {
    const OTHER:&str = "22222222-2222-4222-8222-222222222222";
    let fx = fixture();
    let project = fx.home.join(".claude/projects").join(hangar_workspace::worktrees::sanitize_cwd(&fx.cwd.to_string_lossy()));
    std::fs::create_dir_all(&project).unwrap();
    std::fs::write(project.join(format!("{OTHER}.jsonl")),"{\"type\":\"user\"}\n").unwrap();
    std::fs::write(fx.home.join(".claude/settings.json"),r#"{"permissions":{"defaultMode":"acceptEdits"}}"#).unwrap();
    std::process::Command::new(&fx.tmux).args(["new-session","-d","-s","s1","-c"]).arg(&fx.cwd).status().unwrap();
    let old_agent = fx.agent().unwrap();
    // Sem o registro nativo e sem transcript: a conversa do pane não tem prova.
    std::fs::remove_file(fx.home.join(format!(".claude/sessions/{old_agent}.json"))).unwrap();
    let registry = fx.registry().await;
    let resumed = registry.resume_claude_session("s1",OTHER).await.expect("é sessão Claude daqui");
    let resumed = resumed.map_err(|f|(f.error.code,f.error.message,f.stopped)).unwrap();
    assert!(resumed.changed);
    assert!(std::fs::read_to_string(format!("/proc/{old_agent}/cmdline")).unwrap_or_default().is_empty(),"o Claude antigo saiu antes");
    let args = fx.args();
    let command = args.last().unwrap();
    assert!(command.contains(&format!("claude --resume {OTHER}")),"a conversa escolhida: {command}");
    assert!(command.contains("--permission-mode acceptEdits"),"o modo da conta, explícito: {command}");
    let (key,_) = registry.terminal_view("s1").await.expect("adotado na conversa nova");
    let spec:Value = serde_json::from_slice(&std::fs::read(fx.home.join(format!(".hangar/session-specs/{key}.json"))).unwrap()).unwrap();
    assert_eq!(spec["conversation"],OTHER,"o spec guarda a conversa retomada");
    registry.close(&key,2).await.unwrap();
    fx.finish();
}
