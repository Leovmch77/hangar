use hangar_server::runtime::{codex::Engine,protocol::*};
use serde_json::{Value,json};

fn clock(seconds:f64) -> ClockSample { ClockSample { monotonic_s:seconds,epoch_s:1_800_000_000.0 + seconds } }
fn engine() -> Engine { Engine::new(json!({"name":"session","thread_id":"thread-1","headless":true,"model":"gpt-6","initialized":true,"ready":true}),1,clock(10.0)) }
fn frames(effects:&[Effect]) -> Vec<Value> { effects.iter().filter_map(|e|match e { Effect::Write { frame,.. }=>Some(frame.clone()),_=>None }).collect() }
fn command(kind:OperationKind,payload:Value) -> RuntimeCommand { RuntimeCommand { operation_id:"op-1".into(),kind,payload } }
fn line(engine:&mut Engine,value:Value,time:f64) -> Vec<Effect> { engine.apply(EngineInput::Line(value),clock(time)).unwrap() }

use hangar_server::interactions::{InteractionBinding,InteractionKind,InteractionStore,native_target};
use std::sync::Arc;

/// Store de identidades da própria fixture, ligado à conversa do motor.
fn identified(engine:&mut Engine) -> Arc<InteractionStore> {
    let store = Arc::new(InteractionStore::default());
    engine.set_interactions("key".into(),store.clone()).unwrap();
    store
}
fn shown_binding(engine:&Engine) -> InteractionBinding {
    InteractionBinding { key:"key".into(),conversation:engine.control_view()["thread_id"].as_str().unwrap().into(),generation:1 }
}
/// Identidade exibida de um pedido do servidor, a partir do retrato que o próprio motor publica:
/// alvo na thread do PEDIDO (subagente incluído), vínculo na conversa principal.
fn request_token(engine:&Engine,store:&InteractionStore,kind:InteractionKind,id:Value) -> String {
    let view = engine.control_view();
    let request = view["pending"].as_array().unwrap().iter().find(|pending|pending["request_id"] == id).unwrap()["request"].clone();
    let native:RequestId = serde_json::from_value(id.clone()).unwrap();
    let target = native_target(kind,request["params"]["threadId"].as_str().unwrap(),&id);
    store.observe_revision(&shown_binding(engine),&target,Some(request),engine.request_revision(&native)).unwrap().unwrap()
}
fn async_token(engine:&Engine,store:&InteractionStore,id:&str) -> String {
    let view = engine.control_view();
    let question = view["async_questions"].as_array().unwrap().iter().find(|pair|pair[0] == id).unwrap()[1].clone();
    let target = native_target(InteractionKind::Question,view["thread_id"].as_str().unwrap(),&json!(id));
    store.observe(&shown_binding(engine),&target,Some(question)).unwrap().unwrap()
}
fn select(engine:&mut Engine,store:&InteractionStore,id:Value,option:u64,time:f64) -> Result<Vec<Effect>,RuntimeError> {
    let token = request_token(engine,store,InteractionKind::Approval,id);
    engine.command(command(OperationKind::Select,json!({"option":option,"interaction_id":token})),clock(time))
}
fn answer_form(engine:&mut Engine,store:&InteractionStore,id:i64,answers:Value,time:f64) -> Result<Vec<Effect>,RuntimeError> {
    let token = request_token(engine,store,InteractionKind::Question,json!(id));
    engine.command(command(OperationKind::AnswerQuestions,json!({"request_id":id,"interaction_id":token,"answers":answers})),clock(time))
}

#[test]
fn initialize_then_resume() {
    let mut engine = Engine::new(json!({"name":"session","thread_id":"thread-1","headless":true}),1,clock(10.0));
    let effects = engine.bootstrap(true,"boot".into()).unwrap();
    let initialize = frames(&effects)[0].clone();
    assert_eq!(initialize["method"],"initialize");
    let effects = line(&mut engine,json!({"id":initialize["id"],"result":{}}),11.0);
    let requests = frames(&effects);
    assert_eq!(requests[0]["method"],"initialized");
    assert_eq!(requests[1]["method"],"thread/resume");
    assert_eq!(requests[1]["params"]["threadId"],"thread-1");
}

#[test]
fn takeover_restores_async_question_before_ready() {
    let question = json!({"provider":"codex", "request_id":"async:thread-1:item:0", "is_async":true,
        "questions":[{"id":"answer", "question":"Qual opção?", "options":[]}]});
    let engine = Engine::new(json!({"name":"session", "thread_id":"thread-1", "initialized":true, "ready":true,
        "async_questions":[["async:thread-1:item:0",question]], "async_seen":["item"]}),1,clock(10.0));
    assert_eq!(engine.view()["state"], "awaiting_input");
    assert_eq!(engine.view()["codex_question"]["request_id"], "async:thread-1:item:0");
    assert_eq!(engine.control_view()["deliverable"], false);
}

#[test]
fn reply_ids_and_generations() {
    let mut engine = engine();
    let effects = engine.command(command(OperationKind::ListModels,json!({})),clock(10.0)).unwrap();
    let id = frames(&effects)[0]["id"].clone();
    assert!(id.as_str().unwrap().starts_with("hangar:1:"));
    let old = line(&mut engine,json!({"id":"hangar:0:1","result":{"data":[]}}),11.0);
    assert!(!old.iter().any(|e|matches!(e,Effect::Reply { .. })));
    let current = line(&mut engine,json!({"id":id,"result":{"data":[]}}),12.0);
    assert!(current.iter().any(|e|matches!(e,Effect::Reply { disposition:Disposition::Accepted,.. })));
}

#[test]
fn rpc_timeout_keeps_pending() {
    let mut engine = engine();
    let effects = engine.command(command(OperationKind::Input,json!({"text":"Olá"})),clock(10.0)).unwrap();
    let id = frames(&effects)[0]["id"].clone();
    let timeout = engine.apply(EngineInput::Tick,clock(40.0)).unwrap();
    assert!(timeout.iter().any(|e|matches!(e,Effect::Reply { disposition:Disposition::Unknown,.. })));
    let reply = line(&mut engine,json!({"id":id,"result":{"turn":{"id":"turn-1"}}}),41.0);
    assert!(reply.iter().any(|e|matches!(e,Effect::Reply { disposition:Disposition::Accepted,.. })));
    assert!(frames(&reply).is_empty());
}

#[test]
fn server_request_once() {
    let mut engine = engine();
    let store = identified(&mut engine);
    let request = json!({"id":1,"method":"item/commandExecution/requestApproval","params":{"threadId":"thread-1","command":"pwd"}});
    line(&mut engine,request.clone(),10.0);
    let response = select(&mut engine,&store,json!(1),1,10.0).unwrap();
    assert_eq!(frames(&response)[0]["id"],1);
    assert!(select(&mut engine,&store,json!(1),1,10.0).is_err());
    let effects = line(&mut engine,json!({"id":"unknown","method":"future/request","params":{"threadId":"thread-1"}}),11.0);
    assert_eq!(frames(&effects)[0]["error"]["code"],-32601);
}

#[test]
fn turn_end_idle_before_drain() {
    let mut engine = engine();
    line(&mut engine,json!({"method":"turn/started","params":{"threadId":"thread-1","turn":{"id":"turn-1"}}}),10.0);
    let effects = line(&mut engine,json!({"method":"turn/completed","params":{"threadId":"thread-1","turn":{"id":"turn-1","status":"completed"}}}),11.0);
    assert_eq!(engine.view()["state"],"idle");
    let state = effects.iter().position(|e|matches!(e,Effect::StateChanged)).unwrap();
    let drain = effects.iter().position(|e|matches!(e,Effect::WakeQueue)).unwrap();
    assert!(state < drain);
}

#[test]
fn first_response_times_only_the_first_nonempty_delta_of_the_current_turn() {
    let mut engine = engine();
    line(&mut engine,json!({"method":"turn/started","params":{"threadId":"thread-1","turn":{"id":"turn-1"}}}),10.0);
    for (thread,turn,text) in [("other","turn-1","text"),("thread-1","old","text"),("thread-1","turn-1","")] {
        let effects = line(&mut engine,json!({"method":"item/agentMessage/delta",
            "params":{"threadId":thread,"turnId":turn,"delta":text}}),11.0);
        assert!(!effects.iter().any(|effect|matches!(effect,Effect::Publish { channel,.. } if channel == "rate")));
    }
    let effects = line(&mut engine,json!({"method":"item/agentMessage/delta",
        "params":{"threadId":"thread-1","turnId":"turn-1","delta":"text"}}),12.0);
    assert!(effects.iter().any(|effect|matches!(effect,Effect::Publish { channel,data }
        if channel == "rate" && data == &json!({"first_response":true,"seconds":2.0,"conversation":"thread-1"}))));
    let effects = line(&mut engine,json!({"method":"item/agentMessage/delta",
        "params":{"threadId":"thread-1","turnId":"turn-1","delta":"more"}}),13.0);
    assert!(!effects.iter().any(|effect|matches!(effect,Effect::Publish { channel,.. } if channel == "rate")));
}

#[test]
fn thread_switch_clears_old_preview_and_foreign_deltas_are_ignored() {
    let mut engine = engine();
    let effects = line(&mut engine,json!({"method":"item/agentMessage/delta","params":{"threadId":"other","delta":"filho"}}),10.0);
    assert!(!effects.iter().any(|e|matches!(e,Effect::Publish { .. })));
}

#[test]
fn sandbox_requires_idle() {
    let mut engine = engine();
    line(&mut engine,json!({"method":"turn/started","params":{"threadId":"thread-1","turn":{"id":"turn-1"}}}),10.0);
    assert!(engine.command(command(OperationKind::SetPermissionMode,json!({"mode":"Ask for approval"})),clock(10.0)).is_err());
}

#[test]
fn terminal_without_identified_thread_refuses_bootstrap() {
    let mut engine = Engine::new(json!({"name":"session","headless":false}),1,clock(10.0));
    assert!(engine.bootstrap(true,"boot".into()).is_err());
}

fn terminal() -> Engine { Engine::new(json!({"name":"session","thread_id":"thread-1","headless":false,"cwd":"/work",
    "permission_mode":"Ask for approval"}),1,clock(10.0)) }

/// Conecta o motor terminal e devolve os efeitos da resposta do `initialize` (onde sai a assinatura).
fn connect(engine:&mut Engine) -> Vec<Effect> {
    let effects = engine.bootstrap(true,"boot".into()).unwrap();
    let initialize = frames(&effects)[0].clone();
    assert_eq!(initialize["method"],"initialize");
    line(engine,json!({"id":initialize["id"],"result":{}}),11.0)
}

fn resume_of(effects:&[Effect]) -> Value { frames(effects).into_iter().find(|frame|frame["method"] == "thread/resume").unwrap() }

#[test]
fn conversation_terminal_writes_before_subscription_without_overriding_permissions() {
    let mut engine = Engine::new(serde_json::json!({
        "name":"session", "thread_id":"thread-1", "headless":false,
        "initialized":true, "connected":true, "subscribed":false
    }), 1, clock(10.0));
    let effects = engine.command(command(OperationKind::Input, serde_json::json!({"text":"Olá"})), clock(11.0)).unwrap();
    let writes = frames(&effects);
    let start = writes.iter().find(|frame| frame["method"] == "turn/start").unwrap();
    assert_eq!(start["params"]["threadId"], "thread-1");
    assert!(start["params"].get("approvalPolicy").is_none());
    assert!(!writes.iter().any(|frame| frame["method"] == "thread/start"));
}

#[test]
fn conversation_terminal_connects_then_subscribes_without_creating_thread_or_permissions() {
    let mut engine = terminal();
    let effects = engine.bootstrap(true,"boot".into()).unwrap();
    assert_eq!(engine.control_view()["deliverable"],false);
    let initialize = frames(&effects)[0].clone();
    let effects = line(&mut engine,json!({"id":initialize["id"],"result":{}}),11.0);
    let writes = frames(&effects);
    assert_eq!(writes[0]["method"],"initialized");
    assert!(!writes.iter().any(|frame|frame["method"] == "thread/start"));
    // Assinar não reenvia aprovação nem sandbox: são da TUI.
    assert_eq!(resume_of(&effects)["params"],json!({"threadId":"thread-1","cwd":"/work"}));
    assert!(effects.iter().any(|e|matches!(e,Effect::Reply { operation_id,disposition:Disposition::Accepted,.. } if operation_id == "boot")));
    assert!(effects.iter().any(|e|matches!(e,Effect::WakeQueue)));
    let view = engine.control_view();
    assert_eq!(view["connected"],true);
    assert_eq!(view["subscribed"],false);
    assert_eq!(view["ready"],false);
    assert_eq!(view["deliverable"],true);
    let start = frames(&engine.command(command(OperationKind::Input,json!({"text":"Olá"})),clock(12.0)).unwrap());
    assert_eq!(start[0]["method"],"turn/start");
    assert!(start[0]["params"].get("approvalPolicy").is_none() && start[0]["params"].get("summary").is_none());
}

#[test]
fn conversation_terminal_enqueue_is_not_delivery() {
    let mut engine = Engine::new(json!({"name":"session","thread_id":"thread-1","headless":false,"initialized":true,"connected":true}),1,clock(10.0));
    engine.command(command(OperationKind::Input,json!({"text":"Olá"})),clock(11.0)).unwrap();
    let written = engine.apply(EngineInput::WriteAck { operation_id:"op-1".into(),outcome:WriteOutcome::Written },clock(11.5)).unwrap();
    assert!(!written.iter().any(|e|matches!(e,Effect::Reply { .. })));
}

#[test]
fn conversation_terminal_unsubscribed_turn_stops_holding_after_ttl_without_resend() {
    let mut engine = Engine::new(json!({"name":"session","thread_id":"thread-1","headless":false,"initialized":true,"connected":true}),1,clock(10.0));
    let start = frames(&engine.command(command(OperationKind::Input,json!({"text":"Olá"})),clock(11.0)).unwrap());
    line(&mut engine,json!({"id":start[0]["id"],"result":{"turn":{"id":"turn-1"}}}),12.0);
    assert_eq!(engine.control_view()["deliverable"],false);
    assert_eq!(engine.next_deadline(),Some(312.0));
    engine.apply(EngineInput::Tick,clock(311.0)).unwrap();
    assert_eq!(engine.control_view()["deliverable"],false);
    let expired = engine.apply(EngineInput::Tick,clock(312.0)).unwrap();
    assert!(frames(&expired).is_empty());
    assert!(!expired.iter().any(|e|matches!(e,Effect::Reply { .. })));
    assert!(expired.iter().any(|e|matches!(e,Effect::WakeQueue)));
    assert_eq!(engine.control_view()["deliverable"],true);
    assert!(engine.view()["problema"].is_null());
    assert_eq!(engine.next_deadline(),None);
}

#[test]
fn conversation_terminal_restored_turn_without_start_expires_after_ttl() {
    // Turno ativo que chega pelo estado (não pelo nosso `turn/start`): conta a partir de quando foi visto.
    let mut engine = Engine::new(json!({"name":"session","thread_id":"thread-1","headless":false,"initialized":true,"connected":true}),1,clock(10.0));
    line(&mut engine,json!({"method":"thread/status/changed","params":{"threadId":"thread-1","status":{"type":"active"}}}),20.0);
    assert_eq!(engine.control_view()["in_progress"],true);
    assert_eq!(engine.next_deadline(),Some(320.0));
    engine.apply(EngineInput::Tick,clock(319.0)).unwrap();
    assert_eq!(engine.control_view()["deliverable"],false);
    let expired = engine.apply(EngineInput::Tick,clock(320.0)).unwrap();
    assert!(frames(&expired).is_empty());
    assert!(!expired.iter().any(|e|matches!(e,Effect::Reply { .. })));
    assert_eq!(engine.control_view()["deliverable"],true);
    assert!(engine.view()["problema"].is_null());
}

/// Motor terminal recém-aberto com a assinatura em voo da vida anterior restaurada da fila, já conectado.
fn restored_subscription(operation_id:&str) -> Engine {
    let mut engine = terminal();
    engine.restore_rpc(operation_id.into(),&json!({"jsonrpc":"2.0","id":"hangar:1:7","method":"thread/resume",
        "params":{"threadId":"thread-1","cwd":"/work"}}),0,0);
    connect(&mut engine);
    engine
}

fn patches(effects:&[Effect]) -> usize {
    effects.iter().filter(|e|matches!(e,Effect::Policy { kind,.. } if kind == "session.patch_meta")).count()
}

#[test]
fn conversation_terminal_restored_subscription_keeps_its_policy() {
    let mut engine = restored_subscription("subscribe:1:7");
    let effects = line(&mut engine,json!({"id":"hangar:1:7","result":{"thread":{"id":"thread-1","path":"/r/one.jsonl",
        "status":{"type":"idle"},"turns":[]}}}),12.0);
    assert_eq!(patches(&effects),0);
    assert_eq!(engine.control_view()["subscribed"],true);
    assert_eq!(engine.control_view()["rollout_path"],"/r/one.jsonl");

    let mut engine = restored_subscription("subscribe:1:7");
    line(&mut engine,json!({"id":"hangar:1:7","error":{"message":"no rollout found for thread id thread-1"}}),12.0);
    assert!(engine.view()["problema"].is_null());
    assert_eq!(engine.next_deadline(),Some(13.0));
    assert_eq!(engine.control_view()["subscribed"],false);

    let mut engine = restored_subscription("subscribe:1:7");
    let effects = line(&mut engine,json!({"id":"hangar:1:7","error":{"message":"invalid thread id: thread-1"}}),12.0);
    assert_eq!(engine.view()["problema"],"codex_conversa_nao_abriu");
    assert_eq!(patches(&effects),0);
}

