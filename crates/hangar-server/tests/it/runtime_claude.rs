use crate::mods_support;

use hangar_server::runtime::{claude::ClaudeEngine, protocol::*};
use hangar_server::mods::model::{ModsCall,SurfaceEffect};
use serde_json::{Value, json};

#[test]
fn model_effort_intent_is_not_an_extra_cli_model_field() {
    let mut engine = ClaudeEngine::new(json!({"name":"session","session_id":"sid","initialized":true}),1,
        ClockSample { monotonic_s:0.0,epoch_s:1_800_000_000.0 });
    let effects = engine.command(RuntimeCommand { operation_id:"model".into(),kind:OperationKind::SetModel,
        payload:json!({"model":"test-model","effort":"high"}) },ClockSample { monotonic_s:1.0,epoch_s:1_800_000_001.0 }).unwrap();
    let request = effects.iter().find_map(|effect|match effect { Effect::Write { frame,.. }=>Some(&frame["request"]),_=>None }).unwrap();
    assert_eq!(request,&json!({"subtype":"set_model","model":"test-model"}));
}

#[test]
fn hydrated_reader_requests_usage_and_reload_stamp_without_viewers() {
    let mut engine = engine(json!({"name":"session","session_id":"sid","initialized":true}));
    let snapshot = CanoSnapshot::parse(mods_support::cano_snapshot_json()).unwrap();
    let effects = engine.hydrate(snapshot).unwrap();
    for service in ["last_usage","reload_stamp"] {
        assert!(effects.iter().any(|effect|matches!(effect,Effect::Policy { kind,.. } if kind == service)));
    }
}

fn clock(seconds:f64) -> ClockSample { ClockSample { monotonic_s:seconds,epoch_s:1_800_000_000.0 + seconds } }
fn engine(metadata:Value) -> ClaudeEngine { ClaudeEngine::new(metadata,1,clock(10.0)) }
fn line(engine:&mut ClaudeEngine,value:Value,seconds:f64) -> Vec<Effect> { engine.apply(EngineInput::Line(value),clock(seconds)).unwrap() }
fn command(kind:OperationKind,payload:Value) -> RuntimeCommand { RuntimeCommand { operation_id:"op-1".into(),kind,payload } }
fn writes(effects:&[Effect]) -> Vec<Value> { effects.iter().filter_map(|e|match e { Effect::Write { frame,.. } => Some(frame.clone()),_=>None }).collect() }

#[test]
fn init_timeout_not_deliverable() {
    let mut engine = engine(json!({"name":"session"}));
    let effects = engine.start_initialize("init".into()).unwrap();
    let request_id = writes(&effects)[0]["request_id"].clone();
    let timeout = engine.apply(EngineInput::Tick,clock(190.0)).unwrap();
    assert!(timeout.iter().any(|e|matches!(e,Effect::Reply { disposition:Disposition::Unknown,.. })));
    assert_eq!(engine.view()["iniciando"],true);
    assert_eq!(engine.view()["deliverable"],false);
    line(&mut engine,json!({"type":"control_response","response":{
        "request_id":request_id,"subtype":"success","response":{"commands":[]}}}),191.0);
    assert_eq!(engine.view()["iniciando"],false);
    assert_eq!(engine.view()["deliverable"],true);
}

#[test]
fn pending_plan_rules() {
    let mut engine = engine(json!({"name":"session","permission_mode":"plan","previous_non_plan":"bypassPermissions","initialized":true}));
    let read = line(&mut engine,json!({"type":"control_request","request_id":1,
        "request":{"subtype":"can_use_tool","tool_name":"Read","input":{}}}),10.0);
    assert_eq!(writes(&read)[0]["response"]["response"]["behavior"],"allow");
    for (index,tool) in ["ExitPlanMode","Edit","Write","MultiEdit","NotebookEdit"].into_iter().enumerate() {
        let effects = line(&mut engine,json!({"type":"control_request","request_id":index+2,
            "request":{"subtype":"can_use_tool","tool_name":tool,"input":{}}}),10.0);
        assert!(writes(&effects).is_empty());
    }
    assert_eq!(engine.view()["pending"].as_array().unwrap().len(),5);
}

/// Sem terminal, o cartão publicado é o que o app responde: o ID sai do próprio estado.
fn identified(engine:&mut ClaudeEngine) {
    engine.set_interactions("key".into(),std::sync::Arc::new(hangar_server::interactions::InteractionStore::default())).unwrap();
}
fn shown_id(engine:&ClaudeEngine) -> Option<String> { engine.view()["public_state"]["interaction_id"].as_str().map(str::to_owned) }
fn ack(engine:&mut ClaudeEngine,operation_id:&str) {
    engine.apply(EngineInput::WriteAck { operation_id:operation_id.into(),outcome:WriteOutcome::Written },clock(11.0)).unwrap();
}

#[test]
fn headless_permission_card_carries_the_id_that_answers_it() {
    let mut engine = engine(json!({"name":"session","session_id":"sid","initialized":true}));
    identified(&mut engine);
    line(&mut engine,json!({"type":"control_request","request_id":7,"request":{
        "subtype":"can_use_tool","tool_name":"Bash","input":{"command":"ls"}}}),10.0);
    let state = engine.view()["public_state"].clone();
    assert_eq!(state["question"],"Permitir Bash? ls");
    let shown = shown_id(&engine);
    assert!(shown.is_some(),"permissão publicada sem interaction_id: {state}");
    let shown = shown.unwrap();
    assert_eq!(shown_id(&engine).as_deref(),Some(shown.as_str()),"o mesmo cartão mantém o ID");
    let missing = engine.command(command(OperationKind::Select,json!({"option":1})),clock(10.0)).unwrap_err();
    assert_eq!(missing.code,"erro_interacao_sem_identidade");
    let effects = engine.command(command(OperationKind::Select,json!({"option":1,"interaction_id":shown})),clock(10.0)).unwrap();
    assert_eq!(writes(&effects)[0]["response"]["request_id"],7);
    assert_eq!(writes(&effects)[0]["response"]["response"]["behavior"],"allow");
    ack(&mut engine,"op-1");
    assert!(shown_id(&engine).is_none(),"respondido, o cartão sai");
    line(&mut engine,json!({"type":"control_request","request_id":8,"request":{
        "subtype":"can_use_tool","tool_name":"Bash","input":{"command":"pwd"}}}),12.0);
    assert_ne!(shown_id(&engine).as_deref(),Some(shown.as_str()));
    let stale = engine.command(RuntimeCommand { operation_id:"op-2".into(),kind:OperationKind::Select,
        payload:json!({"option":1,"interaction_id":shown}) },clock(12.0)).unwrap_err();
    assert_eq!(stale.code,"erro_interacao_desatualizada");
}

