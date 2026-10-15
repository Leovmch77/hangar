//! Painel da fila: a lista das mensagens que esperam a vez no Hangar, na ordem de entrega, para todos os
//! aparelhos do chat. Lida da projeção da fila (o mesmo arquivo do `/history`) e publicada pelo hub como evento
//! `queue`. `actions` diz se o Rust escreve nesta sessão: sem ele (terminal que o Rust não assumiu, entrada
//! doente), o painel aparece sem botões. `removed` leva as que esperavam na publicação anterior e sumiram da
//! projeção (apagadas noutro aparelho): todo aparelho retira a bolha `queued-<id>` delas.
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::{Arc, Weak};
use std::time::Duration;

use serde_json::{Value, json};
use tokio::sync::Notify;

use crate::side::{Binding, Hub, SideCtx};
use crate::tail::Subscription;
use crate::transcript::history::{self, QueuePanel};

pub const EVENT: &str = "queue";
/// Releitura sem aviso do observador: cobre a pasta que ainda não existia e a troca de dono da sessão.
const REREAD: Duration = Duration::from_secs(5);

pub fn payload(entries: &[Value], actions: bool) -> Value {
    json!({"entries": entries, "actions": actions})
}

/// As que esperavam na última publicação e já não estão na projeção, em qualquer estado.
fn removed(before: &[String], present: &HashSet<String>) -> Vec<String> {
    before.iter().filter(|id| !present.contains(*id)).cloned().collect()
}

/// Uma por hub; acaba quando o hub fecha. Republica só o que mudou; a troca de conversa (o `rebind` limpa o
/// retrato e acorda esta tarefa) republica mesmo igual. O caminho da fila vem do hub (`learn_queue`): sem
/// ele, espera o aviso, sem perguntar a descoberta. Fila sem escrita nova não se relê, e a saúde da escrita
/// só se sonda no tique ou quando a fila mudou.
pub async fn watch(hub: Weak<Hub>, ctx: SideCtx, wake: Arc<Notify>) {
    let mut subscription: Option<Subscription> = None;
    let mut bound: Option<((u64, Binding), PathBuf)> = None;
    let mut last: Option<String> = None;
    let mut waiting: Vec<String> = Vec::new();
    // Carimbo da fila e início da conversa da última leitura boa, e o painel dela.
    let mut read_key: Option<(Option<String>, f64)> = None;
    let mut panel: Option<QueuePanel> = None;
    // O início da conversa não muda depois de achado: só se procura enquanto o transcript não o tem.
    let mut start_ts = 0.0;
    // Tempo esgotado no retrato do ator (entregando) mantém os botões como estavam.
    let mut actions = false;
    let mut ticked = true;
    loop {
        let Some(live) = hub.upgrade() else { return };
        let Some(current) = live.source_binding() else { return };
        let path = live.queue_path();
        let key = path.clone().map(|path| (current.clone(), path));
        if bound != key {
            subscription = path.map(|path| Subscription::new(ctx.watchers.clone(), path, wake.clone()));
            last = None;
            waiting.clear();
            read_key = None;
            panel = None;
            start_ts = 0.0;
            bound = key;
        }
        if let Some(sub) = subscription.as_mut() {
            sub.arm();
            let (path, jsonl, known, previous) = (sub.path.clone(), current.1.jsonl.clone(), start_ts, read_key.clone());
            let read = tokio::task::spawn_blocking(move || {
                let start = if known > 0.0 { known } else { history::transcript_start_ts(&jsonl) };
                let key = (history::stamp(&path), start);
                let fresh = (previous.as_ref() != Some(&key)).then(|| history::queue_panel_entries(&path, start));
                (key, fresh)
            });
            let probe = ticked || read_key.is_none();
            let health = async {
                match ctx.runtime.get() {
                    Some(registry) if probe => Some(registry.write_health(&live.name).await.unwrap_or(actions)),
                    Some(_) => None,
                    None => Some(false),
                }
            };
            let (read, health) = tokio::join!(read, health);
            let mut changed = health.is_some();
            if let Some(health) = health { actions = health; }
            match read {
                Ok((_, None)) => {}
                Ok((key, Some(Ok(fresh)))) => {
                    if !probe && let Some(registry) = ctx.runtime.get() {
                        actions = registry.write_health(&live.name).await.unwrap_or(actions);
                    }
                    start_ts = key.1;
                    read_key = Some(key);
                    panel = Some(fresh);
                    changed = true;
                }
                _ => {
                    if crate::warn_limit::allow(Some(&live.name), "queue_panel_unreadable") {
                        tracing::warn!(session = %live.name, code = "queue_panel_unreadable", "a fila não se leu; o painel fica com a última lista");
                    }
                }
            }
            if let (true, Some(panel)) = (changed, &panel) {
                let data = payload(&panel.entries, actions);
                let text = data.to_string();
                let gone = removed(&waiting, &panel.present);
                if last.as_deref() != Some(text.as_str()) || !gone.is_empty() {
                    let mut out = data;
                    out["removed"] = json!(gone);
                    if live.publish_own_bound(&current, EVENT, &out.to_string()) {
                        last = Some(text);
                        waiting = panel.entries.iter().filter_map(|e| e["id"].as_str().map(str::to_owned)).collect();
                    }
                }
            }
        }
        drop(live);
        ticked = tokio::select! {
            _ = wake.notified() => false,
            _ = tokio::time::sleep(REREAD) => true,
        };
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn removed_lists_only_the_waiting_that_left_the_projection() {
        let before = vec!["a".to_string(), "b".to_string(), "c".to_string()];
        // `b` virou entregue (continua na projeção); `c` foi apagada.
        let present: HashSet<String> = ["a", "b"].into_iter().map(str::to_owned).collect();
        assert_eq!(removed(&before, &present), ["c"]);
        assert!(removed(&[], &present).is_empty());
    }
}
