//! Pergunta nativa do AskUserQuestion do Claude com terminal: o sidecar do hook PreToolUse
//! (`<config>/.hangar-askq/<sid>.json`) casado com o menu que o pane mostra. Porte de
//! `sse._ask_question_event` e `askquestion.read_pending_askq`. Falhou o casamento, o app fica com
//! os botões do menu do pane; nunca abre o stepper sobre outra pergunta.
use std::collections::{BTreeSet, HashMap};
use std::sync::{LazyLock, Mutex};
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use hangar_api::ask::{AskQuestion, AskQuestionItem};
use hangar_api::state::StateEvent;
use serde::Deserialize;

/// Linhas que o TUI acrescenta a toda pergunta e que nunca estão no payload do hook, comparadas
/// sem a caixinha e sem o ponto final (a múltipla escolha mostra "Type something" sem ponto).
const TUI_EXTRAS: [&str; 2] = ["Type something", "Chat about this"];

/// `_CAIXA_MULTI` (`^\[.?\]\s*`): a caixinha da múltipla escolha é desenho, não rótulo.
fn without_box(label: &str) -> &str {
    let Some(rest) = label.strip_prefix('[') else { return label };
    let mut chars = rest.chars();
    let after = match chars.next() {
        Some(c) if c != '\n' && chars.as_str().starts_with(']') => &chars.as_str()[1..],
        _ => match rest.strip_prefix(']') {
            Some(after) => after,
            None => return label,
        },
    };
    after.trim_start()
}

fn is_tui_extra(label: &str) -> bool { TUI_EXTRAS.contains(&without_box(label).trim_end_matches('.')) }

/// O sidecar responde à pergunta que o pane mostra agora? Só em `awaiting_input`.
pub fn matches(state: &StateEvent, payload: &AskQuestion) -> bool {
    if state.state != "awaiting_input" {
        return false;
    }
    let Some(first) = payload.questions.first() else { return false };
    let first: BTreeSet<&str> = first.options.iter().map(|o| o.label.as_str()).collect();
    let pane: BTreeSet<&str> = state.options.iter().flatten().filter(|o| !is_tui_extra(o)).map(|o| without_box(o)).collect();
    if first.is_empty() || pane.is_empty() {
        return false;
    }
    let has_preview = payload.questions.iter().flat_map(|q| &q.options).any(|o| !o.preview.is_empty());
    // Sem prévia, igualdade exata: a resposta vai por índice, e opção a mais no pane cairia na
    // linha errada. Com prévia o pane trunca o rótulo: prefixo numa direção só, mesma contagem
    // (rótulo curto do pane casando com um longo do sidecar não troca a permissão por outra).
    let (ok, reason) = if has_preview {
        (first.len() == pane.len() && first.iter().all(|l| pane.iter().any(|s| !s.is_empty() && l.starts_with(s))), "askq_preview_mismatch")
    } else if !first.is_subset(&pane) {
        (false, "askq_label_outside_menu")
    } else {
        (pane.is_subset(&first), "askq_pane_extra_option")
    };
    // Degradar para os botões do pane é silencioso na tela: a frequência no diário é o sinal de
    // que o TUI mudou o texto das linhas dele.
    if !ok && crate::warn_limit::allow(Some(&state.session), reason) {
        tracing::info!(session = state.session.as_str(), code = reason, sidecar = first.len(), pane = pane.len(), "askq: menu não casa, fica com os botões do pane");
    }
    ok
}

/// `<config>/projects/<cwd>/<sid>.jsonl` → `<config>/.hangar-askq/<sid>.json`.
pub fn sidecar_path(jsonl: &Path) -> Option<PathBuf> {
    let config = jsonl.parent()?.parent()?.parent()?;
    Some(config.join(crate::list::facts_files::ASKQ_DIR).join(format!("{}.json", jsonl.file_stem()?.to_str()?)))
}

#[derive(Deserialize)]
struct Sidecar { tool_input: ToolInput }

#[derive(Deserialize)]
struct ToolInput { questions: Vec<AskQuestionItem> }

/// Pergunta pendente do sidecar. Ausente é o caso normal (`Ok(None)`); `Err` é o código de um
/// arquivo que existe e não serve (contrato do hook quebrado), que vai ao diário.
pub fn read_pending(jsonl: &Path) -> Result<Option<AskQuestion>, String> {
    Ok(read_revision(jsonl)?.map(|(question, _)| question))
}

static CONSUMED: LazyLock<Mutex<HashMap<PathBuf, BTreeSet<String>>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

