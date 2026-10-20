//! Liberar a conta antes de apagar: sessão do Hangar vai para outra conta com login e folga; o que
//! sobra segurando a conta (terminal de login esquecido, processo solto) é encerrado.
use super::{AccountKey, UsageFacts, catalog::{Account, AccountError}};
use crate::list::procs::{ChildrenMap, ProcessView};
use serde_json::{Value, json};
use std::{collections::BTreeSet, sync::Arc, time::Duration};

/// O pai de `pid` no retrato de processos.
fn parent(map: &ChildrenMap, pid: i64) -> Option<i64> {
    map.iter().find(|(_, children)| children.contains(&pid)).map(|(parent, _)| *parent)
}

/// A sessão do multiplexador que hospeda `pid`: o `-s <nome>` do servidor psmux/tmux acima dele.
fn mux_session(procs: &dyn ProcessView, map: &ChildrenMap, pid: i64) -> Option<String> {
    let mut current = Some(pid);
    for _ in 0..8 {
        let at = current?;
        let argv = procs.argv_checked(at).unwrap_or_default();
        let server = argv.iter().any(|a| a == "server");
        if let Some(name) = argv.windows(2).find(|w| w[0] == "-s").map(|w| w[1].clone()).filter(|_| server) {
            return Some(name);
        }
        current = parent(map, at);
    }
    None
}

/// O Hangar e quem o subiu nunca entram na conta a encerrar, mesmo herdando a variável dela.
fn own_line(map: &ChildrenMap) -> BTreeSet<i64> {
    let mut line = BTreeSet::new();
    let mut current = Some(i64::from(std::process::id()));
    while let Some(pid) = current.filter(|pid| *pid > 1 && line.insert(*pid)) {
        current = parent(map, pid);
    }
    line
}

struct Holder {
    pid: u32,
    name: Option<String>,
    session: Option<String>,
}

fn holders(facts: &UsageFacts) -> Vec<Holder> {
    let procs = crate::list::procs::SystemProcs::whole_machine();
    let map = procs.children(Duration::ZERO).unwrap_or_default();
    let own = own_line(&map);
    let pids: BTreeSet<u32> = facts.pids.iter().chain(&facts.holders).copied().collect();
    pids.into_iter().filter(|pid| !own.contains(&i64::from(*pid))).map(|pid| Holder {
        pid,
        name: procs.name(i64::from(pid)).ok(),
        session: mux_session(&procs, &map, i64::from(pid)),
    }).collect()
}

/// O que segura a conta, para a tela perguntar antes de liberar. E/S bloqueante.
pub(crate) fn describe(facts: &UsageFacts) -> Value {
    let processes: Vec<Value> = holders(facts).into_iter()
        .map(|h| json!({"pid": h.pid, "nome": h.name, "sessao": h.session})).collect();
    json!({"sessoes": facts.sessions, "processos": processes})
}

fn refused(code: &'static str, message: String) -> AccountError {
    AccountError::new(409, code, message, json!({}))
}

fn session_refused(name: &str, why: &str) -> AccountError {
    AccountError::new(409, "erro_liberar_sessao", format!("a sessão '{name}' não foi para outra conta: {why}"),
        json!({"sessao": name, "erro": why}))
}

/// Leva as sessões do Hangar da conta para a de mais folga com login e encerra o resto que a segura.
/// Chamar sem a guarda exclusiva: a reabertura passa pela guarda da conta de destino.
pub(crate) async fn release(state: &Arc<crate::routes::AppState>, account: &Account, key: &AccountKey) -> Result<(), AccountError> {
    let service = &state.accounts;
    let runtime = state.state.runtime.get().cloned();
    let read = || super::bridge::settle_usage(|| service.usage(runtime.as_deref(), key), Duration::from_secs(10));
    let facts = read().await;
    if !facts.sessions.is_empty() {
        let runtime = runtime.clone().ok_or_else(|| refused("erro_liberar_conta", "o runtime não está de pé para levar as sessões".into()))?;
        let catalog = service.claude_catalog()?;
        let quotas = service.quotas(None, false, true).await.unwrap_or(Value::Null);
        let quotas: Vec<Value> = quotas.as_array().into_iter().flatten().filter(|row| row["provedor"] == "claude").cloned().collect();
        let current = account.home.to_string_lossy().into_owned();
        let destination = crate::session_write::account::targets(&catalog, &quotas, Some(&current),
            |path| super::claude_refresh::has_login(std::path::Path::new(path)))
            .into_iter().find(|t| t["login"] == true && t["full"] == false)
            .and_then(|t| t["path"].as_str().map(str::to_owned))
            .ok_or_else(|| refused("erro_sem_conta_destino", "nenhuma outra conta com login e folga para levar as sessões".into()))?;
        for name in &facts.sessions {
            let spec = match runtime.claude_spec(name).await {
                Some(Ok(spec)) => spec,
                _ => return Err(session_refused(name, "ela não é uma sessão Claude do Hangar; feche-a e tente de novo")),
            };
            match crate::session_write::account::reopen_in(state, &runtime, name, &spec, &destination, false,
                crate::session_open::ChangeReason::AccountSwitch).await {
                Some(Ok(_)) => tracing::info!(session = %name, code = "account_release_moved", "sessão levada para outra conta antes de apagar"),
                Some(Err(failure)) => return Err(session_refused(name, &failure.error.message)),
                None => return Err(session_refused(name, "ela não é uma sessão Claude do Hangar; feche-a e tente de novo")),
            }
        }
    }
    let facts = read().await;
    let found = tokio::task::spawn_blocking(move || holders(&facts)).await.unwrap_or_default();
    let mux = crate::state::capture::MuxProcess::new("tmux", Duration::from_secs(5));
    let sessions: BTreeSet<&str> = found.iter().filter_map(|h| h.session.as_deref()).collect();
    for session in sessions {
        let closed = mux.kill_session(session).await;
        tracing::info!(session, ?closed, code = "account_release_mux", "terminal preso na conta encerrado antes de apagar");
    }
    for holder in found.iter().filter(|h| h.session.is_none()) {
        if let Err(error) = crate::runtime::process::terminate(holder.pid) {
            tracing::warn!(pid = holder.pid, ?error, code = "account_release_kill_failed", "processo preso na conta não encerrou");
        }
    }
    // A exclusão relê os fatos sob a guarda: o que não saiu aparece lá como uso.
    for _ in 0..20 {
        let facts = read().await;
        if facts.pids.is_empty() && facts.holders.is_empty() { break; }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    Ok(())
}
