//! Codex com terminal adotado: a TUI segue no tmux e o Rust só se conecta, por WebSocket de loopback,
//! ao app-server que já existe. Nada aqui sobe, religa ou mata processo: o dono dele é o ciclo de vida
//! que o abriu.
use super::cano::IoTasks;
use super::protocol::{CanoBinding,RuntimeError,RuntimeTarget};
use super::websocket::WebSocketConnection;
use serde_json::{Value,json};
use std::net::SocketAddr;
use std::sync::{Arc,Mutex};
use tokio::sync::{mpsc,watch};
use tokio::task::JoinHandle;

/// Problema da sessão enquanto o socket de controle está fora; a TUI segue respondendo no terminal. Código
/// já traduzido em todas as telas; o que aconteceu vai no detalhe.
pub const DISCONNECTED:&str = "runtime_falhou";

/// Espera da reconexão: primeira, multiplicador e teto (segundos).
const RECONNECT_FIRST:f64 = 1.0;
const RECONNECT_FACTOR:f64 = 1.5;
const RECONNECT_MAX:f64 = 10.0;

#[derive(Clone,Debug,PartialEq)]
pub struct CodexTerminalTarget {
    pub key: String,
    pub generation: u64,
    pub name: String,
    pub endpoint: String,
    pub app_pid: u32,
    pub thread_id: String,
    pub terminal: crate::terminal_input::TerminalBinding,
    pub metadata: serde_json::Value,
    pub transcript: Option<std::path::PathBuf>,
    pub lease_path: std::path::PathBuf,
    pub state_path: std::path::PathBuf,
    pub projection_dir: std::path::PathBuf,
}

impl CodexTerminalTarget {
    /// Mesma vida: o que identifica o processo, a conversa e os arquivos. O resto da metadata muda sem trocar a sessão.
    pub fn same_life(&self,other:&Self) -> bool {
        (self.generation,&self.endpoint,self.app_pid,&self.thread_id,&self.terminal,&self.transcript,&self.lease_path,&self.state_path,&self.projection_dir)
            == (other.generation,&other.endpoint,other.app_pid,&other.thread_id,&other.terminal,&other.transcript,&other.lease_path,&other.state_path,&other.projection_dir)
    }

    /// Metadata do motor: sempre com terminal, na conversa e na chave do descritor.
    pub fn engine_metadata(&self) -> Value {
        let mut metadata = if self.metadata.is_object() { self.metadata.clone() } else { json!({}) };
        metadata["headless"] = json!(false);
        metadata["name"] = json!(self.name);
        metadata["key"] = json!(self.key);
        metadata["thread_id"] = json!(self.thread_id);
        metadata
    }

    /// Alvo do ator. Sem cano: pid 0 é "nenhum", e sem `launch` o ator nunca sobe nem mata nada.
    pub fn runtime_target(&self) -> RuntimeTarget {
        RuntimeTarget { key:self.key.clone(),generation:self.generation,name:self.name.clone(),provider:"codex".into(),
            metadata:self.engine_metadata(),binding:CanoBinding { pid:0,escuta:String::new(),token:String::new(),versao:2 },
            lease_path:self.lease_path.clone(),state_path:self.state_path.clone(),projection_dir:self.projection_dir.clone(),
            // Rollout ausente é válido: o motor aprende o caminho depois do primeiro turno.
            transcript:self.transcript.clone().unwrap_or_default(),
            created:self.metadata["created"].as_f64().unwrap_or(self.terminal.created as f64) }
    }
}

/// Só `ws://<IP de loopback literal>:<porta>`. Nome nunca é resolvido: nenhum descritor leva o Rust a outra máquina.
pub fn loopback_endpoint(endpoint:&str) -> Result<SocketAddr,RuntimeError> {
    let refused = ||RuntimeError::new("codex_endpoint","endereço do app-server não é local");
    let address:SocketAddr = endpoint.strip_prefix("ws://").ok_or_else(refused)?.parse().map_err(|_|refused())?;
    if !address.ip().is_loopback() || address.port() == 0 { return Err(refused()); }
    Ok(address)
}

#[derive(Clone,Copy,Debug,PartialEq,Eq)]
pub enum AppServer { Ours, Dead, Foreign }

/// O mesmo critério do `matar_app_server` do Python: o pid tem que ser o `app-server` deste endereço.
pub fn app_server(pid:u32,endpoint:&str) -> AppServer {
    match super::process::argv(pid) {
        None => AppServer::Dead,
        Some(argv) if argv.iter().any(|a|a == "app-server") && argv.iter().any(|a|a == endpoint) => AppServer::Ours,
        Some(_) => AppServer::Foreign,
    }
}

async fn app_server_of(pid:u32,endpoint:&str) -> AppServer {
    let endpoint = endpoint.to_owned();
    tokio::task::spawn_blocking(move||app_server(pid,&endpoint)).await.unwrap_or(AppServer::Dead)
}

/// Admissão: endereço local, conversa identificada e o pid comprovado como o app-server do endereço.
pub async fn verify(target:&CodexTerminalTarget) -> Result<(),RuntimeError> {
    loopback_endpoint(&target.endpoint)?;
    if target.thread_id.is_empty() { return Err(RuntimeError::new("codex_thread","Codex com terminal sem conversa identificada")); }
    match app_server_of(target.app_pid,&target.endpoint).await {
        AppServer::Ours => Ok(()),
        _ => Err(RuntimeError::new("codex_app_pid","o pid informado não é o app-server deste endereço")),
    }
}

