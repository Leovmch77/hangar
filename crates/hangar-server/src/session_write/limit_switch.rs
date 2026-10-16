//! D-002: a sessão Claude que para no limite de uso da conta reabre sozinha na conta de mais folga, pela
//! mesma reabertura do `/conta`, e recebe pela fila um recado para continuar de onde parou.
use std::collections::BTreeMap;
use std::sync::Mutex;

use serde_json::Value;

use crate::runtime::protocol::UsageLimit;
use crate::session_open::{Account,AgentProvider,SessionSpec};

/// O que fazer com a sessão que bateu o limite.
#[derive(Debug,PartialEq)]
pub enum Decision { Switch { path:String, label:String }, Stay(&'static str) }

/// Contas que já bateram o limite, até a janela delas voltar: não são escolhidas de novo nesse prazo.
#[derive(Default)]
pub struct Spent(Mutex<BTreeMap<String,f64>>);

fn canonical(dir:&str) -> String {
    std::fs::canonicalize(dir).map_or_else(|_|dir.to_owned(),|path|path.to_string_lossy().into_owned())
}

impl Spent {
    pub fn mark(&self,dir:&str,until:f64) {
        if let Ok(mut spent) = self.0.lock() { spent.insert(canonical(dir),until); }
    }
    pub fn is_spent(&self,dir:&str,now:f64) -> bool {
        self.0.lock().is_ok_and(|spent|spent.get(&canonical(dir)).is_some_and(|until|*until > now))
    }
}

/// A última mensagem da conversa principal no fim do transcript, se for o aviso de limite do plano ainda valendo.
/// `apiErrorParams` é do CLI de hoje; `quotaLimits` recusado, do antigo. O aperto temporário não traz nenhum.
pub fn transcript_limit(tail:&str,now:f64) -> Option<UsageLimit> {
    let last = tail.lines().rev().filter_map(|line|serde_json::from_str::<Value>(line).ok())
        .find(|line|matches!(line["type"].as_str(),Some("user" | "assistant")) && line["isSidechain"] != true)?;
    if last["type"] != "assistant" || last["isApiErrorMessage"] != true { return None; }
    let params = &last["apiErrorParams"]["rate_limit_info"];
    let info = if last["apiError"] == "usage_limit_reached" && params.is_object() { params }
        else if last["error"] == "rate_limit" && last["quotaLimits"]["status"] == "rejected" { &last["quotaLimits"] }
        else { return None };
    let limit = UsageLimit::from_info(info);
    limit.resets_at.is_none_or(|reset|reset > now).then_some(limit)
}

/// A mesma escolha da abertura (`quotas::suggestion`): a conta Claude lida de mais folga, fora a atual e as
/// gastas nesta janela; cheia (99% ou mais) não serve.
pub fn decide(spec:&SessionSpec,current:&str,catalog:&Value,quotas:&[Value],spent:&Spent,now:f64) -> Decision {
    if spec.provider != AgentProvider::Claude { return Decision::Stay("limit_switch_not_claude"); }
    if matches!(spec.account,Account::Engine{..}) { return Decision::Stay("limit_switch_engine"); }
    let known:Vec<String> = catalog.as_array().into_iter().flatten().filter_map(|row|row["path"].as_str().map(canonical)).collect();
    let current = canonical(current);
    let rows:Vec<Value> = quotas.iter().filter(|row|row["id"].as_str().and_then(|id|id.strip_prefix("claude:")).is_some_and(|path| {
        let path = canonical(path);
        path != current && known.contains(&path) && !spent.is_spent(&path,now)
    })).cloned().collect();
    match crate::accounts::quotas::suggestion(&rows) {
        Some(best) if best["folga"].as_f64().is_some_and(|room|room > 100.0 - super::account::FULL_PCT) =>
            Decision::Switch { path:best["path"].as_str().unwrap_or_default().to_owned(),label:best["label"].as_str().unwrap_or_default().to_owned() },
        _=>Decision::Stay("limit_switch_no_room"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use crate::session_open::{AccountSource,SPEC_VERSION,Surface};

    const FIVE_HOUR:&str = include_str!("../../tests/it/fixtures/usage_limit/claude_five_hour_sdk.jsonl");
    const SEVEN_DAY:&str = include_str!("../../tests/it/fixtures/usage_limit/claude_seven_day_tui.jsonl");
    const OLD_CLI:&str = include_str!("../../tests/it/fixtures/usage_limit/claude_old_cli.jsonl");

    #[test]
    fn the_limit_line_at_the_end_of_the_transcript_gives_window_and_reset() {
        assert_eq!(transcript_limit(FIVE_HOUR,1791570000.0),Some(UsageLimit { window:"five_hour".into(),resets_at:Some(1791577800.0) }));
        assert_eq!(transcript_limit(SEVEN_DAY,1791900000.0),Some(UsageLimit { window:"seven_day".into(),resets_at:Some(1791928800.0) }));
        assert_eq!(transcript_limit(OLD_CLI,1789560000.0),Some(UsageLimit { window:"five_hour".into(),resets_at:Some(1789566600.0) }));
    }

    #[test]
    fn bookkeeping_lines_after_the_limit_do_not_hide_it() {
        let tail = format!("{FIVE_HOUR}{}\n{}\n{}\n",
            json!({"type":"last-prompt","lastPrompt":"x","sessionId":"s"}),
            json!({"type":"assistant","isSidechain":true,"message":{"content":[]}}),
            json!({"type":"queue-operation","operation":"enqueue"}));
        assert!(transcript_limit(&tail,1791570000.0).is_some());
    }

    #[test]
    fn a_passed_reset_or_a_later_message_is_not_the_current_limit() {
        assert_eq!(transcript_limit(FIVE_HOUR,1791577801.0),None,"o reset já passou");
        let later = format!("{FIVE_HOUR}{}\n",json!({"type":"user","isSidechain":false,"message":{"content":"segue"}}));
        assert_eq!(transcript_limit(&later,1791570000.0),None,"a conversa seguiu depois do aviso");
        let throttle = json!({"type":"assistant","isSidechain":false,"isApiErrorMessage":true,"error":"rate_limit",
            "message":{"content":[{"type":"text","text":"API Error: rate limited"}]}}).to_string();
        assert_eq!(transcript_limit(&throttle,1791570000.0),None,"aperto temporário não é a cota");
        assert_eq!(transcript_limit("{\"type\":\"assistant\",\"isSidechain\":false,tor",1791570000.0),None);
    }

    fn spec(account:Account) -> SessionSpec {
        SessionSpec { version:SPEC_VERSION,key:"k".into(),name:"s".into(),cwd:"/w".into(),provider:AgentProvider::Claude,
            surface:Surface::Headless,account,account_source:AccountSource::Default,model:None,effort:None,service_tier:None,
            permission_mode:None,subagent_model:None,customizations:None,jev:false,read_only:false,worktree:None,creator:None,
            created_at:1.0,conversation:None }
    }
    fn catalog(paths:&[&str]) -> Value { Value::Array(paths.iter().map(|p|json!({"path":p,"label":p.trim_start_matches('/')})).collect()) }
    fn quota(path:&str,pct:f64) -> Value { json!({"provedor":"claude","id":format!("claude:{path}"),"label":path.trim_start_matches('/'),"estado":"lida","janelas":[{"pct":pct},{"pct":pct/2.0}]}) }
    fn claude(dir:&str) -> Account { Account::Claude { config_dir:dir.into() } }

    #[test]
    fn the_most_room_wins_and_the_spent_account_never_comes_back_in_its_window() {
        let spent = Spent::default();
        let cat = catalog(&["/a","/b","/c"]);
        // O cache ainda mostra a conta que acabou de bater o limite com folga: ela nunca é destino.
        let quotas = [quota("/a",10.0),quota("/b",40.0),quota("/c",20.0)];
        spent.mark("/a",2000.0);
        assert_eq!(decide(&spec(claude("/a")),"/a",&cat,&quotas,&spent,1000.0),Decision::Switch { path:"/c".into(),label:"c".into() });
        // Na conta nova o limite bate de novo: a primeira continua gasta, sobra a outra.
        spent.mark("/c",2000.0);
        assert_eq!(decide(&spec(claude("/c")),"/c",&cat,&quotas,&spent,1000.0),Decision::Switch { path:"/b".into(),label:"b".into() });
        spent.mark("/b",2000.0);
        assert_eq!(decide(&spec(claude("/b")),"/b",&cat,&quotas,&spent,1000.0),Decision::Stay("limit_switch_no_room"));
        // Passado o reset, as contas voltam a valer, e a de mais folga é a primeira.
        assert_eq!(decide(&spec(claude("/b")),"/b",&cat,&quotas,&spent,2001.0),Decision::Switch { path:"/a".into(),label:"a".into() });
    }

    #[test]
    fn full_unread_or_unknown_accounts_are_no_room() {
        let spent = Spent::default();
        let cat = catalog(&["/a","/b","/c"]);
        let unread = json!({"provedor":"claude","id":"claude:/c","label":"c","estado":"erro"});
        let quotas = [quota("/a",10.0),quota("/b",99.5),unread,quota("/z",0.0)];
        assert_eq!(decide(&spec(claude("/a")),"/a",&cat,&quotas,&spent,1000.0),Decision::Stay("limit_switch_no_room"));
    }

    #[test]
    fn engine_and_other_providers_stay() {
        let spent = Spent::default();
        let (cat,quotas) = (catalog(&["/a","/b"]),[quota("/a",10.0),quota("/b",10.0)]);
        let engine = Account::Engine { name:"kimi".into(),account:None,config_dir:None,context_window:None,context_window_unknown:false };
        assert_eq!(decide(&spec(engine),"/a",&cat,&quotas,&spent,1000.0),Decision::Stay("limit_switch_engine"));
        let mut codex = spec(claude("/a"));
        codex.provider = AgentProvider::Codex;
        assert_eq!(decide(&codex,"/a",&cat,&quotas,&spent,1000.0),Decision::Stay("limit_switch_not_claude"));
    }
}
