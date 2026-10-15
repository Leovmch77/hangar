//! Servidores MCP que um plugin do Claude Code cria com `$.tool.register`. O Claude Code mostra as
//! chamadas deles sozinhas, com o ponto, e dobra as dos outros servidores; o transcript só diz quais
//! são pelo anexo `mcp_instructions_delta`, cujo bloco traz a instrução fixa desses servidores.
use std::fs::{File, Metadata};
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};

use serde_json::{Map, Value};

use super::capped::Capped;

const MARK: &[u8] = b"\"mcp_instructions_delta\"";
const PREFIX: &str = "Tools registered by the ";
const SUFFIX: &str = " plugin through $.tool.register.";

/// Bytes do fim do trecho já lido conferidos antes de continuar: o mesmo arquivo reescrito no lugar (mesmo inode)
/// não muda a identidade.
const TAIL: usize = 256;

#[cfg(unix)]
type Identity = (u64, u64);
#[cfg(not(unix))]
type Identity = Option<std::time::SystemTime>;

/// Quem é o arquivo, estável enquanto ele só cresce: volume e inode no Unix; a data de criação nos outros,
/// porque a de modificação muda a cada linha acrescentada.
fn identity(metadata: &Metadata) -> Identity {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        (metadata.dev(), metadata.ino())
    }
    #[cfg(not(unix))]
    {
        metadata.created().ok()
    }
}

#[derive(Clone, Default)]
struct Scan { offset: u64, identity: Identity, tail: Vec<u8>, servers: Vec<String> }

impl Scan {
    /// O arquivo ainda é o que foi lido até `offset`: mesma identidade, não encolheu e termina nos mesmos bytes.
    fn continues(&self, file: &mut File, len: u64, identity: &Identity) -> bool {
        if self.offset > len || self.identity != *identity { return false; }
        let mut tail = vec![0; self.tail.len()];
        file.seek(SeekFrom::Start(self.offset - tail.len() as u64)).is_ok()
            && file.read_exact(&mut tail).is_ok() && tail == self.tail
    }

    fn remember(&mut self, line: &[u8]) {
        if line.len() >= TAIL {
            self.tail = line[line.len() - TAIL..].to_vec();
        } else {
            self.tail.extend_from_slice(line);
            let excess = self.tail.len().saturating_sub(TAIL);
            self.tail.drain(..excess);
        }
    }
}

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
fn read_from(mut file: File, scan: &mut Scan) -> std::io::Result<()> {
    file.seek(SeekFrom::Start(scan.offset))?;
    let mut reader = BufReader::with_capacity(1 << 16, file);
    let mut line = Vec::new();
    loop {
        line.clear();
        let read = reader.read_until(b'\n', &mut line)?;
        if read == 0 || line.last() != Some(&b'\n') { return Ok(()); }
        scan.offset += read as u64;
        scan.remember(&line);
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
/// só o que ele ganhou. Arquivo trocado (outra identidade, menor ou com outro fim no trecho lido) é relido do começo.
pub fn plugin_tool_servers(path: &Path) -> Vec<String> {
    let Ok(mut file) = File::open(path) else { return Vec::new() };
    let Ok(metadata) = file.metadata() else { return Vec::new() };
    let (len, id) = (metadata.len(), identity(&metadata));
    let cached = SCANS.lock().unwrap_or_else(|e| e.into_inner()).get(path).cloned()
        .filter(|s| s.continues(&mut file, len, &id));
    let restarted = cached.is_none();
    let mut scan = cached.unwrap_or_else(|| Scan { identity: id, ..Scan::default() });
    if scan.offset < len {
        // Fora do cadeado: a primeira leitura de um transcript grande não segura as outras linhas. Leitura que
        // falhou no meio aplicou parte dos anexos: vale o que o cache tem, se ainda for deste arquivo.
        if read_from(file, &mut scan).is_err() {
            if restarted { return Vec::new(); }
            return SCANS.lock().unwrap_or_else(|e| e.into_inner()).get(path).map(|s| s.servers.clone()).unwrap_or_default();
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

    #[test]
    fn a_file_replaced_by_one_of_equal_or_greater_size_is_read_from_scratch() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("s.jsonl");
        let kit = |name: &str| delta(&[(name, &format!("Tools registered by the {name} plugin through $.tool.register."))], &[]);
        std::fs::write(&path, format!("{}\n", kit("aaa"))).unwrap();
        assert_eq!(plugin_tool_servers(&path), vec!["aaa".to_owned()]);
        // Outro arquivo, por rename, do mesmo tamanho: sem o delta que removia "aaa", ele não pode sobrar.
        let other = dir.path().join("novo.jsonl");
        std::fs::write(&other, format!("{}\n", kit("bbb"))).unwrap();
        std::fs::rename(&other, &path).unwrap();
        assert_eq!(plugin_tool_servers(&path), vec!["bbb".to_owned()]);
        // Reescrito no lugar (mesmo inode), maior: também relido do começo.
        std::fs::write(&path, format!("{}\n{}\n", kit("ccc"), kit("ddd"))).unwrap();
        assert_eq!(plugin_tool_servers(&path), vec!["ccc".to_owned(), "ddd".to_owned()]);
        // Reescrito no lugar com o mesmo tamanho exato.
        std::fs::write(&path, format!("{}\n{}\n", kit("eee"), kit("fff"))).unwrap();
        assert_eq!(plugin_tool_servers(&path), vec!["eee".to_owned(), "fff".to_owned()]);
    }
}
