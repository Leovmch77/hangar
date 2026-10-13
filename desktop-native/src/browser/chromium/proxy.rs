//! `GET /cdp/browser?chave=`: CDP do nível do navegador (o que o `connectOverCDP` do Playwright fala) para o navegador
//! de UMA sessão, no mesmo servidor e com o mesmo token do `/cmd`. O Chromium é um só para todas as sessões, então o
//! cliente não fala com ele direto: enxerga um navegador com uma página só, a visível no painel da sessão.
//!
//! - Ids: cada comando do cliente sai com um id novo do pipe e a resposta volta com o id dele; nunca colide com o app.
//! - Sessões: o cliente só usa as sessões que abriu aqui e as filhas delas (iframe, worker); os eventos delas vão só
//!   a ele (`pipe::Port::tap`).
//! - Página: `Target.setAutoAttach`, `Target.createTarget` e o contexto novo (`Target.createBrowserContext`, fictício)
//!   ligam o cliente à página visível; fechar a página (`Target.closeTarget`, `Page.close`) só solta a sessão dele.
//!   O navegador nativo não tem abas: a pessoa vê a execução no painel.
//! - Saída: as sessões do cliente se soltam; a página continua.
use std::time::Duration;

use futures::channel::oneshot;
use serde_json::{Value, json};
use tokio::{io::{AsyncRead, AsyncWrite}, net::TcpStream};

use super::pipe::Port;
use crate::{browser::server::{Request, respond}, ws::{self, Error}};

/// Comandos que, numa sessão de página, mexeriam além dela: no navegador inteiro, em outras sessões ou nos cookies
/// do perfil da pessoa.
const DENIED: [&str; 13] = [
    "Browser.close", "Browser.crash", "Browser.crashGpuProcess", "Browser.setDownloadBehavior", "Browser.setWindowBounds",
    "Target.createTarget", "Target.closeTarget", "Target.createBrowserContext", "Target.disposeBrowserContext",
    "Target.attachToTarget", "Target.exposeDevToolsProtocol", "Page.crash", "Network.clearBrowserCookies",
];
const CONTEXT: &str = "hangar-context-";

pub struct Proxy {
    port: Port,
    tap: u64,
    /// A página visível do painel.
    target: String,
    /// A fila única do socket: eventos do pipe, respostas e eventos montados aqui, na ordem em que saem. Uma fila só
    /// porque a ordem importa: o `detachedFromTarget` de uma sessão tem de chegar antes do `attachedToTarget` da
    /// seguinte na mesma página, ou o Playwright fecha a página nova.
    answers: async_channel::Sender<String>,
    /// Sessão do cliente na página e o contexto fictício em que ela aparece para ele.
    attached: Option<(String, Option<String>)>,
    contexts: Vec<String>,
    next_context: u64,
    closing: bool,
}

/// Upgrade já conferido (rota, token, chave): pede o pipe da sessão à interface e repassa até alguém fechar.
pub async fn serve(mut stream: TcpStream, ws_key: &str, key: String, requests: async_channel::Sender<Request>) {
    let (tx, rx) = oneshot::channel();
    if requests.send(Request::Pipe { key: key.clone(), reply: tx }).await.is_err() {
        return respond(&mut stream, 500, "erro: o app nativo esta fechando").await;
    }
    let (port, target) = match tokio::time::timeout(Duration::from_secs(10), rx).await {
        Ok(Ok(Ok(found))) => found,
        Ok(Ok(Err(text))) => return respond(&mut stream, 404, &text).await,
        _ => return respond(&mut stream, 500, "erro: o app nao respondeu").await,
    };
    let accept = format!("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {}\r\n\r\n",
        ws::accept_key(ws_key));
    if tokio::io::AsyncWriteExt::write_all(&mut stream, accept.as_bytes()).await.is_err() { return; }
    if let Err(e) = run(&mut stream, port, target).await { eprintln!("[nav] cliente CDP de {key} caiu: {e}"); }
}

/// Liga o cliente ao pipe, repassa e, na saída por qualquer motivo, solta as sessões dele.
pub async fn run(stream: &mut (impl AsyncRead + AsyncWrite + Unpin), port: Port, target: String) -> Result<(), Error> {
    // ponytail: filas sem limite; um cliente que não lê acumula eventos até cair.
    let (answers, out) = async_channel::unbounded();
    let tap = port.tap(answers.clone());
    let mut proxy = Proxy { port: port.clone(), tap, target, answers, attached: None, contexts: Vec::new(), next_context: 1, closing: false };
    let result = proxy.pump(stream, out).await;
    for session in port.untap(tap) { drop(port.call(None, "Target.detachFromTarget", json!({"sessionId": session}))); }
    result
}

