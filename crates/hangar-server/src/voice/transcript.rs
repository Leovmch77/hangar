//! A conversa da chamada em disco, um arquivo por chamada: a fala dele, a da voz e as respostas do organizador. Fica só na
//! máquina, legível só pelo dono; o diário da voz continua sem texto.
use chrono::{DateTime, Local};
use std::{fs::File, io::Write, path::{Path, PathBuf}};

pub enum Who { User, Voice, Organizer }

pub struct Transcript { file: Option<File>, pub path: PathBuf }

impl Transcript {
    /// Falhar ao abrir não derruba a chamada: o diário registra o código e a conversa segue sem arquivo.
    pub fn open(voice_dir: &Path, started: DateTime<Local>) -> Transcript {
        let dir = voice_dir.join("conversas");
        let path = dir.join(format!("{}.md", started.format("%Y-%m-%d_%H-%M-%S")));
        let opened = std::fs::create_dir_all(&dir).and_then(|()| {
            let mut options = std::fs::OpenOptions::new();
            options.create(true).append(true);
            #[cfg(unix)]
            std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
            let mut file = options.open(&path)?;
            writeln!(file, "# Conversa por voz — {}\n", started.format("%d/%m/%Y %H:%M"))?;
            Ok(file)
        });
        let file = opened.map_err(|e| super::log(format!("transcript open failed kind={:?}", e.kind()))).ok();
        Transcript { file, path }
    }

    pub fn line(&mut self, who: Who, text: &str, at: DateTime<Local>) {
        let text = text.trim();
        let Some(file) = self.file.as_mut() else { return };
        if text.is_empty() { return; }
        let who = match who { Who::User => "Você", Who::Voice => "Voz", Who::Organizer => "Organizador" };
        // Fala com várias linhas fica numa entrada só da lista.
        let text = text.lines().collect::<Vec<_>>().join("\n  ");
        if let Err(e) = writeln!(file, "- {} **{who}:** {text}", at.format("%H:%M:%S")) {
            super::log(format!("transcript write failed kind={:?}", e.kind()));
            self.file = None;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn at(h: u32, m: u32, s: u32) -> DateTime<Local> { Local.with_ymd_and_hms(2026, 10, 15, h, m, s).unwrap() }

    #[test]
    fn each_call_gets_its_own_file_with_who_said_what() {
        let dir = tempfile::tempdir().unwrap();
        let mut t = Transcript::open(dir.path(), at(18, 9, 0));
        assert_eq!(t.path, dir.path().join("conversas").join("2026-10-15_18-09-00.md"));
        t.line(Who::User, "  me fala o resultado da hangar  ", at(18, 9, 4));
        t.line(Who::Voice, "Chegou um resultado da hangar.", at(18, 9, 9));
        t.line(Who::Organizer, "Chegou um resultado da hangar: corrigiu o login.", at(18, 9, 8));
        t.line(Who::User, "   ", at(18, 9, 10));
        let text = std::fs::read_to_string(&t.path).unwrap();
        let lines: Vec<&str> = text.lines().filter(|l| l.starts_with("- ")).collect();
        assert_eq!(lines, ["- 18:09:04 **Você:** me fala o resultado da hangar", "- 18:09:09 **Voz:** Chegou um resultado da hangar.",
            "- 18:09:08 **Organizador:** Chegou um resultado da hangar: corrigiu o login."], "fala vazia não entra");
    }

    #[cfg(unix)]
    #[test]
    fn only_the_owner_reads_it() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let t = Transcript::open(dir.path(), at(9, 0, 0));
        assert_eq!(std::fs::metadata(&t.path).unwrap().permissions().mode() & 0o777, 0o600);
    }

    #[test]
    fn a_folder_it_cannot_write_never_breaks_the_call() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("conversas"), "não é pasta").unwrap();
        let mut t = Transcript::open(dir.path(), at(9, 0, 0));
        t.line(Who::User, "oi", at(9, 0, 1));
        assert!(!t.path.exists() || t.path.is_file());
    }

    #[test]
    fn multi_line_speech_stays_one_entry() {
        let dir = tempfile::tempdir().unwrap();
        let mut t = Transcript::open(dir.path(), at(9, 0, 0));
        t.line(Who::Organizer, "Opção A: refazer.\nOpção B: manter.", at(9, 0, 1));
        let text = std::fs::read_to_string(&t.path).unwrap();
        assert!(text.contains("**Organizador:** Opção A: refazer.\n  Opção B: manter."), "{text}");
    }
}
