use super::{actor::{LaunchConfig,PolicyClient,RuntimeActor,RuntimeEngine,RuntimeHandle},cano,process,protocol::*,queue::{Action,QueueActor,State as QueueState,Store,acquire_lease}};
use super::codex_terminal::{Adoption,AdoptionCell,CodexTerminalTarget};
use axum::{Router,body::to_bytes,extract::{ConnectInfo,State,Request},http::StatusCode,
    middleware::{self,Next},response::{IntoResponse,Response,sse::{Event,KeepAlive,Sse}},routing::{get,post}};
use serde::Deserialize;
use serde_json::{Value,json};
use std::collections::BTreeMap;
use std::convert::Infallible;
use std::net::SocketAddr;
use std::sync::Arc;
use std::sync::atomic::AtomicU64;
use std::time::{Duration,SystemTime,UNIX_EPOCH};
use subtle::ConstantTimeEq;
use tokio::sync::{broadcast,Mutex};

/// `Headless`: ator sem terminal (cano). `Terminal`: entrada terminal do Claude. `CodexTerminal`: o mesmo
/// ator do Codex, sobre o WebSocket do app-server adotado, com a TUI no pane.
#[derive(Clone)]
pub(crate) enum EntryHandle {
    Headless(RuntimeHandle),
    Terminal {target:super::terminal::TerminalTarget,handle:super::terminal::TerminalHandle},
    CodexTerminal {target:Box<CodexTerminalTarget>,handle:RuntimeHandle,cell:AdoptionCell},
}
impl EntryHandle {
    pub(crate) async fn snapshot(&self)->Result<Value,RuntimeError> {match self {Self::Headless(h) | Self::CodexTerminal {handle:h,..}=>h.snapshot().await,Self::Terminal {handle,..}=>handle.snapshot().await}}
    /// Só o ator do Codex/sem terminal tem motor próprio; o de terminal do Claude não é sessão Codex.
    pub(crate) async fn view(&self)->Result<Value,RuntimeError> {match self {Self::Headless(h) | Self::CodexTerminal {handle:h,..}=>h.view().await,Self::Terminal {..}=>Err(failure("runtime_terminal"))}}
    pub(crate) async fn stop(&self)->Result<(),RuntimeError> {match self {Self::Headless(h) | Self::CodexTerminal {handle:h,..}=>h.stop().await,Self::Terminal {handle,..}=>handle.stop().await}}
    pub(crate) async fn command(&self,command:RuntimeCommand)->Result<RuntimeReply,RuntimeError> {match self {Self::Headless(h) | Self::CodexTerminal {handle:h,..}=>h.command(command).await,Self::Terminal {handle,..}=>handle.command(command).await}}
    pub(crate) async fn queue(&self,id:String,action:Action)->Result<Value,RuntimeError> {match self {Self::Headless(h) | Self::CodexTerminal {handle:h,..}=>h.queue(id,action).await,Self::Terminal {handle,..}=>handle.queue(id,action).await}}
    pub(crate) async fn drain(&self)->Result<Value,RuntimeError> {match self {Self::Headless(h) | Self::CodexTerminal {handle:h,..}=>h.drain().await,Self::Terminal {handle,..}=>handle.drain().await}}
    pub(crate) async fn confirm(&self)->Result<Value,RuntimeError> {match self {Self::Headless(h) | Self::CodexTerminal {handle:h,..}=>h.confirm().await,Self::Terminal {handle,..}=>handle.confirm().await}}
    pub(crate) async fn ensure_projection(&self)->Result<Value,RuntimeError> {match self {Self::Headless(h) | Self::CodexTerminal {handle:h,..}=>h.ensure_projection().await,Self::Terminal {handle,..}=>handle.ensure_projection().await}}
    /// Pane presente: entrada terminal do Claude ou Codex com TUI.
    pub(crate) fn has_terminal(&self) -> bool { !matches!(self,Self::Headless(_)) }
}
struct Entry { generation:u64,handle:EntryHandle,lease_path:std::path::PathBuf,name:String,mods_life:u64,provider:String,account_key:Option<crate::accounts::AccountKey>,mode_source:crate::terminal_facts::ModeSource,live:LiveSender }

async fn runtime_account_guard(provider: &str, metadata: &Value) -> Result<crate::accounts::AccountGuard, RuntimeError> {
    use crate::accounts::{AccountKey, AccountLocks, GuardMode, Provider};
    let provider = if provider == "codex" { Provider::Codex } else { Provider::Claude };
    let field = if provider == Provider::Codex { "codex_home" } else { "config_dir" };
    let home = metadata[field].as_str().map(std::path::PathBuf::from).or_else(|| {
        std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
            .map(|home| std::path::PathBuf::from(home).join(if provider == Provider::Codex { ".codex" } else { ".claude" }))
    }).ok_or_else(|| failure("account_home_unknown"))?;
    let key = tokio::task::spawn_blocking(move || AccountKey::new(provider, &home)).await
        .map_err(|_| failure("account_lock_worker"))?.map_err(|_| failure("account_key_invalid"))?;
    AccountLocks::system().map_err(|_| failure("account_locks_unavailable"))?
        .acquire(&key, GuardMode::Shared, std::time::Instant::now() + Duration::from_secs(5)).await
        .map_err(|_| failure("account_busy"))
}

/// Entrada aberta de uma sessão, achada por nome, para as rotas de escrita do Rust.
#[allow(dead_code)] // o `handle` é lido pelas rotas de escrita que entram depois
pub struct WriteTarget { pub key:String,pub generation:u64,pub provider:String,pub terminal:bool,pub healthy:bool,pub(crate) handle:EntryHandle }

/// Prazo do fechamento da porta: abaixo do `OP_TIMEOUT_S` (75 s) do transporte no Python.
const INGRESS_CLOSE_WAIT:Duration = Duration::from_secs(60);
pub struct RuntimeRegistry {
    interactions:Option<Arc<crate::interactions::InteractionStore>>,
    entries:Arc<Mutex<BTreeMap<String,Entry>>>,
    terminal_states:Option<Arc<crate::state::published::Published>>,
    terms:Option<Arc<crate::term::Terms>>,
    events:broadcast::Sender<RuntimeEvent>,
    policy:PolicyClient,
    instance:String,
    lifecycle:Mutex<BTreeMap<String,Arc<Mutex<()>>>>,
    revisions:Mutex<BTreeMap<String,Arc<AtomicU64>>>,
    mods:Option<crate::mods::state::Mods>,
    plugin:Option<Arc<crate::plugin::Store>>,
    ingress:super::ingress::IngressGates,
    /// Primeira espera da religação do processo que cai (dobra a cada subida seguida).
    respawn_base:Duration,
    /// Último valor da sessão sem terminal por nome, para o feed do hub (`live`).
    live:std::sync::Mutex<BTreeMap<String,LiveSender>>,
    /// Nome → (chave, geração) do ator do Codex com terminal aberto aqui: o estado deles é do Rust.
    codex_owned:std::sync::Mutex<BTreeMap<String,(String,u64)>>,
    /// Hubs do chat, avisados quando essa posse muda.
    hubs:std::sync::OnceLock<crate::side::WeakHubs>,
}

/// A trava pode demorar a soltar: as tarefas de E/S de um ator que saiu, ou o `LockFileEx` de um
/// Rust que acabou de cair no Windows. Espera até 3 s por ela.
/// Só "trava ocupada" espera; outro erro (pasta sem permissão, disco cheio) responde na hora.
async fn wait_lease(path:&std::path::Path) -> Result<Arc<std::fs::File>,RuntimeError> {
    for attempt in 0..60 {
        if attempt > 0 { tokio::time::sleep(Duration::from_millis(50)).await; }
        let path = path.to_owned();
        match tokio::task::spawn_blocking(move ||acquire_lease(&path)).await.map_err(|_|failure("queue_job"))? {
            Ok(lease)=>return Ok(lease),
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock=>{},
            Err(error)=>return Err(RuntimeError::new("runtime_lease",&format!("trava inacessível: {:?}",error.kind()))),
        }
    }
    Err(RuntimeError::new("runtime_lease","trava da sessão presa por outro dono há 3 s"))
}

/// Abre a fila sob a trava e roda `Recover`: entrada que estava em despacho quando o dono anterior
/// parou vira incerta antes de o ator olhar para ela.
async fn open_store(state_path:&std::path::Path,projection_dir:&std::path::Path,key:&str,generation:u64,name:&str,
    lease:Arc<std::fs::File>) -> Result<Store,RuntimeError> {
    let (state_path,projection_dir) = (state_path.to_owned(),projection_dir.to_owned());
    let initial = QueueState::new(key,generation,name,Vec::new());
    static OPENS:AtomicU64 = AtomicU64::new(0);
    let epoch_s = SystemTime::now().duration_since(UNIX_EPOCH).map(|d|d.as_secs_f64()).unwrap_or(0.0);
    let call_id = format!("open-recover:{}:{}:{}",std::process::id(),epoch_s,OPENS.fetch_add(1,std::sync::atomic::Ordering::Relaxed));
    tokio::task::spawn_blocking(move || {
        let _lease = lease;
        let mut store = Store::open(&state_path,&projection_dir,initial)?;
        if store.state().generation != generation { return Ok(Err(failure("runtime_generation"))); }
        store.exec(generation,&call_id,ClockSample { monotonic_s:0.0,epoch_s },Action::Recover)?;
        store.ensure_projection()?;
        Ok(Ok(store))
    }).await
        .map_err(|_|failure("queue_job"))?.map_err(|error:std::io::Error|{
            // A frase da recusa da fila é fixa e diz por que a abertura falhou; o resto só pelo tipo.
            let reason = super::queue::refusal(&error).map_or_else(||format!("{:?}",error.kind()),str::to_owned);
            RuntimeError::new("queue_io",&format!("fila recusou: {reason}"))
        })?
}

/// Negação do `_rust_failed` do Python (erro vazio não é erro), exceto `terminal_facts`, que aqui é doente.
fn healthy(terminal:bool,view:&Value)->bool {
    let failed = match &view["error"] {Value::Null=>false,Value::String(code)=>!code.is_empty(),_=>true};
    if terminal { !failed || view["error"]=="receipt_scan" } else { !failed && view["view"]["alive"] != false }
}

fn failure(code:&str) -> RuntimeError { RuntimeError::new(code,"runtime indisponível para esta chave ou geração") }

