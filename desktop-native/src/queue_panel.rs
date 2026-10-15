//! Painel da fila do nativo: mesma regra do `packages/core/src/queuePanel.ts` (o nativo não importa o core).
use crate::api::dto::ChatEvent;
use serde_json::Value;

const PREFIX: &str = "queued-";

#[derive(Clone, Debug, Default, PartialEq)]
pub struct QueueEntry { pub id: String, pub text: String, pub ts: Option<f64> }

#[derive(Clone, Debug, Default, PartialEq)]
pub struct QueuePanel { pub entries: Vec<QueueEntry>, pub actions: bool }

/// Edição em curso; `saved_draft` é o rascunho que volta ao sair dela.
#[derive(Clone, Debug, PartialEq)]
pub struct QueueEdit { pub entry_id: String, pub original: String, pub saved_draft: String }

/// Corpo do evento `queue`; `entries` que não é lista é quadro inválido.
pub fn parse(data: &Value) -> Option<QueuePanel> {
    let entries = data.get("entries")?.as_array()?.iter().filter_map(|e| Some(QueueEntry {
        id: e.get("id")?.as_str().filter(|id| !id.is_empty())?.to_owned(),
        text: e.get("text")?.as_str()?.to_owned(),
        ts: e.get("ts").and_then(Value::as_f64),
    })).collect();
    Some(QueuePanel { entries, actions: data.get("actions").and_then(Value::as_bool) == Some(true) })
}

/// Sem o evento (Pi, omp, Kimi, modo `python`): as bolhas da fila que ainda esperam, sem ações.
pub fn derived(events: &[ChatEvent]) -> QueuePanel {
    let entries = events.iter().filter(|e| e.kind == "user_msg" && e.id.starts_with(PREFIX) && e.queued_delivered == Some(false)
        && e.desistiu != Some(true) && e.queued_confirmed != Some(true) && e.queued_consumed != Some(true))
        .map(|e| QueueEntry { id: e.id[PREFIX.len()..].to_owned(), text: e.text.clone().unwrap_or_default(), ts: e.queued_ts })
        .collect();
    QueuePanel { entries, actions: false }
}

pub fn current(server: Option<&QueuePanel>, events: &[ChatEvent]) -> QueuePanel { server.cloned().unwrap_or_else(|| derived(events)) }

/// A bolha `queued-<id>` some da conversa enquanto a entrada está no painel.
pub fn hidden(id: &str, panel: &QueuePanel) -> bool {
    id.strip_prefix(PREFIX).is_some_and(|raw| panel.entries.iter().any(|e| e.id == raw))
}

/// Trocar de linha no meio da edição mantém o rascunho de antes da primeira.
pub fn begin_edit(entry: &QueueEntry, draft: &str, current: Option<&QueueEdit>) -> QueueEdit {
    QueueEdit { entry_id: entry.id.clone(), original: entry.text.clone(),
        saved_draft: current.map_or_else(|| draft.to_owned(), |e| e.saved_draft.clone()) }
}

pub fn can_update(text: &str) -> bool { let t = text.trim(); !t.is_empty() && !t.starts_with('/') }

/// `Some(texto do composer)` quando a mensagem saiu da fila durante a edição.
pub fn edit_left(edit: &QueueEdit, panel: &QueuePanel, composer: &str) -> Option<String> {
    if panel.entries.iter().any(|e| e.id == edit.entry_id) { return None; }
    Some(if edit.saved_draft.trim().is_empty() { composer.to_owned() } else { edit.saved_draft.clone() })
}

/// `Some(before_id)` para mover uma posição (`Some(None)` é o fim); `None`, nada a mover.
pub fn move_target(entries: &[QueueEntry], id: &str, up: bool) -> Option<Option<String>> {
    let i = entries.iter().position(|e| e.id == id)?;
    if up { return (i > 0).then(|| Some(entries[i - 1].id.clone())); }
    (i + 1 < entries.len()).then(|| entries.get(i + 2).map(|e| e.id.clone()))
}

/// Soltar `drag` antes (ou depois, com `after`) de `over`; soltar no próprio lugar não move.
pub fn drop_target(entries: &[QueueEntry], drag: &str, over: &str, after: bool) -> Option<Option<String>> {
    let over_i = entries.iter().position(|e| e.id == over)?;
    let from = entries.iter().position(|e| e.id == drag)?;
    let before = if after { entries.get(over_i + 1).map(|e| e.id.clone()) } else { Some(over.to_owned()) };
    let next = entries.get(from + 1).map(|e| e.id.clone());
    (before.as_deref() != Some(drag) && before != next).then_some(before)
}