#[test]
fn headless_question_and_plan_cards_carry_the_id_that_answers_them() {
    let mut engine = engine(json!({"name":"session","session_id":"sid","initialized":true}));
    identified(&mut engine);
    line(&mut engine,json!({"type":"control_request","request_id":1,"request":{
        "subtype":"can_use_tool","tool_name":"AskUserQuestion","input":{"questions":[{
        "question":"Qual opção?","header":"Opção","multiSelect":false,"options":[{"label":"A","description":""}]}]}}}),10.0);
    let form = engine.view()["public_state"]["codex_question"].clone();
    let form_id = form["interaction_id"].as_str().map(str::to_owned);
    assert!(form_id.is_some(),"pergunta publicada sem interaction_id: {form}");
    let effects = engine.command(command(OperationKind::AnswerQuestions,json!({"request_id":1,
        "answers":[{"kind":"option","indices":[0]}],"interaction_id":form_id})),clock(10.0)).unwrap();
    assert_eq!(writes(&effects)[0]["response"]["response"]["updatedInput"]["answers"]["Qual opção?"],"A");
    ack(&mut engine,"op-1");
    line(&mut engine,json!({"type":"control_request","request_id":2,"request":{
        "subtype":"can_use_tool","tool_name":"ExitPlanMode","input":{"plan":"# Plano"},"tool_use_id":"t1"}}),12.0);
    assert_eq!(engine.view()["public_state"]["question"],"Aprovar o plano?");
    let plan = shown_id(&engine);
    assert!(plan.is_some(),"plano publicado sem interaction_id");
    let effects = engine.command(RuntimeCommand { operation_id:"op-2".into(),kind:OperationKind::Select,
        payload:json!({"option":1,"interaction_id":plan}) },clock(12.0)).unwrap();
    assert_eq!(writes(&effects)[0]["response"]["request_id"],2);
    assert_eq!(writes(&effects)[0]["response"]["response"]["behavior"],"allow");
}

fn assert_unanswerable(state:&Value,problema:&str) {
    assert_eq!(state["problema"],problema,"{state}");
    assert!(state["problema_detalhe"].as_str().unwrap_or("").contains("erro_interacao_"),"código da identidade fora do detalhe: {state}");
    assert!(state["options"].is_null() && state["codex_question"].is_null() && state["interaction_id"].is_null()
        && state["claude_plan_pending"].is_null(),"cartão sem ID parece respondível: {state}");
}

#[test]
fn headless_card_without_identity_store_is_shown_unanswerable() {
    let mut engine = engine(json!({"name":"session","session_id":"sid","initialized":true}));
    line(&mut engine,json!({"type":"control_request","request_id":7,"request":{
        "subtype":"can_use_tool","tool_name":"Bash","input":{"command":"ls"}}}),10.0);
    assert_unanswerable(&engine.view()["public_state"],"runtime_falhou");
    line(&mut engine,json!({"type":"control_request","request_id":8,"request":{
        "subtype":"can_use_tool","tool_name":"AskUserQuestion","input":{"questions":[{"question":"Q?","options":[]}]}}}),10.0);
    assert_unanswerable(&engine.view()["public_state"],"runtime_falhou");
}

#[test]
fn headless_identity_error_keeps_the_existing_problem_and_its_own_code() {
    use hangar_server::interactions::{InteractionBinding, InteractionStore};
    let mut engine = engine(json!({"name":"session","session_id":"sid","initialized":true}));
    let store = std::sync::Arc::new(InteractionStore::default());
    engine.set_interactions("key".into(),store.clone()).unwrap();
    line(&mut engine,json!({"type":"result","subtype":"error_max_turns","is_error":true,"result":"limite"}),10.0);
    // Outra vida tomou a chave: observar o cartão desta falha.
    store.bind(&InteractionBinding { key:"key".into(),conversation:"other".into(),generation:9 }).unwrap();
    line(&mut engine,json!({"type":"control_request","request_id":7,"request":{
        "subtype":"can_use_tool","tool_name":"ExitPlanMode","input":{"plan":"# P"}}}),11.0);
    let state = engine.view()["public_state"].clone();
    assert_unanswerable(&state,"headless_turno_erro");
    assert!(state["problema_detalhe"].as_str().unwrap().starts_with("error_max_turns: limite"),"{state}");
}

#[test]
fn question_validates_current_request() {
    use hangar_server::interactions::{InteractionBinding, InteractionKind, InteractionStore, native_target};
    let mut engine = engine(json!({"name":"session","session_id":"sid","initialized":true}));
    let store = std::sync::Arc::new(InteractionStore::default());
    engine.set_interactions("key".into(),store.clone()).unwrap();
    line(&mut engine,json!({"type":"control_request","request_id":1,"request":{
        "subtype":"can_use_tool","tool_name":"AskUserQuestion","input":{"questions":[{
        "question":"Qual opção?","header":"Opção","multiSelect":true,
        "options":[{"label":"A","description":"Primeira"},{"label":"B","description":"Segunda"}]}]}}}),10.0);
    // A resposta leva a identidade da pergunta exibida, como o app manda.
    let binding = InteractionBinding { key:"key".into(),conversation:"sid".into(),generation:1 };
    let shown = store.observe(&binding,&native_target(InteractionKind::Question,"sid",&json!(1)),Some(engine.view()["question"].clone())).unwrap().unwrap();
    assert!(engine.command(command(OperationKind::AnswerQuestions,json!({"request_id":"1","answers":[],"interaction_id":shown})),clock(10.0)).is_err());
    let effects = engine.command(command(OperationKind::AnswerQuestions,json!({"request_id":1,"answers":[{"kind":"option","indices":[0,1]}],"interaction_id":shown})),clock(10.0)).unwrap();
    assert_eq!(writes(&effects)[0]["response"]["response"]["updatedInput"]["answers"]["Qual opção?"],"A, B");
}

#[test]
fn interrupt_denies_all_pending_first() {
    let mut engine = engine(json!({"name":"session","initialized":true}));
    for id in [1,2] { line(&mut engine,json!({"type":"control_request","request_id":id,
        "request":{"subtype":"can_use_tool","tool_name":"Edit","input":{}}}),10.0); }
    let effects = engine.command(command(OperationKind::Interrupt,json!({})),clock(10.0)).unwrap();
    let frames = writes(&effects);
    assert_eq!(frames.len(),3);
    assert_eq!(frames[0]["response"]["response"]["behavior"],"deny");
    assert_eq!(frames[1]["response"]["response"]["behavior"],"deny");
    assert_eq!(frames[2]["request"]["subtype"],"interrupt");
}

