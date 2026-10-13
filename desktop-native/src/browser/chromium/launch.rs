//! Acha o Chromium da máquina e o sobe sem janela, falando CDP por pipe (fd 3 e 4), sem porta de depuração.
use std::{
    env,
    fs::File,
    io::{self, PipeReader, PipeWriter},
    os::{fd::AsRawFd, unix::process::CommandExt},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::OnceLock,
};

/// Ordem de busca: o pedido explícito, o baixado pelo instalador (`chrome-headless-shell`) e o do sistema. O Chrome
/// completo vem antes só quando a pessoa pede nas configurações: o gerenciador de senhas dele prende a entrada do site
/// depois do primeiro login enviado, e o shell não tem essa parte.
const SYSTEM: [&str; 4] = ["google-chrome-stable", "google-chrome", "chromium", "chromium-browser"];

/// Achado uma vez por processo e por escolha: roda a cada desenho do menu do painel. A troca vale para o próximo
/// Chromium que subir.
pub fn find() -> Result<&'static Path, String> {
    static FOUND: [OnceLock<Result<PathBuf, String>>; 2] = [OnceLock::new(), OnceLock::new()];
    let full = crate::appearance::get().full_chrome;
    FOUND[full as usize].get_or_init(|| {
        let found = search(env::var_os("HANGAR_CHROMIUM").map(PathBuf::from), downloaded(), env::var_os("PATH"), full);
        // Sem o shell baixado o Chrome completo entra no lugar, com o gerenciador de senhas que prende o login: fica no
        // diário qual motor está em uso e por quê. Vale até o app reiniciar.
        match &found {
            Ok(bin) if !full && !is_shell(bin) => eprintln!("[nav] motor: {} (chrome-headless-shell ausente em {}; rode scripts/install-chromium.sh)",
                bin.display(), downloaded().map_or_else(|| "?".into(), |d| d.display().to_string())),
            Ok(bin) => eprintln!("[nav] motor: {}", bin.display()),
            Err(e) => eprintln!("[nav] motor: nenhum ({e})"),
        }
        found
    }).as_ref().map(PathBuf::as_path).map_err(Clone::clone)
}

fn downloaded() -> Option<PathBuf> {
    Some(PathBuf::from(env::var_os("HOME")?).join(".hangar/native/chromium/chrome-headless-shell"))
}

fn search(explicit: Option<PathBuf>, downloaded: Option<PathBuf>, path: Option<std::ffi::OsString>, full: bool) -> Result<PathBuf, String> {
    if let Some(bin) = explicit {
        return usable(&bin).then_some(bin.clone()).ok_or_else(|| format!("HANGAR_CHROMIUM aponta para {}, que nao e um executavel", bin.display()));
    }
    let downloaded = downloaded.filter(|b| usable(b));
    if !full && let Some(bin) = downloaded.clone() { return Ok(bin); }
    let dirs: Vec<PathBuf> = path.map(|p| env::split_paths(&p).collect()).unwrap_or_default();
    for name in SYSTEM {
        for dir in &dirs {
            let bin = dir.join(name);
            if usable(&bin) && !snap(&bin) { return Ok(bin); }
        }
    }
    if let Some(bin) = downloaded { return Ok(bin); }
    Err("nenhum Chrome ou Chromium encontrado (instale o google-chrome ou o chromium, ou rode scripts/install-native.sh)".into())
}

/// O Chromium do snap roda confinado e não lê o perfil em pasta oculta da home (`~/.config`): vale como ausente.
/// Ele aparece como link para `/snap/...` ou para o `snap`, ou como script em `/usr/bin` que chama o `/snap/bin`.
fn snap(bin: &Path) -> bool {
    let real = std::fs::canonicalize(bin).unwrap_or_else(|_| bin.to_path_buf());
    if real.starts_with("/snap/") || real.file_name().is_some_and(|n| n == "snap") { return true; }
    let mut head = Vec::new();
    let _ = std::io::Read::read_to_end(&mut std::io::Read::take(match File::open(&real) { Ok(f) => f, Err(_) => return false }, 4096), &mut head);
    head.starts_with(b"#!") && head.windows(6).any(|w| w == b"/snap/")
}

fn usable(bin: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(bin).is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
}

/// O `chrome-headless-shell` já é sem janela; o Chrome completo precisa pedir.
fn is_shell(bin: &Path) -> bool {
    bin.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.contains("headless-shell") || n.contains("headless_shell"))
}

pub fn args(bin: &Path, profile: &Path) -> Vec<String> {
    let mut args = vec![
        "--remote-debugging-pipe".into(),
        format!("--user-data-dir={}", profile.display()),
        "--no-first-run".into(),
        "--no-default-browser-check".into(),
        // Escala 1 no processo: a do painel vai por alvo (o controlador emula a da janela), porque o processo nasce
        // às vezes com a janela escondida, que ainda não sabe a escala do monitor, e escala fixa no processo deixava o
        // painel borrado ou desenhando o dobro do necessário em monitor de escala fracionária.
        "--force-device-scale-factor=1".into(),
        // Sem isto a página do agente, que ninguém está olhando, para de rodar timers e de pintar.
        "--disable-background-timer-throttling".into(),
        "--disable-renderer-backgrounding".into(),
        "--disable-backgrounding-occluded-windows".into(),
        // Cookies cifrados com a chave fixa nos dois motores: pelo chaveiro do sistema cada um usa uma chave, e trocar de
        // motor nas configurações deslogaria tudo.
        "--password-store=basic".into(),
        // `navigator.webdriver` ligado faz o Google recusar o login ("navegador pode não ser seguro").
        "--disable-blink-features=AutomationControlled".into(),
        // Ambiente de teste local (túnel da VM em https://localhost) usa certificado autoassinado. Só localhost:
        // site de fora continua exigindo certificado válido.
        "--allow-insecure-localhost".into(),
    ];
    if !is_shell(bin) { args.insert(0, "--headless".into()); }
    args
}

