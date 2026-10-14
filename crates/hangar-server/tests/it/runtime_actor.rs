use hangar_server::runtime::{actor::*,cano,protocol::*,queue::*};
use serde_json::{Value,json};
use tokio::io::{AsyncBufReadExt,AsyncWriteExt,BufReader};

async fn setup(reply_before_ack:bool) -> (RuntimeHandle,tokio::task::JoinHandle<usize>,tempfile::TempDir) {
    setup_behavior(reply_before_ack,false).await
}

async fn setup_behavior(reply_before_ack:bool,blocked_rpc:bool) -> (RuntimeHandle,tokio::task::JoinHandle<usize>,tempfile::TempDir) {
    setup_mode(reply_before_ack,blocked_rpc,false).await
}

async fn setup_mode(reply_before_ack:bool,blocked_rpc:bool,compound:bool) -> (RuntimeHandle,tokio::task::JoinHandle<usize>,tempfile::TempDir) {
    setup_recovered(reply_before_ack,blocked_rpc,compound,None,false).await
}

async fn setup_recovered(reply_before_ack:bool,blocked_rpc:bool,compound:bool,previous:Option<tempfile::TempDir>,late_reply:bool) -> (RuntimeHandle,tokio::task::JoinHandle<usize>,tempfile::TempDir) {
    let dir = previous.unwrap_or_else(||tempfile::tempdir().unwrap());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let state_path = dir.path().join("key.queue-state.json");
    let state_check = state_path.clone();
    let late_frame = if late_reply {
        let state:State = queue_state(dir.path());
        let request_id = state.operations.values().find(|phase|phase.payload["logical_id"] == "op-1").unwrap().payload["frame"]["id"].clone();
        Some(json!({"type":"cano_output","frame":json!({"id":request_id,"result":{"data":[]}}).to_string()}))
    } else { None };
    let server = tokio::spawn(async move {
        let (stream,_) = listener.accept().await.unwrap();
        let mut reader = BufReader::new(stream);
        let mut header = String::new(); reader.read_line(&mut header).await.unwrap();
        assert_eq!(header,"secret-test\n");
        let snapshot = json!({"type":"cano_snapshot","versao":2,"pid":42,"init":null,"aberto":false,
            "pendentes":[],"ultimo_result":null,"rate_limit":null,"stderr_tail":[],"saiu":null,"inflight":{}});
        reader.get_mut().write_all(format!("{snapshot}\n").as_bytes()).await.unwrap();
        if let Some(frame) = late_frame { reader.get_mut().write_all(format!("{frame}\n").as_bytes()).await.unwrap(); }
        let mut sent = 0;
        loop {
            let mut raw = String::new();
            if reader.read_line(&mut raw).await.unwrap() == 0 { break; }
            let envelope:Value = serde_json::from_str(&raw).unwrap();
            let wire = envelope["operation_id"].as_str().unwrap();
            let state:State = serde_json::from_slice(&std::fs::read(&state_check).unwrap()).unwrap();
            assert!(state.operations[wire].status == Status::Dispatching,"journal precisa preceder os bytes");
            let frame:Value = serde_json::from_str(envelope["frame"].as_str().unwrap()).unwrap();
            sent += 1;
            let result = if compound && frame["method"] == "thread/read" {
                json!({"thread":{"id":"thread-1","status":{"type":"active"},"turns":[{"id":"turn-1","status":"inProgress"}]}})
            } else if frame["method"] == "turn/start" { json!({"turn":{"id":"turn-1","status":"inProgress"}}) }
            else { json!({"data":[]}) };
            let reply = json!({"type":"cano_output","frame":json!({"id":frame["id"],"result":result}).to_string()});
            let ack = json!({"type":"cano_input_ack","operation_id":wire,"outcome":"written"});
            if blocked_rpc && frame["method"] == "model/list" {
                continue;
            }
            let frames = if reply_before_ack { vec![reply,ack] } else { vec![ack,reply] };
            for frame in frames { reader.get_mut().write_all(format!("{frame}\n").as_bytes()).await.unwrap(); }
        }
        sent
    });
    let target = RuntimeTarget { key:"key".into(),generation:1,name:"session".into(),provider:"codex".into(),
        metadata:json!({"name":"session","headless":true,"thread_id":"thread-1","initialized":true,"ready":true}),
        binding:CanoBinding { pid:42,escuta:format!("tcp:{address}"),token:"secret-test".into(),versao:2 },
        lease_path:dir.path().join("key.lock"),state_path:state_path.clone(),projection_dir:dir.path().join("projection"),
        transcript:dir.path().join("chat.jsonl"),created:0.0 };
    let lease = acquire_lease(&target.lease_path).unwrap();
    let store = Store::open(&target.state_path,&target.projection_dir,State::new("key",1,"session",vec![])).unwrap();
    let queue = QueueActor::start(store,lease);
    let connection = cano::connect(&target.binding).await.unwrap();
    let engine = RuntimeEngine::new("codex",target.metadata.clone(),1,ClockSample { monotonic_s:0.0,epoch_s:1_800_000_000.0 }).unwrap();
    let handle = RuntimeActor::spawn(target,queue,connection,engine);
    (handle,server,dir)
}

fn command() -> RuntimeCommand { RuntimeCommand { operation_id:"op-1".into(),kind:OperationKind::ListModels,payload:json!({}) } }

#[tokio::test]
async fn no_sse_runtime_still_drains() {
    let (handle,server,dir) = setup(true).await;
    handle.queue("append".into(),Action::Append { text:"Olá".into(),delivered:false,ts:None,
        pre_transcript:false,entry_id:Some("input-entry".into()) }).await.unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(5),async {
        loop {
            let state:State = queue_state(dir.path());
            if state.operations.get("input-entry").is_some_and(|operation|operation.status == Status::Accepted) { break; }
            tokio::task::yield_now().await;
        }
    }).await.unwrap();
    handle.stop().await.unwrap();
    assert_eq!(server.await.unwrap(),1);
}

#[tokio::test]
async fn confirmed_prompt_does_not_consume_next_echo() {
    use hangar_server::runtime::receipt::ReceiptIndex;
    let (handle,server,dir) = setup(true).await;
    let path = dir.path().join("chat.jsonl");
    std::fs::write(&path, "").unwrap();
    for id in ["first", "second"] {
        let cursor = ReceiptIndex::new("codex", "thread-1").capture(&path).unwrap();
        handle.queue(format!("{id}:append"),Action::Append { text:"Olá".into(),delivered:true,ts:None,
            pre_transcript:false,entry_id:Some(id.into()) }).await.unwrap();
        handle.queue(format!("{id}:prepare"),Action::Prepare { id:id.into(),entry_id:Some(id.into()),
            payload:json!({"kind":"input"}) }).await.unwrap();
        handle.queue(format!("{id}:cursor"),Action::BindDispatch { id:id.into(),cursor:serde_json::to_value(cursor).unwrap() }).await.unwrap();
        use std::io::Write;
        let mut file = std::fs::OpenOptions::new().append(true).open(&path).unwrap();
        writeln!(file,"{}",json!({"type":"response_item", "payload":{"type":"message", "role":"user",
            "content":[{"type":"input_text","text":"Olá"}]}})).unwrap();
        assert_eq!(handle.confirm().await.unwrap()["confirmed"],1);
    }
    let state:State = queue_state(dir.path());
    assert!(state.rows.iter().all(|row|row["confirmed"] == true));
    // As duas confirmadas: não resta operação que possa casar os ecos, e o uso sai da poda.
    assert!(state.used_occurrences.is_empty());
    handle.stop().await.unwrap();
    assert_eq!(server.await.unwrap(),0);
}

#[tokio::test]
async fn row_delivered_before_the_runtime_is_confirmed_once_by_a_later_echo() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("chat.jsonl");
    let echo = |text:&str| json!({"timestamp":"2026-10-06T12:00:00.000Z","type":"response_item","payload":{"type":"message",
        "role":"user","content":[{"type":"input_text","text":text}]}}).to_string();
    std::fs::write(&path, format!("{}\n{}\n{}\n",echo("sim"),echo("velha"),echo("continua"))).unwrap();
    // Entregues pelo Python antes da troca: sem operação nem cursor de despacho, já no estado quando
    // o ator sobe. Inseridas com ele vivo, a rodada do primeiro ocioso confirmaria "a" sem ver "b".
    // Desistida não chegou: um "continua" digitado depois não a dá por entregue.
    let rows = [("a","sim",1791287980.0,false),("b","sim",1791287995.0,false),("c","velha",1791290000.0,false),("d","continua",1791287990.0,true)]
        .map(|(id,text,ts,abandoned)|{
            let mut row = json!({"id":id,"text":text,"ts":ts,"delivered":true});
            if abandoned { row["desistiu"] = json!(true); }
            row
        });
    std::fs::write(dir.path().join("key.queue-state.json"),serde_json::to_vec(&State::new("key",1,"session",rows.to_vec())).unwrap()).unwrap();
    let (handle,server,dir) = setup_recovered(true,false,false,Some(dir),false).await;
    let confirmed = || {
        let state:State = queue_state(dir.path());
        state.rows.iter().filter(|row|row["confirmed"] == true).filter_map(|row|row["id"].as_str().map(str::to_owned)).collect::<Vec<_>>()
    };
    // A rodada do primeiro ocioso corre junto desta: a contagem é de quem gravou primeiro, o estado não.
    handle.confirm().await.unwrap();
    // A única linha "sim" é do envio mais recente (b), não do perdido (a). A linha "velha" foi
    // gravada antes do envio de "c": não prova a entrega dele.
    assert_eq!(confirmed(),["b"]);
    for index in 0..300 { handle.queue(format!("fill:{index}"),Action::SetRuntimeState { state:json!({}) }).await.unwrap(); }
    // Compactada a fila, a linha usada continua gasta: o outro "sim" não a reaproveita.
    assert_eq!(handle.confirm().await.unwrap()["confirmed"],0);
    assert_eq!(confirmed(),["b"]);
    handle.stop().await.unwrap();
    assert_eq!(server.await.unwrap(),0);
}

#[tokio::test]
async fn resubmit_after_prune_of_confirmed_row_does_not_send_again() {
    let input = ||RuntimeCommand { operation_id:"msg".into(),kind:OperationKind::Input,payload:json!({"text":"Olá","entry_id":"msg"}) };
    let (handle,server,dir) = setup(true).await;
    assert!(handle.command(input()).await.unwrap().disposition == Disposition::Accepted);
    handle.queue("confirm".into(),Action::Confirm { entry_ids:vec!["msg".into()] }).await.unwrap();
    for index in 0..300 { handle.queue(format!("fill:{index}"),Action::SetRuntimeState { state:json!({}) }).await.unwrap(); }
    handle.stop().await.unwrap();
    assert_eq!(server.await.unwrap(),1);
    let state:State = queue_state(dir.path());
    assert!(!state.operations.contains_key("msg"));
    // Ator novo, sem a resposta guardada: a linha confirmada responde e nada vai ao fio.
    let (handle,server,_dir) = setup_recovered(true,false,false,Some(dir),false).await;
    assert!(handle.command(input()).await.unwrap().disposition == Disposition::Accepted);
    handle.stop().await.unwrap();
    assert_eq!(server.await.unwrap(),0);
}

#[tokio::test]
async fn prepare_before_every_write_and_cli_reply_before_ack_is_final() {
    let (handle,server,dir) = setup(true).await;
    let result = handle.command(command()).await.unwrap();
    assert!(result.disposition == Disposition::Accepted);
    handle.stop().await.unwrap();
    assert_eq!(server.await.unwrap(),1);
    let state:State = queue_state(dir.path());
    let phase = state.operations.values().find(|operation|operation.payload["logical_id"] == "op-1").unwrap();
    assert_eq!(phase.result["disposition"],"accepted");
}

#[tokio::test]
async fn concurrent_same_id_has_one_dispatch() {
    let (handle,server,_dir) = setup(false).await;
    let (first,second) = tokio::join!(handle.command(command()),handle.command(command()));
    assert!(first.unwrap().disposition == Disposition::Accepted);
    assert!(second.unwrap().disposition == Disposition::Accepted);
    handle.stop().await.unwrap();
    assert_eq!(server.await.unwrap(),1);
}

#[tokio::test]
async fn stop_joins_io_and_persistence_before_unlock() {
    let (handle,server,dir) = setup(false).await;
    handle.command(command()).await.unwrap();
    handle.stop().await.unwrap();
    server.await.unwrap();
    let _next = crate::lease_when_free(&dir.path().join("key.lock"));
}

#[tokio::test]
async fn published_view_has_durable_state() {
    let (handle,server,dir) = setup(false).await;
    let mut events = handle.subscribe();
    handle.command(command()).await.unwrap();
    while let Ok(event) = events.try_recv() {
        if event.channel == "view" {
            let state:State = queue_state(dir.path());
            assert!(state.runtime_state["view"].is_object());
        }
    }
    handle.stop().await.unwrap();
    server.await.unwrap();
}

#[tokio::test]
async fn operation_id_cannot_be_reused_with_another_payload() {
    let (handle,server,_dir) = setup(false).await;
    handle.command(command()).await.unwrap();
    let mut changed = command();
    changed.payload = json!({"limit":7});
    let Err(error) = handle.command(changed).await else { panic!("ID reutilizada precisa falhar") };
    assert_eq!(error.code,"operation_reused");
    handle.stop().await.unwrap();
    assert_eq!(server.await.unwrap(),1);
}

/// Espera `work` e só falha com a fila 5 s sem gravar. Cada passo do runtime grava a fila com fsync:
/// disco lento atrasa sem bloquear nada, e quem fica preso atrás da RPC deixa a fila parada.
async fn unless_queue_stalls<T>(state:&std::path::Path,work:impl std::future::Future<Output=T>) -> T {
    tokio::pin!(work);
    let (mut last,mut since,start) = (std::fs::read(state).unwrap(),std::time::Instant::now(),std::time::Instant::now());
    loop {
        tokio::select! {
            done = &mut work => return done,
            _ = tokio::time::sleep(std::time::Duration::from_millis(10)) => {
                let now = std::fs::read(state).unwrap();
                if now != last { (last,since) = (now,std::time::Instant::now()); }
                assert!(since.elapsed() < std::time::Duration::from_secs(5),"a fila parou de gravar");
                // Fila que regrava sem parar também não pode prender o teste para sempre.
                assert!(start.elapsed() < std::time::Duration::from_secs(60),"a operação não terminou em 60 s");
            }
        }
    }
}