impl Proxy {
    async fn pump(&mut self, stream: &mut (impl AsyncRead + AsyncWrite + Unpin), out: async_channel::Receiver<String>) -> Result<(), Error> {
        let (mut reader, mut writer) = tokio::io::split(stream);
        let mut message = ws::Message::default();
        loop {
            let frame = {
                let next = ws::read_client_frame(&mut reader);
                tokio::pin!(next);
                loop {
                    tokio::select! {
                        frame = &mut next => break frame?,
                        text = out.recv() => match text {
                            Ok(text) => {
                                ws::write_server_frame(&mut writer, 1, text.as_bytes()).await?;
                                if self.closing && out.is_empty() { return ws::write_server_frame(&mut writer, 8, &1000u16.to_be_bytes()).await; }
                            }
                            // O Chromium caiu.
                            Err(_) => return ws::write_server_frame(&mut writer, 8, &1011u16.to_be_bytes()).await,
                        },
                    }
                }
            };
            match frame.opcode {
                8 => { let _ = ws::write_server_frame(&mut writer, 8, &frame.data).await; return Ok(()); }
                9 => ws::write_server_frame(&mut writer, 10, &frame.data).await?,
                10 => {}
                _ => if let Some(bytes) = message.push(frame)? && let Ok(v) = serde_json::from_slice::<Value>(&bytes) {
                    self.command(v).await;
                },
            }
        }
    }

    fn answer(&self, id: &Value, session: Option<&str>, result: Result<Value, String>) {
        let _ = self.answers.force_send(reply(id, session, result));
    }

    /// Repassa sem esperar: a resposta entra na fila quando chegar, e o comando seguinte já pode sair.
    fn forward(&self, id: Value, session: Option<String>, method: &str, params: Value) {
        let (call, answers) = (self.port.call(session.as_deref(), method, params), self.answers.clone());
        tokio::spawn(async move { let _ = answers.send(reply(&id, session.as_deref(), call.await)).await; });
    }

    async fn command(&mut self, v: Value) {
        let id = v["id"].clone();
        let method = v["method"].as_str().unwrap_or_default().to_owned();
        let mut params = if v["params"].is_object() { v["params"].clone() } else { json!({}) };
        let outside = |what: &str| Err(format!("{what} fora do navegador desta sessao"));
        if let Some(session) = v["sessionId"].as_str().map(str::to_owned) {
            let result = if !self.port.owns(self.tap, &session) {
                outside("sessao")
            } else if method == "Page.close" {
                self.detach(&session).await;
                Ok(json!({}))
            } else if method == "Browser.setWindowBounds" {
                // O tamanho da janela é do painel; o viewport do cliente vem pelo `Emulation`.
                Ok(json!({}))
            } else if DENIED.contains(&method.as_str()) {
                outside(&method)
            } else {
                return self.forward(id, Some(session), &method, params);
            };
            return self.answer(&id, Some(&session), result);
        }
        let target = params["targetId"].as_str().map(str::to_owned);
        let visible = target.as_deref().is_none_or(|t| t == self.target);
        let fake = params["browserContextId"].as_str().filter(|c| self.contexts.iter().any(|f| f == c)).map(str::to_owned);
        let result = match method.as_str() {
            "Browser.getVersion" => return self.forward(id, None, &method, params),
            "Target.getTargetInfo" if visible => return self.forward(id, None, &method, params),
            "Browser.getWindowForTarget" if visible => {
                params["targetId"] = self.target.clone().into();
                return self.forward(id, None, &method, params);
            }
            "Target.detachFromTarget" if params["sessionId"].as_str().is_some_and(|s| self.port.owns(self.tap, s)) => {
                return self.forward(id, None, &method, params);
            }
            "Target.setAutoAttach" => self.attach(None).await.map(|_| json!({})),
            "Target.attachToTarget" if visible && target.is_some() => self.attach(None).await.map(|s| json!({"sessionId": s})),
            "Target.createTarget" if params["browserContextId"].is_null() || fake.is_some() => {
                let created = self.attach(fake).await;
                if let (Ok(session), Some(url)) = (&created, params["url"].as_str().filter(|u| !u.is_empty() && *u != "about:blank")) {
                    drop(self.port.call(Some(session), "Page.navigate", json!({"url": url})));
                }
                created.map(|_| json!({"targetId": self.target}))
            }
            "Target.getTargets" => match self.port.call(None, "Target.getTargetInfo", json!({"targetId": self.target})).await {
                Ok(info) => Ok(json!({"targetInfos": [info["targetInfo"]]})),
                Err(e) => Err(e),
            },
            "Target.closeTarget" if visible && target.is_some() => {
                if let Some((session, _)) = self.attached.take() { self.detach(&session).await; }
                Ok(json!({"success": true}))
            }
            "Target.createBrowserContext" => {
                let context = format!("{CONTEXT}{}", self.next_context);
                self.next_context += 1;
                self.contexts.push(context.clone());
                Ok(json!({"browserContextId": context}))
            }
            "Target.disposeBrowserContext" if fake.is_some() => {
                if self.attached.as_ref().is_some_and(|(_, c)| *c == fake) && let Some((session, _)) = self.attached.take() {
                    self.detach(&session).await;
                }
                self.contexts.retain(|c| Some(c) != fake.as_ref());
                Ok(json!({}))
            }
            "Target.getBrowserContexts" => Ok(json!({"browserContextIds": self.contexts})),
            // O download segue negado pelo app e o tamanho da janela é do painel (o viewport do cliente vem pelo
            // `Emulation`); foco e descoberta não têm o que mudar numa página só.
            "Target.setDiscoverTargets" | "Target.activateTarget" | "Browser.setDownloadBehavior" | "Browser.setWindowBounds" => Ok(json!({})),
            "Browser.close" => { self.closing = true; Ok(json!({})) }
            _ => outside(&method),
        };
        self.answer(&id, None, result);
    }

