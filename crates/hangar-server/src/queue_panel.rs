//! Painel da fila: a lista das mensagens que esperam a vez no Hangar, na ordem de entrega, para todos os
//! aparelhos do chat. Lida da projeção da fila (o mesmo arquivo do `/history`) e publicada pelo hub como evento
//! `queue`. `actions` diz se o Rust escreve nesta sessão: sem ele (terminal que o Rust não assumiu, entrada
//! doente), o painel aparece sem botões.
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

pub fn payload(entries: Vec<Value>, actions: bool) -> Value {
    json!({"entries": entries, "actions": actions})
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
/// retrato e acorda esta tarefa) republica mesmo igual.
pub async fn watch(hub: Weak<Hub>, ctx: SideCtx, wake: Arc<Notify>) {
    let mut subscription: Option<Subscription> = None;
    let mut bound: Option<(u64, Binding)> = None;
    let mut last: Option<String> = None;
    loop {
        let Some(live) = hub.upgrade() else { return };
        let Some(current) = live.source_binding() else { return };
        if bound.as_ref() != Some(&current) {
            subscription = None;
            last = None;
            // Descoberta fora: nada a ler ainda; a próxima volta pergunta de novo.
            if let Ok(info) = ctx.info(&live.name).await {
                let path = info.as_ref().and_then(|info| info.history.get("queue")).and_then(Value::as_str).map(PathBuf::from);
                subscription = path.map(|path| Subscription { watchers: ctx.watchers.clone(), path, wake: wake.clone(), armed: false });
                bound = Some(current.clone());
            }
        }
        if let Some(sub) = subscription.as_mut() {
            sub.arm();
            let (path, jsonl) = (sub.path.clone(), current.1.jsonl.clone());
            let read = tokio::task::spawn_blocking(move || crate::transcript::history::queue_panel_entries(&path, &jsonl)).await;
            let actions = match ctx.runtime.get() {
                Some(registry) => registry.writable(&live.name).await.is_some_and(|target| target.healthy),
                None => false,
            };
            match read {
                Ok(Ok(entries)) => {
                    let data = payload(entries, actions).to_string();
                    if last.as_deref() != Some(data.as_str()) && live.publish_own_bound(&current, EVENT, &data) {
                        last = Some(data);
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
