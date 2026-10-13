//! Escrita nos planos do usuário: pin, marcar step e arquivar. O arquivo é do usuário e está
//! versionado: marcar troca um byte, arquivar move sem sobrescrever, e toda falha volta com texto.
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

use crate::list::plan::{blank_fences, pin_path, read_pin, safe_stem, STEP_RE};

/// Para onde vai o plano encerrado: subpasta da própria pasta de planos, que a descoberta não lê.
pub const DONE_DIR: &str = "feitos";

/// Falha de escrita; o texto vai ao parâmetro `erro` do envelope.
#[derive(Debug, PartialEq)]
pub struct WriteError(pub String);

impl From<std::io::Error> for WriteError {
    fn from(e: std::io::Error) -> Self { WriteError(e.to_string()) }
}

/// Serializa o ler-alterar-gravar: celular e desktop marcando na mesma sessão liam o mesmo texto
/// e o segundo regravava por cima do primeiro. A seção crítica é ler um `.md` e trocar um byte.
static WRITE: Mutex<()> = Mutex::new(());
static TEMP: AtomicU64 = AtomicU64::new(0);

/// Fixa o plano da pasta, ou solta com `None`.
pub fn write_pin(root: &Path, stem: Option<&str>) -> Result<(), WriteError> {
    let path = pin_path(root);
    match stem {
        None => match fs::remove_file(&path) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.into()),
            _ => Ok(()),
        },
        Some(stem) => Ok(fs::write(&path, format!("{stem}\n"))?),
    }
}

/// O `.md` de `stem` dentro da pasta; stem com separador nunca vira caminho.
pub fn plan_path(root: &Path, stem: &str) -> Result<PathBuf, WriteError> {
    if !safe_stem(stem) {
        return Err(WriteError(format!("nome de plano inválido: {stem}")));
    }
    Ok(root.join(format!("{stem}.md")))
}

/// Marca ou desmarca o step `idx` (ordem do documento). Grava um byte: o resto do arquivo sai
/// igual, sem reformatar o markdown versionado do usuário.
pub fn mark_step(path: &Path, idx: i64, done: bool) -> Result<(), WriteError> {
    let _guard = WRITE.lock().unwrap_or_else(|e| e.into_inner());
    let raw = fs::read(path)?;
    // A leitura volta ao disco: gravar U+FFFD apagaria o byte original.
    if std::str::from_utf8(&raw).is_err() {
        return Err(WriteError("o plano não está em UTF-8".into()));
    }
    // Mesma neutralização de bloco cercado da leitura, preservando offsets: um step de exemplo
    // dentro de ``` não entra no índice.
    let mut clean = raw.clone();
    blank_fences(&mut clean);
    let marks: Vec<usize> = STEP_RE.captures_iter(&clean).filter_map(|c| c.get(1).map(|m| m.start())).collect();
    let Some(&pos) = usize::try_from(idx).ok().and_then(|i| marks.get(i)) else {
        return Err(WriteError(format!("step {idx} não existe (o plano tem {})", marks.len())));
    };
    if !matches!(raw[pos], b' ' | b'x' | b'X') {
        return Err(WriteError("o plano mudou no disco — recarregue antes de marcar".into()));
    }
    let mut updated = raw;
    updated[pos] = if done { b'x' } else { b' ' };
    let temp = PathBuf::from(format!("{}.{}.{}.tmp", path.display(), std::process::id(), TEMP.fetch_add(1, Ordering::Relaxed)));
    let written = fs::write(&temp, &updated).and_then(|()| crate::runtime::queue::replace(&temp, path));
    if written.is_err() {
        let _ = fs::remove_file(&temp);
    }
    Ok(written?)
}

