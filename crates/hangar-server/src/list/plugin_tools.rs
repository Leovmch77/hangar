//! Servidores MCP que um plugin do Claude Code cria com `$.tool.register`. O Claude Code mostra as
//! chamadas deles sozinhas, com o ponto, e dobra as dos outros servidores; o transcript só diz quais
//! são pelo anexo `mcp_instructions_delta`, cujo bloco traz a instrução fixa desses servidores.
use std::io::{BufRead, BufReader, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};

use serde_json::{Map, Value};

use super::capped::Capped;

const MARK: &[u8] = b"\"mcp_instructions_delta\"";
const PREFIX: &str = "Tools registered by the ";
const SUFFIX: &str = " plugin through $.tool.register.";

#[derive(Clone, Default)]
struct Scan { offset: u64, servers: Vec<String> }

static SCANS: LazyLock<Mutex<Capped<PathBuf, Scan>>> = LazyLock::new(Default::default);

/// O nome como o Claude Code o põe em `mcp__<nome>__<ferramenta>`.
fn tool_name_server(name: &str) -> String {
    name.chars().map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '-' { c } else { '_' }).collect()
}

fn strings<'a>(attachment: &'a Map<String, Value>, key: &str) -> impl Iterator<Item = &'a str> {
    attachment.get(key).and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str)
}

/// O servidor de um bloco `## <nome>\n<instrução>` quando a instrução é a do servidor de um plugin. Só a
/// primeira linha é a fixa: o Claude Code acrescenta parágrafos depois dela (o aviso do modo de permissão).
fn plugin_block(block: &str) -> Option<&str> {
    let (head, body) = block.split_once('\n')?;
    let first = body.trim_start().lines().next()?.trim_end();
    (first.starts_with(PREFIX) && first.ends_with(SUFFIX)).then_some(head.strip_prefix("## ")?)
}

/// Um anexo `mcp_instructions_delta`: o que saiu ou foi trocado deixa de contar; o que entrou conta se for de plugin.
fn apply_delta(servers: &mut Vec<String>, attachment: &Map<String, Value>) {
    for name in strings(attachment, "removedNames").chain(strings(attachment, "addedNames")) {
        let name = tool_name_server(name);
        servers.retain(|s| *s != name);
    }
    for name in strings(attachment, "addedBlocks").filter_map(plugin_block) {
        let name = tool_name_server(name);
        if !servers.contains(&name) { servers.push(name); }
    }
}

/// Só as linhas inteiras novas: a última, ainda sendo escrita, fica para a próxima leitura.
fn read_from(path: &Path, scan: &mut Scan) -> std::io::Result<()> {
    let mut file = std::fs::File::open(path)?;
    file.seek(SeekFrom::Start(scan.offset))?;
    let mut reader = BufReader::with_capacity(1 << 16, file);
    let mut line = Vec::new();
    loop {
        line.clear();
        let read = reader.read_until(b'\n', &mut line)?;
        if read == 0 || line.last() != Some(&b'\n') { return Ok(()); }
        scan.offset += read as u64;
        if memchr::memmem::find(&line, MARK).is_none() { continue; }
        let Ok(Value::Object(obj)) = serde_json::from_slice::<Value>(&line) else { continue };
        if let Some(Value::Object(attachment)) = obj.get("attachment")
            && attachment.get("type").and_then(Value::as_str) == Some("mcp_instructions_delta")
        {
            apply_delta(&mut scan.servers, attachment);
        }
    }
}