pub fn steerable(provider: &str) -> bool { !matches!(provider, "pi" | "omp") }

#[cfg(test)]
mod tests {
    use super::*;
    // O glob pode trazer o `test` da gpui, que colide com o atributo padrão; o nome explícito vence o glob.
    use core::prelude::v1::test;

    fn panel(ids: &[&str]) -> QueuePanel {
        QueuePanel { actions: true, entries: ids.iter().map(|id| QueueEntry { id: (*id).into(), text: format!("t {id}"), ts: Some(1.0) }).collect() }
    }
    fn queued(id: &str, delivered: Option<bool>) -> ChatEvent {
        ChatEvent { kind: "user_msg".into(), id: format!("queued-{id}"), text: Some(format!("t {id}")), queued_delivered: delivered, ..Default::default() }
    }

    #[test]
    fn parses_the_server_event_and_derives_without_it() {
        let parsed = parse(&serde_json::json!({"entries":[{"id":"a","text":"x","ts":2.0},{"id":1}],"actions":true})).unwrap();
        assert_eq!(parsed.entries, vec![QueueEntry { id: "a".into(), text: "x".into(), ts: Some(2.0) }]);
        assert!(parsed.actions);
        assert!(!parse(&serde_json::json!({"entries":[],"actions":"yes"})).unwrap().actions);
        assert!(parse(&serde_json::json!({"entries":"x"})).is_none());
        let mut gave_up = queued("c", Some(false));
        gave_up.desistiu = Some(true);
        let derived = derived(&[queued("a", Some(false)), queued("b", Some(true)), gave_up, queued("d", None)]);
        assert_eq!((derived.entries.len(), derived.actions), (1, false));
        assert_eq!(derived.entries[0].id, "a");
        assert_eq!(current(Some(&panel(&["z"])), &[queued("a", Some(false))]).entries[0].id, "z");
    }

    #[test]
    fn hides_only_bubbles_in_the_panel() {
        assert!(hidden("queued-a", &panel(&["a"])));
        assert!(!hidden("queued-b", &panel(&["a"])));
        assert!(!hidden("a", &panel(&["a"])));
    }

    #[test]
    fn edit_keeps_the_first_draft_and_leaving_follows_the_spec() {
        let first = begin_edit(&panel(&["a"]).entries[0], "rascunho", None);
        assert_eq!((first.entry_id.as_str(), first.original.as_str()), ("a", "t a"));
        let second = begin_edit(&panel(&["b"]).entries[0], "t a mudado", Some(&first));
        assert_eq!(second.saved_draft, "rascunho");
        let edit = QueueEdit { entry_id: "a".into(), original: "x".into(), saved_draft: String::new() };
        assert_eq!(edit_left(&edit, &panel(&["a"]), "novo"), None);
        assert_eq!(edit_left(&edit, &panel(&[]), "novo").as_deref(), Some("novo"));
        let kept = QueueEdit { saved_draft: "antes".into(), ..edit };
        assert_eq!(edit_left(&kept, &panel(&[]), "novo").as_deref(), Some("antes"));
        assert!(!can_update(" ") && !can_update("/clear") && can_update("ok"));
    }

    #[test]
    fn moves_and_drops() {
        let e = panel(&["a", "b", "c"]).entries;
        assert_eq!(move_target(&e, "b", true), Some(Some("a".into())));
        assert_eq!(move_target(&e, "b", false), Some(None));
        assert_eq!(move_target(&e, "a", false), Some(Some("c".into())));
        assert_eq!(move_target(&e, "a", true), None);
        assert_eq!(move_target(&e, "c", false), None);
        assert_eq!(drop_target(&e, "c", "a", false), Some(Some("a".into())));
        assert_eq!(drop_target(&e, "a", "c", true), Some(None));
        assert_eq!(drop_target(&e, "a", "b", false), None);
        assert_eq!(drop_target(&e, "a", "a", true), None);
        assert!(!steerable("pi") && !steerable("omp") && steerable("codex") && steerable("claude"));
    }
}