/// `_pode_estacionar` do Python: o tempo parado conta do último evento da CLI ou comando nosso, e qualquer
/// coisa em aberto (turno, permissão, pergunta, subida, esforço pendente, trabalho de fundo, processo morto) impede.
#[test]
fn park_idle_counts_from_the_last_activity_and_only_with_nothing_open() {
    const PARK:f64 = 65.0 * 60.0;
    let ready = || engine(json!({"name":"session","session_id":"sid","initialized":true,"permission_mode":"manual"}));
    let mut session = ready();
    assert_eq!(session.park_idle(10.0 + PARK),Some(PARK),"parada desde a abertura");
    session.command(command(OperationKind::Input,json!({"text":"oi"})),clock(100.0)).unwrap();
    assert_eq!(session.park_idle(100.0 + PARK),None,"turno em curso");
    line(&mut session,json!({"type":"result","subtype":"success","result":"ok"}),300.0);
    assert_eq!(session.park_idle(300.0 + PARK - 1.0),Some(PARK - 1.0),"o fim do turno é atividade");
    line(&mut session,json!({"type":"rate_limit_event","rate_limit_info":{}}),400.0);
    assert_eq!(session.park_idle(400.0 + PARK),Some(PARK),"qualquer evento da CLI é atividade");

    let mut permission = ready();
    line(&mut permission,json!({"type":"control_request","request_id":"p","request":{"subtype":"can_use_tool","tool_name":"Edit","input":{}}}),10.0);
    assert_eq!(permission.view()["pending"].as_array().unwrap().len(),1,"a permissão ficou em aberto");
    assert_eq!(permission.park_idle(10.0 + PARK * 2.0),None,"permissão em aberto");

    let mut question = ready();
    line(&mut question,json!({"type":"control_request","request_id":"q","request":{"subtype":"can_use_tool","tool_name":"AskUserQuestion","input":{"questions":[]}}}),10.0);
    assert_eq!(question.park_idle(10.0 + PARK * 2.0),None,"pergunta em aberto");

    let starting = engine(json!({"name":"session","session_id":"sid"}));
    assert_eq!(starting.park_idle(10.0 + PARK * 2.0),None,"subida sem initialize");

    let effort = engine(json!({"name":"session","session_id":"sid","initialized":true,"effort_intent":{"operation_id":"e","value":"high","status":"prepared"}}));
    assert_eq!(effort.park_idle(10.0 + PARK * 2.0),None,"esforço pendente");

    let mut background = ready();
    line(&mut background,json!({"type":"system","subtype":"background_tasks_changed","tasks":[{"task_id":"t1","task_type":"local_bash","description":"build"}]}),10.0);
    assert_eq!(background.park_idle(10.0 + PARK * 2.0),None,"trabalho de fundo vivo");

    let mut dead = ready();
    line(&mut dead,json!({"type":"cano_saiu","code":0}),10.0);
    assert_eq!(dead.park_idle(10.0 + PARK * 2.0),None,"processo já morto não tem o que estacionar");
}

#[test]
fn subagent_does_not_close_parent() {
    let mut engine = engine(json!({"name":"session","initialized":true}));
    line(&mut engine,json!({"type":"command_lifecycle","state":"started"}),10.0);
    line(&mut engine,json!({"type":"result","subtype":"success","parent_tool_use_id":"child"}),11.0);
    assert_eq!(engine.view()["in_progress"],true);
}

#[test]
fn usage_last_call_is_context() {
    let mut engine = engine(json!({"name":"session","initialized":true}));
    line(&mut engine,json!({"type":"assistant","message":{"content":[],"usage":{"input_tokens":2,"cache_read_input_tokens":39000,"output_tokens":4}}}),10.0);
    line(&mut engine,json!({"type":"result","subtype":"success","usage":{"input_tokens":500000}}),11.0);
    line(&mut engine,json!({"type":"assistant","message":{"content":[],"usage":{"input_tokens":0}}}),12.0);
    assert_eq!(engine.view()["usage"]["cache_read_input_tokens"],39000);
}

#[test]
fn first_150ms_last_and_clear() {
    let mut engine = engine(json!({"name":"session","initialized":true}));
    let mut publications = Vec::new();
    for (time,event) in [(10.0,json!({"type":"content_block_delta","delta":{"type":"text_delta","text":"Olá "}})),
        (10.1,json!({"type":"content_block_delta","delta":{"type":"text_delta","text":"mundo"}}))] {
        publications.extend(line(&mut engine,json!({"type":"stream_event","event":event}),time));
    }
    publications.extend(engine.apply(EngineInput::Tick,clock(10.15)).unwrap());
    publications.extend(line(&mut engine,json!({"type":"assistant","message":{"content":[{"type":"text","text":"Olá mundo"}]}}),10.2));
    publications.extend(engine.apply(EngineInput::Tick,clock(10.3)).unwrap());
    let texts:Vec<_> = publications.into_iter().filter_map(|e|match e {
        Effect::Publish { channel,data } if channel == "preview" => Some(data["text"].clone()),_=>None }).collect();
    assert_eq!(texts,vec![json!("Olá "),json!("Olá mundo"),json!("")]);
}

#[test]
fn unknown_control_is_neutral() {
    let mut engine = engine(json!({"name":"session"}));
    let effects = line(&mut engine,json!({"type":"control_request","request_id":"future",
        "request":{"subtype":"future_method"}}),10.0);
    assert_eq!(writes(&effects)[0]["response"]["response"],json!({}));
    assert!(effects.iter().any(|e|matches!(e,Effect::Policy { kind,.. } if kind == "unknown_private")));
}

#[test]
fn clear_discards_old_control_and_queued_write() {
    let mut engine = engine(json!({"name":"session", "initialized":true, "session_id":"before"}));
    let effects = engine.command(command(OperationKind::SetModel,json!({"model":"next"})),clock(10.0)).unwrap();
    let request_id = writes(&effects)[0]["request_id"].clone();
    let reset = line(&mut engine,json!({"type":"system", "subtype":"init", "session_id":"after"}),11.0);
    assert!(reset.iter().any(|effect|matches!(effect,Effect::Reply { disposition:Disposition::Unknown,.. })));
    assert!(!engine.write_is_current("op-1"));
    line(&mut engine,json!({"type":"control_response", "response":{"request_id":request_id,
        "subtype":"success", "response":{}}}),12.0);
    assert_ne!(engine.view()["model"], "next");
    assert_eq!(engine.view()["conversation"], "after");
}

#[test]
fn effort_is_deferred_until_a_safe_boundary() {
    let mut engine = engine(json!({"name":"session","initialized":true,"effort":"medium"}));
    line(&mut engine,json!({"type":"command_lifecycle","state":"started"}),10.0);
    let effects = engine.command(command(OperationKind::SetEffort,json!({"effort":"high"})),clock(11.0)).unwrap();
    assert!(writes(&effects).is_empty());
    assert_eq!(engine.view()["effort_intent"]["operation_id"],"op-1");
    let effects = line(&mut engine,json!({"type":"result","subtype":"success"}),12.0);
    assert!(effects.iter().any(|e|matches!(e,Effect::Write { operation_id:Some(id),.. } if id == "op-1:effort")));
    assert_eq!(engine.view()["effort"],"medium");
    line(&mut engine,json!({"type":"assistant","local_command_source":"/effort","message":{
        "content":[{"type":"text","text":"Set effort level to high (this session only)"}]}}),13.0);
    assert_eq!(engine.view()["effort"],"high");
}