/// Regra 1 do módulo de processo: cano gravado `Ours` conecta (mesmo sem `versao`); morto, de outro
/// programa ou ausente, sobe outro com o ambiente que o Python calcula agora (nunca guardado).
pub(super) async fn launch_if_needed(policy:&PolicyClient,target:&mut RuntimeTarget,sidecar_dir:&std::path::Path) -> Result<Option<process::Cano>,RuntimeError> {
    let recorded = target.binding.pid;
    if recorded != 0 {
        let key = target.key.clone();
        let state = tokio::task::spawn_blocking(move||process::liveness(recorded,&key)).await.map_err(|_|failure("launch_job"))?;
        if state == process::Liveness::Ours { return Ok(None); }
    }
    let env = launch_policy(policy,target,"launch_env",json!({})).await?;
    if let Some(code) = env["error"].as_str() { return Err(RuntimeError::new(code,"o Python não montou o comando da sessão")); }
    let shape = ||failure("launch_env_shape");
    let program:Vec<String> = serde_json::from_value(env["program"].clone()).map_err(|_|shape())?;
    let vars:BTreeMap<String,String> = serde_json::from_value(env["env"].clone()).map_err(|_|shape())?;
    let cano_extra = match &env["cano_extra"] { Value::Null=>Default::default(),Value::Object(extra)=>extra.clone(),_=>return Err(shape()) };
    let cwd = target.metadata["cwd"].as_str().filter(|cwd|!cwd.is_empty()).ok_or_else(||failure("launch_cwd"))?;
    let spec = process::LaunchSpec { provider:process::Provider::from_str(&target.provider).ok_or_else(||failure("runtime_provider"))?,
        key:target.key.clone(),cwd:cwd.into(),program,env:vars.into_iter().collect(),cano_extra,sidecar_dir:sidecar_dir.to_owned() };
    let cano = match process::spawn(&spec).await {
        Ok(cano)=>cano,
        Err(error)=>{
            // O gravado já não serve (morto ou de outro programa): o arquivo da sessão para de apontá-lo.
            if recorded != 0 && matches!(error,process::ProcessError::NotListening) { clear_cano(policy,target,recorded).await; }
            let detail = match &error { process::ProcessError::Spawn(detail)=>detail.as_str(),_=>"o processo da sessão não subiu" };
            return Err(RuntimeError::new(error.code(),detail));
        }
    };
    let value = serde_json::to_value(&cano).map_err(|_|failure("cano_json"))?;
    if let Err(error) = launch_policy(policy,target,"session.patch_meta",json!({"cano":value})).await {
        // Sem o arquivo da sessão apontando para ele, o processo ficaria sem dono.
        if let Err(stop) = process::kill(&cano,&target.key,sidecar_dir).await {
            tracing::warn!(key=%target.key,code=stop.code(),"cano não gravado não foi encerrado");
        }
        return Err(error);
    }
    target.binding = CanoBinding { pid:cano.pid,escuta:cano.escuta.clone(),token:cano.token.clone(),versao:cano.versao };
    target.metadata["cano"] = value;
    Ok(Some(cano))
}
pub(super) async fn launch_policy(policy:&PolicyClient,target:&RuntimeTarget,kind:&str,payload:Value) -> Result<Value,RuntimeError> {
    let phase = format!("launch:{}",crate::mods::state::random_hex(8));
    policy.run_for(&target.key,target.generation,kind,&RequestId::String(phase.clone()),payload,&phase).await
}
async fn clear_cano(policy:&PolicyClient,target:&RuntimeTarget,pid:u32) {
    if let Err(error) = launch_policy(policy,target,"session.clear_cano",json!({"pid":pid})).await {
        tracing::warn!(key=%target.key,code=%error.code,"cano não saiu do arquivo da sessão");
    }
}
/// O cano subido agora e que não deu conexão: morre e sai do arquivo da sessão.
pub(super) async fn discard(policy:&PolicyClient,target:&RuntimeTarget,cano:&process::Cano,sidecar_dir:&std::path::Path) {
    if let Err(stop) = process::kill(cano,&target.key,sidecar_dir).await {
        tracing::warn!(key=%target.key,code=stop.code(),"cano sem conexão não foi encerrado");
        return;
    }
    clear_cano(policy,target,cano.pid).await;
}

/// Prazo da devolução da janela esticada ao abrir a sessão com terminal (`unstretch`).
const UNSTRETCH_MAX:Duration = Duration::from_secs(2);

/// Interface dos mods da sessão com terminal (fase 3): o Rust é o dono do terminal aqui, então é dono do
/// clique e da faixa dela. Liga a sessão ao `Mods` na vida `life` com um elo novo; o processo é a chave
/// durável mais o pane e a criação dele, que o renomear mantém.
async fn attach_terminal_mods(mods:&crate::mods::state::Mods,target:&super::terminal::TerminalTarget,
    handle:&super::terminal::TerminalHandle,life:u64) {
    // Antes de ligar: nenhum pedido de app pode estar esticando a janela enquanto ela é lida.
    crate::mods::click::unstretch(handle,std::time::Instant::now()+UNSTRETCH_MAX).await;
    let link = crate::mods::terminal::TerminalLink::anchored(target.name.clone(),life,Arc::new(handle.clone()),mods.clone(),
        crate::mods::click::Limits::default(),handle.anchor());
    let process = format!("{}:{}:{}",target.key,target.binding.pane,target.binding.created);
    mods.attach_terminal_keyed(&target.name,&process,target.plugin_key.as_deref(),life,link.clone());
    // O vigia sobe depois de ligar: o `attach_terminal` para o vigia do elo que estava no nome, e se fosse
    // este mesmo elo o derrubaria. No psmux não há vigia (o `watch_notices` recusa no Windows): lá o mínimo
    // volta na operação seguinte, no `prepare` do clique. O mínimo vale já na abertura: a janela pode ter
    // ficado pequena com um terminal que se desligou.
    if !target.binding.windows { link.watch(&target.binding.mux_argv); }
    tokio::spawn(async move { link.floor().await; });
}

impl RuntimeRegistry {
    pub fn new(upstream:SocketAddr,secret:String,instance:String) -> Self {
        Self { interactions:None,entries:Arc::new(Mutex::new(BTreeMap::new())),terminal_states:None,terms:None,events:broadcast::channel(1024).0,
            policy:PolicyClient::new(upstream,secret,instance.clone()),instance,lifecycle:Mutex::new(BTreeMap::new()),revisions:Mutex::new(BTreeMap::new()),mods:None,plugin:None,ingress:Default::default(),
            respawn_base:Duration::from_secs(5),live:Default::default(),codex_owned:Default::default(),hubs:std::sync::OnceLock::new() }
    }
    /// Liga os hubs do chat: abrir e fechar o ator do Codex com terminal troca o dono do estado neles.
    pub fn bind_hubs(&self,hubs:crate::side::WeakHubs) { let _ = self.hubs.set(hubs); }
    /// O ator do Codex com terminal desta sessão está aberto aqui: o Rust publica o estado dela.
    pub fn owns_codex_terminal(&self,name:&str) -> bool { self.codex_owned.lock().unwrap_or_else(|e|e.into_inner()).contains_key(name) }
    /// Posse pela entrada (chave e geração), não só pelo nome: fechar uma vida antiga não desmarca a viva de mesmo nome.
    fn mark_codex_owner(&self,name:&str,key:&str,generation:u64,owned:bool) {
        let changed = {
            let mut map = self.codex_owned.lock().unwrap_or_else(|e|e.into_inner());
            let life = (key.to_owned(),generation);
            if owned { map.insert(name.to_owned(),life); true }
            else if map.get(name) == Some(&life) { map.remove(name); true }
            else { false }
        };
        if !changed { return; }
        if let Some(hubs) = self.hubs.get().and_then(crate::side::WeakHubs::upgrade) { hubs.set_runtime_owned(name,owned); }
    }
    pub fn with_interactions(mut self,store:Arc<crate::interactions::InteractionStore>) -> Self { self.interactions = Some(store); self }

    pub async fn interaction_binding(&self,name:&str) -> Result<crate::interactions::InteractionBinding,RuntimeError> {
        use crate::interactions::{InteractionBinding,InteractionError,runtime_error};
        let unavailable = ||runtime_error(InteractionError::Unavailable);
        let (key,generation,handle) = {
            let entries = self.entries.lock().await;
            let mut matches = entries.iter().filter(|(_,entry)|entry.name == name);
            let (key,entry) = matches.next().ok_or_else(unavailable)?;
            if matches.next().is_some() { return Err(unavailable()); }
            if let EntryHandle::Terminal { target,.. } = &entry.handle {
                if target.key != *key || target.generation != entry.generation || target.binding.conversation.is_empty() { return Err(unavailable()); }
                return Ok(InteractionBinding { key:key.clone(),conversation:target.binding.conversation.clone(),generation:entry.generation });
            }
            (key.clone(),entry.generation,entry.handle.clone())
        };
        let snapshot = handle.snapshot().await.map_err(|_|unavailable())?;
        let entries = self.entries.lock().await;
        if entries.iter().any(|(other,entry)|other != &key && entry.name == name) { return Err(unavailable()); }
        let entry = entries.get(&key).filter(|entry|entry.name == name && entry.generation == generation).ok_or_else(unavailable)?;
        if matches!(entry.handle,EntryHandle::Terminal {..}) || snapshot["key"] != key || snapshot["generation"] != generation || !snapshot["error"].is_null() { return Err(unavailable()); }
        let conversation = snapshot["view"]["conversation"].as_str().filter(|s|!s.is_empty()).ok_or_else(unavailable)?;
        Ok(InteractionBinding { key,conversation:conversation.into(),generation })
    }