    /// Sessão do cliente na página visível, aberta se ainda não houver (ou se ele trocou de contexto). O
    /// `Target.attachedToTarget` sai antes da resposta, como no auto-attach do Chromium.
    async fn attach(&mut self, context: Option<String>) -> Result<String, String> {
        if let Some((session, current)) = self.attached.take() {
            if self.port.owns(self.tap, &session) {
                if current == context { self.attached = Some((session.clone(), current)); return Ok(session); }
                self.detach(&session).await;
            }
        }
        let mut info = self.port.call(None, "Target.getTargetInfo", json!({"targetId": self.target})).await?["targetInfo"].take();
        let attached = self.port.call(None, "Target.attachToTarget", json!({"targetId": self.target, "flatten": true})).await?;
        let session = attached["sessionId"].as_str().ok_or("attachToTarget sem sessionId")?.to_owned();
        self.port.adopt(self.tap, &session);
        if let Some(context) = &context { info["browserContextId"] = context.as_str().into(); }
        let event = json!({"method": "Target.attachedToTarget", "params": {"sessionId": session, "targetInfo": info, "waitingForDebugger": false}});
        let _ = self.answers.force_send(event.to_string());
        self.attached = Some((session.clone(), context));
        Ok(session)
    }

    /// Solta a sessão; o `Target.detachedFromTarget` que o Chromium manda chega ao cliente pelo pipe.
    async fn detach(&self, session: &str) {
        if let Err(e) = self.port.call(None, "Target.detachFromTarget", json!({"sessionId": session})).await {
            eprintln!("[nav] sessao do cliente CDP nao soltou: {e}");
        }
    }
}

