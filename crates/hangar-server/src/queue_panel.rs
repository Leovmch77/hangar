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
use crate::tail::Watchers;

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

/// Inscrição na pasta da fila que sai junto com a tarefa ou com a troca de conversa.
struct Subscription {
    watchers: Watchers,
    path: PathBuf,
    wake: Arc<Notify>,
    armed: bool,
}

impl Subscription {
    /// Pasta que ainda não existe não arma; cada volta tenta de novo.
    fn arm(&mut self) {
        if !self.armed {
            self.armed = self.watchers.subscribe(&self.path, &self.wake);
        }
    }
}

impl Drop for Subscription {
    fn drop(&mut self) {
        if self.armed {
            self.watchers.unsubscribe(&self.path, &self.wake);
        }
    }
}

/// Uma por hub; acaba quando o hub fecha. Republica só o que mudou; a troca de conversa (o `rebind` limpa o
/// retrato e acorda esta tarefa) republica mesmo igual. O caminho da fila vem do hub (`learn_queue`): sem
/// ele, espera o aviso, sem perguntar a descoberta.
pub async fn watch(hub: Weak<Hub>, ctx: SideCtx, wake: Arc<Notify>) {
    let mut subscription: Option<Subscription> = None;
    let mut bound: Option<((u64, Binding), PathBuf)> = None;
    let mut last: Option<String> = None;
    let mut waiting: Vec<String> = Vec::new();
    // Tempo esgotado no retrato do ator (entregando) mantém os botões como estavam.
    let mut actions = false;
    loop {
        let Some(live) = hub.upgrade() else { return };
        let Some(current) = live.source_binding() else { return };
        let path = live.queue_path();
        let key = path.clone().map(|path| (current.clone(), path));
        if bound != key {
            subscription = path.map(|path| Subscription { watchers: ctx.watchers.clone(), path, wake: wake.clone(), armed: false });
            last = None;
            waiting.clear();
            bound = key;
        }
        if let Some(sub) = subscription.as_mut() {
            sub.arm();
            let (path, jsonl) = (sub.path.clone(), current.1.jsonl.clone());
            let read = tokio::task::spawn_blocking(move || crate::transcript::history::queue_panel_entries(&path, &jsonl)).await;
            actions = match ctx.runtime.get() {
                Some(registry) => registry.write_health(&live.name).await.unwrap_or(actions),
                None => false,
            };
            match read {
                Ok(Ok(panel)) => {
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
                _ => {
                    if crate::warn_limit::allow(Some(&live.name), "queue_panel_unreadable") {
                        tracing::warn!(session = %live.name, code = "queue_panel_unreadable", "a fila não se leu; o painel fica com a última lista");
                    }
                }
            }
        }
        drop(live);
        tokio::select! {
            _ = wake.notified() => {}
            _ = tokio::time::sleep(REREAD) => {}
        }
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