#[tokio::test]
async fn blocked_rpc_does_not_block_interrupt_or_state() {
    let (handle,server,dir) = setup_behavior(false,true).await;
    let request = handle.clone();
    let pending = tokio::spawn(async move { request.command(command()).await });
    let state = dir.path().join("key.queue-state.json");
    unless_queue_stalls(&state,async {
        loop {
            let saved:State = serde_json::from_slice(&std::fs::read(&state).unwrap()).unwrap();
            if saved.operations.contains_key("op-1") { break; }
            // Dormir, não girar: o giro disputa a CPU com quem grava a fila.
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    }).await;
    let result = unless_queue_stalls(&state,handle.command(RuntimeCommand {
        operation_id:"interrupt".into(),kind:OperationKind::Interrupt,payload:json!({}) })).await.unwrap();
    assert!(result.disposition == Disposition::Accepted);
    assert!(handle.snapshot().await.unwrap()["view"].is_object());
    handle.stop().await.unwrap();
    assert!(pending.await.unwrap().is_err());
    assert_eq!(server.await.unwrap(),2);
}

#[tokio::test]
async fn queue_failure_prevents_write() {
    let (handle,server,dir) = setup(false).await;
    let path = dir.path().join("key.queue-state.json");
    std::fs::remove_file(&path).unwrap();
    std::fs::create_dir(&path).unwrap();
    assert!(handle.command(command()).await.is_err());
    assert!(handle.stop().await.is_err());
    assert_eq!(server.await.unwrap(),0);
}

#[tokio::test]
async fn ack_timeout_is_unknown_without_resend() {
    let (handle,server,dir) = setup_behavior(false,true).await;
    let result = handle.command(command()).await.unwrap();
    assert!(result.disposition == Disposition::Unknown);
    let again = handle.command(command()).await.unwrap();
    assert!(again.disposition == Disposition::Unknown);
    let state:State = queue_state(dir.path());
    assert!(state.operations["op-1"].status == Status::Unknown);
    handle.stop().await.unwrap();
    assert_eq!(server.await.unwrap(),1);
}

#[tokio::test]
async fn wire_ids_distinguish_compound_control() {
    let (handle,server,dir) = setup_mode(false,false,true).await;
    let result = handle.command(RuntimeCommand { operation_id:"interrupt".into(),kind:OperationKind::Interrupt,payload:json!({}) }).await.unwrap();
    assert!(result.disposition == Disposition::Accepted);
    handle.stop().await.unwrap();
    assert_eq!(server.await.unwrap(),2);
    let state:State = queue_state(dir.path());
    let phases:Vec<_> = state.operations.values().filter(|operation|operation.payload["logical_id"] == "interrupt:read").collect();
    assert_eq!(phases.len(),1);
    assert_ne!(phases[0].id,"interrupt");
    assert!(state.operations["interrupt"].status == Status::Accepted);
    let final_phase = state.operations.values().find(|operation|operation.payload["logical_id"] == "interrupt").unwrap();
    assert_ne!(final_phase.id,phases[0].id);
}

#[test]
fn unknown_preparation_never_starts_new_mutable_phase() {
    use hangar_server::runtime::codex::Engine;
    let sample = ClockSample { monotonic_s:0.0,epoch_s:1_800_000_000.0 };
    let mut engine = Engine::new(json!({"name":"session","headless":true,"thread_id":"thread-1","ready":true,"initialized":true}),1,sample);
    engine.restore_rpc("mode:settings".into(),&json!({"id":"hangar:1:7","method":"thread/read",
        "params":{"threadId":"thread-1","includeTurns":false}}),0,0);
    let effects = engine.apply(EngineInput::Line(json!({"id":"hangar:1:7","result":{"thread":{"id":"thread-1","model":"test-model"}}})),sample).unwrap();
    assert!(!effects.iter().any(|effect|matches!(effect,Effect::Write { .. })));
    assert!(effects.iter().any(|effect|matches!(effect,Effect::Reply { operation_id,disposition:Disposition::Accepted,.. } if operation_id == "mode:settings")));
}

#[tokio::test]
async fn late_wire_reply_resolves_parent() {
    let (handle,server,dir) = setup_behavior(false,true).await;
    assert!(handle.command(command()).await.unwrap().disposition == Disposition::Unknown);
    handle.stop().await.unwrap();
    assert_eq!(server.await.unwrap(),1);
    let (handle,server,_dir) = setup_recovered(false,false,false,Some(dir),true).await;
    tokio::time::timeout(std::time::Duration::from_secs(5),async {
        loop {
            if handle.command(command()).await.unwrap().disposition == Disposition::Accepted { break; }
            tokio::task::yield_now().await;
        }
    }).await.unwrap();
    handle.stop().await.unwrap();
    assert_eq!(server.await.unwrap(),0);
}

/// Cano Claude falso que só conta o que chega ao fio; a política aponta para uma porta fechada.
/// Conta as escritas da conversa; o `initialize` que a subida pede sozinha só avisa o `Notify`.
async fn setup_claude_unreachable_policy(initialized:bool) -> (RuntimeHandle,tokio::task::JoinHandle<usize>,tempfile::TempDir,std::sync::Arc<tokio::sync::Notify>) {
    let dir = tempfile::tempdir().unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let closed = crate::refused_address();
    let booted = std::sync::Arc::new(tokio::sync::Notify::new());
    let boot_signal = booted.clone();
    let server = tokio::spawn(async move {
        let (stream,_) = listener.accept().await.unwrap();
        let mut reader = BufReader::new(stream);
        let mut header = String::new(); reader.read_line(&mut header).await.unwrap();
        let snapshot = json!({"type":"cano_snapshot","versao":2,"pid":42,"init":null,"aberto":false,
            "pendentes":[],"ultimo_result":null,"rate_limit":null,"stderr_tail":[],"saiu":null,"inflight":{}});
        reader.get_mut().write_all(format!("{snapshot}\n").as_bytes()).await.unwrap();
        let mut sent = 0;
        loop {
            let mut raw = String::new();
            if reader.read_line(&mut raw).await.unwrap() == 0 { break; }
            let envelope:Value = serde_json::from_str(&raw).unwrap();
            let frame:Value = serde_json::from_str(envelope["frame"].as_str().unwrap_or("{}")).unwrap_or_default();
            if frame["type"] == "control_request" && frame["request"]["subtype"] == "initialize" { boot_signal.notify_one(); } else { sent += 1; }
            let ack = json!({"type":"cano_input_ack","operation_id":envelope["operation_id"],"outcome":"written"});
            reader.get_mut().write_all(format!("{ack}\n").as_bytes()).await.unwrap();
        }
        sent
    });
    let target = RuntimeTarget { key:"key".into(),generation:1,name:"session".into(),provider:"claude".into(),
        metadata:json!({"name":"session","headless":true,"session_id":"sid-1","initialized":initialized}),
        binding:CanoBinding { pid:42,escuta:format!("tcp:{address}"),token:"secret-test".into(),versao:2 },
        lease_path:dir.path().join("key.lock"),state_path:dir.path().join("key.queue-state.json"),projection_dir:dir.path().join("projection"),
        transcript:dir.path().join("chat.jsonl"),created:0.0 };
    let lease = acquire_lease(&target.lease_path).unwrap();
    let store = Store::open(&target.state_path,&target.projection_dir,State::new("key",1,"session",vec![])).unwrap();
    let queue = QueueActor::start(store,lease);
    let connection = cano::connect(&target.binding).await.unwrap();
    let engine = RuntimeEngine::new("claude",target.metadata.clone(),1,ClockSample { monotonic_s:0.0,epoch_s:1_800_000_000.0 }).unwrap()
        .with_policy(PolicyClient::new(closed,"secret".into(),"instance".into()));
    (RuntimeActor::spawn(target,queue,connection,engine),server,dir,booted)
}

#[tokio::test]
async fn input_is_prepared_in_rust_even_when_the_python_policy_is_unreachable() {
    // O preparo do prompt é local: o Python fora do ar não adia mais a entrada.
    let (handle,server,dir,_) = setup_claude_unreachable_policy(true).await;
    let input = RuntimeCommand { operation_id:"msg".into(),kind:OperationKind::Input,payload:json!({"text":"Olá","entry_id":"msg"}) };
    assert!(handle.command(input).await.unwrap().disposition == Disposition::Accepted);
    let state:State = queue_state(dir.path());
    assert!(!state.operations.keys().any(|id|id.contains("prepare_prompt")),"cálculo puro não entra no diário");
    handle.stop().await.unwrap();
    assert_eq!(server.await.unwrap(),1,"a mensagem chegou ao fio");
}

#[tokio::test]
async fn turn_end_confirms_the_delivered_input_without_being_asked() {
    // O adapter Python confirmava a fila em todo fim de turno; o ator faz o mesmo sozinho.
    let dir = tempfile::tempdir().unwrap();
    let transcript = dir.path().join("chat.jsonl");
    std::fs::write(&transcript,"").unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let written = transcript.clone();
    let server = tokio::spawn(async move {
        let (stream,_) = listener.accept().await.unwrap();
        let mut reader = BufReader::new(stream);
        let mut header = String::new(); reader.read_line(&mut header).await.unwrap();
        let snapshot = json!({"type":"cano_snapshot","versao":2,"pid":42,"init":null,"aberto":false,
            "pendentes":[],"ultimo_result":null,"rate_limit":null,"stderr_tail":[],"saiu":null,"inflight":{}});
        reader.get_mut().write_all(format!("{snapshot}\n").as_bytes()).await.unwrap();
        loop {
            let mut raw = String::new();
            if reader.read_line(&mut raw).await.unwrap() == 0 { break; }
            let envelope:Value = serde_json::from_str(&raw).unwrap();
            let frame:Value = serde_json::from_str(envelope["frame"].as_str().unwrap()).unwrap();
            let ack = json!({"type":"cano_input_ack","operation_id":envelope["operation_id"],"outcome":"written"});
            reader.get_mut().write_all(format!("{ack}\n").as_bytes()).await.unwrap();
            if frame["type"] == "user" {
                use std::io::Write;
                let mut file = std::fs::OpenOptions::new().append(true).open(&written).unwrap();
                writeln!(file,"{}",json!({"type":"user","uuid":"u-1","message":{"role":"user","content":"Olá"}})).unwrap();
                let result = json!({"type":"cano_output","frame":json!({"type":"result","subtype":"success","is_error":false}).to_string()});
                reader.get_mut().write_all(format!("{result}\n").as_bytes()).await.unwrap();
            }
        }
    });
    let target = RuntimeTarget { key:"key".into(),generation:1,name:"session".into(),provider:"claude".into(),
        metadata:json!({"name":"session","headless":true,"session_id":"sid-1","initialized":true}),
        binding:CanoBinding { pid:42,escuta:format!("tcp:{address}"),token:"secret-test".into(),versao:2 },
        lease_path:dir.path().join("key.lock"),state_path:dir.path().join("key.queue-state.json"),projection_dir:dir.path().join("projection"),
        transcript:transcript.clone(),created:0.0 };
    let lease = acquire_lease(&target.lease_path).unwrap();
    let store = Store::open(&target.state_path,&target.projection_dir,State::new("key",1,"session",vec![])).unwrap();
    let queue = QueueActor::start(store,lease);
    let connection = cano::connect(&target.binding).await.unwrap();
    let engine = RuntimeEngine::new("claude",target.metadata.clone(),1,ClockSample { monotonic_s:0.0,epoch_s:1_800_000_000.0 }).unwrap();
    let handle = RuntimeActor::spawn(target,queue,connection,engine);
    let input = RuntimeCommand { operation_id:"msg".into(),kind:OperationKind::Input,payload:json!({"text":"Olá","entry_id":"msg"}) };
    assert!(handle.command(input).await.unwrap().disposition == Disposition::Accepted);
    let path = dir.path().join("key.queue-state.json");
    tokio::time::timeout(std::time::Duration::from_secs(5),async {
        loop {
            let state:State = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
            if state.rows.iter().any(|row|row["id"] == "msg" && row["confirmed"] == true) { break; }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    }).await.expect("fim de turno precisa confirmar a entrada entregue");
    handle.stop().await.unwrap();
    server.await.unwrap();
}

#[tokio::test]
async fn transcript_growth_confirms_the_input_before_the_turn_ends() {
    // Sem fim de turno: a linha do usuário no transcript basta para confirmar, sem esperar o idle.
    let dir = tempfile::tempdir().unwrap();
    let transcript = dir.path().join("chat.jsonl");
    std::fs::write(&transcript,"").unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let written = transcript.clone();
    let server = tokio::spawn(async move {
        let (stream,_) = listener.accept().await.unwrap();
        let mut reader = BufReader::new(stream);
        let mut header = String::new(); reader.read_line(&mut header).await.unwrap();
        let snapshot = json!({"type":"cano_snapshot","versao":2,"pid":42,"init":null,"aberto":false,
            "pendentes":[],"ultimo_result":null,"rate_limit":null,"stderr_tail":[],"saiu":null,"inflight":{}});
        reader.get_mut().write_all(format!("{snapshot}\n").as_bytes()).await.unwrap();
        loop {
            let mut raw = String::new();
            if reader.read_line(&mut raw).await.unwrap() == 0 { break; }
            let envelope:Value = serde_json::from_str(&raw).unwrap();
            let frame:Value = serde_json::from_str(envelope["frame"].as_str().unwrap()).unwrap();
            let ack = json!({"type":"cano_input_ack","operation_id":envelope["operation_id"],"outcome":"written"});
            reader.get_mut().write_all(format!("{ack}\n").as_bytes()).await.unwrap();
            if frame["type"] == "user" {
                use std::io::Write;
                let mut file = std::fs::OpenOptions::new().append(true).open(&written).unwrap();
                writeln!(file,"{}",json!({"type":"user","uuid":"u-1","message":{"role":"user","content":"Olá"}})).unwrap();
            }
        }
    });
    let target = RuntimeTarget { key:"key".into(),generation:1,name:"session".into(),provider:"claude".into(),
        metadata:json!({"name":"session","headless":true,"session_id":"sid-1","initialized":true}),
        binding:CanoBinding { pid:42,escuta:format!("tcp:{address}"),token:"secret-test".into(),versao:2 },
        lease_path:dir.path().join("key.lock"),state_path:dir.path().join("key.queue-state.json"),projection_dir:dir.path().join("projection"),
        transcript:transcript.clone(),created:0.0 };
    let lease = acquire_lease(&target.lease_path).unwrap();
    let store = Store::open(&target.state_path,&target.projection_dir,State::new("key",1,"session",vec![])).unwrap();
    let queue = QueueActor::start(store,lease);
    let connection = cano::connect(&target.binding).await.unwrap();
    let engine = RuntimeEngine::new("claude",target.metadata.clone(),1,ClockSample { monotonic_s:0.0,epoch_s:1_800_000_000.0 }).unwrap();
    let handle = RuntimeActor::spawn(target,queue,connection,engine);
    let input = RuntimeCommand { operation_id:"msg".into(),kind:OperationKind::Input,payload:json!({"text":"Olá","entry_id":"msg"}) };
    assert!(handle.command(input).await.unwrap().disposition == Disposition::Accepted);
    let path = dir.path().join("key.queue-state.json");
    tokio::time::timeout(std::time::Duration::from_secs(2),async {
        loop {
            let state:State = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
            if state.rows.iter().any(|row|row["id"] == "msg" && row["confirmed"] == true) { break; }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    }).await.expect("o crescimento do transcript precisa confirmar a entrada");
    handle.stop().await.unwrap();
    server.await.unwrap();
}

/// Serviço de política HTTP que responde `ok` a tudo e conta as chamadas.
async fn policy_server() -> (std::net::SocketAddr,std::sync::Arc<std::sync::atomic::AtomicUsize>) {
    use tokio::io::AsyncReadExt;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let calls = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let counter = calls.clone();
    tokio::spawn(async move {
        loop {
            let Ok((stream,_)) = listener.accept().await else { return };
            let counter = counter.clone();
            tokio::spawn(async move {
                let mut reader = BufReader::new(stream);
                loop {
                    let mut length = 0usize;
                    loop {
                        let mut line = String::new();
                        if reader.read_line(&mut line).await.unwrap_or(0) == 0 { return; }
                        if line == "\r\n" { break; }
                        if let Some(value) = line.to_ascii_lowercase().strip_prefix("content-length:") { length = value.trim().parse().unwrap(); }
                    }
                    let mut body = vec![0;length]; reader.read_exact(&mut body).await.unwrap();
                    counter.fetch_add(1,std::sync::atomic::Ordering::SeqCst);
                    let kind = serde_json::from_slice::<Value>(&body).unwrap()["kind"].clone();
                    let data = if kind == "prepare_prompt" { json!({"content":"Olá","notices":[],"native_candidate":false}) } else { json!({}) };
                    let reply = json!({"ok":true,"data":data}).to_string();
                    let response = format!("HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\n\r\n{reply}",reply.len());
                    reader.get_mut().write_all(response.as_bytes()).await.unwrap();
                }
            });
        }
    });
    (address,calls)
}

#[tokio::test]
async fn status_formatting_and_state_changes_do_not_rewrite_the_journal() {
    // Uma mensagem custava ~60 regravações do estado: cada format_status passava pelo diário e
    // cada mudança de estado gravava a vista inteira, mesmo sem nada durável mudar.
    status_turn(false).await;
}

#[tokio::test]
async fn a_local_format_failure_is_cosmetic_and_leaves_the_session_alive() {
    // `rate_limit_info` que não é objeto faz o formatador local falhar (o Python também falhava):
    // a sessão só perde a linha de status e o turno termina.
    let problems = status_turn(true).await;
    assert!(problems.iter().any(|problem|problem["error_code"] == "policy_input"),"a falha precisa aparecer: {problems:?}");
}

/// Um turno completo com o cano falso; devolve os `problem` publicados. `bad_rate` manda um
/// `rate_limit_event` com `rate_limit_info` inválido antes do resultado.
async fn status_turn(bad_rate:bool) -> Vec<Value> {
    let dir = tempfile::tempdir().unwrap();
    let transcript = dir.path().join("chat.jsonl");
    std::fs::write(&transcript,"").unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (stream,_) = listener.accept().await.unwrap();
        let mut reader = BufReader::new(stream);
        let mut header = String::new(); reader.read_line(&mut header).await.unwrap();
        let snapshot = json!({"type":"cano_snapshot","versao":2,"pid":42,"init":null,"aberto":false,
            "pendentes":[],"ultimo_result":null,"rate_limit":null,"stderr_tail":[],"saiu":null,"inflight":{}});
        reader.get_mut().write_all(format!("{snapshot}\n").as_bytes()).await.unwrap();
        loop {
            let mut raw = String::new();
            if reader.read_line(&mut raw).await.unwrap() == 0 { break; }
            let envelope:Value = serde_json::from_str(&raw).unwrap();
            let ack = json!({"type":"cano_input_ack","operation_id":envelope["operation_id"],"outcome":"written"});
            reader.get_mut().write_all(format!("{ack}\n").as_bytes()).await.unwrap();
            let mut events = vec![json!({"type":"stream_event","event":{"type":"message_start","message":{"id":"m1"}}}),
                json!({"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}}),
                json!({"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"oi"}}}),
                json!({"type":"stream_event","event":{"type":"content_block_stop","index":0}}),
                json!({"type":"assistant","message":{"id":"m1","content":[{"type":"text","text":"oi"}]}}),
                json!({"type":"result","subtype":"success","is_error":false,"usage":{"input_tokens":1,"output_tokens":1}})];
            if bad_rate { events.insert(1,json!({"type":"rate_limit_event","rate_limit_info":"boom"})); }
            for event in events {
                let frame = json!({"type":"cano_output","frame":event.to_string()});
                reader.get_mut().write_all(format!("{frame}\n").as_bytes()).await.unwrap();
            }
        }
    });
    let (policy,calls) = policy_server().await;    let target = RuntimeTarget { key:"key".into(),generation:1,name:"session".into(),provider:"claude".into(),
        metadata:json!({"name":"session","headless":true,"session_id":"sid-1","initialized":true}),
        binding:CanoBinding { pid:42,escuta:format!("tcp:{address}"),token:"secret-test".into(),versao:2 },
        lease_path:dir.path().join("key.lock"),state_path:dir.path().join("key.queue-state.json"),projection_dir:dir.path().join("projection"),
        transcript,created:0.0 };
    let lease = acquire_lease(&target.lease_path).unwrap();
    let store = Store::open(&target.state_path,&target.projection_dir,State::new("key",1,"session",vec![])).unwrap();
    let queue = QueueActor::start(store,lease);
    let connection = cano::connect(&target.binding).await.unwrap();
    let engine = RuntimeEngine::new("claude",target.metadata.clone(),1,ClockSample { monotonic_s:0.0,epoch_s:1_800_000_000.0 }).unwrap()
        .with_policy(PolicyClient::new(policy,"secret".into(),"instance".into()));
    let handle = RuntimeActor::spawn(target,queue,connection,engine);
    let mut events = handle.subscribe();
    let input = RuntimeCommand { operation_id:"msg".into(),kind:OperationKind::Input,payload:json!({"text":"Olá","entry_id":"msg"}) };
    assert!(handle.command(input).await.unwrap().disposition == Disposition::Accepted);
    let mut problems = Vec::new();
    tokio::time::timeout(std::time::Duration::from_secs(5),async {
        let mut idle_seen = false;
        loop {
            // A condição vale depois de cada evento e também sem evento: o último `idle` pode vir antes do problema ou da chamada.
            if let Ok(event) = tokio::time::timeout(std::time::Duration::from_millis(100),events.recv()).await {
                let event = event.unwrap();
                if event.channel == "problem" { problems.push(event.data.clone()); }
                if event.channel == "state" && event.data["state"] == "idle" { idle_seen = true; }
            }
            // Preparo, status, uso, carimbo e evento desconhecido são locais: o Python não é chamado neste turno.
            if idle_seen && (!bad_rate || !problems.is_empty()) { break; }
        }
    }).await.expect("o turno precisa terminar");
    handle.stop().await.unwrap();
    assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst),0,"nenhum serviço deste turno precisa mais do Python");
    server.await.unwrap();
    let state:State = queue_state(dir.path());
    assert!(!state.operations.keys().any(|id|id.starts_with("policy:")),"serviço sem efeito não entra no diário");
    let views = state.operations.values().filter(|op|op.payload["kind"] == "set_runtime_state").count();
    assert!(views <= 3,"vista gravada {views} vezes num turno sem mudança durável relevante");
    problems
}

#[tokio::test]
async fn a_queue_refusal_carries_its_reason() {
    // O diário do Python e o log do Rust mostravam só "queue_io"; a frase da fila é fixa e diz a causa.
    let (handle,server,_dir) = setup(true).await;
    let append = ||Action::Append { text:"Olá".into(),delivered:true,ts:None,pre_transcript:false,entry_id:Some("same".into()) };
    handle.queue("first".into(),append()).await.unwrap();
    let error = handle.queue("second".into(),append()).await.unwrap_err();
    assert_eq!(error.code,"queue_io");
    assert!(error.message.contains("entrada da fila já existe"),"{}",error.message);
    handle.stop().await.unwrap();
    server.await.unwrap();
}

#[tokio::test]
async fn steering_the_queue_without_a_turn_is_refused_and_keeps_the_entry() {
    // Sessão ainda sem inicialização: o drain não entrega, e a entrada só pode mudar pela orientação.
    let (handle,server,dir,booted) = setup_claude_unreachable_policy(false).await;
    handle.queue("append".into(),Action::Append { text:"Depois".into(),delivered:false,ts:None,pre_transcript:false,entry_id:Some("later".into()) }).await.unwrap();
    let steer = RuntimeCommand { operation_id:"steer-1".into(),kind:OperationKind::SteerQueue,payload:json!({"entry_id":"later"}) };
    let reply = handle.command(steer).await.unwrap();
    assert!(reply.disposition == Disposition::Rejected);
    assert_eq!(reply.payload["error"],"Não há turno em andamento para orientar");
    // A entrada continua na fila e não ganha a marca de entregue: a orientação recusada não escreve nada.
    tokio::time::timeout(std::time::Duration::from_secs(5),async {
        loop {
            let state:State = queue_state(dir.path());
            if state.rows.iter().any(|row|row["id"] == "later" && row["delivered"] == false) { break; }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    }).await.unwrap_or_else(|_|panic!("a entrada precisa continuar na fila: {:?}",queue_state(dir.path()).rows));
    // A subida pede o `initialize` sozinha; esperado no fio, ele não corre mais contra a parada.
    tokio::time::timeout(std::time::Duration::from_secs(10),booted.notified()).await.expect("a subida não pediu o initialize");
    handle.stop().await.unwrap();
    assert_eq!(server.await.unwrap(),0,"a orientação recusada não escreve nada");
}

#[tokio::test]
async fn local_command_result_confirms_the_slash_entry() {
    // Comando local não vira linha `user`: o `result` com local_command é a prova, como no adapter Python.
    let dir = tempfile::tempdir().unwrap();
    let transcript = dir.path().join("chat.jsonl");
    std::fs::write(&transcript,"").unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let written = transcript.clone();
    let server = tokio::spawn(async move {
        let (stream,_) = listener.accept().await.unwrap();
        let mut reader = BufReader::new(stream);
        let mut header = String::new(); reader.read_line(&mut header).await.unwrap();
        let snapshot = json!({"type":"cano_snapshot","versao":2,"pid":42,"init":null,"aberto":false,
            "pendentes":[],"ultimo_result":null,"rate_limit":null,"stderr_tail":[],"saiu":null,"inflight":{}});
        reader.get_mut().write_all(format!("{snapshot}\n").as_bytes()).await.unwrap();
        loop {
            let mut raw = String::new();
            if reader.read_line(&mut raw).await.unwrap() == 0 { break; }
            let envelope:Value = serde_json::from_str(&raw).unwrap();
            let frame:Value = serde_json::from_str(envelope["frame"].as_str().unwrap()).unwrap();
            let ack = json!({"type":"cano_input_ack","operation_id":envelope["operation_id"],"outcome":"written"});
            reader.get_mut().write_all(format!("{ack}\n").as_bytes()).await.unwrap();
            if frame["type"] == "user" {
                let _ = &written;
                let result = json!({"type":"cano_output","frame":json!({"type":"result","subtype":"success","is_error":false,"local_command":"clear"}).to_string()});
                reader.get_mut().write_all(format!("{result}\n").as_bytes()).await.unwrap();
            }
        }
    });
    let target = RuntimeTarget { key:"key".into(),generation:1,name:"session".into(),provider:"claude".into(),
        metadata:json!({"name":"session","headless":true,"session_id":"sid-1","initialized":true}),
        binding:CanoBinding { pid:42,escuta:format!("tcp:{address}"),token:"secret-test".into(),versao:2 },
        lease_path:dir.path().join("key.lock"),state_path:dir.path().join("key.queue-state.json"),projection_dir:dir.path().join("projection"),
        transcript:transcript.clone(),created:0.0 };
    let lease = acquire_lease(&target.lease_path).unwrap();
    let store = Store::open(&target.state_path,&target.projection_dir,State::new("key",1,"session",vec![])).unwrap();
    let queue = QueueActor::start(store,lease);
    let connection = cano::connect(&target.binding).await.unwrap();
    let engine = RuntimeEngine::new("claude",target.metadata.clone(),1,ClockSample { monotonic_s:0.0,epoch_s:1_800_000_000.0 }).unwrap();
    let handle = RuntimeActor::spawn(target,queue,connection,engine);
    // Outra barra já reivindicada pelo drain e ainda não escrita: o result do /clear não pode confirmá-la.
    handle.queue("claimed".into(),Action::Append { text:"/cost".into(),delivered:true,ts:None,pre_transcript:false,entry_id:Some("next".into()) }).await.unwrap();
    let input = RuntimeCommand { operation_id:"msg".into(),kind:OperationKind::Input,payload:json!({"text":"/clear","entry_id":"msg"}) };
    assert!(handle.command(input).await.unwrap().disposition == Disposition::Accepted);
    let path = dir.path().join("key.queue-state.json");
    tokio::time::timeout(std::time::Duration::from_secs(5),async {
        loop {
            let state:State = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
            if state.rows.iter().any(|row|row["id"] == "msg" && row["confirmed"] == true) { break; }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    }).await.expect("comando local consumido precisa ficar confirmado");
    let state:State = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    assert!(state.rows.iter().any(|row|row["id"] == "next" && row["confirmed"] != true),"barra ainda não escrita não é confirmada");
    handle.stop().await.unwrap();
    server.await.unwrap();
}


fn epoch_now() -> f64 { std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs_f64() }
fn queue_state(dir:&std::path::Path) -> State { serde_json::from_slice(&read_replaced(&dir.join("key.queue-state.json")).unwrap()).unwrap() }

#[tokio::test]
async fn headless_entry_without_proof_gives_up_after_the_deadline_and_can_be_discarded() {
    // Sem terminal nada é redigitado: entregue há mais que o prazo e sem linha no transcript, a entrada
    // vira "não chegou" e o Descartar a tira, em vez de ficar "aguardando confirmação" para sempre.
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("chat.jsonl"),"").unwrap();
    let (cano,server) = claude_cano(vec![]).await;
    let (policy,_) = policy_server().await;
    let handle = claude_actor(dir.path(),cano,policy).await;
    handle.queue("lost".into(),Action::Append { text:"perdida".into(),delivered:true,ts:Some(epoch_now()-120.0),
        pre_transcript:false,entry_id:Some("lost".into()) }).await.unwrap();
    handle.queue("fresh".into(),Action::Append { text:"recente".into(),delivered:true,ts:Some(epoch_now()),
        pre_transcript:false,entry_id:Some("fresh".into()) }).await.unwrap();
    handle.confirm().await.unwrap();
    let state = queue_state(dir.path());
    let row = |id:&str| state.rows.iter().find(|row|row["id"] == id).unwrap().clone();
    assert_eq!(row("lost")["desistiu"],true,"entrada sem prova depois do prazo não desistiu: {}",row("lost"));
    assert!(row("fresh")["desistiu"].is_null(),"dentro do prazo ainda espera a prova");
    assert_eq!(handle.queue("discard".into(),Action::Remove { entry_id:"lost".into() }).await.unwrap(),json!(true));
    handle.stop().await.unwrap();
    server.await.unwrap();
}

#[tokio::test]
async fn headless_wait_writes_the_state_marker_that_drives_the_awaiting_push() {
    // Sem pane não há hook `Notification`: o marcador `<config_dir>/.hangar-state/<sid>.json` é o que
    // dispara o push de "aguardando" e pausa o loop, como nas sessões com terminal.
    let dir = tempfile::tempdir().unwrap();
    let config = dir.path().join("config");
    let (cano,server) = claude_cano(vec![json!({"type":"control_request","request_id":1,"request":{"subtype":"can_use_tool","tool_name":"Bash","input":{"command":"ls"}}})]).await;
    let target = RuntimeTarget { key:"key".into(),generation:1,name:"session".into(),provider:"claude".into(),
        metadata:json!({"name":"session","headless":true,"session_id":"sid-1","initialized":true,"config_dir":config}),
        binding:CanoBinding { pid:42,escuta:format!("tcp:{cano}"),token:"secret-test".into(),versao:2 },
        lease_path:dir.path().join("key.lock"),state_path:dir.path().join("key.queue-state.json"),projection_dir:dir.path().join("projection"),
        transcript:dir.path().join("chat.jsonl"),created:0.0 };
    let lease = acquire_lease(&target.lease_path).unwrap();
    let store = Store::open(&target.state_path,&target.projection_dir,State::new("key",1,"session",vec![])).unwrap();
    let queue = QueueActor::start(store,lease);
    let connection = cano::connect(&target.binding).await.unwrap();
    let engine = RuntimeEngine::new("claude",target.metadata.clone(),1,ClockSample { monotonic_s:0.0,epoch_s:1_800_000_000.0 }).unwrap();
    let handle = RuntimeActor::spawn(target,queue,connection,engine);
    let marker = config.join(".hangar-state/sid-1.json");
    tokio::time::timeout(std::time::Duration::from_secs(3),async {
        loop {
            let state = std::fs::read(&marker).ok().and_then(|bytes|serde_json::from_slice::<Value>(&bytes).ok());
            if state.is_some_and(|state|state["state"] == "awaiting_input") { break; }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    }).await.expect("permissão pedida sem terminal precisa gravar o marcador awaiting_input");
    handle.stop().await.unwrap();
    server.await.unwrap();
}

#[tokio::test]
async fn echo_from_the_cli_confirms_the_entry_without_the_transcript() {
    // `--replay-user-messages`: a CLI devolve a mensagem com o mesmo `uuid` quando ela entra na conversa.
    // O transcript nunca ganha a linha (conversa trocada, arquivo em outro lugar): o eco basta.
    let dir = tempfile::tempdir().unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (stream,_) = listener.accept().await.unwrap();
        let mut reader = BufReader::new(stream);
        let mut header = String::new(); reader.read_line(&mut header).await.unwrap();
        let snapshot = json!({"type":"cano_snapshot","versao":2,"pid":42,"init":null,"aberto":false,
            "pendentes":[],"ultimo_result":null,"rate_limit":null,"stderr_tail":[],"saiu":null,"inflight":{}});
        reader.get_mut().write_all(format!("{snapshot}\n").as_bytes()).await.unwrap();
        loop {
            let mut raw = String::new();
            if reader.read_line(&mut raw).await.unwrap() == 0 { break; }
            let envelope:Value = serde_json::from_str(&raw).unwrap();
            let frame:Value = serde_json::from_str(envelope["frame"].as_str().unwrap()).unwrap();
            let ack = json!({"type":"cano_input_ack","operation_id":envelope["operation_id"],"outcome":"written"});
            reader.get_mut().write_all(format!("{ack}\n").as_bytes()).await.unwrap();
            if frame["type"] == "user" {
                let echo = json!({"type":"user","isReplay":true,"uuid":frame["uuid"],"session_id":"sid-1","parent_tool_use_id":null,"message":frame["message"]});
                let line = json!({"type":"cano_output","frame":echo.to_string()});
                reader.get_mut().write_all(format!("{line}\n").as_bytes()).await.unwrap();
            }
        }
    });
    let (policy,_) = policy_server().await;
    let handle = claude_actor(dir.path(),address,policy).await;
    let input = RuntimeCommand { operation_id:"msg".into(),kind:OperationKind::Input,payload:json!({"text":"Olá","entry_id":"msg"}) };
    assert!(handle.command(input).await.unwrap().disposition == Disposition::Accepted);
    tokio::time::timeout(std::time::Duration::from_secs(3),async {
        loop {
            if queue_state(dir.path()).rows.iter().any(|row|row["id"] == "msg" && row["confirmed"] == true) { break; }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    }).await.expect("o eco da CLI precisa confirmar a entrada");
    handle.stop().await.unwrap();
    server.await.unwrap();
}

#[tokio::test]
async fn queued_entries_become_not_delivered_when_the_process_gives_up() {
    let dir = tempfile::tempdir().unwrap();
    // Permissão em aberto: a sessão não entrega, a mensagem espera na fila.
    let (cano,server) = claude_cano(vec![json!({"type":"control_request","request_id":1,"request":{"subtype":"can_use_tool","tool_name":"Bash","input":{}}})]).await;
    let (policy,_) = policy_server().await;
    let handle = claude_actor(dir.path(),cano,policy).await;
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    handle.queue("wait".into(),Action::Append { text:"espera".into(),delivered:false,ts:None,pre_transcript:false,entry_id:Some("wait".into()) }).await.unwrap();
    assert_eq!(abandon_queued(&handle).await.unwrap(),1);
    let state = queue_state(dir.path());
    let row = state.rows.iter().find(|row|row["id"] == "wait").unwrap();
    assert_eq!((row["delivered"].clone(),row["desistiu"].clone()),(json!(true),json!(true)),"{row}");
    handle.stop().await.unwrap();
    server.await.unwrap();
}

#[tokio::test]
async fn rows_left_unconfirmed_by_an_older_binary_confirm_when_the_actor_opens() {
    // Retrato do estado real: três orientações mandadas durante o turno, aceitas, cada uma com cursor; a CLI as
    // juntou numa mensagem só e a versão anterior confirmou só uma. Ao abrir, o ator acerta as outras sozinho.
    use hangar_server::runtime::receipt::ReceiptIndex;
    let dir = tempfile::tempdir().unwrap();
    let transcript = dir.path().join("chat.jsonl");
    std::fs::write(&transcript,"").unwrap();
    let cursor = serde_json::to_value(ReceiptIndex::new("claude","sid-1").capture(&transcript).unwrap()).unwrap();
    let ids = ["r0","r1","r2"];
    {
        let mut store = Store::open(&dir.path().join("key.queue-state.json"),&dir.path().join("projection"),State::new("key",1,"session",vec![])).unwrap();
        let clock = ClockSample { monotonic_s:0.0,epoch_s:epoch_now()-600.0 };
        for (id,text) in ids.iter().zip(crate::runtime_receipt::MERGED_INPUTS) {
            let op = format!("steer-1:{id}");
            store.exec(1,&format!("append:{id}"),clock,Action::Append { text:text.into(),delivered:true,ts:None,pre_transcript:false,entry_id:Some((*id).into()) }).unwrap();
            store.exec(1,&format!("prepare:{id}"),clock,Action::Prepare { id:op.clone(),payload:json!({"kind":"steer"}),entry_id:Some((*id).into()) }).unwrap();
            store.exec(1,&format!("cursor:{id}"),clock,Action::BindDispatch { id:op.clone(),cursor:cursor.clone() }).unwrap();
            store.exec(1,&format!("begin:{id}"),clock,Action::BeginDispatch { id:op.clone(),wire_id:format!("w:{id}"),staged:false }).unwrap();
            store.exec(1,&format!("finish:{id}"),clock,Action::Finish { id:op,status:Status::Accepted,result:json!({}) }).unwrap();
            store.exec(1,&format!("steered:{id}"),clock,Action::SetDelivered { entry_id:(*id).into(),value:true,steered:true }).unwrap();
        }
    }
    std::fs::write(&transcript,format!("{}\n",crate::runtime_receipt::merged_inputs_line("sid-1","2026-10-13T13:50:29.778Z"))).unwrap();
    let (cano,server) = claude_cano(vec![]).await;
    let (policy,_) = policy_server().await;
    let handle = claude_actor(dir.path(),cano,policy).await;
    tokio::time::timeout(std::time::Duration::from_secs(3),async {
        loop {
            let state = queue_state(dir.path());
            if ids.iter().all(|id|state.rows.iter().any(|row|row["id"] == *id && row["confirmed"] == true)) { break; }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    }).await.unwrap_or_else(|_|panic!("entradas juntadas pela CLI seguem sem confirmação: {:?}",queue_state(dir.path()).rows));
    handle.stop().await.unwrap();
    server.await.unwrap();
}

#[tokio::test]
async fn headless_entry_is_not_given_up_while_a_turn_runs() {
    // Com turno em curso a CLI ainda pode consumir a mensagem: "não chegou" (e o Descartar) agora seria mentira.
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("chat.jsonl"),"").unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (stream,_) = listener.accept().await.unwrap();
        let mut reader = BufReader::new(stream);
        let mut header = String::new(); reader.read_line(&mut header).await.unwrap();
        let snapshot = json!({"type":"cano_snapshot","versao":2,"pid":42,"init":null,"aberto":true,
            "pendentes":[],"ultimo_result":null,"rate_limit":null,"stderr_tail":[],"saiu":null,"inflight":{}});
        reader.get_mut().write_all(format!("{snapshot}\n").as_bytes()).await.unwrap();
        let mut raw = String::new();
        while reader.read_line(&mut raw).await.unwrap_or(0) > 0 { raw.clear(); }
    });
    let (policy,_) = policy_server().await;
    let handle = claude_actor(dir.path(),address,policy).await;
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    handle.queue("lost".into(),Action::Append { text:"no meio do turno".into(),delivered:true,ts:Some(epoch_now()-120.0),
        pre_transcript:false,entry_id:Some("lost".into()) }).await.unwrap();
    handle.confirm().await.unwrap();
    let state = queue_state(dir.path());
    let row = state.rows.iter().find(|row|row["id"] == "lost").unwrap();
    assert!(row["desistiu"].is_null(),"desistiu com o turno em curso: {row}");
    handle.stop().await.unwrap();
    server.await.unwrap();
}

#[tokio::test]
async fn steer_line_in_the_transcript_confirms_without_waiting_for_the_turn_end() {
    // A orientação no meio do turno também abre a vigília do transcript, como a mensagem comum.
    let dir = tempfile::tempdir().unwrap();
    let transcript = dir.path().join("chat.jsonl");
    std::fs::write(&transcript,"").unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let written = transcript.clone();
    let server = tokio::spawn(async move {
        let (stream,_) = listener.accept().await.unwrap();
        let mut reader = BufReader::new(stream);
        let mut header = String::new(); reader.read_line(&mut header).await.unwrap();
        let snapshot = json!({"type":"cano_snapshot","versao":2,"pid":42,"init":null,"aberto":true,
            "pendentes":[],"ultimo_result":null,"rate_limit":null,"stderr_tail":[],"saiu":null,"inflight":{}});
        reader.get_mut().write_all(format!("{snapshot}\n").as_bytes()).await.unwrap();
        loop {
            let mut raw = String::new();
            if reader.read_line(&mut raw).await.unwrap() == 0 { break; }
            let envelope:Value = serde_json::from_str(&raw).unwrap();
            let frame:Value = serde_json::from_str(envelope["frame"].as_str().unwrap()).unwrap();
            let ack = json!({"type":"cano_input_ack","operation_id":envelope["operation_id"],"outcome":"written"});
            reader.get_mut().write_all(format!("{ack}\n").as_bytes()).await.unwrap();
            if frame["type"] == "user" {
                use std::io::Write;
                let mut file = std::fs::OpenOptions::new().append(true).open(&written).unwrap();
                writeln!(file,"{}",json!({"type":"attachment","uuid":"a-1","attachment":{"type":"queued_command","prompt":[{"type":"text","text":"Olá"}]}})).unwrap();
            }
        }
    });
    let (policy,_) = policy_server().await;
    let handle = claude_actor(dir.path(),address,policy).await;
    handle.queue("steer".into(),Action::Append { text:"Olá".into(),delivered:true,ts:None,pre_transcript:false,entry_id:Some("steer".into()) }).await.unwrap();
    let steer = RuntimeCommand { operation_id:"steer".into(),kind:OperationKind::Steer,payload:json!({"text":"Olá","entry_id":"steer"}) };
    assert!(handle.command(steer).await.unwrap().disposition == Disposition::Accepted);
    tokio::time::timeout(std::time::Duration::from_secs(3),async {
        loop {
            if queue_state(dir.path()).rows.iter().any(|row|row["id"] == "steer" && row["confirmed"] == true) { break; }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    }).await.expect("a linha da orientação no transcript precisa confirmar a entrada no meio do turno");
    handle.stop().await.unwrap();
    server.await.unwrap();
}

/// Cano Claude falso que, depois do retrato, manda as linhas dadas e aceita tudo o que chega.
async fn claude_cano(lines:Vec<Value>) -> (std::net::SocketAddr,tokio::task::JoinHandle<usize>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (stream,_) = listener.accept().await.unwrap();
        let mut reader = BufReader::new(stream);
        let mut header = String::new(); reader.read_line(&mut header).await.unwrap();
        let snapshot = json!({"type":"cano_snapshot","versao":2,"pid":42,"init":null,"aberto":false,
            "pendentes":[],"ultimo_result":null,"rate_limit":null,"stderr_tail":[],"saiu":null,"inflight":{}});
        reader.get_mut().write_all(format!("{snapshot}\n").as_bytes()).await.unwrap();
        for line in lines {
            let frame = json!({"type":"cano_output","frame":line.to_string()});
            reader.get_mut().write_all(format!("{frame}\n").as_bytes()).await.unwrap();
        }
        let mut sent = 0;
        loop {
            let mut raw = String::new();
            if reader.read_line(&mut raw).await.unwrap() == 0 { break; }
            let envelope:Value = serde_json::from_str(&raw).unwrap();
            let ack = json!({"type":"cano_input_ack","operation_id":envelope["operation_id"],"outcome":"written"});
            reader.get_mut().write_all(format!("{ack}\n").as_bytes()).await.unwrap();
            sent += 1;
        }
        sent
    });
    (address,server)
}

async fn claude_actor(dir:&std::path::Path,cano:std::net::SocketAddr,policy:std::net::SocketAddr) -> RuntimeHandle {
    let target = RuntimeTarget { key:"key".into(),generation:1,name:"session".into(),provider:"claude".into(),
        metadata:json!({"name":"session","headless":true,"session_id":"sid-1","initialized":true}),
        binding:CanoBinding { pid:42,escuta:format!("tcp:{cano}"),token:"secret-test".into(),versao:2 },
        lease_path:dir.join("key.lock"),state_path:dir.join("key.queue-state.json"),projection_dir:dir.join("projection"),
        transcript:dir.join("chat.jsonl"),created:0.0 };
    let lease = acquire_lease(&target.lease_path).unwrap();
    let store = Store::open(&target.state_path,&target.projection_dir,State::new("key",1,"session",vec![])).unwrap();
    let queue = QueueActor::start(store,lease);
    let connection = cano::connect(&target.binding).await.unwrap();
    let engine = RuntimeEngine::new("claude",target.metadata.clone(),1,ClockSample { monotonic_s:0.0,epoch_s:1_800_000_000.0 }).unwrap()
        // Espera curta pelo Python: o teste de falha confere o erro depois da série.
        .with_policy(PolicyClient::new(policy,"secret".into(),"instance".into()).with_ready_retry(std::time::Duration::from_millis(10),std::time::Duration::from_millis(200)));
    RuntimeActor::spawn(target,queue,connection,engine)
}

#[tokio::test]
async fn a_failed_sidecar_update_still_hands_the_session_over() {
    // Só status/carimbo/uso/registro são perdoados; o sidecar segura a conversa atual (session_id
    // depois do /clear), e perdê-lo calado deixaria o app lendo o transcript velho.
    let dir = tempfile::tempdir().unwrap();
    let closed = crate::refused_address();
    let (cano,server) = claude_cano(vec![json!({"type":"system","subtype":"init","session_id":"sid-2"})]).await;
    let handle = claude_actor(dir.path(),cano,closed).await;
    tokio::time::timeout(std::time::Duration::from_secs(5),async {
        loop {
            // A troca de conversa grava o sidecar pelo ciclo de vida do Rust; sem ele ligado, a gravação
            // falha e a sessão fica em erro, nunca seguindo calada na conversa velha.
            if handle.snapshot().await.unwrap()["error"] == "state_lifecycle_unbound" { break; }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    }).await.expect("falha do sidecar precisa pôr a sessão em erro");
    handle.stop().await.unwrap();
    server.await.unwrap();
}

#[tokio::test]
async fn a_native_message_that_fails_is_never_typed_nor_put_back_in_the_queue() {
    // O recado nativo sai pelo socket do Claude. Falha a partir dali (aqui, sem o registro do servidor
    // não há classe de modo) é incerta: a entrada não volta para a fila nem cai no teclado (seria
    // enviada de novo).
    use tokio::io::AsyncReadExt;
    let dir = tempfile::tempdir().unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let policy = listener.local_addr().unwrap();
    tokio::spawn(async move {
        loop {
            let Ok((stream,_)) = listener.accept().await else { return };
            tokio::spawn(async move {
                let mut reader = BufReader::new(stream);
                loop {
                    let mut length = 0usize;
                    loop {
                        let mut line = String::new();
                        if reader.read_line(&mut line).await.unwrap_or(0) == 0 { return; }
                        if line == "\r\n" { break; }
                        if let Some(value) = line.to_ascii_lowercase().strip_prefix("content-length:") { length = value.trim().parse().unwrap(); }
                    }
                    let mut body = vec![0;length]; reader.read_exact(&mut body).await.unwrap();
                    let kind = serde_json::from_slice::<Value>(&body).unwrap()["kind"].clone();
                    let data = if kind == "prepare_prompt" { json!({"content":"[de: par] oi","notices":[],"native_candidate":true}) }
                        else { json!({}) };
                    let reply = json!({"ok":true,"data":data}).to_string();
                    let response = format!("HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\n\r\n{reply}",reply.len());
                    if reader.get_mut().write_all(response.as_bytes()).await.is_err() { return; }
                }
            });
        }
    });
    let (cano,server) = claude_cano(vec![]).await;
    let handle = claude_actor(dir.path(),cano,policy).await;
    let input = RuntimeCommand { operation_id:"msg".into(),kind:OperationKind::Input,payload:json!({"text":"[de: par] oi","entry_id":"msg"}) };
    let reply = handle.command(input).await.unwrap();
    assert!(reply.disposition == Disposition::Unknown,"envio nativo que falha é incerto, nunca adiado");
    assert_eq!(reply.payload["error_code"],"native_mode_class_missing");
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    let state:State = queue_state(dir.path());
    assert!(state.rows.iter().any(|row|row["id"] == "msg" && row["delivered"] == true),"a entrada não volta para a fila");
    assert!(state.operations.get("msg").is_some_and(|op|op.status != Status::Deferred));
    handle.stop().await.unwrap();
    assert_eq!(server.await.unwrap(),0,"nada foi escrito no cano");
}

// --- Estado e prévia do Codex sem terminal pelo canal em processo (5B Task 9) ---

/// Cano Codex falso: depois do retrato manda o que o teste empurrar; responde e confirma cada escrita.
/// Devolve os métodos escritos no fio.
async fn codex_cano(pendentes:Vec<&'static str>) -> (std::net::SocketAddr,tokio::task::JoinHandle<Vec<String>>,tokio::sync::mpsc::UnboundedSender<Value>) {
    codex_cano_refusing(pendentes,0).await
}

/// `codex_cano` que recusa (erro JSON-RPC) os primeiros `refusals` `turn/start`.
async fn codex_cano_refusing(pendentes:Vec<&'static str>,mut refusals:usize) -> (std::net::SocketAddr,tokio::task::JoinHandle<Vec<String>>,tokio::sync::mpsc::UnboundedSender<Value>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (push,mut pushed) = tokio::sync::mpsc::unbounded_channel::<Value>();
    let server = tokio::spawn(async move {
        let (stream,_) = listener.accept().await.unwrap();
        let (read,mut write) = stream.into_split();
        let mut reader = BufReader::new(read);
        let mut header = String::new(); reader.read_line(&mut header).await.unwrap();
        let snapshot = json!({"type":"cano_snapshot","versao":2,"pid":42,"init":null,"aberto":false,
            "pendentes":pendentes,"ultimo_result":null,"rate_limit":null,"stderr_tail":[],"saiu":null,"inflight":{}});
        write.write_all(format!("{snapshot}\n").as_bytes()).await.unwrap();
        let mut methods = Vec::new();
        loop {
            let mut raw = String::new();
            tokio::select! {
                line = pushed.recv() => {
                    let Some(line) = line else { continue };
                    let frame = json!({"type":"cano_output","frame":line.to_string()});
                    if write.write_all(format!("{frame}\n").as_bytes()).await.is_err() { break; }
                }
                n = reader.read_line(&mut raw) => {
                    if n.unwrap_or(0) == 0 { break; }
                    let envelope:Value = serde_json::from_str(&raw).unwrap();
                    let frame:Value = serde_json::from_str(envelope["frame"].as_str().unwrap()).unwrap();
                    methods.push(frame["method"].as_str().unwrap_or("").to_owned());
                    let ack = json!({"type":"cano_input_ack","operation_id":envelope["operation_id"],"outcome":"written"});
                    write.write_all(format!("{ack}\n").as_bytes()).await.unwrap();
                    if frame.get("id").is_some() && frame.get("method").is_some() {
                        let refused = frame["method"] == "turn/start" && refusals > 0;
                        if refused { refusals -= 1; }
                        let result = if frame["method"] == "turn/start" { json!({"turn":{"id":"turn-1","status":"inProgress"}}) } else { json!({"data":[]}) };
                        let answer = if refused { json!({"id":frame["id"],"error":{"code":-32600,"message":"turn not accepted"}}) } else { json!({"id":frame["id"],"result":result}) };
                        let reply = json!({"type":"cano_output","frame":answer.to_string()});
                        write.write_all(format!("{reply}\n").as_bytes()).await.unwrap();
                    }
                }
            }
        }
        methods
    });
    (address,server,push)
}

async fn codex_live_actor(dir:&std::path::Path,cano:std::net::SocketAddr,live:Option<LiveSender>) -> RuntimeHandle {
    codex_live_actor_as(dir,cano,live,true).await
}

/// `headless: false` sem conversa identificada faz a subida recusar: é o ator que sai com erro.
async fn codex_live_actor_as(dir:&std::path::Path,cano:std::net::SocketAddr,live:Option<LiveSender>,headless:bool) -> RuntimeHandle {
    let target = RuntimeTarget { key:"key".into(),generation:1,name:"session".into(),provider:"codex".into(),
        metadata:json!({"name":"session","headless":headless,"thread_id":if headless { "thread-1" } else { "" },"initialized":true,"ready":headless}),
        binding:CanoBinding { pid:42,escuta:format!("tcp:{cano}"),token:"secret-test".into(),versao:2 },
        lease_path:dir.join("key.lock"),state_path:dir.join("key.queue-state.json"),projection_dir:dir.join("projection"),
        transcript:dir.join("chat.jsonl"),created:0.0 };
    let lease = acquire_lease(&target.lease_path).unwrap();
    let store = Store::open(&target.state_path,&target.projection_dir,State::new("key",1,"session",vec![])).unwrap();
    let queue = QueueActor::start(store,lease);
    let connection = cano::connect(&target.binding).await.unwrap();
    let mut engine = RuntimeEngine::new("codex",target.metadata.clone(),1,ClockSample { monotonic_s:0.0,epoch_s:1_800_000_000.0 }).unwrap();
    if let Some(live) = live { engine = engine.with_live(live); }
    RuntimeActor::spawn(target,queue,connection,engine)
}

async fn live_until(rx:&mut LiveReceiver,what:&str,check:impl Fn(&LiveState)->bool) -> std::sync::Arc<LiveState> {
    tokio::time::timeout(std::time::Duration::from_secs(5),async {
        loop {
            if let Some(state) = rx.borrow_and_update().clone() && check(&state) { return state; }
            rx.changed().await.unwrap();
        }
    }).await.unwrap_or_else(|_|panic!("{what}"))
}

fn delta(text:&str) -> Value { json!({"method":"item/agentMessage/delta","params":{"threadId":"thread-1","delta":text}}) }

#[tokio::test]
async fn codex_preview_goes_to_live_not_to_events() {
    // Prévia no `events` sobe a `revision` e o Python a decodifica: com o canal em processo, ela não vai lá.
    let dir = tempfile::tempdir().unwrap();
    let (cano,server,push) = codex_cano(vec![]).await;
    let (live,mut rx) = tokio::sync::watch::channel(None);
    let handle = codex_live_actor(dir.path(),cano,Some(live)).await;
    let mut events = handle.subscribe();
    // A abertura ainda anda a `revision`; sob carga, por mais que uma janela fixa. Mede depois que ela para.
    let revision = || async { handle.snapshot().await.unwrap()["revision"].as_u64().unwrap() };
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    let before = loop {
        let seen = revision().await;
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        if revision().await == seen { break seen; }
        assert!(std::time::Instant::now() < deadline, "a abertura do ator não assentou");
    };
    while events.try_recv().is_ok() {}
    push.send(delta("olá")).unwrap();
    live_until(&mut rx,"prévia no canal em processo",|s|s.preview == "olá").await;
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    while let Ok(event) = events.try_recv() {
        assert!(!["preview","thinking","tool"].contains(&event.channel.as_str()),"prévia foi ao events: {}",event.channel);
    }
    assert_eq!(handle.snapshot().await.unwrap()["revision"].as_u64().unwrap(),before,"a revision não anda com a prévia");
    handle.stop().await.unwrap();
    drop(push);
    server.abort();
}

#[tokio::test]
async fn codex_view_and_actor_error_reach_live() {
    let dir = tempfile::tempdir().unwrap();
    let (cano,server,push) = codex_cano(vec![]).await;
    let (live,mut rx) = tokio::sync::watch::channel(None);
    let handle = codex_live_actor(dir.path(),cano,Some(live)).await;
    // `Job::View` leva o estado público ao canal.
    push.send(json!({"method":"turn/started","params":{"threadId":"thread-1","turn":{"id":"turn-1"}}})).unwrap();
    live_until(&mut rx,"vista trabalhando no canal",|s|s.public_state["state"] == "working" && s.error.is_none()).await;
    handle.stop().await.unwrap();
    server.abort();
    // Ator que sai com erro deixa o erro marcado.
    let dir = tempfile::tempdir().unwrap();
    let (cano,server,_push) = codex_cano(vec![]).await;
    let (live,mut rx) = tokio::sync::watch::channel(None);
    let live_tx = live.clone();
    let handle = codex_live_actor_as(dir.path(),cano,Some(live),false).await;
    let state = live_until(&mut rx,"erro do ator no canal",|s|s.error.is_some()).await;
    assert!(!state.error.as_ref().unwrap().0.is_empty());
    let _ = handle.stop().await;
    server.abort();
    // O ator que volta (reaberto no mesmo canal) começa sem o erro.
    let (sender,mut rx) = (live_tx,rx);
    let dir = tempfile::tempdir().unwrap();
    let (cano,server,_push) = codex_cano(vec![]).await;
    let handle = codex_live_actor(dir.path(),cano,Some(sender)).await;
    live_until(&mut rx,"erro some com o ator de volta",|s|s.error.is_none()).await;
    handle.stop().await.unwrap();
    server.abort();
}

#[tokio::test]
async fn claude_headless_view_and_preview_go_to_live_not_to_events() {
    let dir = tempfile::tempdir().unwrap();
    let (cano,server) = claude_cano(vec![json!({"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"oi"}}})]).await;
    let target = RuntimeTarget { key:"key".into(),generation:1,name:"session".into(),provider:"claude".into(),
        metadata:json!({"name":"session","headless":true,"session_id":"sid-1","initialized":true}),
        binding:CanoBinding { pid:42,escuta:format!("tcp:{cano}"),token:"secret-test".into(),versao:2 },
        lease_path:dir.path().join("key.lock"),state_path:dir.path().join("key.queue-state.json"),projection_dir:dir.path().join("projection"),
        transcript:dir.path().join("chat.jsonl"),created:0.0 };
    let lease = acquire_lease(&target.lease_path).unwrap();
    let store = Store::open(&target.state_path,&target.projection_dir,State::new("key",1,"session",vec![])).unwrap();
    let (events,mut rx) = tokio::sync::broadcast::channel(64);
    let (live,mut live_rx) = tokio::sync::watch::channel(None);
    let engine = RuntimeEngine::new("claude",target.metadata.clone(),1,ClockSample { monotonic_s:0.0,epoch_s:1_800_000_000.0 }).unwrap()
        .with_publisher(events).with_live(live);
    let connection = cano::connect(&target.binding).await.unwrap();
    let handle = RuntimeActor::spawn(target,QueueActor::start(store,lease),connection,engine);
    // Turno que a CLI já tocava (reabertura): a vista sai `working` junto com a prévia.
    live_until(&mut live_rx,"prévia do Claude sem terminal no canal em processo",
        |s|s.preview == "oi" && s.public_state["state"] == "working").await;
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    while let Ok(event) = rx.try_recv() {
        assert!(!["preview","thinking","tool"].contains(&event.channel.as_str()),"prévia foi ao events: {}",event.channel);
    }
    handle.stop().await.unwrap();
    server.await.unwrap();
}

#[tokio::test]
async fn queued_input_drains_without_any_subscriber() {
    // O gatilho de entrega do `sse.py` some para o Codex: o ator drena sozinho no fim do turno.
    let dir = tempfile::tempdir().unwrap();
    let (cano,server,push) = codex_cano(vec![]).await;
    let (live,mut rx) = tokio::sync::watch::channel(None);
    let handle = codex_live_actor(dir.path(),cano,Some(live)).await;
    let first = handle.command(RuntimeCommand { operation_id:"in-1".into(),kind:OperationKind::Input,payload:json!({"text":"um"}) }).await.unwrap();
    assert!(first.disposition == Disposition::Accepted);
    push.send(json!({"method":"turn/started","params":{"threadId":"thread-1","turn":{"id":"turn-1"}}})).unwrap();
    live_until(&mut rx,"turno aberto",|s|s.public_state["state"] == "working").await;
    handle.queue("append-2".into(),Action::Append { text:"dois".into(),delivered:false,ts:None,pre_transcript:false,entry_id:Some("in-2".into()) }).await.unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    let path = dir.path().join("key.queue-state.json");
    let sent = |path:&std::path::Path| { let state:State = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
        state.operations.get("in-2").is_some_and(|op|matches!(op.status,Status::Accepted | Status::Confirmed)) };
    assert!(!sent(&path),"com turno rodando a segunda espera");
    push.send(json!({"method":"turn/completed","params":{"threadId":"thread-1","turn":{"id":"turn-1","status":"completed"}}})).unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(5),async { while !sent(&path) { tokio::time::sleep(std::time::Duration::from_millis(20)).await; } })
        .await.expect("fim do turno drena a fila sem assinante nenhum");
    handle.stop().await.unwrap();
    drop(push);
    let methods = server.await.unwrap();
    assert_eq!(methods.iter().filter(|m|*m == "turn/start").count(),2,"{methods:?}");
}

#[tokio::test]
async fn refused_turn_start_puts_the_input_back_and_the_next_idle_sends_it() {
    // Recusa explícita do Codex: nada começou, a entrada volta à fila (`deferred` do Python) e sai no próximo ocioso.
    let dir = tempfile::tempdir().unwrap();
    let (cano,server,push) = codex_cano_refusing(vec![],1).await;
    let handle = codex_live_actor(dir.path(),cano,None).await;
    let first = handle.command(RuntimeCommand { operation_id:"in-1".into(),kind:OperationKind::Input,payload:json!({"text":"um"}) }).await.unwrap();
    assert!(first.disposition == Disposition::Deferred,"{first:?}");
    let path = dir.path().join("key.queue-state.json");
    let row = |path:&std::path::Path| { let state:State = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
        state.rows.iter().find(|row|row["id"] == "in-1").cloned() };
    tokio::time::timeout(std::time::Duration::from_secs(5),async { while row(&path).is_none_or(|row|row["delivered"] != false) { tokio::time::sleep(std::time::Duration::from_millis(20)).await; } })
        .await.expect("a entrada recusada volta para a fila");
    push.send(json!({"method":"thread/status/changed","params":{"threadId":"thread-1","status":{"type":"idle"}}})).unwrap();
    let sent = |path:&std::path::Path| { let state:State = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
        state.operations.get("in-1").is_some_and(|op|matches!(op.status,Status::Accepted | Status::Confirmed)) };
    tokio::time::timeout(std::time::Duration::from_secs(5),async { while !sent(&path) { tokio::time::sleep(std::time::Duration::from_millis(20)).await; } })
        .await.expect("o ocioso seguinte entrega a mensagem");
    handle.stop().await.unwrap();
    drop(push);
    let methods = server.await.unwrap();
    assert_eq!(methods.iter().filter(|m|*m == "turn/start").count(),2,"{methods:?}");
}

// --- Codex sem terminal nasce e religa no Rust (5B Task 4) ---

#[cfg(target_os = "linux")]
mod launch {
    use super::*;
    use hangar_server::runtime::gateway::RuntimeRegistry;
    use hangar_server::runtime::process;
    use std::sync::{Arc,Mutex};
    use tokio::io::AsyncReadExt;

    fn unique_key() -> String {
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos() as u64;
        format!("{:016x}{:04x}",nanos ^ ((std::process::id() as u64) << 32),rand_suffix())
    }
    fn rand_suffix() -> u16 { static N:std::sync::atomic::AtomicU16 = std::sync::atomic::AtomicU16::new(0); N.fetch_add(1,std::sync::atomic::Ordering::Relaxed) }

    use crate::use_cano_bin;

    /// `codex app-server --stdio` falso: responde `initialize` e a abertura da conversa.
    fn fake_codex(dir:&std::path::Path) -> std::path::PathBuf {
        
        let path = dir.join("codex");
        crate::write_executable(&path, format!(r#"#!/usr/bin/env python3
import json, sys
for line in sys.stdin:
    msg = json.loads(line)
    if "id" not in msg or "method" not in msg:
        continue
    method = msg["method"]
    if method == "initialize":
        result = {{"userAgent": "hangar/{} (x)"}}
    elif method in ("thread/start", "thread/resume"):
        result = {{"thread": {{"id": "thread-new", "path": "/tmp/rollout-thread-new.jsonl", "status": {{"type": "idle"}}}}, "model": "gpt-test"}}
    else:
        result = {{}}
    print(json.dumps({{"id": msg["id"], "result": result}}), flush=True)
"#,hangar_codex::version::CHECKED));
        path
    }

    fn env(key:&str,owner:&str) -> Value {
        let mut env:serde_json::Map<String,Value> = std::env::vars().filter(|(k,_)|!k.starts_with("HANGAR_CANO_")).map(|(k,v)|(k,json!(v))).collect();
        env.insert("HANGAR_CANO_KEY".into(),json!(key));
        env.insert("HANGAR_CANO_OWNER".into(),json!(owner));
        Value::Object(env)
    }

    /// Ambiente-base da subida (`with_codex_environment`): o do processo, com HOME na pasta do teste
    /// (conta padrão e configuração do Jev isoladas) e um PATH só com ela e o `python3` do script: o
    /// `codex` de verdade da máquina nunca é achado, nem com o falso escondido.
    fn codex_env(dir:&std::path::Path) -> hangar_server::accounts::environment::AccountEnvironment {
        let mut map:std::collections::BTreeMap<String,String> = std::env::vars()
            .filter(|(k,_)|!k.starts_with("HANGAR_CANO_") && !matches!(k.as_str(),"CODEX_HOME" | "CLAUDE_CONFIG_DIR")).collect();
        let python = std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()).map(|p|p.join("python3")).find(|p|p.is_file()).expect("python3 no PATH");
        let tools = dir.join(".tools");
        std::fs::create_dir_all(&tools).unwrap();
        if let Err(error) = std::os::unix::fs::symlink(python,tools.join("python3")) { assert_eq!(error.kind(),std::io::ErrorKind::AlreadyExists); }
        let path = std::env::join_paths([dir.to_path_buf(),tools]).unwrap();
        map.insert("PATH".into(),path.to_string_lossy().into_owned());
        map.insert("HOME".into(),dir.to_string_lossy().into_owned());
        hangar_server::accounts::environment::AccountEnvironment::from_map(map)
    }

    /// O sidecar que o Python grava ao criar a sessão: sem ele a subida recusa (`session_patch_owner`).
    fn write_sidecar(dir:&std::path::Path,key:&str,extra:Value) {
        let mut meta = json!({"name":"cx","key":key,"provider":"codex","headless":true,"cwd":dir});
        for (field,value) in extra.as_object().unwrap() { meta[field] = value.clone(); }
        std::fs::write(dir.join("cx.json"),meta.to_string()).unwrap();
    }
    fn sidecar(dir:&std::path::Path) -> Value { serde_json::from_slice(&std::fs::read(dir.join("cx.json")).unwrap()).unwrap() }

    /// Nenhuma política da subida nem do arquivo da sessão do Codex chega ao Python.
    fn assert_python_untouched(calls:&Arc<Mutex<Vec<(String,Value)>>>) {
        let leaked:Vec<String> = calls.lock().unwrap().iter().map(|(kind,_)|kind.clone())
            .filter(|kind|matches!(kind.as_str(),"launch_env" | "session.patch_meta" | "session.clear_cano")).collect();
        assert!(leaked.is_empty(),"o Codex pediu ao Python: {leaked:?}");
    }

    /// Python falso: anota cada pedido e responde `ok` vazio. Com o Codex local, nada da subida nem do
    /// arquivo da sessão deveria chegar aqui.
    async fn policy() -> (std::net::SocketAddr,Arc<Mutex<Vec<(String,Value)>>>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let calls = Arc::new(Mutex::new(Vec::new()));
        let seen = calls.clone();
        tokio::spawn(async move {
            loop {
                let Ok((stream,_)) = listener.accept().await else { return };
                let seen = seen.clone();
                tokio::spawn(async move {
                    let mut reader = BufReader::new(stream);
                    loop {
                        let mut length = 0usize;
                        loop {
                            let mut line = String::new();
                            if reader.read_line(&mut line).await.unwrap_or(0) == 0 { return; }
                            if line == "\r\n" { break; }
                            if let Some(value) = line.to_ascii_lowercase().strip_prefix("content-length:") { length = value.trim().parse().unwrap(); }
                        }
                        let mut body = vec![0;length]; reader.read_exact(&mut body).await.unwrap();
                        // Só as políticas interessam; o resto (diário) recebe `{}`.
                        let body:Value = serde_json::from_slice(&body).unwrap_or_default();
                        let kind = body["kind"].as_str().unwrap_or("").to_owned();
                        seen.lock().unwrap().push((kind,body["payload"].clone()));
                        let reply = json!({"ok":true,"data":{}}).to_string();
                        let response = format!("HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\n\r\n{reply}",reply.len());
                        if reader.get_mut().write_all(response.as_bytes()).await.is_err() { return; }
                    }
                });
            }
        });
        (address,calls)
    }

    fn target(dir:&std::path::Path,key:&str,binding:CanoBinding) -> RuntimeTarget {
        RuntimeTarget { key:key.into(),generation:1,name:"cx".into(),provider:"codex".into(),
            metadata:json!({"name":"cx","key":key,"headless":true,"cwd":dir}),binding,
            lease_path:dir.join("q.lock"),state_path:dir.join("q.json"),projection_dir:dir.join("projection"),
            transcript:dir.join("rollout.jsonl"),created:0.0 }
    }

    async fn until_ready(registry:&RuntimeRegistry,key:&str) {
        let handle = registry.handle(key,1).await.unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(15),async {
            loop {
                if handle.snapshot().await.unwrap()["view"]["ready"] == true { break; }
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            }
        }).await.expect("o motor chega a ready no processo novo");
    }

    fn no_cano() -> CanoBinding { CanoBinding { pid:0,escuta:String::new(),token:String::new(),versao:2 } }

    #[tokio::test]
    async fn open_with_launch_and_no_cano_spawns_records_and_gets_ready() {
        use_cano_bin();
        let dir = tempfile::tempdir().unwrap();
        let key = unique_key();
        let owner = dir.path().to_string_lossy().into_owned();
        fake_codex(dir.path());
        write_sidecar(dir.path(),&key,json!({}));
        let (address,calls) = policy().await;
        let registry = RuntimeRegistry::new(address,"secret".into(),"instance".into()).with_codex_environment(codex_env(dir.path()));
        let opened = registry.open_with_launch(target(dir.path(),&key,no_cano()),dir.path().into()).await.unwrap();
        assert_eq!(opened["opened"],true);
        until_ready(&registry,&key).await;
        let recorded = sidecar(dir.path())["cano"].clone();
        let pid = recorded["pid"].as_u64().expect("o cano novo vai para o arquivo da sessão") as u32;
        assert_eq!(recorded["versao"],2);
        assert!(matches!(process::liveness(pid,&key),process::Liveness::Ours));
        // O processo nasceu com o ambiente calculado aqui: chave e dono do cano.
        let environ = std::fs::read(format!("/proc/{pid}/environ")).unwrap();
        assert!(environ.split(|b|*b == 0).any(|var|var == format!("HANGAR_CANO_KEY={key}").as_bytes()));
        assert!(environ.split(|b|*b == 0).any(|var|var == format!("HANGAR_CANO_OWNER={owner}").as_bytes()));
        assert_python_untouched(&calls);
        registry.close(&key,1).await.unwrap();
        let cano:process::Cano = serde_json::from_value(recorded).unwrap();
        process::kill(&cano,&key,dir.path()).await.unwrap();
    }

    #[tokio::test]
    async fn open_with_launch_and_live_cano_connects_without_spawning() {
        use_cano_bin();
        let dir = tempfile::tempdir().unwrap();
        let key = unique_key();
        let owner = dir.path().to_string_lossy().into_owned();
        let codex = fake_codex(dir.path());
        let env:Vec<(String,String)> = env(&key,&owner).as_object().unwrap().iter().map(|(k,v)|(k.clone(),v.as_str().unwrap().to_owned())).collect();
        let live = process::spawn(&process::LaunchSpec { provider:process::Provider::Codex,key:key.clone(),cwd:dir.path().into(),
            program:vec![codex.to_string_lossy().into_owned(),"app-server".into(),"--stdio".into()],env,
            cano_extra:Default::default(),sidecar_dir:dir.path().into() }).await.unwrap();
        write_sidecar(dir.path(),&key,json!({"cano":serde_json::to_value(&live).unwrap()}));
        let (address,calls) = policy().await;
        let registry = RuntimeRegistry::new(address,"secret".into(),"instance".into()).with_codex_environment(codex_env(dir.path()));
        let binding = CanoBinding { pid:live.pid,escuta:live.escuta.clone(),token:live.token.clone(),versao:2 };
        registry.open_with_launch(target(dir.path(),&key,binding),dir.path().into()).await.unwrap();
        until_ready(&registry,&key).await;
        assert_eq!(sidecar(dir.path())["cano"]["pid"],live.pid,"cano vivo da sessão: conecta e não sobe outro");
        assert_python_untouched(&calls);
        registry.close(&key,1).await.unwrap();
        process::kill(&live,&key,dir.path()).await.unwrap();
    }

    // --- Ciclo de vida no Rust (5B Task 5) ---

    #[tokio::test]
    async fn open_without_launch_still_manages_the_process() {
        use_cano_bin();
        let dir = tempfile::tempdir().unwrap();
        let key = unique_key();
        let owner = dir.path().to_string_lossy().into_owned();
        let codex = fake_codex(dir.path());
        let env:Vec<(String,String)> = env(&key,&owner).as_object().unwrap().iter().map(|(k,v)|(k.clone(),v.as_str().unwrap().to_owned())).collect();
        let live = process::spawn(&process::LaunchSpec { provider:process::Provider::Codex,key:key.clone(),cwd:dir.path().into(),
            program:vec![codex.to_string_lossy().into_owned(),"app-server".into(),"--stdio".into()],env,
            cano_extra:Default::default(),sidecar_dir:dir.path().into() }).await.unwrap();
        write_sidecar(dir.path(),&key,json!({"cano":serde_json::to_value(&live).unwrap()}));
        let (address,calls) = policy().await;
        let registry = RuntimeRegistry::new(address,"secret".into(),"instance".into()).with_codex_environment(codex_env(dir.path()));
        let binding = CanoBinding { pid:live.pid,escuta:live.escuta.clone(),token:live.token.clone(),versao:2 };
        // Reaberta sem subir (a administração do Python): encerrar ainda mata o processo.
        registry.open_managed(target(dir.path(),&key,binding),dir.path().into()).await.unwrap();
        until_ready(&registry,&key).await;
        assert_eq!(registry.close_with_kill(&key,1).await.unwrap(),json!({"closed":true,"killed":true}));
        assert!(matches!(process::liveness(live.pid,&key),process::Liveness::Dead));
        assert_python_untouched(&calls);
    }

    /// `codex` falso que anota cada subida e cada pedido em `calls.jsonl`. Com `crash` na pasta cai no
    /// primeiro pedido (antes de ficar pronto); sem ele, cai quando `die` aparece na pasta. `turn/start` abre um
    /// turno que só `turn/interrupt` fecha.
    fn lifecycle_codex(dir:&std::path::Path) -> std::path::PathBuf {
        
        let path = dir.join("codex");
        crate::write_executable(&path, format!(r#"#!/usr/bin/env python3
import json, os, sys, threading, time
d = os.path.dirname(os.path.abspath(__file__))
def note(entry):
    with open(os.path.join(d, "calls.jsonl"), "a") as f:
        f.write(json.dumps(entry) + "\n")
note({{"start": time.time(), "pid": os.getpid(), "ppid": os.getppid()}})
crash = os.path.exists(os.path.join(d, "crash"))
def watch():
    while not os.path.exists(os.path.join(d, "die")):
        time.sleep(0.02)
    os._exit(1)
if not crash:
    threading.Thread(target=watch, daemon=True).start()
def send(obj):
    print(json.dumps(obj), flush=True)
for line in sys.stdin:
    msg = json.loads(line)
    if "method" not in msg:
        continue
    method = msg["method"]
    note({{"method": method, "params": msg.get("params") or {{}}}})
    if crash:
        os._exit(1)
    if "id" not in msg:
        continue
    if method == "initialize":
        result = {{"userAgent": "hangar/{} (x)"}}
    elif method == "thread/resume" and os.path.exists(os.path.join(d, "tier")):
        result = {{"thread": {{"id": "thread-new", "path": "/tmp/rollout-thread-new.jsonl", "status": {{"type": "idle"}}}}, "model": "gpt-test", "serviceTier": "default"}}
    elif method in ("thread/start", "thread/resume"):
        result = {{"thread": {{"id": "thread-new", "path": "/tmp/rollout-thread-new.jsonl", "status": {{"type": "idle"}}}}, "model": "gpt-test"}}
    elif method == "thread/settings/update" and os.path.exists(os.path.join(d, "tier")):
        # Como o Codex: a troca de Fast chega também como aviso da thread, que o motor exige antes de conferir.
        send({{"method": "thread/settings/updated", "params": {{"threadId": "thread-new", "threadSettings": {{"serviceTier": msg["params"].get("serviceTier")}}}}}})
        result = {{}}
    elif method == "turn/start":
        result = {{"turn": {{"id": "turn-1", "status": "inProgress"}}}}
    elif method == "thread/read" and os.path.exists(os.path.join(d, "cut")):
        result = {{"thread": {{"id": "thread-new", "status": {{"type": "idle"}}, "turns": [{{"id": "turn-1", "status": "interrupted", "items": []}}]}}}}
    elif method == "turn/interrupt":
        send({{"id": msg["id"], "result": {{}}}})
        send({{"method": "turn/completed", "params": {{"threadId": "thread-new", "turn": {{"id": "turn-1", "status": "interrupted"}}}}}})
        continue
    else:
        result = {{}}
    send({{"id": msg["id"], "result": result}})
"#,hangar_codex::version::CHECKED));
        path
    }

    fn calls(dir:&std::path::Path) -> Vec<Value> {
        std::fs::read_to_string(dir.join("calls.jsonl")).unwrap_or_default().lines().map(|line|serde_json::from_str(line).unwrap()).collect()
    }
    fn starts(dir:&std::path::Path) -> Vec<f64> { calls(dir).iter().filter_map(|call|call["start"].as_f64()).collect() }

    /// Canos subidos, na ordem: o `codex` falso anota o pai (o cano, que o roda direto) a cada subida.
    /// Só o pid: `kill` e `liveness` conferem por ele e pela chave.
    fn recorded(dir:&std::path::Path) -> Vec<process::Cano> {
        calls(dir).iter().filter_map(|call|call["ppid"].as_u64())
            .map(|pid|process::Cano { pid:pid as u32,escuta:String::new(),token:String::new(),ts:0.0,versao:2,extra:Default::default() }).collect()
    }

    async fn lifecycle_session(dir:&std::path::Path,key:&str,mode:&str,base:std::time::Duration) -> (Arc<RuntimeRegistry>,Arc<Mutex<Vec<(String,Value)>>>) {
        use_cano_bin();
        lifecycle_codex(dir);
        // Sem modo no sidecar: vale o da abertura, e o patch do modo fica visível no arquivo.
        write_sidecar(dir,key,json!({}));
        let (address,calls) = policy().await;
        let registry = Arc::new(RuntimeRegistry::new(address,"secret".into(),"instance".into()).with_respawn_base(base).with_codex_environment(codex_env(dir)));
        let mut target = target(dir,key,no_cano());
        target.metadata["permission_mode"] = json!(mode);
        registry.open_with_launch(target,dir.into()).await.unwrap();
        until_ready(&registry,key).await;
        (registry,calls)
    }

    async fn until<F:Fn()->bool>(what:&str,check:F) {
        tokio::time::timeout(std::time::Duration::from_secs(20),async { while !check() { tokio::time::sleep(std::time::Duration::from_millis(20)).await; } })
            .await.unwrap_or_else(|_|panic!("{what}"));
    }

    fn control(id:&str,kind:OperationKind,payload:Value) -> RuntimeCommand { RuntimeCommand { operation_id:id.into(),kind,payload } }

    async fn cleanup(registry:&RuntimeRegistry,key:&str,dir:&std::path::Path,calls:&Arc<Mutex<Vec<(String,Value)>>>) {
        let _ = registry.close(key,1).await;
        // O `codex` falso simples não anota subidas: o cano dele é o do sidecar.
        let current = std::fs::read(dir.join("cx.json")).ok().and_then(|raw|serde_json::from_slice::<Value>(&raw).ok())
            .and_then(|meta|serde_json::from_value::<process::Cano>(meta["cano"].clone()).ok());
        for cano in recorded(dir).into_iter().chain(current) { let _ = process::kill(&cano,key,dir).await; }
        assert_python_untouched(calls);
    }

    #[tokio::test]
    async fn cano_exit_respawns_with_backoff_up_to_three() {
        let dir = tempfile::tempdir().unwrap();
        let key = unique_key();
        let base = std::time::Duration::from_millis(300);
        let (registry,policy) = lifecycle_session(dir.path(),&key,"Full Access",base).await;
        // A partir daqui toda subida cai antes de ficar pronta.
        std::fs::write(dir.path().join("crash"),"").unwrap();
        std::fs::write(dir.path().join("die"),"").unwrap();
        until("três subidas depois da queda",||starts(dir.path()).len() >= 4).await;
        tokio::time::sleep(base * 8 + std::time::Duration::from_secs(1)).await;
        let starts = starts(dir.path());
        assert_eq!(starts.len(),4,"teto de 3 subidas seguidas: {starts:?}");
        for (index,pair) in starts.windows(2).enumerate() {
            let wanted = base.as_secs_f64() * f64::from(1u32 << index);
            assert!(pair[1] - pair[0] >= wanted * 0.9,"espera {index} cresce dobrando: {:?} < {wanted}",pair[1] - pair[0]);
        }
        let handle = registry.handle(&key,1).await.unwrap();
        let snapshot = handle.snapshot().await.unwrap();
        assert_eq!(snapshot["view"]["public_state"]["problema"],"codex_headless_nao_subiu",
            "teto esgotado deixa a sessão com o problema: {}",snapshot["view"]["public_state"]);
        assert_eq!(sidecar(dir.path())["cano"]["pid"],recorded(dir.path())[3].pid,"cada subida grava o cano novo no arquivo da sessão");
        cleanup(&registry,&key,dir.path(),&policy).await;
    }

    #[tokio::test]
    async fn new_thread_id_is_saved_in_the_view_before_the_patch() {
        // O patch confere a vista salva: a thread nova tem que estar nela antes do
        // `session.patch_meta {thread_id}`, senão o arquivo da sessão fica sem a thread.
        for _ in 0..5 {
            use_cano_bin();
            let dir = tempfile::tempdir().unwrap();
            let key = unique_key();
            fake_codex(dir.path());
            write_sidecar(dir.path(),&key,json!({"thread_id":"thread-old"}));
            let (address,calls) = policy().await;
            let registry = RuntimeRegistry::new(address,"secret".into(),"instance".into()).with_codex_environment(codex_env(dir.path()));
            registry.open_with_launch(target(dir.path(),&key,no_cano()),dir.path().into()).await.unwrap();
            until_ready(&registry,&key).await;
            until("thread gravada no arquivo da sessão",||sidecar(dir.path())["thread_id"] == "thread-new").await;
            let meta = sidecar(dir.path());
            assert_eq!(meta["rollout_path"],"/tmp/rollout-thread-new.jsonl");
            assert!(handle_view(&registry,&key).await["public_state"]["problema"].is_null(),"patch recusado como velho");
            cleanup(&registry,&key,dir.path(),&calls).await;
        }
    }

    /// Sidecar reescrito por outra vida (outra chave): o patch local recusa, nada é gravado e a sessão
    /// mostra o problema, como a recusa do Python.
    #[tokio::test]
    async fn patch_on_a_sidecar_of_another_life_shows_a_problem() {
        let dir = tempfile::tempdir().unwrap();
        let key = unique_key();
        let (registry,calls) = lifecycle_session(dir.path(),&key,"Full Access",std::time::Duration::from_secs(5)).await;
        let mut events = registry.subscribe();
        // Com a trava, como a outra vida grava: sem ela, um patch desta vida ainda a caminho lê o arquivo
        // antigo e o recoloca por cima, e o patch do modo deixa de ser recusado.
        let other = json!({"name":"cx","key":"other-life","provider":"codex","headless":true,"cwd":dir.path()});
        hangar_server::runtime::codex_sidecar::locked(dir.path(),"cx",|path|std::fs::write(path,other.to_string())).unwrap();
        let handle = registry.handle(&key,1).await.unwrap();
        let _ = handle.command(control("perm-1",OperationKind::SetPermissionMode,json!({"mode":"full access"}))).await;
        tokio::time::timeout(std::time::Duration::from_secs(10),async {
            loop {
                match events.recv().await {
                    Ok(event) if event.channel == "problem" && event.data["error_code"] == "session_patch_owner" => break,
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => panic!("canal de eventos fechou"),
                    _ => {},
                }
            }
        }).await.expect("recusa do sidecar aparece como problema");
        assert!(sidecar(dir.path()).get("permission_mode").is_none(),"nada gravado no sidecar da outra vida");
        cleanup(&registry,&key,dir.path(),&calls).await;
    }

    /// Reação do ator ao `stale` do patch local: Fast confirmado quando o sidecar já está noutra thread
    /// é recusado como velho, nada é gravado e, sem ser a conversa, a sessão segue sem problema.
    #[tokio::test]
    async fn stale_fast_patch_on_headless_is_only_logged() {
        let dir = tempfile::tempdir().unwrap();
        let key = unique_key();
        let (registry,calls) = lifecycle_session(dir.path(),&key,"Full Access",std::time::Duration::from_secs(5)).await;
        until("thread no sidecar",||sidecar(dir.path())["thread_id"] == "thread-new").await;
        let mut moved = sidecar(dir.path());
        moved["thread_id"] = json!("thread-other");
        // Sob a trava do sidecar, como o Rust e o Python gravam.
        hangar_server::runtime::codex_sidecar::locked(dir.path(),"cx",|path|std::fs::write(path,moved.to_string())).unwrap();
        std::fs::write(dir.path().join("tier"),"").unwrap();
        let handle = registry.handle(&key,1).await.unwrap();
        let reply = handle.command(control("tier-1",OperationKind::SetServiceTier,json!({"service_tier":"default"}))).await.unwrap();
        assert!(reply.disposition == Disposition::Accepted,"a confirmação do Codex vale; só o arquivo recusa: {:?}",reply.payload);
        // O mesmo job salva a vista com o Fast e logo depois roda o patch: esperar por ela prova que o patch foi pedido.
        until("vista salva com o Fast",||std::fs::read(dir.path().join("q.json")).ok()
            .and_then(|raw|serde_json::from_slice::<Value>(&raw).ok())
            .is_some_and(|state|state["runtime_state"]["view"]["service_tier"] == "default")).await;
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        let meta = sidecar(dir.path());
        assert!(meta.get("service_tier").is_none_or(Value::is_null),"Fast de outra thread não entra no sidecar: {meta}");
        assert_eq!(meta["thread_id"],"thread-other");
        let view = handle_view(&registry,&key).await;
        assert!(view["public_state"]["problema"].is_null(),"stale fora da conversa só vai ao log: {}",view["public_state"]);
        assert!(handle.snapshot().await.unwrap()["error"].is_null(),"a sessão segue no Rust");
        cleanup(&registry,&key,dir.path(),&calls).await;
    }

    #[tokio::test]
    async fn restart_kills_and_respawns_on_the_same_thread() {
        let dir = tempfile::tempdir().unwrap();
        let key = unique_key();
        let (registry,policy) = lifecycle_session(dir.path(),&key,"Full Access",std::time::Duration::from_secs(5)).await;
        let old = recorded(dir.path())[0].clone();
        let handle = registry.handle(&key,1).await.unwrap();
        let reply = handle.command(control("restart-1",OperationKind::Restart,json!({}))).await.unwrap();
        assert!(reply.disposition == Disposition::Accepted,"reiniciar responde aceito");
        assert!(matches!(process::liveness(old.pid,&key),process::Liveness::Dead),"o processo antigo morreu");
        let canos = recorded(dir.path());
        assert_eq!(canos.len(),2);
        assert!(matches!(process::liveness(canos[1].pid,&key),process::Liveness::Ours));
        until_ready(&registry,&key).await;
        let resumed:Vec<Value> = calls(dir.path()).into_iter().filter(|call|call["method"] == "thread/resume").collect();
        assert_eq!(resumed.last().unwrap()["params"]["threadId"],"thread-new","a conversa continua na mesma thread");
        assert_eq!(starts(dir.path()).len(),2,"um processo novo, nunca dois");
        cleanup(&registry,&key,dir.path(),&policy).await;
    }

    #[tokio::test]
    async fn permission_same_sandbox_only_patches_meta() {
        let dir = tempfile::tempdir().unwrap();
        let key = unique_key();
        let (registry,policy) = lifecycle_session(dir.path(),&key,"Full Access",std::time::Duration::from_secs(5)).await;
        let handle = registry.handle(&key,1).await.unwrap();
        let reply = handle.command(control("perm-1",OperationKind::SetPermissionMode,json!({"mode":"full access"}))).await.unwrap();
        assert!(reply.disposition == Disposition::Accepted);
        assert_eq!(reply.payload,json!({"current":"Full Access"}));
        until("modo gravado no arquivo da sessão",||sidecar(dir.path())["permission_mode"] == "Full Access").await;
        assert_eq!(starts(dir.path()).len(),1,"mesmo sandbox: nenhum processo novo");
        let unknown = handle.command(control("perm-2",OperationKind::SetPermissionMode,json!({"mode":"turbo"}))).await;
        assert_eq!(unknown.err().unwrap().code,"erro_modo_desconhecido");
        cleanup(&registry,&key,dir.path(),&policy).await;
    }

    #[tokio::test]
    async fn permission_other_sandbox_respawns_when_idle_and_refuses_when_busy() {
        let dir = tempfile::tempdir().unwrap();
        let key = unique_key();
        let (registry,policy) = lifecycle_session(dir.path(),&key,"Full Access",std::time::Duration::from_secs(5)).await;
        let handle = registry.handle(&key,1).await.unwrap();
        let input = handle.command(RuntimeCommand { operation_id:"in-1".into(),kind:OperationKind::Input,payload:json!({"text":"oi"}) }).await.unwrap();
        assert!(input.disposition == Disposition::Accepted);
        until("turno aberto",||calls(dir.path()).iter().any(|call|call["method"] == "turn/start")).await;
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        let busy = handle.command(control("perm-busy",OperationKind::SetPermissionMode,json!({"mode":"Ask for approval"}))).await;
        assert_eq!(busy.err().unwrap().code,"erro_permissao_ocupada");
        assert_eq!(starts(dir.path()).len(),1,"ocupada: nada morre, nada sobe");
        assert!(matches!(process::liveness(recorded(dir.path())[0].pid,&key),process::Liveness::Ours));
        handle.command(control("stop-1",OperationKind::Interrupt,json!({}))).await.unwrap();
        until_idle(&handle).await;
        let reply = handle.command(control("perm-idle",OperationKind::SetPermissionMode,json!({"mode":"Ask for approval"}))).await.unwrap();
        assert_eq!(reply.payload,json!({"current":"Ask for approval"}));
        until("ocioso: processo novo",||recorded(dir.path()).len() >= 2).await;
        let canos = recorded(dir.path());
        assert_eq!(canos.len(),2);
        assert!(matches!(process::liveness(canos[0].pid,&key),process::Liveness::Dead));
        // O modo é gravado antes do comando novo: o processo novo já nasce no sandbox dele.
        assert_eq!(sidecar(dir.path())["permission_mode"],"Ask for approval");
        let cmdline = String::from_utf8_lossy(&std::fs::read(format!("/proc/{}/cmdline",canos[1].pid)).unwrap()).replace('\0'," ");
        assert!(cmdline.contains("sandbox_mode=\"read-only\""),"{cmdline}");
        until_ready(&registry,&key).await;
        let resumed:Vec<Value> = calls(dir.path()).into_iter().filter(|call|call["method"] == "thread/resume").collect();
        assert_eq!(resumed.last().unwrap()["params"]["sandbox"],"read-only");
        assert_eq!(resumed.last().unwrap()["params"]["threadId"],"thread-new");
        // A lista de modos (`GET /codex-permissions`) lê a vista publicada: a vida nova a mostra com o modo novo.
        let handle = registry.handle(&key,1).await.unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(5),async {
            while handle.snapshot().await.unwrap()["view"]["permission_mode"] != "Ask for approval" { tokio::time::sleep(std::time::Duration::from_millis(20)).await; }
        }).await.expect("vista publicada com o modo novo");
        cleanup(&registry,&key,dir.path(),&policy).await;
    }

    async fn until_idle(handle:&RuntimeHandle) {
        tokio::time::timeout(std::time::Duration::from_secs(20),async {
            while handle.snapshot().await.unwrap()["view"]["in_progress"] != false { tokio::time::sleep(std::time::Duration::from_millis(20)).await; }
        }).await.expect("turno fechado");
    }

    #[tokio::test]
    async fn sandbox_switch_that_fails_to_start_keeps_the_new_mode_for_the_next_life() {
        let dir = tempfile::tempdir().unwrap();
        let key = unique_key();
        let (registry,policy) = lifecycle_session(dir.path(),&key,"Full Access",std::time::Duration::from_millis(300)).await;
        let handle = registry.handle(&key,1).await.unwrap();
        // Sem o `codex` no PATH a subida falha; ele volta antes da religação automática (300 ms).
        let (codex,hidden) = (dir.path().join("codex"),dir.path().join("codex.off"));
        std::fs::rename(&codex,&hidden).unwrap();
        let failed = handle.command(control("perm-1",OperationKind::SetPermissionMode,json!({"mode":"Ask for approval"}))).await;
        std::fs::rename(&hidden,&codex).unwrap();
        // `codex_ausente` volta quando o 7l expuser `process::resolve_program`.
        assert_eq!(failed.err().unwrap().code,"cano_nao_subiu");
        assert_eq!(sidecar(dir.path())["permission_mode"],"Ask for approval","o modo novo fica gravado para a próxima vida");
        assert!(matches!(process::liveness(recorded(dir.path())[0].pid,&key),process::Liveness::Dead),"o processo antigo já tinha morrido");
        // A religação automática sobe com o modo gravado no arquivo, no comando e no `thread/resume`.
        until("religou depois da falha",||recorded(dir.path()).len() >= 2).await;
        until_ready(&registry,&key).await;
        let resumed:Vec<Value> = calls(dir.path()).into_iter().filter(|call|call["method"] == "thread/resume").collect();
        assert_eq!(resumed.last().unwrap()["params"]["sandbox"],"read-only");
        let view = handle_view(&registry,&key).await;
        assert_eq!(view["permission_mode"],"Ask for approval");
        assert!(view["public_state"]["problema"].is_null(),"a vida nova pronta não carrega o problema da subida que falhou: {}",view["public_state"]);
        cleanup(&registry,&key,dir.path(),&policy).await;
    }

    async fn handle_view(registry:&RuntimeRegistry,key:&str) -> Value {
        registry.handle(key,1).await.unwrap().snapshot().await.unwrap()["view"].clone()
    }

    #[tokio::test]
    async fn process_killed_mid_turn_respawns_and_shows_the_cut_turn() {
        let dir = tempfile::tempdir().unwrap();
        let key = unique_key();
        let (registry,policy) = lifecycle_session(dir.path(),&key,"Full Access",std::time::Duration::from_millis(300)).await;
        let handle = registry.handle(&key,1).await.unwrap();
        handle.command(RuntimeCommand { operation_id:"in-1".into(),kind:OperationKind::Input,payload:json!({"text":"oi"}) }).await.unwrap();
        until("turno aberto",||calls(dir.path()).iter().any(|call|call["method"] == "turn/start")).await;
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        std::fs::write(dir.path().join("cut"),"").unwrap();
        // O app-server morre no meio do turno.
        process::kill(&recorded(dir.path())[0],&key,dir.path()).await.unwrap();
        until("religou sozinho",||recorded(dir.path()).len() >= 2).await;
        until_ready(&registry,&key).await;
        tokio::time::timeout(std::time::Duration::from_secs(20),async {
            while handle_view(&registry,&key).await["public_state"]["problema"] != "codex_turno_cortado" {
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
        }).await.expect("a sessão mostra o turno cortado depois de religar");
        assert_eq!(starts(dir.path()).len(),2,"um processo novo, nunca dois");
        cleanup(&registry,&key,dir.path(),&policy).await;
    }

    #[tokio::test]
    async fn registry_live_follows_open_respawn_and_close() {
        // O canal do hub nasce com a sessão aberta no Rust, passa pela religação e esvazia no `close`.
        let dir = tempfile::tempdir().unwrap();
        let key = unique_key();
        let (registry,policy) = lifecycle_session(dir.path(),&key,"Full Access",std::time::Duration::from_millis(300)).await;
        let rx = registry.live("cx");
        until("estado da sessão aberta no canal",||rx.borrow().as_ref().is_some_and(|s|s.public_state["state"] == "idle")).await;
        process::kill(&recorded(dir.path())[0],&key,dir.path()).await.unwrap();
        until("religou sozinho",||recorded(dir.path()).len() >= 2).await;
        until_ready(&registry,&key).await;
        until("vida nova no mesmo canal",||rx.borrow().as_ref().is_some_and(|s|s.public_state["state"] == "idle" && s.error.is_none())).await;
        cleanup(&registry,&key,dir.path(),&policy).await;
        until("fechar esvazia o canal",||rx.borrow().is_none()).await;
    }

    #[tokio::test]
    async fn close_with_kill_ends_the_process() {
        let dir = tempfile::tempdir().unwrap();
        let key = unique_key();
        let (registry,policy) = lifecycle_session(dir.path(),&key,"Full Access",std::time::Duration::from_secs(5)).await;
        let cano = recorded(dir.path())[0].clone();
        let traces = ||std::fs::read_dir(dir.path()).unwrap().flatten()
            .filter(|entry|entry.file_name().to_string_lossy().starts_with(&format!("cano-{}",&key[..16]))).count();
        assert!(traces() > 0,"o cano vivo tem socket e log na pasta");
        let closed = registry.close_with_kill(&key,1).await.unwrap();
        assert_eq!(closed,json!({"closed":true,"killed":true}));
        assert!(matches!(process::liveness(cano.pid,&key),process::Liveness::Dead));
        assert_eq!(traces(),0,"socket e log do cano apagados");
        assert!(registry.handle(&key,1).await.is_err(),"a sessão saiu do Rust");
    }
}

// --- Codex com terminal: resposta assíncrona reservada, da fila ao recibo (Task 9) ---

mod terminal_async {
    use super::*;
    use hangar_server::interactions::{InteractionBinding,InteractionKind,InteractionStore,native_target};
    use hangar_server::runtime::codex::Engine;
    use std::sync::{Arc,Mutex};

    const QUESTION:&str = "async:thread-1:q1:0";
    const ANSWER:&str = "> Qual pasta?\n\nA";

    fn async_turns() -> Value {
        json!([{"id":"t0","status":"completed","items":[{"id":"q1","type":"agentMessage","delivery":"async",
            "questions":[{"title":"Qual pasta?","options":["A","B"]}]}]}])
    }

    /// Cano do Codex com terminal: a assinatura traz a pergunta assíncrona `q1`; cada `turn/start` é
    /// aceito e a mensagem dele vai ao rollout, como o Codex grava. Devolve os textos de `turn/start`.
    async fn terminal_cano(rollout:std::path::PathBuf) -> (std::net::SocketAddr,tokio::task::JoinHandle<()>,tokio::sync::mpsc::UnboundedSender<Value>,Arc<Mutex<Vec<String>>>) {
        terminal_cano_with(rollout,async_turns()).await
    }

    /// `turns`: o que a assinatura (`thread/resume`) traz; vazio = sem pergunta, entrada comum livre.
    async fn terminal_cano_with(rollout:std::path::PathBuf,turns:Value) -> (std::net::SocketAddr,tokio::task::JoinHandle<()>,tokio::sync::mpsc::UnboundedSender<Value>,Arc<Mutex<Vec<String>>>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (push,mut pushed) = tokio::sync::mpsc::unbounded_channel::<Value>();
        let starts = Arc::new(Mutex::new(Vec::new()));
        let seen = starts.clone();
        let server = tokio::spawn(async move {
            let (stream,_) = listener.accept().await.unwrap();
            let (read,mut write) = stream.into_split();
            let mut reader = BufReader::new(read);
            let mut header = String::new(); reader.read_line(&mut header).await.unwrap();
            let snapshot = json!({"type":"cano_snapshot","versao":2,"pid":42,"init":null,"aberto":false,
                "pendentes":[],"ultimo_result":null,"rate_limit":null,"stderr_tail":[],"saiu":null,"inflight":{}});
            write.write_all(format!("{snapshot}\n").as_bytes()).await.unwrap();
            loop {
                let mut raw = String::new();
                tokio::select! {
                    line = pushed.recv() => {
                        let Some(line) = line else { continue };
                        let frame = json!({"type":"cano_output","frame":line.to_string()});
                        if write.write_all(format!("{frame}\n").as_bytes()).await.is_err() { break; }
                    }
                    n = reader.read_line(&mut raw) => {
                        if n.unwrap_or(0) == 0 { break; }
                        let envelope:Value = serde_json::from_str(&raw).unwrap();
                        let frame:Value = serde_json::from_str(envelope["frame"].as_str().unwrap()).unwrap();
                        let ack = json!({"type":"cano_input_ack","operation_id":envelope["operation_id"],"outcome":"written"});
                        write.write_all(format!("{ack}\n").as_bytes()).await.unwrap();
                        if frame.get("id").is_none() || frame.get("method").is_none() { continue; }
                        let result = match frame["method"].as_str().unwrap_or("") {
                            "thread/resume" => json!({"thread":{"id":"thread-1","path":rollout,"status":{"type":"idle"},"turns":turns.clone()}}),
                            "turn/start" => {
                                let text = frame["params"]["input"][0]["text"].as_str().unwrap_or("").to_owned();
                                use std::io::Write;
                                let mut file = std::fs::OpenOptions::new().append(true).open(&rollout).unwrap();
                                writeln!(file,"{}",json!({"type":"response_item","payload":{"type":"message","role":"user",
                                    "content":[{"type":"input_text","text":text}]}})).unwrap();
                                let count = { let mut starts = seen.lock().unwrap(); starts.push(text); starts.len() };
                                json!({"turn":{"id":format!("turn-{count}"),"status":"inProgress"}})
                            }
                            _ => json!({}),
                        };
                        let reply = json!({"type":"cano_output","frame":json!({"id":frame["id"],"result":result}).to_string()});
                        write.write_all(format!("{reply}\n").as_bytes()).await.unwrap();
                    }
                }
            }
        });
        (address,server,push,starts)
    }

    /// Ator do Codex com terminal sobre a fila da pasta (que pode já ter estado de uma vida anterior).
    async fn terminal_actor(dir:&std::path::Path,cano:std::net::SocketAddr,store:Arc<InteractionStore>) -> RuntimeHandle {
        let target = RuntimeTarget { key:"key".into(),generation:1,name:"session".into(),provider:"codex".into(),
            metadata:json!({"name":"session","headless":false,"thread_id":"thread-1","cwd":"/work","initialized":true}),
            binding:CanoBinding { pid:42,escuta:format!("tcp:{cano}"),token:"secret-test".into(),versao:2 },
            lease_path:dir.join("key.lock"),state_path:dir.join("key.queue-state.json"),projection_dir:dir.join("projection"),
            transcript:dir.join("chat.jsonl"),created:0.0 };
        let lease = acquire_lease(&target.lease_path).unwrap();
        let queue = QueueActor::start(Store::open(&target.state_path,&target.projection_dir,State::new("key",1,"session",vec![])).unwrap(),lease);
        let connection = cano::connect(&target.binding).await.unwrap();
        let engine = RuntimeEngine::new("codex",target.metadata.clone(),1,ClockSample { monotonic_s:0.0,epoch_s:1_800_000_000.0 }).unwrap()
            .with_interactions("key".into(),store).unwrap();
        RuntimeActor::spawn(target,queue,connection,engine)
    }


    async fn until(what:&str,check:impl Fn() -> bool) {
        tokio::time::timeout(std::time::Duration::from_secs(5),async { while !check() { tokio::time::sleep(std::time::Duration::from_millis(20)).await; } })
            .await.unwrap_or_else(|_|panic!("{what}"));
    }

    async fn view_until(handle:&RuntimeHandle,what:&str,check:impl Fn(&Value) -> bool) -> Value {
        tokio::time::timeout(std::time::Duration::from_secs(5),async {
            loop {
                let view = handle.view().await.unwrap();
                if check(&view) { return view; }
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
        }).await.unwrap_or_else(|_|panic!("{what}"))
    }

    fn question_open(view:&Value) -> bool { view["async_questions"].as_array().is_some_and(|q|q.iter().any(|pair|pair[0] == QUESTION)) }

    /// Responde a pergunta pela identidade exibida no retrato que o próprio ator publica.
    async fn answer(handle:&RuntimeHandle,store:&InteractionStore) -> RuntimeReply {
        let view = view_until(handle,"assinada com a pergunta assíncrona",|v|v["subscribed"] == true && question_open(v)).await;
        let question = view["async_questions"].as_array().unwrap().iter().find(|pair|pair[0] == QUESTION).unwrap()[1].clone();
        let binding = InteractionBinding { key:"key".into(),conversation:"thread-1".into(),generation:1 };
        let token = store.observe(&binding,&native_target(InteractionKind::Question,"thread-1",&json!(QUESTION)),Some(question)).unwrap().unwrap();
        handle.command(RuntimeCommand { operation_id:"answer".into(),kind:OperationKind::AnswerQuestions,
            payload:json!({"request_id":QUESTION,"interaction_id":token,"answers":[{"question_id":"answer","kind":"option","indices":[0]}]}) }).await.unwrap()
    }

    fn accepted(dir:&std::path::Path,id:&str) -> bool {
        queue_state(dir).operations.get(id).is_some_and(|op|matches!(op.status,Status::Accepted | Status::Confirmed))
    }

    #[tokio::test]
    async fn reserved_answer_goes_alone_before_an_earlier_ordinary_input_and_is_confirmed() {
        let dir = tempfile::tempdir().unwrap();
        let rollout = dir.path().join("chat.jsonl");
        std::fs::write(&rollout,"").unwrap();
        let (cano,server,push,starts) = terminal_cano(rollout).await;
        let store = Arc::new(InteractionStore::default());
        let handle = terminal_actor(dir.path(),cano,store.clone()).await;
        view_until(&handle,"assinada",|v|v["subscribed"] == true && question_open(v)).await;
        // A pergunta assíncrona não segura a mensagem comum: ela sai na hora, como no Python.
        handle.queue("ordinary".into(),Action::Append { text:"segue".into(),delivered:false,ts:None,pre_transcript:false,entry_id:Some("ordinary".into()) }).await.unwrap();
        until("a mensagem comum não espera a pergunta",||accepted(dir.path(),"ordinary")).await;
        // Com o turno dela rodando, a resposta é reservada; gravada, a pessoa recebe "aceito" e o cartão fecha.
        let reply = answer(&handle,&store).await;
        assert!(reply.disposition == Disposition::Accepted,"reserva gravada é resposta aceita");
        assert_eq!(reply.payload["reserved"],true);
        assert_eq!(reply.payload["decision_confirmed"],false);
        let entry = reply.payload["entry_id"].as_str().unwrap().to_owned();
        let state = queue_state(dir.path());
        assert_eq!(state.operations[&entry].entry_id.as_deref(),Some(entry.as_str()),"entrada e operação gravadas juntas");
        assert!(handle.view().await.unwrap()["public_state"]["codex_question"].is_null(),"o cartão respondido fecha");
        assert!(!accepted(dir.path(),&entry),"reservada espera o fim do turno");
        // Fim do turno: a reservada sai, uma vez.
        push.send(json!({"method":"turn/completed","params":{"threadId":"thread-1","turn":{"id":"turn-1","status":"completed"}}})).unwrap();
        until("turno da resposta reservada aceito",||accepted(dir.path(),&entry)).await;
        assert_eq!(*starts.lock().unwrap(),vec!["segue".to_owned(),ANSWER.to_owned()]);
        view_until(&handle,"a pergunta respondida sai das pendências",|v|!question_open(v)).await;
        // O recibo no rollout confirma a entrada reservada pela operação dela.
        handle.confirm().await.unwrap();
        until("reservada confirmada pelo recibo",||queue_state(dir.path()).rows.iter().any(|row|row["id"] == entry.as_str() && row["confirmed"] == true)).await;
        handle.stop().await.unwrap();
        drop(push);
        server.abort();
    }

    /// Vida anterior parou depois de reivindicar a entrada reservada e antes de prepará-la; com
    /// `refused`, uma tentativa anterior foi recusada sem escrita e a operação voltou a `prepared`.
    fn claimed_before_prepare(dir:&std::path::Path,refused:bool) -> String {
        let reservation = ReservedAsyncAnswer { request_id:QUESTION.into(),interaction_id:"old-life".into(),
            entry_id:"async-answer:1:7".into(),operation_id:"async-answer:1:7".into(),text:ANSWER.into() };
        let entry = reservation.entry_id.clone();
        let payload = serde_json::to_value(Engine::async_answer_command(&reservation,"thread-1",1)).unwrap();
        let clock = ClockSample { monotonic_s:0.0,epoch_s:1_800_000_000.0 };
        let mut store = Store::open(&dir.join("key.queue-state.json"),&dir.join("projection"),State::new("key",1,"session",vec![])).unwrap();
        store.exec(1,"reserve",clock,Action::ReserveAsyncAnswer { entry_id:entry.clone(),text:ANSWER.into(),payload:payload.clone() }).unwrap();
        if refused {
            let wire = format!("wire:{entry}:3");
            for (call,action) in [
                ("claim-0",Action::Claim { min_ts:0.0,limit:Some(1),entry_id:Some(entry.clone()) }),
                ("prepare-0",Action::Prepare { id:entry.clone(),payload:payload.clone(),entry_id:Some(entry.clone()) }),
                ("wire",Action::Prepare { id:wire.clone(),payload:json!({"logical_id":entry,"frame":{"id":"hangar:1:3","method":"turn/start"},"generation":1}),entry_id:None }),
                ("wire-dispatch",Action::BeginDispatch { id:wire.clone(),wire_id:wire.clone(),staged:false }),
                ("dispatch",Action::BeginDispatch { id:entry.clone(),wire_id:wire.clone(),staged:false }),
                ("refused",Action::Finish { id:wire.clone(),status:Status::Rejected,result:json!({"write_outcome":"not_written"}) }),
                ("deferred",Action::Finish { id:entry.clone(),status:Status::Deferred,result:json!({"operation_id":entry,"disposition":"deferred","payload":{"write_outcome":"not_written"}}) }),
                ("unclaim",Action::SetDelivered { entry_id:entry.clone(),value:false,steered:false }),
            ] { store.exec(1,call,clock,action).unwrap(); }
        }
        store.exec(1,"claim",clock,Action::Claim { min_ts:0.0,limit:Some(1),entry_id:Some(entry.clone()) }).unwrap();
        if refused {
            store.exec(1,"prepare-1",clock,Action::Prepare { id:entry.clone(),payload,entry_id:Some(entry.clone()) }).unwrap();
            assert!(!store.state().operations[&entry].wire_attempts.is_empty(),"a tentativa recusada continua registrada");
        }
        entry
    }

    async fn resumes_once(refused:bool) {
        let dir = tempfile::tempdir().unwrap();
        let rollout = dir.path().join("chat.jsonl");
        std::fs::write(&rollout,"").unwrap();
        let entry = claimed_before_prepare(dir.path(),refused);
        assert_eq!(queue_state(dir.path()).rows.iter().find(|row|row["id"] == entry.as_str()).unwrap()["delivered"],true);
        let (cano,server,push,starts) = terminal_cano(rollout).await;
        let handle = terminal_actor(dir.path(),cano,Arc::new(InteractionStore::default())).await;
        until("a mesma entrada sai na vida nova",||accepted(dir.path(),&entry)).await;
        view_until(&handle,"a pergunta respondida sai das pendências",|v|v["subscribed"] == true && !question_open(v)).await;
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        assert_eq!(*starts.lock().unwrap(),vec![ANSWER.to_owned()],"exatamente uma vez");
        handle.stop().await.unwrap();
        drop(push);
        server.abort();
    }

    #[tokio::test]
    async fn restart_between_claim_and_prepare_sends_the_same_entry_exactly_once() { resumes_once(false).await; }

    #[tokio::test]
    async fn reservation_from_another_generation_is_uncertain_and_never_sent() {
        let dir = tempfile::tempdir().unwrap();
        let rollout = dir.path().join("chat.jsonl");
        std::fs::write(&rollout,"").unwrap();
        // Gravada por uma vida de outra geração: nada prova que ela não saiu.
        let reservation = ReservedAsyncAnswer { request_id:QUESTION.into(),interaction_id:"old-life".into(),
            entry_id:"async-answer:2:1".into(),operation_id:"async-answer:2:1".into(),text:ANSWER.into() };
        let payload = serde_json::to_value(Engine::async_answer_command(&reservation,"thread-1",2)).unwrap();
        let clock = ClockSample { monotonic_s:0.0,epoch_s:1_800_000_000.0 };
        {
            let mut store = Store::open(&dir.path().join("key.queue-state.json"),&dir.path().join("projection"),State::new("key",1,"session",vec![])).unwrap();
            store.exec(1,"reserve",clock,Action::ReserveAsyncAnswer { entry_id:reservation.entry_id.clone(),text:ANSWER.into(),payload }).unwrap();
        }
        let (cano,server,push,starts) = terminal_cano(rollout).await;
        let handle = terminal_actor(dir.path(),cano,Arc::new(InteractionStore::default())).await;
        view_until(&handle,"assinada com a pergunta",|v|v["subscribed"] == true && question_open(v)).await;
        assert_eq!(handle.drain().await.unwrap()["sent"],0,"incerta não é apta: nada a sair");
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        assert!(starts.lock().unwrap().is_empty(),"reserva de outra geração nunca sai");
        assert!(question_open(&handle.view().await.unwrap()),"a pergunta segue aberta para a TUI");
        handle.stop().await.unwrap();
        drop(push);
        server.abort();
    }

    #[tokio::test]
    async fn an_attempt_refused_without_writing_does_not_make_the_reservation_uncertain() { resumes_once(true).await; }

    #[cfg(unix)]
    #[tokio::test]
    async fn reservation_persisted_despite_a_queue_error_answers_reserved_and_goes_out_once() {
        use std::os::unix::fs::PermissionsExt;
        if std::fs::metadata("/proc/self").map(|m|std::os::unix::fs::MetadataExt::uid(&m)==0).unwrap_or(false) {
            return;     // como root o chmod não recusa nada
        }
        let dir = tempfile::tempdir().unwrap();
        let rollout = dir.path().join("chat.jsonl");
        std::fs::write(&rollout,"").unwrap();
        let (cano,server,push,starts) = terminal_cano(rollout).await;
        let store = Arc::new(InteractionStore::default());
        let handle = terminal_actor(dir.path(),cano,store.clone()).await;
        view_until(&handle,"assinada",|v|v["subscribed"] == true && question_open(v)).await;
        // O estado grava, a projeção (pasta travada) não: a fila responde erro com a reserva já no disco.
        let projection = dir.path().join("projection");
        std::fs::set_permissions(&projection,std::fs::Permissions::from_mode(0o500)).unwrap();
        let reply = answer(&handle,&store).await;
        std::fs::set_permissions(&projection,std::fs::Permissions::from_mode(0o700)).unwrap();
        // Gravada, mas a fila respondeu erro: nem sucesso nem erro de envio, o incerto que manda conferir.
        assert!(reply.disposition == Disposition::Unknown,"erro da fila não vira resposta aceita: {reply:?}");
        assert_eq!(reply.payload["reserved"],true);
        let entry = reply.payload["entry_id"].as_str().unwrap().to_owned();
        assert!(queue_state(dir.path()).operations.contains_key(&entry));
        // Acorda a fila de novo (a reivindicação pode ter falhado com a pasta travada).
        push.send(json!({"method":"turn/completed","params":{"threadId":"thread-1","turn":{"id":"","status":"completed"}}})).unwrap();
        until("a reserva gravada sai",||accepted(dir.path(),&entry)).await;
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        assert_eq!(*starts.lock().unwrap(),vec![ANSWER.to_owned()],"exatamente uma vez");
        handle.stop().await.unwrap();
        drop(push);
        server.abort();
    }

    #[tokio::test]
    async fn steer_with_text_and_no_turn_is_refused_and_leaves_no_queue_row() {
        // `/steer` com texto vai direto ao `turn/steer` (Python): sem turno é recusa, nunca linha presa na fila.
        let dir = tempfile::tempdir().unwrap();
        let (handle,server,push,starts) = quiet_actor(dir.path()).await;
        let refused = handle.command(RuntimeCommand { operation_id:"steer".into(),kind:OperationKind::Steer,payload:json!({"text":"mais curto","turn_id":null}) }).await;
        assert!(refused.as_ref().is_err() || refused.as_ref().is_ok_and(|r|r.disposition == Disposition::Rejected),"{refused:?}");
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        assert!(queue_state(dir.path()).rows.is_empty(),"a orientação não vira linha na fila: {:?}",queue_state(dir.path()).rows);
        // A fila segue livre: a próxima mensagem sai.
        handle.queue("ordinary".into(),ordinary()).await.unwrap();
        until("a fila não ficou travada",||accepted(dir.path(),"ordinary")).await;
        assert_eq!(*starts.lock().unwrap(),vec!["segue".to_owned()]);
        handle.stop().await.unwrap();
        drop(push);
        server.abort();
    }

    #[tokio::test]
    async fn steering_the_queue_leaves_the_reserved_answer_to_its_own_dispatch() {
        let dir = tempfile::tempdir().unwrap();
        let rollout = dir.path().join("chat.jsonl");
        std::fs::write(&rollout,"").unwrap();
        let (cano,server,push,starts) = terminal_cano(rollout).await;
        let store = Arc::new(InteractionStore::default());
        let handle = terminal_actor(dir.path(),cano,store.clone()).await;
        view_until(&handle,"assinada",|v|v["subscribed"] == true && question_open(v)).await;
        handle.queue("ordinary".into(),ordinary()).await.unwrap();
        until("turno da mensagem comum",||accepted(dir.path(),"ordinary")).await;
        let entry = answer(&handle,&store).await.payload["entry_id"].as_str().unwrap().to_owned();
        handle.queue("later".into(),Action::Append { text:"depois".into(),delivered:false,ts:None,pre_transcript:false,entry_id:Some("later".into()) }).await.unwrap();
        let steered = handle.command(RuntimeCommand { operation_id:"steer-queue".into(),kind:OperationKind::SteerQueue,payload:json!({"entry_id":null}) }).await.unwrap();
        assert_eq!(steered.payload["ids"],json!(["later"]),"só a mensagem comum orienta");
        assert_eq!(queue_state(dir.path()).rows.iter().find(|row|row["id"] == entry.as_str()).unwrap()["delivered"],false,"a reservada espera a vez dela");
        push.send(json!({"method":"turn/completed","params":{"threadId":"thread-1","turn":{"id":"turn-1","status":"completed"}}})).unwrap();
        until("a reservada sai pelo despacho dela",||accepted(dir.path(),&entry)).await;
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        assert_eq!(starts.lock().unwrap().iter().filter(|text|*text == ANSWER).count(),1,"a resposta sai uma vez");
        handle.stop().await.unwrap();
        drop(push);
        server.abort();
    }

    // --- Retenção de turnos durante o seletor `/permissions` da TUI ---
    // Relógio real como no resto do módulo: o ator mede prazos com `std::time::Instant` e fala por TCP,
    // então o relógio pausado do tokio não governa o que importa aqui.

    /// Ator do Codex com terminal sem pergunta pendente, assinado e livre para abrir turno.
    async fn quiet_actor(dir:&std::path::Path) -> (RuntimeHandle,tokio::task::JoinHandle<()>,tokio::sync::mpsc::UnboundedSender<Value>,Arc<Mutex<Vec<String>>>) {
        subscribed_actor(dir,true).await
    }

    /// `idle`: espera também a sessão entregável. Com entrada na fila, ela sai logo e a espera não vale.
    async fn subscribed_actor(dir:&std::path::Path,idle:bool) -> (RuntimeHandle,tokio::task::JoinHandle<()>,tokio::sync::mpsc::UnboundedSender<Value>,Arc<Mutex<Vec<String>>>) {
        let rollout = dir.join("chat.jsonl");
        if !rollout.exists() { std::fs::write(&rollout,"").unwrap(); }
        let (cano,server,push,starts) = terminal_cano_with(rollout,json!([])).await;
        let handle = terminal_actor(dir,cano,Arc::new(InteractionStore::default())).await;
        view_until(&handle,"assinada e livre para turno",|v|v["subscribed"] == true && (!idle || v["deliverable"] == true)).await;
        (handle,server,push,starts)
    }

    fn ordinary() -> Action {
        Action::Append { text:"segue".into(),delivered:false,ts:None,pre_transcript:false,entry_id:Some("ordinary".into()) }
    }

    #[tokio::test]
    async fn queued_input_waits_for_the_selector_hold_and_goes_out_once() {
        let dir = tempfile::tempdir().unwrap();
        let (handle,server,push,starts) = quiet_actor(dir.path()).await;
        let hold = handle.hold_turns().await.expect("sessão ociosa aceita a retenção");
        handle.queue("ordinary".into(),ordinary()).await.unwrap();
        let direct = handle.command(RuntimeCommand { operation_id:"direct".into(),kind:OperationKind::Input,payload:json!({"text":"direta"}) }).await.unwrap();
        assert!(direct.disposition == Disposition::Deferred,"entrada direta adia durante o seletor");
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        assert!(starts.lock().unwrap().is_empty(),"nenhum turn/start durante o seletor");
        assert!(!accepted(dir.path(),"ordinary"));
        drop(hold);
        until("a entrada da fila sai quando o seletor termina",||accepted(dir.path(),"ordinary")).await;
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        let sent = starts.lock().unwrap().clone();
        assert_eq!(sent.first().map(String::as_str),Some("segue"),"a da fila sai primeiro: {sent:?}");
        assert_eq!(sent.iter().filter(|text|*text == "segue").count(),1,"exatamente uma vez: {sent:?}");
        handle.stop().await.unwrap();
        drop(push);
        server.abort();
    }

    #[tokio::test]
    async fn a_failed_selector_releases_the_hold() {
        let dir = tempfile::tempdir().unwrap();
        let (handle,server,push,starts) = quiet_actor(dir.path()).await;
        let selector = async {
            let _turns = handle.hold_turns().await?;
            handle.queue("ordinary".into(),ordinary()).await?;
            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
            assert!(starts.lock().unwrap().is_empty(),"nada sai com o seletor aberto");
            Err::<(),_>(RuntimeError::new("permission_picker_not_opened","o seletor não abriu"))
        }.await;
        assert_eq!(selector.unwrap_err().code,"permission_picker_not_opened");
        until("a entrada sai depois do erro do seletor",||accepted(dir.path(),"ordinary")).await;
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        assert_eq!(*starts.lock().unwrap(),vec!["segue".to_owned()],"exatamente uma vez");
        handle.stop().await.unwrap();
        drop(push);
        server.abort();
    }

    fn turn_started() -> Value { json!({"method":"turn/started","params":{"threadId":"thread-1","turn":{"id":"turn-tui"}}}) }

    #[tokio::test]
    async fn a_turn_in_progress_refuses_the_hold() {
        let dir = tempfile::tempdir().unwrap();
        let (handle,server,push,_starts) = quiet_actor(dir.path()).await;
        push.send(turn_started()).unwrap();
        view_until(&handle,"turno em andamento",|v|v["deliverable"] == false).await;
        let refused = handle.hold_turns().await.err().expect("turno em voo recusa o seletor");
        assert_eq!(refused.code,TURN_HOLD_BUSY);
        handle.stop().await.unwrap();
        drop(push);
        server.abort();
    }

    #[tokio::test]
    async fn a_second_selector_is_refused_when_the_tui_opened_a_turn_meanwhile() {
        let dir = tempfile::tempdir().unwrap();
        let (handle,server,push,_starts) = quiet_actor(dir.path()).await;
        let first = handle.hold_turns().await.expect("ociosa aceita o primeiro seletor");
        // Turno aberto pela própria TUI durante o primeiro seletor: a retenção viva não dispensa a checagem.
        push.send(turn_started()).unwrap();
        view_until(&handle,"turno da TUI em andamento",|v|v["deliverable"] == false).await;
        let refused = handle.hold_turns().await.err().expect("segundo seletor com turno em voo recusa");
        assert_eq!(refused.code,TURN_HOLD_BUSY);
        drop(first);
        handle.stop().await.unwrap();
        drop(push);
        server.abort();
    }

    #[tokio::test]
    async fn compact_is_refused_under_the_hold() {
        let dir = tempfile::tempdir().unwrap();
        let (handle,server,push,_starts) = quiet_actor(dir.path()).await;
        let hold = handle.hold_turns().await.unwrap();
        let refused = handle.command(RuntimeCommand { operation_id:"compact".into(),kind:OperationKind::Compact,payload:json!({}) }).await
            .err().expect("compactar recusa com o seletor aberto");
        assert_eq!(refused.code,TURN_HOLD_BUSY);
        drop(hold);
        handle.stop().await.unwrap();
        drop(push);
        server.abort();
    }

    #[tokio::test]
    async fn a_new_actor_life_does_not_inherit_the_hold() {
        let dir = tempfile::tempdir().unwrap();
        let (first,server,push,starts) = quiet_actor(dir.path()).await;
        let hold = first.hold_turns().await.unwrap();
        first.queue("ordinary".into(),ordinary()).await.unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        assert!(starts.lock().unwrap().is_empty());
        first.stop().await.unwrap();
        drop(push);
        server.abort();
        // A retenção da vida anterior continua viva em quem a pegou e não segura a vida nova.
        let (second,server,push,starts) = subscribed_actor(dir.path(),false).await;
        until("a vida nova leva a entrada",||accepted(dir.path(),"ordinary")).await;
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        assert_eq!(*starts.lock().unwrap(),vec!["segue".to_owned()],"exatamente uma vez");
        drop(hold);
        second.stop().await.unwrap();
        drop(push);
        server.abort();
    }
}