/// Não apaga o caminho: ele pode já guardar a pergunta seguinte.
pub fn consume_revision(jsonl: &Path, revision: &str) -> Result<(), String> {
    let path = sidecar_path(jsonl).ok_or("askq_path")?;
    CONSUMED.lock().map_err(|_| "askq_consumed_lock")?.entry(path).or_default().insert(revision.into());
    Ok(())
}

pub fn read_revision(jsonl: &Path) -> Result<Option<(AskQuestion, String)>, String> {
    let path = sidecar_path(jsonl).ok_or("askq_path")?;
    let mut consumed = CONSUMED.lock().map_err(|_| "askq_consumed_lock")?;
    let metadata = match std::fs::metadata(&path) {
        Ok(metadata) => metadata,
        Err(e) if e.kind() == ErrorKind::NotFound => { consumed.remove(&path); return Ok(None); },
        Err(e) => return Err(format!("askq_unreadable:{:?}", e.kind())),
    };
    let stamp = file_stamp(&metadata)?;
    let bytes = match std::fs::read(&path) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == ErrorKind::NotFound => { consumed.remove(&path); return Ok(None); },
        Err(e) => return Err(format!("askq_unreadable:{:?}", e.kind())),
    };
    let mut digest = ring::digest::Context::new(&ring::digest::SHA256);
    digest.update(stamp.as_bytes());
    digest.update(&bytes);
    let revision: String = digest.finish().as_ref().iter().map(|b| format!("{b:02x}")).collect();
    // A publicação nunca combina a leitura de A com a revisão de B.
    match std::fs::read(&path) {
        Ok(current) if current == bytes && std::fs::metadata(&path).ok().and_then(|m| file_stamp(&m).ok()).as_ref() == Some(&stamp) => {},
        Ok(_) => return Err("askq_changed_during_read".into()),
        Err(e) if e.kind() == ErrorKind::NotFound => { consumed.remove(&path); return Ok(None); },
        Err(e) => return Err(format!("askq_unreadable:{:?}", e.kind())),
    }
    if consumed.get(&path).is_some_and(|revisions| revisions.contains(&revision)) { return Ok(None); }
    // ponytail: `multiSelect` como texto ("true") o pydantic aceita e o serde recusa; o resultado
    // é o mesmo de um sidecar quebrado (fica o menu do pane), e o hook grava o booleano.
    // Só o código: a mensagem do serde pode citar o texto da pergunta.
    let sidecar: Sidecar = serde_json::from_slice(&bytes).map_err(|_| "askq_malformed".to_owned())?;
    Ok(Some((AskQuestion { questions: sidecar.tool_input.questions, interaction_id: None }, revision)))
}

fn file_stamp(metadata: &std::fs::Metadata) -> Result<String, String> {
    let modified = metadata.modified().map_err(|_| "askq_revision_missing")?;
    let mut stamp = format!("{:?}:{:?}:{}", modified, metadata.created().ok(), metadata.len());
    #[cfg(unix)] {
        use std::os::unix::fs::MetadataExt;
        stamp.push_str(&format!(":{}:{}", metadata.dev(), metadata.ino()));
    }
    Ok(stamp)
}

pub fn observe_menu(interactions: &crate::interactions::InteractionStore,
    binding: &crate::interactions::InteractionBinding, jsonl: &Path, pane: &str) -> Result<Option<String>, String> {
    let target = crate::interactions::InteractionTarget { kind: crate::interactions::InteractionKind::Menu, request_key: "terminal:menu".into() };
    let analysis = crate::terminal_state::analyze(pane);
    let semantic = if analysis.state == "awaiting_input" && read_revision(jsonl)?.is_none() {
        Some(crate::terminal_input::interaction_semantic(pane, None).map_err(|e| e.code().to_owned())?)
    } else { None };
    interactions.observe(binding, &target, semantic).map_err(|e| e.code().to_owned())
}

