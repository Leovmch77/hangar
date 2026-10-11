//! Sem terminal → terminal: cria o pane do Codex com o auxiliar e o `Handoff` do 7l e espera a TUI
//! retomar a conversa. Processo, IPC e citação são do 7l; aqui só a receita do lançador e a espera.
//! Quem chama (U2) segura a vigia, fecha o cano antigo antes e mata o pane pelo nome em qualquer erro.
use super::claude_relaunch::{Consumed,Handoff,LaunchRecipe,RELAUNCH_FLAG};
use super::codex_terminal::{AppServer,app_server,loopback_endpoint};
use super::protocol::RuntimeError;
use super::{codex_launch,codex_sidecar};
use crate::accounts::environment::AccountEnvironment;
use crate::list::discover_other::truthy;
use crate::list::procs::ProcessView;
use crate::state::capture::MuxProcess;
use crate::terminal_input::TerminalIo;
use serde_json::{Map,Value};
use std::collections::BTreeMap;
use std::ffi::OsString;
use std::path::{Path,PathBuf};
use std::time::Duration;

/// `lancador.EXECUTAVEL`: o mesmo nome no PATH (no Windows, o `.cmd` do `install.ps1`).
pub const LAUNCHER:&str = "hangar-codex-tui";
/// O `_wait_terminal` do Python.
pub const TERMINAL_WAIT:Duration = Duration::from_secs(45);
/// O shell do pane leva um instante para virar o auxiliar (`exec`).
const HELPER_WAIT:Duration = Duration::from_secs(5);
const POLL:Duration = Duration::from_millis(200);

/// Pane criado e receita entregue ao auxiliar, ainda sem lançar: `consumed.start()` lança.
/// Soltar sem `start` faz o auxiliar sair e o pane morrer.
pub struct Opened { pub target:String, pub pane_pid:i64, pub consumed:Consumed }

fn refused(code:&str,message:&str) -> RuntimeError { RuntimeError::new(code,message) }

fn field<'a>(meta:&'a Value,name:&str) -> Result<&'a str,RuntimeError> {
    meta[name].as_str().filter(|v|!v.is_empty()).ok_or_else(||refused("launch_meta",&format!("sidecar sem `{name}`")))
}

/// Argv e ambiente do lançador. Só `--cwd`/`--resume` (decisão Q3): com a chave igual à do sidecar,
/// o `hangar-codex-tui` completa modelo, esforço, conta e modo dele, sem segunda cópia do
/// `comando_do_lancador`. Bloqueante (conta e configuração do Jev).
pub fn launch_command(base:&AccountEnvironment,meta:&Value) -> Result<(Vec<OsString>,BTreeMap<String,String>),RuntimeError> {
    let (cwd,thread) = (field(meta,"cwd")?,field(meta,"thread_id")?);
    let mut env = codex_launch::environment(base,meta,&codex_launch::runtime_config(base))?;
    // Marcas do cano: no lançador fariam a varredura de órfãos tomar o app-server do pane por cano.
    env.remove("HANGAR_CANO_KEY");
    env.remove("HANGAR_CANO_OWNER");
    // O que o `tmux.new_session` do Python punha no pane; o auxiliar limpa o ambiente antes de lançar.
    env.insert("CP_PROVIDER".into(),"codex".into());
    env.insert("COLORTERM".into(),"truecolor".into());
    env.insert("CLAUDE_CODE_TMUX_TRUECOLOR".into(),"1".into());
    let argv = [LAUNCHER,"--cwd",cwd,"--resume",thread].map(OsString::from).to_vec();
    Ok((argv,env))
}

/// `-e` do pane do auxiliar: só identidade e cores. O ambiente do agente vai pelo IPC privado.
pub fn public_env(name:&str,key:&str) -> Vec<(String,String)> {
    [("CP_SESSION_NAME",name),("CP_SESSION_KEY",key),("CP_PROVIDER","codex"),("COLORTERM","truecolor"),("CLAUDE_CODE_TMUX_TRUECOLOR","1")]
        .map(|(k,v)|(k.to_owned(),v.to_owned())).to_vec()
}