#[test]
fn restored_resume_saved_before_the_marker_stays_on_the_old_path() {
    // Registro sem o id `subscribe:<geração>:<n>` (anterior à mudança): mesma restauração de antes.
    let mut engine = restored_subscription("bootstrap:key:1:thread");
    let effects = line(&mut engine,json!({"id":"hangar:1:7","result":{"thread":{"id":"thread-1","path":"/r/one.jsonl",
        "status":{"type":"idle"},"turns":[]}}}),12.0);
    assert_eq!(patches(&effects),1);
    assert_eq!(engine.control_view()["subscribed"],false);
}

#[test]
fn conversation_terminal_missing_rollout_retries_with_growing_bounded_wait() {
    let mut engine = terminal();
    let resume = resume_of(&connect(&mut engine));
    line(&mut engine,json!({"id":resume["id"],"error":{"code":-32600,"message":"no rollout found for thread id thread-1"}}),12.0);
    assert!(engine.view()["problema"].is_null());
    assert_eq!(engine.control_view()["deliverable"],true);
    assert_eq!(engine.next_deadline(),Some(13.0));
    assert!(frames(&engine.apply(EngineInput::Tick,clock(12.5)).unwrap()).is_empty());
    let retry = resume_of(&engine.apply(EngineInput::Tick,clock(13.0)).unwrap());
    assert_eq!(retry["params"]["threadId"],"thread-1");
    line(&mut engine,json!({"id":retry["id"],"error":{"message":"no rollout found for thread id thread-1"}}),13.5);
    assert_eq!(engine.next_deadline(),Some(15.0));
    let retry = resume_of(&engine.apply(EngineInput::Tick,clock(15.0)).unwrap());
    let effects = line(&mut engine,json!({"id":retry["id"],"result":{"thread":{"id":"thread-1","path":"/r/one.jsonl",
        "status":{"type":"idle"},"turns":[]}}}),16.0);
    let view = engine.control_view();
    assert_eq!(view["subscribed"],true);
    assert_eq!(view["ready"],true);
    assert_eq!(view["rollout_path"],"/r/one.jsonl");
    assert!(effects.iter().any(|e|matches!(e,Effect::WakeQueue)));
    assert_eq!(engine.next_deadline(),None);
}

#[test]
fn conversation_terminal_invalid_thread_is_not_retried_and_shows_problem() {
    let mut engine = terminal();
    let resume = resume_of(&connect(&mut engine));
    line(&mut engine,json!({"id":resume["id"],"error":{"code":-32600,"message":"invalid thread id: thread-1"}}),12.0);
    assert_eq!(engine.view()["problema"],"codex_conversa_nao_abriu");
    assert_eq!(engine.next_deadline(),None);
    assert!(frames(&engine.apply(EngineInput::Tick,clock(60.0)).unwrap()).is_empty());
}

#[test]
fn conversation_terminal_unproven_resume_result_is_refused_and_does_not_wake_queue() {
    for result in [json!({}),json!("thread-1"),json!({"thread":{"id":"thread-2","path":"/r/two.jsonl","status":{"type":"idle"},"turns":[]}})] {
        let mut engine = terminal();
        let resume = resume_of(&connect(&mut engine));
        let effects = line(&mut engine,json!({"id":resume["id"],"result":result}),12.0);
        assert!(effects.iter().any(|e|matches!(e,Effect::Reply { disposition:Disposition::Rejected,.. })),"{result}");
        assert!(!effects.iter().any(|e|matches!(e,Effect::Reply { disposition:Disposition::Accepted,.. })),"{result}");
        assert!(!effects.iter().any(|e|matches!(e,Effect::WakeQueue)),"{result}");
        let view = engine.control_view();
        assert_eq!(view["subscribed"],false,"{result}");
        assert_eq!(view["ready"],false,"{result}");
        assert!(view["rollout_path"] != "/r/two.jsonl","{result}");
        assert_eq!(engine.view()["problema"],"codex_conversa_nao_abriu","{result}");
    }
    let mut engine = terminal();
    let resume = resume_of(&connect(&mut engine));
    let effects = line(&mut engine,json!({"id":resume["id"],"result":{"thread":{"id":"thread-1","path":"/r/one.jsonl","status":{"type":"idle"},"turns":[]}}}),12.0);
    assert!(effects.iter().any(|e|matches!(e,Effect::Reply { disposition:Disposition::Accepted,.. })));
    assert!(effects.iter().any(|e|matches!(e,Effect::WakeQueue)));
    assert_eq!(engine.control_view()["subscribed"],true);
    assert_eq!(engine.control_view()["ready"],true);
}

#[test]
fn conversation_terminal_subscription_without_reply_is_not_silent_idle() {
    let mut engine = terminal();
    connect(&mut engine);
    engine.apply(EngineInput::Tick,clock(41.0)).unwrap();
    assert_eq!(engine.view()["state"],"idle");
    assert_eq!(engine.view()["problema"],"codex_conversa_nao_abriu");
    assert_eq!(engine.control_view()["subscribed"],false);
}

#[test]
fn conversation_terminal_unwritten_subscription_is_retried() {
    let mut engine = terminal();
    let effects = connect(&mut engine);
    let operation = effects.iter().find_map(|e|match e { Effect::Write { frame,operation_id } if frame["method"] == "thread/resume"=>operation_id.clone(),_=>None }).unwrap();
    let lost = engine.apply(EngineInput::WriteAck { operation_id:operation,outcome:WriteOutcome::NotWritten },clock(11.5)).unwrap();
    assert!(lost.iter().any(|e|matches!(e,Effect::Reply { disposition:Disposition::Rejected,.. })));
    assert_eq!(engine.next_deadline(),Some(12.5));
    assert_eq!(resume_of(&engine.apply(EngineInput::Tick,clock(12.5)).unwrap())["params"]["threadId"],"thread-1");
}

#[test]
fn conversation_terminal_refuses_headless_only_commands() {
    let mut engine = Engine::new(json!({"name":"session","thread_id":"thread-1","headless":false,"initialized":true,"connected":true}),1,clock(10.0));
    assert!(engine.command(command(OperationKind::Restart,json!({})),clock(11.0)).is_err());
    assert!(engine.command(command(OperationKind::SetPermissionMode,json!({"mode":"Full Access"})),clock(11.0)).is_err());
}

#[test]
fn conversation_terminal_follows_tui_thread_and_keeps_subagent_requests() {
    let mut engine = terminal();
    let resume = resume_of(&connect(&mut engine));
    line(&mut engine,json!({"id":resume["id"],"result":{"thread":{"id":"thread-1","path":"/r/one.jsonl","status":{"type":"idle"},"turns":[]}}}),12.0);
    line(&mut engine,json!({"id":7,"method":"item/commandExecution/requestApproval","params":{"threadId":"thread-1","command":"pwd"}}),13.0);
    // Pedido de subagente atravessa o filtro de outra thread.
    let child = line(&mut engine,json!({"id":8,"method":"item/fileChange/requestApproval","params":{"threadId":"child","grantRoot":"/work"}}),13.0);
    assert!(frames(&child).is_empty());
    // Subagente iniciado não troca o vínculo.
    line(&mut engine,json!({"method":"thread/started","params":{"thread":{"id":"child","path":"/r/child.jsonl","cwd":"/work",
        "source":"cli","parentThreadId":"thread-1"}}}),14.0);
    assert_eq!(engine.control_view()["thread_id"],"thread-1");
    let effects = line(&mut engine,json!({"method":"thread/started","params":{"thread":{"id":"thread-2","path":"/r/two.jsonl",
        "cwd":"/work","source":"cli"}}}),15.0);
    let view = engine.control_view();
    assert_eq!(view["thread_id"],"thread-2");
    assert_eq!(view["rollout_path"],"/r/two.jsonl");
    assert_eq!(view["subscribed"],false);
    assert_eq!(view["connected"],true);
    let pending:Vec<Value> = view["pending"].as_array().unwrap().iter().map(|p|p["request_id"].clone()).collect();
    assert_eq!(pending,vec![json!(8)]);
    assert_eq!(resume_of(&effects)["params"]["threadId"],"thread-2");
    assert!(effects.iter().any(|e|matches!(e,Effect::Policy { kind,payload,.. } if kind == "session.patch_meta" && payload["thread_id"] == "thread-2")));
    // O mesmo `thread/started` repetido não reassina nem invalida de novo.
    let late =line(&mut engine,json!({"method":"thread/started","params":{"thread":{"id":"thread-2","path":"/r/two.jsonl","cwd":"/work","source":"cli"}}}),16.0);
    assert!(frames(&late).is_empty());
}

#[test]
fn conversation_terminal_late_subscription_of_previous_thread_is_ignored() {
    let mut engine = terminal();
    let old = resume_of(&connect(&mut engine));
    line(&mut engine,json!({"method":"thread/started","params":{"thread":{"id":"thread-2","path":"/r/two.jsonl","cwd":"/work","source":"cli"}}}),12.0);
    line(&mut engine,json!({"id":old["id"],"result":{"thread":{"id":"thread-1","path":"/r/one.jsonl","status":{"type":"idle"},"turns":[]}}}),13.0);
    let view = engine.control_view();
    assert_eq!(view["thread_id"],"thread-2");
    assert_eq!(view["subscribed"],false);
    assert_eq!(view["rollout_path"],"/r/two.jsonl");
}

#[test]
fn question_hydrate_merges_notifications() {
    let mut engine = engine();
    let read = engine.command(command(OperationKind::ReadSettings,json!({"include_turns":true})),clock(10.0)).unwrap();
    let id = frames(&read)[0]["id"].clone();
    line(&mut engine,json!({"method":"item/completed","params":{"threadId":"thread-1","item":{
        "id":"question-new","type":"agentMessage","delivery":"async","questions":[{"title":"Nova pergunta","options":["A","B"]}]}}}),11.0);
    line(&mut engine,json!({"id":id,"result":{"thread":{"id":"thread-1","status":{"type":"idle"},"turns":[]}}}),12.0);
    assert_eq!(engine.view()["codex_question"]["questions"][0]["question"],"Nova pergunta");
    line(&mut engine,json!({"method":"item/completed","params":{"threadId":"thread-1","item":{
        "id":"ordinary-user","type":"userMessage","content":[{"type":"text","text":"> Nova pergunta\n\nA"}]}}}),13.0);
    assert_eq!(engine.view()["codex_question"]["questions"][0]["question"],"Nova pergunta");
}

#[test]
fn preview_full_prefix_on_takeover() {
    let mut engine = engine();
    let snapshot = CanoSnapshot::parse(json!({"type":"cano_snapshot","versao":2,"pid":42,"init":null,
        "aberto":false,"pendentes":[],"ultimo_result":null,"rate_limit":null,"stderr_tail":[],"saiu":null,
        "inflight":{"codex":{"thread-1":{"complete":true,"text":"Olá 🌎","itemId":"item-1","turnId":"turn-1"}}}})).unwrap();
    let effects = engine.hydrate(snapshot).unwrap();
    let text = effects.into_iter().find_map(|e|match e { Effect::Publish { channel,data } if channel == "preview"=>Some(data["text"].clone()),_=>None }).unwrap();
    assert_eq!(text,"Olá 🌎");
    assert_eq!(engine.control_view()["turn_id"],"turn-1");
}

#[test]
fn late_reply_does_not_reopen_a_completed_turn() {
    let mut engine = engine();
    let effects = engine.command(command(OperationKind::Input,json!({"text":"Olá"})),clock(10.0)).unwrap();
    let id = frames(&effects)[0]["id"].clone();
    line(&mut engine,json!({"method":"turn/started","params":{"threadId":"thread-1","turn":{"id":"turn-1"}}}),11.0);
    line(&mut engine,json!({"method":"turn/completed","params":{"threadId":"thread-1","turn":{"id":"turn-1","status":"completed"}}}),12.0);
    line(&mut engine,json!({"id":id,"result":{"turn":{"id":"turn-1"}}}),13.0);
    assert_eq!(engine.view()["state"],"idle");
    assert_eq!(engine.control_view()["in_progress"],false);
}

#[test]
fn late_ack_does_not_remove_reused_server_request() {
    let mut engine = engine();
    let store = identified(&mut engine);
    let approval = json!({"id":1,"method":"item/commandExecution/requestApproval","params":{"threadId":"thread-1","command":"pwd"}});
    line(&mut engine,approval.clone(),10.0);
    select(&mut engine,&store,json!(1),1,10.0).unwrap();
    line(&mut engine,json!({"method":"serverRequest/resolved","params":{"threadId":"thread-1","requestId":1}}),11.0);
    line(&mut engine,approval,12.0);
    engine.apply(EngineInput::WriteAck { operation_id:"op-1".into(),outcome:WriteOutcome::Written },clock(13.0)).unwrap();
    assert_eq!(engine.control_view()["pending"].as_array().unwrap().len(),1);
}

#[test]
fn voice_organizer_uses_same_writer_without_changing_target_thread() {
    let mut engine = engine();
    engine.command(RuntimeCommand { operation_id:"voice-open".into(),kind:OperationKind::VoiceOpen,payload:json!({"call_id":"call-1"}) },clock(10.0)).unwrap();
    let effects = engine.command(RuntimeCommand { operation_id:"voice-thread".into(),kind:OperationKind::VoiceRpc,
        payload:json!({"call_id":"call-1","method":"thread/start","params":{"ephemeral":true,"sandbox":"read-only","approvalPolicy":"never"}}) },clock(11.0)).unwrap();
    let id = frames(&effects)[0]["id"].clone();
    line(&mut engine,json!({"id":id,"result":{"thread":{"id":"organizer-1"}}}),12.0);
    assert_eq!(engine.control_view()["thread_id"],"thread-1");
    let effects = line(&mut engine,json!({"id":7,"method":"item/tool/call","params":{"threadId":"organizer-1","name":"draft"}}),13.0);
    assert!(effects.iter().any(|effect|matches!(effect,Effect::Publish { channel,data } if channel == "voice" && data["call_id"] == "call-1")));
    assert!(!effects.iter().any(|effect|matches!(effect,Effect::Write { .. })));
    assert!(engine.control_view()["pending"].as_array().unwrap().is_empty());
    assert!(engine.command(RuntimeCommand { operation_id:"wrong-id".into(),kind:OperationKind::VoiceRespond,
        payload:json!({"call_id":"call-1","request_id":"7","result":{}}) },clock(14.0)).is_err());
    assert!(engine.command(RuntimeCommand { operation_id:"wrong-thread".into(),kind:OperationKind::VoiceRpc,
        payload:json!({"call_id":"call-1","method":"turn/start","params":{"threadId":"thread-1","input":[]}}) },clock(15.0)).is_err());
}

#[test]
fn voice_initialize_is_virtual_and_never_sends_another_initialize() {
    let mut engine = engine();
    engine.command(RuntimeCommand { operation_id:"open".into(),kind:OperationKind::VoiceOpen,payload:json!({"call_id":"call"}) },clock(10.0)).unwrap();
    let effects = engine.command(RuntimeCommand { operation_id:"init".into(),kind:OperationKind::VoiceRpc,
        payload:json!({"call_id":"call","method":"initialize","params":{}}) },clock(11.0)).unwrap();
    assert!(frames(&effects).is_empty());
    assert!(effects.iter().any(|effect|matches!(effect,Effect::Reply { disposition:Disposition::Accepted,.. })));
}

#[test]
fn slash_skill_waits_for_catalog_before_starting_turn() {
    let mut engine = engine();
    let effects = engine.command(command(OperationKind::Input,json!({"text":"/skill Olá", "skill_name":"skill",
        "input":[{"type":"text","text":"/skill Olá"}]})),clock(10.0)).unwrap();
    let read = frames(&effects)[0].clone();
    assert_eq!(read["method"],"skills/list");
    let effects = line(&mut engine,json!({"id":read["id"],"result":{"data":[]}}),11.0);
    let (request_id,_) = effects.iter().find_map(|effect|match effect {
        Effect::Policy { kind,request_id,payload } if kind == "skill_catalog"=>Some((request_id.clone(),payload.clone())),_=>None }).unwrap();
    assert!(frames(&effects).is_empty());
    let effects = engine.apply(EngineInput::PolicyResult { request_id,payload:json!({"skill":{"native_name":"skill","path":"/fake/skill"}}) },clock(12.0)).unwrap();
    let input = frames(&effects)[0].clone();
    assert_eq!(input["method"],"turn/start");
    assert_eq!(input["params"]["input"][1],json!({"type":"skill","name":"skill","path":"/fake/skill"}));
}