    pub fn with_respawn_base(mut self,base:Duration) -> Self { self.respawn_base = base; self }
    /// Interface dos mods: sessão Claude sem terminal aberta aqui vira superfície remota e publica no `Mods`.
    pub fn with_mods(mut self,mods:crate::mods::state::Mods) -> Self { self.mods = Some(mods); self }
    pub fn with_plugin(mut self, plugin:Arc<crate::plugin::Store>) -> Self { self.plugin = Some(plugin); self }
    pub fn with_terminal_states(mut self, states:Arc<crate::state::published::Published>) -> Self { self.terminal_states=Some(states);self }
    pub fn with_terms(mut self, terms:Arc<crate::term::Terms>) -> Self {self.terms=Some(terms);self}
    fn terminal_mode_reader(&self) -> crate::terminal_facts::ModeReader {
        let (entries,published,permissions)=(Arc::downgrade(&self.entries),self.terminal_states.clone(),self.permissions.clone());
        Arc::new(move |name| {
            let (entries,published,permissions)=(entries.clone(),published.clone(),permissions.clone());
            Box::pin(async move {
                let entries=entries.upgrade().ok_or(crate::terminal_input::ServiceError("terminal_mode_unavailable"))?;
                let (mut source,terminal,live)={
                    let entries=entries.lock().await;
                    let mut matches=entries.iter().filter(|(_,entry)|entry.name==name && entry.provider=="claude");
                    let Some((key,entry))=matches.next() else {return Ok(None)};
                    if matches.next().is_some() {return Err(crate::terminal_input::ServiceError("terminal_mode_ambiguous"));}
                    if entry.mode_source.binding.key!=*key || entry.mode_source.binding.generation!=entry.generation || entry.mode_source.binding.conversation.is_empty() {
                        return Err(crate::terminal_input::ServiceError("terminal_mode_binding_changed"));
                    }
                    (entry.mode_source.clone(),matches!(&entry.handle,EntryHandle::Terminal {..}),entry.live.clone())
                };
                if !terminal {
                    let current=live.borrow().clone().filter(|state|state.error.is_none()).ok_or(crate::terminal_input::ServiceError("terminal_mode_unavailable"))?;
                    if current.binding.as_ref()!=Some(&source.binding) {return Err(crate::terminal_input::ServiceError("terminal_mode_binding_changed"));}
                }
                let confirmed=match &permissions {
                    Some(memory)=>memory.lock().map_err(|_|crate::terminal_input::ServiceError("terminal_mode_unavailable"))?
                        .confirmed(&source.binding.conversation).map_err(crate::terminal_input::ServiceError)?,
                    None=>return Err(crate::terminal_input::ServiceError("terminal_mode_unavailable")),
                };
                if let Some(mode)=confirmed.clone() {
                    source.confirmed=Some(if mode.current=="plan" {mode.previous_non_plan} else {mode.current});
                } else if terminal {
                    if let Some(state)=published.as_ref().and_then(|published|published.get(&name,Some(&source.binding.conversation))) {
                        if state.problema.is_some() {return Err(crate::terminal_input::ServiceError("terminal_mode_unavailable"));}
                        source.confirmed=state.claude_permission_mode.clone().filter(|mode|!mode.is_empty() && mode!="plan")
                            .or_else(||state.claude_previous_non_plan.clone().filter(|mode|!mode.is_empty() && mode!="plan"));
                    }
                } else {
                    let current=live.borrow().clone().filter(|state|state.error.is_none()).ok_or(crate::terminal_input::ServiceError("terminal_mode_unavailable"))?;
                    let binding=current.binding.as_ref().filter(|binding|binding.key==source.binding.key && binding.generation==source.binding.generation && !binding.conversation.is_empty()).ok_or(crate::terminal_input::ServiceError("terminal_mode_binding_changed"))?;
                    if binding.conversation!=source.binding.conversation {return Err(crate::terminal_input::ServiceError("terminal_mode_binding_changed"));}
                    source.confirmed=current.public_state["claude_permission_mode"].as_str().filter(|mode|!mode.is_empty() && *mode!="plan")
                        .or_else(||current.public_state["claude_previous_non_plan"].as_str().filter(|mode|!mode.is_empty() && *mode!="plan"))
                        .map(str::to_owned).or(source.confirmed);
                }
                let entries=entries.lock().await;
                if !entries.get(&source.binding.key).is_some_and(|entry|entry.name==name && entry.generation==source.binding.generation && entry.mode_source.binding==source.binding && entry.mode_source.transcript==source.transcript) {
                    return Err(crate::terminal_input::ServiceError("terminal_mode_binding_changed"));
                }
                if !terminal && live.borrow().as_ref().and_then(|state|state.binding.as_ref())!=Some(&source.binding) {return Err(crate::terminal_input::ServiceError("terminal_mode_binding_changed"));}
                let fresh=permissions.as_ref().ok_or(crate::terminal_input::ServiceError("terminal_mode_unavailable"))?
                    .lock().map_err(|_|crate::terminal_input::ServiceError("terminal_mode_unavailable"))?
                    .confirmed(&source.binding.conversation).map_err(crate::terminal_input::ServiceError)?;
                if fresh!=confirmed {return Err(crate::terminal_input::ServiceError("terminal_mode_binding_changed"));}
                Ok(Some(source))
            })
        })
    }
    /// Vínculo e metadados do terminal, sem enviar um pedido ao ator ocupado.
    pub async fn terminal_target(&self,name:&str)->Result<Option<super::terminal::TerminalTarget>,RuntimeError> {
        let entries=self.entries.lock().await;let mut matches=entries.iter().filter(|(_,entry)|entry.name==name);
        let Some((key,entry))=matches.next() else {return Ok(None)};
        if matches.next().is_some() {return Err(failure("runtime_binding"));}
        match &entry.handle {
            EntryHandle::Terminal {target,..} if target.key==*key && target.generation==entry.generation && target.binding.generation==entry.generation && target.binding.name==name=>Ok(Some(target.clone())),
            EntryHandle::Terminal {..}=>Err(failure("runtime_binding")),_=>Ok(None),
        }
    }
    pub async fn interaction_binding_readonly(&self,name:&str)->Result<crate::interactions::InteractionBinding,RuntimeError> {
        let entries=self.entries.lock().await;let mut matches=entries.iter().filter(|(_,entry)|entry.name==name);
        let (key,entry)=matches.next().ok_or_else(||failure("runtime_binding"))?;
        if matches.next().is_some() {return Err(failure("runtime_binding"));}
        if let EntryHandle::Terminal {target,..}=&entry.handle {
            if target.key!=*key || target.generation!=entry.generation || target.binding.generation!=entry.generation || target.binding.name!=name || target.binding.conversation.is_empty() {return Err(failure("runtime_binding"));}
            return Ok(crate::terminal_facts::LocalTerminalFacts::binding(target));
        }
        let live=entry.live.borrow().clone().filter(|state|state.error.is_none()).ok_or_else(||failure("runtime_binding"))?;
        let binding=live.binding.clone().filter(|binding|binding.key==*key && binding.generation==entry.generation && !binding.conversation.is_empty()).ok_or_else(||failure("runtime_binding"))?;
        Ok(binding)
    }
    pub async fn drain(&self,name:&str)->Result<Value,RuntimeError> {
        let handle={
            let entries=self.entries.lock().await;let mut matches=entries.values().filter(|entry|entry.name==name);
            let entry=matches.next().ok_or_else(||failure("runtime_binding"))?;
            if matches.next().is_some() {return Err(failure("runtime_binding"));}entry.handle.clone()
        };handle.drain().await
    }
    pub fn plugin(&self) -> Result<&Arc<crate::plugin::Store>,RuntimeError> {
        self.plugin.as_ref().ok_or_else(||failure("plugin_store_unavailable"))
    }
    async fn bind_plugin(&self,name:&str) -> Result<(),RuntimeError> {
        if let Some(plugin) = &self.plugin {
            let binding = self.interaction_binding(name).await?;
            plugin.bind(&binding).map_err(|error|failure(error.0))?;
        }
        Ok(())
    }
    pub fn ingress(&self) -> &super::ingress::IngressGates { &self.ingress }
    pub fn subscribe(&self) -> broadcast::Receiver<RuntimeEvent> { self.events.subscribe() }
    /// Último valor da sessão `name` para o feed do hub; `None` enquanto ela não está aberta aqui.
    pub fn live(&self,name:&str) -> LiveReceiver { self.live_sender(name).subscribe() }
    /// Canal do nome, criado na primeira procura (feed ou ator, o que vier antes). Canal vazio e sem
    /// receptor sai do mapa aqui: sem isto o mapa guardaria todo nome que já teve chat aberto. Canal
    /// que um ator já segura (cópia fora do mapa) fica, mesmo vazio: o ator só escreve no primeiro passo.
    fn live_sender(&self,name:&str) -> LiveSender {
        let mut map = self.live.lock().unwrap_or_else(|e|e.into_inner());
        map.retain(|key,sender|key == name || sender.receiver_count() > 0 || sender.sender_count() > 1 || sender.borrow().is_some());
        map.entry(name.to_owned()).or_insert_with(||tokio::sync::watch::channel(None).0).clone()
    }
    pub async fn handle(&self,key:&str,generation:u64) -> Result<RuntimeHandle,RuntimeError> {
        match self.entry(key,generation).await? {EntryHandle::Headless(handle) | EntryHandle::CodexTerminal {handle,..}=>Ok(handle),_=>Err(failure("runtime_provider"))}
    }
    async fn entry(&self,key:&str,generation:u64)->Result<EntryHandle,RuntimeError> {
        self.entries.lock().await.get(key).filter(|entry|entry.generation==generation)
            .map(|entry|entry.handle.clone()).ok_or_else(||failure("runtime_binding"))
    }
    /// Abre a sessão no Rust: trava, fila com `Recover`, conexão ao cano e ator. Responde sem
    /// esperar o `initialize`; o ator o faz e drena a fila quando a sessão fica entregável.
    pub async fn open(&self,target:RuntimeTarget) -> Result<Value,RuntimeError> { self.open_inner(target,None,false).await }
    /// `open` que pode subir o processo: sobe só se o cano gravado não for `Ours` (vivo e da chave).
    pub async fn open_with_launch(&self,target:RuntimeTarget,sidecar_dir:std::path::PathBuf) -> Result<Value,RuntimeError> {
        self.open_inner(target,Some(sidecar_dir),true).await
    }
    /// `open` de sessão cujo processo o Rust administra (religar, reiniciar, encerrar) sem subir agora.
    pub async fn open_managed(&self,target:RuntimeTarget,sidecar_dir:std::path::PathBuf) -> Result<Value,RuntimeError> {
        self.open_inner(target,Some(sidecar_dir),false).await
    }
    /// Abertura que falha fica no canal do hub até a próxima abertura (a mesma regra do `close` com
    /// erro): sem isso o chat mostraria a sessão parada. Geração ou provedor errado é pedido torto,
    /// não a sessão falhando.
    async fn open_inner(&self,target:RuntimeTarget,managed:Option<std::path::PathBuf>,spawn:bool) -> Result<Value,RuntimeError> {
        let name = target.name.clone();
        let result = self.open_attempt(target,managed,spawn).await;
        if let Err(error) = &result && !["runtime_generation","runtime_provider"].contains(&error.code.as_str()) {
            super::actor::mark_live_error(&self.live_sender(&name),&error.code,&error.message);
        }
        result
    }
    async fn open_attempt(&self,mut target:RuntimeTarget,managed:Option<std::path::PathBuf>,spawn:bool) -> Result<Value,RuntimeError> {
        let launch = managed.as_ref().filter(|_|spawn);
        let barrier = self.barrier(&target.key).await;
        let _guard = barrier.lock().await;
        let existing = self.entries.lock().await.get(&target.key).map(|entry|(entry.generation,entry.handle.clone()));
        let handle = if let Some((generation,handle)) = existing {
            if generation != target.generation { return Err(failure("runtime_generation")); }
            match handle {EntryHandle::Headless(handle)=>handle,_=>return Err(failure("runtime_provider"))}
        } else {
        if !["claude","codex"].contains(&target.provider.as_str()) || target.binding.versao != 2 { return Err(failure("runtime_provider")); }
        let account_guard = runtime_account_guard(&target.provider, &target.metadata).await?;
        let lease = wait_lease(&target.lease_path).await?;
        let store = open_store(&target.state_path,&target.projection_dir,&target.key,target.generation,&target.name,lease.clone()).await?;
        let mut metadata = target.metadata.clone();
        if let Some(fields) = store.state().runtime_state["view"].as_object() {
            if fields.get("conversation").is_some_and(|conversation|conversation == &metadata[if target.provider == "claude" { "session_id" } else { "thread_id" }]) {
                for (key,value) in fields { if key != "public_state" { metadata[key] = value.clone(); } }
            }
        }
        let queue = QueueActor::start(store,lease);
        // Depois da fila: o `session.patch_meta` do Python lê o estado dela.
        let launched = match &launch {
            Some(sidecar_dir)=>launch_if_needed(&self.policy,&mut target,sidecar_dir).await,
            None=>Ok(None),
        };
        let connection = match &launched {
            Err(error)=>Err(error.clone()),
            Ok(_)=>cano::connect(&target.binding).await,
        };
        let connection = match connection {
            Ok(connection)=>connection,
            Err(error)=>{
                if let Err(stop) = queue.shutdown().await {
                    tracing::warn!(key=%target.key,code=%error.code,stop=?stop.kind(),"fila não fechou depois da falha ao conectar no cano");
                }
                // Só o cano subido nesta chamada morre: um vivo de antes pode estar no meio de um turno.
                if let (Ok(Some(cano)),Some(sidecar_dir)) = (launched,launch) { discard(&self.policy,&target,&cano,sidecar_dir).await; }
                return Err(error);
            },
        };
        let fresh = matches!(launched,Ok(Some(_)));
        let epoch_s = SystemTime::now().duration_since(UNIX_EPOCH).map(|d|d.as_secs_f64()).unwrap_or(0.0);
        let revision = self.revisions.lock().await.entry(target.key.clone()).or_insert_with(||Arc::new(AtomicU64::new(0))).clone();
        let mut engine = RuntimeEngine::new(&target.provider,metadata,target.generation,ClockSample { monotonic_s:0.0,epoch_s })?
            .with_policy(self.policy.clone()).with_publisher(self.events.clone()).with_revision(revision);
        if let Some(store) = &self.interactions { engine = engine.with_interactions(target.key.clone(),store.clone())?; }
        engine.set_fresh_process(fresh);
        if let Some(sidecar_dir) = &managed { engine = engine.with_launch(LaunchConfig { sidecar_dir:sidecar_dir.clone(),backoff:self.respawn_base }); }
        if let Some(mods) = &self.mods { engine = engine.with_mods(mods.clone()); }
        engine = engine.with_live(self.live_sender(&target.name));
        // Dono único dos pedidos dos apps até o `close` (S9). Só o Claude tem superfície. Registrado antes
        // de a tarefa do ator existir: a primeira faixa publicada já encontra a sessão no `Mods`.
        // A vida no `Mods` é única no servidor; o processo é a chave durável mais o cano, que o renomear mantém.
        let life = engine.mods_life();
        let handle = RuntimeActor::spawn_with(target.clone(),queue,connection,engine,|handle| {
            if target.provider == "claude" && let Some(mods) = &self.mods {
                let process = format!("{}:{}:{}",target.key,target.binding.pid,target.binding.escuta);
                mods.attach_process(&target.name,&process,life,Arc::new(handle.clone()));
            }
        });
        self.entries.lock().await.insert(target.key.clone(),Entry { generation:target.generation,handle:EntryHandle::Headless(handle.clone()),
            lease_path:target.lease_path.clone(),name:target.name.clone(),mods_life:life,provider:target.provider.clone(),account_key:Some(account_guard.key.clone()),
            mode_source:crate::terminal_facts::ModeSource {binding:crate::interactions::InteractionBinding {key:target.key.clone(),generation:target.generation,conversation:target.metadata[if target.provider=="claude" {"session_id"} else {"thread_id"}].as_str().unwrap_or("").into()},transcript:target.transcript.clone(),confirmed:target.metadata["permission_mode"].as_str().filter(|mode|*mode!="plan").map(str::to_owned)},
            live:self.live_sender(&target.name) });
        handle
        };
        let snapshot = match handle.snapshot().await {
            Ok(snapshot) if snapshot["error"].is_null() && snapshot["view"]["alive"] != false=>snapshot,
            result=>{
                // Ator morto ou cano já saído: fecha agora, senão a entrada presa responderia ao próximo `open`.
                let error = match result {
                    Err(error)=>error,
                    Ok(snapshot)=>snapshot["error"].as_str().map_or_else(||failure("cano_exited"),|code|RuntimeError::new(code,"ator do runtime terminou ao abrir")),
                };
                if let Err(close) = self.close_locked(&target.key,target.generation,false).await {
                    tracing::warn!(key=%target.key,code=%close.code,"sessão não fechou depois de abrir com erro");
                }
                return Err(error);
            }
        };
        if target.provider == "claude" { self.bind_plugin(&target.name).await?; }
        Ok(json!({"opened":true,"instance":self.instance,"key":target.key,"generation":target.generation,"state":snapshot}))
    }
    /// Adota o app-server do Codex com terminal: confere endereço local, conversa e pid, abre a fila sob a
    /// trava e liga o ator ao WebSocket. O processo segue do ciclo de vida que o abriu: nada sobe nem morre aqui.
    pub async fn open_codex_terminal(&self,target:CodexTerminalTarget) -> Result<Value,RuntimeError> {
        let name = target.name.clone();
        let result = self.open_codex_terminal_attempt(target).await;
        if let Err(error) = &result && !["runtime_generation","runtime_provider"].contains(&error.code.as_str()) {
            super::actor::mark_live_error(&self.live_sender(&name),&error.code,&error.message);
        }
        result
    }
    async fn open_codex_terminal_attempt(&self,target:CodexTerminalTarget) -> Result<Value,RuntimeError> {
        let barrier = self.barrier(&target.key).await;
        let _guard = barrier.lock().await;
        let existing = self.entries.lock().await.get(&target.key).map(|entry|(entry.generation,entry.handle.clone()));
        let handle = match existing {
            Some((generation,EntryHandle::CodexTerminal { target:old,handle,.. })) if generation == target.generation && old.same_life(&target)=>{
                // Mesma vida, mas o app-server pode ter morrido: responder `opened` com um ator desconectado para
                // sempre esconderia isso. Quem fecha e adota a vida nova é o ciclo de vida.
                super::codex_terminal::verify(&target).await?;
                handle
            },
            Some(_)=>return Err(failure("runtime_generation")),
            None=>{
                super::codex_terminal::verify(&target).await?;
                let account_guard = runtime_account_guard("codex",&target.metadata).await?;
                let lease = wait_lease(&target.lease_path).await?;
                let store = open_store(&target.state_path,&target.projection_dir,&target.key,target.generation,&target.name,lease.clone()).await?;
                let runtime = target.runtime_target();
                let mut metadata = runtime.metadata.clone();
                if let Some(fields) = store.state().runtime_state["view"].as_object() {
                    if fields.get("conversation").is_some_and(|conversation|conversation == &metadata["thread_id"]) {
                        for (key,value) in fields { if key != "public_state" && key != "headless" { metadata[key] = value.clone(); } }
                    }
                }
                let queue = QueueActor::start(store,lease);
                let connection = match super::websocket::WebSocketConnection::connect(&target.endpoint).await {
                    Ok(connection)=>connection,
                    Err(error)=>{
                        if let Err(stop) = queue.shutdown().await {
                            tracing::warn!(key=%target.key,code=%error.code,stop=?stop.kind(),"fila não fechou depois da falha ao conectar no app-server");
                        }
                        return Err(error);
                    }
                };
                let epoch_s = SystemTime::now().duration_since(UNIX_EPOCH).map(|d|d.as_secs_f64()).unwrap_or(0.0);
                let revision = self.revisions.lock().await.entry(target.key.clone()).or_insert_with(||Arc::new(AtomicU64::new(0))).clone();
                let mut engine = RuntimeEngine::new("codex",metadata,target.generation,ClockSample { monotonic_s:0.0,epoch_s })?
                    .with_policy(self.policy.clone()).with_publisher(self.events.clone()).with_revision(revision);
                if let Some(store) = &self.interactions { engine = engine.with_interactions(target.key.clone(),store.clone())?; }
                engine = engine.with_live(self.live_sender(&target.name));
                let cell = AdoptionCell::new(&target.endpoint,target.app_pid);
                let adoption = Adoption { endpoint:target.endpoint.clone(),app_pid:target.app_pid,cell:cell.clone() };
                let handle = RuntimeActor::spawn_adopted(runtime,queue,connection,engine,adoption);
                self.entries.lock().await.insert(target.key.clone(),Entry { generation:target.generation,
                    handle:EntryHandle::CodexTerminal { target:Box::new(target.clone()),handle:handle.clone(),cell },
                    lease_path:target.lease_path.clone(),name:target.name.clone(),mods_life:0,provider:"codex".into(),account_key:Some(account_guard.key.clone()),
                    mode_source:crate::terminal_facts::ModeSource {binding:crate::interactions::InteractionBinding {key:target.key.clone(),generation:target.generation,conversation:target.thread_id.clone()},transcript:target.transcript.clone().unwrap_or_default(),confirmed:None},
                    live:self.live_sender(&target.name) });
                // O estado passa a sair do feed do runtime; o pane segue presente.
                self.mark_codex_owner(&target.name,&target.key,target.generation,true);
                handle
            }
        };
        let snapshot = match handle.snapshot().await {
            Ok(snapshot) if snapshot["error"].is_null()=>snapshot,
            result=>{
                let error = match result {
                    Err(error)=>error,
                    Ok(snapshot)=>snapshot["error"].as_str().map_or_else(||failure("runtime_closed"),|code|RuntimeError::new(code,"ator do runtime terminou ao abrir")),
                };
                if let Err(close) = self.close_locked(&target.key,target.generation,false).await {
                    tracing::warn!(key=%target.key,code=%close.code,"sessão não fechou depois de abrir com erro");
                }
                return Err(error);
            }
        };
        Ok(json!({"opened":true,"instance":self.instance,"key":target.key,"generation":target.generation,"state":snapshot}))
    }
    pub async fn open_terminal(&self,target:super::terminal::TerminalTarget)->Result<Value,RuntimeError> {
        let barrier=self.barrier(&target.key).await; let _guard=barrier.lock().await;
        let existing=self.entries.lock().await.get(&target.key).map(|e|(e.generation,e.handle.clone(),e.mods_life));
        let handle=match existing {
            Some((generation,EntryHandle::Terminal {target:old,handle},life)) if generation==target.generation && old.binding==target.binding
                && old.metadata==target.metadata && old.transcript==target.transcript && old.state_path==target.state_path && old.projection_dir==target.projection_dir && old.lease_path==target.lease_path=>{
                // Reabertura da mesma vida: se o nome saiu do `Mods`, a sessão volta a ser ligada, na vida da
                // entrada, que é a que o `close` esquece. Nome com outra vida fica com ela: é uma sessão mais
                // nova e viva, e tomá-lo a deixaria sem dono e sem o nome de nascimento.
                if let Some(mods)=&self.mods && life!=0 && mods.life(&target.name).is_none() {
                    attach_terminal_mods(mods,&target,&handle,life).await;
                }
                handle
            },
            Some(_)=>return Err(failure("runtime_generation")),
            None=>{
                let lease=wait_lease(&target.lease_path).await?;
                let store=open_store(&target.state_path,&target.projection_dir,&target.key,target.generation,&target.name,lease.clone()).await?;
                let revision=self.revisions.lock().await.entry(target.key.clone()).or_insert_with(||Arc::new(AtomicU64::new(0))).clone();
                if let Some(interactions) = &self.interactions {
                    interactions.bind(&crate::interactions::InteractionBinding { key:target.key.clone(),conversation:target.binding.conversation.clone(),generation:target.generation })
                        .map_err(crate::interactions::runtime_error)?;
                }
                // A âncora nasce com o executor, que a lê, e passa ao elo pelo `handle`, também na reabertura.
                let options=super::terminal::TerminalOptions {interactions:self.interactions.clone(),plugin:self.plugin.clone(),mode_facts:Some(self.terminal_mode_reader()),terms:self.terms.clone(),anchor:super::terminal::ModsAnchor::default(),..Default::default()};
                let handle=super::terminal::TerminalActor::spawn(target.clone(),QueueActor::start(store,lease),self.policy.clone(),options,self.events.clone(),revision);
                // A vida no `Mods` é única no servidor (`new_life`).
                let life=match &self.mods {
                    Some(mods)=>{
                        let life=mods.new_life();
                        attach_terminal_mods(mods,&target,&handle,life).await;
                        life
                    },
                    None=>0,
                };
                self.entries.lock().await.insert(target.key.clone(),Entry {generation:target.generation,handle:EntryHandle::Terminal {target:target.clone(),handle:handle.clone()},lease_path:target.lease_path.clone(),name:target.name.clone(),mods_life:life,provider:"claude".into(),account_key:None,
                    mode_source:crate::terminal_facts::ModeSource {binding:crate::terminal_facts::LocalTerminalFacts::binding(&target),transcript:target.transcript.clone(),confirmed:None},live:self.live_sender(&target.name)});handle
            }
        };
        let snapshot=handle.snapshot().await?;
        self.bind_plugin(&target.name).await?;
        Ok(json!({"opened":true,"instance":self.instance,"key":target.key,"generation":target.generation,"state":snapshot}))
    }
    /// Fecha a sessão no Rust: o ator para e solta a trava; o cano segue vivo.
    pub async fn close(&self,key:&str,generation:u64) -> Result<Value,RuntimeError> {
        let barrier = self.barrier(key).await;
        let _guard = barrier.lock().await;
        self.close_locked(key,generation,false).await
    }
    /// Encerrar a sessão: o ator para e o processo dela morre, com os arquivos do cano. Sem a sessão
    /// aberta aqui não há o que matar (`killed: false`): quem pediu decide.
    pub async fn close_with_kill(&self,key:&str,generation:u64) -> Result<Value,RuntimeError> {
        let barrier = self.barrier(key).await;
        let _guard = barrier.lock().await;
        self.close_locked(key,generation,true).await
    }
    async fn close_locked(&self,key:&str,generation:u64,kill:bool) -> Result<Value,RuntimeError> {
        let (handle,lease_path,name,life) = match self.entries.lock().await.get(key) {
            None=>return Ok(if kill { json!({"closed":true,"killed":false}) } else { json!({"closed":true}) }),
            Some(entry) if entry.generation == generation=>(entry.handle.clone(),entry.lease_path.clone(),entry.name.clone(),entry.mods_life),
            _=>return Err(failure("runtime_generation")),
        };
        if kill && matches!(&handle,EntryHandle::Terminal {..}) { return Err(failure("close_kill")); }
        if let Some(plugin) = &self.plugin { plugin.forget(key).map_err(|error|failure(error.0))?; }
        let stopped = match (&handle,kill) {
            (EntryHandle::Headless(handle),true)=>handle.stop_killing().await,
            // O app-server adotado não é do Rust: encerrar é do ciclo de vida que o abriu.
            (EntryHandle::Terminal {..} | EntryHandle::CodexTerminal {..},true)=>return Err(failure("close_kill")),
            (EntryHandle::CodexTerminal { cell,handle,.. },false)=>{
                // A reconexão em voo para antes de a posse sair daqui.
                cell.revoke();
                handle.stop().await
            },
            _=>handle.stop().await,
        };
        if let Err(error) = stopped {
            // `stop` sempre junta a tarefa do ator: se ele saiu por erro, a posse acaba com ele. Sem
            // isto a entrada morta ficava para sempre, a sessão não reabria e o retrato de eventos
            // de todas as sessões caía. Só solta depois de a trava estar livre de fato.
            if wait_lease(&lease_path).await.is_err() {
                tracing::warn!(key,code=%error.code,"ator terminou mas a trava não liberou em 3 s; sessão segue presa");
                return Err(error);
            }
            if kill {
                // O ator parou e soltou a trava: a sessão saiu daqui, só o processo não morreu. Responder
                // erro deixava o Python achando que ela seguia aqui; `killed: false` e quem pediu decide.
                tracing::warn!(key,code=%error.code,"sessão fechada sem encerrar o processo");
                if let Some(store) = &self.interactions { store.forget(key).map_err(crate::interactions::runtime_error)?; }
                self.entries.lock().await.remove(key);
                self.clear_live(&name).await;
                if let Some(mods) = &self.mods { mods.forget(&name,life); }
                return Ok(json!({"closed":true,"killed":false}));
            }
            tracing::warn!(key,code=%error.code,"ator do runtime já tinha terminado; sessão liberada");
        }
        if let Some(store) = &self.interactions { store.forget(key).map_err(crate::interactions::runtime_error)?; }
        self.entries.lock().await.remove(key);
        // Codex com terminal fora do Rust: o hub devolve o estado à observação do Python.
        if matches!(handle,EntryHandle::CodexTerminal {..}) { self.mark_codex_owner(&name,key,generation,false); }
        self.clear_live(&name).await;
        // A sessão saiu do Rust: os apps perdem a faixa e os pedidos voltam a não ter dono (S9). Com ou sem
        // terminal, esquece só esta vida: outra sessão que tenha tomado o nome (outra vida) fica.
        if let Some(mods) = &self.mods { mods.forget(&name,life); }
        Ok(if kill { json!({"closed":true,"killed":true}) } else { json!({"closed":true}) })
    }
    /// Sessão fora do Rust: o feed mostra a parada (`None`), e o canal sem receptor sai do mapa.
    async fn clear_live(&self,name:&str) {
        // Outra vida com o mesmo nome (reaberta antes deste fechamento) segue dona do canal.
        if self.entries.lock().await.values().any(|entry|entry.name == name) { return; }
        let mut map = self.live.lock().unwrap_or_else(|e|e.into_inner());
        if let Some(sender) = map.get(name) {
            // Vida que acabou com erro: o problema fica até a próxima abertura, que escreve por cima.
            // ponytail: o canal com erro de sessão apagada fica no mapa; um por nome, sem crescer.
            if sender.borrow().as_ref().is_some_and(|state|state.error.is_some()) { return; }
            sender.send_replace(None);
            if sender.receiver_count() == 0 { map.remove(name); }
        }
    }
    async fn barrier(&self,key:&str) -> Arc<Mutex<()>> {
        self.lifecycle.lock().await.entry(key.into()).or_insert_with(||Arc::new(Mutex::new(()))).clone()
    }
    /// Chave do ator de entrada terminal da sessão `name` e o retrato dele; `None` sem ator aberto.
    pub async fn terminal_view(&self,name:&str) -> Option<(String,Value)> {
        let found = self.entries.lock().await.iter().find_map(|(key,entry)| match &entry.handle {
            EntryHandle::Terminal {target,handle} if target.name==name=>Some((key.clone(),handle.clone())),
            _=>None,
        });
        let (key,handle) = found?;
        match handle.snapshot().await {
            Ok(view)=>Some((key,view)),
            Err(error)=>Some((key,json!({"error":error.code,"view":{}}))),
        }
    }
    /// Entrada aberta da sessão `name`, para escrever. Chamar depois do `ingress().enter`: a procurada
    /// antes de esperar a porta pode ser a que o relançamento parou.
    /// `healthy` é a negação do `_rust_failed` do Python; `terminal_facts` conta como doente aqui
    /// (vínculo trocado, só o `prepare_session` refaz), `receipt_scan` não.
    pub async fn writable(&self,name:&str) -> Option<WriteTarget> {
        // Nome repetido é defeito de quem abriu a entrada; a escrita vai para a geração mais nova.
        let (key,generation,provider,handle) = self.entries.lock().await.iter().filter(|(_,e)|e.name==name).max_by_key(|(_,e)|e.generation)
            .map(|(key,e)|(key.clone(),e.generation,e.provider.clone(),e.handle.clone()))?;
        let terminal = handle.has_terminal();
        let healthy = match tokio::time::timeout(Duration::from_secs(1),handle.snapshot()).await {
            Ok(Ok(view))=>healthy(terminal,&view),
            _=>false,
        };
        Some(WriteTarget { key,generation,provider,terminal,healthy,handle })
    }
    /// A entrada mais nova do nome é de terminal? Sem retrato: serve a decisão que vem antes da porta.
    pub async fn is_terminal(&self,name:&str) -> bool {
        self.entries.lock().await.values().filter(|e|e.name==name).max_by_key(|e|e.generation)
            .is_some_and(|e|e.handle.has_terminal())
    }
    /// Sessão do ator de entrada terminal de chave `key`.
    pub async fn terminal_name(&self,key:&str) -> Option<String> {
        match &self.entries.lock().await.get(key)?.handle { EntryHandle::Terminal {target,..}=>Some(target.name.clone()), _=>None }
    }
    /// Leitura pura: quem exclui já pode segurar exclusividade.
    pub async fn account_usage(&self, key: &crate::accounts::AccountKey) -> crate::accounts::UsageFacts {
        let entries = self.entries.lock().await;
        let sessions = entries.values().filter(|entry| entry.account_key.as_ref().is_some_and(|account| account == key))
            .map(|entry| entry.name.clone()).collect();
        crate::accounts::UsageFacts { complete: true, sessions, ..Default::default() }
    }

