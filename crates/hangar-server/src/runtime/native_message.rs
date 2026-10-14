//! Recados nativos do Claude Code escritos pelo Rust (o `uds_messaging.py` como referência): o socket
//! de mensagens da sessão, lido do registro do próprio CLI (`<config>/sessions/<pid>.json`), e a caixa
//! de entrada do Rust em `cc-socks/<pid>.sock`. A caixa é o endereço de resposta (`from`) do recado:
//! retido ou recusado, o receptor devolve ali um `peer_message_status`; entrega aceita não devolve nada.
//! Fora do Unix o Claude Code não abre socket, e o recado segue pelo caminho de sempre.
use super::protocol::RuntimeError;
use crate::terminal_input::{NativeMessage,TerminalIo,WriteOutcome};
use serde_json::{Value,json};
use std::collections::{BTreeMap,VecDeque};
use std::path::{Path,PathBuf};
use std::sync::{Arc,Mutex};

/// Recados à espera de recibo guardados; o mais antigo sai primeiro (o `_RECADOS_NATIVOS` do Python).
const EXPECTED_MAX:usize = 500;
/// Teto de um recibo: o quadro do Claude Code tem poucas centenas de bytes.
const RECEIPT_MAX:usize = 64 << 10;

/// Pasta dos sockets do Claude Code. Ausente, ele não fala por socket nesta máquina.
fn socks_dir() -> Option<PathBuf> {
    #[cfg(unix)] {
        let run = std::env::var_os("XDG_RUNTIME_DIR").filter(|dir|!dir.is_empty()).map(PathBuf::from)
            .unwrap_or_else(||PathBuf::from(format!("/run/user/{}",unsafe { libc::getuid() })));
        Some(run.join("cc-socks")).filter(|dir|dir.is_dir())
    }
    #[cfg(not(unix))] { None }
}

/// O socket de inbox da sessão Claude cuja conversa é `session_id`, como o `socket_da_sessao` do
/// Python: o registro do CLI na pasta da conta e no `~/.claude`, processo vivo e socket existente.
/// O socket existir basta: a pasta `cc-socks` não é conferida à parte.
pub fn session_socket(session_id:&str,config_dir:Option<&str>) -> Option<PathBuf> {
    let mut dirs:Vec<PathBuf> = config_dir.filter(|dir|!dir.is_empty()).map(|dir|Path::new(dir).join("sessions")).into_iter().collect();
    if let Some(home) = std::env::home_dir() { dirs.push(home.join(".claude").join("sessions")); }
    socket_in(&dirs,session_id)
}

fn socket_in(dirs:&[PathBuf],session_id:&str) -> Option<PathBuf> {
    let mut seen = Vec::new();
    for dir in dirs {
        let Ok(dir) = dir.canonicalize() else { continue };
        if seen.contains(&dir) || !dir.is_dir() { continue; }
        seen.push(dir.clone());
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().is_none_or(|ext|ext != "json") { continue; }
            let Some(record) = std::fs::read(&path).ok().and_then(|raw|serde_json::from_slice::<Value>(&raw).ok()) else { continue };
            if record["sessionId"].as_str() != Some(session_id) { continue; }
            let Some(socket) = record["messagingSocketPath"].as_str().filter(|socket|!socket.is_empty()) else { continue };
            let pid = record["pid"].as_i64().or_else(||record["pid"].as_str().and_then(|pid|pid.parse().ok()));
            let alive = pid.and_then(|pid|u32::try_from(pid).ok()).is_some_and(|pid|pid > 0 && super::process::probe_alive(pid));
            if alive && Path::new(socket).exists() { return Some(socket.into()); }
        }
    }
    None
}

/// Os `peer_message_status` de uma conexão da caixa: (msg_id, estado).
fn receipts(bytes:&[u8]) -> Vec<(String,String)> {
    String::from_utf8_lossy(bytes).lines().filter_map(|line| {
        let frame:Value = serde_json::from_str(line.trim()).ok()?;
        if frame["type"] != "peer_message_status" && frame["action"] != "peer_message_status" { return None; }
        let id = [&frame["orig_msg_id"],&frame["msg_id"]].into_iter().find_map(|id|id.as_str().filter(|id|!id.is_empty()))?;
        let state = [&frame["state"],&frame["status"]].into_iter().find_map(Value::as_str).unwrap_or("");
        Some((id.to_owned(),state.to_owned()))
    }).collect()
}

/// Recado → (sessão, operação), com a ordem de chegada para descartar o mais antigo.
type Expected = Mutex<(BTreeMap<String,(String,String)>,VecDeque<String>)>;

