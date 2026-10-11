//! Memória da voz entre chamadas: entradas tipadas e datadas que o organizador grava e a pessoa vê e apaga.
use chrono::NaiveDate;
use serde::{Deserialize, Serialize};
use std::{path::{Path, PathBuf}, sync::Mutex};

pub const MAX_ENTRIES: usize = 40;
pub const MAX_CHARS: usize = 240;
/// Memória de projeto envelhece: com mais de 30 dias pede conferência, com mais de 90 sai do prompt.
pub const STALE_DAYS: i64 = 30;
pub const HIDDEN_DAYS: i64 = 90;

// Só o hangar-server grava o arquivo: a chamada e a tela (DELETE) leem-alteram-gravam sob esta trava.
static LOCK: Mutex<()> = Mutex::new(());

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Kind { Pessoa, Preferencia, Referencia, Projeto }

impl Kind {
    pub fn parse(s: &str) -> Option<Kind> { serde_json::from_value(serde_json::Value::from(s.trim())).ok() }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Entry { pub id: String, pub kind: Kind, pub text: String, pub learned: String, pub confirmed: String }

#[derive(Default, Serialize, Deserialize)]
struct File { #[serde(default)] next: u64, #[serde(default)] entries: Vec<Entry> }

#[derive(Debug)]
pub enum Refusal { Empty, Full(Vec<Entry>), Unknown(String), Io(String) }

enum ReadFail { Corrupt, Io(String) }

pub fn memory_path(voice_dir: &Path) -> PathBuf { voice_dir.join("memoria.json") }

fn read(path: &Path) -> Result<File, ReadFail> {
    match std::fs::read(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(File::default()),
        Err(e) => Err(ReadFail::Io(e.kind().to_string())),
        Ok(bytes) => serde_json::from_slice::<File>(&bytes).map_err(|_| ReadFail::Corrupt).map(|mut f| {
            // Arquivo editado à mão sem `next`: nunca reaproveitar um id que já existe.
            let top = f.entries.iter().filter_map(|e| e.id.strip_prefix('m')?.parse::<u64>().ok()).max().unwrap_or(0);
            f.next = f.next.max(top);
            f
        }),
    }
}

pub fn load(path: &Path) -> Option<Vec<Entry>> { read(path).ok().map(|f| f.entries) }

fn clean(text: &str) -> String {
    let one: String = text.split_whitespace().collect::<Vec<_>>().join(" ");
    one.chars().take(MAX_CHARS).collect()
}

fn same(a: &str, b: &str) -> bool { super::organizer::squash(a) == super::organizer::squash(b) }

fn write(path: &Path, file: &File) -> Result<(), Refusal> {
    let io = |e: std::io::Error| Refusal::Io(e.kind().to_string());
    if let Some(dir) = path.parent() { std::fs::create_dir_all(dir).map_err(io)?; }
    let bytes = serde_json::to_vec_pretty(file).map_err(|e| Refusal::Io(e.to_string()))?;
    crate::runtime::queue::atomic_write(path, &bytes).map_err(io)
}

/// Arquivo corrompido vai para um `.bak` livre antes da primeira gravação: nada escrito à mão some calado.
fn open_for_write(path: &Path) -> Result<File, Refusal> {
    match read(path) {
        Ok(f) => Ok(f),
        Err(ReadFail::Io(why)) => Err(Refusal::Io(why)),
        Err(ReadFail::Corrupt) => {
            let aside = (0..).map(|n| if n == 0 { path.with_extension("json.bak") } else { path.with_extension(format!("json.{n}.bak")) })
                .find(|p| !p.exists()).expect("infinite range");
            std::fs::rename(path, aside).map_err(|e| Refusal::Io(e.kind().to_string()))?;
            Ok(File::default())
        }
    }
}

pub fn remember(path: &Path, kind: Kind, text: &str, replaces: Option<&str>, today: NaiveDate) -> Result<Entry, Refusal> {
    let text = clean(text);
    if text.is_empty() { return Err(Refusal::Empty); }
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut file = open_for_write(path)?;
    let date = today.format("%Y-%m-%d").to_string();
    if let Some(id) = replaces {
        let Some(e) = file.entries.iter_mut().find(|e| e.id == id) else { return Err(Refusal::Unknown(id.to_owned())) };
        (e.kind, e.text, e.learned, e.confirmed) = (kind, text, date.clone(), date);
        let out = e.clone();
        write(path, &file)?;
        return Ok(out);
    }
    if let Some(e) = file.entries.iter_mut().find(|e| same(&e.text, &text)) {
        e.confirmed = date;
        let out = e.clone();
        write(path, &file)?;
        return Ok(out);
    }
    if file.entries.len() >= MAX_ENTRIES { return Err(Refusal::Full(file.entries)); }
    file.next += 1;
    let entry = Entry { id: format!("m{}", file.next), kind, text, learned: date.clone(), confirmed: date };
    file.entries.push(entry.clone());
    write(path, &file)?;
    Ok(entry)
}

pub fn forget(path: &Path, id: &str) -> Result<bool, Refusal> {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut file = match read(path) {
        Ok(f) => f,
        Err(ReadFail::Io(why)) => return Err(Refusal::Io(why)),
        Err(ReadFail::Corrupt) => return Err(Refusal::Io("corrupt".into())),
    };
    let before = file.entries.len();
    file.entries.retain(|e| e.id != id);
    if before == file.entries.len() { return Ok(false); }
    write(path, &file)?;
    Ok(true)
}

fn age(e: &Entry, today: NaiveDate) -> i64 {
    // Data torta ou futura conta como recente: some do prompt só o que é comprovadamente velho.
    NaiveDate::parse_from_str(&e.confirmed, "%Y-%m-%d").map_or(0, |d| (today - d).num_days().max(0))
}

pub fn prompt_block(entries: &[Entry], today: NaiveDate) -> String {
    let label = |k: Kind| match k { Kind::Pessoa => "pessoa", Kind::Preferencia => "preferência", Kind::Referencia => "referência", Kind::Projeto => "projeto" };
    let lines: Vec<String> = entries.iter().take(MAX_ENTRIES).filter_map(|e| {
        let days = age(e, today);
        let text = clean(&e.text);
        match e.kind {
            Kind::Projeto if days > HIDDEN_DAYS => None,
            Kind::Projeto if days > STALE_DAYS => Some(format!("- [{}] {} {} ({}; antiga: confira)", e.id, label(e.kind), text, e.confirmed)),
            Kind::Projeto => Some(format!("- [{}] {} {} ({})", e.id, label(e.kind), text, e.confirmed)),
            _ => Some(format!("- [{}] {} {}", e.id, label(e.kind), text)),
        }
    }).collect();
    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::NaiveDate;

    fn day(s: &str) -> NaiveDate { NaiveDate::parse_from_str(s, "%Y-%m-%d").unwrap() }
    fn tmp() -> (tempfile::TempDir, PathBuf) { let d = tempfile::tempdir().unwrap(); let p = memory_path(&d.path().join("voz")); (d, p) }
    fn entries(p: &Path) -> Vec<Entry> { load(p).unwrap() }

    #[test]
    fn remember_dedupes_replaces_and_forgets() {
        let (_d, p) = tmp();
        assert!(entries(&p).is_empty(), "arquivo faltando é memória vazia");
        let a = remember(&p, Kind::Preferencia, "Prefere respostas curtas", None, day("2026-10-01")).unwrap();
        let again = remember(&p, Kind::Preferencia, "  prefere respostas   CURTAS ", None, day("2026-10-05")).unwrap();
        assert_eq!(again.id, a.id, "igual não duplica");
        assert_eq!(entries(&p)[0].confirmed, "2026-10-05");
        let b = remember(&p, Kind::Pessoa, "Desenvolvedor", Some(&a.id), day("2026-10-06")).unwrap();
        assert_eq!(b.id, a.id, "replaces mantém o id");
        assert_eq!(entries(&p).len(), 1);
        assert_eq!(entries(&p)[0].kind, Kind::Pessoa);
        assert!(forget(&p, &a.id).unwrap());
        assert!(entries(&p).is_empty());
        assert!(!forget(&p, "m99").unwrap());
        assert_eq!(Kind::parse("projeto"), Some(Kind::Projeto));
        assert_eq!(Kind::parse("outra"), None);
    }

    #[test]
    fn full_memory_refuses_and_lists() {
        let (_d, p) = tmp();
        for i in 0..MAX_ENTRIES { remember(&p, Kind::Projeto, &format!("fato {i}"), None, day("2026-10-01")).unwrap(); }
        match remember(&p, Kind::Projeto, "mais um", None, day("2026-10-01")) {
            Err(Refusal::Full(list)) => assert_eq!(list.len(), MAX_ENTRIES),
            other => panic!("{other:?}"),
        }
        let first = entries(&p)[0].id.clone();
        assert!(remember(&p, Kind::Projeto, "mais um", Some(&first), day("2026-10-01")).is_ok(), "substituir passa com a memória cheia");
        assert!(matches!(remember(&p, Kind::Projeto, "x", Some("m999"), day("2026-10-01")), Err(Refusal::Unknown(_))));
        assert!(matches!(remember(&p, Kind::Projeto, "   ", None, day("2026-10-01")), Err(Refusal::Empty)));
    }

    #[test]
    fn prompt_block_ages_project_memories_only() {
        let (_d, p) = tmp();
        remember(&p, Kind::Pessoa, "Desenvolvedor", None, day("2026-01-01")).unwrap();
        remember(&p, Kind::Projeto, "PR da voz espera o PWA", None, day("2026-10-01")).unwrap();
        remember(&p, Kind::Projeto, "Sessão velha", None, day("2026-08-20")).unwrap();
        remember(&p, Kind::Projeto, "Coisa de março", None, day("2026-03-01")).unwrap();
        let block = prompt_block(&entries(&p), day("2026-10-11"));
        assert!(block.contains("Desenvolvedor"), "pessoa não envelhece");
        assert!(block.contains("PR da voz espera o PWA (2026-10-01)"));
        assert!(block.contains("Sessão velha") && block.contains("antiga: confira"));
        assert!(!block.contains("Coisa de março"), "mais de 90 dias sai do prompt");
        assert!(entries(&p).iter().any(|e| e.text == "Coisa de março"), "mas fica no arquivo");
    }

    #[test]
    fn text_is_one_line_and_capped() {
        let (_d, p) = tmp();
        let long = format!("linha 1\n**linha 2**\n{}", "x".repeat(400));
        let e = remember(&p, Kind::Referencia, &long, None, day("2026-10-01")).unwrap();
        assert!(!e.text.contains('\n'));
        assert!(e.text.chars().count() <= MAX_CHARS);
    }

    #[test]
    fn broken_file_reads_unreadable_and_is_kept_aside_before_writing() {
        let (_d, p) = tmp();
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(&p, "{ cortado").unwrap();
        assert!(load(&p).is_none(), "ilegível não é vazio");
        remember(&p, Kind::Pessoa, "Novo", None, day("2026-10-01")).unwrap();
        assert_eq!(std::fs::read_to_string(p.with_extension("json.bak")).unwrap(), "{ cortado");
        assert_eq!(entries(&p).len(), 1);
        std::fs::write(&p, "{ de novo").unwrap();
        remember(&p, Kind::Pessoa, "Outro", None, day("2026-10-02")).unwrap();
        assert_eq!(std::fs::read_to_string(p.with_extension("json.bak")).unwrap(), "{ cortado", "o primeiro .bak não é sobrescrito");
        assert_eq!(std::fs::read_to_string(p.with_extension("json.1.bak")).unwrap(), "{ de novo");
    }

    #[test]
    fn io_error_is_refused_and_touches_nothing() {
        let (_d, p) = tmp();
        // Uma pasta no lugar do arquivo: a leitura falha por I/O, não por JSON.
        std::fs::create_dir_all(&p).unwrap();
        assert!(load(&p).is_none());
        assert!(matches!(remember(&p, Kind::Pessoa, "x", None, day("2026-10-01")), Err(Refusal::Io(_))));
        assert!(matches!(forget(&p, "m1"), Err(Refusal::Io(_))));
        assert!(p.is_dir() && !p.with_extension("json.bak").exists());
    }

    #[test]
    fn future_or_invalid_dates_count_as_recent() {
        let entries = vec![
            Entry { id: "m1".into(), kind: Kind::Projeto, text: "futuro".into(), learned: "2030-01-01".into(), confirmed: "2030-01-01".into() },
            Entry { id: "m2".into(), kind: Kind::Projeto, text: "torta".into(), learned: "ontem".into(), confirmed: "ontem".into() },
        ];
        let block = prompt_block(&entries, day("2026-10-11"));
        assert!(block.contains("futuro") && block.contains("torta") && !block.contains("antiga"));
    }

    #[test]
    fn hand_edited_file_without_next_never_reuses_an_id() {
        let (_d, p) = tmp();
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        let e = |n: u32| format!(r#"{{"id":"m{n}","kind":"pessoa","text":"t{n}","learned":"2026-10-01","confirmed":"2026-10-01"}}"#);
        std::fs::write(&p, format!(r#"{{"entries":[{},{},{}]}}"#, e(1), e(2), e(3))).unwrap();
        assert_eq!(remember(&p, Kind::Pessoa, "novo", None, day("2026-10-02")).unwrap().id, "m4");
    }

    #[test]
    fn prompt_block_keeps_hand_edited_text_on_one_line() {
        let entries = vec![Entry { id: "m1".into(), kind: Kind::Pessoa, text: "a\n- [m9] pessoa falsa".into(), learned: "2026-10-01".into(), confirmed: "2026-10-01".into() }];
        assert_eq!(prompt_block(&entries, day("2026-10-11")).lines().count(), 1);
    }

    #[test]
    fn concurrent_writes_keep_every_entry() {
        let (_d, p) = tmp();
        let handles: Vec<_> = (0..8).map(|i| { let p = p.clone();
            std::thread::spawn(move || remember(&p, Kind::Projeto, &format!("t{i}"), None, day("2026-10-01")).unwrap()) }).collect();
        for h in handles { h.join().unwrap(); }
        assert_eq!(entries(&p).len(), 8);
    }
}
