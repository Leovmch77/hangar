//! Estado compacto do envio terminal, compartilhado apenas com os leitores da sessão.
use serde_json::Value;
use tokio::sync::watch;

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct TerminalStatus {
    pub error: Option<String>,
    pub message: Option<String>,
    pub input_stalled: Option<String>,
    /// A troca por limite de uso que não aconteceu: (código, detalhe). Fica até a próxima troca.
    pub limit: Option<(String, String)>,
}

pub type StatusSender = watch::Sender<TerminalStatus>;
pub type StatusReceiver = watch::Receiver<TerminalStatus>;

pub(crate) fn publish_snapshot(sender: &StatusSender, data: &Value) {
    let error = data["error"].as_str().map(str::to_owned);
    let input_stalled = data["view"]["input_stalled"].as_str().map(str::to_owned);
    sender.send_if_modified(|current| {
        let message = current.message.clone().filter(|_| error.is_some() && error == current.error);
        let next = TerminalStatus { error, message, input_stalled, limit: current.limit.clone() };
        if *current == next { return false; }
        *current = next;
        true
    });
}

pub(crate) fn publish_problem(sender: &StatusSender, code: &str, message: &str) {
    sender.send_if_modified(|current| {
        if current.error.as_deref() == Some(code) && current.message.as_deref() == Some(message) { return false; }
        current.error = Some(code.to_owned());
        current.message = Some(message.to_owned());
        true
    });
}

pub(crate) fn publish_limit(sender: &StatusSender, limit: Option<(String, String)>) {
    sender.send_if_modified(|current| {
        if current.limit == limit { return false; }
        current.limit = limit;
        true
    });
}

/// Uma saída inesperada não pode deixar o monitor mostrando o último estado saudável.
pub(crate) struct PanicMark(pub Option<StatusSender>);

impl Drop for PanicMark {
    fn drop(&mut self) {
        if let Some(sender) = &self.0 {
            publish_problem(sender, "runtime_panic", "o ator do runtime caiu");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn snapshots_preserve_error_detail_until_recovery_and_ignore_other_fields() {
        let (sender, mut receiver) = watch::channel(TerminalStatus::default());
        publish_problem(&sender, "queue_io", "fila indisponível");
        receiver.borrow_and_update();
        publish_snapshot(&sender, &json!({"error":"queue_io", "view":{"input_stalled":"composer_busy"}}));
        assert_eq!(receiver.borrow_and_update().message.as_deref(), Some("fila indisponível"));
        publish_snapshot(&sender, &json!({"error":"queue_io", "view":{"input_stalled":"composer_busy", "deliverable":true}, "revision":99}));
        assert!(!receiver.has_changed().unwrap(), "campos que o monitor não usa não o acordam");
        publish_snapshot(&sender, &json!({"error":null,"view":{}}));
        assert_eq!(*receiver.borrow(), TerminalStatus::default());
    }

    #[test]
    fn actor_panic_keeps_a_visible_problem() {
        let (sender, receiver) = watch::channel(TerminalStatus::default());
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _guard = PanicMark(Some(sender));
            panic!("fixture");
        }));
        assert!(result.is_err());
        assert_eq!(receiver.borrow().error.as_deref(), Some("runtime_panic"));
    }
}
