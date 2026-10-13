//! Plano nativo do Claude Code (modo plano) proposto e ainda sem resposta no transcript principal
//! da sessão: o painel de prévia do plano. Porte de `plano_claude.py`.
use std::collections::HashMap;
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use serde_json::{Map, Value};

static SLUG: LazyLock<regex::Regex> = LazyLock::new(|| regex::Regex::new(r"^[a-z0-9][a-z0-9-]{0,119}$").unwrap());

/// Respostas do `ExitPlanMode` que encerram a proposta; o envio a um líder de equipe não encerra.
const APPROVED: [&str; 3] = ["User has approved your plan.", "User has approved exiting plan mode.", "User has approved the plan."];

#[derive(Clone, Debug, PartialEq)]
pub struct NativePlan {
    pub name: String,
    pub path: PathBuf,
    /// Id do bloco do chat onde a proposta aparece, no formato que o transcript publica.
    pub anchor_id: Option<String>,
}

type Candidate = (PathBuf, Option<String>);

/// A proposta ainda sem resposta, ou `None`. Escrita confirmada traz o caminho exato e vence o slug.
pub fn discover(transcript: &Path, cwd: &Path) -> Option<NativePlan> {
    let root = plans_root(transcript, cwd);
    let file = File::open(transcript).ok()?;
    let mut candidates: HashMap<String, Candidate> = HashMap::new();
    let mut exits: HashMap<String, (String, Option<String>)> = HashMap::new();
    let mut last: Option<Candidate> = None;
    let mut last_slug: Option<String> = None;
    let mut confirmed_slug: Option<(String, Option<String>)> = None;
    let mut awaiting: Option<Candidate> = None;
    let mut approved = false;

    for line in BufReader::new(file).split(b'\n').map_while(Result::ok) {
        let Ok(Value::Object(event)) = serde_json::from_slice::<Value>(&line) else { continue };
        if event.get("isSidechain") == Some(&Value::Bool(true)) {
            continue;
        }
        if let Some(slug) = event.get("slug").and_then(Value::as_str).filter(|s| SLUG.is_match(s)) {
            last_slug = Some(slug.to_owned());
        }
        let content = event.get("message").and_then(|m| m.get("content"));
        if str_field(&event, "type") == Some("user") && human_prompt(content) {
            awaiting = None;
            last = None;
            confirmed_slug = None;
            candidates.clear();
            exits.clear();
            approved = false;
        }
        let Some(blocks) = content.and_then(Value::as_array) else { continue };
        if str_field(&event, "type") == Some("assistant") && let Some(waiting) = &awaiting {
            if let Some(reply) = block_id(&event, Kind::Text) {
                last = Some((waiting.0.clone(), Some(reply)));
                awaiting = None;
            }
        }
        for block in blocks.iter().filter_map(Value::as_object) {
            match str_field(block, "type") {
                Some("tool_use") => {
                    let id = str_field(block, "id");
                    if matches!(str_field(block, "name"), Some("EnterPlanMode" | "ExitPlanMode")) {
                        approved = false;
                    }
                    if approved {
                        continue;
                    }
                    if str_field(block, "name") == Some("ExitPlanMode") && let Some(id) = id
                        && (last_slug.is_some() || last.is_some())
                    {
                        let name = match (&last_slug, &last) {
                            (Some(slug), _) => slug.clone(),
                            (None, Some(c)) => stem(&c.0),
                            (None, None) => unreachable!(),
                        };
                        let anchor = block_id(&event, Kind::ToolUse(id));
                        exits.insert(id.to_owned(), (name.clone(), anchor.clone()));
                        let path = last.as_ref().map_or_else(|| real(&root.join(format!("{name}.md"))), |c| c.0.clone());
                        last = Some((path, anchor));
                        awaiting = None;
                    }
                    let (Some(raw), Some(id)) = (block_path(block), id) else { continue };
                    let path = resolve(raw, cwd);
                    let markdown = path.extension().is_some_and(|e| e.to_string_lossy().eq_ignore_ascii_case("md"));
                    if markdown && path.starts_with(&root) {
                        candidates.insert(id.to_owned(), (path, block_id(&event, Kind::ToolUse(id))));
                    }
                }
                Some("tool_result") => {
                    let id = str_field(block, "tool_use_id").unwrap_or_default();
                    let failed = block.get("is_error") == Some(&Value::Bool(true));
                    let candidate = candidates.remove(id);
                    if let Some(c) = &candidate && !failed {
                        last = Some(c.clone());
                        awaiting = Some(c.clone());
                    }
                    let Some(exit) = exits.remove(id) else { continue };
                    if failed {
                        continue;
                    }
                    if let Some(text) = block.get("content").and_then(Value::as_str)
                        && APPROVED.iter().any(|a| text.starts_with(a))
                    {
                        last = None;
                        confirmed_slug = None;
                        awaiting = None;
                        candidates.clear();
                        approved = true;
                        continue;
                    }
                    let path = match (&candidate, &last) {
                        (Some(c), _) => c.0.clone(),
                        (None, Some(l)) => l.0.clone(),
                        (None, None) => real(&root.join(format!("{}.md", exit.0))),
                    };
                    let anchor = exit.1.clone().or_else(|| last.as_ref().and_then(|l| l.1.clone()));
                    confirmed_slug = Some(exit);
                    last = Some((path.clone(), anchor.clone()));
                    awaiting = Some((path, anchor));
                }
                _ => {}
            }
        }
    }
    if let Some((path, anchor_id)) = last {
        return Some(NativePlan { name: stem(&path), path, anchor_id });
    }
    let (name, anchor_id) = confirmed_slug?;
    let path = real(&root.join(format!("{name}.md")));
    // O slug validado já impede a saída; a fronteira fica explícita se a montagem mudar.
    path.starts_with(&root).then_some(NativePlan { name, path, anchor_id })
}