/// Caixa de entrada dos recibos e os recados que esperam um. Ligada no primeiro recado.
#[derive(Default)]
pub struct Inbox {
    /// Pasta da caixa; sem ela, a do Claude Code (`cc-socks`).
    socks:Option<PathBuf>,
    origin:std::sync::OnceLock<Option<String>>,
    expected:Arc<Expected>,
    /// Some com a caixa: a tarefa que atende o socket acaba quando a caixa é descartada.
    stop:std::sync::OnceLock<tokio::sync::watch::Sender<()>>,
}

/// O que um recibo resolve: a sessão (chave), a operação e o estado devolvido pelo receptor.
pub struct Receipt { pub key:String, pub operation:String, pub state:String }

impl Inbox {
    /// A caixa em outra pasta (testes, para não ligar no `cc-socks` da máquina).
    pub fn in_dir(dir:PathBuf) -> Self { let mut inbox = Self::default(); inbox.socks = Some(dir); inbox }

    /// O `from` dos recados: a caixa ligada em `cc-socks/<pid>.sock`, ou um endereço sem caixa quando ela
    /// não liga (sem `cc-socks`, fora do Unix). Liga uma vez; cada recibo vai a `deliver`.
    pub fn origin(&self,deliver:impl Fn(Receipt) + Send + Sync + 'static) -> String {
        self.origin.get_or_init(||self.socks.clone().or_else(socks_dir).and_then(|dir|self.bind(&dir.join(format!("{}.sock",std::process::id())),deliver)))
            .clone().unwrap_or_else(||format!("uds:hangar-{}",std::process::id()))
    }

    #[cfg(unix)]
    fn bind(&self,path:&Path,deliver:impl Fn(Receipt) + Send + Sync + 'static) -> Option<String> {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::remove_file(path);
        let bound = std::os::unix::net::UnixListener::bind(path).and_then(|listener| {
            std::fs::set_permissions(path,std::fs::Permissions::from_mode(0o600))?;
            listener.set_nonblocking(true)?;
            tokio::net::UnixListener::from_std(listener)
        });
        let listener = match bound {
            Ok(listener) => listener,
            Err(error) => {
                tracing::warn!(path=%path.display(),io_kind=?error.kind(),code="native_inbox_unbound","caixa dos recados nativos não ligou");
                return None;
            }
        };
        let (route,expected) = (Arc::new(deliver),self.expected.clone());
        let (stop,mut stopped) = tokio::sync::watch::channel(());
        let _ = self.stop.set(stop);
        tokio::spawn(async move {
            loop {
                let accepted = tokio::select! {
                    _ = stopped.changed() => return,
                    accepted = listener.accept() => accepted,
                };
                // Falha de recurso (descritores esgotados) não vira laço quente.
                let Ok((mut stream,_)) = accepted else { tokio::time::sleep(std::time::Duration::from_millis(100)).await; continue };
                let (route,expected) = (route.clone(),expected.clone());
                tokio::spawn(async move {
                    use tokio::io::AsyncReadExt;
                    let mut bytes = Vec::new();
                    let mut limited = (&mut stream).take(RECEIPT_MAX as u64);
                    let _ = tokio::time::timeout(std::time::Duration::from_secs(3),limited.read_to_end(&mut bytes)).await;
                    for (id,state) in receipts(&bytes) {
                        match resolve(&expected,&id) {
                            Some((key,operation)) => route(Receipt { key,operation,state }),
                            None => tracing::warn!(msg_id=%id,state=%state,code="native_receipt_unmatched","recibo de recado nativo sem destino"),
                        }
                    }
                });
            }
        });
        Some(format!("uds:{}",path.display()))
    }
    #[cfg(not(unix))]
    fn bind(&self,_:&Path,_:impl Fn(Receipt) + Send + Sync + 'static) -> Option<String> { None }

    /// O recado `message_id` da operação `operation` da sessão `key` espera recibo.
    pub fn expect(&self,message_id:&str,key:&str,operation:&str) {
        let mut guard = self.expected.lock().unwrap_or_else(|e|e.into_inner());
        let (expected,order) = &mut *guard;
        if expected.insert(message_id.into(),(key.into(),operation.into())).is_none() { order.push_back(message_id.into()); }
        while order.len() > EXPECTED_MAX { if let Some(old) = order.pop_front() { expected.remove(&old); } }
    }

}

impl Drop for Inbox {
    /// O socket sai com a caixa: um endereço morto no `cc-socks` não serve a ninguém.
    fn drop(&mut self) {
        if let Some(Some(origin)) = self.origin.get() && let Some(path) = origin.strip_prefix("uds:") { let _ = std::fs::remove_file(path); }
    }
}

/// Fica guardado: o mesmo recado pode voltar retido e depois liberado.
fn resolve(expected:&Expected,message_id:&str) -> Option<(String,String)> {
    expected.lock().unwrap_or_else(|e|e.into_inner()).0.get(message_id).cloned()
}

/// O `native_message` do Python para o Claude sem terminal: escreve o recado no socket da sessão.
/// `not_written` devolve o recado ao caminho de sempre; depois de começar a escrita, nenhuma falha
/// autoriza outro transporte (`unknown`). `route` é o id do recado e o `from` (`native_route`); sem o
/// registro do servidor não há classe nem caixa, e o envio recusa.
pub async fn send(metadata:&Value,text:&str,mode:Option<&str>,route:Option<(String,String)>,io:&dyn TerminalIo) -> Result<Value,RuntimeError> {
    let Some((sender,_)) = crate::terminal_input::message_prefix(text) else { return Ok(json!({"outcome":"not_written","reason":"ordinary_input"})) };
    let (Some(mode),Some((message_id,origin))) = (mode.filter(|mode|matches!(*mode,"bypass" | "prompting")),route) else {
        return Err(RuntimeError::new("native_mode_class_missing","recado sem a classe de modo"));
    };
    let (session_id,config_dir) = (metadata["session_id"].as_str().unwrap_or("").to_owned(),metadata["config_dir"].as_str().map(str::to_owned));
    let socket = tokio::task::spawn_blocking(move||session_socket(&session_id,config_dir.as_deref())).await
        .map_err(|_|RuntimeError::new("native_socket_lookup","busca do socket da sessão falhou"))?;
    let Some(socket) = socket else { return Ok(json!({"outcome":"not_written","reason":"no_socket"})) };
    let native = NativeMessage { socket,origin,sender:sender.into(),mode:mode.into(),message_id:Some(message_id.clone()) };
    let envelope = crate::terminal_input::native_envelope(&native,text,&message_id);
    Ok(match io.socket(&native,envelope).await.unwrap_or(WriteOutcome::Unknown) {
        // `native` é o que a rota devolve ao app (como o resultado do caminho com terminal).
        WriteOutcome::Written => json!({"outcome":"written","msg_id":message_id,"native":true}),
        WriteOutcome::NotWritten => json!({"outcome":"not_written","reason":"socket_refused"}),
        WriteOutcome::Unknown => json!({"outcome":"unknown","msg_id":message_id,"native":true}),
    })
}

#[cfg(all(test,unix))]
mod tests {
    use super::*;

