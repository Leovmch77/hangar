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
    payload.questions.first().is_some_and(|first| matches_item(state, payload, first, true))
}

fn matches_item(state: &StateEvent, payload: &AskQuestion, item: &AskQuestionItem, log: bool) -> bool {
    if state.state != "awaiting_input" {
        return false;
    }
    let first: BTreeSet<&str> = item.options.iter().map(|o| o.label.as_str()).collect();
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
    if !ok && log && crate::warn_limit::allow(Some(&state.session), reason) {
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

/// Aba de envio do formulário: o cursor vivo (o último da tela) está em "Submit answers".
fn submit_tab(pane: &str) -> bool {
    pane.lines().filter(|line| line.trim_start().starts_with(['❯', '›'])).last().is_some_and(|line| line.contains("Submit answers"))
}

pub fn observe_menu(interactions: &crate::interactions::InteractionStore,
    binding: &crate::interactions::InteractionBinding, jsonl: &Path, pane: &str) -> Result<Option<String>, String> {
    // A aba de envio é o mesmo menu sendo enviado: retratá-la trocaria o ID que o envio confere.
    if submit_tab(pane) { return Ok(None); }
    let target = crate::interactions::InteractionTarget { kind: crate::interactions::InteractionKind::Menu, request_key: "terminal:menu".into() };
    let analysis = crate::terminal_state::analyze(pane);
    let semantic = if analysis.state == "awaiting_input" && read_revision(jsonl)?.is_none() {
        Some(crate::terminal_input::interaction_semantic(pane, None).map_err(|e| e.code().to_owned())?)
    } else { None };
    interactions.observe(binding, &target, semantic).map_err(|e| e.code().to_owned())
}

/// Mesmo quadro e semântica que o escritor reconfere antes do primeiro efeito. Única regra para a
/// publicação (lista e monitor) e para os fatos do executor.
pub fn observe_terminal(interactions: &crate::interactions::InteractionStore,
    binding: &crate::interactions::InteractionBinding, jsonl: &Path, pane: &str) -> Result<Option<AskQuestion>, String> {
    let target = crate::interactions::InteractionTarget { kind: crate::interactions::InteractionKind::Question, request_key: "terminal:askq".into() };
    let pending = read_revision(jsonl)?;
    let Some((mut question, revision)) = pending else {
        interactions.observe_revision(binding, &target, None, None).map_err(|e| e.code().to_owned())?;
        return Ok(None);
    };
    let analysis = crate::terminal_state::analyze(pane);
    let submit = submit_tab(pane);
    // Sem menu na tela a pergunta não está aberta: o hook nunca apaga o sidecar respondido.
    if analysis.state != "awaiting_input" && !submit { return Ok(None); }
    let event = StateEvent { state: analysis.state, question: analysis.question, options: analysis.options, ..Default::default() };
    // Texto da pergunta junto: com opções iguais às da primeira, só ele separa as etapas.
    let later = submit || question.questions.iter().skip(1)
        .any(|item| event.question.as_deref() == Some(item.question.as_str()) && matches_item(&event, &question, item, false));
    if later {
        // Etapa seguinte (ou envio) do formulário já publicado: o mesmo ID, sem retratar de novo,
        // porque o retrato desta etapa trocaria o ID que está sendo respondido.
        let published = interactions.current(binding, &target).map_err(|e| e.code().to_owned())?
            .filter(|published| published.source_revision.as_deref() == Some(revision.as_str()))
            .ok_or("askq_pane_mismatch")?;
        if read_revision(jsonl)?.as_ref().map(|(_, current)| current) != Some(&revision) { return Err("askq_changed_during_read".into()); }
        question.interaction_id = Some(published.interaction_id);
        return Ok(Some(question));
    }
    if !matches(&event, &question) { return Err("askq_pane_mismatch".into()); }
    let semantic = crate::terminal_input::interaction_semantic(pane, Some(&question)).map_err(|e| e.code().to_owned())?;
    if read_revision(jsonl)?.as_ref().map(|(_, current)| current) != Some(&revision) { return Err("askq_changed_during_read".into()); }
    question.interaction_id = interactions.observe_revision(binding, &target, Some(semantic), Some(revision))
        .map_err(|e| e.code().to_owned())?;
    Ok(Some(question))
}

/// Código estático da falha da pergunta, para a causa chegar ao resultado da entrega.
pub fn failure_code(code: &str) -> &'static str {
    const KNOWN: [&str; 7] = ["askq_pane_mismatch", "askq_changed_during_read", "askq_malformed", "askq_path",
        "askq_consumed_lock", "askq_revision_missing", "askq_unreadable"];
    let base = code.split(':').next().unwrap_or(code);
    KNOWN.into_iter().find(|known| *known == base)
        .or_else(|| crate::interactions::InteractionError::from_code(code).map(|error| error.code()))
        .unwrap_or("terminal_question_unavailable")
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

    const STEP_ONE: &str = "   Cor?\n\n ❯ 1. Azul\n   2. Verde\n   3. Type something.\n   4. Chat about this\n";
    const STEP_TWO: &str = "   Pasta?\n\n ❯ 1. A\n   2. B\n   3. Type something.\n   4. Chat about this\n";
    const SUBMIT: &str = "Review your answers\n → Azul\n → A\n\n ❯ 1. Submit answers\n   2. Cancel\n";
    const OTHER: &str = "   Outra?\n\n ❯ 1. X\n   2. Y\n";

    fn bound_store() -> (crate::interactions::InteractionStore, crate::interactions::InteractionBinding) {
        let store = crate::interactions::InteractionStore::default();
        let binding = crate::interactions::InteractionBinding { key: "k".into(), conversation: "sid".into(), generation: 1 };
        store.bind(&binding).unwrap();
        (store, binding)
    }

    #[test]
    fn later_step_of_the_same_form_keeps_the_published_id_and_replacement_is_refused() {
        let tmp = tempfile::tempdir().unwrap();
        let jsonl = tmp.path().join("projects/p/sid.jsonl");
        let path = sidecar_path(&jsonl).unwrap();
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, r#"{"tool_input":{"questions":[
            {"question":"Cor?","header":"Cor","multiSelect":false,"options":[{"label":"Azul"},{"label":"Verde"}]},
            {"question":"Pasta?","header":"Pasta","multiSelect":false,"options":[{"label":"A"},{"label":"B"}]}]}}"#).unwrap();
        let (store, binding) = bound_store();
        let published = observe_terminal(&store, &binding, &jsonl, STEP_ONE).unwrap().unwrap().interaction_id.unwrap();
        let expected = store.expected(&binding, Some(&published)).unwrap();
        // Segunda etapa e aba de envio são o mesmo formulário: lista, monitor e executor recebem a
        // pergunta com o mesmo ID, e o registro não muda.
        for pane in [STEP_ONE, STEP_TWO, SUBMIT] {
            let seen = observe_terminal(&store, &binding, &jsonl, pane).unwrap().unwrap();
            assert_eq!((seen.interaction_id.as_deref(), seen.questions.len()), (Some(published.as_str()), 2));
            assert_eq!(store.expected(&binding, Some(&published)).unwrap(), expected);
        }
        // Pergunta fechada (composer de volta, sidecar ainda no disco): nada aberto, registro intacto.
        assert_eq!(observe_terminal(&store, &binding, &jsonl, "────────────────\n❯ \n────────────────\n"), Ok(None));
        assert_eq!(store.expected(&binding, Some(&published)).unwrap(), expected);
        // Etapa 2 sem a primeira ter sido publicada não ganha identidade.
        let (fresh, fresh_binding) = bound_store();
        assert_eq!(observe_terminal(&fresh, &fresh_binding, &jsonl, STEP_TWO).unwrap_err(), "askq_pane_mismatch");
        // Pergunta fora do formulário segue recusada, e a causa chega inteira ao executor.
        let refused = observe_terminal(&store, &binding, &jsonl, OTHER).unwrap_err();
        assert_eq!(failure_code(&refused), "askq_pane_mismatch");
        assert_eq!(failure_code("askq_unreadable:PermissionDenied"), "askq_unreadable");
        assert_eq!(failure_code("algo_novo"), "terminal_question_unavailable");
        // Troca real A→B: B é outro formulário, com outra revisão e outro ID; o de A deixa de valer.
        std::fs::write(&path, r#"{"tool_input":{"questions":[
            {"question":"Pasta?","header":"Pasta","multiSelect":false,"options":[{"label":"A"},{"label":"B"}]}]}}"#).unwrap();
        assert_ne!(read_revision(&jsonl).unwrap().map(|(_, revision)| revision), expected.source_revision);
        let replaced = observe_terminal(&store, &binding, &jsonl, STEP_TWO).unwrap().unwrap().interaction_id.unwrap();
        assert_ne!(replaced, published);
        assert!(store.expected(&binding, Some(&published)).is_err());
    }

    #[test]
    fn menu_without_sidecar_keeps_its_identity_on_the_submit_tab() {
        let tmp = tempfile::tempdir().unwrap();
        let jsonl = tmp.path().join("projects/p/sid.jsonl");
        let (store, binding) = bound_store();
        let menu = "   Quais?\n\n ❯ 1. [ ] Alfa\n   2. [x] Bravo\n";
        let id = observe_menu(&store, &binding, &jsonl, menu).unwrap().unwrap();
        let expected = store.expected(&binding, Some(&id)).unwrap();
        assert_eq!((expected.target.kind.clone(), expected.source_revision.clone()), (crate::interactions::InteractionKind::Menu, None));
        assert_eq!(observe_menu(&store, &binding, &jsonl, SUBMIT), Ok(None));
        assert_eq!(store.expected(&binding, Some(&id)).unwrap(), expected);
        assert_ne!(observe_menu(&store, &binding, &jsonl, OTHER).unwrap().unwrap(), id);
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