#[test]
fn organizer_request_before_thread_reply_is_preserved_once() {
    let mut engine = engine();
    engine.command(RuntimeCommand { operation_id:"open".into(),kind:OperationKind::VoiceOpen,payload:json!({"call_id":"call"}) },clock(10.0)).unwrap();
    let effects = engine.command(RuntimeCommand { operation_id:"start".into(),kind:OperationKind::VoiceRpc,
        payload:json!({"call_id":"call","method":"thread/start","params":{"ephemeral":true,"sandbox":"read-only","approvalPolicy":"never"}}) },clock(11.0)).unwrap();
    let id = frames(&effects)[0]["id"].clone();
    let request = json!({"id":7,"method":"item/tool/call","params":{"threadId":"organizer","name":"draft"}});
    assert!(frames(&line(&mut engine,request.clone(),11.1)).is_empty());
    let effects = line(&mut engine,json!({"id":id,"result":{"thread":{"id":"organizer"}}}),12.0);
    assert_eq!(effects.iter().filter(|effect|matches!(effect,Effect::Publish { channel,.. } if channel == "voice")).count(),1);
    let duplicate = line(&mut engine,request,12.1);
    assert!(!duplicate.iter().any(|effect|matches!(effect,Effect::Publish { channel,.. } if channel == "voice")));
}

#[test]
fn subagent_request_during_voice_start_reaches_the_card_once_the_voice_is_open() {
    let mut engine = engine();
    let store = identified(&mut engine);
    engine.command(RuntimeCommand { operation_id:"open".into(),kind:OperationKind::VoiceOpen,payload:json!({"call_id":"call"}) },clock(10.0)).unwrap();
    let effects = engine.command(RuntimeCommand { operation_id:"start".into(),kind:OperationKind::VoiceRpc,
        payload:json!({"call_id":"call","method":"thread/start","params":{"ephemeral":true,"sandbox":"read-only","approvalPolicy":"never"}}) },clock(11.0)).unwrap();
    let id = frames(&effects)[0]["id"].clone();
    line(&mut engine,json!({"id":12,"method":"item/commandExecution/requestApproval","params":{"threadId":"subagent","command":"ls"}}),11.1);
    line(&mut engine,json!({"id":id,"result":{"thread":{"id":"organizer"}}}),12.0);
    assert_eq!(engine.view()["state"],"awaiting_input");
    let effects = select(&mut engine,&store,json!(12),1,13.0).unwrap();
    assert_eq!(reply_to(&effects,12)["result"]["decision"],"accept");
}

fn tier_notification(engine:&mut Engine,thread:&str,tier:Value,time:f64) -> Vec<Effect> {
    line(engine,json!({"method":"thread/settings/updated","params":{"threadId":thread,"threadSettings":{"serviceTier":tier}}}),time)
}
fn tier_accepted(effects:&[Effect]) -> bool {
    effects.iter().any(|effect|matches!(effect,Effect::Reply { operation_id,disposition:Disposition::Accepted,payload }
        if operation_id == "op-1" && payload["service_tier"].is_string()))
}
fn tier_update(engine:&mut Engine,tier:&str) -> Value {
    let effects = engine.command(command(OperationKind::SetServiceTier,json!({"service_tier":tier})),clock(10.0)).unwrap();
    let mut request = frames(&effects)[0].clone();
    if tier == "priority" {
        assert_eq!(request["method"],"model/list");
        request = frames(&line(engine,json!({"id":request["id"],"result":{"data":[{"model":"gpt-6","serviceTiers":[{"id":"priority"}]}]}}),10.1))[0].clone();
    }
    assert_eq!(request["method"],"thread/settings/update");
    assert_eq!(request["params"],json!({"threadId":"thread-1","serviceTier":tier}));
    request
}

#[test]
fn expired_service_tier_writes_cannot_reach_the_transport() {
    for tier in ["default","priority"] {
        let mut engine = engine();
        let effects = engine.command(command(OperationKind::SetServiceTier,json!({"service_tier":tier})),clock(10.0)).unwrap();
        let writes:Vec<_> = effects.iter().filter_map(|effect|match effect {
            Effect::Write { operation_id:Some(id),.. }=>Some(id.clone()),_=>None,
        }).collect();
        assert!(!writes.is_empty());
        assert!(writes.iter().all(|id|engine.write_is_current(id)));
        engine.apply(EngineInput::Tick,clock(20.1)).unwrap();
        assert!(writes.iter().all(|id|!engine.write_is_current(id)));
    }
}

#[test]
fn service_tier_already_active_is_accepted_without_waiting() {
    for tier in ["default","priority"] {
        let mut engine = Engine::new(json!({"name":"session","thread_id":"thread-1","headless":true,"model":"gpt-6",
            "initialized":true,"ready":true,"service_tier":tier}),1,clock(10.0));
        assert_eq!(engine.control_view()["service_tier"],tier);
        let effects = engine.command(command(OperationKind::SetServiceTier,json!({"service_tier":tier})),clock(10.0)).unwrap();
        assert!(tier_accepted(&effects));
        assert!(frames(&effects).is_empty());
    }
}

#[test]
fn service_tier_control_is_strict_and_catalog_keeps_tiers() {
    assert_eq!(serde_json::to_value(OperationKind::SetServiceTier).unwrap(),"set_service_tier");
    let mut engine = engine();
    for payload in [json!({"service_tier":"fast"}),json!({"service_tier":null}),json!({"service_tier":"default","model":"other"})] {
        assert!(engine.command(command(OperationKind::SetServiceTier,payload),clock(10.0)).is_err());
    }
    let request = frames(&engine.command(command(OperationKind::ListModels,json!({})),clock(10.0)).unwrap())[0].clone();
    let effects = line(&mut engine,json!({"id":request["id"],"result":{"data":[{"model":"gpt-6","serviceTiers":[{"id":"priority"}],"defaultServiceTier":"default"}]}}),10.1);
    let catalog = effects.iter().find_map(|effect|match effect { Effect::Reply { payload,.. }=>Some(payload),_=>None }).unwrap();
    assert_eq!(catalog[0]["serviceTiers"],json!([{"id":"priority"}]));
    assert_eq!(catalog[0]["defaultServiceTier"],"default");
}

#[test]
fn priority_requires_visible_live_support_and_unchanged_model() {
    for model in [json!({"model":"gpt-6","serviceTiers":[]}),json!({"model":"gpt-6","hidden":true,"serviceTiers":[{"id":"priority"}]}),
        json!({"model":"gpt-6","serviceTiers":[{"id":"priority","hidden":true}]})] {
        let mut engine = engine();
        let request = frames(&engine.command(command(OperationKind::SetServiceTier,json!({"service_tier":"priority"})),clock(10.0)).unwrap())[0].clone();
        let effects = line(&mut engine,json!({"id":request["id"],"result":{"data":[model]}}),10.1);
        assert!(frames(&effects).is_empty());
        assert!(effects.iter().any(|effect|matches!(effect,Effect::Reply { operation_id,disposition:Disposition::Rejected,.. } if operation_id == "op-1")));
    }
    let mut engine = engine();
    let request = frames(&engine.command(command(OperationKind::SetServiceTier,json!({"service_tier":"priority"})),clock(10.0)).unwrap())[0].clone();
    line(&mut engine,json!({"method":"thread/settings/updated","params":{"threadId":"thread-1","threadSettings":{"model":"other"}}}),10.1);
    let effects = line(&mut engine,json!({"id":request["id"],"result":{"data":[{"model":"gpt-6","serviceTiers":[{"id":"priority"}]}]}}),10.2);
    assert!(frames(&effects).is_empty());
    assert!(!tier_accepted(&effects));
}

#[test]
fn service_tier_needs_ack_notification_and_authoritative_snapshot_in_either_order() {
    for tier in ["priority","default"] { for before_ack in [false,true] {
        let mut engine = Engine::new(json!({"name":"session","thread_id":"thread-1","headless":true,"ready":true,
            "model":"gpt-6","effort":"high","mode":"plan"}),1,clock(10.0));
        let update = tier_update(&mut engine,tier);
        assert!(engine.command(RuntimeCommand { operation_id:"second".into(),kind:OperationKind::SetServiceTier,payload:json!({"service_tier":"default"}) },clock(10.2)).is_err());
        assert!(tier_notification(&mut engine,"other",json!(tier),10.3).is_empty());
        let effects = if before_ack {
            assert!(frames(&tier_notification(&mut engine,"thread-1",json!(tier),10.4)).is_empty());
            line(&mut engine,json!({"id":update["id"],"result":{}}),10.5)
        } else {
            let ack = line(&mut engine,json!({"id":update["id"],"result":{}}),10.4);
            assert!(!tier_accepted(&ack)); assert!(frames(&ack).is_empty());
            tier_notification(&mut engine,"thread-1",json!(tier),10.5)
        };
        assert!(!tier_accepted(&effects));
        let read = frames(&effects)[0].clone();
        assert_eq!(read["method"],"thread/resume"); assert_eq!(read["params"],json!({"threadId":"thread-1"}));
        let confirmed = line(&mut engine,json!({"id":read["id"],"result":{"thread":{"id":"thread-1"},"serviceTier":tier}}),10.6);
        assert!(tier_accepted(&confirmed));
        assert_eq!(engine.view()["codex_service_tier"],tier);
        assert_eq!(engine.control_view()["service_tier"],tier);
        assert_eq!(engine.control_view()["model"],"gpt-6"); assert_eq!(engine.control_view()["effort"],"high"); assert_eq!(engine.control_view()["mode"],"plan");
    } }
}

#[test]
fn old_candidate_waits_for_new_event_and_does_not_poll() {
    let mut engine = engine(); let update = tier_update(&mut engine,"priority");
    line(&mut engine,json!({"id":update["id"],"result":{}}),10.2);
    assert!(frames(&tier_notification(&mut engine,"thread-1",json!("default"),10.3)).is_empty());
    let read = frames(&tier_notification(&mut engine,"thread-1",json!("priority"),10.4))[0].clone();
    let stale = line(&mut engine,json!({"id":read["id"],"result":{"thread":{"id":"thread-1"},"serviceTier":"default"}}),10.5);
    assert!(!tier_accepted(&stale)); assert!(frames(&stale).is_empty());
    let read = frames(&tier_notification(&mut engine,"thread-1",json!("priority"),10.6))[0].clone();
    tier_notification(&mut engine,"thread-1",json!("priority"),10.7);
    let during = line(&mut engine,json!({"id":read["id"],"result":{"thread":{"id":"thread-1"},"serviceTier":"default"}}),10.8);
    assert!(!tier_accepted(&during));
    let read = frames(&during)[0].clone();
    let confirmed = line(&mut engine,json!({"id":read["id"],"result":{"thread":{"id":"thread-1"},"serviceTier":"priority"}}),10.9);
    assert!(tier_accepted(&confirmed));
}

#[test]
fn service_tier_errors_expiry_disconnect_and_recovery_never_accept() {
    for failure in ["rpc","timeout","eof","foreign_snapshot","write"] {
        let mut engine = engine(); let update = tier_update(&mut engine,"default");
        let effects = match failure {
            "rpc"=>line(&mut engine,json!({"id":update["id"],"error":{"message":"refused"}}),11.0),
            "timeout"=>engine.apply(EngineInput::Tick,clock(20.1)).unwrap(),
            "eof"=>line(&mut engine,json!({"type":"cano_saiu"}),11.0),
            "write"=>engine.apply(EngineInput::WriteAck { operation_id:"op-1".into(),outcome:WriteOutcome::Unknown },clock(11.0)).unwrap(),
            _=>{
                line(&mut engine,json!({"id":update["id"],"result":{}}),10.2);
                let read = frames(&tier_notification(&mut engine,"thread-1",json!("default"),10.3))[0].clone();
                line(&mut engine,json!({"id":read["id"],"result":{"thread":{"id":"other"},"serviceTier":"default"}}),11.0)
            },
        };
        assert!(effects.iter().any(|effect|matches!(effect,Effect::Reply { operation_id,disposition:Disposition::Rejected | Disposition::Unknown,.. } if operation_id == "op-1")));
        assert!(!tier_accepted(&effects));
        assert!(!tier_accepted(&line(&mut engine,json!({"id":update["id"],"result":{}}),21.0)));
    }
    let mut engine = engine();
    let frame = json!({"id":"hangar:1:50","method":"thread/settings/update","params":{"threadId":"thread-1","serviceTier":"priority"}});
    engine.restore_rpc("op-1".into(),&frame,0,0);
    let recovered = line(&mut engine,json!({"id":frame["id"],"result":{}}),11.0);
    assert!(!recovered.iter().any(|effect|matches!(effect,Effect::Reply { disposition:Disposition::Accepted,.. })));
    assert!(frames(&recovered).is_empty());
    assert!(engine.control_view()["service_tier"].is_null());
}

#[test]
fn read_preserves_tier_and_resume_cannot_overwrite_newer_settings() {
    let mut engine = Engine::new(json!({"name":"session","thread_id":"thread-1","headless":true,"ready":true,
        "service_tier":"priority","model":"gpt-6","effort":"high"}),1,clock(10.0));
    let read = frames(&engine.command(command(OperationKind::ReadSettings,json!({})),clock(10.0)).unwrap())[0].clone();
    line(&mut engine,json!({"id":read["id"],"result":{"thread":{"id":"thread-1"}}}),10.1);
    assert_eq!(engine.control_view()["service_tier"],"priority");
    let resume = json!({"id":"hangar:1:50","method":"thread/resume","params":{"threadId":"thread-1"}});
    engine.restore_rpc("resume".into(),&resume,0,0);
    tier_notification(&mut engine,"thread-1",json!("priority"),10.2);
    line(&mut engine,json!({"id":resume["id"],"result":{"thread":{"id":"thread-1"},"serviceTier":null,"model":"old","reasoningEffort":"low"}}),10.3);
    assert_eq!(engine.control_view()["service_tier"],"priority"); assert_eq!(engine.control_view()["model"],"gpt-6");
    let read = frames(&engine.command(command(OperationKind::SetServiceTier,json!({"service_tier":"default"})),clock(11.0)).unwrap())[0].clone();
    line(&mut engine,json!({"id":read["id"],"result":{}}),11.1);
    let resume = frames(&tier_notification(&mut engine,"thread-1",Value::Null,11.2))[0].clone();
    assert!(tier_accepted(&line(&mut engine,json!({"id":resume["id"],"result":{"thread":{"id":"thread-1"},"serviceTier":null}}),11.3)));
}

#[test]
fn resume_uses_external_tier_and_thread_change_cancels_pending_choice() {
    for (wire_tier,effective) in [(json!("priority"),"priority"),(Value::Null,"default")] {
        let mut engine = engine();
        let resume = json!({"id":"hangar:1:50","method":"thread/resume","params":{"threadId":"thread-1"}});
        engine.restore_rpc("resume".into(),&resume,0,0);
        line(&mut engine,json!({"id":resume["id"],"result":{"thread":{"id":"thread-1","serviceTier":"wrong"},"serviceTier":wire_tier}}),10.1);
        assert_eq!(engine.control_view()["service_tier"],effective);
    }
    // Conversa nova (`thread/start`): o `resume` que devolve outra conversa é recusado, não troca o vínculo.
    let mut engine = engine(); let update = tier_update(&mut engine,"default");
    let start = json!({"id":"hangar:1:50","method":"thread/start","params":{}});
    engine.restore_rpc("start".into(),&start,0,0);
    let effects = line(&mut engine,json!({"id":start["id"],"result":{"thread":{"id":"other"},"serviceTier":"priority"}}),10.2);
    assert!(effects.iter().any(|effect|matches!(effect,Effect::Reply { operation_id,disposition:Disposition::Unknown,.. } if operation_id == "op-1")));
    assert!(!tier_accepted(&line(&mut engine,json!({"id":update["id"],"result":{}}),10.3)));
}

#[test]
fn bootstrap_new_process_preserves_tier_but_live_resume_does_not_override() {
    for reconnect in [false,true] {
        let mut engine = Engine::new(json!({"name":"session","thread_id":"thread-1","headless":true,"service_tier":"priority"}),1,clock(10.0));
        let init = frames(&engine.bootstrap(reconnect,"boot".into()).unwrap())[0].clone();
        let requests = frames(&line(&mut engine,json!({"id":init["id"],"result":{}}),10.1));
        if reconnect { assert!(requests[1]["params"].get("serviceTier").is_none()); }
        else { assert_eq!(requests[1]["params"]["serviceTier"],"priority"); }
    }
}

fn published(effects:&[Effect],name:&str) -> Vec<String> {
    effects.iter().filter_map(|e|match e { Effect::Publish { channel,data } if channel == name=>data["text"].as_str().map(str::to_owned),_=>None }).collect()
}

