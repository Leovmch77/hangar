//! Preferências de worktrees do servidor, compartilhadas com as criações por sessão.
use crate::{Result, error};
use serde::{Deserialize, Serialize};
use std::{
    fs::OpenOptions,
    io::Write,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum KeepWhen {
    UncommittedChanges,
    TrackedChanges,
    AnyLocalFiles,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WorktreeSettings {
    pub location: String,
    #[serde(deserialize_with = "required_days")]
    pub inactive_days: Option<u16>,
    pub delete_merged: bool,
    pub delete_unchanged: bool,
    pub keep_when: KeepWhen,
}
fn required_days<'de, D: serde::Deserializer<'de>>(
    d: D,
) -> std::result::Result<Option<u16>, D::Error> {
    let days = Option::<u16>::deserialize(d)?;
    if days.is_some_and(|n| !(1..=3650).contains(&n)) {
        return Err(serde::de::Error::custom("prazo deve ser de 1 a 3650 dias"));
    }
    Ok(days)
}
impl Default for WorktreeSettings {
    fn default() -> Self {
        Self {
            location: String::new(),
            inactive_days: None,
            delete_merged: false,
            delete_unchanged: false,
            keep_when: KeepWhen::UncommittedChanges,
        }
    }
}
impl WorktreeSettings {
    pub fn location_path(&self, home: &Path) -> Result<PathBuf> {
        if self.inactive_days.is_some_and(|n| !(1..=3650).contains(&n)) {
            return Err(error(422, "prazo deve ser de 1 a 3650 dias"));
        }
        let location = self.location.as_str();
        if location.contains('\0') || location.trim() != location {
            return Err(error(422, "pasta de worktrees inválida"));
        }
        let path = if location.is_empty() {
            home.join(".hangar/worktrees")
        } else if location == "~" {
            home.to_path_buf()
        } else if let Some(rel) = location
            .strip_prefix("~/")
            .or_else(|| location.strip_prefix("~\\"))
        {
            home.join(rel)
        } else {
            PathBuf::from(location)
        };
        let path = crate::worktrees::normpath(&path);
        if !path.is_absolute() || path.parent().is_none() || crate::real(&path).parent().is_none() {
            return Err(error(
                422,
                "use uma pasta absoluta que não seja a raiz do disco",
            ));
        }
        Ok(path)
    }
    pub fn load_at(file: &Path) -> Result<Self> {
        match std::fs::read(file) {
            Ok(bytes) => serde_json::from_slice(&bytes)
                .map_err(|_| error(503, "configuração de worktrees ilegível")),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Self::default()),
            Err(_) => Err(error(503, "configuração de worktrees ilegível")),
        }
    }
    pub fn save_at(&self, file: &Path, home: &Path) -> Result<()> {
        self.location_path(home)?;
        locked(file, || write_json(file, self))
    }
    pub fn enabled(&self) -> bool {
        self.inactive_days.is_some() || self.delete_merged || self.delete_unchanged
    }
}
pub fn load_default() -> Result<WorktreeSettings> {
    let home = crate::home().ok_or_else(|| error(503, "pasta pessoal indisponível"))?;
    WorktreeSettings::load_at(&home.join(".hangar/worktree-settings.json"))
}
pub fn locked<T>(file: &Path, f: impl FnOnce() -> Result<T>) -> Result<T> {
    let parent = file
        .parent()
        .ok_or_else(|| error(500, "caminho sem pasta"))?;
    std::fs::create_dir_all(parent)
        .map_err(|_| error(500, "não consegui criar a pasta de configuração"))?;
    let lock = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(file.with_extension("lock"))
        .map_err(|_| error(503, "não consegui abrir a trava de worktrees"))?;
    let start = Instant::now();
    loop {
        match lock.try_lock() {
            Ok(()) => break,
            Err(std::fs::TryLockError::WouldBlock) if start.elapsed() < Duration::from_secs(3) => {
                std::thread::sleep(Duration::from_millis(10))
            }
            Err(_) => return Err(error(503, "configuração de worktrees ocupada")),
        }
    }
    f()
}
pub fn write_json(file: &Path, value: &impl Serialize) -> Result<()> {
    let parent = file
        .parent()
        .ok_or_else(|| error(500, "caminho sem pasta"))?;
    std::fs::create_dir_all(parent)
        .map_err(|_| error(500, "não consegui criar a pasta de configuração"))?;
    let mut tmp = tempfile::NamedTempFile::new_in(parent)
        .map_err(|_| error(500, "não consegui criar o arquivo temporário"))?;
    let bytes =
        serde_json::to_vec_pretty(value).map_err(|_| error(500, "configuração inválida"))?;
    tmp.write_all(&bytes)
        .and_then(|_| tmp.as_file().sync_all())
        .map_err(|_| error(500, "não consegui gravar a configuração"))?;
    tmp.persist(file)
        .map_err(|_| error(500, "não consegui publicar a configuração"))?;
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn settings_validate_location_and_full_payload() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path();
        let mut s = WorktreeSettings::default();
        assert_eq!(
            s.location_path(home).unwrap(),
            home.join(".hangar/worktrees")
        );
        s.location = "~/projects/worktrees".into();
        assert_eq!(
            s.location_path(home).unwrap(),
            home.join("projects/worktrees")
        );
        for invalid in [
            "relative",
            "/",
            "~/../../../../../../..",
            "~someone/work",
            " /absolute",
        ] {
            s.location = invalid.into();
            assert!(s.location_path(home).is_err(), "{invalid}");
        }
        assert!(serde_json::from_str::<WorktreeSettings>(r#"{"location":""}"#).is_err());
        let file = home.join("settings.json");
        let mut s = WorktreeSettings {
            inactive_days: Some(0),
            ..WorktreeSettings::default()
        };
        assert!(s.save_at(&file, home).is_err());
        s.inactive_days = Some(3651);
        assert!(s.save_at(&file, home).is_err());
        s.inactive_days = Some(8);
        s.save_at(&file, home).unwrap();
        assert_eq!(WorktreeSettings::load_at(&file).unwrap(), s);
    }
}
