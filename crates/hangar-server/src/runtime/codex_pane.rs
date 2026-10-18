//! Sem terminal → terminal: espera a TUI que o lançador único (`session_open::terminal`) pôs no pane
//! retomar a conversa. Quem chama (U2) segura a vigia, fecha o cano antigo antes e mata o pane pelo nome
//! em qualquer erro.
use super::codex_terminal::{AppServer,app_server,loopback_endpoint};
use super::protocol::RuntimeError;
use super::codex_sidecar;
use crate::list::discover_other::truthy;
use crate::state::capture::MuxProcess;
use serde_json::{Map,Value};
use std::path::Path;
use std::time::Duration;

/// O `_wait_terminal` do Python.
pub const TERMINAL_WAIT:Duration = Duration::from_secs(45);
const POLL:Duration = Duration::from_millis(200);

fn refused(code:&str,message:&str) -> RuntimeError { RuntimeError::new(code,message) }

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
