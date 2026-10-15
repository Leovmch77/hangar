//! Variáveis de tela para o que o servidor lança. O serviço do usuário pode subir antes de o compositor exportá-las, e aí o
//! processo filho nasce sem tela: o controle de tela recusa, programa gráfico não abre janela.
use std::path::{Path, PathBuf};

pub const KEYS: [&str; 4] = ["WAYLAND_DISPLAY", "DISPLAY", "HYPRLAND_INSTANCE_SIGNATURE", "XDG_RUNTIME_DIR"];

/// As variáveis de `KEYS` que faltam em `current`, vindas do ambiente do gerenciador systemd do usuário (`systemd`, a saída
/// de `systemctl --user show-environment`) e, sem ele, da pasta de runtime: o primeiro socket `wayland-*` e a instância do
/// Hyprland mais recente em `hypr/`. O que o processo já tem nunca é trocado.
pub fn missing(current: impl Fn(&str) -> Option<String>, systemd: &str, runtime: Option<&Path>) -> Vec<(String, String)> {
    let from_systemd = |key: &str| systemd.lines().find_map(|l| l.strip_prefix(key)?.strip_prefix('=')).filter(|v| !v.is_empty())
        .map(str::to_owned);
    let from_runtime = |key: &str| match key {
        "WAYLAND_DISPLAY" => names(runtime?).into_iter().filter(|(n, _)| n.starts_with("wayland-") && !n.ends_with(".lock"))
            .map(|(n, _)| n).min(),
        "HYPRLAND_INSTANCE_SIGNATURE" => names(&runtime?.join("hypr")).into_iter().max_by_key(|(_, at)| *at).map(|(n, _)| n),
        _ => None,
    };
    KEYS.iter().filter(|key| current(key).is_none())
        .filter_map(|key| from_systemd(key).or_else(|| from_runtime(key)).map(|v| ((*key).to_owned(), v))).collect()
}

/// Nome e data de modificação de cada entrada de `dir`; pasta ilegível = nenhuma.
fn names(dir: &Path) -> Vec<(String, std::time::SystemTime)> {
    std::fs::read_dir(dir).into_iter().flatten().flatten()
        .filter_map(|e| Some((e.file_name().into_string().ok()?, e.metadata().ok()?.modified().ok()?))).collect()
}

/// `missing` com o ambiente deste processo; fora do Linux, nada.
pub fn fill() -> Vec<(String, String)> {
    if !cfg!(target_os = "linux") { return Vec::new(); }
    let current = |key: &str| std::env::var(key).ok().filter(|v| !v.is_empty());
    let systemd = systemd_environment().unwrap_or_default();
    let runtime = current("XDG_RUNTIME_DIR").map(PathBuf::from)
        .or_else(|| systemd.lines().find_map(|l| l.strip_prefix("XDG_RUNTIME_DIR=")).map(PathBuf::from));
    missing(current, &systemd, runtime.as_deref())
}

/// Com prazo: barramento do usuário quebrado não pode prender quem lança.
fn systemd_environment() -> Option<String> {
    let mut child = std::process::Command::new("systemctl").args(["--user", "show-environment"])
        .stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::null()).spawn().ok()?;
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
    loop {
        if child.try_wait().ok()?.is_some() { break; }
        if std::time::Instant::now() >= deadline { let _ = child.kill(); let _ = child.wait(); return None; }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    let mut out = String::new();
    std::io::Read::read_to_string(&mut child.stdout.take()?, &mut out).ok()?;
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env<'a>(vars: &'a [(&'a str, &'a str)]) -> impl Fn(&str) -> Option<String> + 'a {
        move |key| vars.iter().find(|(k, _)| *k == key).map(|(_, v)| (*v).to_owned())
    }

    #[test]
    fn takes_what_is_missing_from_the_user_manager_and_keeps_what_the_process_has() {
        let systemd = "PATH=/usr/bin\nWAYLAND_DISPLAY=wayland-1\nDISPLAY=:1\nHYPRLAND_INSTANCE_SIGNATURE=abc_1\nXDG_RUNTIME_DIR=/run/user/1000\n";
        let got = missing(env(&[("DISPLAY", ":0")]), systemd, None);
        assert_eq!(got, [("WAYLAND_DISPLAY".into(), "wayland-1".into()), ("HYPRLAND_INSTANCE_SIGNATURE".into(), "abc_1".into()),
            ("XDG_RUNTIME_DIR".into(), "/run/user/1000".into())], "DISPLAY do processo fica; PATH não é de tela");
        assert!(missing(env(&[("WAYLAND_DISPLAY", "w"), ("DISPLAY", ":0"), ("HYPRLAND_INSTANCE_SIGNATURE", "s"), ("XDG_RUNTIME_DIR", "/r")]),
            systemd, None).is_empty());
    }

    #[test]
    fn without_the_user_manager_the_runtime_dir_still_tells_the_wayland_socket_and_the_newest_hyprland() {
        let run = tempfile::tempdir().unwrap();
        std::fs::write(run.path().join("wayland-1.lock"), "").unwrap();
        std::fs::write(run.path().join("wayland-1"), "").unwrap();
        let hypr = run.path().join("hypr");
        std::fs::create_dir_all(hypr.join("old_1")).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(20));
        std::fs::create_dir_all(hypr.join("new_2")).unwrap();
        let got = missing(env(&[("XDG_RUNTIME_DIR", "x")]), "", Some(run.path()));
        assert_eq!(got, [("WAYLAND_DISPLAY".into(), "wayland-1".into()), ("HYPRLAND_INSTANCE_SIGNATURE".into(), "new_2".into())]);
    }

    #[test]
    fn nothing_found_is_nothing_filled() {
        let run = tempfile::tempdir().unwrap();
        assert!(missing(env(&[]), "garbage without equals\n", Some(run.path())).is_empty());
    }
}