/// Receita montada para o `Handoff`. Executável resolvido no PATH do ambiente da conta, com a regra
/// do `shutil.which`; faltando ele ou o `codex`, recusa antes de criar o pane (`_exigir_lancador_codex`):
/// o pane morreria na hora com o `new-session` devolvendo sucesso.
pub fn launch_recipe(base:&AccountEnvironment,meta:&Value) -> Result<LaunchRecipe,RuntimeError> {
    let (argv,env) = launch_command(base,meta)?;
    let pairs:Vec<(String,String)> = env.iter().map(|(k,v)|(k.clone(),v.clone())).collect();
    let executable = super::process::resolve_program(LAUNCHER,&pairs)
        .ok_or_else(||refused("codex_launcher_missing","hangar-codex-tui não está no PATH deste servidor; instale o lançador"))?;
    if super::process::resolve_program("codex",&pairs).is_none() {
        return Err(refused("codex_cli_missing","codex não está no PATH deste servidor"));
    }
    Ok(LaunchRecipe { executable,cwd:PathBuf::from(field(meta,"cwd")?),argv,
        environ:env.into_iter().map(|(k,v)|OsString::from(format!("{k}={v}"))).collect() })
}

/// Cria o pane `name` com o auxiliar e entrega a ele a receita do lançador. `meta` é o sidecar já
/// regravado com terminal (`name`, `key`, `cwd`, `thread_id`, `codex_account`, `jev`).
pub async fn open(io:&dyn TerminalIo,mux_argv:&[String],procs:&dyn ProcessView,base:&AccountEnvironment,meta:&Value,windows:bool) -> Result<Opened,RuntimeError> {
    let (name,key) = (field(meta,"name")?.to_owned(),field(meta,"key")?.to_owned());
    let cwd = PathBuf::from(field(meta,"cwd")?);
    let (owned_base,owned_meta) = (base.clone(),meta.clone());
    let recipe = tokio::task::spawn_blocking(move||launch_recipe(&owned_base,&owned_meta)).await
        .map_err(|_|refused("codex_relaunch_recipe","montagem da receita interrompida"))??;
    let handoff = Handoff::prepare().map_err(|_|refused("relaunch_ipc","canal privado do relançamento não abriu"))?;
    let endpoint = handoff.endpoint().to_owned();
    let (target,pane_pid) = super::lifecycle::stage_session(io,mux_argv,&name,&cwd,&public_env(&name,&key),&endpoint,windows).await?;
    let exe = std::env::current_exe().map_err(|_|refused("relaunch_binary","binário do servidor ilegível"))?;
    let deadline = tokio::time::Instant::now() + HELPER_WAIT;
    let helper = loop {
        match procs.recipe(pane_pid) {
            Ok(found) if found.executable == exe && found.argv.get(1).is_some_and(|a|a == RELAUNCH_FLAG) => break found,
            _ if tokio::time::Instant::now() < deadline => tokio::time::sleep(Duration::from_millis(20)).await,
            _ => return Err(refused("relaunch_helper_identity","o pane não virou o auxiliar do relançamento")),
        }
    };
    let consumed = handoff.consume(&helper,procs,&recipe).await
        .map_err(|_|refused("relaunch_ipc_consumption","o auxiliar não recebeu a receita do lançador"))?;
    Ok(Opened { target,pane_pid,consumed })
}