/// Move `<stem>.md` e o `.html` irmão para `feitos/`; devolve o que moveu. Mover, não apagar: o
/// plano é o registro do que foi feito. Tudo ou nada: as colisões dos dois são conferidas antes.
pub fn archive(root: &Path, stem: &str) -> Result<Vec<String>, WriteError> {
    let md = plan_path(root, stem)?;
    if !md.is_file() {
        return Err(WriteError(format!("plano não encontrado: {stem}")));
    }
    // Antes de mover: depois, o pin já não reconhece o stem e ficaria morto no disco.
    let was_pinned = read_pin(root).as_deref() == Some(stem);
    let target = root.join(DONE_DIR);
    fs::create_dir_all(&target)?;
    let names: Vec<String> = [".md", ".html"].iter().map(|ext| format!("{stem}{ext}")).filter(|n| root.join(n).is_file()).collect();
    if let Some(taken) = names.iter().find(|n| target.join(n).exists()) {
        return Err(WriteError(format!("já existe {taken} em {DONE_DIR}/")));
    }
    let mut moved = Vec::new();
    for name in names {
        if let Err(e) = crate::runtime::queue::replace(&root.join(&name), &target.join(&name)) {
            // Diz o que já saiu: sem isso a pessoa tenta de novo e lê "plano não encontrado".
            return Err(WriteError(if moved.is_empty() { e.to_string() } else { format!("moveu {} e falhou em {name}: {e}", moved.join(", ")) }));
        }
        moved.push(name);
    }
    if was_pinned && let Err(e) = write_pin(root, None) {
        // O pin morto é inofensivo (a leitura o descarta); não desfaz o arquivamento feito.
        tracing::warn!(code = "plan_pin_release_failed", error = %e.0, "plano arquivado, pin não solto");
    }
    Ok(moved)
}

#[cfg(test)]
mod tests {
    use super::*;

    const PLAN: &str = "### Task 1: X\n\n```md\n- [x] **Step 9: exemplo**\n```\n- [ ] **Step 1: a**\n- [ ] **Step 2: b**\n";

