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
    [ -f "$S.nospawn" ] && exit 1
    : > "$S.env"; prev=""; for a in "$@"; do [ "$prev" = "-e" ] && echo "$a" >> "$S.env"; prev="$a"; done
    # O processo leva o ambiente do `-e` e o que o `hangar-engine` poria; `$S.forge` sobrepõe (outra identidade).
    E=(); while IFS= read -r l; do E+=("$l"); done < "$S.env"
    last="${{@: -1}}"
    x=$(grep -oE -- 'hangar-engine --exec [^ ]+' <<<"$last" | cut -d' ' -f3); [ -n "$x" ] && E+=("CP_ENGINE=$x")
    x=$(grep -oE -- '--account [^ ]+' <<<"$last" | cut -d' ' -f2); [ -n "$x" ] && E+=("CP_ENGINE_ACCOUNT=$x")
    x=$(grep -oE -- '--service-tier [^ ]+' <<<"$last" | cut -d' ' -f2); [ -n "$x" ] && E+=("CP_ENGINE_SERVICE_TIER=$x")
    [ -f "$S.forge" ] && while IFS= read -r l; do E+=("$l"); done < "$S.forge"
    # `$S.stubborn`: este `claude` ignora o SIGTERM (só esta subida).
    pre=''; [ -f "$S.stubborn" ] && pre='trap "" TERM; ' && rm -f "$S.stubborn"
    env -u CLAUDE_CONFIG_DIR "${{E[@]}}" bash -c "${{pre}}exec -a claude sleep 120" </dev/null >/dev/null 2>&1 &
    pid=$!; for i in $(seq 100); do tr '\0' ' ' < /proc/$pid/cmdline | grep -q '^claude ' && break; sleep 0.01; done
    echo "$4 $pid 1700000100" > "$S"
    sid=$(printf '%s\n' "$@" | grep -oE -- '--(resume|session-id) [0-9a-f-]{{36}}' | head -1 | cut -d' ' -f2); [ -n "$sid" ] || sid='{SID}'
    # O registro nativo vai à pasta da conta em que o processo roda.
    dir='{sessions}'; for l in "${{E[@]}}"; do case "$l" in CLAUDE_CONFIG_DIR=*) dir="${{l#CLAUDE_CONFIG_DIR=}}/sessions";; esac; done
    mkdir -p "$dir"; echo "{{\"pid\":$pid,\"sessionId\":\"$sid\"}}" > "$dir/$pid.json";;
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
        // `hangar-engine` falso à frente: a sessão de motor não depende do que esta máquina tem instalado.
        let bin = self.home.join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        crate::write_executable(&bin.join("hangar-engine"),"#!/bin/sh\nexit 0\n");
        let path = format!("{}:{}",bin.display(),std::env::var("PATH").unwrap());
        let map = [("HOME",self.home.to_string_lossy().into_owned()),("PATH",path)].into_iter().map(|(k,v)|(k.to_owned(),v)).collect();
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