#[test]
fn stop_terminates_the_commands_the_interrupted_turn_was_running() {
    let mut engine = engine();
    line(&mut engine,json!({"method":"turn/started","params":{"threadId":"thread-1","turn":{"id":"turn-1"}}}),10.0);
    line(&mut engine,json!({"method":"item/started","params":{"threadId":"thread-1","turnId":"turn-1",
        "item":{"type":"commandExecution","id":"exec-1","processId":"43041","command":"sleep 300"}}}),10.5);
    line(&mut engine,json!({"method":"item/started","params":{"threadId":"thread-1","turnId":"turn-1",
        "item":{"type":"commandExecution","id":"exec-2","processId":"43042","command":"true"}}}),10.6);
    line(&mut engine,json!({"method":"item/completed","params":{"threadId":"thread-1","turnId":"turn-1",
        "item":{"type":"commandExecution","id":"exec-2","processId":"43042"}}}),10.7);
    let interrupt = frames(&engine.command(command(OperationKind::Interrupt,json!({})),clock(11.0)).unwrap())[0].clone();
    assert_eq!(interrupt["method"],"turn/interrupt");
    let effects = line(&mut engine,json!({"id":interrupt["id"],"result":{}}),11.1);
    let terminate:Vec<_> = frames(&effects).into_iter().filter(|f|f["method"] == "thread/backgroundTerminals/terminate").collect();
    assert_eq!(terminate.len(),1);
    assert_eq!(terminate[0]["params"],json!({"threadId":"thread-1","processId":"43041"}));
    assert!(effects.iter().any(|e|matches!(e,Effect::Reply { operation_id,disposition:Disposition::Accepted,.. } if operation_id == "op-1")));
}

#[test]
fn usage_limit_has_its_own_problem_and_survives_the_failed_turn() {
    let mut engine = engine();
    line(&mut engine,json!({"method":"turn/started","params":{"threadId":"thread-1","turn":{"id":"turn-1"}}}),10.0);
    line(&mut engine,json!({"method":"error","params":{"threadId":"thread-1","turnId":"turn-1","willRetry":true,
        "error":{"message":"Rate limit reached","codexErrorInfo":"rateLimitExceeded"}}}),10.5);
    assert_eq!(engine.view()["problema"],"codex_limite_uso");
    line(&mut engine,json!({"method":"error","params":{"threadId":"thread-1","turnId":"turn-1","willRetry":false,
        "error":{"message":"You've hit your usage limit.","codexErrorInfo":"usageLimitExceeded"}}}),11.0);
    line(&mut engine,json!({"method":"turn/completed","params":{"threadId":"thread-1","turn":{"id":"turn-1","status":"failed",
        "error":{"message":"turn failed"}}}}),11.5);
    assert_eq!(engine.view()["problema"],"codex_limite_uso");
    assert_eq!(engine.view()["problema_detalhe"],"You've hit your usage limit.");
}

#[test]
fn reasoning_summary_streams_on_the_thinking_channel_and_input_asks_for_it() {
    let mut engine = engine();
    let start = frames(&engine.command(command(OperationKind::Input,json!({"text":"oi"})),clock(9.0)).unwrap())[0].clone();
    assert_eq!(start["params"]["summary"],"detailed");
    line(&mut engine,json!({"method":"turn/started","params":{"threadId":"thread-1","turn":{"id":"turn-1"}}}),10.0);
    let first = line(&mut engine,json!({"method":"item/reasoning/summaryTextDelta","params":{"threadId":"thread-1","turnId":"turn-1",
        "itemId":"rs-1","summaryIndex":0,"delta":"**Plano**"}}),10.1);
    assert_eq!(published(&first,"thinking"),vec!["**Plano**"]);
    line(&mut engine,json!({"method":"item/reasoning/summaryPartAdded","params":{"threadId":"thread-1","turnId":"turn-1",
        "itemId":"rs-1","summaryIndex":1}}),11.0);
    let second = line(&mut engine,json!({"method":"item/reasoning/summaryTextDelta","params":{"threadId":"thread-1","turnId":"turn-1",
        "itemId":"rs-1","summaryIndex":1,"delta":"Depois"}}),11.3);
    assert_eq!(published(&second,"thinking"),vec!["**Plano**\n\nDepois"]);
    let answer = line(&mut engine,json!({"method":"item/started","params":{"threadId":"thread-1","turnId":"turn-1",
        "item":{"type":"agentMessage","id":"msg-1","text":""}}}),12.0);
    assert_eq!(published(&answer,"thinking"),vec![""]);
}

#[test]
fn turn_cut_by_a_dead_app_server_is_reported_after_reconnect() {
    let mut engine = Engine::new(json!({"name":"session","thread_id":"thread-1","headless":true,"in_progress":true,"turn_id":"turn-1"}),2,clock(10.0));
    let init = frames(&engine.bootstrap(true,"boot".into()).unwrap())[0].clone();
    let resume = frames(&line(&mut engine,json!({"id":init["id"],"result":{}}),10.1))[1].clone();
    assert_eq!(resume["method"],"thread/resume");
    let effects = line(&mut engine,json!({"id":resume["id"],"result":{"thread":{"id":"thread-1","status":{"type":"idle"}}}}),10.2);
    let read = frames(&effects).into_iter().find(|f|f["method"] == "thread/read").unwrap();
    assert_eq!(read["params"]["includeTurns"],true);
    line(&mut engine,json!({"id":read["id"],"result":{"thread":{"id":"thread-1","status":{"type":"idle"},
        "turns":[{"id":"turn-1","status":"interrupted"}]}}}),10.3);
    assert_eq!(engine.view()["problema"],"codex_turno_cortado");
}

#[test]
fn finished_turn_after_reconnect_is_not_reported_as_cut() {
    let mut engine = Engine::new(json!({"name":"session","thread_id":"thread-1","headless":true,"in_progress":true}),2,clock(10.0));
    let init = frames(&engine.bootstrap(true,"boot".into()).unwrap())[0].clone();
    let resume = frames(&line(&mut engine,json!({"id":init["id"],"result":{}}),10.1))[1].clone();
    let effects = line(&mut engine,json!({"id":resume["id"],"result":{"thread":{"id":"thread-1","status":{"type":"idle"}}}}),10.2);
    let read = frames(&effects).into_iter().find(|f|f["method"] == "thread/read").unwrap();
    line(&mut engine,json!({"id":read["id"],"result":{"thread":{"id":"thread-1","status":{"type":"idle"},
        "turns":[{"id":"turn-1","status":"completed"}]}}}),10.3);
    assert!(engine.view()["problema"].is_null());
}

fn diags(effects:&[Effect]) -> Vec<(DiagEvent,String)> {
    effects.iter().filter_map(|e|match e { Effect::Diag { event,code }=>Some((*event,code.clone())),_=>None }).collect()
}

#[test]
fn other_codex_version_warns_once_on_initialize() {
    let mut engine = Engine::new(json!({"name":"session","thread_id":"thread-1","headless":true}),1,clock(10.0));
    let effects = engine.bootstrap(true,"boot".into()).unwrap();
    let id = frames(&effects)[0]["id"].clone();
    let effects = line(&mut engine,json!({"id":id,"result":{"userAgent":"hangar/9.1.0 (x)"}}),11.0);
    assert_eq!(diags(&effects),vec![(DiagEvent::CodexVersion,"codex_9_1".into())]);
    assert_eq!(engine.view()["problema"],"codex_versao_nao_conferida");
    assert!(engine.view()["problema_detalhe"].as_str().unwrap().contains("9.1.0"));
}

#[test]
fn checked_codex_version_is_silent() {
    let mut engine = Engine::new(json!({"name":"session","thread_id":"thread-1","headless":true}),1,clock(10.0));
    let effects = engine.bootstrap(true,"boot".into()).unwrap();
    let id = frames(&effects)[0]["id"].clone();
    let ua = format!("hangar/{} (x)",hangar_codex::version::CHECKED);
    let effects = line(&mut engine,json!({"id":id,"result":{"userAgent":ua}}),11.0);
    assert!(diags(&effects).is_empty());
    assert!(engine.view()["problema"].is_null());
}

#[test]
fn notification_with_wrong_type_is_dropped_and_reported() {
    let mut engine = engine();
    line(&mut engine,json!({"method":"turn/started","params":{"threadId":"thread-1","turn":{"id":"turn-1"}}}),10.0);
    let effects = line(&mut engine,json!({"method":"item/agentMessage/delta","params":{"threadId":"thread-1","turnId":"turn-1","delta":5}}),11.0);
    assert_eq!(diags(&effects),vec![(DiagEvent::CodexDecode,"item_agentmessage_delta".into())]);
    assert!(effects.iter().any(|e|matches!(e,Effect::Policy { kind,.. } if kind == "unknown_private")));
    let effects = line(&mut engine,json!({"method":"turn/completed","params":{"threadId":"thread-1","turn":{"id":"turn-1","status":"completed"}}}),12.0);
    assert!(effects.iter().any(|e|matches!(e,Effect::WakeQueue)));
    assert_eq!(engine.view()["state"],"idle");
}

#[test]
fn repeated_malformed_notification_reports_privately_once() {
    let mut engine = engine();
    line(&mut engine,json!({"method":"turn/started","params":{"threadId":"thread-1","turn":{"id":"turn-1"}}}),10.0);
    let mut effects = line(&mut engine,json!({"method":"item/agentMessage/delta","params":{"threadId":"thread-1","turnId":"turn-1","delta":5}}),11.0);
    effects.extend(line(&mut engine,json!({"method":"item/agentMessage/delta","params":{"threadId":"thread-1","turnId":"turn-1","delta":6}}),11.1));
    assert_eq!(effects.iter().filter(|e|matches!(e,Effect::Policy { kind,.. } if kind == "unknown_private")).count(),1);
    assert_eq!(diags(&effects).len(),2);
}

#[test]
fn malformed_reply_reports_only_its_shape() {
    let mut engine = engine();
    let request = frames(&engine.command(command(OperationKind::ReadSettings,json!({})),clock(10.0)).unwrap())[0].clone();
    let effects = line(&mut engine,json!({"id":request["id"],"result":{"thread":"x","b":1}}),11.0);
    let payload = effects.iter().find_map(|e|match e { Effect::Policy { kind,payload,.. } if kind == "unknown_private" => Some(payload.clone()),_=>None }).unwrap();
    assert_eq!(payload["event"],json!({"method":"thread/read","result_keys":["thread","b"]}));
    let mut engine = self::engine();
    let request = frames(&engine.command(command(OperationKind::ReadSettings,json!({})),clock(12.0)).unwrap())[0].clone();
    let effects = line(&mut engine,json!({"id":request["id"],"result":"texto"}),13.0);
    let payload = effects.iter().find_map(|e|match e { Effect::Policy { kind,payload,.. } if kind == "unknown_private" => Some(payload.clone()),_=>None }).unwrap();
    assert_eq!(payload["event"],json!({"method":"thread/read","result_type":"string"}));
}

#[test]
fn unknown_notification_is_silent() {
    let mut engine = engine();
    let effects = line(&mut engine,json!({"method":"thread/novidade","params":{"threadId":"thread-1"}}),10.0);
    assert!(diags(&effects).is_empty());
    assert!(effects.is_empty());
}

#[test]
fn unknown_server_request_still_gets_method_not_found() {
    let mut engine = engine();
    let effects = line(&mut engine,json!({"id":77,"method":"foo/bar","params":{"threadId":"thread-1"}}),10.0);
    let reply = frames(&effects).into_iter().find(|f|f["id"] == 77).unwrap();
    assert_eq!(reply["error"]["code"],-32601);
    assert!(reply["error"]["message"].as_str().unwrap().contains("foo/bar"));
}

#[test]
fn reply_with_wrong_type_is_reported_and_engine_stays_usable() {
    let mut engine = engine();
    let request = frames(&engine.command(command(OperationKind::ReadSettings,json!({})),clock(10.0)).unwrap())[0].clone();
    assert_eq!(request["method"],"thread/read");
    let effects = line(&mut engine,json!({"id":request["id"],"result":{"thread":"x"}}),11.0);
    assert_eq!(diags(&effects),vec![(DiagEvent::CodexDecode,"thread_read".into())]);
    assert!(effects.iter().any(|e|matches!(e,Effect::Policy { kind,payload,.. } if kind == "unknown_private" && payload["kind"] == "decode:thread/read")));
    assert!(effects.iter().any(|e|matches!(e,Effect::Reply { disposition:Disposition::Accepted,.. })));
    line(&mut engine,json!({"method":"turn/started","params":{"threadId":"thread-1","turn":{"id":"turn-1"}}}),12.0);
    assert_eq!(engine.view()["state"],"working");
}

#[test]
fn undecodable_cut_check_read_is_reported_once() {
    let mut engine = Engine::new(json!({"name":"session","thread_id":"thread-1","headless":true,"in_progress":true}),2,clock(10.0));
    let init = frames(&engine.bootstrap(true,"boot".into()).unwrap())[0].clone();
    let resume = frames(&line(&mut engine,json!({"id":init["id"],"result":{}}),10.1))[1].clone();
    let effects = line(&mut engine,json!({"id":resume["id"],"result":{"thread":{"id":"thread-1","status":{"type":"idle"}}}}),10.2);
    let read = frames(&effects).into_iter().find(|f|f["method"] == "thread/read").unwrap();
    let effects = line(&mut engine,json!({"id":read["id"],"result":{"thread":"x"}}),10.3);
    assert_eq!(effects.iter().filter(|e|matches!(e,Effect::Policy { kind,.. } if kind == "unknown_private")).count(),1);
    assert_eq!(diags(&effects),vec![(DiagEvent::CodexDecode,"thread_read".into())]);
    assert!(engine.view()["problema"].is_null());
}

#[test]
fn undecodable_user_input_request_still_asks_from_the_raw_line() {
    let mut engine = engine();
    let effects = line(&mut engine,json!({"id":5,"method":"item/tool/requestUserInput","params":{"threadId":"thread-1",
        "questions":[{"id":"q1","header":"H","question":"Qual?","isOther":"sim"}]}}),10.0);
    assert_eq!(diags(&effects),vec![(DiagEvent::CodexDecode,"item_tool_requestuserinput".into())]);
    let view = engine.view();
    assert_eq!(view["state"],"awaiting_input");
    assert_eq!(view["codex_question"]["questions"][0]["id"],"q1");
    assert_eq!(view["codex_question"]["questions"][0]["isOther"],false);
    assert_eq!(view["codex_question"]["questions"][0]["options"],json!([]));
    assert!(diags(&line(&mut engine,json!({"method":"thread/novidade","params":{"threadId":"thread-1"}}),10.1)).is_empty());
}

#[test]
fn user_input_request_without_questions_asks_nothing() {
    let mut engine = engine();
    line(&mut engine,json!({"id":6,"method":"item/tool/requestUserInput","params":{"threadId":"thread-1"}}),10.0);
    assert!(engine.view()["codex_question"].is_null());
}

#[test]
fn undecodable_turn_completed_still_closes_the_turn() {
    let mut engine = engine();
    line(&mut engine,json!({"method":"turn/started","params":{"threadId":"thread-1","turn":{"id":"turn-1"}}}),10.0);
    let effects = line(&mut engine,json!({"method":"turn/completed","params":{"threadId":"thread-1","turn":{"id":"turn-1","status":5}}}),11.0);
    assert_eq!(diags(&effects),vec![(DiagEvent::CodexDecode,"turn_completed".into())]);
    assert!(effects.iter().any(|e|matches!(e,Effect::WakeQueue)));
    assert_eq!(engine.view()["state"],"idle");
}

#[test]
fn undecodable_approval_shows_the_raw_command() {
    let mut engine = engine();
    line(&mut engine,json!({"id":3,"method":"item/commandExecution/requestApproval","params":{"threadId":"thread-1",
        "command":"rm -rf build","cwd":"/repo","reason":5}}),10.0);
    assert_eq!(engine.view()["question"],"Rodar `rm -rf build` em /repo?");
}

#[test]
fn unreadable_codex_version_is_reported_without_problem() {
    let mut engine = Engine::new(json!({"name":"session","thread_id":"thread-1","headless":true}),1,clock(10.0));
    let effects = engine.bootstrap(true,"boot".into()).unwrap();
    let id = frames(&effects)[0]["id"].clone();
    let effects = line(&mut engine,json!({"id":id,"result":{"userAgent":"sem versão"}}),11.0);
    assert_eq!(diags(&effects),vec![(DiagEvent::CodexVersion,"codex_desconhecida".into())]);
    assert!(engine.view()["problema"].is_null());
}

#[test]
fn undecodable_turn_completed_keeps_the_retry_problem() {
    let mut engine = engine();
    line(&mut engine,json!({"method":"turn/started","params":{"threadId":"thread-1","turn":{"id":"turn-1"}}}),10.0);
    line(&mut engine,json!({"method":"error","params":{"threadId":"thread-1","turnId":"turn-1","willRetry":true,
        "error":{"message":"stream disconnected"}}}),10.5);
    assert_eq!(engine.view()["problema"],"codex_sem_conexao");
    let effects = line(&mut engine,json!({"method":"turn/completed","params":{"threadId":"thread-1","turn":{"id":"turn-1","status":5}}}),11.0);
    assert!(effects.iter().any(|e|matches!(e,Effect::WakeQueue)));
    assert_eq!(engine.view()["state"],"idle");
    assert_eq!(engine.view()["problema"],"codex_sem_conexao");
}

#[test]
fn undecodable_turn_completed_of_another_turn_is_ignored() {
    let mut engine = engine();
    line(&mut engine,json!({"method":"turn/started","params":{"threadId":"thread-1","turn":{"id":"turn-2"}}}),10.0);
    line(&mut engine,json!({"method":"turn/completed","params":{"threadId":"thread-1","turn":{"id":"turn-1","status":5}}}),11.0);
    assert_eq!(engine.view()["state"],"working");
}