fn reply(id: &Value, session: Option<&str>, result: Result<Value, String>) -> String {
    let mut reply = match result {
        Ok(result) => json!({"id": id, "result": result}),
        Err(message) => json!({"id": id, "error": {"code": -32000, "message": message}}),
    };
    if let Some(session) = session { reply["sessionId"] = session.into(); }
    reply.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    fn client_frame(opcode: u8, data: &[u8]) -> Vec<u8> {
        let mut wire = vec![0x80 | opcode];
        match data.len() {
            n if n < 126 => wire.push(0x80 | n as u8),
            n => { wire.push(0x80 | 126); wire.extend_from_slice(&(n as u16).to_be_bytes()); }
        }
        wire.extend_from_slice(&[0, 0, 0, 0]);
        wire.extend_from_slice(data);
        wire
    }

    async fn server_text(socket: &mut (impl AsyncRead + Unpin)) -> (u8, Value) {
        let mut head = [0; 2];
        socket.read_exact(&mut head).await.unwrap();
        let len = match head[1] & 127 { 126 => usize::from(socket.read_u16().await.unwrap()), n => usize::from(n) };
        let mut data = vec![0; len];
        socket.read_exact(&mut data).await.unwrap();
        (head[0] & 15, serde_json::from_slice(&data).unwrap_or(Value::Null))
    }

    /// O que o proxy escreve no pipe, lido numa thread (o leitor do pipe bloqueia).
    fn sent(reader: std::io::PipeReader) -> async_channel::Receiver<Value> {
        let (tx, rx) = async_channel::unbounded();
        std::thread::spawn(move || {
            let mut reader = BufReader::new(reader);
            let mut buffer = Vec::new();
            while reader.read_until(0, &mut buffer).is_ok_and(|n| n > 0) {
                buffer.pop();
                if tx.send_blocking(serde_json::from_slice(&buffer).unwrap()).is_err() { break; }
                buffer.clear();
            }
        });
        rx
    }

    async fn next(rx: &async_channel::Receiver<Value>) -> Value {
        tokio::time::timeout(Duration::from_secs(5), rx.recv()).await.expect("o proxy nao escreveu no pipe").unwrap()
    }

    async fn send(client: &mut (impl AsyncWrite + Unpin), v: Value) { client.write_all(&client_frame(1, v.to_string().as_bytes())).await.unwrap(); }

    /// Liga o cliente à página `T` como o `connectOverCDP` faz, respondendo pelo Chromium; devolve a sessão `C1`.
    async fn connect(port: &Port, pipe: &async_channel::Receiver<Value>, client: &mut (impl AsyncRead + AsyncWrite + Unpin)) {
        send(client, json!({"id": 1, "method": "Target.setAutoAttach", "params": {"autoAttach": true, "waitForDebuggerOnStart": true, "flatten": true}})).await;
        let info = next(pipe).await;
        assert_eq!((info["method"].as_str(), &info["params"]["targetId"]), (Some("Target.getTargetInfo"), &json!("T")));
        port.inject(json!({"id": info["id"], "result": {"targetInfo": {"targetId": "T", "type": "page", "url": "about:blank"}}}));
        let attach = next(pipe).await;
        assert_eq!((attach["method"].as_str(), &attach["params"]), (Some("Target.attachToTarget"), &json!({"targetId": "T", "flatten": true})));
        port.inject(json!({"id": attach["id"], "result": {"sessionId": "C1"}}));
        let (_, event) = server_text(client).await;
        assert_eq!((event["method"].as_str(), &event["params"]["sessionId"], &event["params"]["targetInfo"]["targetId"]),
            (Some("Target.attachedToTarget"), &json!("C1"), &json!("T")));
        assert_eq!(server_text(client).await.1, json!({"id": 1, "result": {}}));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn ids_are_remapped_and_events_reach_only_their_client() {
        let (port, reader) = Port::test();
        let pipe = sent(reader);
        let (mut client, mut server) = tokio::io::duplex(64 * 1024);
        let relay = tokio::spawn({ let port = port.clone(); async move { run(&mut server, port, "T".into()).await } });
        connect(&port, &pipe, &mut client).await;

        // O app tem um comando em curso; o do cliente sai com outro id, e cada resposta volta a quem pediu.
        let app = port.call(Some("APP"), "Page.enable", json!({}));
        let app_id = next(&pipe).await["id"].clone();
        send(&mut client, json!({"id": 1, "sessionId": "C1", "method": "Runtime.evaluate", "params": {"expression": "1+1"}})).await;
        let out = next(&pipe).await;
        assert_eq!((out["sessionId"].as_str(), out["method"].as_str()), (Some("C1"), Some("Runtime.evaluate")));
        assert_ne!(out["id"], app_id);
        assert_ne!(out["id"], json!(1));
        port.inject(json!({"id": out["id"], "result": {"result": {"value": 2}}}));
        port.inject(json!({"id": app_id, "result": {"app": true}}));
        assert_eq!(server_text(&mut client).await.1, json!({"id": 1, "sessionId": "C1", "result": {"result": {"value": 2}}}));
        assert_eq!(app.await, Ok(json!({"app": true})));

        // Evento da sessão do app segue para a interface; o da sessão do cliente (e o da filha dele) vai só a ele.
        assert!(port.inject(json!({"method": "Page.frameNavigated", "sessionId": "APP", "params": {}})).is_some());
        assert!(port.inject(json!({"method": "Target.attachedToTarget", "sessionId": "C1", "params": {"sessionId": "W1"}})).is_none());
        assert!(port.inject(json!({"method": "Runtime.consoleAPICalled", "sessionId": "W1", "params": {}})).is_none());
        assert_eq!(server_text(&mut client).await.1["params"]["sessionId"], "W1");
        assert_eq!(server_text(&mut client).await.1["sessionId"], "W1");

        // Sessão alheia e comando de navegador fora do escopo são recusados sem chegar ao pipe.
        send(&mut client, json!({"id": 2, "sessionId": "APP", "method": "Runtime.evaluate"})).await;
        assert!(server_text(&mut client).await.1["error"]["message"].as_str().unwrap().contains("sessao"));
        send(&mut client, json!({"id": 3, "method": "Storage.getCookies"})).await;
        assert!(server_text(&mut client).await.1["error"]["message"].as_str().unwrap().contains("Storage.getCookies"));
        send(&mut client, json!({"id": 4, "sessionId": "C1", "method": "Browser.close"})).await;
        assert_eq!(server_text(&mut client).await.1["id"], 4);
        assert!(pipe.try_recv().is_err());

        client.write_all(&client_frame(8, &1000u16.to_be_bytes())).await.unwrap();
        assert_eq!(server_text(&mut client).await.0, 8);
        relay.await.unwrap().unwrap();
        // Saída: as sessões do cliente se soltam, a página fica.
        let mut gone = vec![next(&pipe).await, next(&pipe).await];
        gone.sort_by_key(|m| m["params"]["sessionId"].as_str().map(str::to_owned));
        for (message, session) in gone.iter().zip(["C1", "W1"]) {
            assert_eq!((message["method"].as_str(), message["params"]["sessionId"].as_str()), (Some("Target.detachFromTarget"), Some(session)));
        }
        assert!(port.inject(json!({"method": "Runtime.consoleAPICalled", "sessionId": "C1", "params": {}})).is_some(), "cliente saiu: nada mais vai a ele");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn new_page_and_close_reuse_the_visible_page() {
        let (port, reader) = Port::test();
        let pipe = sent(reader);
        let (mut client, mut server) = tokio::io::duplex(64 * 1024);
        let relay = tokio::spawn({ let port = port.clone(); async move { run(&mut server, port, "T".into()).await } });
        connect(&port, &pipe, &mut client).await;

        // `newContext()` + `newPage()`: a sessão da página passa para o contexto novo, que é fictício.
        send(&mut client, json!({"id": 5, "method": "Target.createBrowserContext", "params": {"disposeOnDetach": true}})).await;
        let context = server_text(&mut client).await.1["result"]["browserContextId"].as_str().unwrap().to_owned();
        assert!(pipe.try_recv().is_err(), "contexto novo nao nasce no Chromium");
        send(&mut client, json!({"id": 6, "method": "Target.createTarget", "params": {"url": "about:blank", "browserContextId": context}})).await;
        let detach = next(&pipe).await;
        assert_eq!((detach["method"].as_str(), detach["params"]["sessionId"].as_str()), (Some("Target.detachFromTarget"), Some("C1")));
        port.inject(json!({"method": "Target.detachedFromTarget", "params": {"sessionId": "C1"}}));
        port.inject(json!({"id": detach["id"], "result": {}}));
        let info = next(&pipe).await;
        port.inject(json!({"id": info["id"], "result": {"targetInfo": {"targetId": "T", "type": "page"}}}));
        let attach = next(&pipe).await;
        port.inject(json!({"id": attach["id"], "result": {"sessionId": "C2"}}));
        // A página velha fecha para o cliente antes de a nova aparecer.
        assert_eq!(server_text(&mut client).await.1["method"], "Target.detachedFromTarget");
        let (_, event) = server_text(&mut client).await;
        assert_eq!((&event["params"]["sessionId"], &event["params"]["targetInfo"]["browserContextId"]), (&json!("C2"), &json!(context)));
        assert_eq!(server_text(&mut client).await.1, json!({"id": 6, "result": {"targetId": "T"}}));

        // Fechar a página só solta a sessão do cliente: nada de `Target.closeTarget` no pipe.
        send(&mut client, json!({"id": 7, "method": "Target.closeTarget", "params": {"targetId": "T"}})).await;
        let detach = next(&pipe).await;
        assert_eq!((detach["method"].as_str(), detach["params"]["sessionId"].as_str()), (Some("Target.detachFromTarget"), Some("C2")));
        port.inject(json!({"id": detach["id"], "result": {}}));
        assert_eq!(server_text(&mut client).await.1, json!({"id": 7, "result": {"success": true}}));

        drop(client);
        assert!(relay.await.unwrap().is_err());
    }
}