/// Formato real da CLI: a SAÍDA vai no `local_command_source`, sem o nome do comando. Outra saída local no
/// meio não confirma nem recusa o esforço.
#[test]
fn effort_is_confirmed_by_the_cli_output_carried_in_the_source() {
    let mut engine = engine(json!({"name":"session","initialized":true,"effort":"medium"}));
    let effects = engine.command(command(OperationKind::SetEffort,json!({"effort":"low"})),clock(10.0)).unwrap();
    assert!(effects.iter().any(|e|matches!(e,Effect::Write { operation_id:Some(id),.. } if id == "op-1:effort")));
    line(&mut engine,json!({"type":"assistant","local_command_source":"<local-command-stdout>Total cost: $0</local-command-stdout>",
        "message":{"content":[{"type":"text","text":"Total cost: $0"}]}}),11.0);
    assert_eq!(engine.view()["effort_intent"]["status"],"dispatching");
    let out = "Set effort level to low (this session only): Quick, straightforward implementation with minimal overhead";
    let effects = line(&mut engine,json!({"type":"assistant","local_command_source":format!("<local-command-stdout>{out}</local-command-stdout>"),
        "message":{"content":[{"type":"text","text":out}]}}),12.0);
    assert_eq!(engine.view()["effort"],"low");
    assert!(effects.iter().any(|e|matches!(e,Effect::Reply { operation_id,disposition:Disposition::Accepted,.. } if operation_id == "op-1")));
}

#[test]
fn effort_typed_by_the_user_keeps_its_slash_command_on_the_answer() {
    let mut engine = engine(json!({"name":"session","initialized":true}));
    engine.command(command(OperationKind::Steer,json!({"text":"/effort high"})),clock(11.0)).unwrap();
    let out = "Set effort level to high (this session only): Comprehensive implementation";
    let effects = line(&mut engine,json!({"type":"assistant","local_command_source":format!("<local-command-stdout>{out}</local-command-stdout>"),
        "message":{"content":[{"type":"text","text":out}]}}),12.0);
    assert!(effects.iter().any(|e|matches!(e,Effect::Policy { kind,payload,.. } if kind == "local_output" && payload["source"] == "/effort high")));
}

/// A CLI põe a SAÍDA no `local_command_source`, não o comando.
#[test]
fn local_answer_carries_the_slash_command_that_was_written() {
    let mut engine = engine(json!({"name":"session","initialized":true}));
    engine.command(command(OperationKind::Steer,json!({"text":"/btw"})),clock(11.0)).unwrap();
    let effects = line(&mut engine,json!({"type":"assistant",
        "local_command_source":"<local-command-stdout>/btw isn't available in this environment.</local-command-stdout>",
        "message":{"content":[{"type":"text","text":"/btw isn't available in this environment."}]}}),12.0);
    assert!(effects.iter().any(|e|matches!(e,Effect::Policy { kind,payload,.. } if kind == "local_output" && payload["source"] == "/btw")));
    let again = line(&mut engine,json!({"type":"assistant","local_command_source":"<local-command-stdout>x</local-command-stdout>",
        "message":{"content":[{"type":"text","text":"x"}]}}),13.0);
    assert!(again.iter().any(|e|matches!(e,Effect::Policy { kind,payload,.. } if kind == "local_output" && payload["source"].is_null())));
}

#[test]
fn late_ack_does_not_override_result() {
    let mut engine = engine(json!({"name":"session"}));
    let effects = engine.start_initialize("init".into()).unwrap();
    let request_id = writes(&effects)[0]["request_id"].clone();
    line(&mut engine,json!({"type":"control_response","response":{
        "request_id":request_id,"subtype":"success","response":{}}}),11.0);
    let effects = engine.apply(EngineInput::WriteAck { operation_id:"init".into(),outcome:WriteOutcome::Unknown },clock(12.0)).unwrap();
    assert!(!effects.iter().any(|e|matches!(e,Effect::Reply { disposition:Disposition::Unknown,.. })));
    assert_eq!(engine.view()["deliverable"],true);
}

#[test]
fn mods_call_needs_a_surface_and_a_live_attach() {
    let mut engine = engine(json!({"name":"session","initialized":true}));
    let refused = engine.mods_call(1,ModsCall::Show { site:"p".into() },7.0,clock(10.0)).err().unwrap();
    assert_eq!(refused.code,"erro_mod_botao_inexistente","sem superfície ligada");
    engine.enable_surface("ui:t".into());
    let effects = engine.mods_call(2,ModsCall::Show { site:"p".into() },7.0,clock(10.0)).unwrap();
    assert!(effects.iter().any(|effect|matches!(effect,Effect::Surface { effect:SurfaceEffect::Reply { token:2,result:Err(error) } }
        if error.code == "erro_mod_painel_inexistente")),"superfície ainda não ligada responde na hora");
}

fn surface_engine(metadata:Value) -> ClaudeEngine { let mut engine = engine(metadata); engine.enable_surface("ui:t".into()); engine }
fn surface_writes(effects:&[Effect]) -> Vec<Value> {
    effects.iter().filter_map(|e|match e { Effect::Surface { effect:SurfaceEffect::Write { frame, .. } }=>Some(frame.clone()),_=>None }).collect()
}
fn snapshot() -> CanoSnapshot { CanoSnapshot::parse(mods_support::cano_snapshot_json()).unwrap() }
/// Motor com a superfície ligada e a faixa já desenhada (nenhum desenho em voo).
fn attached() -> ClaudeEngine {
    let mut engine = surface_engine(json!({"name":"session","initialized":true}));
    let attach = surface_writes(&engine.hydrate(snapshot()).unwrap())[0].clone();
    let effects = line(&mut engine,json!({"type":"control_response","response":{"subtype":"success","request_id":attach["request_id"],"response":{"surfaces":["desktop"]}}}),11.0);
    let band = surface_writes(&effects).into_iter().find(|frame|frame["request"]["subtype"] == "ui_render").unwrap();
    line(&mut engine,json!({"type":"control_response","response":{"subtype":"success","request_id":band["request_id"],
        "response":{"tree":{"type":"Text"},"hooked":true}}}),11.0);
    engine
}

#[test]
fn surface_attaches_only_when_initialize_offers_it() {
    for (capabilities,attaches) in [(json!(["ui_surface_v1"]),true),(json!([]),false)] {
        let mut engine = surface_engine(json!({"name":"session"}));
        let request_id = writes(&engine.start_initialize("init".into()).unwrap())[0]["request_id"].clone();
        let effects = line(&mut engine,json!({"type":"control_response","response":{"request_id":request_id,"subtype":"success",
            "response":{"commands":[],"capabilities":capabilities}}}),11.0);
        let attach = surface_writes(&effects).into_iter().find(|frame|frame["request"]["subtype"] == "ui_attach");
        assert_eq!(attach.is_some(),attaches);
        assert!(writes(&effects).iter().all(|frame|frame["request"]["subtype"] != "ui_attach"),"ui_attach nunca vai pelo diário");
    }
}

#[test]
fn hydrated_initialized_session_attaches_again() {
    let mut surfaced = surface_engine(json!({"name":"session","initialized":true}));
    let frames = surface_writes(&surfaced.hydrate(snapshot()).unwrap());
    assert_eq!(frames[0]["request"]["subtype"],"ui_attach");
    let mut plain = engine(json!({"name":"session","initialized":true}));
    assert!(surface_writes(&plain.hydrate(snapshot()).unwrap()).is_empty(),"sem superfície ligada nada sai");
}