/// O Chromium lê de `writer` (fd 3 dele) e escreve em `reader` (fd 4 dele).
pub struct Launched {
    pub child: Child,
    pub reader: PipeReader,
    pub writer: PipeWriter,
}

pub fn spawn(bin: &Path, profile: &Path) -> io::Result<Launched> {
    // O perfil guarda cookies e sessões logadas: só o dono entra.
    {
        use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
        std::fs::DirBuilder::new().recursive(true).mode(0o700).create(profile)?;
        std::fs::set_permissions(profile, std::fs::Permissions::from_mode(0o700))?;
    }
    let (their_in, writer) = io::pipe()?;
    let (reader, their_out) = io::pipe()?;
    let (fd_in, fd_out) = (their_in.as_raw_fd(), their_out.as_raw_fd());
    let mut command = Command::new(bin);
    command.args(args(bin, profile)).stdin(Stdio::null()).stdout(Stdio::null()).stderr(log_file());
    // SAFETY: só chamadas async-signal-safe entre o fork e o exec.
    unsafe {
        command.pre_exec(move || {
            // Copia para longe antes: uma das pontas pode já ser o fd 3 ou 4.
            let a = libc::fcntl(fd_in, libc::F_DUPFD, 10);
            let b = libc::fcntl(fd_out, libc::F_DUPFD, 10);
            if a < 0 || b < 0 || libc::dup2(a, 3) < 0 || libc::dup2(b, 4) < 0 { return Err(io::Error::last_os_error()); }
            // App que morre sem fechar leva o Chromium junto.
            libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL);
            Ok(())
        });
    }
    let child = command.spawn()?;
    drop((their_in, their_out));
    Ok(Launched { child, reader, writer })
}

/// A saída do Chromium vai para o diário do app, não para o terminal de quem o abriu.
fn log_file() -> Stdio {
    log_path().and_then(|path| File::options().create(true).append(true).open(path).ok()).map_or_else(Stdio::null, Stdio::from)
}

pub fn log_path() -> Option<PathBuf> { crate::appearance::dir().map(|dir| dir.join("chromium.log")) }

#[cfg(test)]
mod tests {
    use super::*;

    fn exe(dir: &Path, name: &str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let bin = dir.join(name);
        std::fs::write(&bin, "#!/bin/sh\n").unwrap();
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        bin
    }

    #[test]
    fn search_prefers_explicit_then_downloaded_then_system_unless_full_chrome_is_asked() {
        let dir = std::env::temp_dir().join(format!("hangar-chromium-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let system = exe(&dir, "chromium");
        let shell = exe(&dir, "chrome-headless-shell");
        let path = Some(dir.clone().into_os_string());
        assert_eq!(search(None, None, path.clone(), false), Ok(system.clone()));
        assert_eq!(search(None, Some(shell.clone()), path.clone(), false), Ok(shell.clone()));
        assert_eq!(search(None, Some(shell.clone()), path.clone(), true), Ok(system.clone()));
        assert_eq!(search(None, Some(shell.clone()), None, true), Ok(shell.clone()));
        assert_eq!(search(None, Some(dir.join("nada")), path.clone(), false), Ok(system.clone()));
        assert_eq!(search(Some(shell.clone()), None, path.clone(), true), Ok(shell.clone()));
        assert!(search(Some(dir.join("nada")), None, path, false).is_err());
        assert!(search(None, Some(dir.join("nada")), None, false).is_err());
        // O wrapper do Ubuntu em /usr/bin, que só chama o snap, não conta: cai no baixado.
        std::fs::write(&system, "#!/bin/sh\nexec /snap/bin/chromium \"$@\"\n").unwrap();
        assert!(search(None, None, Some(dir.clone().into_os_string()), true).is_err());
        assert_eq!(search(None, Some(shell.clone()), Some(dir.clone().into_os_string()), true), Ok(shell.clone()));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn only_the_full_chrome_asks_for_headless() {
        let profile = Path::new("/p");
        assert_eq!(args(Path::new("/usr/bin/google-chrome-stable"), profile)[0], "--headless");
        let shell = args(Path::new("/x/chrome-headless-shell"), profile);
        assert!(!shell.contains(&"--headless".to_string()));
        assert!(shell.contains(&"--force-device-scale-factor=1".to_string()));
        assert!(shell.contains(&"--password-store=basic".to_string()));
        assert!(shell.contains(&"--allow-insecure-localhost".to_string()));
        assert!(!shell.iter().any(|a| a == "--ignore-certificate-errors"));
    }
}