#[test]
fn unreadable_command_approval_offers_no_session_wide_grant() {
    let mut engine = engine();
    let store = identified(&mut engine);
    line(&mut engine,json!({"id":4,"method":"item/commandExecution/requestApproval","params":{"threadId":"thread-1",
        "command":["rm","-rf","build"],"cwd":"/repo"}}),10.0);
    let view = engine.view();
    assert_eq!(view["question"],"Rodar um comando que o Hangar não conseguiu ler em /repo?");
    assert_eq!(view["options"],json!(["Permitir","Negar"]));
    assert!(select(&mut engine,&store,json!(4),3,10.1).is_err());
    let answer = frames(&select(&mut engine,&store,json!(4),2,10.2).unwrap());
    assert_eq!(answer[0]["result"]["decision"],"decline");
}

fn bootstrapped(meta:Value) -> (Engine,Vec<Value>) {
    let mut engine = Engine::new(meta,1,clock(10.0));
    engine.set_fresh_process(true);
    let effects = engine.bootstrap(true,"boot".into()).unwrap();
    let id = frames(&effects)[0]["id"].clone();
    let effects = line(&mut engine,json!({"id":id,"result":{"userAgent":format!("hangar/{} (x)",hangar_codex::version::CHECKED)}}),11.0);
    (engine,frames(&effects))
}

fn find_method(sent:&[Value],method:&str) -> Value { sent.iter().find(|f|f["method"] == method).unwrap().clone() }

#[test]
fn resume_carries_cwd_policy_sandbox_and_tier_like_python() {
    let (_,sent) = bootstrapped(json!({"name":"s","thread_id":"t1","headless":true,"cwd":"/p",
        "permission_mode":"Ask for approval","service_tier":"priority"}));
    assert_eq!(find_method(&sent,"thread/resume")["params"],
        json!({"threadId":"t1","cwd":"/p","approvalPolicy":"on-request","sandbox":"read-only","serviceTier":"priority"}));
}

#[test]
fn permission_mode_matches_case_insensitively_like_python() {
    let (_,sent) = bootstrapped(json!({"name":"s","thread_id":"t1","headless":true,"cwd":"/p","permission_mode":" ask for approval "}));
    let params = find_method(&sent,"thread/resume")["params"].clone();
    assert_eq!((params["sandbox"].clone(),params["approvalPolicy"].clone()),(json!("read-only"),json!("on-request")));
}

#[test]
fn terminal_permission_mode_is_unknown_never_full_access() {
    // Sem modo no sidecar (terminal comum) e com o da abertura (import): a TUI pode ter mudado depois.
    for metadata in [json!({"name":"s","thread_id":"t1","headless":false,"cwd":"/p"}),
                     json!({"name":"s","thread_id":"t1","headless":false,"cwd":"/p","permission_mode":"Full Access"})] {
        let engine = Engine::new(metadata,1,clock(10.0));
        assert!(engine.control_view()["permission_mode"].is_null(),"{}",engine.control_view()["permission_mode"]);
    }
    let headless = Engine::new(json!({"name":"s","thread_id":"t1","headless":true,"cwd":"/p"}),1,clock(10.0));
    assert_eq!(headless.control_view()["permission_mode"],"Full Access","sem terminal segue o padrão de hoje");
}

#[test]
fn missing_model_provider_retries_resume_with_openai() {
    let (mut engine,sent) = bootstrapped(json!({"name":"s","thread_id":"t1","headless":true,"cwd":"/p"}));
    let resume = find_method(&sent,"thread/resume");
    let effects = line(&mut engine,json!({"id":resume["id"],"error":{"code":-32600,"message":"Model provider `x` not found"}}),12.0);
    let retry = find_method(&frames(&effects),"thread/resume");
    assert_eq!(retry["params"]["modelProvider"],"openai");
    // Segunda recusa igual não repete: vira erro da subida.
    let effects = line(&mut engine,json!({"id":retry["id"],"error":{"code":-32600,"message":"Model provider `x` not found"}}),13.0);
    assert!(frames(&effects).is_empty());
    assert!(effects.iter().any(|e|matches!(e,Effect::Reply { operation_id,disposition:Disposition::Rejected,.. } if operation_id == "boot")));
    assert_eq!(engine.view()["problema"],"codex_conversa_nao_abriu");
}

#[test]
fn provider_retry_and_start_fallback_skip_transfers() {
    let (mut engine,sent) = bootstrapped(json!({"name":"s","thread_id":"t1","headless":true,"transfer_id":"tr"}));
    let resume = find_method(&sent,"thread/resume");
    let effects = line(&mut engine,json!({"id":resume["id"],"error":{"code":-32600,"message":"no rollout found for thread id t1"}}),12.0);
    assert!(frames(&effects).is_empty());
}

#[test]
fn no_rollout_falls_back_to_thread_start() {
    let (mut engine,sent) = bootstrapped(json!({"name":"s","thread_id":"t1","headless":true,"cwd":"/p","model":"gpt-6"}));
    let resume = find_method(&sent,"thread/resume");
    let effects = line(&mut engine,json!({"id":resume["id"],"error":{"code":-32600,"message":"no rollout found for thread id t1"}}),12.0);
    assert!(frames(&effects).iter().any(|f|f["method"] == "thread/start" && f["params"]["model"] == "gpt-6"));
}

#[test]
fn headless_unproven_open_result_is_refused_and_does_not_wake_queue() {
    // `resume` precisa devolver a conversa pedida; `start`, uma conversa com id.
    let cases = [
        (json!({"name":"s","thread_id":"t1","headless":true,"cwd":"/p"}),"thread/resume",json!({})),
        (json!({"name":"s","thread_id":"t1","headless":true,"cwd":"/p"}),"thread/resume",json!("t1")),
        (json!({"name":"s","thread_id":"t1","headless":true,"cwd":"/p"}),"thread/resume",json!({"thread":{"id":"t2","path":"/r/two.jsonl"}})),
        (json!({"name":"s","headless":true,"cwd":"/p"}),"thread/start",json!({})),
        (json!({"name":"s","headless":true,"cwd":"/p"}),"thread/start",json!("t2")),
        (json!({"name":"s","headless":true,"cwd":"/p"}),"thread/start",json!({"thread":{"id":"","path":"/r/two.jsonl"}})),
    ];
    for (meta,method,result) in cases {
        let (mut engine,sent) = bootstrapped(meta);
        let open = find_method(&sent,method);
        let effects = line(&mut engine,json!({"id":open["id"],"result":result}),12.0);
        assert!(effects.iter().any(|e|matches!(e,Effect::Reply { operation_id,disposition:Disposition::Rejected,.. } if operation_id == "boot")),"{method} {result}");
        assert!(!effects.iter().any(|e|matches!(e,Effect::Reply { disposition:Disposition::Accepted,.. })),"{method} {result}");
        assert!(!effects.iter().any(|e|matches!(e,Effect::WakeQueue)),"{method} {result}");
        assert_eq!(patches(&effects),0,"{method} {result}");
        assert_eq!(engine.control_view()["ready"],false,"{method} {result}");
        assert_eq!(engine.view()["problema"],"codex_conversa_nao_abriu","{method} {result}");
    }
    for (meta,method,id) in [(json!({"name":"s","thread_id":"t1","headless":true,"cwd":"/p"}),"thread/resume","t1"),
        (json!({"name":"s","headless":true,"cwd":"/p"}),"thread/start","t2")] {
        let (mut engine,sent) = bootstrapped(meta);
        let open = find_method(&sent,method);
        let effects = line(&mut engine,json!({"id":open["id"],"result":{"thread":{"id":id,"path":"/r/x.jsonl","status":{"type":"idle"},"turns":[]}}}),12.0);
        assert!(effects.iter().any(|e|matches!(e,Effect::Reply { operation_id,disposition:Disposition::Accepted,.. } if operation_id == "boot")),"{method}");
        assert!(effects.iter().any(|e|matches!(e,Effect::WakeQueue)),"{method}");
        assert_eq!(engine.control_view()["ready"],true,"{method}");
        assert_eq!(engine.control_view()["thread_id"],id,"{method}");
    }
}

#[test]
fn refused_effort_is_a_problem_not_a_failure() {
    let (mut engine,sent) = bootstrapped(json!({"name":"s","thread_id":"t1","headless":true,"cwd":"/p","effort":"max"}));
    let resume = find_method(&sent,"thread/resume");
    let effects = line(&mut engine,json!({"id":resume["id"],"result":{"thread":{"id":"t1","status":{"type":"idle"},"turns":[]},"model":"gpt-6"}}),12.0);
    let update = find_method(&frames(&effects),"thread/settings/update");
    let effects = line(&mut engine,json!({"id":update["id"],"error":{"code":-32600,"message":"effort max not supported"}}),13.0);
    assert_eq!(engine.view()["problema"],"codex_esforco_nao_aplicado");
    assert_eq!(engine.control_view()["ready"],true);
    assert!(effects.iter().any(|e|matches!(e,Effect::WakeQueue)));
}

#[test]
fn select_without_pending_approval_says_no_pending_permission() {
    // Sem pedido aberto não há identidade atual: a mostrada antes da resolução fica desatualizada.
    let mut engine = engine();
    let store = identified(&mut engine);
    request(&mut engine,1,"item/commandExecution/requestApproval",json!({"threadId":"thread-1","command":"pwd"}));
    let token = request_token(&engine,&store,InteractionKind::Approval,json!(1));
    line(&mut engine,json!({"method":"serverRequest/resolved","params":{"threadId":"thread-1","requestId":1}}),10.5);
    let Err(error) = engine.command(command(OperationKind::Select,json!({"option":1,"interaction_id":token})),clock(11.0)) else { panic!("devia recusar") };
    assert_eq!(error.code,"erro_interacao_desatualizada");
}

fn live_attach(meta:Value) -> (Engine,Value) {
    let mut engine = Engine::new(meta,1,clock(10.0));
    let id = frames(&engine.bootstrap(true,"boot".into()).unwrap())[0]["id"].clone();
    let sent = frames(&line(&mut engine,json!({"id":id,"result":{}}),11.0));
    let resume = find_method(&sent,"thread/resume");
    (engine,resume)
}

#[test]
fn live_attach_to_thread_without_rollout_is_ready_on_the_same_thread() {
    let (mut engine,resume) = live_attach(json!({"name":"s","thread_id":"t1","headless":true,"cwd":"/p","service_tier":"priority"}));
    assert_eq!(resume["params"],json!({"threadId":"t1"}));
    let effects = line(&mut engine,json!({"id":resume["id"],"error":{"code":-32600,"message":"no rollout found for thread id t1"}}),12.0);
    assert!(frames(&effects).iter().all(|f|f["method"] != "thread/start"));
    assert!(effects.iter().any(|e|matches!(e,Effect::Reply { operation_id,disposition:Disposition::Accepted,.. } if operation_id == "boot")));
    assert!(effects.iter().any(|e|matches!(e,Effect::WakeQueue)));
    assert_eq!(engine.control_view()["ready"],true);
    assert!(engine.view()["problema"].is_null());
    let effects = engine.command(command(OperationKind::Input,json!({"text":"Olá"})),clock(13.0)).unwrap();
    assert_eq!(find_method(&frames(&effects),"turn/start")["params"]["threadId"],"t1");
}

#[test]
fn live_attach_refusal_is_a_visible_problem_and_effort_refusal_stays_a_failure() {
    let (mut engine,resume) = live_attach(json!({"name":"s","thread_id":"t1","headless":true,"cwd":"/p"}));
    let effects = line(&mut engine,json!({"id":resume["id"],"error":{"code":-32600,"message":"thread t1 not loaded"}}),12.0);
    assert!(frames(&effects).is_empty());
    assert!(effects.iter().any(|e|matches!(e,Effect::Reply { operation_id,disposition:Disposition::Rejected,.. } if operation_id == "boot")));
    assert_eq!(engine.view()["problema"],"codex_conversa_nao_abriu");
    assert!(engine.view()["problema_detalhe"].as_str().unwrap().contains("not loaded"));
    assert!(effects.iter().any(|e|matches!(e,Effect::Diag { event:DiagEvent::CodexBootstrap,code } if code == "thread/resume")));
}

#[test]
fn initialize_refusal_is_a_visible_problem() {
    let mut engine = Engine::new(json!({"name":"s","thread_id":"t1","headless":true}),1,clock(10.0));
    let id = frames(&engine.bootstrap(true,"boot".into()).unwrap())[0]["id"].clone();
    let effects = line(&mut engine,json!({"id":id,"error":{"code":-32600,"message":"bad client"}}),11.0);
    assert!(effects.iter().any(|e|matches!(e,Effect::Reply { operation_id,disposition:Disposition::Rejected,.. } if operation_id == "boot")));
    assert_eq!(engine.view()["problema"],"codex_conversa_nao_abriu");
}

/// A vida anterior aplicou o esforço; religar no cano vivo não o reenvia (como o Python), nem com nem sem rollout.
#[test]
fn live_attach_does_not_resend_effort() {
    let (mut engine,resume) = live_attach(json!({"name":"s","thread_id":"t1","headless":true,"cwd":"/p","effort":"max","async_during_load":[]}));
    let effects = line(&mut engine,json!({"id":resume["id"],"error":{"code":-32600,"message":"no rollout found for thread id t1"}}),12.0);
    assert!(frames(&effects).iter().all(|f|f["method"] != "thread/settings/update"));
    assert_eq!(engine.control_view()["ready"],true);
    assert!(engine.control_view()["async_during_load"].is_null());

    let (mut engine,resume) = live_attach(json!({"name":"s","thread_id":"t1","headless":true,"cwd":"/p","effort":"max"}));
    let effects = line(&mut engine,json!({"id":resume["id"],"result":{"thread":{"id":"t1","status":{"type":"idle"},"turns":[]},"model":"gpt-6"}}),12.0);
    assert!(frames(&effects).iter().all(|f|f["method"] != "thread/settings/update"));
    assert_eq!(engine.control_view()["ready"],true);
}

/// O Python recusa Fast sozinho enquanto o arquivo ainda tem a thread anterior: vai no patch da thread.
#[test]
fn new_thread_saves_fast_with_the_thread_in_one_patch() {
    let mut engine = Engine::new(json!({"name":"s","headless":true,"cwd":"/p"}),1,clock(10.0));
    engine.set_fresh_process(true);
    let id = frames(&engine.bootstrap(true,"boot".into()).unwrap())[0]["id"].clone();
    let start = find_method(&frames(&line(&mut engine,json!({"id":id,"result":{}}),11.0)),"thread/start");
    let effects = line(&mut engine,json!({"id":start["id"],"result":{"thread":{"id":"t2","path":"/r.jsonl","status":{"type":"idle"},"turns":[]},
        "model":"gpt-6","serviceTier":null}}),12.0);
    let patches:Vec<Value> = effects.iter().filter_map(|e|match e { Effect::Policy { kind,payload,.. } if kind == "session.patch_meta" => Some(payload.clone()),_=>None }).collect();
    assert_eq!(patches,vec![json!({"thread_id":"t2","rollout_path":"/r.jsonl","service_tier":"default"})]);
}

fn request(engine:&mut Engine,id:i64,method:&str,params:Value) -> Vec<Effect> {
    line(engine,json!({"id":id,"method":method,"params":params}),10.0)
}
fn reply_to(effects:&[Effect],id:i64) -> Value { frames(effects).into_iter().find(|f|f["id"] == id && f.get("method").is_none()).unwrap() }

#[test]
fn permissions_request_is_a_card_and_answers_with_scope() {
    let mut engine = engine();
    let store = identified(&mut engine);
    request(&mut engine,5,"item/permissions/requestApproval",json!({"threadId":"thread-1","cwd":"/p","reason":"ler config",
        "permissions":{"fileSystem":{"read":["/etc/x"],"write":["/p/out"]},"network":{"enabled":true}}}));
    let view = engine.view();
    assert_eq!(view["state"],"awaiting_input");
    assert_eq!(view["options"],json!(["Permitir neste turno","Permitir na sessão","Negar"]));
    let text = view["question"].as_str().unwrap();
    assert!(text.contains("/etc/x") && text.contains("/p/out") && text.contains("rede"));
    let effects = select(&mut engine,&store,json!(5),2,11.0).unwrap();
    let answer = reply_to(&effects,5);
    assert_eq!(answer["result"]["scope"],"session");
    assert_eq!(answer["result"]["permissions"]["fileSystem"]["read"],json!(["/etc/x"]));
}

#[test]
fn denied_permissions_grant_nothing() {
    let mut engine = engine();
    let store = identified(&mut engine);
    request(&mut engine,5,"item/permissions/requestApproval",json!({"threadId":"thread-1","permissions":{"network":{"enabled":true}}}));
    let effects = select(&mut engine,&store,json!(5),3,11.0).unwrap();
    assert_eq!(reply_to(&effects,5)["result"],json!({"permissions":{},"scope":"turn"}));
}

