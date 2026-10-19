//! `~/.hangar/link-returns.json`: quando cada filha foi ligada ao criador e quando a resposta dela
//! voltou a ele (`{"<filha>": {"linked_at": f64, "returned_at": f64|null, "returned_key": str|null}}`).
use std::collections::BTreeMap;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct LinkReturn {
    pub linked_at: f64,
    #[serde(default)]
    pub returned_at: Option<f64>,
    /// Qual resposta voltou: `last_reply_at` muda com qualquer escrita no transcript, a resposta não.
    #[serde(default)]
    pub returned_key: Option<String>,
}

pub type LinkReturns = BTreeMap<String, LinkReturn>;

/// Ler e regravar sem perder a escrita de outra tarefa do processo (a ligação e o retorno).
static LOCK: Mutex<()> = Mutex::new(());

pub fn path(hangar_dir: &Path) -> PathBuf { hangar_dir.join("link-returns.json") }

/// Roda E/S de disco fora do executor; pânico da tarefa vira erro de E/S.
pub async fn blocking<T: Send + 'static>(f: impl FnOnce() -> io::Result<T> + Send + 'static) -> io::Result<T> {
    tokio::task::spawn_blocking(f).await.map_err(io::Error::other).and_then(|r| r)
}

/// Arquivo ausente é vazio; ilegível é erro: regravar por cima apagaria os `returned_at` dos outros.
pub fn read(hangar_dir: &Path) -> io::Result<LinkReturns> {
    match std::fs::read(path(hangar_dir)) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(io::Error::other),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(LinkReturns::new()),
        Err(error) => Err(error),
    }
}

/// Lê, muda e grava (tmp+rename) sob a trava do processo.
pub fn update(hangar_dir: &Path, change: impl FnOnce(&mut LinkReturns)) -> io::Result<()> {
    modify(hangar_dir, |all| { change(all); true })
}

/// Como `update`, mas só grava quando `change` diz que mudou.
fn modify(hangar_dir: &Path, change: impl FnOnce(&mut LinkReturns) -> bool) -> io::Result<()> {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut all = read(hangar_dir)?;
    if !change(&mut all) { return Ok(()); }
    std::fs::create_dir_all(hangar_dir)?;
    crate::runtime::queue::atomic_write(&path(hangar_dir), &serde_json::to_vec_pretty(&all)?)
}

/// Ligação nova: `linked_at` agora e nenhum retorno ainda (o de uma vida antiga com o mesmo nome não vale).
pub fn record_linked(hangar_dir: &Path, children: &[String], now: f64) -> io::Result<()> {
    update(hangar_dir, |all| {
        for child in children { all.insert(child.clone(), LinkReturn { linked_at: now, ..LinkReturn::default() }); }
    })
}

/// Filha renomeada leva o registro junto: sem ele, nunca mais volta resposta dela.
pub fn rename(hangar_dir: &Path, old: &str, new: &str) -> io::Result<()> {
    modify(hangar_dir, |all| match all.remove(old) {
        Some(entry) => { all.insert(new.to_owned(), entry); true }
        None => false,
    })
}

/// Tira as filhas que `keep` não reconhece mais (vínculo desfeito, sessão fechada).
pub fn retain(hangar_dir: &Path, keep: impl Fn(&str) -> bool) -> io::Result<()> {
    modify(hangar_dir, |all| { let before = all.len(); all.retain(|name, _| keep(name)); all.len() != before })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn linking_writes_linked_at_and_keeps_the_other_children() {
        let dir = tempfile::tempdir().unwrap();
        assert!(read(dir.path()).unwrap().is_empty());
        update(dir.path(), |all| { all.insert("b".into(), LinkReturn { linked_at: 1.0, returned_at: Some(2.0), returned_key: None }); }).unwrap();
        record_linked(dir.path(), &["a".to_owned()], 10.5).unwrap();
        let raw: serde_json::Value = serde_json::from_slice(&std::fs::read(path(dir.path())).unwrap()).unwrap();
        assert_eq!(raw, serde_json::json!({"a": {"linked_at": 10.5, "returned_at": null, "returned_key": null},
            "b": {"linked_at": 1.0, "returned_at": 2.0, "returned_key": null}}));
        // Religar a mesma filha zera o retorno da vida anterior.
        record_linked(dir.path(), &["b".to_owned()], 20.0).unwrap();
        assert_eq!(read(dir.path()).unwrap()["b"], LinkReturn { linked_at: 20.0, ..LinkReturn::default() });
    }

    #[test]
    fn an_unreadable_file_is_not_overwritten() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(path(dir.path()), "{torto").unwrap();
        assert!(record_linked(dir.path(), &["a".to_owned()], 1.0).is_err());
        assert_eq!(std::fs::read_to_string(path(dir.path())).unwrap(), "{torto");
    }

    #[test]
    fn old_files_load_rename_moves_the_entry_and_retain_prunes() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(path(dir.path()), r#"{"a": {"linked_at": 1.0, "returned_at": 2.0}, "b": {"linked_at": 3.0}}"#).unwrap();
        assert_eq!(read(dir.path()).unwrap()["a"], LinkReturn { linked_at: 1.0, returned_at: Some(2.0), returned_key: None });
        rename(dir.path(), "a", "a2").unwrap();
        rename(dir.path(), "sumiu", "x").unwrap();
        let all = read(dir.path()).unwrap();
        assert_eq!(all.keys().collect::<Vec<_>>(), ["a2", "b"]);
        assert_eq!(all["a2"].returned_at, Some(2.0));
        retain(dir.path(), |name| name == "b").unwrap();
        assert_eq!(read(dir.path()).unwrap().keys().collect::<Vec<_>>(), ["b"]);
    }
}