    pub async fn snapshots(&self) -> Result<Vec<RuntimeEvent>,RuntimeError> {
        let entries:Vec<_> = self.entries.lock().await.iter().map(|(key,entry)|(key.clone(),entry.generation,entry.handle.clone())).collect();
        let mut output = Vec::new();
        for (key,generation,handle) in entries {
            // Uma sessão sem ator não tira o retrato das outras: ela fica de fora até ser liberada.
            match handle.snapshot().await {
                Ok(data)=>output.push(RuntimeEvent { key,generation,revision:data["revision"].as_u64().unwrap_or(0),channel:"snapshot".into(),data }),
                Err(error)=>if crate::warn_limit::allow(Some(&key),&error.code) { tracing::warn!(key,code=%error.code,"sessão fora do retrato inicial dos eventos") },
            }
        }
        Ok(output)
    }
    /// Retrato de todas as sessões, por chave, para a lista. Diferente de `snapshots`, a sessão cujo
    /// ator não respondeu fica com `{"error": código}`: fora do retrato ela pareceria parada.
    pub async fn list_snapshots(&self) -> BTreeMap<String,Value> {
        let entries:Vec<_> = self.entries.lock().await.iter().map(|(key,entry)|(key.clone(),entry.handle.clone())).collect();
        let asks = entries.into_iter().map(|(key,handle)| async move {
            let data = match tokio::time::timeout(Duration::from_secs(1),handle.snapshot()).await {
                Ok(Ok(data))=>data,
                Ok(Err(error))=>json!({"error":error.code}),
                Err(_)=>json!({"error":"runtime_snapshot_timeout"}),
            };
            (key,data)
        });
        futures_util::future::join_all(asks).await.into_iter().collect()
    }
    pub async fn list_snapshots_readonly(&self) -> BTreeMap<String,Value> {
        let entries=self.entries.lock().await;
        entries.iter().map(|(key,entry)| {
            let unavailable=||json!({"key":key,"generation":entry.generation,"error":"runtime_live_unavailable"});
            let data=match &entry.handle {
                EntryHandle::Terminal {target,..} if target.key==*key && target.generation==entry.generation=>{
                    match self.terminal_states.as_ref().and_then(|states|states.get(&entry.name,Some(&target.binding.conversation))) {
                        Some(state)=>json!({"key":key,"generation":entry.generation,"error":state.problema,"view":{"alive":state.state!="dead","conversation":target.binding.conversation,"headless":false,"public_state":state}}),
                        None=>unavailable(),
                    }
                },
                EntryHandle::Terminal {..}=>unavailable(),
                _=>match entry.live.borrow().clone() {
                    Some(live) if live.binding.as_ref().is_some_and(|binding|binding.key==*key && binding.generation==entry.generation && !binding.conversation.is_empty()) && live.public_state["state"].is_string()=>{
                        json!({"key":key,"generation":entry.generation,"error":live.error.as_ref().map(|error|&error.0),"view":{"alive":live.public_state["state"]!="dead","conversation":live.binding.as_ref().map(|binding|&binding.conversation),"headless":matches!(entry.handle,EntryHandle::Headless(_)),"public_state":live.public_state}})
                    },
                    _=>unavailable(),
                },
            };(key.clone(),data)
        }).collect()
    }
    pub async fn shutdown(&self) -> Result<(),RuntimeError> {
        let entries:Vec<_> = self.entries.lock().await.iter().map(|(key,entry)|(key.clone(),entry.generation)).collect();
        for (key,generation) in entries { self.close(&key,generation).await?; }
        Ok(())
    }
}

