//! Reabrir o Claude pelo spec: `reopen_session(nome, SessionChange)` para troca de modo (terminal ⇄ sem
//! terminal), recarregar, bypass e troca de conta. A ordem é a da spec: monta a vida nova (comando,
//! ambiente, conta) antes de tocar em processo; encerra a antiga e confirma que ela saiu, a árvore inteira
//! (S-18); dá a partida na nova e confirma que ela está viva na conversa e no modo pedidos; grava o spec.
//! Falha antes de encerrar não muda nada; falha depois volta a sessão pelo spec antigo e o erro sai com
//! código. O modo vem do spec e do que o Rust observou da sessão, nunca de uma leitura do rodapé feita na
//! hora: sem modo conhecido, recusa (S-01).
use super::gateway::RuntimeRegistry;
use super::protocol::RuntimeError;
use super::terminal::TerminalTarget;
use crate::list::procs::{ProcessView,SystemProcs};
use crate::session_open::claude::ClaudeContext;
use crate::session_open::terminal::{PaneSpec,TerminalEnv};
use crate::session_open::{Account,PermissionMode,SessionChange,SessionSpec,Surface};
use serde_json::{Value,json};
use std::path::PathBuf;
use std::time::Duration;

fn refused(code:&str,message:&str) -> RuntimeError { RuntimeError::new(code,message) }