    fn record(dir:&Path,file:&str,value:Value) {
        std::fs::create_dir_all(dir).unwrap();
        std::fs::write(dir.join(file),value.to_string()).unwrap();
    }

    #[test]
    fn the_socket_comes_from_a_live_record_of_the_same_conversation() {
        let tmp = tempfile::tempdir().unwrap();
        let (account,home) = (tmp.path().join("conta/sessions"),tmp.path().join("home/sessions"));
        let socket = tmp.path().join("s.sock");
        std::fs::write(&socket,"").unwrap();
        let me = i64::from(std::process::id());
        record(&account,"1.json",json!({"pid":me,"sessionId":"outra","messagingSocketPath":socket}));
        record(&account,"2.json",json!({"pid":i32::MAX,"sessionId":"sid","messagingSocketPath":socket}));
        record(&account,"3.json",json!({"pid":me,"sessionId":"sid","messagingSocketPath":tmp.path().join("sumiu.sock")}));
        assert_eq!(socket_in(&[account.clone(),home.clone()],"sid"),None,"outra conversa, processo morto ou socket ausente");
        record(&home,"4.json",json!({"pid":me.to_string(),"sessionId":"sid","messagingSocketPath":socket}));
        assert_eq!(socket_in(&[account,home],"sid"),Some(socket));
    }

    #[test]
    fn only_peer_message_status_frames_are_receipts() {
        let bytes = [
            json!({"type":"peer_message_status","orig_msg_id":"m1","state":"retained"}).to_string(),
            "não é json".into(),
            json!({"action":"peer_message_status","msg_id":"m2","status":"refused"}).to_string(),
            json!({"type":"user","msg_id":"m3"}).to_string(),
            json!({"type":"peer_message_status","state":"released"}).to_string(),
        ].join("\n");
        assert_eq!(receipts(bytes.as_bytes()),vec![("m1".into(),"retained".into()),("m2".into(),"refused".into())]);
    }