#[test]
fn elicitation_form_becomes_a_native_question() {
    let mut engine = engine();
    let store = identified(&mut engine);
    request(&mut engine,6,"mcpServer/elicitation/request",json!({"threadId":"thread-1","serverName":"db","mode":"form","message":"Qual ambiente?",
        "requestedSchema":{"type":"object","properties":{"env":{"type":"string","enum":["dev","prod"],"title":"Ambiente"},"note":{"type":"string","title":"Nota"}},"required":["env"]}}));
    let view = engine.view();
    let question = &view["codex_question"];
    assert_eq!(question["request_id"],6);
    assert_eq!(question["questions"][0]["options"],json!([{"label":"dev","description":""},{"label":"prod","description":""}]));
    assert_eq!(question["questions"][1]["options"],json!([]));
    let effects = answer_form(&mut engine,&store,6,json!([
        {"question_id":"env","kind":"option","indices":[1]},{"question_id":"note","kind":"text","value":"urgente"}]),11.0).unwrap();
    assert_eq!(reply_to(&effects,6)["result"],json!({"action":"accept","content":{"env":"prod","note":"urgente"}}));
}

#[test]
fn elicitation_converts_number_and_boolean_answers() {
    let mut engine = engine();
    let store = identified(&mut engine);
    request(&mut engine,6,"mcpServer/elicitation/request",json!({"threadId":"thread-1","serverName":"db","mode":"form","message":"x",
        "requestedSchema":{"type":"object","properties":{"n":{"type":"integer"},"ok":{"type":"boolean"}}}}));
    assert_eq!(engine.view()["codex_question"]["questions"][1]["options"][0]["label"],"sim");
    let effects = answer_form(&mut engine,&store,6,json!([
        {"question_id":"n","kind":"text","value":"42"},{"question_id":"ok","kind":"option","indices":[1]}]),11.0).unwrap();
    assert_eq!(reply_to(&effects,6)["result"]["content"],json!({"n":42,"ok":false}));
}

#[test]
fn skipping_an_elicitation_form_cancels_it() {
    use hangar_server::interactions::{InteractionStore,InteractionBinding,InteractionKind,native_target};
    let mut engine = engine();
    let store = std::sync::Arc::new(InteractionStore::default());
    engine.set_interactions("key".into(),store.clone()).unwrap();
    let request = json!({"id":6,"method":"mcpServer/elicitation/request","params":{"threadId":"thread-1","serverName":"db","mode":"form","message":"x",
        "requestedSchema":{"type":"object","properties":{"n":{"type":"string"}}}}});
    line(&mut engine,request.clone(),10.0);
    let binding = InteractionBinding { key:"key".into(),conversation:"thread-1".into(),generation:1 };
    let token = store.observe_revision(&binding,&native_target(InteractionKind::Question,"thread-1",&json!(6)),Some(request),engine.request_revision(&RequestId::Integer(6))).unwrap().unwrap();
    let effects = engine.command(command(OperationKind::SkipQuestion,json!({"request_id":6,"interaction_id":token})),clock(11.0)).unwrap();
    assert_eq!(reply_to(&effects,6)["result"],json!({"action":"cancel"}));
}

#[test]
fn elicitation_schema_that_does_not_fit_is_declined_with_a_note() {
    let mut engine = engine();
    let effects = request(&mut engine,7,"mcpServer/elicitation/request",json!({"threadId":"thread-1","serverName":"db","mode":"form","message":"x",
        "requestedSchema":{"type":"object","properties":{"deep":{"type":"object"}}}}));
    assert_eq!(reply_to(&effects,7)["result"]["action"],"decline");
    assert!(effects.iter().any(|e|matches!(e,Effect::Policy { kind,.. } if kind == "local_output")));
}

#[test]
fn elicitation_url_is_a_link_card() {
    let mut engine = engine();
    let store = identified(&mut engine);
    request(&mut engine,8,"mcpServer/elicitation/request",json!({"threadId":"thread-1","serverName":"gh","mode":"url","message":"Autorize","url":"https://example.com/auth","elicitationId":"e1"}));
    let view = engine.view();
    assert!(view["question"].as_str().unwrap().contains("https://example.com/auth"));
    assert_eq!(view["options"],json!(["Concluí","Cancelar"]));
    let effects = select(&mut engine,&store,json!(8),2,11.0).unwrap();
    assert_eq!(reply_to(&effects,8)["result"],json!({"action":"cancel"}));
}

#[test]
fn current_time_is_answered() {
    let mut engine = engine();
    let effects = request(&mut engine,9,"currentTime/read",json!({"threadId":"thread-1"}));
    // O schema 0.161 chama o campo `currentTimeAt` (segundos Unix inteiros).
    assert_eq!(reply_to(&effects,9)["result"]["currentTimeAt"],1_800_000_010);
}

#[test]
fn request_from_a_subagent_thread_is_not_dropped() {
    let mut engine = engine();
    let store = identified(&mut engine);
    request(&mut engine,10,"item/commandExecution/requestApproval",json!({"threadId":"subagent-thread","command":"ls"}));
    assert_eq!(engine.view()["state"],"awaiting_input");
    let effects = select(&mut engine,&store,json!(10),1,11.0).unwrap();
    assert_eq!(reply_to(&effects,10)["result"]["decision"],"accept");
}

#[test]
fn blank_command_approval_is_unreadable() {
    let mut engine = engine();
    request(&mut engine,11,"item/commandExecution/requestApproval",json!({"threadId":"thread-1","command":"   ","cwd":"/repo"}));
    let view = engine.view();
    assert_eq!(view["question"],"Rodar um comando que o Hangar não conseguiu ler em /repo?");
    assert_eq!(view["options"],json!(["Permitir","Negar"]));
}

#[test]
fn undecodable_failed_turn_completed_marks_the_turn_error() {
    let mut engine = engine();
    line(&mut engine,json!({"method":"turn/started","params":{"threadId":"thread-1","turn":{"id":"turn-1"}}}),10.0);
    line(&mut engine,json!({"method":"turn/completed","params":{"threadId":"thread-1","turn":{"id":"turn-1","status":"failed","error":"boom"}}}),11.0);
    let view = engine.view();
    assert_eq!(view["state"],"idle");
    assert_eq!(view["problema"],"headless_turno_erro");
    assert!(view["problema_detalhe"].is_null());
}

#[test]
fn mode_change_is_written_to_the_session_file() {
    let mut engine = engine();
    let read = frames(&engine.command(command(OperationKind::SetMode,json!({"mode":"plan"})),clock(10.0)).unwrap())[0].clone();
    let update = frames(&line(&mut engine,json!({"id":read["id"],"result":{"thread":{"id":"thread-1","status":{"type":"idle"},"turns":[]}}}),10.1))[0].clone();
    let effects = line(&mut engine,json!({"id":update["id"],"result":{}}),10.2);
    let patch = effects.iter().find_map(|e|match e { Effect::Policy { kind,payload,.. } if kind == "session.patch_meta" => Some(payload.clone()),_=>None }).unwrap();
    assert_eq!(patch["mode"],"plan");
    let reply = effects.iter().find_map(|e|match e { Effect::Reply { operation_id,payload,.. } if operation_id == "op-1" => Some(payload.clone()),_=>None }).unwrap();
    assert_eq!(reply["mode"],"plan");
    // Trocar só o modelo não mexe no modo gravado.
    let model = frames(&engine.command(RuntimeCommand { operation_id:"op-2".into(),kind:OperationKind::SetModel,payload:json!({"model":"gpt-6"}) },clock(11.0)).unwrap())[0].clone();
    let effects = line(&mut engine,json!({"id":model["id"],"result":{}}),11.1);
    let patch = effects.iter().find_map(|e|match e { Effect::Policy { kind,payload,.. } if kind == "session.patch_meta" => Some(payload.clone()),_=>None }).unwrap();
    assert!(patch.get("mode").is_none());
}

#[test]
fn stop_whose_turn_read_fails_still_answers() {
    // Sem turno conhecido o Stop lê a conversa antes; a leitura recusada responde a operação de cima.
    let mut engine = engine();
    let read = frames(&engine.command(command(OperationKind::Interrupt,json!({})),clock(11.0)).unwrap())[0].clone();
    assert_eq!(read["method"],"thread/read");
    let effects = line(&mut engine,json!({"id":read["id"],"error":{"code":-32603,"message":"boom"}}),11.1);
    assert!(effects.iter().any(|e|matches!(e,Effect::Reply { operation_id,disposition:Disposition::Rejected,.. } if operation_id == "op-1")));
}

// ── Codex com terminal: pedidos, resolução e respostas reservadas ─────────────────────────────

/// Terminal conectado e assinado na `thread-1`, sem turno.
fn subscribed_terminal() -> Engine {
    let mut engine = terminal();
    let resume = resume_of(&connect(&mut engine));
    line(&mut engine,json!({"id":resume["id"],"result":{"thread":{"id":"thread-1","path":"/r/one.jsonl","status":{"type":"idle"},"turns":[]}}}),12.0);
    assert_eq!(engine.control_view()["subscribed"],true);
    engine
}
fn reply_of(effects:&[Effect],id:&str) -> Option<(Disposition,Value)> {
    effects.iter().find_map(|e|match e { Effect::Reply { operation_id,disposition,payload } if operation_id == id => Some((*disposition,payload.clone())),_=>None })
}
fn reservation_of(effects:&[Effect]) -> Option<ReservedAsyncAnswer> {
    effects.iter().find_map(|e|match e { Effect::ReserveAsyncAnswer { reservation,.. } => Some(reservation.clone()),_=>None })
}
fn pending_ids(engine:&Engine) -> Vec<Value> {
    engine.control_view()["pending"].as_array().unwrap().iter().map(|p|p["request_id"].clone()).collect()
}
fn async_ids(engine:&Engine) -> Vec<Value> {
    engine.control_view()["async_questions"].as_array().unwrap().iter().map(|pair|pair[0].clone()).collect()
}
fn ack(engine:&mut Engine,id:&str,outcome:WriteOutcome,time:f64) -> Vec<Effect> {
    engine.apply(EngineInput::WriteAck { operation_id:id.into(),outcome },clock(time)).unwrap()
}
fn local_notice(effects:&[Effect]) -> bool { effects.iter().any(|e|matches!(e,Effect::Policy { kind,.. } if kind == "local_output")) }
fn ask_async(engine:&mut Engine,item:&str,title:&str,time:f64) -> String {
    line(engine,json!({"method":"item/completed","params":{"threadId":"thread-1","item":{
        "id":item,"type":"agentMessage","delivery":"async","questions":[{"title":title,"options":["A","B"]}]}}}),time);
    format!("async:thread-1:{item}:0")
}
fn answer_async(engine:&mut Engine,store:&InteractionStore,request:&str,operation:&str,time:f64) -> Result<Vec<Effect>,RuntimeError> {
    let token = async_token(engine,store,request);
    engine.command(RuntimeCommand { operation_id:operation.into(),kind:OperationKind::AnswerQuestions,
        payload:json!({"request_id":request,"interaction_id":token,"answers":[{"question_id":"answer","kind":"option","indices":[0]}]}) },clock(time))
}
/// O comando que o ator devolve ao reivindicar a entrada reservada.
fn dispatch(engine:&mut Engine,reservation:&ReservedAsyncAnswer,time:f64) -> Vec<Effect> {
    engine.command(Engine::async_answer_command(reservation,"thread-1",1),clock(time)).unwrap()
}
/// Pergunta assíncrona respondida e reserva gravada na fila.
fn reserved(engine:&mut Engine,store:&InteractionStore,request:&str,operation:&str,time:f64) -> ReservedAsyncAnswer {
    let reservation = reservation_of(&answer_async(engine,store,request,operation,time).unwrap()).unwrap();
    assert!(matches!(engine.settle_async_answer(&reservation.entry_id,true).as_slice(),[Effect::WakeQueue]));
    reservation
}

#[test]
fn conversation_terminal_requests_the_tui_handles_are_not_auto_refused() {
    let mut engine = subscribed_terminal();
    for (id,request) in [
        (json!("future"),json!({"id":"future","method":"future/request","params":{"threadId":"thread-1"}})),
        (json!(9),json!({"id":9,"method":"currentTime/read","params":{"threadId":"thread-1"}})),
        (json!(7),json!({"id":7,"method":"mcpServer/elicitation/request","params":{"threadId":"thread-1","serverName":"db","mode":"form",
            "message":"x","requestedSchema":{"type":"object","properties":{"deep":{"type":"object"}}}}})),
    ] {
        let effects = line(&mut engine,request,13.0);
        assert!(frames(&effects).is_empty(),"{id} não pode ser respondido nem recusado pelo Hangar");
        assert!(!local_notice(&effects));
        assert!(!effects.iter().any(|e|matches!(e,Effect::Policy { kind,.. } if kind == "unknown_private")),"o pedido cru não sai daqui");
    }
    assert_eq!(pending_ids(&engine),vec![json!("future"),json!(9),json!(7)]);
    assert_eq!(engine.control_view()["deliverable"],false);
    // Fila segura pelo pedido da TUI: a sessão não aparece ociosa.
    assert_eq!(engine.view()["state"],"awaiting_input");
    // A TUI resolve: sai sem aviso de recusa.
    let resolved = line(&mut engine,json!({"method":"serverRequest/resolved","params":{"threadId":"thread-1","requestId":"future"}}),14.0);
    assert!(!local_notice(&resolved));
    assert_eq!(pending_ids(&engine),vec![json!(9),json!(7)]);
}

#[test]
fn conversation_terminal_written_answer_is_not_a_decision_until_resolved() {
    let mut engine = subscribed_terminal();
    let store = identified(&mut engine);
    request(&mut engine,7,"item/commandExecution/requestApproval",json!({"threadId":"thread-1","command":"pwd"}));
    let sent = select(&mut engine,&store,json!(7),1,13.0).unwrap();
    assert_eq!(reply_to(&sent,7)["result"]["decision"],"accept");
    let acked = ack(&mut engine,"op-1",WriteOutcome::Written,14.0);
    assert_eq!(reply_of(&acked,"op-1"),Some((Disposition::Unknown,json!({"write_outcome":"written","decision_confirmed":false}))));
    // Escrever não aplica a decisão: o pedido segue até a resolução, e repetir não gera outro quadro.
    assert_eq!(pending_ids(&engine),vec![json!(7)]);
    assert!(select(&mut engine,&store,json!(7),1,14.5).is_err());
    let resolved = line(&mut engine,json!({"method":"serverRequest/resolved","params":{"threadId":"thread-1","requestId":7}}),15.0);
    assert!(pending_ids(&engine).is_empty());
    assert!(reply_of(&resolved,"op-1").is_none() && !local_notice(&resolved),"a resolução não atribui autor nem decisão");
}

#[test]
fn conversation_terminal_tui_resolving_before_the_app_ack_stays_uncertain() {
    let mut engine = subscribed_terminal();
    let store = identified(&mut engine);
    request(&mut engine,7,"item/fileChange/requestApproval",json!({"threadId":"thread-1","grantRoot":"/work"}));
    select(&mut engine,&store,json!(7),1,13.0).unwrap();
    line(&mut engine,json!({"method":"serverRequest/resolved","params":{"threadId":"thread-1","requestId":7}}),13.5);
    assert!(pending_ids(&engine).is_empty());
    let acked = ack(&mut engine,"op-1",WriteOutcome::Written,14.0);
    assert_eq!(reply_of(&acked,"op-1"),Some((Disposition::Unknown,json!({"write_outcome":"written","decision_confirmed":false}))));
}

#[test]
fn conversation_terminal_unknown_answer_write_is_never_resent() {
    let mut engine = subscribed_terminal();
    let store = identified(&mut engine);
    request(&mut engine,7,"item/commandExecution/requestApproval",json!({"threadId":"thread-1","command":"pwd"}));
    select(&mut engine,&store,json!(7),2,13.0).unwrap();
    let acked = ack(&mut engine,"op-1",WriteOutcome::Unknown,14.0);
    assert_eq!(reply_of(&acked,"op-1"),Some((Disposition::Unknown,json!({"write_outcome":"unknown","decision_confirmed":false}))));
    assert!(select(&mut engine,&store,json!(7),2,15.0).is_err());
    // Não escrito volta a aceitar a resposta, com a recusa de não-escrita.
    let mut engine = subscribed_terminal();
    let store = identified(&mut engine);
    request(&mut engine,8,"item/commandExecution/requestApproval",json!({"threadId":"thread-1","command":"pwd"}));
    select(&mut engine,&store,json!(8),1,13.0).unwrap();
    let acked = ack(&mut engine,"op-1",WriteOutcome::NotWritten,14.0);
    assert_eq!(reply_of(&acked,"op-1").map(|(d,_)|d),Some(Disposition::Rejected));
    assert!(select(&mut engine,&store,json!(8),1,15.0).is_ok());
}

#[test]
fn conversation_terminal_subagent_request_targets_its_own_thread_under_the_main_binding() {
    let mut engine = subscribed_terminal();
    let store = identified(&mut engine);
    request(&mut engine,8,"item/commandExecution/requestApproval",json!({"threadId":"child","command":"ls"}));
    // Identidade com o alvo na thread principal não serve para o pedido do subagente.
    let request = engine.control_view()["pending"][0]["request"].clone();
    let wrong = store.observe_revision(&shown_binding(&engine),&native_target(InteractionKind::Approval,"thread-1",&json!(8)),
        Some(request),engine.request_revision(&RequestId::Integer(8))).unwrap().unwrap();
    assert!(engine.command(command(OperationKind::Select,json!({"option":1,"interaction_id":wrong})),clock(13.0)).is_err());
    let effects = select(&mut engine,&store,json!(8),1,13.5).unwrap();
    assert_eq!(reply_to(&effects,8)["result"]["decision"],"accept");
}