#[test]
fn hydrate_with_the_process_gone_does_not_attach() {
    // A15: com `saiu` no retrato, o `ui_attach` iria a um processo morto e venceria em 15 s.
    let mut engine = surface_engine(json!({"name":"session","initialized":true}));
    let mut gone = mods_support::cano_snapshot_json();
    gone["saiu"] = json!(0);
    assert!(surface_writes(&engine.hydrate(CanoSnapshot::parse(gone).unwrap()).unwrap()).is_empty());
    // Não iniciada: a ligação espera o `initialize` dizer se o processo aceita a superfície.
    let mut fresh = surface_engine(json!({"name":"session"}));
    assert!(surface_writes(&fresh.hydrate(snapshot()).unwrap()).is_empty());
}

#[test]
fn ui_lines_go_to_the_surface_and_never_to_the_unknown_log() {
    let mut engine = surface_engine(json!({"name":"session","initialized":true}));
    let attach = surface_writes(&engine.hydrate(snapshot()).unwrap())[0].clone();
    let effects = line(&mut engine,json!({"type":"control_response","response":{"subtype":"success","request_id":attach["request_id"],"response":{"surfaces":["desktop"]}}}),11.0);
    assert!(surface_writes(&effects).iter().any(|frame|frame["request"]["subtype"] == "ui_render"));
    assert!(!effects.iter().any(|e|matches!(e,Effect::Reply { .. })),"resposta ui_* não fecha operação da fila");
    let effects = line(&mut engine,json!({"type":"system","subtype":"ui_toast","plugin":"vitrine","text":"oi","timeout_ms":4000,"uuid":"u","session_id":"s"}),11.0);
    assert!(effects.iter().any(|e|matches!(e,Effect::Surface { effect:SurfaceEffect::Toast { text,.. } } if text == "oi")));
    assert!(!effects.iter().any(|e|matches!(e,Effect::Policy { kind,.. } if kind == "unknown_private" || kind == "local_output")));
}

#[test]
fn ui_copy_is_answered_off_the_journal() {
    let mut engine = attached();
    let effects = line(&mut engine,json!({"type":"control_request","request_id":"uuid-1","request":{"subtype":"ui_copy","surface":"desktop","client_id":"hangar","plugin":"vitrine","text":"Texto"}}),12.0);
    assert!(writes(&effects).is_empty(),"nada pelo diário");
    assert_eq!(surface_writes(&effects)[0]["response"]["response"],json!({"copied":true}));
    assert!(effects.iter().any(|e|matches!(e,Effect::Surface { effect:SurfaceEffect::Copied { text,.. } } if text == "Texto")));
}

#[test]
fn without_surface_ui_copy_keeps_the_empty_answer() {
    let mut engine = engine(json!({"name":"session","initialized":true}));
    let effects = line(&mut engine,json!({"type":"control_request","request_id":"uuid-1","request":{"subtype":"ui_copy","text":"x"}}),12.0);
    assert_eq!(writes(&effects)[0]["response"]["response"],json!({}));
}

#[test]
fn automatic_answers_never_reuse_an_operation_id() {
    let mut engine = engine(json!({"name":"session","permission_mode":"plan","previous_non_plan":"bypassPermissions","initialized":true}));
    let mut ids = Vec::new();
    for (request,subtype) in [(1,"can_use_tool"),(2,"can_use_tool"),(3,"hook_callback"),(4,"hook_callback")] {
        let effects = line(&mut engine,json!({"type":"control_request","request_id":request,
            "request":{"subtype":subtype,"tool_name":"Read","input":{}}}),10.0);
        ids.extend(effects.iter().filter_map(|e|match e { Effect::Write { operation_id:Some(id),.. } => Some(id.clone()),_=>None }));
    }
    let unique:std::collections::BTreeSet<_> = ids.iter().collect();
    assert_eq!((ids.len(),unique.len()),(4,4),"resposta automática repetiu o ID da operação: {ids:?}");
}

fn notes(effects:&[Effect]) -> Vec<String> {
    effects.iter().filter_map(|e|match e { Effect::Policy { kind,payload,.. } if kind == "local_output" => payload["text"].as_str().map(str::to_owned),_=>None }).collect()
}

#[test]
fn request_cancelled_by_the_cli_leaves_a_note() {
    let mut engine = engine(json!({"name":"session","session_id":"sid","initialized":true}));
    line(&mut engine,json!({"type":"control_request","request_id":7,"request":{"subtype":"can_use_tool","tool_name":"Bash","input":{"command":"ls"}}}),10.0);
    let effects = line(&mut engine,json!({"type":"control_cancel_request","request_id":7}),11.0);
    // O cancelamento vem também do Parar, do fim do turno e do prazo da CLI: sem prova de que foi um hook, o texto é neutro.
    assert_eq!(notes(&effects),vec!["⚙️ Permitir Bash? ls — encerrado antes da sua resposta".to_owned()]);
    line(&mut engine,json!({"type":"control_request","request_id":8,"request":{"subtype":"can_use_tool","tool_name":"AskUserQuestion",
        "input":{"questions":[{"question":"Qual pasta?","options":[]}]}}}),12.0);
    let effects = line(&mut engine,json!({"type":"control_cancel_request","request_id":8}),13.0);
    assert_eq!(notes(&effects),vec!["⚙️ Pergunta cancelada antes da resposta: Qual pasta?".to_owned()]);
    assert!(notes(&line(&mut engine,json!({"type":"control_cancel_request","request_id":9}),14.0)).is_empty(),"pedido desconhecido não vira nota");
}

#[test]
fn engine_session_keeps_its_fixed_route_over_the_model_the_cli_reports() {
    let mut engine = engine(json!({"name":"session","session_id":"sid","initialized":true,"engine_account":"kimi","model":"kimi-k3"}));
    line(&mut engine,json!({"type":"system","subtype":"init","session_id":"sid","model":"claude-base"}),10.0);
    assert_eq!(engine.view()["model"],"kimi-k3");
    let mut plain = self::engine(json!({"name":"session","session_id":"sid","initialized":true,"model":"old"}));
    line(&mut plain,json!({"type":"system","subtype":"init","session_id":"sid","model":"claude-new"}),10.0);
    assert_eq!(plain.view()["model"],"claude-new");
}

#[test]
fn working_label_keeps_the_subagent_step_and_compaction_end_only_after_compaction() {
    let mut engine = engine(json!({"name":"session","session_id":"sid","initialized":true}));
    line(&mut engine,json!({"type":"command_lifecycle","state":"started"}),10.0);
    line(&mut engine,json!({"type":"system","subtype":"task_started","task_id":"t","subagent_type":"Explore","description":"Lendo arquivos"}),10.0);
    line(&mut engine,json!({"type":"system","subtype":"task_progress","task_id":"t"}),10.0);
    let label = |engine:&ClaudeEngine| engine.view()["public_state"]["label"].as_str().unwrap_or("").to_owned();
    assert!(label(&engine).starts_with("Explore: Lendo arquivos"),"passo sem descrição apagou o anterior: {}",label(&engine));
    line(&mut engine,json!({"type":"system","subtype":"compact_boundary"}),10.0);
    assert!(label(&engine).starts_with("Explore: Lendo arquivos"),"compact_boundary sem compactação limpou o rótulo: {}",label(&engine));
}