/// Os servidores de plugin do transcript. A primeira leitura percorre o arquivo inteiro; as seguintes,
/// só o que ele ganhou. Arquivo menor que o já lido foi trocado e é relido do começo.
pub fn plugin_tool_servers(path: &Path) -> Vec<String> {
    let Ok(len) = std::fs::metadata(path).map(|m| m.len()) else { return Vec::new() };
    let cached = |scans: &mut Capped<PathBuf, Scan>| scans.get(path).filter(|s| s.offset <= len).cloned();
    let mut scan = cached(&mut SCANS.lock().unwrap_or_else(|e| e.into_inner())).unwrap_or_default();
    if scan.offset < len {
        // Fora do cadeado: a primeira leitura de um transcript grande não segura as outras linhas. Leitura que
        // falhou no meio aplicou parte dos anexos: vale o que o cache tem.
        if read_from(path, &mut scan).is_err() {
            return cached(&mut SCANS.lock().unwrap_or_else(|e| e.into_inner())).map(|s| s.servers).unwrap_or_default();
        }
        SCANS.lock().unwrap_or_else(|e| e.into_inner()).insert(path.to_path_buf(), scan.clone());
    }
    scan.servers
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::io::Write;

    const PLUGIN: &str = "Tools registered by the pmedico plugin through $.tool.register.";

    fn delta(added: &[(&str, &str)], removed: &[&str]) -> String {
        json!({"parentUuid": null, "isSidechain": false, "attachment": {"type": "mcp_instructions_delta",
            "addedNames": added.iter().map(|(name, _)| *name).collect::<Vec<_>>(),
            "addedBlocks": added.iter().map(|(name, body)| format!("## {name}\n{body}")).collect::<Vec<_>>(),
            "removedNames": removed}, "type": "attachment", "uuid": "u", "timestamp": "2026-10-14T00:00:00.000Z"}).to_string()
    }

    fn apply(servers: &mut Vec<String>, line: &str) {
        let obj: Value = serde_json::from_str(line).unwrap();
        apply_delta(servers, obj["attachment"].as_object().unwrap());
    }

    #[test]
    fn only_servers_with_the_plugin_instruction_count() {
        let mut servers = Vec::new();
        apply(&mut servers, &delta(&[("ai-memory", "Long-term memory for the current project."), ("pmedico", PLUGIN)], &[]));
        assert_eq!(servers, vec!["pmedico".to_owned()]);
    }

    #[test]
    fn only_the_first_line_of_the_block_is_the_plugin_instruction() {
        let mut servers = Vec::new();
        let extra = format!("{PLUGIN}\n\nWhile bypass permissions mode is active: use Bash.");
        let fake = format!("Servidor comum.\n{PLUGIN}");
        apply(&mut servers, &delta(&[("pmedico", &extra), ("outro", &fake)], &[]));
        assert_eq!(servers, vec!["pmedico".to_owned()], "parágrafo depois conta; instrução no meio de outra não");
    }

    #[test]
    fn a_removed_or_replaced_server_stops_counting() {
        let mut servers = vec!["pmedico".to_owned(), "kit".to_owned()];
        apply(&mut servers, &delta(&[], &["pmedico"]));
        assert_eq!(servers, vec!["kit".to_owned()]);
        apply(&mut servers, &delta(&[("kit", "Servidor comum com o mesmo nome.")], &[]));
        assert!(servers.is_empty());
    }

    #[test]
    fn names_follow_the_tool_name_rule() {
        assert_eq!(tool_name_server("meu plugin.x"), "meu_plugin_x");
        assert_eq!(tool_name_server("hangar-computer-control"), "hangar-computer-control");
        let mut servers = Vec::new();
        apply(&mut servers, &delta(&[("meu plugin", "Tools registered by the meu plugin plugin through $.tool.register.")], &[]));
        assert_eq!(servers, vec!["meu_plugin".to_owned()]);
    }

    #[test]
    fn a_transcript_without_delta_has_no_plugin_servers() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("s.jsonl");
        std::fs::write(&path, format!("{}\n", json!({"type": "user", "message": {"content": "oi"}}))).unwrap();
        assert!(plugin_tool_servers(&path).is_empty());
        assert!(plugin_tool_servers(&dir.path().join("ausente.jsonl")).is_empty());
    }

    #[test]
    fn the_scan_reads_only_new_whole_lines_and_restarts_on_a_shorter_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("s.jsonl");
        let mut file = std::fs::File::create(&path).unwrap();
        writeln!(file, "{}", json!({"type": "user", "message": {"content": "oi"}})).unwrap();
        // Linha ainda sem o fim: o Claude Code está escrevendo e ela não conta.
        write!(file, "{}", delta(&[("pmedico", PLUGIN)], &[])).unwrap();
        file.flush().unwrap();
        assert!(plugin_tool_servers(&path).is_empty());
        writeln!(file).unwrap();
        file.flush().unwrap();
        assert_eq!(plugin_tool_servers(&path), vec!["pmedico".to_owned()]);
        writeln!(file, "{}", delta(&[], &["pmedico"])).unwrap();
        file.flush().unwrap();
        assert!(plugin_tool_servers(&path).is_empty());
        // Arquivo trocado por um menor: relido do começo.
        std::fs::write(&path, format!("{}\n", delta(&[("kit", "Tools registered by the kit plugin through $.tool.register.")], &[]))).unwrap();
        assert_eq!(plugin_tool_servers(&path), vec!["kit".to_owned()]);
    }
}