    #[test]
    fn expected_messages_are_bounded_and_survive_a_first_receipt() {
        let inbox = Inbox::default();
        for n in 0..=EXPECTED_MAX { inbox.expect(&format!("m{n}"),"k","op"); }
        assert_eq!(resolve(&inbox.expected,"m0"),None,"o mais antigo sai");
        assert_eq!(resolve(&inbox.expected,"m1"),Some(("k".into(),"op".into())));
        assert_eq!(resolve(&inbox.expected,"m1"),Some(("k".into(),"op".into())),"retido e depois liberado");
    }

    struct Capture(std::sync::Mutex<Vec<Vec<u8>>>,WriteOutcome);
    impl TerminalIo for Capture {
        fn command<'a>(&'a self,_:crate::terminal_input::CommandRequest) -> crate::terminal_input::IoFuture<'a,crate::terminal_input::CommandOutput> { unreachable!() }
        fn socket<'a>(&'a self,_:&'a NativeMessage,envelope:Vec<u8>) -> crate::terminal_input::IoFuture<'a,WriteOutcome> {
            self.0.lock().unwrap().push(envelope);
            let outcome = self.1;
            Box::pin(async move { Ok(outcome) })
        }
    }

    #[tokio::test]
    async fn send_writes_the_frame_with_the_operation_id_and_the_inbox_address() {
        // Sem `cc-socks` não há socket: o recado volta ao caminho de sempre.
        let io = Capture(Default::default(),WriteOutcome::Written);
        let meta = json!({"session_id":"sid-inexistente","config_dir":null});
        let route = ||Some((crate::terminal_facts::message_id("k","op"),"uds:caixa".to_owned()));
        let plain = send(&meta,"Olá",Some("bypass"),route(),&io).await.unwrap();
        assert_eq!(plain,json!({"outcome":"not_written","reason":"ordinary_input"}));
        for (mode,route) in [(None,route()),(Some("turbo"),route()),(Some("bypass"),None)] {
            assert_eq!(send(&meta,"[de: a] Olá",mode,route,&io).await.unwrap_err().code,"native_mode_class_missing");
        }
        let socketless = send(&meta,"[de: a] Olá",Some("bypass"),route(),&io).await.unwrap();
        assert_eq!(socketless,json!({"outcome":"not_written","reason":"no_socket"}));
        assert!(io.0.lock().unwrap().is_empty(),"nada escrito");
        // O envelope é o do caminho com terminal, com o id da operação e a caixa como resposta.
        let native = NativeMessage { socket:"s".into(),origin:"uds:caixa".into(),sender:"a".into(),mode:"bypass".into(),message_id:None };
        let frame:Value = serde_json::from_slice(&crate::terminal_input::native_envelope(&native,"[de: a] Olá",&crate::terminal_facts::message_id("k","op"))).unwrap();
        assert_eq!((frame["msg_id"].as_str(),frame["from"].as_str()),(Some(crate::terminal_facts::message_id("k","op").as_str()),Some("uds:caixa")));
    }

    #[tokio::test]
    async fn a_receipt_reaches_the_session_that_sent_the_message() {
        let tmp = tempfile::tempdir().unwrap();
        let inbox = Inbox::default();
        let (sender,mut receiver) = tokio::sync::mpsc::unbounded_channel();
        let origin = inbox.bind(&tmp.path().join("caixa.sock"),move|receipt:Receipt|{ let _ = sender.send((receipt.key,receipt.operation,receipt.state)); }).unwrap();
        inbox.expect("m1","k","op");
        let path = origin.strip_prefix("uds:").unwrap();
        for frame in [json!({"type":"peer_message_status","orig_msg_id":"m9","state":"refused"}),json!({"type":"peer_message_status","orig_msg_id":"m1","state":"refused"})] {
            use tokio::io::AsyncWriteExt;
            let mut stream = tokio::net::UnixStream::connect(path).await.unwrap();
            stream.write_all(format!("{frame}\n").as_bytes()).await.unwrap();
            stream.shutdown().await.unwrap();
        }
        let got = tokio::time::timeout(std::time::Duration::from_secs(5),receiver.recv()).await.unwrap().unwrap();
        assert_eq!(got,("k".into(),"op".into(),"refused".into()));
        assert!(receiver.try_recv().is_err(),"recibo sem destino não vai a sessão nenhuma");
    }
}
