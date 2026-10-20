//! A conversa da chamada em disco, um arquivo por chamada: a fala dele, a da voz e as respostas do organizador. Fica só na
//! máquina, legível só pelo dono; o diário da voz continua sem texto.
use chrono::{DateTime, Local};
use std::{collections::VecDeque, fs::File, io::Write, path::{Path, PathBuf}};

#[derive(Clone, Copy, PartialEq)]
pub enum Who { User, Voice, Organizer }

/// `recent`: as últimas falas dele e da voz, em memória, para a voz nova continuar depois de uma queda; `forwarded`: a fala
/// dele já chegou ao organizador.
pub struct Transcript { file: Option<File>, pub path: PathBuf, recent: VecDeque<Said> }

struct Said { who: Who, text: String, forwarded: bool }

const RECENT_LINES: usize = 16;
const RECENT_LINE_CHARS: usize = 600;

/// O que vai na volta de uma queda: `voice`, a conversa recente para a voz nova; `organizer`, a fala dele que não chegou
/// ao organizador antes da queda.
pub struct Recap { pub voice: Option<String>, pub organizer: Option<String>, pub lines: usize }

impl Transcript {
    /// Falhar ao abrir não derruba a chamada: o diário registra o código e a conversa segue sem arquivo.
    pub fn open(voice_dir: &Path, started: DateTime<Local>) -> Transcript {
        let dir = voice_dir.join("conversas");
        let stamp = started.format("%Y-%m-%d_%H-%M-%S").to_string();
        let mut path = dir.join(format!("{stamp}.md"));
        let opened = std::fs::create_dir_all(&dir).and_then(|()| {
            #[cfg(unix)]
            std::fs::set_permissions(&dir, std::os::unix::fs::PermissionsExt::from_mode(0o700))?;
            // Duas chamadas no mesmo segundo: a segunda ganha sufixo, nunca escreve no arquivo da outra.
            let mut file = (1..100).find_map(|n| {
                let candidate = if n == 1 { dir.join(format!("{stamp}.md")) } else { dir.join(format!("{stamp}-{n}.md")) };
                let mut options = std::fs::OpenOptions::new();
                options.write(true).create_new(true);
                #[cfg(unix)]
                std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
                match options.open(&candidate) {
                    Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => None,
                    other => { path = candidate; Some(other) }
                }
            }).unwrap_or_else(|| Err(std::io::ErrorKind::AlreadyExists.into()))?;
            writeln!(file, "# Conversa por voz — {}\n", started.format("%d/%m/%Y %H:%M"))?;
            Ok(file)
        });
        let file = opened.map_err(|e| super::log(format!("transcript open failed kind={:?}", e.kind()))).ok();
        Transcript { file, path, recent: VecDeque::new() }
    }

    /// A voz repassou fala nova ao organizador: o que ele disse até aqui chegou lá.
    pub fn forwarded(&mut self) { for said in &mut self.recent { said.forwarded = true; } }

    pub fn recap(&self) -> Recap {
        let quote = |s: &Said| match s.who { Who::User => format!("- Usuário: {}", s.text), _ => format!("- Você (voz): {}", s.text) };
        let lines: Vec<String> = self.recent.iter().map(quote).collect();
        let voice = (!lines.is_empty()).then(|| format!("A conversa falada caiu e voltou agora. O que foi dito antes da queda, do \
            mais antigo ao mais recente; é contexto para continuar a conversa, não leia em voz alta:\n{}", lines.join("\n")));
        let first = self.recent.iter().position(|s| s.who == Who::User && !s.forwarded);
        let organizer = first.map(|at| {
            let lost: Vec<String> = self.recent.iter().skip(at).filter(|s| s.who == Who::User).map(|s| format!("«{}»", s.text)).collect();
            let before = self.recent.iter().take(at).rev().find(|s| s.who == Who::Voice)
                .map(|s| format!(" logo depois de a voz dizer «{}»", s.text)).unwrap_or_default();
            format!("A conversa falada caiu antes de esta fala dele chegar a você; ele disse{before}: {}. Considere dito: se ela \
                responde uma pergunta ou escolhe uma opção, a escolha está feita.", lost.join(" "))
        });
        Recap { voice, organizer, lines: lines.len() }
    }

    pub fn line(&mut self, who: Who, text: &str, at: DateTime<Local>) {
        let text = text.trim();
        if text.is_empty() { return; }
        if who != Who::Organizer {
            if self.recent.len() >= RECENT_LINES { self.recent.pop_front(); }
            let mut short: String = text.chars().take(RECENT_LINE_CHARS).collect();
            if short.len() < text.len() { short.push('…'); }
            self.recent.push_back(Said { who, text: short, forwarded: who != Who::User });
        }
        let Some(file) = self.file.as_mut() else { return };
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

    #[cfg(unix)]
    #[test]
    fn the_folder_is_private_too() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        Transcript::open(dir.path(), at(9, 0, 0));
        assert_eq!(std::fs::metadata(dir.path().join("conversas")).unwrap().permissions().mode() & 0o777, 0o700);
    }

    #[test]
    fn two_calls_in_the_same_second_never_share_a_file() {
        let dir = tempfile::tempdir().unwrap();
        let (a, b) = (Transcript::open(dir.path(), at(9, 0, 0)), Transcript::open(dir.path(), at(9, 0, 0)));
        assert_ne!(a.path, b.path);
        assert!(a.path.is_file() && b.path.is_file());
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
    fn recap_carries_the_talk_and_the_answer_that_never_reached_the_organizer() {
        let dir = tempfile::tempdir().unwrap();
        let mut t = Transcript::open(dir.path(), at(17, 0, 0));
        assert!(t.recap().voice.is_none(), "nada dito, nada a levar");
        t.line(Who::User, "vai pra sessão do mobile", at(17, 1, 25));
        t.forwarded();
        t.line(Who::Organizer, "Ela deixou A e B.", at(17, 1, 31));
        t.line(Who::Voice, "A, conferir no emulador; B, publicar direto. Qual você prefere?", at(17, 2, 3));
        assert!(t.recap().organizer.is_none(), "tudo o que ele disse chegou");
        t.line(Who::User, "confere no Android", at(17, 2, 5));
        let recap = t.recap();
        let voice = recap.voice.unwrap();
        assert!(voice.contains("- Usuário: vai pra sessão do mobile") && voice.contains("- Você (voz): A, conferir"), "{voice}");
        assert!(!voice.contains("Ela deixou A e B."), "a voz já falou o que o organizador escreveu");
        let note = recap.organizer.unwrap();
        assert!(note.contains("«confere no Android»") && note.contains("Qual você prefere?"), "{note}");
        t.forwarded();
        assert!(t.recap().organizer.is_none());
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