/// As frases do `_OCUPADA` do Python, que o app já mostra.
pub fn busy_message(code:&str) -> Option<&'static str> {
    Some(match code {
        "erro_sessao_iniciando"=>"a sessão ainda está iniciando — espere ela ficar pronta",
        "erro_sessao_esperando_resposta"=>"há uma permissão ou pergunta esperando resposta",
        "erro_sessao_trabalhando"=>"a sessão está trabalhando — espere ela terminar",
        "erro_fila_pendente"=>"há mensagens na fila esperando entrega",
        _=>return None,
    })
}
fn busy(code:&'static str) -> RuntimeError { RuntimeError::new(code,busy_message(code).unwrap_or_default()) }

const EFFORTS:[&str;5] = ["low","medium","high","xhigh","max"];
/// Quanto a árvore do processo antigo tem para sair antes de a conversa ganhar outro dono.
const EXIT_WAIT:Duration = Duration::from_secs(15);
/// `--resume` de conversa longa demora a mostrar o prompt.
const TERMINAL_WAIT:Duration = Duration::from_secs(60);
const HEADLESS_WAIT:Duration = Duration::from_secs(10);
/// A vida nova que falhou e não saiu: nada volta por cima dela.
const NEW_ALIVE:&str = "reopen_new_alive";

/// Onde o encerramento da vida antiga parou: antes do processo sair (nada mudou), com ele vivo depois
/// de pedido o fim (não se reabre por cima), ou depois de ele sair (a sessão volta pelo spec antigo).
enum Stop { Before(RuntimeError), Alive(RuntimeError), After(RuntimeError) }

/// A vida que roda agora.
enum Life {
    Terminal { target:TerminalTarget },
    /// Sem terminal: o sidecar e, aberta aqui, a geração da entrada.
    Headless { meta:Value, open:bool },
    /// Com terminal e sem conversa provada (aberto sem id): só o pane, sem entrada aqui.
    Bare { pane_pid:i64 },
}

/// A sessão Claude como está: o spec dela (gravado ⊕ observado), a conversa, a chave, a geração da fila
/// e a base fora do plano.
struct Current { spec:SessionSpec, sid:String, generation:u64, life:Life, previous_non_plan:Option<String>, settings:Option<Value> }

/// O que a vida nova precisa, montado antes de encerrar a antiga.
enum Start { Terminal(Box<PaneSpec>,TerminalEnv), Headless(Value) }

/// O que a reabertura devolve: o spec da vida que ficou de pé (`None` sem mudança).
#[derive(Debug)]
pub struct Reopened { pub spec:Option<SessionSpec>, pub changed:bool }

/// Recusa (`stopped: false`: nada mudou) ou falha depois de encerrar a vida antiga (a mensagem diz onde a
/// sessão ficou).
#[derive(Debug)]
pub struct ReopenFailure { pub error:RuntimeError, pub stopped:bool, pub landed:Option<Surface> }
impl ReopenFailure {
    fn refused(error:RuntimeError) -> Self { Self { error,stopped:false,landed:None } }
    /// A vida antiga saiu e a sessão terminou em `landed` (`None`: sem processo).
    pub fn ended_without_terminal(&self,from_terminal:bool) -> bool { self.stopped && from_terminal && self.landed==Some(Surface::Headless) }
}

/// O que uma troca faz entre encerrar a vida antiga e dar a partida na nova (mover a conversa de conta):
/// `check` antes de qualquer efeito, `apply` com o processo antigo já fora, `undo` se a vida nova falhar.
pub trait Between: Send + Sync {
    /// O que a mudança tira do spec além do que ela mesma diz (sair do motor zera o modelo dele).
    fn adjust(&self,_next:&mut SessionSpec) {}
    fn check<'a>(&'a self,from:&'a SessionSpec,to:&'a SessionSpec,sid:&'a str) -> futures_util::future::BoxFuture<'a,Result<(),RuntimeError>>;
    fn apply<'a>(&'a self,from:&'a SessionSpec,to:&'a SessionSpec,sid:&'a str) -> futures_util::future::BoxFuture<'a,Result<(),RuntimeError>>;
    fn undo<'a>(&'a self,from:&'a SessionSpec,to:&'a SessionSpec,sid:&'a str) -> futures_util::future::BoxFuture<'a,Result<(),RuntimeError>>;
}

fn valid_spec_key(key:&str) -> bool { key.len()==32 && key.bytes().all(|b|b.is_ascii_hexdigit()) }

/// Árvore do processo com o nascimento de cada um: some quando todos saíram (ou foram reaproveitados).
fn tree(root:i64) -> Result<Vec<(i64,f64)>,RuntimeError> {
    let procs=SystemProcs::default();
    let children=procs.children(Duration::ZERO).map_err(|_|refused("lifecycle_process_read","os processos da máquina não puderam ser lidos"))?;
    Ok(crate::list::discover::descendants(root,&children).into_iter().filter_map(|pid|procs.start_time(pid).map(|birth|(pid,birth))).collect())
}

async fn wait_gone(lives:Vec<(i64,f64)>,limit:Duration) -> Result<(),RuntimeError> {
    let deadline=tokio::time::Instant::now()+limit;
    loop {
        let alive:Vec<(i64,f64)>={let pending=lives.clone();tokio::task::spawn_blocking(move||{
            let procs=SystemProcs::default();
            pending.into_iter().filter(|(pid,birth)|!super::lifecycle::process_absent(&procs,*pid,*birth).unwrap_or(false)).collect()
        }).await.unwrap_or_else(|_|lives.clone())};
        if alive.is_empty() {return Ok(());}
        if tokio::time::Instant::now()>=deadline {
            return Err(refused("reopen_process_alive","o processo antigo não saiu; para não haver dois Claude na mesma conversa, a sessão não reabriu"));
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

/// Quanto as sobras mortas à força têm para sumir.
const FORCED_WAIT:Duration = Duration::from_secs(3);

/// Espera a árvore sair; quem passa do prazo e ainda é o mesmo processo é morto à força (SIGKILL; no
/// Windows um `taskkill /F` só, sem `/T`: pid reaproveitado levaria árvore alheia) e ganha mais 3 s.
async fn stop_tree(lives:Vec<(i64,f64)>) -> Result<(),RuntimeError> {
    // No Windows o `claude` não trata o pedido de saída: esperar o prazo inteiro só atrasa.
    let wait=if cfg!(windows) {Duration::from_millis(1500)} else {EXIT_WAIT};
    if wait_gone(lives.clone(),wait).await.is_ok() {return Ok(());}
    let left=tokio::task::spawn_blocking(move||{
        let procs=SystemProcs::default();
        let left:Vec<(i64,f64)>=lives.into_iter().filter(|(pid,birth)|!super::lifecycle::process_absent(&procs,*pid,*birth).unwrap_or(false)).collect();
        force_kill(&left);
        left
    }).await.map_err(|_|refused("reopen_process_alive","o processo antigo não pôde ser encerrado à força"))?;
    tracing::warn!(pids=?left.iter().map(|(pid,_)|*pid).collect::<Vec<_>>(),"processo antigo não saiu no prazo; morto à força");
    wait_gone(left,FORCED_WAIT).await
}

#[cfg(unix)]
fn force_kill(left:&[(i64,f64)]) {
    for (pid,_) in left {
        // SAFETY: sinal a um pid conferido pela identidade logo antes.
        if let Ok(pid)=i32::try_from(*pid) {unsafe {libc::kill(pid,libc::SIGKILL);}}
    }
}

#[cfg(windows)]
fn force_kill(left:&[(i64,f64)]) {
    if left.is_empty() {return;}
    let system=std::env::var_os("SystemRoot").map(|root|PathBuf::from(root).join("System32").join("taskkill.exe")).filter(|path|path.is_file());
    let mut command=std::process::Command::new(system.unwrap_or_else(||PathBuf::from("taskkill")));
    command.arg("/F");
    for (pid,_) in left {command.args(["/PID",&pid.to_string()]);}
    let ran=command.stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).status();
    if ran.is_err() {tracing::warn!(code="reopen_taskkill_missing","taskkill não rodou; as sobras do processo antigo ficaram");}
}

/// A política que a CLI aplica ao bypass (`permissions.disableBypassPermissionsMode`), lida antes de
/// encerrar a vida antiga: a conta, o projeto, a gerenciada da máquina e as escolhas da sessão. Arquivo
/// ilegível recusa (CRA-066).
fn bypass_policy(config:&std::path::Path,cwd:&std::path::Path,settings:Option<&Value>,env:&std::collections::BTreeMap<String,String>) -> Result<(),RuntimeError> {
    let forbids=|value:&Value|value["permissions"]["disableBypassPermissionsMode"]=="disable";
    let mut paths=vec![config.join("settings.json"),cwd.join(".claude/settings.json"),cwd.join(".claude/settings.local.json")];
    if cfg!(target_os="linux") {paths.push(PathBuf::from("/etc/claude-code/managed-settings.json"));}
    if cfg!(target_os="macos") {paths.push(PathBuf::from("/Library/Application Support/ClaudeCode/managed-settings.json"));}
    if cfg!(windows) {
        let program_files=env.get("ProgramFiles").ok_or_else(||refused("relaunch_policy_source","a pasta de programas do Windows não é conhecida"))?;
        paths.push(PathBuf::from(program_files).join("ClaudeCode/managed-settings.json"));
    }
    for path in paths {
        let bytes=match std::fs::read(&path) {Ok(bytes)=>bytes,Err(error) if error.kind()==std::io::ErrorKind::NotFound=>continue,
            Err(_)=>return Err(refused("relaunch_policy_read","a política de permissões não pôde ser lida; nada foi reaberto"))};
        let value:Value=serde_json::from_slice(&bytes).map_err(|_|refused("relaunch_policy_read","a política de permissões não pôde ser lida; nada foi reaberto"))?;
        if forbids(&value) {return Err(refused("relaunch_policy_forbids_bypass","a política de permissões desta máquina ou conta proíbe o bypass"));}
    }
    if settings.is_some_and(forbids) {return Err(refused("relaunch_policy_forbids_bypass","as escolhas desta sessão proíbem o bypass"));}
    Ok(())
}

/// A identidade que a CLI lê do ambiente: a pasta da conta, o motor, a conta fixa e o Fast.
fn identity(env:&crate::accounts::environment::AccountEnvironment,spec:&SessionSpec)
    -> (PathBuf,Option<String>,Option<String>,Option<crate::session_open::ServiceTier>) {
    let config=spec.account.config_dir().map_or_else(||env.claude_base.clone(),PathBuf::from);
    let config=std::fs::canonicalize(&config).unwrap_or(config);
    match &spec.account {
        Account::Engine { name,account,.. }=>(config,Some(name.clone()),account.clone(),spec.service_tier),
        _=>(config,None,None,None),
    }
}

/// `default_model.anthropic`: alias, id da Anthropic (Bedrock e Vertex incluídos) ou ARN do Bedrock.
static ANTHROPIC:std::sync::LazyLock<regex::Regex>=std::sync::LazyLock::new(||regex::Regex::new(
    r"(?i)\A(?:(?:[a-z]{2,}\.)?(?:anthropic\.)?claude-[\w.:@-]+|arn:aws[\w-]*:bedrock:\S+|default|best|opus|opusplan|sonnet|haiku|fable)(?:\[1m\])?\z").unwrap());

/// O que a vida nova leva e a CLI recusaria, conferido antes de encerrar a antiga (o `_comando_terminal` e o
/// `para_headless` do Python): o motor que sumiu, o modelo malformado ou de outro provedor, o Fast sem
/// suporte e o corpo do motor ilegível. Bloqueante.
fn preflight(env:&crate::accounts::environment::AccountEnvironment,next:&mut SessionSpec,settings:Option<&Value>,
             runtime:tokio::runtime::Handle) -> Result<(),RuntimeError> {
    use crate::session_open::OpenFacts;
    let facts=crate::session_open::facts::LocalFacts::new(env.clone(),runtime);
    if let Account::Engine { name,account,config_dir,.. }=&next.account && !facts.engines().contains(name) {
        if account.is_some() {return Err(refused("reopen_engine_missing","motor da conta ChatGPT fixa indisponível; nada foi reaberto"));}
        // A escolha lida é do motor: numa conta Anthropic ela criaria uma sessão inviável.
        tracing::warn!(session=%next.name,engine=%name,"motor sumiu do catálogo; a sessão volta na conta Anthropic");
        next.account=config_dir.clone().map_or(Account::Default,|config_dir|Account::Claude { config_dir });
        (next.model,next.effort,next.service_tier)=(None,None,None);
    }
    if let Some(model)=next.model.as_deref() && !crate::session_open::resolve::valid_model(model) {
        return Err(refused("reopen_model_invalid","model: use letras, números e . _ : / - ~ [ ] (até 128 caracteres, sem começar com -)"));
    }
    let engine=match &next.account {Account::Engine { name,.. }=>Some(name.clone()),_=>None};
    if engine.is_none() && next.model.as_deref().is_some_and(|model|!ANTHROPIC.is_match(model.trim())) {
        tracing::warn!(session=%next.name,"modelo que não é da Anthropic; a sessão volta no padrão da conta");
        next.model=None;
    }
    if let Some(tier)=next.service_tier && !facts.supports_fast(engine.as_deref(),next.model.as_deref()) {
        if tier==crate::session_open::ServiceTier::Priority {
            return Err(refused("launch_service_tier","service_tier exige Claude com motor GPT no CLIProxyAPI local"));
        }
        next.service_tier=None;
    }
    if next.service_tier.is_some() {engine_body(env,next.account.config_dir(),std::path::Path::new(&next.cwd),settings)?;}
    Ok(())
}

/// O pré-voo do `engines.service_tier_settings`: o `CLAUDE_CODE_EXTRA_BODY` que o lançador do motor vai
/// ler (ambiente do servidor, escolhas da conta, do projeto e locais, e as da sessão) tem de ser um objeto.
fn engine_body(env:&crate::accounts::environment::AccountEnvironment,config_dir:Option<&str>,cwd:&std::path::Path,explicit:Option<&Value>) -> Result<(),RuntimeError> {
    let bad=|what:&str|refused("reopen_engine_body",&format!("{what}; nada foi reaberto"));
    let read=|path:&std::path::Path|->Result<Value,RuntimeError> {
        let value=match std::fs::read(path) {
            Err(error) if error.kind()==std::io::ErrorKind::NotFound=>return Ok(json!({})),
            Err(_)=>return Err(bad("settings: arquivo ilegível ou JSON inválido")),
            Ok(raw)=>serde_json::from_slice::<Value>(&raw).map_err(|_|bad("settings: arquivo ilegível ou JSON inválido"))?,
        };
        if !value.is_object() || value.get("env").is_some_and(|e|!e.is_object()) {return Err(bad("settings: esperado um objeto JSON com env como objeto"));}
        Ok(value)
    };
    let cwd=&std::fs::canonicalize(cwd).unwrap_or_else(|_|cwd.to_owned());
    let project=cwd.join(".claude");
    let mut paths=vec![config_dir.map_or_else(||env.claude_base.clone(),PathBuf::from).join("settings.json"),project.join("settings.json"),project.join("settings.local.json")];
    let root=local_settings_root(cwd,&env.home);
    if &root!=cwd {paths.push(root.join(".claude").join("settings.local.json"));}
    let mut extra=Value::from(env.base.get("CLAUDE_CODE_EXTRA_BODY").map_or("{}",String::as_str));
    for path in paths { if let Some(value)=read(&path)?["env"].get("CLAUDE_CODE_EXTRA_BODY") {extra=value.clone();} }
    if let Some(value)=explicit.and_then(|e|e["env"].get("CLAUDE_CODE_EXTRA_BODY")) {extra=value.clone();}
    let Value::String(text)=extra else {return Err(bad("CLAUDE_CODE_EXTRA_BODY: esperado texto JSON"))};
    match serde_json::from_str::<Value>(&text) {
        Ok(Value::Object(_))=>Ok(()),
        Ok(_)=>Err(bad("CLAUDE_CODE_EXTRA_BODY: esperado um objeto JSON")),
        Err(_)=>Err(bad("CLAUDE_CODE_EXTRA_BODY: JSON inválido")),
    }
}

/// `_local_settings_root`: o Claude lê o `settings.local.json` da raiz Git no POSIX, só com a raiz do usuário.
fn local_settings_root(cwd:&std::path::Path,home:&std::path::Path) -> PathBuf {
    #[cfg(unix)] {
        use std::os::unix::fs::MetadataExt;
        // SAFETY: geteuid lê a identidade do processo.
        let uid=unsafe {libc::geteuid()};
        let home=std::fs::canonicalize(home).unwrap_or_else(|_|home.to_owned());
        for root in cwd.ancestors() {
            if !root.join(".git").exists() {continue;}
            if root==home {return cwd.to_owned();}
            let mut entries=vec![root.to_owned(),root.join(".git")];
            if root.join(".claude").exists() {entries.push(root.join(".claude"));}
            let owned=entries.iter().all(|path|std::fs::metadata(path).is_ok_and(|m|m.uid()==uid));
            return if owned {root.to_owned()} else {cwd.to_owned()};
        }
    }
    #[cfg(not(unix))] let _=home;
    cwd.to_owned()
}

/// Spec de um Claude com terminal aberto antes do registro, lido do processo vivo: o que o `para_headless`
/// do Python lia do `/proc`. Só para essas sessões; a reabertura grava o spec dali em diante.
fn legacy_terminal_spec(target:&TerminalTarget,name:&str,cwd:String) -> Result<(SessionSpec,Option<Value>),RuntimeError> {
    let mut spec=process_spec(i64::from(target.metadata.agent_pid),&target.key,name,cwd,target.created)?;
    spec.0.conversation=Some(target.binding.conversation.clone());
    Ok(spec)
}

/// O spec do Claude que roda no processo `pid`: conta, motor, modelo, esforço, modo, Fast, Jev e só leitura.
pub(super) fn process_spec(pid:i64,key:&str,name:&str,cwd:String,created:f64) -> Result<(SessionSpec,Option<Value>),RuntimeError> {
    spec_of(&SystemProcs::default(),pid,key,name,cwd,created)
}

fn spec_of(procs:&dyn ProcessView,pid:i64,key:&str,name:&str,cwd:String,created:f64) -> Result<(SessionSpec,Option<Value>),RuntimeError> {
    // Ambiente ilegível não diz se a sessão roda protegida (só leitura) nem em que conta.
    procs.env_var(pid,"HANGAR_ORQ_READ_ONLY").map_err(|_|refused("lifecycle_process_read","o ambiente do Claude não pôde ser lido; nada foi encerrado"))?;
    let env=|var:&str|procs.env_var(pid,var).ok().flatten().map(|v|v.to_string_lossy().into_owned()).filter(|v|!v.is_empty());
    let argv=procs.argv_checked(pid).map_err(|_|refused("lifecycle_process_read","o processo do Claude não pôde ser lido"))?;
    let flag=|name:&str|argv.windows(2).find(|w|w[0]==name).map(|w|w[1].clone())
        .or_else(||argv.iter().find_map(|a|a.strip_prefix(&format!("{name}=")).map(str::to_owned)));
    let config_dir=env("CLAUDE_CONFIG_DIR");
    let account=match env("CP_ENGINE") {
        Some(engine)=>Account::Engine { name:engine,account:env("CP_ENGINE_ACCOUNT"),config_dir,
            context_window:env("CLAUDE_CODE_MAX_CONTEXT_TOKENS").and_then(|v|v.parse().ok()),context_window_unknown:false },
        None=>config_dir.map_or(Account::Default,|config_dir|Account::Claude { config_dir }),
    };
    let engine=matches!(account,Account::Engine{..});
    let settings=env("HANGAR_CLAUDE_SETTINGS").and_then(|raw|serde_json::from_str::<Value>(&raw).ok()).filter(|v|v.as_object().is_some_and(|o|!o.is_empty()));
    let tier=env("CP_ENGINE_SERVICE_TIER").and_then(|t|serde_json::from_value(Value::from(t)).ok());
    let spec=SessionSpec { version:crate::session_open::SPEC_VERSION,key:key.into(),name:name.into(),cwd,
        provider:crate::session_open::AgentProvider::Claude,surface:Surface::Terminal,account,account_source:crate::session_open::AccountSource::Explicit,
        model:flag("--model"),effort:flag("--effort"),service_tier:tier,
        permission_mode:flag("--permission-mode").as_deref().and_then(PermissionMode::claude),
        subagent_model:if engine {None} else {env("CLAUDE_CODE_SUBAGENT_MODEL")},customizations:None,
        jev:env("HANGAR_JEV").as_deref()==Some("on"),read_only:env("HANGAR_ORQ_READ_ONLY").as_deref()==Some("1"),
        worktree:None,creator:None,created_at:created,conversation:None };
    Ok((spec,settings))
}

impl RuntimeRegistry {
    fn claude_sidecars(&self) -> PathBuf { self.codex_environment().home.join(".hangar").join("claude-headless") }

    async fn claude_sidecar(&self,name:&str) -> Result<Option<Value>,RuntimeError> {
        let path=super::codex_sidecar::path(&self.claude_sidecars(),name);
        match tokio::task::spawn_blocking(move||super::codex_sidecar::read(&path)).await {
            Ok(Ok(meta))=>Ok(meta.map(Value::Object)),
            _=>Err(refused("claude_sidecar_read","o arquivo da sessão sem terminal não pôde ser lido")),
        }
    }

    /// O spec que a sessão Claude `name` roda agora (gravado ⊕ observado), sem conferir se está parada.
    /// `None` = não é sessão Claude daqui.
    pub async fn claude_spec(&self,name:&str) -> Option<Result<SessionSpec,RuntimeError>> {
        match self.claude_sidecar(name).await {
            Err(error)=>return Some(Err(error)),
            Ok(Some(_))=>{},
            Ok(None)=>if let Err(error)=self.watcher_ref()?.adopt_claude(self,name).await? {return Some(Err(error));},
        }
        Some(self.claude_current(name,false,false).await.map(|current|current.spec))
    }

    /// O modo que o Rust confirmou por último na conversa (memória dele, sem leitura do rodapé).
    pub fn observed_claude_mode(&self,conversation:&str) -> Option<String> { self.permission_view(conversation).map(|view|view.current) }

    /// O modelo que a sessão Claude `name` usa agora (a vista sem terminal ou a linha de status do terminal);
    /// `None` = o do spec, sem nada mais novo.
    pub async fn claude_model_in_use(&self,name:&str) -> Option<String> {
        if let Some((_,view))=self.claude_headless_view(name).await {return view["model"].as_str().filter(|m|!m.is_empty()).map(str::to_owned);}
        let (target,_)=self.claude_terminal_entry(name).await?;
        super::lifecycle::terminal_choices(&target).ok().flatten()?.model.filter(|m|!m.is_empty())
    }

    /// A sessão Claude `name` está sem terminal (tem sidecar)? `None` com o sidecar ilegível.
    pub async fn claude_headless(&self,name:&str) -> Option<bool> { self.claude_sidecar(name).await.ok().map(|meta|meta.is_some()) }

    /// Reabre a sessão Claude `name` com a mudança. `None` = não é sessão Claude daqui (nem sidecar nem pane
    /// com uma conversa Claude), e a rota segue o caminho de sempre. Troca de modo para o modo em que a
    /// sessão já está não toca em nada (`changed: false`).
    pub async fn reopen_claude_session(&self,name:&str,change:SessionChange,between:Option<&dyn Between>) -> Option<Result<Reopened,ReopenFailure>> {
        let surface=match self.claude_sidecar(name).await {
            Err(error)=>return Some(Err(ReopenFailure::refused(error))),
            Ok(Some(_))=>Surface::Headless,
            Ok(None)=>{
                let watcher=self.watcher_ref()?;
                if let Err(error)=watcher.adopt_claude(self,name).await? {return Some(Err(ReopenFailure::refused(error)));}
                Surface::Terminal
            },
        };
        if change.reason==crate::session_open::ChangeReason::ModeSwitch && change.surface==Some(surface) {
            return Some(Ok(Reopened { spec:None,changed:false }));
        }
        Some(self.reopen_by_spec(name,change,between,None).await)
    }

    /// `/resume`: a sessão Claude `name` volta na conversa `sid`, que já existe, pelo mesmo caminho das outras
    /// reaberturas (S-22): a vida nova é montada antes, a antiga sai inteira antes de a nova subir (S-17) e a
    /// falha volta pelo spec de antes (S-16). O pane sem conversa provada também. `None` = não é Claude daqui.
    pub async fn resume_claude_session(&self,name:&str,sid:&str) -> Option<Result<Reopened,ReopenFailure>> {
        if let Err(error)=self.claude_resume_spec(name).await? {return Some(Err(ReopenFailure::refused(error)));}
        let change=SessionChange { reason:crate::session_open::ChangeReason::Resume,surface:None,account:None,permission_mode:None,
            model:None,effort:None,service_tier:None };
        Some(self.reopen_by_spec(name,change,None,Some(sid)).await)
    }

    /// O spec da sessão Claude `name` para retomar outra conversa: sem terminal, adotada ou com o pane sem
    /// conversa provada (o caso do `/resume`). `None` = não é Claude daqui.
    pub async fn claude_resume_spec(&self,name:&str) -> Option<Result<SessionSpec,RuntimeError>> {
        match self.claude_sidecar(name).await {
            Err(error)=>return Some(Err(error)),
            Ok(Some(_))=>return Some(self.claude_current(name,false,false).await.map(|current|current.spec)),
            Ok(None)=>{},
        }
        let watcher=self.watcher_ref()?;
        match watcher.adopt_claude(self,name).await {
            Some(Ok(()))=>Some(self.claude_current(name,false,false).await.map(|current|current.spec)),
            // Sem conversa provada é o caso do `/resume`: a sessão aberta sem id.
            Some(Err(error)) if error.code!="claude_terminal_conversation_unproved"=>Some(Err(error)),
            _=>match watcher.bare_claude(name).await {
                Ok(Some(_))=>Some(self.bare_current(name).await.map(|current|current.spec)),
                Ok(None)=>None,
                Err(error)=>Some(Err(error)),
            },
        }
    }

    async fn reopen_by_spec(&self,name:&str,change:SessionChange,between:Option<&dyn Between>,resume:Option<&str>) -> Result<Reopened,ReopenFailure> {
        let transfer=|| {
            let open=super::codex_relaunch::transfer_open(&self.codex_environment().home,name,None,None);
            if open {Err(ReopenFailure::refused(RuntimeError::new("session_transfer_busy","a sessão está trocando de agente")))} else {Ok(())}
        };
        transfer()?;
        let _ingress=super::lifecycle::ClosedIngress::acquire_unless_transfer(self.ingress(),name).await.map_err(ReopenFailure::refused)?;
        // A transferência que começou enquanto esta esperava a porta.
        transfer()?;
        // Conferido de novo sob a porta: outra troca pode ter terminado enquanto esta esperava.
        let now=match self.claude_sidecar(name).await.map_err(ReopenFailure::refused)? {Some(_)=>Surface::Headless,None=>Surface::Terminal};
        if change.reason==crate::session_open::ChangeReason::ModeSwitch && change.surface==Some(now) {
            return Ok(Reopened { spec:None,changed:false });
        }
        let mut current=self.claude_current(name,true,resume.is_some()).await.map_err(ReopenFailure::refused)?;
        // Outra conversa leva as escolhas de plugins e skills guardadas dela, não as do processo de agora.
        if let Some(sid)=resume.filter(|sid|*sid!=current.sid) {
            let (home,sid)=(self.codex_environment().home,sid.to_owned());
            current.settings=tokio::task::spawn_blocking(move||crate::claude_customizations::stored(&home,&sid)).await
                .map_err(|_|ReopenFailure::refused(refused("claude_customizations_read_failed","as escolhas da conversa não puderam ser lidas")))?
                .map_err(|(code,detail)|ReopenFailure::refused(refused(code,detail)))?;
        }
        let sid=resume.unwrap_or(&current.sid).to_owned();
        let mut next=current.spec.with(&change);
        next.conversation=Some(sid.clone());
        if let Some(between)=between {between.adjust(&mut next);}
        {let (env,mut spec,settings,handle)=(self.codex_environment(),next,current.settings.clone(),tokio::runtime::Handle::current());
            next=tokio::task::spawn_blocking(move||preflight(&env,&mut spec,settings.as_ref(),handle).map(|()|spec)).await
                .map_err(|_|ReopenFailure::refused(refused("reopen_preflight","a subida nova não pôde ser conferida")))?.map_err(ReopenFailure::refused)?;}
        if let Some(between)=between {between.check(&current.spec,&next,&current.sid).await.map_err(ReopenFailure::refused)?;}
        let start=self.prepare_start(name,&next,&current,&sid).await.map_err(ReopenFailure::refused)?;
        match self.stop_claude(name,&current,next.surface).await {
            Ok(())=>{},
            Err(Stop::Before(error))=>return Err(ReopenFailure::refused(error)),
            // O processo antigo que não saiu não é reaberto por cima: seriam dois Claude na mesma conversa.
            Err(Stop::Alive(error))=>{
                super::actor::mark_live_error(&self.live_channel(name),&error.code,&error.message);
                return Err(ReopenFailure { error,stopped:true,landed:None });
            },
            Err(Stop::After(error))=>return Err(self.restore_claude(name,&current,error).await),
        }
        if let Some(between)=between && let Err(error)=between.apply(&current.spec,&next,&current.sid).await {
            return Err(self.restore_claude(name,&current,error).await);
        }
        match self.start_claude(name,&next,start,&sid).await {
            Ok(())=>{
                if valid_spec_key(&next.key) && let Err(error)=crate::session_open::record::write(&self.codex_environment().home,&next) {
                    // A sessão nova está de pé: o registro velho só deixa a próxima reabertura sem esta mudança.
                    tracing::warn!(session=%name,kind=?error.kind(),"spec da reabertura não gravado");
                }
                Ok(Reopened { spec:Some(next),changed:true })
            },
            // A vida nova que não saiu não divide a conversa com a de antes restaurada.
            Err(error) if error.code==NEW_ALIVE=>{
                super::actor::mark_live_error(&self.live_channel(name),&error.code,&error.message);
                Err(ReopenFailure { error,stopped:true,landed:None })
            },
            Err(error)=>{
                // A conversa que não voltou para a conta de antes não é reaberta lá: seria outra conversa.
                if let Some(between)=between && let Err(undo)=between.undo(&current.spec,&next,&current.sid).await {
                    let error=RuntimeError::new(&error.code,&format!("{}; {}",error.message,undo.message));
                    super::actor::mark_live_error(&self.live_channel(name),&error.code,&error.message);
                    return Err(ReopenFailure { error,stopped:true,landed:None });
                }
                Err(self.restore_claude(name,&current,error).await)
            },
        }
    }

    /// A sessão, o spec dela e se ela está parada. Ocupada recusa com o motivo, antes de qualquer efeito.
    async fn claude_current(&self,name:&str,checks:bool,bare:bool) -> Result<Current,RuntimeError> {
        let env=self.codex_environment();
        if let Some(meta)=self.claude_sidecar(name).await? {
            let mut spec=crate::session_open::record::claude_live(&env.home,&meta,name).map_err(|e|refused("launch_meta",&format!("registro da sessão ilegível: {e}")))?;
            let sid=meta["session_id"].as_str().filter(|s|!s.is_empty()).ok_or_else(||refused("lifecycle_conversation","sessão sem conversa"))?.to_owned();
            let open=self.claude_headless_view(name).await;
            let (generation,view)=match open {
                Some((generation,view))=>(generation,Some(view)),
                None=>(self.queue_generation(&spec.key).await?,None),
            };
            if let Some(view)=&view {
                if checks && view["alive"]==true && view["initialized"]!=true {return Err(busy("erro_sessao_iniciando"));}
                if checks && (!view["question"].is_null() || view["pending"].as_array().is_some_and(|p|!p.is_empty())) {return Err(busy("erro_sessao_esperando_resposta"));}
                if checks && view["in_progress"]==true {return Err(busy("erro_sessao_trabalhando"));}
                // O modo e as escolhas que a CLI mudou sozinha valem (S-02); com motor, o do sidecar.
                if let Some(mode)=view["permission_mode"].as_str().and_then(PermissionMode::claude) {spec.permission_mode=Some(mode);}
                if !matches!(spec.account,Account::Engine{..}) {
                    if let Some(model)=view["model"].as_str().filter(|m|!m.is_empty()) {spec.model=Some(model.into());}
                    if let Some(effort)=view["effort"].as_str().filter(|e|EFFORTS.contains(e)) {spec.effort=Some(effort.into());}
                }
            }
            // Na troca por limite a fila foi segurada para ir com a conversa à conta nova.
            if checks && !self.limit_held(name) && self.queue_pending(&spec.key).await {return Err(busy("erro_fila_pendente"));}
            if spec.permission_mode.is_none() {
                spec.permission_mode=Some(super::claude_launch::account_mode(&env,spec.account.config_dir())?);
            }
            let previous_non_plan=meta["previous_non_plan"].as_str().map(str::to_owned);
            let settings=meta.get("claude_settings").filter(|s|s.as_object().is_some_and(|o|!o.is_empty())).cloned();
            return Ok(Current { spec,sid,generation,life:Life::Headless { meta,open:view.is_some() },previous_non_plan,settings });
        }
        let Some((target,handle))=self.claude_terminal_entry(name).await else {
            if bare {return self.bare_current(name).await;}
            return Err(refused("runtime_binding","a sessão não está aberta aqui"));
        };
        let cwd={let procs=SystemProcs::default();procs.cwd(i64::from(target.metadata.agent_pid)).map(|p|p.to_string_lossy().into_owned())};
        let recorded=if valid_spec_key(&target.key) {
            crate::session_open::record::read(&env.home,&target.key).map_err(|e|refused("session_spec_read",&format!("registro da sessão ilegível: {e}")))?
        } else {None};
        let (mut spec,settings)=match recorded {
            Some(spec)=>{
                let settings=SystemProcs::default().env_var(i64::from(target.metadata.agent_pid),"HANGAR_CLAUDE_SETTINGS").ok().flatten()
                    .and_then(|raw|serde_json::from_str::<Value>(&raw.to_string_lossy()).ok()).filter(|v|v.as_object().is_some_and(|o|!o.is_empty()));
                (spec,settings)
            },
            None=>legacy_terminal_spec(&target,name,cwd.clone().ok_or_else(||refused("lifecycle_process_read","a pasta do Claude não pôde ser lida"))?)?,
        };
        spec.name=name.into();
        spec.surface=Surface::Terminal;
        if !matches!(spec.account,Account::Engine{..}) && let Ok(Some(choices))=super::lifecycle::terminal_choices(&target) {
            if let Some(model)=choices.model.filter(|m|!m.is_empty()) {spec.model=Some(model);}
            // `ultracode` só existe no `/effort` em voo: a linha de comando não o aceita (S-13).
            if let Some(effort)=choices.effort.filter(|e|EFFORTS.contains(&e.as_str())) {spec.effort=Some(effort);}
        }
        let observed=self.permission_view(&target.binding.conversation);
        if let Some(mode)=observed.as_ref().and_then(|view|PermissionMode::claude(&view.current)) {spec.permission_mode=Some(mode);}
        if checks && spec.permission_mode.is_none() {
            return Err(refused("permission_mode_unknown","o modo de permissão da sessão não é conhecido; nada foi reaberto"));
        }
        // Parada, sem pergunta, sem fila e sem entrega incerta: os motivos do `_motivo_ocupada`.
        if checks {handle.control(format!("guard:reopen:{}",crate::mods::state::random_hex(8)),"lifecycle_guard".into(),json!({"queued_ok":self.limit_held(name)})).await?;}
        Ok(Current { sid:target.binding.conversation.clone(),generation:target.generation,previous_non_plan:observed.map(|v|v.previous_non_plan),
            settings,spec,life:Life::Terminal { target } })
    }

    /// O pane Claude sem conversa provada: o spec gravado pela chave dele, senão o lido do processo; o modo
    /// desconhecido é o da conta, que é onde a CLI aberta sem `--permission-mode` estava. A conversa de agora
    /// não existe para a reabertura: a volta, se a nova falhar, é numa conversa nova na mesma sessão.
    async fn bare_current(&self,name:&str) -> Result<Current,RuntimeError> {
        let env=self.codex_environment();
        let watcher=self.watcher_ref().ok_or_else(||refused("runtime_binding","sem a vigia do terminal"))?;
        let bare=watcher.bare_claude(name).await?.ok_or_else(||refused("runtime_binding","a sessão não roda um Claude"))?;
        let recorded=if valid_spec_key(&bare.key) {
            crate::session_open::record::read(&env.home,&bare.key).map_err(|e|refused("session_spec_read",&format!("registro da sessão ilegível: {e}")))?
        } else {None};
        let settings_of=|pid:i64|SystemProcs::default().env_var(pid,"HANGAR_CLAUDE_SETTINGS").ok().flatten()
            .and_then(|raw|serde_json::from_str::<Value>(&raw.to_string_lossy()).ok()).filter(|v|v.as_object().is_some_and(|o|!o.is_empty()));
        let (mut spec,settings)=match recorded {
            Some(spec)=>(spec,settings_of(bare.agent)),
            None=>process_spec(bare.agent,&bare.key,name,bare.cwd.clone(),bare.created)?,
        };
        spec.name=name.into();
        spec.surface=Surface::Terminal;
        if spec.permission_mode.is_none() {spec.permission_mode=Some(super::claude_launch::account_mode(&env,spec.account.config_dir())?);}
        let generation=self.queue_generation(&spec.key).await?;
        let sid=crate::session_open::open::uuid4(&crate::mods::state::random_hex(16));
        Ok(Current { spec,sid,generation,life:Life::Bare { pane_pid:bare.pane_pid },previous_non_plan:None,settings })
    }

    /// O comando da vida nova, com tudo que pode recusar antes de encerrar a antiga.
    async fn prepare_start(&self,name:&str,next:&SessionSpec,current:&Current,sid:&str) -> Result<Start,RuntimeError> {
        let env=self.codex_environment();
        let mode=next.permission_mode.ok_or_else(||refused("permission_mode_unknown","o modo de permissão da sessão não é conhecido; nada foi reaberto"))?;
        if mode==PermissionMode::BypassPermissions {
            let config=next.account.config_dir().map_or_else(||env.claude_base.clone(),PathBuf::from);
            bypass_policy(&config,std::path::Path::new(&next.cwd),current.settings.as_ref(),&env.base)?;
        }
        // A base do plano: a guardada; sem ela, a do transcript da conversa e, por último, o modo da conta.
        let previous_non_plan=if mode==PermissionMode::Plan {
            let remembered=current.previous_non_plan.as_deref().and_then(PermissionMode::claude);
            let transcript=||[&current.spec,next].into_iter().map(|spec|super::claude_launch::transcript(&env,spec,sid)).find_map(|path|
                crate::terminal_facts::transcript_mode(&path,&std::sync::Mutex::new(Default::default())).ok().flatten()
                    .as_deref().and_then(PermissionMode::claude));
            match remembered.or_else(transcript) {
                Some(mode)=>Some(mode),
                None=>Some(super::claude_launch::account_mode(&env,current.spec.account.config_dir())?),
            }
        } else {None};
        let route=match &next.account {
            Account::Engine { name:engine,account:Some(account),.. }=>Some(crate::session_open::facts::fixed_account(
                &crate::accounts::AccountService::new(env.clone()),engine,account).map_err(|e|refused("launch_engine_account",&e.msg))?),
            _=>None,
        };
        if matches!(next.account,Account::Engine{..}) {
            let path:Vec<(String,String)>=env.base.iter().map(|(k,v)|(k.clone(),v.clone())).collect();
            if super::process::resolve_program("hangar-engine",&path).is_none() {
                return Err(refused("launch_engine_missing","hangar-engine não está no PATH deste servidor; sem ele a sessão com motor morre ao nascer"));
            }
        }
        match next.surface {
            Surface::Headless=>{
                if next.read_only {return Err(refused("headless_read_only",super::claude_launch::READ_ONLY_MSG));}
                let mut meta=crate::session_open::open::headless_sidecar(next,sid,previous_non_plan,current.settings.as_ref(),route.as_ref());
                if let Life::Headless { meta:old,.. }=&current.life {
                    // O que só o sidecar guarda (o `created`, o `problema` da conta) segue com a sessão.
                    // O aviso da conta anterior (limite batido, sem login) não vale noutra conta.
                    let fields:&[&str]=if next.account==current.spec.account {&["created","problema"]} else {&["created"]};
                    for field in fields { if let Some(value)=old.get(*field) {meta[*field]=value.clone();} }
                }
                // Confere a subida inteira (conta, motor, modo, Fast) antes de encerrar a vida antiga.
                let (bridge,owned,handle)=(self.policy_plugin_bridge(),name.to_owned(),tokio::runtime::Handle::current());
                let (check,env)=(meta.clone(),env.clone());
                let checked=tokio::task::spawn_blocking(move||super::claude_launch::prepare(&env,bridge.as_ref(),&check,&owned,handle)).await
                    .map_err(|_|refused("relaunch_recipe","a subida nova não pôde ser preparada"))?;
                checked.map(|_|Start::Headless(meta))
            },
            Surface::Terminal=>{
                let read_only=if next.read_only {
                    let run=|argv:Vec<String>,timeout:Duration|->futures_util::future::BoxFuture<'_,crate::session_open::open::ProgramOutput> {
                        let base=env.base.clone();Box::pin(async move {crate::session_open::server::run_program(&base,argv,timeout).await})
                    };
                    Some(crate::session_open::open::read_only_envelope(&env.base,&env.home,&next.cwd,next.account.config_dir(),&run).await
                        .map_err(|e|refused("reopen_read_only",&e.msg))?)
                } else {None};
                let watcher=self.watcher_ref().ok_or_else(||refused("runtime_binding","sem a vigia do terminal"))?;
                let mut terminal={let (home,base)=(env.home.clone(),env.base.clone());tokio::task::spawn_blocking(move||TerminalEnv::local(&home,&base)).await
                    .map_err(|_|refused("reopen_terminal_env","o ambiente do terminal não pôde ser lido"))?};
                terminal.program=watcher.mux_program();
                let runtime=super::codex_launch::runtime_config(&env);
                let roots=crate::session_open::claude::plugin_roots(&env.home);
                let bridge=self.policy_plugin_bridge();
                let key=crate::mods::state::random_hex(16);
                // A troca de conta só leva a conversa depois de encerrar: a de agora diz se ela já existe.
                let resume=super::claude_launch::transcript(&env,next,sid).exists() || super::claude_launch::transcript(&env,&current.spec,sid).exists();
                let ctx=ClaudeContext { plugin_roots:&roots,bridge:bridge.as_ref(),bridge_key:&key,runtime_config:&runtime,server_env:&env.base,
                    settings:current.settings.as_ref(),read_only:read_only.as_deref(),windows:terminal.windows,initial_prompt:None,engine_route:route.as_ref(),
                    resume,allow_bypass:previous_non_plan==Some(PermissionMode::BypassPermissions) };
                Ok(Start::Terminal(Box::new(crate::session_open::claude::pane(next,sid,&ctx)),terminal))
            },
        }
    }

    /// Encerra a vida que roda e confirma a saída da árvore inteira; depois avança a geração da fila.
    async fn stop_claude(&self,name:&str,current:&Current,to:Surface) -> Result<(),Stop> {
        let key=current.spec.key.clone();
        let before=Stop::Before;
        match &current.life {
            Life::Terminal { target }=>{
                let io=crate::terminal_input::ProcessIo::default();
                let pane=super::lifecycle::pane(&io,&target.binding).await.map_err(before)?;
                if pane.copy {return Err(Stop::Before(refused("lifecycle_panel","o terminal está com um painel aberto")));}
                let lives=tree(pane.pid).map_err(before)?;
                let (program,prefix)=target.binding.mux_argv.split_first().ok_or_else(||Stop::Before(refused("lifecycle_mux","sem o multiplexador")))?;
                self.close_claude_entry(&key,current.generation).await.map_err(before)?;
                let session=if target.binding.windows {name.to_owned()} else {format!("={name}")};
                let mut command=crate::terminal_input::child_command(program);
                command.args(prefix).args(["kill-session","-t",&session]).stdin(std::process::Stdio::null()).kill_on_drop(true);
                let killed=tokio::time::timeout(Duration::from_secs(5),command.output()).await.ok().and_then(Result::ok).is_some_and(|o|o.status.success());
                if !killed {return Err(Stop::Before(refused("reopen_kill_mux","o terminal não fechou; a sessão não reabriu")));}
                stop_tree(lives).await.map_err(Stop::Alive)?;
            },
            Life::Bare { pane_pid }=>{
                let lives=tree(*pane_pid).map_err(before)?;
                let watcher=self.watcher_ref().ok_or_else(||Stop::Before(refused("runtime_binding","sem a vigia do terminal")))?;
                let session=if cfg!(windows) {name.to_owned()} else {format!("={name}")};
                if watcher.mux_text(&["kill-session","-t",&session]).await.is_none() {
                    return Err(Stop::Before(refused("reopen_kill_mux","o terminal não fechou; a sessão não reabriu")));
                }
                stop_tree(lives).await.map_err(Stop::Alive)?;
            },
            Life::Headless { meta,open }=>{
                let cano=meta.get("cano").filter(|c|c.is_object()).and_then(|c|serde_json::from_value::<super::process::Cano>(c.clone()).ok());
                let lives=match &cano {Some(cano)=>tree(i64::from(cano.pid)).map_err(before)?,None=>Vec::new()};
                if *open {self.close_claude_entry(&key,current.generation).await.map_err(before)?;}
                if let Some(cano)=cano {
                    // `kill` que falha pode ter sinalizado o grupo: a árvore que sobrou decide.
                    if let Err(error)=super::process::kill(&cano,&key,&self.claude_sidecars()).await {
                        stop_tree(lives).await.map_err(|_|Stop::Alive(RuntimeError::new(error.code(),"o processo antigo não foi encerrado")))?;
                    } else {
                        stop_tree(lives).await.map_err(Stop::Alive)?;
                    }
                }
                // O sidecar sai: nada sobe o processo sem terminal enquanto o pane nasce. Sem terminal de
                // novo, a vida nova grava o dela.
                if to==Surface::Terminal {self.remove_claude_sidecar(name).await.map_err(Stop::After)?;}
            },
        }
        self.advance_generation(name,&key,current.generation).await.map_err(Stop::After)
    }

    /// Dá a partida na vida nova e confirma: o Claude na conversa e no modo pedidos.
    async fn start_claude(&self,name:&str,next:&SessionSpec,start:Start,sid:&str) -> Result<(),RuntimeError> {
        let env=self.codex_environment();
        let mode=next.permission_mode.map(PermissionMode::name).unwrap_or_default();
        match start {
            Start::Terminal(pane,terminal)=>{
                crate::session_open::claude::pretrust(&crate::session_open::claude::claude_json(&terminal,&env.home,next.account.config_dir()),&next.cwd,terminal.windows);
                let watcher=self.watcher_ref().ok_or_else(||refused("runtime_binding","sem a vigia do terminal"))?;
                if let Err(error)=crate::session_open::terminal::spawn(&watcher.spawn_mux(),&terminal,&pane).await {
                    self.drop_failed_terminal(name).await?;
                    return Err(refused("reopen_terminal_spawn",&format!("o terminal não abriu: {}",error.stderr)));
                }
                let deadline=tokio::time::Instant::now()+TERMINAL_WAIT;
                let io=crate::terminal_input::ProcessIo::default();
                loop {
                    if let Some(Ok(()))=watcher.adopt_claude(self,name).await
                        && let Some((target,_))=self.claude_terminal_entry(name).await
                        && target.binding.conversation==sid
                        && super::lifecycle::permission_mode(&io,&target.binding).await.is_ok_and(|shown|shown==mode) {
                        let pid=i64::from(target.metadata.agent_pid);
                        let running=process_spec(pid,&next.key,name,next.cwd.clone(),0.0).map(|(spec,_)|identity(&env,&spec));
                        if running.as_ref().is_ok_and(|running|*running==identity(&env,next)) {return Ok(());}
                        if running.is_ok() {
                            self.drop_failed_terminal(name).await?;
                            return Err(refused("reopen_identity","o Claude reabriu com uma identidade diferente da escolhida (conta, motor ou Fast)"));
                        }
                    }
                    if tokio::time::Instant::now()>=deadline {
                        self.drop_failed_terminal(name).await?;
                        return Err(refused("relaunch_confirmation","o Claude não voltou no terminal na conversa e no modo pedidos"));
                    }
                    tokio::time::sleep(Duration::from_millis(200)).await;
                }
            },
            Start::Headless(meta)=>{
                let dir=self.claude_sidecars();
                {let (dir,owned,meta)=(dir.clone(),name.to_owned(),meta.as_object().cloned().unwrap_or_default());
                    tokio::task::spawn_blocking(move||super::codex_sidecar::put(&dir,&owned,&meta)).await
                        .map_err(|_|refused("lifecycle_sidecar_io","o arquivo da sessão não foi gravado"))?
                        .map_err(|_|refused("lifecycle_sidecar_io","o arquivo da sessão não foi gravado"))?;}
                let opened=self.open_claude_headless(name,true).await.unwrap_or_else(||Err(refused("runtime_binding","a sessão sem terminal sumiu")));
                if let Err(error)=opened {
                    self.drop_failed_headless(name,&next.key).await?;
                    return Err(error);
                }
                let deadline=tokio::time::Instant::now()+HEADLESS_WAIT;
                loop {
                    if let Some((_,view))=self.claude_headless_view(name).await {
                        if view["alive"]==false {break;}
                        if view["initialized"]==true && view["conversation"]==sid {
                            if view["permission_mode"]==mode {return Ok(());}
                            break;
                        }
                    }
                    if tokio::time::Instant::now()>=deadline {break;}
                    tokio::time::sleep(Duration::from_millis(50)).await;
                }
                self.drop_failed_headless(name,&next.key).await?;
                Err(refused("relaunch_initialize","o Claude sem terminal não subiu na conversa e no modo pedidos"))
            },
        }
    }

    /// Falhou depois de encerrar: a sessão volta pelo spec de antes; sem terminal, se nem o terminal de antes
    /// voltar. O erro diz onde ela ficou.
    async fn restore_claude(&self,name:&str,current:&Current,error:RuntimeError) -> ReopenFailure {
        // Só leitura estacionada não roda sem terminal: volta a esperar o terminal protegido, com o arquivo dela.
        if let (true,Life::Headless { meta,.. })=(current.spec.read_only,&current.life) {
            let (dir,owned,meta)=(self.claude_sidecars(),name.to_owned(),meta.as_object().cloned().unwrap_or_default());
            let parked=tokio::task::spawn_blocking(move||super::codex_sidecar::put(&dir,&owned,&meta)).await;
            let message=format!("o terminal protegido não voltou ({}); a sessão read-only ficou parada até reabrir no terminal",error.message);
            if !matches!(parked,Ok(Ok(_))) {
                let message=format!("{message}; o arquivo da sessão não foi regravado");
                super::actor::mark_live_error(&self.live_channel(name),&error.code,&message);
                return ReopenFailure { error:RuntimeError::new("erro_troca_conta_parada",&message),stopped:true,landed:None };
            }
            return ReopenFailure { error:RuntimeError::new("erro_troca_conta_parada",&message),stopped:true,landed:Some(Surface::Headless) };
        }
        let mut tries=vec![current.spec.clone()];
        if current.spec.surface==Surface::Terminal && !current.spec.read_only {
            let mut headless=current.spec.clone();headless.surface=Surface::Headless;tries.push(headless);
        }
        for spec in tries {
            // O sidecar da tentativa sem terminal faria a adoção do pane abrir o processo sem terminal.
            if spec.surface==Surface::Terminal && let Err(error)=self.remove_claude_sidecar(name).await {
                tracing::warn!(session=%name,code=%error.code,"sidecar da tentativa que falhou ficou");
                continue;
            }
            let back=match self.prepare_start(name,&spec,current,&current.sid).await {
                Ok(start)=>self.start_claude(name,&spec,start,&current.sid).await,
                Err(error)=>Err(error),
            };
            match back {
                Ok(())=>{
                    let place=if spec.surface==current.spec.surface {"a sessão voltou como estava"} else {"a sessão seguiu sem terminal"};
                    return ReopenFailure { error:RuntimeError::new(&error.code,&format!("{}; {place}",error.message)),stopped:true,landed:Some(spec.surface) };
                },
                Err(restore)=>tracing::warn!(session=%name,code=%restore.code,"a sessão não voltou pelo spec de antes"),
            }
        }
        let message=format!("{}; a sessão não voltou e ficou sem processo",error.message);
        super::actor::mark_live_error(&self.live_channel(name),&error.code,&message);
        ReopenFailure { error:RuntimeError::new(&error.code,&message),stopped:true,landed:None }
    }

    async fn remove_claude_sidecar(&self,name:&str) -> Result<(),RuntimeError> {
        let (dir,owned)=(self.claude_sidecars(),name.to_owned());
        tokio::task::spawn_blocking(move||super::codex_sidecar::locked(&dir,&owned,|path|match std::fs::remove_file(path) {
            Err(error) if error.kind()!=std::io::ErrorKind::NotFound=>Err(error),_=>Ok(()) }))
            .await.map_err(|_|refused("lifecycle_sidecar_io","o arquivo da sessão não pôde ser apagado"))?
            .map_err(|_|refused("lifecycle_sidecar_io","o arquivo da sessão não pôde ser apagado"))
    }

    /// Fecha o terminal da tentativa que falhou e espera a árvore dele sair; ficou vivo = `NEW_ALIVE`.
    async fn drop_failed_terminal(&self,name:&str) -> Result<(),RuntimeError> {
        if let Some((target,_))=self.claude_terminal_entry(name).await {let _=self.close_claude_entry(&target.key,target.generation).await;}
        let watcher=self.watcher_ref().ok_or_else(||refused(NEW_ALIVE,"sem a vigia do terminal para fechar a tentativa"))?;
        let session=if cfg!(windows) {name.to_owned()} else {format!("={name}")};
        let lives=match watcher.mux_text(&["display-message","-p","-t",&session,"#{pane_pid}"]).await.and_then(|pid|pid.trim().parse::<i64>().ok()) {
            Some(pid)=>tree(pid)?,
            None=>Vec::new(),
        };
        let _=watcher.mux_text(&["kill-session","-t",&session]).await;
        wait_gone(lives,EXIT_WAIT).await.map_err(|_|refused(NEW_ALIVE,"o Claude novo não saiu; a sessão não volta por cima dele para não haver dois na mesma conversa"))
    }

    async fn drop_failed_headless(&self,name:&str,key:&str) -> Result<(),RuntimeError> {
        if let Some((generation,_))=self.claude_headless_view(name).await {let _=self.close_claude_entry(key,generation).await;}
        let Ok(Some(meta))=self.claude_sidecar(name).await else {return Ok(())};
        let Some(cano)=meta.get("cano").filter(|c|c.is_object()).and_then(|c|serde_json::from_value::<super::process::Cano>(c.clone()).ok()) else {return Ok(())};
        let lives=tree(i64::from(cano.pid))?;
        if let Err(error)=super::process::kill(&cano,key,&self.claude_sidecars()).await {
            tracing::warn!(session=%name,code=error.code(),"cano da reabertura que falhou não foi encerrado");
        }
        wait_gone(lives,EXIT_WAIT).await.map_err(|_|refused(NEW_ALIVE,"o Claude novo não saiu; a sessão não volta por cima dele para não haver dois na mesma conversa"))
    }

    /// A geração seguinte na fila: a vida nova não casa com recibos e interações da antiga.
    async fn advance_generation(&self,name:&str,key:&str,generation:u64) -> Result<(),RuntimeError> {
        let queue=self.codex_environment().claude_base.join(".hangar-queue");
        let (state_path,lease_path)=super::codex_terminal::queue_files(&queue,key);
        let (key,name)=(key.to_owned(),name.to_owned());
        tokio::task::spawn_blocking(move||{
            let _lease=super::queue::acquire_lease_within(&lease_path,Duration::from_secs(3)).map_err(|_|refused("queue_lease","a fila da sessão está presa"))?;
            let mut store=super::queue::Store::open(&state_path,&queue,super::queue::State::new(&key,generation,&name,Vec::new())).map_err(|_|refused("queue_io","fila da sessão inacessível"))?;
            if store.state().generation!=generation {return Err(refused("runtime_generation","a vida da sessão mudou durante a reabertura"));}
            let clock=super::protocol::ClockSample {monotonic_s:0.0,epoch_s:std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0.0,|d|d.as_secs_f64())};
            store.exec(generation,&format!("claude-reopen:{}",crate::mods::state::random_hex(8)),clock,
                super::queue::Action::AdvanceLifecycle {generation:generation+1,state:json!({})}).map_err(|_|refused("queue_io","fila da sessão inacessível"))?;
            Ok(())
        }).await.map_err(|_|refused("queue_job","a fila da sessão não respondeu"))?
    }

    async fn queue_generation(&self,key:&str) -> Result<u64,RuntimeError> {
        let (state,_)=super::codex_terminal::queue_files(&self.codex_environment().claude_base.join(".hangar-queue"),key);
        tokio::task::spawn_blocking(move||match super::queue::read_replaced(&state) {
            Err(error) if error.kind()==std::io::ErrorKind::NotFound=>Ok(1),
            Err(_)=>Err(refused("queue_io","fila da sessão inacessível")),
            Ok(raw)=>serde_json::from_slice::<Value>(&raw).ok().and_then(|s|s["generation"].as_u64()).ok_or_else(||refused("queue_io","fila da sessão ilegível")),
        }).await.map_err(|_|refused("queue_job","a fila da sessão não respondeu"))?
    }

    /// Só a linha não entregue segura a troca (`_motivo_ocupada`).
    async fn queue_pending(&self,key:&str) -> bool {
        let (state,_)=super::codex_terminal::queue_files(&self.codex_environment().claude_base.join(".hangar-queue"),key);
        tokio::task::spawn_blocking(move||match super::queue::read_replaced(&state) {
            Err(_)=>false,
            Ok(raw)=>serde_json::from_slice::<Value>(&raw).is_ok_and(|s|s["rows"].as_array().is_some_and(|rows|rows.iter().any(|r|r["delivered"]==false))),
        }).await.unwrap_or(false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::list::procs::ChildrenMap;
    use std::ffi::OsString;
    use std::sync::Arc;

    /// Um Claude cujo argv se lê e o ambiente não (outro dono, `/proc` protegido).
    struct Sealed;
    impl ProcessView for Sealed {
        fn children(&self,_:Duration) -> std::io::Result<Arc<ChildrenMap>> { Ok(Arc::default()) }
        fn argv_checked(&self,_:i64) -> std::io::Result<Vec<String>> { Ok(vec!["claude".into(),"--permission-mode".into(),"manual".into()]) }
        fn cwd(&self,_:i64) -> Option<PathBuf> { None }
        fn env_var(&self,_:i64,_:&str) -> std::io::Result<Option<OsString>> { Err(std::io::ErrorKind::PermissionDenied.into()) }
        fn start_time(&self,_:i64) -> Option<f64> { None }
    }

    /// CRA-012: sem ler o ambiente não se sabe se a sessão roda protegida (só leitura) nem em que conta:
    /// recusa, como o Python, em vez de reabrir fora da proteção.
    #[test]
    fn an_unreadable_environment_refuses_instead_of_guessing_not_read_only() {
        let error=spec_of(&Sealed,7,"k","s1","/w".into(),0.0).unwrap_err();
        assert_eq!(error.code,"lifecycle_process_read");
    }
}