/// Vínculo adotado como o registro o tem agora; `None` depois de fechar ou transferir a sessão.
#[derive(Clone,Default)]
pub struct AdoptionCell(Arc<Mutex<Option<(String,u32)>>>);

impl AdoptionCell {
    pub fn new(endpoint:&str,app_pid:u32) -> Self { Self(Arc::new(Mutex::new(Some((endpoint.to_owned(),app_pid))))) }
    pub fn current(&self) -> Option<(String,u32)> { self.0.lock().unwrap_or_else(|e|e.into_inner()).clone() }
    /// Antes de ceder a posse: tentativa em voo que termine depois disto não vale.
    pub fn revoke(&self) { *self.0.lock().unwrap_or_else(|e|e.into_inner()) = None; }
}

/// O que o ator precisa para reconectar sem o registro: o endereço e o pid da abertura, e a célula viva.
#[derive(Clone)]
pub struct Adoption { pub endpoint:String, pub app_pid:u32, pub cell:AdoptionCell }

impl Adoption {
    fn still_ours(&self) -> bool { self.cell.current().is_some_and(|(endpoint,pid)|endpoint == self.endpoint && pid == self.app_pid) }
}

pub enum Attempt {
    Connected(WebSocketConnection),
    /// O mesmo processo segue vivo: tenta de novo depois da espera.
    Retry(RuntimeError),
    /// Vínculo trocado, sessão fechada ou processo morto: espera o ciclo de vida, sem outro app-server.
    Gone(RuntimeError),
}

/// Uma tentativa: revalida vínculo, endereço e processo antes de conectar, e o vínculo de novo depois.
pub async fn reconnect(adoption:&Adoption) -> Attempt {
    if !adoption.still_ours() { return Attempt::Gone(RuntimeError::new("codex_adoption_changed","a sessão trocou de dono ou de app-server")); }
    if let Err(error) = loopback_endpoint(&adoption.endpoint) { return Attempt::Gone(error); }
    if app_server_of(adoption.app_pid,&adoption.endpoint).await != AppServer::Ours {
        return Attempt::Gone(RuntimeError::new("codex_app_server_gone","o app-server da sessão não está mais vivo neste endereço"));
    }
    match WebSocketConnection::connect(&adoption.endpoint).await {
        Ok(_) if !adoption.still_ours() => Attempt::Gone(RuntimeError::new("codex_adoption_changed","a sessão trocou de dono durante a reconexão")),
        Ok(connection) => Attempt::Connected(connection),
        Err(error) => Attempt::Retry(error),
    }
}

/// Estado da reconexão do ator terminal: uma tarefa em voo, espera crescente e a época do transporte
/// em que a tentativa nasceu. Separado da religação do cano e da retentativa da assinatura.
#[derive(Default)]
pub(crate) struct Reconnect {
    pub(crate) next_at:Option<f64>,
    pub(crate) task:Option<JoinHandle<Attempt>>,
    pub(crate) epoch:u64,
    wait:Option<f64>,
}

impl Reconnect {
    /// Próxima espera: 1 s, ×1,5, até 10 s.
    pub(crate) fn schedule(&mut self,now:f64) {
        let wait = self.wait.map_or(RECONNECT_FIRST,|wait|(wait*RECONNECT_FACTOR).min(RECONNECT_MAX));
        self.wait = Some(wait);
        self.next_at = Some(now + wait);
    }
    pub(crate) fn connected(&mut self) { self.wait = None; self.next_at = None; }
    /// Fechamento ou transferência: timer e tentativa saem antes de ceder a posse.
    pub(crate) fn cancel(&mut self) {
        self.next_at = None;
        if let Some(task) = self.task.take() { task.abort(); }
    }
}

/// Transporte que já caiu: escrever nele falha na hora e ele não produz eventos.
pub(super) fn closed_io() -> IoTasks {
    let (writer,_) = mpsc::channel(1);
    let (ui_writer,_) = mpsc::channel(1);
    let (_,events) = mpsc::channel(1);
    IoTasks { writer,ui_writer,events,stop:watch::channel(false).0,reader_task:tokio::spawn(async {}),writer_task:tokio::spawn(async {}) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_literal_loopback_address_is_accepted() {
        assert!(loopback_endpoint("ws://127.0.0.1:43210").is_ok());
        assert!(loopback_endpoint("ws://[::1]:43210").is_ok());
        for refused in ["ws://localhost:43210","ws://10.0.0.5:43210","ws://192.168.1.2:1","wss://127.0.0.1:43210",
            "ws://127.0.0.1:0","ws://127.0.0.1:43210/x","127.0.0.1:43210","ws://example.com:80","ws://127.0.0.1"] {
            assert_eq!(loopback_endpoint(refused).unwrap_err().code,"codex_endpoint","{refused}");
        }
    }

    #[test]
    fn reconnect_wait_grows_by_half_up_to_ten_seconds() {
        let mut reconnect = Reconnect::default();
        let mut waits = Vec::new();
        for _ in 0..9 { reconnect.schedule(0.0); waits.push(reconnect.next_at.unwrap()); }
        assert_eq!(&waits[..3],&[1.0,1.5,2.25]);
        assert_eq!(*waits.last().unwrap(),10.0);
        reconnect.connected();
        reconnect.schedule(5.0);
        assert_eq!(reconnect.next_at,Some(6.0),"conexão boa volta à primeira espera");
    }

    #[test]
    fn this_test_process_is_not_an_app_server() {
        assert_eq!(app_server(std::process::id(),"ws://127.0.0.1:1"),AppServer::Foreign);
    }
}