/// Mesmo quadro e semântica que o escritor reconfere antes do primeiro efeito.
pub fn observe_terminal(interactions: &crate::interactions::InteractionStore,
    binding: &crate::interactions::InteractionBinding, jsonl: &Path, pane: &str) -> Result<Option<AskQuestion>, String> {
    let target = crate::interactions::InteractionTarget { kind: crate::interactions::InteractionKind::Question, request_key: "terminal:askq".into() };
    let pending = read_revision(jsonl)?;
    let Some((mut question, revision)) = pending else {
        interactions.observe_revision(binding, &target, None, None).map_err(|e| e.code().to_owned())?;
        return Ok(None);
    };
    let event = hangar_api::state::StateEvent {
        state: "awaiting_input".into(), question: crate::terminal_state::analyze(pane).question,
        options: crate::terminal_state::analyze(pane).options, ..Default::default()
    };
    if !matches(&event, &question) { return Err("askq_pane_mismatch".into()); }
    let semantic = crate::terminal_input::interaction_semantic(pane, Some(&question)).map_err(|e| e.code().to_owned())?;
    if read_revision(jsonl)?.as_ref().map(|(_, current)| current) != Some(&revision) { return Err("askq_changed_during_read".into()); }
    question.interaction_id = interactions.observe_revision(binding, &target, Some(semantic), Some(revision))
        .map_err(|e| e.code().to_owned())?;
    Ok(Some(question))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    #[test]
    fn source_revision_is_file_revision_not_poll_and_same_content_republication_is_new() {
        let tmp = tempfile::tempdir().unwrap();
        let jsonl = tmp.path().join("projects/p/sid.jsonl");
        let path = sidecar_path(&jsonl).unwrap();
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let bytes = br#"{"tool_input":{"questions":[{"question":"Cor?","header":"Cor","options":[],"multiSelect":false}]}}"#;
        std::fs::write(&path, bytes).unwrap();
        let (_, first) = read_revision(&jsonl).unwrap().unwrap();
        assert_eq!(read_revision(&jsonl).unwrap().unwrap().1, first);
        consume_revision(&jsonl, &first).unwrap();
        std::fs::write(&path, bytes).unwrap();
        let file = std::fs::OpenOptions::new().write(true).open(&path).unwrap();
        file.set_times(std::fs::FileTimes::new().set_modified(std::time::UNIX_EPOCH + std::time::Duration::from_secs(999))).unwrap();
        let (_, second) = read_revision(&jsonl).unwrap().unwrap();
        assert_ne!(first, second);
        assert_eq!(read_revision(&jsonl).unwrap().unwrap().1, second);
    }

    #[test]
    fn matches_menu_python_golden() {
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../backend/tests/fixtures/contract/golden/ask_question.json");
        let rows: Vec<Value> = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
        assert!(rows.len() >= 15);
        let dir = tempfile::tempdir().unwrap();
        for row in &rows {
            let name = row["name"].as_str().unwrap();
            let state = match row["pane"].as_str() {
                Some(pane) => {
                    let a = crate::terminal_state::analyze(pane);
                    assert_eq!(serde_json::to_value(&a.options).unwrap(), row["options"], "{name}: menu do pane");
                    StateEvent { state: a.state, options: a.options, ..Default::default() }
                }
                None => StateEvent { state: row["state"].as_str().unwrap().into(),
                    options: serde_json::from_value(row["options"].clone()).unwrap(), ..Default::default() },
            };
            let jsonl = dir.path().join(name).join("projects/p/sid.jsonl");
            let askq = sidecar_path(&jsonl).unwrap();
            std::fs::create_dir_all(askq.parent().unwrap()).unwrap();
            match &row["sidecar"] {
                Value::Null => {}
                Value::String(raw) => std::fs::write(&askq, raw).unwrap(),
                other => std::fs::write(&askq, other.to_string()).unwrap(),
            }
            let event = read_pending(&jsonl).ok().flatten()
                .filter(|p| matches(&state, p))
                .map(|p| serde_json::to_value(p).unwrap());
            assert_eq!(event.unwrap_or(Value::Null), row["expected"], "{name}");
        }
    }

    #[test]
    fn box_and_extras() {
        assert_eq!(without_box("[ ] Alfa"), "Alfa");
        assert_eq!(without_box("[x]Bravo"), "Bravo");
        assert_eq!(without_box("[]  C"), "C");
        assert_eq!(without_box("[]] D"), "D");
        assert_eq!(without_box("[ab] E"), "[ab] E");
        assert!(is_tui_extra("[ ] Type something.") && is_tui_extra("Chat about this"));
        assert!(!is_tui_extra("Type something else"));
    }

    #[test]
    fn missing_is_none_and_broken_is_error() {
        let dir = tempfile::tempdir().unwrap();
        let jsonl = dir.path().join("projects/p/sid.jsonl");
        assert_eq!(read_pending(&jsonl), Ok(None));
        let askq = sidecar_path(&jsonl).unwrap();
        std::fs::create_dir_all(askq.parent().unwrap()).unwrap();
        std::fs::write(&askq, "{").unwrap();
        assert_eq!(read_pending(&jsonl), Err("askq_malformed".to_owned()));
        // `questions` vazio derruba o Python (`questions[0]`); aqui só não abre o stepper.
        let empty = AskQuestion { questions: Vec::new(), interaction_id: None };
        assert!(!matches(&StateEvent { state: "awaiting_input".into(), options: Some(vec!["A".into()]), ..Default::default() }, &empty));
    }
}