/// Campos da vida pronta: terminal, mesma chave e conversa, endereço local e os dois pids.
fn ready(meta:&Map<String,Value>,key:&str,thread_id:&str) -> Option<(String,u32,u32)> {
    let text = |f:&str|meta.get(f).and_then(Value::as_str).filter(|s|!s.is_empty());
    let pid = |f:&str|meta.get(f).and_then(Value::as_u64).and_then(|p|u32::try_from(p).ok()).filter(|p|*p != 0);
    if meta.get("headless").is_some_and(truthy) || text("key") != Some(key) || text("thread_id") != Some(thread_id) { return None; }
    let endpoint = text("endpoint")?;
    loopback_endpoint(endpoint).ok()?;
    Some((endpoint.to_owned(),pid("app_pid")?,pid("tui_pid")?))
}

/// Até `within` (use `TERMINAL_WAIT`): a TUI do sidecar viva e o `app_pid` comprovado como o
/// app-server do endereço de loopback (os critérios do `codex_terminal::verify`). Devolve o sidecar
/// pronto para a adoção. O pane sumir antes é erro; multiplexador calado não é pane morto.
pub async fn wait_terminal(mux:&MuxProcess,sidecar_dir:&Path,name:&str,key:&str,thread_id:&str,within:Duration) -> Result<Map<String,Value>,RuntimeError> {
    let deadline = tokio::time::Instant::now() + within;
    let path = codex_sidecar::path(sidecar_dir,name);
    loop {
        let read = path.clone();
        let meta = tokio::task::spawn_blocking(move||codex_sidecar::load(&read)).await.ok().flatten();
        if let Some(meta) = meta && let Some((endpoint,app_pid,tui_pid)) = ready(&meta,key,thread_id) {
            let alive = tokio::task::spawn_blocking(move||super::process::argv(tui_pid).is_some()
                && app_server(app_pid,&endpoint) == AppServer::Ours).await.unwrap_or(false);
            if alive { return Ok(meta); }
        }
        if mux.has_session(name).await == Some(false) {
            return Err(refused("codex_terminal_exited","o terminal encerrou antes de retomar a conversa"));
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(refused("codex_terminal_timeout","o terminal não retomou a conversa em 45 segundos"));
        }
        tokio::time::sleep(POLL).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn base(home:&Path,path:&str) -> AccountEnvironment {
        let home = home.to_string_lossy();
        let map:BTreeMap<String,String> = [("HOME",&*home),("USERPROFILE",&*home),("PATH",path),("TMUX","/tmp/tmux-1/default,1,0"),("TMUX_PANE","%3"),
            ("OPENAI_API_KEY","sk-main"),("HANGAR_INTERNAL_SECRET","s"),("CP_AUTH_TOKEN","t")].into_iter().map(|(k,v)|(k.into(),v.into())).collect();
        AccountEnvironment::from_map(map)
    }

    fn meta() -> Value { json!({"name":"cx","key":"k1","cwd":"/work","thread_id":"t-1","jev":true,"permission_mode":"Ask for approval","model":"m"}) }

    #[test]
    fn the_launcher_gets_only_cwd_resume_and_the_session_environment() {
        let home = tempfile::tempdir().unwrap();
        let claude = home.path().join(".claude");
        std::fs::create_dir_all(&claude).unwrap();
        std::fs::write(claude.join("runtime-config.json"),json!({"jev_api_key":"k"}).to_string()).unwrap();
        let (argv,env) = launch_command(&base(home.path(),"/bin"),&meta()).unwrap();
        assert_eq!(argv,["hangar-codex-tui","--cwd","/work","--resume","t-1"].map(OsString::from),"modelo, modo e conta vêm do sidecar no lançador");
        assert_eq!((env["CP_SESSION_NAME"].as_str(),env["CP_SESSION_KEY"].as_str(),env["CP_PROVIDER"].as_str()),("cx","k1","codex"));
        assert_eq!((env["COLORTERM"].as_str(),env["CLAUDE_CODE_TMUX_TRUECOLOR"].as_str()),("truecolor","1"));
        assert_eq!(env["CODEX_HOME"],home.path().join(".codex").to_string_lossy());
        assert_eq!((env["HANGAR_JEV"].as_str(),env["TYPESAFE_API_KEY"].as_str()),("on","k"),"Jev relido da configuração");
        for gone in ["TMUX","TMUX_PANE","HANGAR_CANO_KEY","HANGAR_CANO_OWNER","HANGAR_INTERNAL_SECRET","CP_AUTH_TOKEN"] {
            assert!(!env.contains_key(gone),"{gone}");
        }
        for missing in ["cwd","thread_id","name","key"] {
            let mut bad = meta();
            bad.as_object_mut().unwrap().remove(missing);
            assert_eq!(launch_command(&base(home.path(),"/bin"),&bad).unwrap_err().code,"launch_meta","{missing}");
        }
    }

    /// O `-e` do pane fica dentro da allowlist do `stage_session` e não leva segredo nem conta.
    #[test]
    fn the_pane_environment_is_identity_and_colors_only() {
        let env = public_env("cx","k1");
        let allowed = ["CP_SESSION_KEY","CP_SESSION_NAME","CP_PROVIDER","COLORTERM","CLAUDE_CODE_TMUX_TRUECOLOR","CLAUDE_CODE_NO_FLICKER","CP_HEADLESS"];
        assert!(env.iter().all(|(k,_)|allowed.contains(&k.as_str())),"{env:?}");
        assert_eq!(env,[("CP_SESSION_NAME","cx"),("CP_SESSION_KEY","k1"),("CP_PROVIDER","codex"),("COLORTERM","truecolor"),("CLAUDE_CODE_TMUX_TRUECOLOR","1")]
            .map(|(k,v)|(k.to_owned(),v.to_owned())));
    }

    #[cfg(unix)]
    #[test]
    fn the_recipe_resolves_the_launcher_on_the_account_path_or_refuses() {
        use std::os::unix::fs::PermissionsExt;
        let home = tempfile::tempdir().unwrap();
        let bin = home.path().join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        let path = bin.to_string_lossy().into_owned();
        assert_eq!(launch_recipe(&base(home.path(),&path),&meta()).err().unwrap().code,"codex_launcher_missing");
        for exe in [LAUNCHER,"codex"] {
            std::fs::write(bin.join(exe),"#!/bin/sh\n").unwrap();
            std::fs::set_permissions(bin.join(exe),std::fs::Permissions::from_mode(0o755)).unwrap();
            if exe == LAUNCHER { assert_eq!(launch_recipe(&base(home.path(),&path),&meta()).err().unwrap().code,"codex_cli_missing"); }
        }
        let recipe = launch_recipe(&base(home.path(),&path),&meta()).unwrap();
        assert_eq!(recipe.executable,bin.join(LAUNCHER));
        assert_eq!(recipe.cwd,PathBuf::from("/work"));
        assert_eq!(recipe.argv[0],LAUNCHER);
        assert!(recipe.environ.contains(&OsString::from("CP_SESSION_KEY=k1")));
        assert!(!recipe.environ.iter().any(|e|e.to_string_lossy().starts_with("TMUX=")));
    }

    #[test]
    fn ready_needs_the_same_life_a_local_endpoint_and_both_pids() {
        let ok = json!({"name":"cx","key":"k1","thread_id":"t-1","endpoint":"ws://127.0.0.1:4500","app_pid":7,"tui_pid":9,"headless":false});
        let as_map = |v:&Value|v.as_object().unwrap().clone();
        assert_eq!(ready(&as_map(&ok),"k1","t-1"),Some(("ws://127.0.0.1:4500".into(),7,9)));
        for (field,value) in [("headless",json!(true)),("key",json!("k2")),("thread_id",json!("t-2")),("endpoint",json!("ws://example.com:4500")),
            ("endpoint",Value::Null),("app_pid",Value::Null),("tui_pid",json!(0))] {
            let mut bad = ok.clone();
            bad[field] = value;
            assert_eq!(ready(&as_map(&bad),"k1","t-1"),None,"{field}");
        }
    }
}