fn replies(effects:&[Effect]) -> Vec<(String,Disposition,Value)> {
    effects.iter().filter_map(|e|match e { Effect::Reply { operation_id,disposition,payload } => Some((operation_id.clone(),disposition.clone(),payload.clone())),_=>None }).collect()
}

#[test]
fn interrupt_without_a_turn_says_so_and_with_a_turn_answers_on_the_write() {
    let mut engine = engine(json!({"name":"session","session_id":"sid","initialized":true}));
    let effects = engine.command(command(OperationKind::Interrupt,json!({})),clock(10.0)).unwrap();
    assert!(writes(&effects).is_empty(),"sem turno nada vai à CLI");
    assert!(replies(&effects).iter().any(|(id,disposition,payload)|id == "op-1" && *disposition == Disposition::Accepted && payload["interrupted"] == false),
        "sem turno a resposta diz que não havia o que interromper: {:?}",replies(&effects));
    line(&mut engine,json!({"type":"command_lifecycle","state":"started"}),11.0);
    let effects = engine.command(RuntimeCommand { operation_id:"op-2".into(),kind:OperationKind::Interrupt,payload:json!({}) },clock(11.0)).unwrap();
    assert_eq!(writes(&effects)[0]["request"]["subtype"],"interrupt");
    let effects = engine.apply(EngineInput::WriteAck { operation_id:"op-2".into(),outcome:WriteOutcome::Written },clock(11.5)).unwrap();
    assert!(replies(&effects).iter().any(|(id,disposition,_)|id == "op-2" && *disposition == Disposition::Accepted),
        "o Parar responde quando o pedido chega à CLI, sem esperar a resposta dela");
}

#[test]
fn base_mode_not_restored_after_the_plan_shows_on_the_band() {
    for refused in [true,false] {
        let mut engine = engine(json!({"name":"session","session_id":"sid","initialized":true,"permission_mode":"plan","previous_non_plan":"acceptEdits"}));
        identified(&mut engine);
        line(&mut engine,json!({"type":"control_request","request_id":1,"request":{"subtype":"can_use_tool","tool_name":"ExitPlanMode","input":{"plan":"# P"}}}),10.0);
        let plan = shown_id(&engine);
        engine.command(command(OperationKind::Select,json!({"option":1,"interaction_id":plan})),clock(10.0)).unwrap();
        let effects = line(&mut engine,json!({"type":"system","subtype":"status","permissionMode":"default"}),11.0);
        let restore = writes(&effects).into_iter().find(|frame|frame["request"]["subtype"] == "set_permission_mode").expect("volta à base pedida");
        assert_eq!(restore["request"]["mode"],"acceptEdits");
        if refused {
            line(&mut engine,json!({"type":"control_response","response":{"subtype":"error","request_id":restore["request_id"],"error":"modo recusado"}}),12.0);
        } else {
            engine.apply(EngineInput::Tick,clock(30.0)).unwrap();
        }
        let state = engine.view()["public_state"].clone();
        assert_eq!(state["problema"],"headless_turno_erro","refused={refused}: a falha ao voltar à base ficou calada: {state}");
        assert!(state["problema_detalhe"].as_str().unwrap_or("").contains("acceptEdits"),"{state}");
    }
}

#[test]
fn subagent_lifecycle_follows_the_latest_run_of_each_agent() {
    // Eventos do Claude Code 2.1.296 em stream-json (sonda `lifeprobe-a`), na ordem em que saíram.
    let mut engine = engine(json!({"name":"session","session_id":"86d31b17-559c-4868-b84d-120b080d264d","initialized":true}));
    let agent = "a33dc15d3ed06eda5";
    let events = [
        json!({"type":"system","subtype":"background_tasks_changed","tasks":[{"task_id":agent,"run_id":"0mv6r5zbx-f32cbd7a","task_type":"local_agent","subagent_type":"general-purpose","description":"Contador sleep 8 em background"}]}),
        json!({"type":"system","subtype":"task_started","task_id":agent,"run_id":"0mv6r5zbx-f32cbd7a","tool_use_id":"toolu_019oqFWW2fJ2VXfLmPSFMF5m","description":"Contador sleep 8 em background","subagent_type":"general-purpose","is_backgrounded":true,"spawn_depth":1,"task_type":"local_agent"}),
        json!({"type":"system","subtype":"task_progress","task_id":agent,"run_id":"0mv6r5zbx-f32cbd7a","description":"Running Run sleep 8 then echo done-one","subagent_type":"general-purpose","last_tool_name":"Bash"}),
        json!({"type":"system","subtype":"task_started","task_id":"b7x65u6s6","run_id":"0mv6r65tp-6e8f6c4d","owned_by_subagent":true,"description":"Run sleep 8 then echo done-one","is_backgrounded":false,"parent_task_id":agent,"task_type":"local_bash"}),
        json!({"type":"system","subtype":"task_notification","task_id":"b7x65u6s6","run_id":"0mv6r65tp-6e8f6c4d","status":"completed","output_file":"","summary":"Run sleep 8 then echo done-one"}),
    ];
    for event in events { line(&mut engine,event,10.0); }
    let subagents = engine.view()["subagents"].clone();
    assert_eq!(subagents,json!({agent:{"state":"running","run_id":"0mv6r5zbx-f32cbd7a","end_time":null}}),"só o subagente, em execução: {subagents}");
    line(&mut engine,json!({"type":"system","subtype":"task_updated","task_id":agent,"run_id":"0mv6r5zbx-f32cbd7a","patch":{"status":"completed","end_time":1791900303614u64}}),11.0);
    line(&mut engine,json!({"type":"system","subtype":"task_notification","task_id":agent,"run_id":"0mv6r5zbx-f32cbd7a","status":"completed","summary":"done-one"}),11.0);
    line(&mut engine,json!({"type":"system","subtype":"background_tasks_changed","tasks":[]}),11.0);
    assert_eq!(engine.view()["subagents"][agent],json!({"state":"completed","run_id":"0mv6r5zbx-f32cbd7a","end_time":1791900303614u64}));
    // Retomado: mesmo agentId, execução nova.
    line(&mut engine,json!({"type":"system","subtype":"background_tasks_changed","tasks":[{"task_id":agent,"run_id":"0mv6r6keb-8bab04c9","task_type":"local_agent","subagent_type":"general-purpose","description":"Contador sleep 8 em background"}]}),12.0);
    line(&mut engine,json!({"type":"system","subtype":"task_started","task_id":agent,"run_id":"0mv6r6keb-8bab04c9","task_type":"local_agent","subagent_type":"general-purpose"}),12.0);
    assert_eq!(engine.view()["subagents"][agent],json!({"state":"running","run_id":"0mv6r6keb-8bab04c9","end_time":null}));
    // Desfecho atrasado da execução anterior não mexe na atual.
    line(&mut engine,json!({"type":"system","subtype":"task_notification","task_id":agent,"run_id":"0mv6r5zbx-f32cbd7a","status":"failed"}),12.5);
    assert_eq!(engine.view()["subagents"][agent]["state"],"running");
    line(&mut engine,json!({"type":"system","subtype":"task_updated","task_id":agent,"run_id":"0mv6r6keb-8bab04c9","patch":{"status":"killed","end_time":1791900324539u64}}),13.0);
    assert_eq!(engine.view()["subagents"][agent],json!({"state":"stopped","run_id":"0mv6r6keb-8bab04c9","end_time":1791900324539u64}));
}