    fn repo() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let plans = dir.path().join("docs/superpowers/plans");
        fs::create_dir_all(&plans).unwrap();
        fs::create_dir_all(dir.path().join(".git")).unwrap();
        (dir, plans)
    }

    fn plan(plans: &Path, stem: &str, body: &str) -> PathBuf {
        let p = plans.join(format!("{stem}.md"));
        fs::write(&p, body).unwrap();
        p
    }

    #[test]
    fn marking_changes_only_the_checkbox_and_fences_do_not_count() {
        let (_d, plans) = repo();
        let p = plan(&plans, "2026-07-01-p", PLAN);
        mark_step(&p, 0, true).unwrap();
        mark_step(&p, 1, true).unwrap();
        assert_eq!(fs::read_to_string(&p).unwrap(), PLAN.replace("- [ ] **Step 1", "- [x] **Step 1").replace("- [ ] **Step 2", "- [x] **Step 2"));
        mark_step(&p, 0, false).unwrap();
        assert!(fs::read_to_string(&p).unwrap().contains("- [ ] **Step 1: a**"));
        assert!(fs::read_dir(&plans).unwrap().all(|e| !e.unwrap().file_name().to_string_lossy().ends_with(".tmp")), "sem temporário largado");
    }

    #[test]
    fn marking_out_of_range_or_a_non_utf8_plan_refuses_without_writing() {
        let (_d, plans) = repo();
        let p = plan(&plans, "2026-07-01-p", PLAN);
        assert_eq!(mark_step(&p, 99, true), Err(WriteError("step 99 não existe (o plano tem 2)".into())));
        assert_eq!(mark_step(&p, -1, true), Err(WriteError("step -1 não existe (o plano tem 2)".into())));
        let mut bytes = PLAN.as_bytes().to_vec();
        bytes.extend_from_slice(b"\xff\n");
        fs::write(&p, &bytes).unwrap();
        assert_eq!(mark_step(&p, 0, true), Err(WriteError("o plano não está em UTF-8".into())));
        assert_eq!(fs::read(&p).unwrap(), bytes);
        assert!(mark_step(&plans.join("sumiu.md"), 0, true).is_err());
    }

    #[test]
    fn concurrent_marks_never_undo_each_other() {
        let (_d, plans) = repo();
        let body: String = (0..8).map(|i| format!("- [ ] **Step {i}: s**\n")).collect();
        let p = plan(&plans, "2026-07-01-p", &body);
        let threads: Vec<_> = (0..8).map(|i| { let p = p.clone(); std::thread::spawn(move || mark_step(&p, i, true).unwrap()) }).collect();
        threads.into_iter().for_each(|t| t.join().unwrap());
        assert_eq!(fs::read_to_string(&p).unwrap().matches("- [x]").count(), 8);
    }

    #[test]
    fn pin_lives_in_git_or_beside_the_plans_and_none_removes_it() {
        let (d, plans) = repo();
        plan(&plans, "2026-07-01-p", PLAN);
        write_pin(&plans, Some("2026-07-01-p")).unwrap();
        assert_eq!(fs::read_to_string(d.path().join(".git/cp-plan-pin")).unwrap(), "2026-07-01-p\n");
        assert_eq!(read_pin(&plans).as_deref(), Some("2026-07-01-p"));
        write_pin(&plans, None).unwrap();
        assert!(!d.path().join(".git/cp-plan-pin").exists());
        write_pin(&plans, None).unwrap();
        let wt = tempfile::tempdir().unwrap();
        let wt_plans = wt.path().join("docs/superpowers/plans");
        fs::create_dir_all(&wt_plans).unwrap();
        fs::write(wt.path().join(".git"), "gitdir: x").unwrap();
        write_pin(&wt_plans, Some("!none")).unwrap();
        assert_eq!(fs::read_to_string(wt_plans.join(".cp-plan-pin")).unwrap(), "!none\n");
        assert_eq!(pin_path(&wt_plans), wt_plans.join(".cp-plan-pin"));
    }

    #[test]
    fn stems_with_separators_never_become_paths() {
        let (_d, plans) = repo();
        for bad in ["../../../fora", "a/b", "a\\b", "..", ".", ""] {
            assert_eq!(plan_path(&plans, bad), Err(WriteError(format!("nome de plano inválido: {bad}"))));
            assert!(archive(&plans, bad).is_err());
        }
    }

    #[test]
    fn archiving_moves_md_and_html_and_releases_its_pin() {
        let (d, plans) = repo();
        plan(&plans, "2026-07-01-p", PLAN);
        fs::write(plans.join("2026-07-01-p.html"), "<p>").unwrap();
        write_pin(&plans, Some("2026-07-01-p")).unwrap();
        assert_eq!(archive(&plans, "2026-07-01-p").unwrap(), ["2026-07-01-p.md", "2026-07-01-p.html"]);
        assert!(plans.join("feitos/2026-07-01-p.md").is_file() && plans.join("feitos/2026-07-01-p.html").is_file());
        assert!(!plans.join("2026-07-01-p.md").exists());
        assert!(!d.path().join(".git/cp-plan-pin").exists(), "pin do plano arquivado solto");
        assert_eq!(archive(&plans, "nada"), Err(WriteError("plano não encontrado: nada".into())));
    }

    #[test]
    fn archiving_is_all_or_nothing_and_never_overwrites_done_plans() {
        let (_d, plans) = repo();
        plan(&plans, "2026-07-01-p", PLAN);
        fs::write(plans.join("2026-07-01-p.html"), "<p>").unwrap();
        fs::create_dir_all(plans.join("feitos")).unwrap();
        fs::write(plans.join("feitos/2026-07-01-p.html"), "antigo").unwrap();
        assert_eq!(archive(&plans, "2026-07-01-p"), Err(WriteError("já existe 2026-07-01-p.html em feitos/".into())));
        assert!(plans.join("2026-07-01-p.md").is_file() && plans.join("2026-07-01-p.html").is_file());
        assert_eq!(fs::read_to_string(plans.join("feitos/2026-07-01-p.html")).unwrap(), "antigo");
    }
}