#[tokio::test]
async fn the_queue_held_by_the_usage_limit_goes_along_with_the_reopen() {
    use hangar_server::runtime::{gateway::LimitHit,protocol::UsageLimit};
    let fx = fixture();
    let key = "ef".repeat(16);
    fx.put_sidecar(json!({"name":"s1","provider":"claude","headless":true,"key":key,"cwd":fx.cwd,"session_id":SID,"permission_mode":"manual","cano":null}));
    std::fs::create_dir_all(fx.queue.join("runtime")).unwrap();
    std::fs::write(fx.queue.join(format!("runtime/{key}.json")),json!({"key":key,"owner_key":key,"generation":1,"name":"s1",
        "rows":[{"id":"1","text":"oi","delivered":false}]}).to_string()).unwrap();
    let registry = fx.registry().await;
    let (sink,_hits) = tokio::sync::mpsc::unbounded_channel();
    registry.set_limit_sink(sink);
    registry.usage_limit(LimitHit { name:"s1".into(),provider:"claude".into(),account:None,limit:UsageLimit { window:"five_hour".into(),resets_at:None } });
    let (_python, server) = crate::runtime_codex_watch::serve_owner(registry).await;
    let (_,body) = post(server,"recarregar",json!({})).await;
    assert_ne!(body["detail"]["code"].as_str(),Some("erro_fila_pendente"),"{body}");
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

/// CRA-005/RET-001: a porta retida pela troca de conversa (a transferência Claude→Codex) recusa a
/// reabertura na hora com o código da transferência, antes de qualquer efeito; nunca espera nem passa por cima.
#[tokio::test]
async fn a_port_held_by_the_transfer_refuses_the_reopen_with_the_transfer_code() {
    let fx = fixture();
    fx.transcript();
    fx.put_sidecar(json!({"name":"s1","provider":"claude","headless":true,"key":"ab".repeat(16),"cwd":fx.cwd,"session_id":SID,
        "permission_mode":"acceptEdits","cano":null}));
    let registry = fx.registry().await;
    registry.ingress().hold("s1",Duration::from_secs(1)).await.unwrap();
    let refused = tokio::time::timeout(Duration::from_secs(5),registry.reopen_claude_session("s1",mode_switch(true),None)).await
        .expect("recusa na hora, sem esperar a porta").expect("é sessão Claude daqui").unwrap_err();
    assert_eq!((refused.error.code.as_str(),refused.stopped),("session_transfer_busy",false));
    assert!(fx.args().is_empty(),"nenhum terminal pedido");
    assert!(fx.sidecar_path("s1").exists(),"nada mudou");
    registry.ingress().release("s1");
}

/// RET-001: o registro de uma transferência em curso também recusa a retomada, como o `_transfer_guard`.
#[tokio::test]
async fn an_open_transfer_record_refuses_the_resume() {
    let fx = fixture();
    fx.transcript();
    fx.put_sidecar(json!({"name":"s1","provider":"claude","headless":true,"key":"ab".repeat(16),"cwd":fx.cwd,"session_id":SID,
        "permission_mode":"acceptEdits","cano":null}));
    let transfers = fx.home.join(".hangar/conversation-transfers");
    std::fs::create_dir_all(transfers.join("indexes")).unwrap();
    let id = "33333333-3333-4333-8333-333333333333";
    std::fs::write(transfers.join(format!("{id}.json")),json!({"name":"s1","phase":"prepared"}).to_string()).unwrap();
    let digest:String = ring::digest::digest(&ring::digest::SHA256,b"s1").as_ref().iter().map(|b|format!("{b:02x}")).collect();
    std::fs::write(transfers.join(format!("indexes/session-{digest}.json")),json!([id]).to_string()).unwrap();
    let registry = fx.registry().await;
    let refused = registry.resume_claude_session("s1",SID).await.expect("é sessão Claude daqui").unwrap_err();
    assert_eq!((refused.error.code.as_str(),refused.stopped),("session_transfer_busy",false));
    assert!(fx.args().is_empty() && fx.sidecar_path("s1").exists(),"nada mudou");
}

/// Sem terminal parada com `extra` no sidecar, levada ao terminal: o resultado e o comando pedido.
async fn to_terminal(fx:&Fixture,extra:Value) -> (Result<(),(String,bool)>,Vec<String>) {
    fx.transcript();
    let mut meta = json!({"name":"s1","provider":"claude","headless":true,"key":"ab".repeat(16),"cwd":fx.cwd,"session_id":SID,
        "permission_mode":"acceptEdits","cano":null});
    for (field,value) in extra.as_object().unwrap() { meta[field] = value.clone(); }
    fx.put_sidecar(meta);
    let registry = fx.registry().await;
    let outcome = registry.reopen_claude_session("s1",mode_switch(true),None).await.expect("é sessão Claude daqui")
        .map(|_|()).map_err(|f|(f.error.code,f.stopped));
    if outcome.is_ok() { registry.close(&"ab".repeat(16),2).await.unwrap(); fx.finish(); }
    (outcome,fx.args())
}

fn command(args:&[String]) -> String { args.last().cloned().unwrap_or_default() }

/// CRA-015/TMX-073/RET-015: o motor que sumiu do `engines.json` volta na conta Anthropic, sem o modelo,
/// o esforço, a janela e o Fast dele: reaplicá-los numa conta Anthropic criaria uma sessão inviável.
#[tokio::test]
async fn an_engine_gone_from_the_catalog_reopens_on_the_anthropic_account_without_its_choices() {
    let fx = fixture();
    let (outcome,args) = to_terminal(&fx,json!({"engine":"gone","model":"gpt-5.4","effort":"high","context_window":400000,"service_tier":"default"})).await;
    assert_eq!(outcome,Ok(()));
    let command = command(&args);
    assert!(!command.contains("hangar-engine") && !command.contains("--model") && !command.contains("--effort"),"conta Anthropic, sem a escolha do motor: {command}");
    let spec:Value = serde_json::from_slice(&std::fs::read(fx.home.join(format!(".hangar/session-specs/{}.json","ab".repeat(16)))).unwrap()).unwrap();
    assert_eq!((spec["account"]["kind"].as_str(),spec["service_tier"].is_null()),(Some("default"),true));
}

/// CRA-015/RET-015: com a conta ChatGPT fixa, o motor que sumiu recusa antes de encerrar.
#[tokio::test]
async fn a_fixed_account_engine_gone_from_the_catalog_refuses_before_anything_stops() {
    let fx = fixture();
    let (outcome,args) = to_terminal(&fx,json!({"engine":"gone","engine_account":"acc","model":"gpt-5.4"})).await;
    assert_eq!(outcome,Err(("reopen_engine_missing".into(),false)));
    assert!(args.is_empty() && fx.sidecar_path("s1").exists(),"nada mudou");
}

/// RET-019: sem motor, o id de motor herdado de um `/model` não vira `--model` na conta Anthropic.
#[tokio::test]
async fn a_foreign_model_without_an_engine_reopens_on_the_account_default() {
    let fx = fixture();
    let (outcome,args) = to_terminal(&fx,json!({"model":"gpt-5.4"})).await;
    assert_eq!(outcome,Ok(()));
    assert!(!command(&args).contains("--model"),"{}",command(&args));
}

/// RET-020: o modelo malformado é recusado antes de encerrar, pela mesma regra da criação.
#[tokio::test]
async fn a_malformed_model_refuses_before_anything_stops() {
    let fx = fixture();
    let (outcome,args) = to_terminal(&fx,json!({"model":"claude-x;touch /tmp/y"})).await;
    assert_eq!(outcome,Err(("reopen_model_invalid".into(),false)));
    assert!(args.is_empty() && fx.sidecar_path("s1").exists(),"nada mudou");
}

fn engines(fx:&Fixture,base:&str) {
    std::fs::write(fx.home.join(".claude/engines.json"),json!({"e":{"base_url":base,"model":"gpt-5.4","api_key":"x"}}).to_string()).unwrap();
}

/// CRA-016/TMX-075/RET-021: o Fast vai ao terminal só onde há suporte: `priority` sem ele recusa antes
/// de encerrar, `default` sem ele some do comando.
#[tokio::test]
async fn the_fast_tier_needs_support_before_the_terminal_reopens() {
    let fx = fixture();
    engines(&fx,"http://example.invalid/v1");
    let (outcome,args) = to_terminal(&fx,json!({"engine":"e","model":"gpt-5.4","service_tier":"priority"})).await;
    assert_eq!(outcome,Err(("launch_service_tier".into(),false)));
    assert!(args.is_empty());
    let fx = fixture();
    engines(&fx,"http://example.invalid/v1");
    let (outcome,args) = to_terminal(&fx,json!({"engine":"e","model":"gpt-5.4","service_tier":"default"})).await;
    assert_eq!(outcome,Ok(()));
    assert!(command(&args).contains("hangar-engine") && !command(&args).contains("--service-tier"),"{}",command(&args));
}

/// CRA-027/TMX-075: com Fast, o `CLAUDE_CODE_EXTRA_BODY` inválido nas escolhas do projeto recusa antes de
/// encerrar (o pré-voo do `engines.service_tier_settings`); válido, o tier vai ao comando.
#[tokio::test]
async fn an_invalid_engine_body_refuses_the_fast_reopen_before_anything_stops() {
    let proxy = |fx:&Fixture| {
        std::fs::create_dir_all(fx.home.join(".cli-proxy-api")).unwrap();
        std::fs::write(fx.home.join(".cli-proxy-api/config.yaml"),"port: 8317\napi-keys:\n  - k\n").unwrap();
        engines(fx,"http://127.0.0.1:8317/v1");
    };
    let fx = fixture();
    proxy(&fx);
    std::fs::create_dir_all(fx.cwd.join(".claude")).unwrap();
    std::fs::write(fx.cwd.join(".claude/settings.json"),json!({"env":{"CLAUDE_CODE_EXTRA_BODY":"{torto"}}).to_string()).unwrap();
    let (outcome,args) = to_terminal(&fx,json!({"engine":"e","model":"gpt-5.4","service_tier":"priority"})).await;
    assert_eq!(outcome,Err(("reopen_engine_body".into(),false)));
    assert!(args.is_empty() && fx.sidecar_path("s1").exists(),"nada mudou");
    let fx = fixture();
    proxy(&fx);
    let (outcome,args) = to_terminal(&fx,json!({"engine":"e","model":"gpt-5.4","service_tier":"priority"})).await;
    assert_eq!(outcome,Ok(()));
    assert!(command(&args).contains("--service-tier priority"),"{}",command(&args));
}

/// CRA-035: a vida nova que sobe noutra conta (o `wait_for_claude` do Python conferia `CLAUDE_CONFIG_DIR`,
/// motor, conta fixa e Fast) não é dada como reaberta, mesmo na conversa e no modo pedidos.
#[tokio::test]
async fn a_new_life_with_another_identity_is_not_a_reopen() {
    let fx = fixture();
    std::fs::write(fx.state.with_extension("forge"),format!("CLAUDE_CONFIG_DIR={}\n",fx.home.join(".claude-outra").display())).unwrap();
    let (outcome,_) = to_terminal(&fx,json!({})).await;
    assert_eq!(outcome.map_err(|(code,_)|code),Err("reopen_identity".into()));
    fx.finish();
}

/// CRA-056: o Fast da sessão de motor confere o modelo em uso (a linha de status do terminal), não o
/// gravado: o `/model` trocado para um que não aceita Fast recusa.
#[tokio::test]
async fn fast_checks_the_model_in_use_not_the_recorded_one() {
    let fx = fixture();
    std::fs::create_dir_all(fx.home.join(".cli-proxy-api")).unwrap();
    std::fs::write(fx.home.join(".cli-proxy-api/config.yaml"),"port: 8317\napi-keys:\n  - k\n").unwrap();
    engines(&fx,"http://127.0.0.1:8317/v1");
    fx.transcript();
    let key = "34".repeat(16);
    std::process::Command::new(&fx.tmux).args(["new-session","-d","-s","s1","-c"]).arg(&fx.cwd).arg("-e").arg(format!("CP_SESSION_KEY={key}")).status().unwrap();
    let spec = json!({"version":1,"key":key,"name":"s1","cwd":fx.cwd,"provider":"claude","surface":"terminal",
        "account":{"kind":"engine","name":"e","account":null,"config_dir":null,"context_window":null},
        "account_source":"explicit","model":"gpt-5.4","effort":null,"service_tier":null,"permission_mode":"acceptEdits","subagent_model":null,
        "customizations":null,"jev":false,"read_only":false,"worktree":null,"creator":null,"created_at":1.0});
    std::fs::create_dir_all(fx.home.join(".hangar/session-specs")).unwrap();
    std::fs::write(fx.home.join(format!(".hangar/session-specs/{key}.json")),spec.to_string()).unwrap();
    std::fs::create_dir_all(fx.home.join(".claude/.hangar-status")).unwrap();
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs_f64();
    std::fs::write(fx.home.join(format!(".claude/.hangar-status/{SID}.json")),json!({"line":"x","model":"claude-opus-4-5","ts":now}).to_string()).unwrap();
    let registry = fx.registry().await;
    let server = serve_with_accounts(&fx,registry.clone()).await;
    let (status,body) = post(server,"service-tier",json!({"service_tier":"priority"})).await;
    assert_eq!((status,body["detail"]["code"].as_str()),(400,Some("erro_fast_indisponivel")),"{body}");
    fx.finish();
}

/// CRA-020: no plano sem a base guardada (memória ou sidecar), a base é a do transcript e, sem ela, a do
/// modo da conta; base bypass leva a licença de voltar ao bypass ao sair do plano.
#[tokio::test]
async fn a_plan_without_a_remembered_base_takes_it_from_the_transcript_then_the_account() {
    for (transcript,settings) in [(Some("bypassPermissions"),Some("acceptEdits")),(None,None)] {
        let fx = fixture();
        let dir = fx.home.join(".claude/projects").join(hangar_workspace::worktrees::sanitize_cwd(&fx.cwd.to_string_lossy()));
        std::fs::create_dir_all(&dir).unwrap();
        let line = transcript.map_or_else(||json!({"type":"user"}),|mode|json!({"type":"user","permissionMode":mode}));
        std::fs::write(dir.join(format!("{SID}.jsonl")),format!("{line}\n{}\n",json!({"type":"user","permissionMode":"plan"}))).unwrap();
        if let Some(mode) = settings { std::fs::write(fx.home.join(".claude/settings.json"),json!({"permissions":{"defaultMode":mode}}).to_string()).unwrap(); }
        fx.put_sidecar(json!({"name":"s1","provider":"claude","headless":true,"key":"ab".repeat(16),"cwd":fx.cwd,"session_id":SID,
            "permission_mode":"plan","cano":null}));
        std::fs::write(fx.state.with_extension("screen"),"\n❯ \n  ⏸ plan mode on (shift+tab to cycle)\n").unwrap();
        let registry = fx.registry().await;
        registry.reopen_claude_session("s1",mode_switch(true),None).await.unwrap().map_err(|f|f.error.code).unwrap();
        let command = command(&fx.args());
        assert!(command.contains("--allow-dangerously-skip-permissions"),"base bypass ({transcript:?}): {command}");
        registry.close(&"ab".repeat(16),2).await.unwrap();
        fx.finish();
    }
}

/// RET-025: retomar OUTRA conversa leva as escolhas de plugins e skills guardadas dela, não as do processo
/// que roda agora.
#[tokio::test]
async fn resuming_another_conversation_brings_its_stored_choices() {
    const OTHER:&str = "22222222-2222-4222-8222-222222222222";
    let fx = fixture();
    let project = fx.home.join(".claude/projects").join(hangar_workspace::worktrees::sanitize_cwd(&fx.cwd.to_string_lossy()));
    std::fs::create_dir_all(&project).unwrap();
    std::fs::write(project.join(format!("{OTHER}.jsonl")),"{\"type\":\"user\"}\n").unwrap();
    std::fs::write(fx.home.join(".claude/settings.json"),r#"{"permissions":{"defaultMode":"acceptEdits"}}"#).unwrap();
    std::fs::create_dir_all(fx.home.join(".hangar/claude-customizations")).unwrap();
    std::fs::write(fx.home.join(format!(".hangar/claude-customizations/{OTHER}.json")),
        json!({"settings":{"enabledPlugins":{"guardado@loja":false}}}).to_string()).unwrap();
    let own = json!({"enabledPlugins":{"do-processo@loja":false}}).to_string();
    std::process::Command::new(&fx.tmux).args(["new-session","-d","-s","s1","-c"]).arg(&fx.cwd)
        .arg("-e").arg(format!("HANGAR_CLAUDE_SETTINGS={own}")).status().unwrap();
    let old_agent = fx.agent().unwrap();
    std::fs::remove_file(fx.home.join(format!(".claude/sessions/{old_agent}.json"))).unwrap();
    let registry = fx.registry().await;
    let resumed = registry.resume_claude_session("s1",OTHER).await.expect("é sessão Claude daqui");
    resumed.map_err(|f|(f.error.code,f.error.message)).unwrap();
    let command = command(&fx.args());
    assert!(command.contains("guardado@loja") && !command.contains("do-processo@loja"),"{command}");
    let (key,_) = registry.terminal_view("s1").await.unwrap();
    registry.close(&key,2).await.unwrap();
    fx.finish();
}

/// CRA-049: o `claude` antigo que não sai no prazo (ignora o SIGTERM) é morto à força, conferido pela
/// identidade, e a reabertura segue; nunca dois Claude na mesma conversa.
#[tokio::test]
async fn an_old_claude_that_ignores_the_stop_is_killed_and_the_reopen_goes_on() {
    let fx = fixture();
    fx.transcript();
    let key = "56".repeat(16);
    std::fs::write(fx.state.with_extension("stubborn"),"").unwrap();
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
    let change = SessionChange { reason:ChangeReason::Reload,surface:None,account:None,permission_mode:None,model:None,effort:None,service_tier:None };
    let reopened = registry.reopen_claude_session("s1",change,None).await.expect("é sessão Claude daqui");
    let outcome = reopened.map(|_|()).map_err(|f|(f.error.code,f.stopped));
    let _ = std::process::Command::new("kill").args(["-9",&old_agent.to_string()]).status();
    assert_eq!(outcome,Ok(()));
    assert!(std::fs::read_to_string(format!("/proc/{old_agent}/cmdline")).unwrap_or_default().is_empty(),"o antigo saiu à força");
    let (found,_) = registry.terminal_view("s1").await.unwrap();
    registry.close(&found,2).await.unwrap();
    fx.finish();
}

/// CRA-047: a sessão só leitura estacionada cuja troca de conta não traz o terminal protegido fica parada
/// (o arquivo dela continua lá), com `erro_troca_conta_parada`; nunca sem nada nem sem terminal.
#[tokio::test]
async fn a_parked_read_only_session_whose_terminal_does_not_come_back_stays_parked() {
    let fx = fixture();
    let b = account_b(&fx);
    std::fs::write(fx.home.join(".claude/.credentials.json"),"{\"claudeAiOauth\":{\"accessToken\":\"a\"}}").unwrap();
    fx.transcript();
    fx.put_sidecar(json!({"name":"s1","provider":"claude","headless":true,"key":"ab".repeat(16),"cwd":fx.cwd,"session_id":SID,
        "permission_mode":"acceptEdits","cano":null,"read_only":true}));
    std::fs::write(fx.state.with_extension("nospawn"),"").unwrap();
    let registry = fx.registry().await;
    let server = serve_with_accounts(&fx,registry).await;
    let (status,body) = post(server,"conta",json!({"config_dir":b})).await;
    assert_eq!((status,body["detail"]["code"].as_str()),(409,Some("erro_troca_conta_parada")),"{body}");
    let meta:Value = serde_json::from_slice(&std::fs::read(fx.sidecar_path("s1")).expect("segue estacionada")).unwrap();
    assert_eq!((meta["read_only"].as_bool(),meta["session_id"].as_str()),(Some(true),Some(SID)));
}