#[test]
fn echoed_user_message_with_our_uuid_proves_the_delivery() {
    let mut engine = engine(json!({"name":"session","session_id":"sid","initialized":true}));
    let effects = engine.command(RuntimeCommand { operation_id:"msg".into(),kind:OperationKind::Input,payload:json!({"text":"Olá"}) },clock(10.0)).unwrap();
    let uuid = writes(&effects)[0]["uuid"].as_str().expect("mensagem escrita sem uuid").to_owned();
    let echoed = |effects:&[Effect]| effects.iter().filter_map(|e|match e { Effect::InputEchoed { operation_id } => Some(operation_id.clone()),_=>None }).collect::<Vec<_>>();
    let other = line(&mut engine,json!({"type":"user","isReplay":true,"uuid":"00000000-0000-5000-8000-000000000000","message":{"role":"user","content":"Olá"}}),10.5);
    assert!(echoed(&other).is_empty(),"eco de outra mensagem não prova esta");
    let echo = line(&mut engine,json!({"type":"user","isReplay":true,"uuid":uuid,"session_id":"sid","message":{"role":"user","content":[{"type":"text","text":"Olá"}]}}),11.0);
    assert_eq!(echoed(&echo),vec!["msg".to_owned()]);
    assert!(echoed(&line(&mut engine,json!({"type":"user","isReplay":true,"uuid":uuid,"message":{"role":"user","content":"Olá"}}),11.5)).is_empty(),"o mesmo eco confirma uma vez");
}

#[test]
fn background_agent_keeps_the_label_after_the_turn_ends_until_it_leaves_the_live_set() {
    let mut engine = engine(json!({"name":"session","session_id":"sid","initialized":true}));
    let agent = "a33dc15d3ed06eda5";
    line(&mut engine,json!({"type":"command_lifecycle","state":"started"}),10.0);
    line(&mut engine,json!({"type":"system","subtype":"background_tasks_changed","tasks":[{"task_id":agent,"run_id":"r1","task_type":"local_agent","subagent_type":"general-purpose","description":"Contador sleep 8 em background"}]}),10.0);
    line(&mut engine,json!({"type":"system","subtype":"task_started","task_id":agent,"run_id":"r1","task_type":"local_agent","subagent_type":"general-purpose","description":"Contador sleep 8 em background","is_backgrounded":true}),10.0);
    line(&mut engine,json!({"type":"system","subtype":"task_started","task_id":"b1","run_id":"r2","task_type":"local_bash","description":"sleep 8","is_backgrounded":false}),10.0);
    line(&mut engine,json!({"type":"result","subtype":"success","is_error":false}),11.0);
    let label = engine.view()["public_state"]["label"].clone();
    assert_eq!(label,"general-purpose: Contador sleep 8 em background","o agente de fundo vivo some do rótulo no fim do turno: {label}");
    line(&mut engine,json!({"type":"system","subtype":"background_tasks_changed","tasks":[]}),20.0);
    assert!(engine.view()["public_state"]["label"].is_null(),"fora do conjunto vivo, o agente terminou");
}

#[test]
fn answering_after_the_process_died_is_a_closed_question_not_a_server_error() {
    let mut engine = engine(json!({"name":"session","session_id":"sid","initialized":true}));
    identified(&mut engine);
    line(&mut engine,json!({"type":"control_request","request_id":7,"request":{"subtype":"can_use_tool","tool_name":"Bash","input":{"command":"ls"}}}),10.0);
    let shown = shown_id(&engine);
    line(&mut engine,json!({"type":"cano_saiu","rc":1}),11.0);
    let refused = engine.command(command(OperationKind::Select,json!({"option":1,"interaction_id":shown})),clock(11.0)).unwrap_err();
    assert_eq!(refused.code,"erro_interacao_desatualizada");
}

fn persisted_problem(effects:&[Effect]) -> Option<Value> {
    effects.iter().find_map(|e|match e { Effect::PersistClaude { patch,.. } if patch.get("problema").is_some() => Some(patch["problema"].clone()),_=>None })
}

#[test]
fn crash_stays_idle_with_the_reason_and_survives_into_the_next_life() {
    let mut engine = engine(json!({"name":"session","session_id":"sid","initialized":true}));
    line(&mut engine,json!({"type":"cano_stderr","linha":"Error: not logged in"}),11.0);
    let effects = line(&mut engine,json!({"type":"cano_saiu","rc":3}),12.0);
    let state = engine.view()["public_state"].clone();
    assert_eq!(state["state"],"idle","queda mostra a faixa do problema, não 'Sessão encerrada': {state}");
    assert_eq!((state["problema"].as_str(),state["problema_detalhe"].as_str()),(Some("headless_processo_caiu"),Some("Error: not logged in\nrc=3")));
    assert_eq!(persisted_problem(&effects),Some(json!(["headless_processo_caiu","Error: not logged in\nrc=3"])),"o problema vai ao arquivo da sessão");
    let mut next = ClaudeEngine::new(json!({"name":"session","session_id":"sid","initialized":true,
        "problema":["headless_processo_caiu","Error: not logged in\nrc=3"]}),2,clock(20.0));
    assert_eq!(next.view()["public_state"]["problema"],"headless_processo_caiu","a vida seguinte ainda mostra a queda");
    let effects = line(&mut next,json!({"type":"result","subtype":"success","is_error":false}),21.0);
    assert!(next.view()["public_state"]["problema"].is_null());
    assert_eq!(persisted_problem(&effects),Some(Value::Null),"o turno bom limpa o arquivo da sessão");
}

#[test]
fn clean_exit_is_not_a_crash() {
    for rc in [0,-15] {
        let mut engine = engine(json!({"name":"session","session_id":"sid","initialized":true}));
        let effects = line(&mut engine,json!({"type":"cano_saiu","rc":rc}),12.0);
        let state = engine.view()["public_state"].clone();
        assert_eq!(state["state"],"idle","rc={rc}: {state}");
        assert!(state["problema"].is_null() && persisted_problem(&effects).is_none(),"rc={rc} não é queda: {state}");
    }
}

