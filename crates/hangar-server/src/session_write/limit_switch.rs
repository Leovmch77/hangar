//! D-002: a sessão Claude que para no limite de uso da conta reabre sozinha na conta de mais folga, pela
//! mesma reabertura do `/conta`, e recebe pela fila um recado para continuar de onde parou.
use std::collections::BTreeMap;
use std::sync::{Arc,Mutex};

use futures_util::future::BoxFuture;
use serde_json::Value;

use crate::routes::AppState;
use crate::runtime::gateway::{LimitHit,RuntimeRegistry};
use crate::runtime::protocol::UsageLimit;
use crate::session_open::{Account,AccountSource,AgentProvider,ChangeReason,SessionSpec};

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
        else if last["apiError"].is_null() && last["error"] == "rate_limit" && last["quotaLimits"]["status"] == "rejected" { &last["quotaLimits"] }
        else { return None };
    let limit = UsageLimit::from_info(info);
    limit.resets_at.is_none_or(|reset|reset > now).then_some(limit)
}

/// O fim do arquivo basta: depois do aviso só vêm linhas de controle curtas.
const TAIL_BYTES:u64 = 64 * 1024;

pub fn file_limit(path:&std::path::Path,now:f64) -> Option<UsageLimit> {
    use std::io::{Read,Seek,SeekFrom};
    let mut file = std::fs::File::open(path).ok()?;
    let size = file.metadata().ok()?.len();
    file.seek(SeekFrom::Start(size.saturating_sub(TAIL_BYTES))).ok()?;
    let mut tail = Vec::new();
    file.read_to_end(&mut tail).ok()?;
    transcript_limit(&String::from_utf8_lossy(&tail),now)
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

/// Vai à sessão pela fila, depois de reaberta: sem ele a conversa ficaria parada no aviso de limite.
pub const CONTINUE:&str = "O limite de uso da conta anterior acabou e esta sessão foi reaberta em outra conta. Continue de onde parou.";

/// Janela sem reset conhecido fica gasta por cinco horas, a menor das janelas.
const UNKNOWN_RESET_S:f64 = 5.0 * 3600.0;

/// Resultado da reabertura pedida ao servidor.
#[derive(Debug,PartialEq)]
pub enum Reopen { Done, NotRust, Failed(String) }

/// O que a troca usa do servidor; nos testes, um falso que registra as chamadas.
pub trait Host: Send + Sync {
    fn spec<'a>(&'a self,name:&'a str) -> BoxFuture<'a,Option<Result<SessionSpec,String>>>;
    fn current_dir(&self,spec:&SessionSpec) -> String;
    fn catalog(&self) -> Result<Value,String>;
    fn quotas(&self) -> BoxFuture<'_,Result<Vec<Value>,String>>;
    fn reopen<'a>(&'a self,name:&'a str,spec:&'a SessionSpec,path:&'a str) -> BoxFuture<'a,Reopen>;
    fn deliver<'a>(&'a self,name:&'a str,text:&'a str) -> BoxFuture<'a,Result<(),String>>;
    fn diary(&self,name:&str,code:&str,reason:&'static str);
    fn now(&self) -> f64;
}

#[derive(Default)]
struct Switcher {
    spent:Spent,
    /// O último limite tratado por sessão: o mesmo aviso relido não troca de conta duas vezes.
    handled:Mutex<BTreeMap<String,UsageLimit>>,
}

enum Outcome { Switched { label:String, explicit:bool }, Stayed(&'static str), Failed(String) }

impl Switcher {
    fn first_time(&self,name:&str,limit:&UsageLimit) -> bool {
        self.handled.lock().is_ok_and(|mut handled|handled.insert(name.to_owned(),limit.clone()).as_ref() != Some(limit))
    }

    async fn switch(&self,host:&dyn Host,hit:&LimitHit) -> Outcome {
        if hit.provider != "claude" { return Outcome::Stayed("limit_switch_not_claude"); }
        let spec = match host.spec(&hit.name).await {
            None=>return Outcome::Stayed("limit_switch_not_rust"),
            Some(Err(code))=>return Outcome::Failed(code),
            Some(Ok(spec))=>spec,
        };
        if matches!(spec.account,Account::Engine{..}) { return Outcome::Stayed("limit_switch_engine"); }
        let now = host.now();
        let current = host.current_dir(&spec);
        self.spent.mark(&current,hit.limit.resets_at.filter(|reset|*reset > now).unwrap_or(now + UNKNOWN_RESET_S));
        let catalog = match host.catalog() { Ok(catalog)=>catalog, Err(code)=>return Outcome::Failed(code) };
        let quotas = match host.quotas().await { Ok(quotas)=>quotas, Err(code)=>return Outcome::Failed(code) };
        let (path,label) = match decide(&spec,&current,&catalog,&quotas,&self.spent,now) {
            Decision::Switch { path,label }=>(path,label),
            Decision::Stay(code)=>return Outcome::Stayed(code),
        };
        match host.reopen(&hit.name,&spec,&path).await {
            Reopen::NotRust=>return Outcome::Stayed("limit_switch_not_rust"),
            Reopen::Failed(code)=>return Outcome::Failed(code),
            Reopen::Done=>{},
        }
        if let Err(code) = host.deliver(&hit.name,CONTINUE).await {
            return Outcome::Failed(format!("limit_switch_continue_{code}"));
        }
        Outcome::Switched { label,explicit:spec.account_source == AccountSource::Explicit }
    }

    async fn handle(&self,host:&dyn Host,hit:LimitHit) {
        if !self.first_time(&hit.name,&hit.limit) { return; }
        let outcome = self.switch(host,&hit).await;
        let report = |code:&str,reason:&'static str|host.diary(&hit.name,&super::input::diary_code(code),reason);
        match outcome {
            Outcome::Switched { label,explicit } => {
                tracing::info!(session=%hit.name,window=%hit.limit.window,to=%label,explicit,"limite de uso: sessão reaberta em outra conta");
                report("switched","limite de uso: a sessão reabriu na conta de mais folga e recebeu o recado para continuar");
                // O limite vence a conta escolhida pela pessoa, e isso fica registrado.
                if explicit { report("explicit_account","limite de uso: a conta escolhida pela pessoa foi trocada"); }
            }
            Outcome::Stayed("limit_switch_no_room") => {
                tracing::warn!(session=%hit.name,window=%hit.limit.window,"limite de uso: nenhuma conta com folga; a sessão fica parada");
                report("limit_switch_no_room","limite de uso: nenhuma conta Claude com folga; a sessão fica parada até o reset");
            }
            Outcome::Stayed(code) => tracing::info!(session=%hit.name,code,"limite de uso sem troca de conta"),
            Outcome::Failed(code) => {
                tracing::warn!(session=%hit.name,%code,"limite de uso: a troca de conta falhou");
                report(&code,"limite de uso: a troca de conta falhou; a sessão fica parada");
            }
        }
    }
}

/// O vigia que recebe do runtime as sessões paradas no limite, uma troca por vez: duas sessões batendo o
/// limite juntas não escolhem a mesma conta sem ver a outra gasta.
pub fn spawn(st:Arc<AppState>) -> Option<tokio::task::JoinHandle<()>> {
    let runtime = st.state.runtime.get()?.clone();
    let (sink,mut hits) = tokio::sync::mpsc::unbounded_channel();
    runtime.set_limit_sink(sink);
    let switcher = Switcher::default();
    let host = Native { st,runtime };
    Some(tokio::spawn(async move {
        while let Some(hit) = hits.recv().await { switcher.handle(&host,hit).await; }
    }))
}

struct Native { st:Arc<AppState>, runtime:Arc<RuntimeRegistry> }

impl Host for Native {
    fn spec<'a>(&'a self,name:&'a str) -> BoxFuture<'a,Option<Result<SessionSpec,String>>> {
        Box::pin(async move { self.runtime.claude_spec(name).await.map(|spec|spec.map_err(|error|error.code)) })
    }
    fn current_dir(&self,spec:&SessionSpec) -> String { super::account::current_dir(&self.runtime,spec) }
    fn catalog(&self) -> Result<Value,String> { self.st.accounts.claude_catalog().map_err(|error|error.code.into()) }
    fn quotas(&self) -> BoxFuture<'_,Result<Vec<Value>,String>> {
        Box::pin(async move {
            let quotas = self.st.accounts.quotas(None,false,true).await.map_err(|error|error.code.to_string())?;
            Ok(quotas.as_array().into_iter().flatten().filter(|row|row["provedor"]=="claude").cloned().collect())
        })
    }
    fn reopen<'a>(&'a self,name:&'a str,spec:&'a SessionSpec,path:&'a str) -> BoxFuture<'a,Reopen> {
        Box::pin(async move {
            match super::account::reopen_in(&self.st,&self.runtime,name,spec,path,false,ChangeReason::LimitSwitch).await {
                None=>Reopen::NotRust,
                Some(Err(failure))=>Reopen::Failed(failure.error.code),
                Some(Ok(_))=>Reopen::Done,
            }
        })
    }
    fn deliver<'a>(&'a self,name:&'a str,text:&'a str) -> BoxFuture<'a,Result<(),String>> {
        Box::pin(async move {
            super::input::deliver_text(&self.st,name,text).await.map_err(|detail|detail["code"].as_str().unwrap_or("failed").to_owned())
        })
    }
    fn diary(&self,name:&str,code:&str,reason:&'static str) { self.st.diag.report("session.limit_switch",name,code,reason); }
    fn now(&self) -> f64 { crate::state::monitor::wall_now() }
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
        let mut other:Value = serde_json::from_str(FIVE_HOUR.trim()).unwrap();
        other["apiError"] = json!("overloaded");
        assert_eq!(transcript_limit(&other.to_string(),1791570000.0),None,"a reserva da cota recusada é só do CLI sem apiError");
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
    fn the_same_limit_read_again_does_not_switch_twice() {
        let switcher = Switcher::default();
        let limit = UsageLimit { window:"five_hour".into(),resets_at:Some(1000.0) };
        assert!(switcher.first_time("s",&limit));
        assert!(!switcher.first_time("s",&limit),"o plugin e o ator podem avisar o mesmo fim de turno");
        assert!(switcher.first_time("s",&UsageLimit { window:"five_hour".into(),resets_at:Some(2000.0) }),"a conta nova bateu o dela");
        assert!(switcher.first_time("other",&limit));
    }

    #[tokio::test]
    async fn the_runtime_hands_the_stopped_session_to_the_switcher() {
        let runtime = crate::runtime::gateway::RuntimeRegistry::new("127.0.0.1:9".parse().unwrap(),"s".into(),"i".into());
        let limit = UsageLimit { window:"seven_day".into(),resets_at:None };
        runtime.usage_limit("lost","claude",limit.clone());
        let (sink,mut hits) = tokio::sync::mpsc::unbounded_channel();
        runtime.set_limit_sink(sink);
        runtime.usage_limit("s1","codex",limit.clone());
        let hit = hits.try_recv().unwrap();
        assert_eq!((hit.name.as_str(),hit.provider.as_str(),hit.limit),("s1","codex",limit));
        assert!(hits.try_recv().is_err());
    }

    struct Fake {
        spec:Mutex<SessionSpec>,
        catalog:Value,
        quotas:Mutex<Result<Vec<Value>,String>>,
        /// Respostas da reabertura, na ordem; vazia = feita.
        reopens:Mutex<Vec<Reopen>>,
        log:Mutex<Vec<String>>,
        diary:Mutex<Vec<String>>,
    }

    impl Fake {
        fn new(dir:&str,quotas:Vec<Value>) -> Self {
            Fake { spec:Mutex::new(spec(claude(dir))),catalog:catalog(&["/a","/b","/c"]),quotas:Mutex::new(Ok(quotas)),
                reopens:Mutex::new(Vec::new()),log:Mutex::new(Vec::new()),diary:Mutex::new(Vec::new()) }
        }
        fn log(&self) -> Vec<String> { self.log.lock().unwrap().clone() }
        fn diary(&self) -> Vec<String> { self.diary.lock().unwrap().clone() }
    }

    impl Host for Fake {
        fn spec<'a>(&'a self,_:&'a str) -> BoxFuture<'a,Option<Result<SessionSpec,String>>> {
            Box::pin(async move { Some(Ok(self.spec.lock().unwrap().clone())) })
        }
        fn current_dir(&self,spec:&SessionSpec) -> String { spec.account.config_dir().unwrap_or("/default").to_owned() }
        fn catalog(&self) -> Result<Value,String> { Ok(self.catalog.clone()) }
        fn quotas(&self) -> BoxFuture<'_,Result<Vec<Value>,String>> { Box::pin(async move { self.quotas.lock().unwrap().clone() }) }
        fn reopen<'a>(&'a self,_:&'a str,_:&'a SessionSpec,path:&'a str) -> BoxFuture<'a,Reopen> {
            Box::pin(async move {
                self.log.lock().unwrap().push(format!("reopen {path}"));
                let mut reopens = self.reopens.lock().unwrap();
                let outcome = if reopens.is_empty() { Reopen::Done } else { reopens.remove(0) };
                if outcome == Reopen::Done { *self.spec.lock().unwrap() = spec(claude(path)); }
                outcome
            })
        }
        fn deliver<'a>(&'a self,_:&'a str,text:&'a str) -> BoxFuture<'a,Result<(),String>> {
            Box::pin(async move { self.log.lock().unwrap().push(format!("deliver {text}")); Ok(()) })
        }
        fn diary(&self,_:&str,code:&str,_:&'static str) { self.diary.lock().unwrap().push(code.to_owned()); }
        fn now(&self) -> f64 { 1000.0 }
    }

    fn hit(reset:f64) -> LimitHit {
        LimitHit { name:"s".into(),provider:"claude".into(),limit:UsageLimit { window:"five_hour".into(),resets_at:Some(reset) } }
    }

    #[tokio::test]
    async fn the_stopped_session_reopens_in_the_roomiest_account_and_is_told_to_continue() {
        let fake = Fake::new("/a",vec![quota("/a",100.0),quota("/b",60.0),quota("/c",20.0)]);
        Switcher::default().handle(&fake,hit(2000.0)).await;
        assert_eq!(fake.log(),vec!["reopen /c".to_owned(),format!("deliver {CONTINUE}")]);
        assert_eq!(fake.diary(),vec!["switched"]);
    }

    #[tokio::test]
    async fn an_unreadable_quota_is_a_failure_with_its_code_not_no_room() {
        let fake = Fake::new("/a",Vec::new());
        *fake.quotas.lock().unwrap() = Err("quota_read_failed".into());
        Switcher::default().handle(&fake,hit(2000.0)).await;
        assert!(fake.log().is_empty());
        assert_eq!(fake.diary(),vec!["quota_read_failed"]);
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