#[derive(Clone)]
struct Gateway { registry:Arc<RuntimeRegistry>,secret:String,instance:String,protocol:u32 }

pub fn startup_line(protocol:u32,instance:&str,port:u16) -> String {
    json!({"type":"runtime_ready","protocol":protocol,"instance":instance,"port":port}).to_string()
}

pub async fn serve(listener:tokio::net::TcpListener,registry:Arc<RuntimeRegistry>,secret:String,instance:String,protocol:u32) -> std::io::Result<()> {
    if !listener.local_addr()?.ip().is_loopback() { return Err(std::io::Error::new(std::io::ErrorKind::PermissionDenied,"IPC somente no loopback")); }
    let state = Gateway { registry,secret,instance,protocol };
    let router = Router::new().route("/runtime/op",post(operation)).route("/runtime/events",get(events))
        .layer(middleware::from_fn_with_state(state.clone(),authorize)).with_state(state);
    axum::serve(axum::serve::ListenerExt::tap_io(listener,crate::nodelay),router.into_make_service_with_connect_info::<SocketAddr>()).await
}

async fn authorize(State(state):State<Gateway>,request:Request,next:Next) -> Response {
    let local = request.extensions().get::<ConnectInfo<SocketAddr>>().is_some_and(|info|info.0.ip().is_loopback());
    let secret = request.headers().get("x-hangar-internal").map(|h|h.as_bytes()).unwrap_or(&[]);
    let instance = request.headers().get("x-hangar-runtime-instance").map(|h|h.as_bytes()).unwrap_or(&[]);
    if !local || secret.ct_eq(state.secret.as_bytes()).unwrap_u8() != 1 || instance.ct_eq(state.instance.as_bytes()).unwrap_u8() != 1 {
        return StatusCode::NOT_FOUND.into_response();
    }
    next.run(request).await
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Envelope {
    protocol:u32,instance:String,key:String,generation:u64,operation_id:String,clock:ClockSample,command:Value,
}

async fn operation(State(state):State<Gateway>,request:Request) -> Response {
    let body = match to_bytes(request.into_body(),MAX_ENVELOPE).await { Ok(body)=>body,Err(_)=>return refuse(StatusCode::PAYLOAD_TOO_LARGE,None,"body") };
    let envelope:Envelope = match serde_json::from_slice(&body) { Ok(envelope)=>envelope,Err(_)=>return refuse(StatusCode::BAD_REQUEST,None,"envelope") };
    let _ = envelope.clock;
    let mismatch = if envelope.protocol != state.protocol { Some("protocol") } else if envelope.instance != state.instance { Some("instance") }
        else if envelope.operation_id.is_empty() { Some("operation_id") } else { None };
    if let Some(check) = mismatch { return refuse(StatusCode::CONFLICT,Some(&envelope.key),check); }
    let result = dispatch(&state.registry,&envelope).await;
    match result {
        Ok(result)=>json_response(StatusCode::OK,json!({"ok":true,"result":result})),
        Err(error)=>{
            if crate::warn_limit::allow(Some(&envelope.key),&error.code) {
                // Só o nome vem do descritor: o resto dele é caminho e credencial do cano.
                let name = envelope.command["descriptor"]["name"].as_str().unwrap_or("");
                tracing::warn!(key=%envelope.key,session=%name,kind=%envelope.command["kind"].as_str().unwrap_or("?"),
                    code=%error.code,reason=%error.message,"runtime recusou operação");
            }
            json_response(StatusCode::SERVICE_UNAVAILABLE,json!({"ok":false,"error_code":error.code,"message":error.message}))
        }
    }
}

/// Recusa antes do despacho: diz qual conferência falhou, sem o corpo.
fn refuse(status:StatusCode,key:Option<&str>,check:&'static str) -> Response {
    if crate::warn_limit::allow(key,check) {
        tracing::warn!(status=status.as_u16(),key=%key.unwrap_or(""),check=%check,"runtime recusou envelope");
    }
    status.into_response()
}

fn json_response(status:StatusCode,value:Value) -> Response {
    (status,[("content-type","application/json")],value.to_string()).into_response()
}

async fn dispatch(registry:&RuntimeRegistry,envelope:&Envelope) -> Result<Value,RuntimeError> {
    let command = &envelope.command;
    let kind = command["kind"].as_str().ok_or_else(||failure("command_kind"))?;
    let fields:&[&str] = match kind {
        "open"=>&["kind","descriptor","launch"],
        "submit"=>&["kind","text","steer","pre_transcript"],
        "control"=>&["kind","control","payload"],
        "queue"=>&["kind","action"],
        "ingress"=>&["kind","name","closed","held"],
        "close"=>&["kind","kill"],
        "snapshot" | "drain" | "confirm" | "ensure_projection"=>&["kind"],
        _=>return Err(failure("command_kind")),
    };
    if !command.as_object().is_some_and(|object|object.keys().all(|key|fields.contains(&key.as_str()))) {
        return Err(failure("command_fields"));
    }
    if kind == "ingress" {
        let name = command["name"].as_str().filter(|n|!n.is_empty()).ok_or_else(||failure("ingress_payload"))?;
        let closed = command["closed"].as_bool().ok_or_else(||failure("ingress_payload"))?;
        // `held`: fechamento da troca de conversa; a reabertura correspondente leva o mesmo `held`.
        let held = match &command["held"] { Value::Null=>false, value=>value.as_bool().ok_or_else(||failure("ingress_payload"))? };
        let gates = registry.ingress();
        match (closed,held) {
            (true,false)=>gates.close(name,INGRESS_CLOSE_WAIT).await.map_err(|_|failure("ingress_busy"))?,
            (true,true)=>gates.hold(name,INGRESS_CLOSE_WAIT).await.map_err(|_|failure("ingress_busy"))?,
            (false,false)=>gates.open(name),
            (false,true)=>gates.release(name),
        }
        return Ok(json!({"closed":closed}));
    }
    if kind == "open" {
        // `launch`: quem abre pode subir o processo (só sem terminal, e só se o gravado não for nosso).
        let launch = match &command["launch"] { Value::Null=>false, value=>value.as_bool().ok_or_else(||failure("open_launch"))? };
        let mut value=command["descriptor"].clone();
        if value["provider"]=="claude" && value["headless"]==false {
            let parsed:Descriptor=serde_json::from_value(value.clone()).map_err(|_|failure("descriptor_shape"))?;
            let binding=terminal_binding(&parsed)?;
            let metadata=crate::terminal_facts::TerminalMetadata::resolve(&parsed.meta,&binding,std::path::Path::new(&parsed.jsonl)).await.map_err(|error|failure(error.0))?;
            value["meta"]["config_dir"]=json!(metadata.config_dir);value["meta"]["agent_pid"]=json!(metadata.agent_pid);
            value["meta"]["agent_birth"]=json!(metadata.agent_birth);value["meta"]["fingerprint"]=json!(metadata.fingerprint);value["meta"]["message_origin"]=json!(metadata.origin);
        }
        return match descriptor(&value,launch)? {
            Target::Headless(target,sidecar_dir) if launch=>{
                if target.key!=envelope.key || target.generation!=envelope.generation{return Err(failure("runtime_binding"));}
                let sidecar_dir = sidecar_dir.filter(|dir|!dir.as_os_str().is_empty()).ok_or_else(||failure("launch_sidecar_dir"))?;
                registry.open_with_launch(target,sidecar_dir).await
            },
            // Codex sem terminal com a pasta do arquivo: o Rust administra o processo mesmo sem subir agora.
            Target::Headless(target,Some(sidecar_dir)) if target.provider == "codex" && !sidecar_dir.as_os_str().is_empty()=>{
                if target.key!=envelope.key || target.generation!=envelope.generation{return Err(failure("runtime_binding"));}
                registry.open_managed(target,sidecar_dir).await
            },
            Target::Headless(target,_)=>{
                if target.key!=envelope.key || target.generation!=envelope.generation{return Err(failure("runtime_binding"));}
                registry.open(target).await
            },
            Target::Terminal(_) if launch=>Err(failure("open_launch")),
            Target::Terminal(target)=>{
                if target.key!=envelope.key || target.generation!=envelope.generation{return Err(failure("runtime_binding"));}
                registry.open_terminal(target).await
            }
            // Codex com terminal só adota: subir o app-server é do ciclo de vida do Python.
            Target::CodexTerminal(_) if launch=>Err(failure("open_launch")),
            Target::CodexTerminal(target)=>{
                if target.key!=envelope.key || target.generation!=envelope.generation{return Err(failure("runtime_binding"));}
                registry.open_codex_terminal(*target).await
            }
        };
    }
    if kind == "close" {
        let kill = match &command["kill"] { Value::Null=>false, value=>value.as_bool().ok_or_else(||failure("close_kill"))? };
        return if kill { registry.close_with_kill(&envelope.key,envelope.generation).await } else { registry.close(&envelope.key,envelope.generation).await };
    }
    let handle = registry.entry(&envelope.key,envelope.generation).await?;
    match kind {
        "submit"=> {
            // Só envios: as consultas que o Python repete (confirm, snapshot) inflariam a conta.
            crate::migration_status::count_private(if matches!(&handle,EntryHandle::Terminal {..}) {"send_terminal"} else {"send_headless"});
            if matches!(&handle,EntryHandle::Terminal {..}) && (command.get("steer").is_some_and(|value|!value.is_boolean())
                || command.get("pre_transcript").is_some_and(|value|!value.is_boolean())) {return Err(failure("terminal_payload"));}
            let kind = if command["steer"] == true && !matches!(&handle,EntryHandle::Terminal {..}) { OperationKind::Steer } else { OperationKind::Input };
            let reply = handle.command(RuntimeCommand { operation_id:envelope.operation_id.clone(),kind,
                payload:json!({"text":command["text"],"pre_transcript":command["pre_transcript"].as_bool().unwrap_or(false)}) }).await?;
            serde_json::to_value(reply).map_err(|_|failure("reply_json"))
        }
        "control"=> {
            if let EntryHandle::Terminal {handle,..}=&handle {
                let control=command["control"].as_str().ok_or_else(||failure("control_kind"))?;
                let reply=handle.control(envelope.operation_id.clone(),control.into(),command["payload"].clone()).await?;
                return serde_json::to_value(reply).map_err(|_|failure("reply_json"));
            }
            let control:OperationKind = serde_json::from_value(command["control"].clone()).map_err(|_|failure("control_kind"))?;
            let reply = handle.command(RuntimeCommand { operation_id:envelope.operation_id.clone(),kind:control,payload:command["payload"].clone() }).await?;
            serde_json::to_value(reply).map_err(|_|failure("reply_json"))
        }
        "queue"=>handle.queue(envelope.operation_id.clone(),serde_json::from_value::<Action>(command["action"].clone()).map_err(|_|failure("queue_action"))?).await,
        "snapshot"=>handle.snapshot().await,
        "drain"=>handle.drain().await,
        "confirm"=>handle.confirm().await,
        "ensure_projection"=>handle.ensure_projection().await,
        _=>Err(failure("command_kind")),
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Descriptor {
    name:String,key:String,provider:String,headless:bool,meta:Value,jsonl:String,
    projection_dir:std::path::PathBuf,state_path:std::path::PathBuf,lock_path:std::path::PathBuf,generation:u64,
    /// Pasta do arquivo da sessão, onde o cano subido pelo Rust põe socket e log; só no `open` com `launch`.
    #[serde(default)] sidecar_dir:Option<std::path::PathBuf>,
}

/// Sem terminal leva a pasta do arquivo da sessão (`sidecar_dir`), que só o `open` com `launch` usa.
/// O Codex com terminal leva endereço, pid e thread do app-server adotado, nunca um cano.
enum Target {Headless(RuntimeTarget,Option<std::path::PathBuf>),Terminal(super::terminal::TerminalTarget),CodexTerminal(Box<CodexTerminalTarget>)}

/// Vínculo do pane, igual para Claude e Codex com terminal.
fn terminal_binding(descriptor:&Descriptor) -> Result<crate::terminal_input::TerminalBinding,RuntimeError> {
    let binding:crate::terminal_input::TerminalBinding=serde_json::from_value(descriptor.meta["terminal"].clone()).map_err(|_|failure("terminal_binding"))?;
    if binding.generation!=descriptor.generation || binding.name!=descriptor.name || binding.conversation.is_empty() || binding.mux_argv.is_empty()
        || binding.mux_argv.iter().any(|v|v.contains('\0'))
        || (!binding.windows && (!binding.pane.starts_with('%') || binding.pane[1..].parse::<u64>().is_err()))
        || (binding.windows && !binding.pane.starts_with(&format!("={}:",binding.name))) {return Err(failure("terminal_binding"));}
    Ok(binding)
}

/// Codex com terminal: conversa do pane igual à thread, endereço de loopback literal e pid informado. Rollout
/// ausente (`jsonl` vazio) é válido; quem prova o pid é a abertura.
fn codex_terminal_descriptor(descriptor:Descriptor) -> Result<CodexTerminalTarget,RuntimeError> {
    let terminal = terminal_binding(&descriptor)?;
    let thread_id = descriptor.meta["thread_id"].as_str().unwrap_or("").to_owned();
    if thread_id.is_empty() { return Err(RuntimeError::new("codex_thread","Codex com terminal sem conversa identificada")); }
    if terminal.conversation != thread_id { return Err(failure("terminal_binding")); }
    let endpoint = descriptor.meta["endpoint"].as_str().ok_or_else(||RuntimeError::new("codex_endpoint","endereço do app-server ausente"))?.to_owned();
    super::codex_terminal::loopback_endpoint(&endpoint)?;
    let app_pid = descriptor.meta["app_pid"].as_u64().and_then(|pid|u32::try_from(pid).ok()).filter(|pid|*pid != 0)
        .ok_or_else(||RuntimeError::new("codex_app_pid","pid do app-server ausente ou inválido"))?;
    Ok(CodexTerminalTarget { key:descriptor.key,generation:descriptor.generation,name:descriptor.name,endpoint,app_pid,thread_id,terminal,
        transcript:(!descriptor.jsonl.is_empty()).then(||descriptor.jsonl.into()),metadata:descriptor.meta,
        lease_path:descriptor.lock_path,state_path:descriptor.state_path,projection_dir:descriptor.projection_dir })
}

fn descriptor(value:&Value,launch:bool) -> Result<Target,RuntimeError> {
    let descriptor:Descriptor = serde_json::from_value(value.clone()).map_err(|_|failure("descriptor_shape"))?;
    if descriptor.meta["key"] != descriptor.key || descriptor.key.is_empty() { return Err(failure("descriptor_binding")); }
    if !descriptor.headless {
        // O sidecar do Codex com terminal grava `"cano": null`: ausente ou nulo é "sem cano"; um cano de verdade não vale aqui.
        if descriptor.provider == "codex" {
            if !descriptor.meta["cano"].is_null() { return Err(failure("descriptor_provider")); }
            return codex_terminal_descriptor(descriptor).map(|target|Target::CodexTerminal(Box::new(target)));
        }
        if descriptor.meta.get("cano").is_some(){return Err(failure("descriptor_provider"));}
        if descriptor.provider!="claude" {return Err(failure("descriptor_provider"));}
        let binding = terminal_binding(&descriptor)?;
        if descriptor.jsonl.is_empty() {return Err(failure("terminal_binding"));}
        let metadata=crate::terminal_facts::TerminalMetadata::from_descriptor(&descriptor.meta).map_err(|error|failure(error.0))?;
        return Ok(Target::Terminal(super::terminal::TerminalTarget {metadata,key:descriptor.key,generation:descriptor.generation,name:descriptor.name,
            created:descriptor.meta["created"].as_f64().unwrap_or(binding.created as f64),binding,
            plugin_key:descriptor.meta["plugin_key"].as_str().filter(|key|!key.is_empty()).map(str::to_owned),
            lease_path:descriptor.lock_path,state_path:descriptor.state_path,projection_dir:descriptor.projection_dir,transcript:descriptor.jsonl.into()}));
    }
    if descriptor.meta.get("terminal").is_some(){return Err(failure("descriptor_provider"));}
    let cano = &descriptor.meta["cano"];
    // Subida pedida sem cano gravado: pid 0 é "nenhum", e a subida grava o novo antes de conectar.
    let binding = if launch && cano["pid"].as_u64().is_none_or(|pid|pid == 0) { CanoBinding { pid:0,escuta:String::new(),token:String::new(),versao:2 } }
    else if launch { CanoBinding { pid:cano["pid"].as_u64().and_then(|pid|u32::try_from(pid).ok()).ok_or_else(||failure("cano_pid"))?,
        escuta:cano["escuta"].as_str().unwrap_or_default().into(),token:cano["token"].as_str().unwrap_or_default().into(),
        // Cano vivo da sessão sem `versao` gravada já fala a 2.
        versao:cano["versao"].as_u64().and_then(|version|u32::try_from(version).ok()).unwrap_or(2) } }
    else { CanoBinding { pid:cano["pid"].as_u64().and_then(|pid|u32::try_from(pid).ok()).ok_or_else(||failure("cano_pid"))?,
        escuta:cano["escuta"].as_str().ok_or_else(||failure("cano_address"))?.into(),
        token:cano["token"].as_str().ok_or_else(||failure("cano_token"))?.into(),
        // O Codex subido pelo Python grava o `cano` antes de conectar, sem `versao`, e já fala a 2.
        versao:match cano["versao"].as_u64().and_then(|version|u32::try_from(version).ok()) {
            Some(version)=>version, None if descriptor.provider == "codex"=>2, None=>return Err(failure("cano_version")) } } };
    Ok(Target::Headless(RuntimeTarget { key:descriptor.key,generation:descriptor.generation,name:descriptor.name,provider:descriptor.provider,
        created:descriptor.meta["created"].as_f64().unwrap_or(0.0),metadata:descriptor.meta,binding,
        lease_path:descriptor.lock_path,state_path:descriptor.state_path,projection_dir:descriptor.projection_dir,transcript:descriptor.jsonl.into() },
        descriptor.sidecar_dir))
}

async fn events(State(state):State<Gateway>) -> Response {
    let receiver = state.registry.subscribe();
    let initial = match state.registry.snapshots().await { Ok(events)=>std::collections::VecDeque::from(events),Err(error)=>{
        tracing::warn!(code=%error.code,reason=%error.message,"runtime sem retrato inicial dos eventos");
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    } };
    let stream = futures_util::stream::unfold((receiver,initial),| (mut receiver,mut initial) | async move {
        let event = if let Some(event) = initial.pop_front() { event } else {
            match receiver.recv().await { Ok(event)=>event,Err(_)=>return None }
        };
        Some((Ok::<_,Infallible>(Event::default().event("runtime").data(serde_json::to_string(&event).unwrap())),(receiver,initial)))
    });
    Sse::new(stream).keep_alive(KeepAlive::new().interval(Duration::from_secs(10))).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn healthy_follows_python_rust_failed() {
        assert!(!healthy(true,&json!({"error":"terminal_facts","view":{}})));
        assert!(healthy(true,&json!({"error":"receipt_scan","view":{}})));
        assert!(!healthy(true,&json!({"error":"queue_io","view":{}})));
        assert!(healthy(true,&json!({"error":null,"view":{}})));
        assert!(!healthy(false,&json!({"error":null,"view":{"alive":false}})));
        assert!(!healthy(false,&json!({"error":"cano_exited","view":{"alive":true}})));
        assert!(healthy(false,&json!({"error":null,"view":{"alive":true}})));
        assert!(healthy(false,&json!({"error":"","view":{}})));
    }

    #[test]
    fn terminal_and_headless_sources_do_not_overlap() {
        let value = json!({"name":"session","key":"key","provider":"codex","headless":false,
            "meta":{"key":"key","cano":{"pid":42,"escuta":"tcp:127.0.0.1:1","token":"test","versao":2}},
            "jsonl":"chat.jsonl","projection_dir":"projection","state_path":"state","lock_path":"lock","generation":1});
        assert!(descriptor(&value,false).is_err());
        let mut headless = value;
        headless["headless"] = json!(true);
        assert!(descriptor(&headless,false).is_ok());
    }

    fn codex_terminal_value() -> Value {
        json!({"name":"cx-proof","key":"codex-key","provider":"codex","headless":false,
            "meta":{"key":"codex-key","thread_id":"thread-1","endpoint":"ws://127.0.0.1:43210","app_pid":12345,
                "terminal":{"name":"cx-proof","pane":"%7","conversation":"thread-1","generation":1,"created":1,"mux_argv":["tmux"],"windows":false,"clipboard_lock_path":null}},
            "jsonl":"","projection_dir":"projection","state_path":"state","lock_path":"lock","generation":1})
    }

    #[test]
    fn codex_terminal_descriptor_is_its_own_target_and_needs_no_rollout() {
        let Ok(Target::CodexTerminal(target)) = descriptor(&codex_terminal_value(),false) else { panic!("descritor do Codex com terminal") };
        assert_eq!((target.endpoint.as_str(),target.app_pid,target.thread_id.as_str()),("ws://127.0.0.1:43210",12345,"thread-1"));
        assert!(target.transcript.is_none(),"rollout ausente é válido");
        let runtime = target.runtime_target();
        assert_eq!((runtime.binding.pid,runtime.binding.escuta.as_str()),(0,""),"endereço e pid não viram cano");
        assert_eq!(runtime.metadata["headless"],false);
    }

    #[test]
    fn codex_terminal_descriptor_refusals_have_codes() {
        let refused = |change:&dyn Fn(&mut Value)| { let mut value = codex_terminal_value(); change(&mut value); descriptor(&value,false).err().map(|e|e.code) };
        assert_eq!(refused(&|v|v["meta"]["endpoint"] = json!("ws://10.1.2.3:43210")).as_deref(),Some("codex_endpoint"));
        assert_eq!(refused(&|v|v["meta"]["endpoint"] = json!("ws://localhost:43210")).as_deref(),Some("codex_endpoint"));
        assert_eq!(refused(&|v|v["meta"]["thread_id"] = json!("")).as_deref(),Some("codex_thread"));
        assert_eq!(refused(&|v|v["meta"]["app_pid"] = json!(0)).as_deref(),Some("codex_app_pid"));
        assert_eq!(refused(&|v|v["meta"]["key"] = json!("other-key")).as_deref(),Some("descriptor_binding"));
        assert_eq!(refused(&|v|v["meta"]["terminal"]["conversation"] = json!("thread-2")).as_deref(),Some("terminal_binding"));
        assert_eq!(refused(&|v|v["meta"]["cano"] = json!({"pid":1})).as_deref(),Some("descriptor_provider"));
    }

    #[test]
    fn closing_an_old_life_does_not_unmark_the_live_owner_of_the_same_name() {
        let registry = RuntimeRegistry::new("127.0.0.1:9".parse().unwrap(),"test".into(),"instance".into());
        registry.mark_codex_owner("cx","old-key",1,true);
        registry.mark_codex_owner("cx","new-key",1,true);
        registry.mark_codex_owner("cx","old-key",1,false);
        assert!(registry.owns_codex_terminal("cx"),"a vida nova segue dona do estado");
        registry.mark_codex_owner("cx","new-key",2,false);
        assert!(registry.owns_codex_terminal("cx"),"outra geração da mesma chave também não desmarca");
        registry.mark_codex_owner("cx","new-key",1,false);
        assert!(!registry.owns_codex_terminal("cx"));
    }

    #[test]
    fn codex_terminal_sidecar_with_null_cano_is_accepted() {
        // Forma do sidecar real do Codex com terminal: `cano` nulo e os campos de sempre.
        let mut value = codex_terminal_value();
        for (key,field) in [("cano",Value::Null),("headless",json!(false)),("name",json!("cx-proof")),("cwd",json!("/work")),("created",json!(1.5))] {
            value["meta"][key] = field;
        }
        let Ok(Target::CodexTerminal(target)) = descriptor(&value,false) else { panic!("cano nulo é ausência de cano") };
        assert_eq!(target.runtime_target().created,1.5);
        assert_eq!(target.runtime_target().binding.pid,0);
    }

    #[test]
    fn launch_accepts_a_session_without_cano() {
        let value = json!({"name":"session","key":"key","provider":"codex","headless":true,"meta":{"key":"key","cano":null},
            "jsonl":"","projection_dir":"projection","state_path":"state","lock_path":"lock","generation":1,"sidecar_dir":"dir"});
        assert!(descriptor(&value,false).is_err(),"sem `launch`, sem cano não abre");
        let Ok(Target::Headless(target,sidecar_dir)) = descriptor(&value,true) else { panic!("subida sem cano gravado") };
        assert_eq!((target.binding.pid,target.binding.versao),(0,2));
        assert_eq!(sidecar_dir.as_deref(),Some(std::path::Path::new("dir")));
    }

    #[test]
    fn held_empty_live_channel_survives_another_lookup() {
        // O `open` pega o canal e o ator só escreve no primeiro passo: outra procura no meio não o apaga.
        let registry = RuntimeRegistry::new("127.0.0.1:9".parse().unwrap(),"test".into(),"instance".into());
        let held = registry.live_sender("a");
        let _other = registry.live_sender("b");
        held.send_replace(Some(Arc::new(LiveState::default())));
        assert!(registry.live("a").borrow().is_some(),"o feed lê o mesmo canal que o ator segura");
        drop(held);
        registry.live_sender("a").send_replace(None);
        let _ = registry.live_sender("c");
        assert!(!registry.live.lock().unwrap().contains_key("a"),"vazio, sem dono e sem receptor: sai");
    }

    #[tokio::test]
    async fn failed_codex_open_shows_its_error_until_the_next_open() {
        let dir = tempfile::tempdir().unwrap();
        let registry = RuntimeRegistry::new("127.0.0.1:9".parse().unwrap(),"test".into(),"instance".into());
        let rx = registry.live("cx");
        // Cano gravado que não atende: a conexão falha.
        let target = RuntimeTarget { key:"k".into(),generation:1,name:"cx".into(),provider:"codex".into(),
            metadata:json!({"name":"cx","key":"k","headless":true}),
            binding:CanoBinding { pid:42,escuta:"tcp:127.0.0.1:9".into(),token:"t".into(),versao:2 },
            lease_path:dir.path().join("q.lock"),state_path:dir.path().join("q.json"),projection_dir:dir.path().join("projection"),
            transcript:dir.path().join("rollout.jsonl"),created:0.0 };
        let error = registry.open(target.clone()).await.unwrap_err();
        assert_eq!(rx.borrow().as_ref().and_then(|s|s.error.clone()).map(|(code,_)|code),Some(error.code.clone()));
        // Pedido torto (provedor de fora) não acende problema.
        registry.live_sender("cx").send_replace(None);
        let other = RuntimeTarget { provider:"pi".into(),..target };
        assert_eq!(registry.open(other).await.unwrap_err().code,"runtime_provider");
        assert!(rx.borrow().is_none());
    }

    #[tokio::test]
    async fn close_keeps_the_error_of_a_life_that_failed() {
        let registry = RuntimeRegistry::new("127.0.0.1:9".parse().unwrap(),"test".into(),"instance".into());
        let rx = registry.live("a");
        let failed = LiveState { error:Some(("queue_io".into(),"fila recusou".into())),..Default::default() };
        registry.live_sender("a").send_replace(Some(Arc::new(failed)));
        registry.clear_live("a").await;
        assert!(rx.borrow().as_ref().is_some_and(|s|s.error.is_some()),"o hub segue mostrando a falha depois do close");
        registry.live_sender("a").send_replace(Some(Arc::new(LiveState::default())));
        registry.clear_live("a").await;
        assert!(rx.borrow().is_none(),"vida que acabou bem: o canal esvazia");
    }

    #[tokio::test]
    async fn one_sse_reader_multiple_keys() {
        let registry = RuntimeRegistry::new("127.0.0.1:9".parse().unwrap(),"test".into(),"instance".into());
        let mut receiver = registry.subscribe();
        assert_eq!(registry.events.receiver_count(),1);
        for key in ["claude-key","codex-key"] {
            assert!(registry.events.send(RuntimeEvent { key:key.into(),generation:1,revision:1,channel:"state".into(),data:json!({}) }).is_ok());
        }
        assert_eq!(receiver.recv().await.unwrap().key,"claude-key");
        assert_eq!(receiver.recv().await.unwrap().key,"codex-key");
    }
}