#[test]
fn conversation_terminal_steer_and_interrupt_go_through_the_app_server() {
    let mut engine = subscribed_terminal();
    let start = frames(&engine.command(command(OperationKind::Input,json!({"text":"Olá"})),clock(13.0)).unwrap())[0].clone();
    line(&mut engine,json!({"id":start["id"],"result":{"turn":{"id":"turn-1"}}}),13.5);
    let steer = frames(&engine.command(RuntimeCommand { operation_id:"steer".into(),kind:OperationKind::Steer,payload:json!({"text":"mais curto"}) },clock(14.0)).unwrap())[0].clone();
    assert_eq!(steer["method"],"turn/steer");
    assert_eq!(steer["params"]["threadId"],"thread-1");
    assert_eq!(steer["params"]["expectedTurnId"],"turn-1");
    let stop = frames(&engine.command(RuntimeCommand { operation_id:"stop".into(),kind:OperationKind::Interrupt,payload:json!({}) },clock(15.0)).unwrap())[0].clone();
    assert_eq!(stop["method"],"turn/interrupt");
    assert_eq!(stop["params"],json!({"threadId":"thread-1","turnId":"turn-1"}));
}

#[test]
fn conversation_terminal_async_answer_is_reserved_not_sent() {
    let mut engine = subscribed_terminal();
    let store = identified(&mut engine);
    let question = ask_async(&mut engine,"q1","Qual pasta?",13.0);
    let effects = answer_async(&mut engine,&store,&question,"answer-1",13.5).unwrap();
    assert!(frames(&effects).is_empty(),"aceitar a resposta não escreve no fio");
    let reservation = reservation_of(&effects).unwrap();
    assert_eq!(reservation.request_id,question);
    assert_eq!(reservation.text,"> Qual pasta?\n\nA");
    assert_eq!(reservation.entry_id,reservation.operation_id);
    assert!(effects.iter().any(|e|matches!(e,Effect::ReserveAsyncAnswer { operation_id,.. } if operation_id == "answer-1")));
    assert!(reply_of(&effects,"answer-1").is_none(),"quem respondeu espera a gravação na fila");
    // Ainda gravando: nada sai e a repetição espera a mesma operação.
    assert_eq!(engine.ready_async_answer_entry(),None);
    assert!(answer_async(&mut engine,&store,&question,"answer-2",13.6).is_err());
    assert!(matches!(engine.settle_async_answer(&reservation.entry_id,true).as_slice(),[Effect::WakeQueue]));
    assert_eq!(engine.ready_async_answer_entry(),Some(reservation.entry_id.clone()));
    // A pergunta continua pendente e a mensagem comum continua barrada.
    assert_eq!(async_ids(&engine),vec![json!(question)]);
    assert_eq!(engine.control_view()["deliverable"],false);
    let again = answer_async(&mut engine,&store,&question,"answer-3",14.0).unwrap();
    assert!(reservation_of(&again).is_none() && frames(&again).is_empty());
    assert_eq!(reply_of(&again,"answer-3"),Some((Disposition::Unknown,reservation.reply_payload())));
    assert_eq!(reservation.reply_payload()["decision_confirmed"],false);
}

#[test]
fn conversation_terminal_failed_reservation_leaves_the_question_open() {
    let mut engine = subscribed_terminal();
    let store = identified(&mut engine);
    let question = ask_async(&mut engine,"q1","Qual pasta?",13.0);
    let first = reservation_of(&answer_async(&mut engine,&store,&question,"answer-1",13.5).unwrap()).unwrap();
    assert!(engine.settle_async_answer(&first.entry_id,false).is_empty());
    assert_eq!(engine.ready_async_answer_entry(),None);
    let second = reservation_of(&answer_async(&mut engine,&store,&question,"answer-2",14.0).unwrap()).unwrap();
    assert_ne!(second.entry_id,first.entry_id);
}

#[test]
fn conversation_terminal_reservation_with_unknown_persistence_never_goes_out_in_this_life() {
    let mut engine = subscribed_terminal();
    let store = identified(&mut engine);
    let question = ask_async(&mut engine,"q1","Qual pasta?",13.0);
    let reservation = reservation_of(&answer_async(&mut engine,&store,&question,"answer-1",13.5).unwrap()).unwrap();
    engine.uncertain_async_answer(&reservation.entry_id);
    assert_eq!(engine.ready_async_answer_entry(),None);
    let again = answer_async(&mut engine,&store,&question,"answer-2",14.0).unwrap();
    assert!(reservation_of(&again).is_none() && frames(&again).is_empty());
    assert_eq!(reply_of(&again,"answer-2").map(|(d,_)|d),Some(Disposition::Unknown));
}

#[test]
fn conversation_terminal_two_async_questions_only_the_answered_one_leaves() {
    let mut engine = subscribed_terminal();
    let store = identified(&mut engine);
    let first = ask_async(&mut engine,"q1","Qual pasta?",13.0);
    let second = ask_async(&mut engine,"q2","Qual branch?",13.1);
    let reservation = reserved(&mut engine,&store,&first,"answer-1",13.5);
    // A outra pergunta sem resposta não segura a reservada.
    assert_eq!(engine.ready_async_answer_entry(),Some(reservation.entry_id.clone()));
    let effects = dispatch(&mut engine,&reservation,14.0);
    let start = frames(&effects)[0].clone();
    assert_eq!(start["method"],"turn/start");
    assert_eq!(start["params"],json!({"threadId":"thread-1","input":[{"type":"text","text":"> Qual pasta?\n\nA"}]}));
    // Uma por vez: com o turno em voo nenhuma outra sai.
    assert_eq!(engine.ready_async_answer_entry(),None);
    assert!(ack(&mut engine,&reservation.operation_id,WriteOutcome::Written,14.1).iter().all(|e|!matches!(e,Effect::Reply { .. })));
    assert_eq!(async_ids(&engine),vec![json!(first.clone()),json!(second.clone())],"enfileirar ou escrever não fecha a pergunta");
    let accepted = line(&mut engine,json!({"id":start["id"],"result":{"turn":{"id":"turn-1"}}}),14.5);
    assert_eq!(reply_of(&accepted,&reservation.operation_id).map(|(d,_)|d),Some(Disposition::Accepted));
    assert_eq!(async_ids(&engine),vec![json!(second)]);
    assert_eq!(engine.ready_async_answer_entry(),None);
}

#[test]
fn conversation_terminal_reserved_answer_goes_before_an_earlier_ordinary_input() {
    let mut engine = subscribed_terminal();
    let store = identified(&mut engine);
    let question = ask_async(&mut engine,"q1","Qual pasta?",13.0);
    // A mensagem comum chegou antes e espera a pergunta.
    let ordinary = engine.command(RuntimeCommand { operation_id:"ordinary".into(),kind:OperationKind::Input,payload:json!({"text":"segue"}) },clock(13.2)).unwrap();
    assert_eq!(reply_of(&ordinary,"ordinary").map(|(d,_)|d),Some(Disposition::Deferred));
    let reservation = reserved(&mut engine,&store,&question,"answer-1",13.5);
    assert_eq!(engine.control_view()["deliverable"],false,"a reserva não libera a primeira mensagem comum");
    let start = frames(&dispatch(&mut engine,&reservation,14.0))[0].clone();
    line(&mut engine,json!({"id":start["id"],"result":{"turn":{"id":"turn-1"}}}),14.5);
    let ended = line(&mut engine,json!({"method":"turn/completed","params":{"threadId":"thread-1","turn":{"id":"turn-1","status":"completed"}}}),15.0);
    assert!(ended.iter().any(|e|matches!(e,Effect::WakeQueue)));
    assert_eq!(engine.control_view()["deliverable"],true);
    let sent = engine.command(RuntimeCommand { operation_id:"ordinary".into(),kind:OperationKind::Input,payload:json!({"text":"segue"}) },clock(15.5)).unwrap();
    assert_eq!(frames(&sent)[0]["params"]["input"][0]["text"],"segue");
}

#[test]
fn conversation_terminal_rpc_approval_blocks_the_reserved_answer() {
    let mut engine = subscribed_terminal();
    let store = identified(&mut engine);
    let question = ask_async(&mut engine,"q1","Qual pasta?",13.0);
    let reservation = reserved(&mut engine,&store,&question,"answer-1",13.5);
    request(&mut engine,7,"item/commandExecution/requestApproval",json!({"threadId":"thread-1","command":"pwd"}));
    assert_eq!(engine.ready_async_answer_entry(),None);
    let held = dispatch(&mut engine,&reservation,14.0);
    assert!(frames(&held).is_empty());
    assert_eq!(reply_of(&held,&reservation.operation_id).map(|(d,_)|d),Some(Disposition::Deferred));
    let resolved = line(&mut engine,json!({"method":"serverRequest/resolved","params":{"threadId":"thread-1","requestId":7}}),15.0);
    assert!(resolved.iter().any(|e|matches!(e,Effect::WakeQueue)));
    assert_eq!(engine.ready_async_answer_entry(),Some(reservation.entry_id.clone()));
    assert_eq!(frames(&dispatch(&mut engine,&reservation,15.5))[0]["method"],"turn/start");
}

#[test]
fn conversation_terminal_unwritten_reserved_answer_returns_to_the_queue() {
    let mut engine = subscribed_terminal();
    let store = identified(&mut engine);
    let question = ask_async(&mut engine,"q1","Qual pasta?",13.0);
    let reservation = reserved(&mut engine,&store,&question,"answer-1",13.5);
    dispatch(&mut engine,&reservation,14.0);
    let acked = ack(&mut engine,&reservation.operation_id,WriteOutcome::NotWritten,14.1);
    assert_eq!(reply_of(&acked,&reservation.operation_id).map(|(d,_)|d),Some(Disposition::Deferred));
    assert_eq!(engine.ready_async_answer_entry(),Some(reservation.entry_id.clone()));
    assert_eq!(frames(&dispatch(&mut engine,&reservation,15.0)).len(),1);
}

#[test]
fn conversation_terminal_drop_after_possible_write_is_never_resent() {
    let mut engine = subscribed_terminal();
    let store = identified(&mut engine);
    let question = ask_async(&mut engine,"q1","Qual pasta?",13.0);
    let reservation = reserved(&mut engine,&store,&question,"answer-1",13.5);
    dispatch(&mut engine,&reservation,14.0);
    let acked = ack(&mut engine,&reservation.operation_id,WriteOutcome::Unknown,14.1);
    assert_eq!(reply_of(&acked,&reservation.operation_id).map(|(d,_)|d),Some(Disposition::Unknown));
    assert_eq!(engine.ready_async_answer_entry(),None);
    let again = answer_async(&mut engine,&store,&question,"answer-2",15.0).unwrap();
    assert!(frames(&again).is_empty() && reservation_of(&again).is_none());
    assert_eq!(reply_of(&again,"answer-2").map(|(d,_)|d),Some(Disposition::Unknown));
    // Só o recibo no transcript fecha a pergunta.
    assert_eq!(async_ids(&engine),vec![json!(question)]);
    let confirmed = engine.confirm_input(&reservation.operation_id);
    assert!(confirmed.iter().any(|e|matches!(e,Effect::StateChanged)));
    assert!(async_ids(&engine).is_empty());
}

#[test]
fn conversation_terminal_reservation_for_a_closed_question_is_refused_without_a_turn() {
    let mut engine = subscribed_terminal();
    let store = identified(&mut engine);
    let question = ask_async(&mut engine,"q1","Qual pasta?",13.0);
    let reservation = reserved(&mut engine,&store,&question,"answer-1",13.5);
    let token = async_token(&engine,&store,&question);
    engine.command(RuntimeCommand { operation_id:"skip".into(),kind:OperationKind::SkipQuestion,payload:json!({"request_id":question,"interaction_id":token}) },clock(14.0)).unwrap();
    let refused = dispatch(&mut engine,&reservation,14.5);
    assert!(frames(&refused).is_empty());
    let (disposition,payload) = reply_of(&refused,&reservation.operation_id).unwrap();
    assert_eq!(disposition,Disposition::Rejected);
    assert_eq!(payload["reservation"],"invalid");
    // Despacho de outra conversa também não vira turno.
    let mut engine = subscribed_terminal();
    let store = identified(&mut engine);
    let question = ask_async(&mut engine,"q1","Qual pasta?",13.0);
    let reservation = reserved(&mut engine,&store,&question,"answer-1",13.5);
    let mut foreign = Engine::async_answer_command(&reservation,"thread-2",1);
    foreign.payload["thread_id"] = json!("thread-2");
    let refused = engine.command(foreign,clock(14.0)).unwrap();
    assert!(frames(&refused).is_empty());
    assert_eq!(reply_of(&refused,&reservation.operation_id).map(|(d,_)|d),Some(Disposition::Rejected));
}

#[test]
fn conversation_terminal_rpc_refusal_of_the_reserved_turn_ends_the_reservation() {
    let mut engine = subscribed_terminal();
    let store = identified(&mut engine);
    let question = ask_async(&mut engine,"q1","Qual pasta?",13.0);
    let reservation = reserved(&mut engine,&store,&question,"answer-1",13.5);
    let start = frames(&dispatch(&mut engine,&reservation,14.0))[0].clone();
    let refused = line(&mut engine,json!({"id":start["id"],"error":{"code":-32600,"message":"turn already active"}}),14.5);
    assert_eq!(reply_of(&refused,&reservation.operation_id).map(|(d,_)|d),Some(Disposition::Rejected));
    assert_eq!(async_ids(&engine),vec![json!(question.clone())],"a pergunta continua aberta");
    let fresh = reservation_of(&answer_async(&mut engine,&store,&question,"answer-2",15.0).unwrap()).unwrap();
    assert_ne!(fresh.entry_id,reservation.entry_id);
}

#[test]
fn conversation_terminal_reservation_resumes_from_the_persisted_operation() {
    use hangar_server::runtime::queue::Status;
    let question = json!({"provider":"codex","request_id":"async:thread-1:q1:0","is_async":true,
        "questions":[{"id":"answer","header":"1","question":"Qual pasta?","multiSelect":false,"isOther":true,"isSecret":false,"options":[{"label":"A","description":""}]}]});
    let restored = || Engine::new(json!({"name":"session","thread_id":"thread-1","headless":false,"initialized":true,"connected":true,
        "async_questions":[["async:thread-1:q1:0",question.clone()]],"async_seen":["q1"]}),1,clock(10.0));
    let reservation = ReservedAsyncAnswer { request_id:"async:thread-1:q1:0".into(),interaction_id:"old-life".into(),
        entry_id:"async-answer:1:3".into(),operation_id:"async-answer:1:3".into(),text:"> Qual pasta?\n\nA".into() };
    // Fechada antes do envio: a mesma entrada sai na vida nova.
    for (status,written) in [(Status::Prepared,false),(Status::Deferred,true)] {
        let mut engine = restored();
        engine.restore_async_answer(reservation.clone(),"thread-1",status,written);
        assert_eq!(engine.ready_async_answer_entry(),Some("async-answer:1:3".into()));
        let start = frames(&engine.command(Engine::async_answer_command(&reservation,"thread-1",1),clock(11.0)).unwrap())[0].clone();
        assert_eq!(start["params"]["input"][0]["text"],"> Qual pasta?\n\nA");
    }
    // Pode ter sido escrita: nunca sai de novo, e a repetição devolve a mesma entrada incerta.
    for status in [Status::Dispatching,Status::Unknown] {
        let mut engine = restored();
        let store = identified(&mut engine);
        engine.restore_async_answer(reservation.clone(),"thread-1",status,true);
        assert_eq!(engine.ready_async_answer_entry(),None);
        let token = async_token(&engine,&store,"async:thread-1:q1:0");
        let again = engine.command(RuntimeCommand { operation_id:"again".into(),kind:OperationKind::AnswerQuestions,
            payload:json!({"request_id":"async:thread-1:q1:0","interaction_id":token,"answers":[{"question_id":"answer","kind":"option","indices":[0]}]}) },clock(11.0)).unwrap();
        assert!(frames(&again).is_empty());
        assert_eq!(reply_of(&again,"again"),Some((Disposition::Unknown,reservation.reply_payload())));
    }
    // Aceita fecha a pergunta; recusada ou de outra conversa não volta.
    let mut engine = restored();
    engine.restore_async_answer(reservation.clone(),"thread-1",Status::Accepted,true);
    assert!(async_ids(&engine).is_empty());
    for (status,thread) in [(Status::Rejected,"thread-1"),(Status::Prepared,"thread-2")] {
        let mut engine = restored();
        engine.restore_async_answer(reservation.clone(),thread,status,false);
        assert_eq!(engine.ready_async_answer_entry(),None);
        assert_eq!(async_ids(&engine),vec![json!("async:thread-1:q1:0")]);
    }
}