#[test]
fn kill_or_exit_mid_turn_is_a_crash_and_lost_connection_is_visible() {
    // SIGKILL (OOM, kill -9) e qualquer saída no meio do turno cortam o trabalho: é queda, com o problema.
    for (rc,working) in [(-9,false),(0,true),(-15,true)] {
        let mut engine = engine(json!({"name":"session","session_id":"sid","initialized":true}));
        if working { line(&mut engine,json!({"type":"command_lifecycle","state":"started"}),11.0); }
        let effects = line(&mut engine,json!({"type":"cano_saiu","rc":rc}),12.0);
        let state = engine.view()["public_state"].clone();
        assert_eq!((state["problema"].as_str(),state["problema_detalhe"].as_str()),(Some("headless_processo_caiu"),Some(format!("rc={rc}").as_str())),
            "rc={rc} working={working}: {state}");
        assert!(persisted_problem(&effects).is_some());
    }
    // Sem código de saída: a conexão com o processo caiu; a faixa diz isso, sem gravar queda no arquivo.
    let mut engine = engine(json!({"name":"session","session_id":"sid","initialized":true}));
    let effects = line(&mut engine,json!({"type":"cano_saiu","rc":null}),12.0);
    let state = engine.view()["public_state"].clone();
    assert_eq!(state["problema"],"runtime_falhou","{state}");
    assert!(state["problema_detalhe"].as_str().unwrap_or("").starts_with("cano_closed"),"{state}");
    assert!(persisted_problem(&effects).is_none());
}

#[test]
fn process_exit_fails_pending_mods_calls() {
    let mut engine = attached();
    line(&mut engine,json!({"type":"system","subtype":"ui_panes","panes":[{"id":"p","title":"P","plugin":"m"}],"shown_id":"p","focused_id":null,"focus_requested_id":null}),12.0);
    engine.mods_call(5,ModsCall::Show { site:"p".into() },7.0,clock(12.0)).unwrap();
    let effects = line(&mut engine,json!({"type":"cano_saiu","rc":1}),13.0);
    assert!(effects.iter().any(|e|matches!(e,Effect::Surface { effect:SurfaceEffect::Reply { token:5,result:Err(error) } } if error.code == "erro_mod_clique_sem_resposta")));
    assert!(effects.iter().any(|e|matches!(e,Effect::Surface { effect:SurfaceEffect::Publish { data } } if data["panes"] == json!([]))));
}

#[test]
fn turn_start_redraws_the_band_with_is_working() {
    let mut engine = attached();
    line(&mut engine,json!({"type":"command_lifecycle","state":"started"}),12.0);
    let effects = engine.apply(EngineInput::Tick,clock(12.2)).unwrap();
    let band = surface_writes(&effects).into_iter().find(|frame|frame["request"]["component"] == "AbovePrompt").expect("faixa pedida de novo");
    assert_eq!(band["request"]["props"]["isWorking"],true);
}

#[test]
fn conversation_reset_redraws_the_band_without_is_working() {
    let mut engine = attached();
    line(&mut engine,json!({"type":"command_lifecycle","state":"started"}),12.0);
    let effects = engine.apply(EngineInput::Tick,clock(12.2)).unwrap();
    let working = surface_writes(&effects).into_iter().find(|frame|frame["request"]["component"] == "AbovePrompt").unwrap();
    line(&mut engine,json!({"type":"control_response","response":{"subtype":"success","request_id":working["request_id"],
        "response":{"tree":{"type":"Text"},"hooked":true}}}),12.3);
    line(&mut engine,json!({"type":"conversation_reset"}),12.4);
    assert_eq!(engine.view()["in_progress"],false);
    let effects = engine.apply(EngineInput::Tick,clock(12.6)).unwrap();
    let band = surface_writes(&effects).into_iter().find(|frame|frame["request"]["component"] == "AbovePrompt").expect("faixa pedida de novo");
    assert_eq!(band["request"]["props"]["isWorking"],false);
}

#[test]
fn surface_deadline_enters_the_engine_clock() {
    // Sem o prazo da superfície no relógio, o ator não acordaria para ligar de novo.
    let mut engine = surface_engine(json!({"name":"session","initialized":true}));
    engine.hydrate(snapshot()).unwrap();
    // Primeiro vence o carimbo de recarga (20); passado ele, o próximo é o prazo da ligação (10 + 15).
    assert_eq!(engine.next_deadline(),Some(20.0));
    engine.apply(EngineInput::Tick,clock(20.0)).unwrap();
    assert_eq!(engine.next_deadline(),Some(25.0),"prazo da ligação no relógio do motor");
    let effects = engine.apply(EngineInput::Tick,clock(25.0)).unwrap();
    assert!(surface_writes(&effects).is_empty(),"ligação vencida espera 1 s antes de tentar de novo");
    assert!(engine.next_deadline().is_some_and(|deadline|deadline <= 26.0 + 1e-9),"a nova tentativa entra no relógio");
    let effects = engine.apply(EngineInput::Tick,clock(26.0)).unwrap();
    assert_eq!(surface_writes(&effects)[0]["request"]["subtype"],"ui_attach");
}

#[test]
fn turn_already_running_when_the_engine_opens_is_working_until_result() {
    let mut engine = engine(json!({"name":"session","session_id":"sid","initialized":true}));
    assert_eq!(engine.view()["deliverable"],true);
    for (index,event) in [
        json!({"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"meio"}}}),
        json!({"type":"assistant","message":{"content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"ls"}}]}}),
        json!({"type":"tool_progress","tool_use_id":"t1"}),
        json!({"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"ok"}]}}),
    ].into_iter().enumerate() {
        line(&mut engine,event,11.0+index as f64);
        assert_eq!(engine.view()["public_state"]["state"],"working","evento {index}");
        assert_eq!(engine.view()["deliverable"],false,"evento {index}");
    }
    line(&mut engine,json!({"type":"result","subtype":"success"}),20.0);
    assert_eq!(engine.view()["public_state"]["state"],"idle");
    assert_eq!(engine.view()["deliverable"],true);
}

#[test]
fn events_outside_a_turn_do_not_open_one() {
    for event in [
        json!({"type":"system","subtype":"init","session_id":"sid","model":"m"}),
        json!({"type":"rate_limit_event","rate_limit_info":{"status":"allowed"}}),
        json!({"type":"keep_alive"}),
        json!({"type":"assistant","local_command_source":"cost","message":{"content":[{"type":"text","text":"Total cost: $0"}]}}),
        json!({"type":"user","message":{"content":"<local-command-stdout>ok</local-command-stdout>"}}),
        json!({"type":"stream_event","parent_tool_use_id":"t9","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"sub"}}}),
    ] {
        let mut engine = engine(json!({"name":"session","session_id":"sid","initialized":true}));
        line(&mut engine,event.clone(),11.0);
        assert_eq!(engine.view()["in_progress"],false,"{event}");
        assert_eq!(engine.view()["deliverable"],true,"{event}");
    }
}

#[test]
fn relaunch_helper_failure_says_its_kind_before_exiting() {
    let bin = env!("CARGO_BIN_EXE_hangar-server");
    let run = |args: &[&str]| std::process::Command::new(bin).args(args).stdin(std::process::Stdio::null()).output().unwrap();
    let bad = run(&["--session-relaunch"]);
    assert_eq!(bad.status.code(), Some(126));
    assert!(String::from_utf8_lossy(&bad.stderr).contains("InvalidInput"), "{}", String::from_utf8_lossy(&bad.stderr));
    #[cfg(unix)] {
        let gone = run(&["--session-relaunch", "/nonexistent/hangar-relaunch.sock"]);
        assert_eq!(gone.status.code(), Some(126));
        assert!(String::from_utf8_lossy(&gone.stderr).contains("NotFound"), "{}", String::from_utf8_lossy(&gone.stderr));
    }
}
