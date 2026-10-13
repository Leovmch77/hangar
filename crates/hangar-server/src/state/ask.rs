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
struct Sidecar { tool_input: ToolInput, #[serde(default)] tool_use_id: Option<String> }

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

/// Até onde o transcript já foi lido à procura da resposta de cada revisão: só o que cresceu é relido.
static SCANNED: LazyLock<Mutex<HashMap<PathBuf, (String, u64, bool)>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

/// `(o transcript tem o tool_result da chamada, a própria chamada já apareceu)`. Lê só linhas
/// inteiras desde a última leitura.
fn answered_in_transcript(jsonl: &Path, call: &str, revision: &str) -> Result<(bool, bool), String> {
    use std::io::{Read, Seek, SeekFrom};
    let (start, seen_before) = SCANNED.lock().map_err(|_| "askq_scan_lock")?.get(jsonl)
        .filter(|(seen, ..)| seen == revision).map_or((0, false), |(_, offset, call_seen)| (*offset, *call_seen));
    let mut file = std::fs::File::open(jsonl).map_err(|e| format!("askq_transcript_unreadable:{:?}", e.kind()))?;
    let mut buf = Vec::new();
    file.seek(SeekFrom::Start(start)).and_then(|_| file.read_to_end(&mut buf))
        .map_err(|e| format!("askq_transcript_unreadable:{:?}", e.kind()))?;
    let complete = buf.iter().rposition(|&b| b == b'\n').map_or(0, |i| i + 1);
    let needle = format!("\"tool_use_id\":\"{call}\"");
    let contains = |needle: &str| buf[..complete].windows(needle.len()).any(|w| w == needle.as_bytes());
    let found = contains(&needle);
    let call_seen = seen_before || contains(&format!("\"id\":\"{call}\""));
    SCANNED.lock().map_err(|_| "askq_scan_lock")?.insert(jsonl.to_path_buf(), (revision.to_owned(), start + complete as u64, call_seen));
    Ok((found, call_seen))
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
    drop(consumed);
    // O hook não apaga o sidecar quando a resposta vem pelo terminal: sem isto a pergunta velha
    // prenderia todo menu seguinte (plano, permissão) em askq_pane_mismatch. Só a resposta achada
    // no transcript tira a pergunta; dúvida a mantém aberta.
    // ponytail: sidecar sem tool_use_id (o hook sempre grava) não é conferido.
    // Órfão: a chamada nunca chegou ao transcript passada a carência; a lista o expira igual.
    let age = metadata.modified().ok().and_then(|m| m.elapsed().ok()).map_or(0.0, |d| d.as_secs_f64());
    if let Some(call) = sidecar.tool_use_id.as_deref()
        && let (answered, call_seen) = answered_in_transcript(jsonl, call, &revision)?
        && (answered || !call_seen && age >= crate::list::facts_files::ASK_GRACE) {
        if !answered { tracing::info!(transcript = %jsonl.display(), code = "askq_orphan", "askq: chamada fora do transcript, sidecar expirado"); }
        CONSUMED.lock().map_err(|_| "askq_consumed_lock")?.entry(path).or_default().insert(revision);
        return Ok(None);
    }
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
pub(crate) fn submit_tab(pane: &str) -> bool {
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

pub fn observe_screen_menu(plugin: &crate::plugin::Store, binding: &crate::interactions::InteractionBinding,
    jsonl: &Path, pane: &str) -> Result<(Option<String>, Option<serde_json::Map<String, serde_json::Value>>), String> {
    let interactions = plugin.interactions();
    let mut notice = plugin.plan_notice(binding).map_err(|e| e.0.to_owned())?;
    // ponytail: divide o cursor de leitura com o sidecar do askq; com os dois abertos, cada um relê do começo.
    if let Some(call) = notice.as_ref().map(|n| n.tool_use_id.clone())
        && answered_in_transcript(jsonl, &call, &format!("plan:{call}"))?.0 {
        plugin.drop_plan(binding, &call).map_err(|e| e.0.to_owned())?;
        interactions.observe(binding, &plan_target(&call), None).map_err(|e| e.code().to_owned())?;
        notice = None;
    }
    if submit_tab(pane) || !crate::terminal_state::plan_dialog(&crate::terminal_state::analyze(pane)) {
        if let Some(n) = &notice { interactions.observe(binding, &plan_target(&n.tool_use_id), None).map_err(|e| e.code().to_owned())?; }
        return Ok((observe_menu(interactions, binding, jsonl, pane)?, None));
    }
    // O diálogo do plano nunca vira menu comum: sem o aviso do plugin, é falha visível.
    let menu = crate::interactions::InteractionTarget { kind: crate::interactions::InteractionKind::Menu, request_key: "terminal:menu".into() };
    interactions.observe(binding, &menu, None).map_err(|e| e.code().to_owned())?;
    let n = notice.ok_or("plan_notice_missing")?;
    let mut semantic = crate::terminal_input::interaction_semantic(pane, None).map_err(|e| e.code().to_owned())?;
    semantic["tool_use_id"] = serde_json::json!(n.tool_use_id);
    let id = interactions.observe(binding, &plan_target(&n.tool_use_id), Some(semantic)).map_err(|e| e.code().to_owned())?;
    let plan = serde_json::json!({"plan": n.plan, "path": n.path, "tool_use_id": n.tool_use_id});
    Ok((id, plan.as_object().cloned()))
}

/// Tipo `Menu`: a resposta é a tecla no diálogo do pane, conferida pelo mesmo escritor dos menus.
pub fn plan_target(tool_use_id: &str) -> crate::interactions::InteractionTarget {
    crate::interactions::plugin_target(crate::interactions::InteractionKind::Menu, &format!("plan:{tool_use_id}"))
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
    const KNOWN: [&str; 9] = ["askq_pane_mismatch", "askq_changed_during_read", "askq_malformed", "askq_path",
        "askq_consumed_lock", "askq_revision_missing", "askq_unreadable", "askq_transcript_unreadable", "askq_scan_lock"];
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
    fn sidecar_answered_in_the_transcript_does_not_hold_the_next_menu() {
        const PLAN: &str = "   Claude has written up a plan and is ready to execute. Would you like to proceed?\n\n   ❯ 1. Yes, and use auto mode\n     2. Yes, manually approve edits\n     3. Tell Claude what to change\n";
        let tmp = tempfile::tempdir().unwrap();
        let jsonl = tmp.path().join("projects/p/sid.jsonl");
        let path = sidecar_path(&jsonl).unwrap();
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::create_dir_all(jsonl.parent().unwrap()).unwrap();
        std::fs::write(&path, r#"{"tool_use_id":"toolu_cor","tool_input":{"questions":[
            {"question":"Cor?","header":"Cor","multiSelect":false,"options":[{"label":"Azul"},{"label":"Verde"}]}]}}"#).unwrap();
        let ask = r#"{"timestamp":"2099-01-01T00:00:00Z","message":{"content":[{"type":"tool_use","id":"toolu_cor","name":"AskUserQuestion"}]}}"#;
        let (store, binding) = bound_store();
        // Sem transcript não há prova: erro com código, nunca a pergunta sumida.
        let missing = observe_terminal(&store, &binding, &jsonl, PLAN).unwrap_err();
        assert_eq!(failure_code(&missing), "askq_transcript_unreadable");
        // Pergunta ainda aberta: o menu de outra pergunta segue recusado.
        std::fs::write(&jsonl, format!("{ask}\n")).unwrap();
        assert_eq!(observe_terminal(&store, &binding, &jsonl, PLAN).unwrap_err(), "askq_pane_mismatch");
        // Respondida no terminal (o hook não apaga o sidecar): o plano é um menu comum, com identidade.
        std::fs::write(&jsonl, format!("{ask}\n{}\n",
            r#"{"timestamp":"2099-01-01T00:00:01Z","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_cor"}]}}"#)).unwrap();
        assert_eq!(observe_terminal(&store, &binding, &jsonl, PLAN), Ok(None));
        assert!(observe_menu(&store, &binding, &jsonl, PLAN).unwrap().is_some());
    }

    #[test]
    fn orphan_sidecar_whose_call_never_reached_the_transcript_expires_after_the_grace() {
        const MENU: &str = "   Outra?\n\n ❯ 1. X\n   2. Y\n";
        let tmp = tempfile::tempdir().unwrap();
        let jsonl = tmp.path().join("projects/p/sid.jsonl");
        let path = sidecar_path(&jsonl).unwrap();
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::create_dir_all(jsonl.parent().unwrap()).unwrap();
        std::fs::write(&jsonl, "{\"timestamp\":\"2099-01-01T00:00:00Z\",\"type\":\"user\"}\n").unwrap();
        std::fs::write(&path, r#"{"tool_use_id":"toolu_orfa","tool_input":{"questions":[
            {"question":"Cor?","header":"Cor","multiSelect":false,"options":[{"label":"Azul"},{"label":"Verde"}]}]}}"#).unwrap();
        let (store, binding) = bound_store();
        // Recém-gravado, a chamada ainda pode estar a caminho do transcript.
        assert_eq!(observe_terminal(&store, &binding, &jsonl, MENU).unwrap_err(), "askq_pane_mismatch");
        let old = std::time::SystemTime::now() - std::time::Duration::from_secs(60);
        std::fs::OpenOptions::new().write(true).open(&path).unwrap().set_times(std::fs::FileTimes::new().set_modified(old)).unwrap();
        assert_eq!(observe_terminal(&store, &binding, &jsonl, MENU), Ok(None));
        assert!(observe_menu(&store, &binding, &jsonl, MENU).unwrap().is_some());
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

    const PLAN: &str = include_str!("../../tests/fixtures/pane_plan_dialog.txt");

    #[test]
    fn plan_dialog_publishes_the_plugin_plan_id_never_the_pane_menu() {
        use serde_json::json;
        let dir = tempfile::tempdir().unwrap();
        let jsonl = dir.path().join("projects/p/sid.jsonl");
        std::fs::create_dir_all(jsonl.parent().unwrap()).unwrap();
        std::fs::write(&jsonl, "").unwrap();
        let binding = crate::interactions::InteractionBinding { key: "k".into(), conversation: "sid".into(), generation: 1 };
        let store = crate::plugin::Store::new(std::sync::Arc::new(crate::interactions::InteractionStore::default()));
        store.interactions().bind(&binding).unwrap();
        store.bind(&binding).unwrap();
        let menu = crate::interactions::InteractionTarget { kind: crate::interactions::InteractionKind::Menu, request_key: "terminal:menu".into() };

        // Diálogo do plano sem o aviso do plugin: falha visível, e o menu do pane não ganha ID.
        assert_eq!(observe_screen_menu(&store, &binding, &jsonl, PLAN), Err("plan_notice_missing".to_owned()));
        assert!(store.interactions().current(&binding, &menu).unwrap().is_none());

        store.notice_plan(&binding, "toolu_1".into(), "# Plano".into(), Some("/p.md".into())).unwrap();
        let (id, plan) = observe_screen_menu(&store, &binding, &jsonl, PLAN).unwrap();
        let id = id.unwrap();
        assert_eq!(plan.unwrap(), *json!({"plan":"# Plano","path":"/p.md","tool_use_id":"toolu_1"}).as_object().unwrap());
        let expected = store.interactions().expected(&binding, Some(&id)).unwrap();
        assert_eq!(expected.target, crate::interactions::plugin_target(crate::interactions::InteractionKind::Menu, "plan:toolu_1"));
        assert_eq!(expected.semantic["pane"]["options"], json!(["Yes, and use auto mode", "Yes, manually approve edits", "Tell Claude what to change"]));
        assert!(store.interactions().current(&binding, &menu).unwrap().is_none());
        assert_eq!(observe_screen_menu(&store, &binding, &jsonl, PLAN).unwrap().0.as_deref(), Some(id.as_str()));

        // Fora do diálogo o cartão some e o menu comum volta a ter o ID dele.
        const OTHER: &str = "   Outra?\n\n ❯ 1. X\n   2. Y\n";
        let (other, plan) = observe_screen_menu(&store, &binding, &jsonl, OTHER).unwrap();
        assert!(other.is_some_and(|other| other != id) && plan.is_none());
        assert!(store.interactions().expected(&binding, Some(&id)).is_err());

        // A resposta no transcript encerra o aviso: o mesmo quadro não revive o cartão velho.
        std::fs::write(&jsonl, "{\"type\":\"user\",\"message\":{\"content\":[{\"type\":\"tool_result\",\"tool_use_id\":\"toolu_1\"}]}}\n").unwrap();
        assert_eq!(observe_screen_menu(&store, &binding, &jsonl, PLAN), Err("plan_notice_missing".to_owned()));
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