fn str_field<'a>(map: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    map.get(key).and_then(Value::as_str)
}

fn stem(path: &Path) -> String {
    path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default()
}

/// O `resolve()` do Python: `~` expandido e links seguidos, mesmo para o que ainda não existe.
fn real(path: &Path) -> PathBuf {
    hangar_workspace::real(path)
}

fn resolve(raw: &str, cwd: &Path) -> PathBuf {
    let path = Path::new(raw);
    if path.is_absolute() || raw.starts_with('~') { real(path) } else { real(&cwd.join(path)) }
}

/// O transcript do Claude fica em `<config>/projects/<slug>/<id>.jsonl`.
fn config_dir(transcript: &Path) -> PathBuf {
    let mut parents = transcript.ancestors().skip(1);
    let (_, projects, config) = (parents.next(), parents.next(), parents.next());
    match (projects, config) {
        (Some(p), Some(c)) if p.file_name().is_some_and(|n| n == "projects") => c.to_path_buf(),
        _ => hangar_workspace::home().unwrap_or_default().join(".claude"),
    }
}

/// `plansDirectory` das configurações (conta e projeto, a última vence) ou `<config>/plans`.
fn plans_root(transcript: &Path, cwd: &Path) -> PathBuf {
    let config = config_dir(transcript);
    let mut chosen: Option<Value> = None;
    for file in [config.join("settings.json"), config.join("settings.local.json"),
                 cwd.join(".claude/settings.json"), cwd.join(".claude/settings.local.json")] {
        let read = std::fs::read(&file).ok().and_then(|raw| serde_json::from_slice::<Value>(&raw).ok());
        if let Some(Value::Object(settings)) = read && let Some(v) = settings.get("plansDirectory") {
            chosen = Some(v.clone());
        }
    }
    match chosen.as_ref().and_then(Value::as_str).filter(|s| !s.trim().is_empty()) {
        Some(raw) => resolve(raw, cwd),
        None => real(&config.join("plans")),
    }
}

fn block_path(block: &Map<String, Value>) -> Option<&str> {
    let input = block.get("input")?.as_object()?;
    match str_field(block, "name")? {
        "Write" | "Edit" => str_field(input, "file_path"),
        // Versões que exponham o arquivo no evento do modo plano.
        "ExitPlanMode" => str_field(input, "planFilePath"),
        _ => None,
    }
}