#[test]
fn conversation_terminal_late_turn_start_of_a_restored_reservation_closes_only_it() {
    use hangar_server::runtime::queue::Status;
    let question = json!({"provider":"codex","request_id":"async:thread-1:q1:0","is_async":true,"questions":[{"id":"answer","question":"Qual pasta?","options":[]}]});
    let mut engine = Engine::new(json!({"name":"session","thread_id":"thread-1","headless":false,"initialized":true,"connected":true,
        "async_questions":[["async:thread-1:q1:0",question]],"async_seen":["q1"]}),1,clock(10.0));
    let reservation = ReservedAsyncAnswer { request_id:"async:thread-1:q1:0".into(),interaction_id:"old".into(),
        entry_id:"async-answer:1:3".into(),operation_id:"async-answer:1:3".into(),text:"> Qual pasta?\n\nA".into() };
    engine.restore_async_answer(reservation.clone(),"thread-1",Status::Unknown,true);
    engine.restore_rpc("async-answer:1:3".into(),&json!({"jsonrpc":"2.0","id":"hangar:1:9","method":"turn/start",
        "params":{"threadId":"thread-1","input":[{"type":"text","text":"> Qual pasta?\n\nA"}]}}),0,0);
    line(&mut engine,json!({"id":"hangar:1:9","result":{"turn":{"id":"turn-9"}}}),11.0);
    assert!(async_ids(&engine).is_empty());
}

#[test]
fn conversation_terminal_thread_change_drops_reservations_and_end_of_life_drops_requests() {
    let mut engine = subscribed_terminal();
    let store = identified(&mut engine);
    let question = ask_async(&mut engine,"q1","Qual pasta?",13.0);
    let reservation = reserved(&mut engine,&store,&question,"answer-1",13.5);
    line(&mut engine,json!({"method":"thread/started","params":{"thread":{"id":"thread-2","path":"/r/two.jsonl","cwd":"/work","source":"cli"}}}),14.0);
    assert_eq!(engine.ready_async_answer_entry(),None);
    let refused = engine.command(Engine::async_answer_command(&reservation,"thread-1",1),clock(14.5)).unwrap();
    assert!(frames(&refused).is_empty());
    assert_eq!(reply_of(&refused,&reservation.operation_id).map(|(d,_)|d),Some(Disposition::Rejected));
    // Fim da vida: pedidos desta conexão não recebem resposta tardia na próxima.
    let mut engine = subscribed_terminal();
    request(&mut engine,7,"item/commandExecution/requestApproval",json!({"threadId":"thread-1","command":"pwd"}));
    line(&mut engine,json!({"type":"cano_saiu","rc":null}),15.0);
    assert!(pending_ids(&engine).is_empty());
}

#[test]
fn conversation_terminal_lost_socket_holds_the_queue_and_resubscribes_the_same_thread() {
    let mut engine = subscribed_terminal();
    let store = identified(&mut engine);
    // Turno em voo e uma aprovação respondida pelo app, ainda sem recibo.
    let started = engine.command(RuntimeCommand { operation_id:"msg".into(),kind:OperationKind::Input,payload:json!({"text":"primeira"}) },clock(12.5)).unwrap();
    assert!(frames(&started).iter().any(|f|f["method"] == "turn/start"));
    request(&mut engine,7,"item/commandExecution/requestApproval",json!({"threadId":"thread-1","command":"pwd"}));
    let token = request_token(&engine,&store,InteractionKind::Approval,json!(7));
    assert_eq!(frames(&engine.command(command(OperationKind::Select,json!({"option":1,"interaction_id":token})),clock(13.0)).unwrap()).len(),1);
    // O turno e a resposta já tinham ido ao socket.
    let handed:std::collections::BTreeSet<String> = ["msg".to_owned(),"op-1".to_owned()].into();
    let lost = engine.transport_lost("a conexão de controle caiu",&handed);
    // O turno sem recibo fica incerto, sem processo morto nem `headless_caiu`.
    assert_eq!(reply_of(&lost,"msg").map(|(d,_)|d),Some(Disposition::Unknown));
    let view = engine.view();
    assert_eq!(view["problema"],hangar_server::runtime::codex_terminal::DISCONNECTED);
    assert_ne!(view["state"],"dead");
    assert_eq!(view["headless"],false);
    let control = engine.control_view();
    assert_eq!((control["alive"].clone(),control["connected"].clone(),control["subscribed"].clone(),control["deliverable"].clone()),
        (json!(true),json!(false),json!(false),json!(false)));
    assert!(pending_ids(&engine).is_empty(),"pedido que o servidor não reapresentar não fica respondível");
    assert!(engine.command(command(OperationKind::Select,json!({"option":1,"interaction_id":token})),clock(13.5)).is_err());
    // Recibo tardio da escrita antiga não vira decisão.
    assert!(!ack(&mut engine,"op-1",WriteOutcome::Written,14.0).iter().any(|e|matches!(e,Effect::Reply { disposition:Disposition::Accepted,.. })));
    // Reconectado: inicializa e assina a MESMA thread, sem repetir turno nem aprovação.
    let resumed = connect(&mut engine);
    assert_eq!(resume_of(&resumed)["params"]["threadId"],"thread-1");
    assert!(!frames(&resumed).iter().any(|f|f["method"] == "turn/start" || f["id"] == 7));
    assert!(engine.view()["problema"].is_null(),"o problema sai quando a conexão volta");
    assert_eq!(engine.control_view()["connected"],true);
    // O pedido levado pela queda continua avisando, sem token novo, e segura a fila.
    assert_eq!(engine.view()["state"],"awaiting_input");
    assert_eq!(engine.control_view()["deliverable"],false);
    assert!(pending_ids(&engine).is_empty());
    // Reapresentado: vira pedido mostrável de novo, com identidade nova; resolvido pela TUI, sai.
    request(&mut engine,7,"item/commandExecution/requestApproval",json!({"threadId":"thread-1","command":"pwd"}));
    assert_eq!(pending_ids(&engine),vec![json!(7)]);
    line(&mut engine,json!({"method":"serverRequest/resolved","params":{"threadId":"thread-1","requestId":7}}),15.0);
    assert_ne!(engine.view()["state"],"awaiting_input");
    // Perdido e nunca reapresentado: o fim do turno também tira o aviso.
    request(&mut engine,8,"item/commandExecution/requestApproval",json!({"threadId":"thread-1","command":"ls"}));
    engine.transport_lost("de novo",&Default::default());
    connect(&mut engine);
    assert_eq!(engine.view()["state"],"awaiting_input");
    line(&mut engine,json!({"method":"turn/completed","params":{"threadId":"thread-1","turn":{"id":"","status":"completed"}}}),16.0);
    assert_ne!(engine.view()["state"],"awaiting_input");
}

#[test]
fn conversation_terminal_write_never_handed_to_the_socket_is_not_written_on_drop() {
    let mut engine = subscribed_terminal();
    let started = engine.command(RuntimeCommand { operation_id:"msg".into(),kind:OperationKind::Input,payload:json!({"text":"preparada"}) },clock(12.5)).unwrap();
    assert!(frames(&started).iter().any(|f|f["method"] == "turn/start"));
    // O quadro ainda estava sendo preparado quando o socket caiu: nunca saiu.
    let lost = engine.transport_lost("caiu",&Default::default());
    let (disposition,payload) = reply_of(&lost,"msg").unwrap();
    assert_ne!(disposition,Disposition::Unknown,"o que nunca saiu não fica incerto");
    assert_eq!(payload["write_outcome"],"not_written");
}

#[test]
fn conversation_terminal_reserved_answer_from_another_generation_is_refused() {
    let mut engine = subscribed_terminal();
    let store = identified(&mut engine);
    let question = ask_async(&mut engine,"q1","Qual pasta?",13.0);
    let reservation = reserved(&mut engine,&store,&question,"answer-1",13.5);
    let refused = engine.command(Engine::async_answer_command(&reservation,"thread-1",2),clock(14.0)).unwrap();
    assert!(frames(&refused).is_empty());
    assert_eq!(reply_of(&refused,&reservation.operation_id).map(|(d,_)|d),Some(Disposition::Rejected));
}

// ── Controles do Codex com terminal pelo app-server adotado ─────────────────────────────────────

/// Terminal conectado e assinado (a assinatura colou), com modelo e esforço conhecidos.
fn modeled_terminal() -> Engine {
    let mut engine = Engine::new(json!({"name":"session","thread_id":"thread-1","headless":false,"cwd":"/work",
        "model":"gpt-6","effort":"medium","permission_mode":"Ask for approval"}),1,clock(10.0));
    let resume = resume_of(&connect(&mut engine));
    line(&mut engine,json!({"id":resume["id"],"result":{"thread":{"id":"thread-1","path":"/r/one.jsonl","status":{"type":"idle"},"turns":[]}}}),12.0);
    assert_eq!(engine.control_view()["subscribed"],true);
    engine
}
fn op(id:&str,kind:OperationKind,payload:Value) -> RuntimeCommand { RuntimeCommand { operation_id:id.into(),kind,payload } }
fn accepted_payload(effects:&[Effect],id:&str) -> Option<Value> {
    effects.iter().find_map(|e|match e { Effect::Reply { operation_id,disposition:Disposition::Accepted,payload } if operation_id == id=>Some(payload.clone()),_=>None })
}
/// Nada da tabela sem terminal nem de relançamento: só o pedido do próprio controle.
fn terminal_safe(effects:&[Effect]) {
    assert!(!effects.iter().any(|e|matches!(e,Effect::Respawn { .. })));
    for frame in frames(effects) {
        assert_ne!(frame["method"],"thread/start");
        assert!(frame["params"].get("approvalPolicy").is_none() && frame["params"].get("sandbox").is_none(),"{frame}");
    }
}

#[test]
fn conversation_terminal_read_controls_run_over_the_adopted_app_server() {
    let mut engine = modeled_terminal();
    for (id,kind,payload,method) in [
        ("models",OperationKind::ListModels,json!({}),"model/list"),
        ("skills",OperationKind::ListSkills,json!({}),"skills/list"),
        ("limits",OperationKind::ReadRateLimits,json!({}),"account/rateLimits/read"),
        ("settings",OperationKind::ReadSettings,json!({"include_turns":false}),"thread/read"),
    ] {
        let effects = engine.command(op(id,kind,payload),clock(13.0)).unwrap();
        terminal_safe(&effects);
        let request = frames(&effects)[0].clone();
        assert_eq!(request["method"],method);
        if method == "skills/list" { assert_eq!(request["params"]["cwds"],json!(["/work"])); }
        if method == "thread/read" { assert_eq!(request["params"]["threadId"],"thread-1"); }
    }
    let settings = frames(&engine.command(op("again",OperationKind::ReadSettings,json!({})),clock(13.5)).unwrap())[0].clone();
    let effects = line(&mut engine,json!({"id":settings["id"],"result":{"thread":{"id":"thread-1","status":{"type":"idle"},"turns":[]}}}),13.6);
    let current = accepted_payload(&effects,"again").unwrap();
    assert_eq!(current["model"],"gpt-6"); assert_eq!(current["effort"],"medium");
}

#[test]
fn conversation_terminal_model_and_mode_change_the_tui_thread_without_permissions() {
    let mut engine = modeled_terminal();
    let effects = engine.command(op("model",OperationKind::SetModel,json!({"model":"gpt-6-mini","effort":"high"})),clock(13.0)).unwrap();
    terminal_safe(&effects);
    let update = frames(&effects)[0].clone();
    assert_eq!(update["method"],"thread/settings/update");
    assert_eq!(update["params"]["threadId"],"thread-1");
    assert_eq!(update["params"]["model"],"gpt-6-mini"); assert_eq!(update["params"]["effort"],"high");
    line(&mut engine,json!({"id":update["id"],"result":{}}),13.1);
    assert_eq!(engine.control_view()["model"],"gpt-6-mini"); assert_eq!(engine.control_view()["effort"],"high");

    let read = frames(&engine.command(op("mode",OperationKind::SetMode,json!({"mode":"plan"})),clock(14.0)).unwrap())[0].clone();
    assert_eq!(read["method"],"thread/read");
    let effects = line(&mut engine,json!({"id":read["id"],"result":{"thread":{"id":"thread-1","status":{"type":"idle"},"turns":[]}}}),14.1);
    terminal_safe(&effects);
    let update = frames(&effects)[0].clone();
    assert_eq!(update["method"],"thread/settings/update");
    assert_eq!(update["params"]["collaborationMode"]["mode"],"plan");
    assert_eq!(update["params"]["collaborationMode"]["settings"]["model"],"gpt-6-mini");
    let done = line(&mut engine,json!({"id":update["id"],"result":{}}),14.2);
    assert_eq!(accepted_payload(&done,"mode").unwrap()["mode"],"plan");
    assert_eq!(engine.view()["codex_mode"],"plan");
}

#[test]
fn conversation_terminal_fast_uses_the_same_confirmation_and_keeps_the_subscription() {
    let mut engine = modeled_terminal();
    let effects = engine.command(op("op-1",OperationKind::SetServiceTier,json!({"service_tier":"default"})),clock(13.0)).unwrap();
    terminal_safe(&effects);
    let update = frames(&effects)[0].clone();
    assert_eq!(update["params"],json!({"threadId":"thread-1","serviceTier":"default"}));
    line(&mut engine,json!({"id":update["id"],"result":{}}),13.1);
    let verify = frames(&tier_notification(&mut engine,"thread-1",json!("default"),13.2))[0].clone();
    // A conferência é um `thread/resume` só com a thread: não reenvia aprovação nem sandbox.
    assert_eq!(verify["method"],"thread/resume"); assert_eq!(verify["params"],json!({"threadId":"thread-1"}));
    assert!(tier_accepted(&line(&mut engine,json!({"id":verify["id"],"result":{"thread":{"id":"thread-1"},"serviceTier":"default"}}),13.3)));
    assert_eq!(engine.control_view()["subscribed"],true);
    assert_eq!(engine.view()["codex_service_tier"],"default");
}

#[test]
fn conversation_terminal_compact_waits_for_the_subscription_and_fast_does_not() {
    // Conectado sem assinatura: o fim da compactação não chegaria.
    let mut engine = terminal();
    connect(&mut engine);
    let refused = engine.command(op("op-1",OperationKind::Compact,json!({})),clock(12.0)).err().unwrap();
    assert_eq!(refused.code,"codex_command");
    // Fast antes do 1º turno: sem rollout, a conferência aceita o aviso da própria thread.
    let effects = engine.command(op("op-1",OperationKind::SetServiceTier,json!({"service_tier":"default"})),clock(12.0)).unwrap();
    terminal_safe(&effects);
    let update = frames(&effects)[0].clone();
    assert_eq!(update["params"],json!({"threadId":"thread-1","serviceTier":"default"}));
    line(&mut engine,json!({"id":update["id"],"result":{}}),12.1);
    let verify = frames(&tier_notification(&mut engine,"thread-1",json!("default"),12.2))[0].clone();
    assert_eq!(verify["method"],"thread/resume");
    let missing = json!({"id":verify["id"],"error":{"code":-32600,"message":"no rollout found for thread id thread-1"}});
    assert!(tier_accepted(&line(&mut engine,missing,12.3)));
    assert_eq!(engine.view()["codex_service_tier"],"default");
    // Outro erro na conferência continua sendo recusa.
    let effects = engine.command(op("op-2",OperationKind::SetServiceTier,json!({"service_tier":"priority"})),clock(13.0)).unwrap();
    let catalog = frames(&effects)[0].clone();
    assert_eq!(catalog["method"],"model/list");
    let refused = line(&mut engine,json!({"id":catalog["id"],"error":{"code":-1,"message":"boom"}}),13.1);
    assert!(refused.iter().any(|e|matches!(e,Effect::Reply { operation_id,disposition:Disposition::Rejected,.. } if operation_id == "op-2")));
    let mut engine = modeled_terminal();
    let effects = engine.command(op("compact",OperationKind::Compact,json!({})),clock(13.0)).unwrap();
    terminal_safe(&effects);
    let start = frames(&effects)[0].clone();
    assert_eq!(start["method"],"thread/compact/start"); assert_eq!(start["params"]["threadId"],"thread-1");
    line(&mut engine,json!({"id":start["id"],"result":{}}),13.1);
    assert_eq!(engine.view()["label"],"Compactando…");
    assert_eq!(engine.control_view()["deliverable"],false);
}

#[test]
fn conversation_terminal_relaunch_controls_are_refused_with_a_code() {
    use hangar_server::runtime::codex::{TERMINAL_RELAUNCH,TERMINAL_UNSUPPORTED};
    let mut engine = modeled_terminal();
    for kind in [OperationKind::Restart,OperationKind::Reload,OperationKind::SetPermissionMode,OperationKind::OpenTerminal] {
        let refused = engine.command(op("op-1",kind,json!({"mode":"Full Access"})),clock(13.0)).err().unwrap();
        assert_eq!(refused.code,TERMINAL_RELAUNCH,"{kind:?}");
    }
    for kind in [OperationKind::Commands,OperationKind::Cwd,OperationKind::Detach,OperationKind::VoiceOpen,OperationKind::SteerQueue] {
        let refused = engine.command(op("op-1",kind,json!({})),clock(13.0)).err().unwrap();
        assert_eq!(refused.code,TERMINAL_UNSUPPORTED,"{kind:?}");
    }
    // Processo caído não vira relançamento: o app-server com terminal não é do Hangar.
    line(&mut engine,json!({"type":"cano_saiu"}),14.0);
    assert_eq!(engine.command(op("op-1",OperationKind::Restart,json!({})),clock(14.5)).err().unwrap().code,TERMINAL_RELAUNCH);
}