fn human_prompt(content: Option<&Value>) -> bool {
    match content {
        Some(Value::String(s)) => !s.trim().is_empty(),
        Some(Value::Array(blocks)) if !blocks.is_empty() => {
            !blocks.iter().all(|b| b.as_object().is_some_and(|b| str_field(b, "type") == Some("tool_result")))
        }
        _ => false,
    }
}

enum Kind<'a> { Text, ToolUse(&'a str) }

/// O mesmo id que o parser do transcript publica: `uuid` no primeiro bloco visível, `uuid:N` depois.
fn block_id(event: &Map<String, Value>, kind: Kind) -> Option<String> {
    let uuid = str_field(event, "uuid")?;
    let blocks = event.get("message")?.get("content")?.as_array()?;
    let at = |i: usize| if i == 0 { uuid.to_owned() } else { format!("{uuid}:{i}") };
    let mut index = 0;
    for block in blocks.iter().filter_map(Value::as_object) {
        let nonblank = |key: &str| block.get(key).and_then(Value::as_str).is_some_and(|t| !crate::transcript::py::strip(t).is_empty());
        match str_field(block, "type") {
            Some("tool_use") => {
                if let Kind::ToolUse(id) = kind && str_field(block, "id") == Some(id) {
                    return Some(at(index));
                }
                index += 1;
            }
            // Todo bloco de texto ganha posição, como no parser do chat, mesmo vazio ou nulo.
            Some("text") => {
                if matches!(kind, Kind::Text) && nonblank("text") {
                    return Some(at(index));
                }
                index += 1;
            }
            Some("thinking") if nonblank("thinking") => index += 1,
            _ => {}
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn tool(id: &str, path: &Path, sidechain: bool) -> Value {
        json!({"isSidechain": sidechain, "message": {"content": [
            {"type": "tool_use", "id": id, "name": "Write", "input": {"file_path": path}}]}})
    }
    fn result(id: &str, error: bool) -> Value {
        json!({"isSidechain": false, "message": {"content": [
            {"type": "tool_result", "tool_use_id": id, "content": "resultado", "is_error": error}]}})
    }
    fn assistant(uuid: &str, block: Value, slug: Option<&str>) -> Value {
        let mut e = json!({"type": "assistant", "uuid": uuid, "parentUuid": "p", "isSidechain": false,
            "message": {"content": [block]}});
        if let Some(slug) = slug { e["slug"] = json!(slug); }
        e
    }
    fn result_of(uuid: &str, id: &str) -> Value {
        json!({"type": "user", "uuid": uuid, "parentUuid": "p", "isSidechain": false, "message": {"content": [
            {"type": "tool_result", "tool_use_id": id, "content": "resultado", "is_error": false}]}})
    }
    fn human(uuid: &str, text: &str) -> Value {
        json!({"type": "user", "uuid": uuid, "parentUuid": "p", "isSidechain": false,
            "message": {"role": "user", "content": text}})
    }
    fn write(id: &str, path: &Path) -> Value { json!({"type": "tool_use", "id": id, "name": "Write", "input": {"file_path": path}}) }
    fn text(t: &str) -> Value { json!({"type": "text", "text": t}) }
    fn exit(id: &str) -> Value { json!({"type": "tool_use", "id": id, "name": "ExitPlanMode", "input": {}}) }

    /// Raiz temporária já resolvida: o `real` dos caminhos comparados é o mesmo do código.
    fn root() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let path = real(dir.path());
        (dir, path)
    }
    fn transcript(config: &Path, session: &str, lines: &[Value]) -> PathBuf {
        let path = config.join("projects/-projeto").join(format!("{session}.jsonl"));
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, lines.iter().map(Value::to_string).collect::<Vec<_>>().join("\n")).unwrap();
        path
    }

    #[test]
    fn each_session_gets_the_plan_it_wrote() {
        let (_d, tmp) = root();
        let config = tmp.join("conta");
        let (one, two) = (config.join("plans/um.md"), config.join("plans/dois.md"));
        std::fs::create_dir_all(config.join("plans")).unwrap();
        std::fs::write(&one, "# Um").unwrap();
        std::fs::write(&two, "# Dois").unwrap();
        let t1 = transcript(&config, "s1", &[tool("a", &one, false), result("a", false)]);
        let t2 = transcript(&config, "s2", &[tool("b", &two, false), result("b", false)]);
        assert_eq!(discover(&t1, &tmp).unwrap().path, one);
        assert_eq!(discover(&t2, &tmp).unwrap().path, two);
    }

    #[test]
    fn project_plans_directory_wins() {
        let (_d, tmp) = root();
        let project = tmp.join("repo");
        std::fs::create_dir_all(project.join(".claude")).unwrap();
        std::fs::write(project.join(".claude/settings.local.json"), r#"{"plansDirectory": "documentos/planos"}"#).unwrap();
        let plan = project.join("documentos/planos/custom.md");
        std::fs::create_dir_all(plan.parent().unwrap()).unwrap();
        std::fs::write(&plan, "# Custom").unwrap();
        let t = transcript(&tmp.join("conta"), "s1", &[tool("a", &plan, false), result("a", false)]);
        assert_eq!(discover(&t, &project).unwrap().path, plan);
    }

    #[test]
    fn writes_outside_the_root_from_subagents_or_failed_are_ignored() {
        let (_d, tmp) = root();
        let config = tmp.join("conta");
        std::fs::create_dir_all(config.join("plans")).unwrap();
        let valid = config.join("plans/valido.md");
        let t = transcript(&config, "s1", &[
            tool("fora", &tmp.join("segredo.md"), false), result("fora", false),
            tool("sub", &valid, true), result("sub", false),
            tool("falha", &valid, false), result("falha", true)]);
        assert_eq!(discover(&t, &tmp), None);
    }

    #[test]
    fn a_removed_file_keeps_its_metadata() {
        let (_d, tmp) = root();
        let config = tmp.join("conta");
        let plan = config.join("plans/removido.md");
        let t = transcript(&config, "s1", &[tool("a", &plan, false), result("a", false)]);
        assert_eq!(discover(&t, &tmp).unwrap().path, plan);
    }

    #[test]
    fn native_slug_names_the_plan_and_a_malformed_one_never_escapes() {
        let (_d, tmp) = root();
        let config = tmp.join("conta");
        let t = transcript(&config, "s1", &[
            json!({"type": "system", "subtype": "compact_boundary", "slug": "plano-nativo", "isSidechain": false}),
            json!({"slug": "plano-nativo", "isSidechain": false, "message": {"content": [
                {"type": "tool_use", "id": "sair", "name": "ExitPlanMode", "input": {"plan": "# Plano"}}]}}),
            result("sair", false)]);
        let found = discover(&t, &tmp).unwrap();
        assert_eq!((found.name.as_str(), found.path), ("plano-nativo", config.join("plans/plano-nativo.md")));
        let bad = transcript(&config, "s2", &[json!({"type": "system", "slug": "../../segredo", "isSidechain": false})]);
        assert_eq!(discover(&bad, &tmp), None);
        let normal = transcript(&config, "s3", &[json!({"type": "user", "slug": "sessao-normal", "isSidechain": false})]);
        assert_eq!(discover(&normal, &tmp), None);
    }

    #[test]
    fn native_approval_closes_the_plan_without_a_new_prompt() {
        for reply in ["User has approved your plan. You can now start coding.",
                      "User has approved exiting plan mode. You can now proceed.",
                      "User has approved the plan. There is nothing else needed from you now. Please respond with \"ok\""] {
            let (_d, tmp) = root();
            let config = tmp.join("conta");
            let mut lines = vec![assistant("proposta", exit("exit"), Some("plano-nativo"))];
            let t = transcript(&config, "s1", &lines);
            assert_eq!(discover(&t, &tmp).unwrap().anchor_id.as_deref(), Some("proposta"));
            lines.push(json!({"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": "exit", "content": reply}]}}));
            lines.push(assistant("implementando", text("OK"), None));
            lines.push(tool("progresso", &config.join("plans/plano-nativo.md"), false));
            lines.push(result("progresso", false));
            let t = transcript(&config, "s1", &lines);
            assert_eq!(discover(&t, &tmp), None, "{reply}");
        }
    }

    #[test]
    fn submitting_to_the_team_lead_is_not_approval() {
        let (_d, tmp) = root();
        let t = transcript(&tmp.join("conta"), "s1", &[
            assistant("proposta", exit("exit"), Some("plano-nativo")),
            json!({"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": "exit",
                "content": "Your plan has been submitted to the team lead for approval."}]}})]);
        assert_eq!(discover(&t, &tmp).unwrap().anchor_id.as_deref(), Some("proposta"));
    }

    #[test]
    fn a_confirmed_write_beats_a_generic_slug() {
        let (_d, tmp) = root();
        let config = tmp.join("conta");
        let plan = config.join("plans/nome-escolhido.md");
        let t = transcript(&config, "s1", &[
            json!({"type": "user", "slug": "slug-generico", "isSidechain": false}),
            tool("escrita", &plan, false), result("escrita", false)]);
        assert_eq!(discover(&t, &tmp).unwrap().path, plan);
    }

    #[test]
    fn a_human_reply_closes_the_previous_proposal() {
        let (_d, tmp) = root();
        let config = tmp.join("conta");
        let plan = config.join("plans/turno.md");
        let t = transcript(&config, "s1", &[
            human("u1", "crie um plano"), assistant("a-write", write("write-1", &plan), None),
            result_of("r1", "write-1"), assistant("a-plan", text("Plano confirmado."), None),
            human("u2", "pergunta posterior"), assistant("a-longe", text("Resposta posterior alheia."), None)]);
        assert_eq!(discover(&t, &tmp), None);
        let t = transcript(&config, "s2", &[
            human("u1", "crie o plano"), assistant("a-write", write("write-1", &plan), None),
            result_of("r1", "write-1"), human("u2", "outra pergunta")]);
        assert_eq!(discover(&t, &tmp), None, "escrita sem texto não volta depois de outro prompt");
    }

    #[test]
    fn a_new_plan_next_turn_moves_path_and_anchor() {
        let (_d, tmp) = root();
        let config = tmp.join("conta");
        let (first, second) = (config.join("plans/primeiro.md"), config.join("plans/segundo.md"));
        let t = transcript(&config, "s1", &[
            human("u1", "primeiro"), assistant("a-write-1", write("write-1", &first), None),
            result_of("r1", "write-1"), assistant("a-plan-1", text("Plano primeiro."), None),
            human("u2", "segundo"), assistant("a-write-2", write("write-2", &second), None),
            result_of("r2", "write-2"), assistant("a-plan-2", text("Plano segundo."), None)]);
        let found = discover(&t, &tmp).unwrap();
        assert_eq!((found.path, found.anchor_id.as_deref()), (second, Some("a-plan-2")));
    }

    #[test]
    fn anchor_counts_every_text_block_like_the_chat_parser() {
        let event = json!({"uuid": "u", "message": {"content": [
            {"type": "text", "text": null}, {"type": "thinking", "thinking": "  "}, {"type": "text", "text": ""},
            {"type": "tool_use", "id": "t"}, {"type": "text", "text": "Plano."}]}});
        let event = event.as_object().unwrap();
        assert_eq!(block_id(event, Kind::ToolUse("t")).as_deref(), Some("u:2"));
        assert_eq!(block_id(event, Kind::Text).as_deref(), Some("u:3"));
    }

    #[test]
    fn a_confirmed_write_beats_exit_plan_mode_and_keeps_the_reply_anchor() {
        let (_d, tmp) = root();
        let config = tmp.join("conta");
        let plan = config.join("plans/chosen.md");
        let t = transcript(&config, "s1", &[
            human("u1", "crie o plano"), assistant("a-write", write("write-1", &plan), None),
            result_of("r1", "write-1"),
            assistant("a-exit", json!({"type": "tool_use", "id": "exit-1", "name": "ExitPlanMode", "input": {"plan": "# genérico"}}), Some("slug-generico")),
            result_of("r2", "exit-1"), assistant("a-plan", text("Plano escolhido."), None)]);
        assert_eq!(discover(&t, &tmp), Some(NativePlan { name: "chosen".into(), path: plan, anchor_id: Some("a-plan".into()) }));
    }
}
