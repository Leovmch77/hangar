//! Espaço regenerável das provas, separado do registro durável da orquestração.

use serde::Serialize;
use serde_json::Value;
use std::{
    fs, io,
    path::{Path, PathBuf},
};

#[derive(Debug, Default, Serialize)]
pub struct PruneReport {
    pub paths: Vec<PathBuf>,
    pub bytes: u64,
}

fn invalid(message: &str) -> io::Error {
    io::Error::other(message)
}

fn linked(meta: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        meta.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    {
        meta.file_type().is_symlink()
    }
}

fn read_file(path: &Path) -> io::Result<String> {
    let meta = fs::symlink_metadata(path)?;
    if linked(&meta) || !meta.is_file() {
        return Err(invalid(
            "O registro da orquestração deve ser um arquivo regular, sem link.",
        ));
    }
    fs::read_to_string(path)
}

fn run_state(dir: &Path) -> io::Result<bool> {
    let config: Value = serde_json::from_str(&read_file(&dir.join("orq.json"))?)?;
    if !config.is_object() || config.get("arbiter").and_then(Value::as_str).is_none() {
        return Err(invalid("Configuração de orquestração inválida."));
    }
    if dir.join(".git").exists() {
        return Err(invalid(
            "A pasta durável não pode ser a raiz de um repositório.",
        ));
    }
    if let Some(repo) = config.get("repo").and_then(Value::as_str)
        && let Ok(repo) = fs::canonicalize(repo)
        && (repo.starts_with(dir) || dir.starts_with(repo))
    {
        return Err(invalid(
            "A pasta durável deve ficar fora do repositório de trabalho.",
        ));
    }
    let mut ended = false;
    for line in read_file(&dir.join("eventos.jsonl"))?
        .lines()
        .filter(|line| !line.trim().is_empty())
    {
        let event: Value = serde_json::from_str(line)?;
        let kind = event
            .get("tipo")
            .and_then(Value::as_str)
            .ok_or_else(|| invalid("Evento de orquestração inválido."))?;
        if kind == "execucao_fim" {
            ended = true;
        } else if kind == "execucao_inicio"
            || (kind != "espera" && event.get("task").is_some_and(Value::is_number))
        {
            ended = false;
        }
    }
    Ok(ended)
}

struct Lease(fs::File);

impl Drop for Lease {
    fn drop(&mut self) {
        let _ = self.0.unlock();
    }
}

fn lease(dir: &Path, exclusive: bool) -> io::Result<Lease> {
    let path = dir.join(".storage.lock");
    if path.symlink_metadata().is_ok_and(|meta| linked(&meta)) {
        return Err(invalid("A trava da pasta durável não pode ser um link."));
    }
    let file = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(path)?;
    let result = if exclusive {
        file.try_lock()
    } else {
        file.try_lock_shared()
    };
    result.map_err(|_| invalid("Há uma prova ou poda em andamento nesta orquestração."))?;
    Ok(Lease(file))
}

fn regenerable(path: &Path) -> bool {
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("");
    let parent = path
        .parent()
        .and_then(Path::file_name)
        .and_then(|name| name.to_str())
        .unwrap_or("");
    matches!(
        name,
        "target" | "node_modules" | "sandboxes" | "uv-cache" | "pip-cache"
    ) || (matches!(parent, ".cache" | "cache") && matches!(name, "uv" | "pip" | "npm"))
        || (matches!(parent, ".cargo" | "cargo" | "cargo-home")
            && matches!(name, "registry" | "git"))
        || (parent == ".npm" && name == "_cacache")
        || (parent == ".rustup" && matches!(name, "toolchains" | "downloads" | "tmp"))
        || (matches!(name, "debug" | "release" | "dist")
            && path
                .parent()
                .is_some_and(|parent| parent.join(".rustc_info.json").is_file()))
}

fn size(path: &Path) -> io::Result<u64> {
    let meta = fs::symlink_metadata(path)?;
    if linked(&meta) {
        return Ok(0);
    }
    if meta.is_file() {
        return Ok(meta.len());
    }
    let mut bytes = 0;
    for entry in fs::read_dir(path)? {
        bytes += size(&entry?.path())?;
    }
    Ok(bytes)
}

fn collect(dir: &Path, relative: &Path, report: &mut PruneReport) -> io::Result<()> {
    let mut entries = fs::read_dir(dir.join(relative))?.collect::<Result<Vec<_>, _>>()?;
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        let path = relative.join(entry.file_name());
        let meta = fs::symlink_metadata(entry.path())?;
        if linked(&meta) || !meta.is_dir() || entry.file_name() == ".git" {
            continue;
        }
        if regenerable(&dir.join(&path)) {
            report.bytes += size(&entry.path())?;
            report.paths.push(path);
        } else {
            collect(dir, &path, report)?;
        }
    }
    Ok(())
}

/// Simula ou remove apenas diretórios regeneráveis; registro inválido conserva tudo.
pub fn prune(dir: &Path, apply: bool) -> io::Result<PruneReport> {
    if linked(&fs::symlink_metadata(dir)?) {
        return Err(invalid("A pasta durável não pode ser um link."));
    }
    let dir = fs::canonicalize(dir)?;
    let _lease = lease(&dir, apply)?;
    let ended = run_state(&dir)?;
    if apply && !ended {
        return Err(invalid(
            "A execução está em andamento ou foi retomada; a poda exige execucao_fim.",
        ));
    }
    let mut report = PruneReport::default();
    collect(&dir, Path::new(""), &mut report)?;
    if apply {
        for relative in &report.paths {
            if !run_state(&dir)? {
                return Err(invalid("A execução foi retomada durante a poda."));
            }
            fs::remove_dir_all(dir.join(relative))?;
        }
    }
    Ok(report)
}

/// Limpa instalações anteriores sem transformar um registro duvidoso em permissão para apagar.
pub fn prune_archive(root: &Path, apply: bool) -> io::Result<Value> {
    let mut runs = Vec::new();
    if !root.try_exists()? {
        return Ok(serde_json::json!({"runs": runs, "bytes": 0}));
    }
    if linked(&fs::symlink_metadata(root)?) {
        return Err(invalid("O arquivo de orquestrações não pode ser um link."));
    }
    let mut entries = fs::read_dir(root)?.collect::<Result<Vec<_>, _>>()?;
    entries.sort_by_key(|entry| entry.file_name());
    let mut bytes = 0;
    for entry in entries {
        let meta = fs::symlink_metadata(entry.path())?;
        if linked(&meta) || !meta.is_dir() {
            continue;
        }
        if !entry.path().join("orq.json").exists() && !entry.path().join("eventos.jsonl").exists() {
            continue;
        }
        match prune(&entry.path(), apply) {
            Ok(report) => {
                bytes += report.bytes;
                runs.push(serde_json::json!({"run": entry.file_name().to_string_lossy(), "report": report}));
            }
            Err(error) => runs.push(serde_json::json!({"run": entry.file_name().to_string_lossy(), "skipped": error.to_string()})),
        }
    }
    Ok(serde_json::json!({"runs": runs, "bytes": bytes}))
}

/// Executa uma prova com etapa própria e conserva no arquivo apenas o que o comando publicar.
pub async fn proof(dir: &Path, command: &[String]) -> io::Result<i32> {
    use crate::terminal_process::{CommandTree, finish, leader_exited};
    use std::process::Stdio;
    if command.is_empty() {
        return Err(invalid("Informe o comando da prova depois de --."));
    }
    let dir = fs::canonicalize(dir)?;
    let _lease = lease(&dir, false)?;
    if run_state(&dir)? {
        return Err(invalid(
            "A execução já terminou; registre a retomada antes da prova.",
        ));
    }
    // No Linux /tmp costuma ser memória; builds grandes precisam do temporário em disco.
    let parent = std::env::var_os("ORQ_PROOF_TMPDIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            if cfg!(target_os = "linux") {
                PathBuf::from("/var/tmp")
            } else {
                std::env::temp_dir()
            }
        });
    let parent = fs::canonicalize(parent)?;
    if parent.starts_with(&dir) {
        return Err(invalid(
            "O temporário da prova deve ficar fora da pasta durável.",
        ));
    }
    // Registrados antes do temporário: sinal sem tratador mataria o processo e deixaria a etapa órfã.
    #[cfg(unix)]
    let mut terminate =
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
    // Fechar o painel tmux manda SIGHUP; o filho, em outro grupo, não o recebe.
    #[cfg(unix)]
    let mut hangup = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::hangup())?;
    let temp = tempfile::Builder::new()
        .prefix("hangar-orq-proof-")
        .tempdir_in(parent)?;
    let result = async {
        let mut cmd = tokio::process::Command::new(&command[0]);
        cmd.args(&command[1..])
            .stdin(Stdio::inherit())
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit())
            .kill_on_drop(true);
        // O toolchain instalado é somente leitura; isolá-lo junto dos caches impediria usar o Cargo.
        if std::env::var_os("RUSTUP_HOME").is_none()
            && let Some(home) = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE"))
        {
            cmd.env("RUSTUP_HOME", PathBuf::from(home).join(".rustup"));
        }
        for (key, relative) in [
            ("HOME", "home"),
            ("USERPROFILE", "home"),
            ("CARGO_HOME", "cargo"),
            ("CARGO_TARGET_DIR", "target"),
            ("UV_CACHE_DIR", "uv-cache"),
            ("PIP_CACHE_DIR", "pip-cache"),
            ("XDG_CACHE_HOME", "cache"),
            ("npm_config_cache", "npm-cache"),
            ("TMPDIR", "tmp"),
            ("TMP", "tmp"),
            ("TEMP", "tmp"),
        ] {
            let path = temp.path().join(relative);
            fs::create_dir_all(&path)?;
            cmd.env(key, path);
        }
        cmd.env("ORQ_PROOF_ROOT", temp.path()).env("ORQ_DIR", &dir);
        let mut tree = CommandTree::configure(&mut cmd)?;
        let mut child = cmd.spawn()?;
        if let Err(error) = tree.attach(&child) {
            let _ = child.kill().await;
            return Err(error);
        }
        eprintln!("Etapa temporária da prova: {}", temp.path().display());
        let finished = tokio::select! {
            result = leader_exited(&mut child) => result.map(|_| false),
            result = tokio::signal::ctrl_c() => result.map(|_| true),
            _ = async {
                #[cfg(unix)]
                tokio::select! { _ = terminate.recv() => {}, _ = hangup.recv() => {} }
                #[cfg(not(unix))]
                std::future::pending::<()>().await;
            } => Ok(true),
        };
        finish(&mut tree).await;
        let status = child.wait().await?;
        Ok(if finished? {
            130
        } else {
            status.code().unwrap_or(1)
        })
    }
    .await;
    temp.close()?;
    result
}

fn write_receipt(base: &Path, report: &Value) -> io::Result<()> {
    fs::create_dir_all(base)?;
    let mut receipt = tempfile::NamedTempFile::new_in(base)?;
    serde_json::to_writer_pretty(&mut receipt, report)?;
    receipt
        .persist(base.join("orq-pruned-v1.json"))
        .map_err(|error| error.error)?;
    Ok(())
}

/// O passo da atualização roda antes do download do Rust; só o binário novo consome o pedido.
pub fn prune_requested(home: &Path) -> io::Result<bool> {
    let base = home.join(".hangar");
    let request = base.join("orq-prune-request-v1");
    if !request.try_exists()? {
        return Ok(false);
    }
    let _lease = lease(&base, true)?;
    read_file(&request)?;
    let report = prune_archive(&base.join("orq"), true)?;
    write_receipt(&base, &report)?;
    fs::remove_file(request)?;
    Ok(true)
}

/// Comandos locais; este caminho não sobe servidor nem lê credenciais.
pub fn cli(args: &[String]) -> std::process::ExitCode {
    let result = (|| -> io::Result<i32> {
        let (action, rest) = args
            .split_first()
            .ok_or_else(|| invalid("Informe podar, prune-archive ou proof."))?;
        let (dir, flags) = rest
            .split_first()
            .ok_or_else(|| invalid("Informe a pasta durável."))?;
        let dir = Path::new(dir);
        if action == "proof" {
            return tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()?
                .block_on(proof(
                    dir,
                    flags.strip_prefix(&["--".into()]).unwrap_or(flags),
                ));
        }
        if flags
            .iter()
            .any(|flag| !matches!(flag.as_str(), "--apply" | "--check" | "--receipt"))
            || (flags.contains(&"--apply".into()) && flags.contains(&"--check".into()))
        {
            return Err(invalid("Opções da poda inválidas."));
        }
        let apply = flags.contains(&"--apply".into());
        let check = flags.contains(&"--check".into());
        let receipt_requested = flags.contains(&"--receipt".into());
        if receipt_requested && (action != "prune-archive" || !apply) {
            return Err(invalid("O recibo exige prune-archive --apply."));
        }
        let (report, remains) = match action.as_str() {
            "podar" => {
                let report = prune(dir, apply)?;
                let remains = !report.paths.is_empty();
                (serde_json::to_value(report)?, remains)
            }
            "prune-archive" => {
                let report = prune_archive(dir, apply)?;
                let remains = report["runs"].as_array().is_some_and(|runs| {
                    runs.iter().any(|run| {
                        run["skipped"].is_string()
                            || run["report"]["paths"]
                                .as_array()
                                .is_some_and(|paths| !paths.is_empty())
                    })
                });
                (report, remains)
            }
            _ => return Err(invalid("Comando de armazenamento desconhecido.")),
        };
        if receipt_requested {
            let parent = dir
                .parent()
                .ok_or_else(|| invalid("Pasta do arquivo inválida."))?;
            write_receipt(parent, &report)?;
        }
        println!("{}", serde_json::json!({"apply": apply, "report": report}));
        Ok(i32::from(check && remains))
    })();
    match result {
        Ok(code) => std::process::ExitCode::from(exit_code(code)),
        Err(error) => {
            eprintln!("orq: {error}");
            std::process::ExitCode::from(2)
        }
    }
}

// No Windows a falha do processo chega como NTSTATUS negativo; só o 0 real é sucesso.
fn exit_code(code: i32) -> u8 {
    u8::try_from(code).unwrap_or(1)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn exit_code_never_turns_a_failure_into_success() {
        assert_eq!(exit_code(0), 0);
        assert_eq!(exit_code(7), 7);
        // NTSTATUS de violação de acesso, como o Windows entrega em `ExitStatus::code()`.
        assert_ne!(exit_code(0xC000_0005_u32 as i32), 0);
        assert_ne!(exit_code(256), 0);
    }

    fn run_dir() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        fs::write(
            dir.path().join("orq.json"),
            r#"{"arbiter":"arbiter","repo":"/repository"}"#,
        )
        .unwrap();
        fs::write(
            dir.path().join("eventos.jsonl"),
            "{\"tipo\":\"execucao_inicio\"}\n{\"tipo\":\"execucao_fim\"}\n",
        )
        .unwrap();
        dir
    }

    fn artifact(root: &Path, name: &str, content: &[u8]) {
        let path = root.join(name);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, content).unwrap();
    }

    #[test]
    fn prune_previews_then_removes_only_regenerable_directories() {
        let dir = run_dir();
        for name in [
            "provas/r1/target/a",
            "provas/r1/home/.cargo/registry/a",
            "provas/r1/cargo/git/a",
            "provas/r1/home/.cache/uv/a",
            "provas/r1/uv-cache/a",
            "provas/r1/pip-cache/a",
            "provas/r1/node_modules/a",
            "sandboxes/reviewer/src/a",
            "provas/r1/home/.npm/_cacache/a",
            "provas/r1/home/.rustup/toolchains/a",
            "t11-host-target/debug/deps/a",
        ] {
            artifact(dir.path(), name, b"build");
        }
        artifact(dir.path(), "t11-host-target/.rustc_info.json", b"{}");
        for name in [
            "registro.md",
            "provas/r1/task1.md",
            "provas/r1/build.log",
            "provas/r1/capture.png",
            "provas/r1/home/.cargo/config.toml",
            "medicao/relatorio.json",
        ] {
            artifact(dir.path(), name, b"evidence");
        }
        let preview = prune(dir.path(), false).unwrap();
        assert!(
            preview
                .paths
                .contains(&std::path::PathBuf::from("sandboxes"))
        );
        assert_eq!(preview.bytes, 55);
        assert!(dir.path().join("provas/r1/target/a").exists());
        let applied = prune(dir.path(), true).unwrap();
        assert_eq!(applied.paths, preview.paths);
        assert!(!dir.path().join("sandboxes").exists());
        assert!(!dir.path().join("provas/r1/target").exists());
        assert!(!dir.path().join("t11-host-target/debug").exists());
        for name in [
            "registro.md",
            "provas/r1/task1.md",
            "provas/r1/build.log",
            "provas/r1/capture.png",
            "provas/r1/home/.cargo/config.toml",
            "medicao/relatorio.json",
        ] {
            assert_eq!(fs::read(dir.path().join(name)).unwrap(), b"evidence");
        }
        assert!(prune(dir.path(), true).unwrap().paths.is_empty());
    }

    #[test]
    fn prune_refuses_active_resumed_or_unreadable_runs() {
        for events in [
            "{\"tipo\":\"execucao_inicio\"}\n",
            "{\"tipo\":\"execucao_fim\"}\n{\"tipo\":\"task_inicio\",\"task\":1}\n",
            "{\"tipo\":\"execucao_fim\"}\n{truncated",
        ] {
            let dir = run_dir();
            artifact(dir.path(), "target/a", b"keep");
            fs::write(dir.path().join("eventos.jsonl"), events).unwrap();
            assert!(prune(dir.path(), true).is_err());
            assert!(dir.path().join("target/a").exists());
        }
    }

    #[cfg(unix)]
    #[test]
    fn prune_does_not_follow_links_into_other_directories() {
        use std::os::unix::fs::symlink;
        let dir = run_dir();
        let outside = tempfile::tempdir().unwrap();
        artifact(outside.path(), "target/a", b"outside");
        symlink(outside.path(), dir.path().join("provas")).unwrap();
        artifact(dir.path(), "sandboxes/round/report.md", b"copy");
        symlink(outside.path(), dir.path().join("sandboxes/round/outside")).unwrap();
        prune(dir.path(), true).unwrap();
        assert_eq!(
            fs::read(outside.path().join("target/a")).unwrap(),
            b"outside"
        );
        assert!(dir.path().join("provas").is_symlink());
    }

    #[test]
    fn archive_cleans_old_finished_runs_and_reports_skipped_runs() {
        let archive = tempfile::tempdir().unwrap();
        let old = archive.path().join("old");
        let active = archive.path().join("active");
        for path in [&old, &active] {
            artifact(path, "orq.json", br#"{"arbiter":"arbiter"}"#);
            artifact(path, "target/a", b"build");
            artifact(path, "registro.md", b"report");
        }
        artifact(&old, "eventos.jsonl", b"{\"tipo\":\"execucao_fim\"}\n");
        artifact(
            &active,
            "eventos.jsonl",
            b"{\"tipo\":\"task_inicio\",\"task\":1}\n",
        );
        let report = prune_archive(archive.path(), true).unwrap();
        assert!(!old.join("target").exists());
        assert!(active.join("target/a").exists());
        assert_eq!(fs::read(old.join("registro.md")).unwrap(), b"report");
        assert!(
            report["runs"]
                .as_array()
                .unwrap()
                .iter()
                .any(|run| run["run"] == "active" && run["skipped"].is_string())
        );
    }

    #[test]
    fn upgrade_request_is_consumed_only_after_the_new_binary_prunes_and_records_receipt() {
        let home = tempfile::tempdir().unwrap();
        let run = home.path().join(".hangar/orq/old");
        artifact(&run, "orq.json", br#"{"arbiter":"arbiter"}"#);
        artifact(&run, "eventos.jsonl", b"{\"tipo\":\"execucao_fim\"}\n");
        artifact(&run, "target/build", b"old build");
        artifact(&run, "registro.md", b"report");
        let request = home.path().join(".hangar/orq-prune-request-v1");
        fs::write(&request, "").unwrap();
        assert!(prune_requested(home.path()).unwrap());
        assert!(!request.exists());
        assert!(!run.join("target").exists());
        assert_eq!(fs::read(run.join("registro.md")).unwrap(), b"report");
        let receipt: Value = serde_json::from_str(
            &fs::read_to_string(home.path().join(".hangar/orq-pruned-v1.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(receipt["bytes"], 9);
        assert!(!prune_requested(home.path()).unwrap());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn proof_keeps_caches_outside_the_archive_and_cleans_after_failure() {
        let dir = run_dir();
        fs::write(
            dir.path().join("eventos.jsonl"),
            "{\"tipo\":\"execucao_inicio\"}\n",
        )
        .unwrap();
        let command = ["/bin/sh", "-c", r#"
            printf '%s\n' "$ORQ_PROOF_ROOT" "$HOME" "$CARGO_HOME" "$CARGO_TARGET_DIR" "$UV_CACHE_DIR" "$PIP_CACHE_DIR" "$XDG_CACHE_HOME" "$npm_config_cache" > "$ORQ_DIR/environment.txt"
            mkdir -p "$CARGO_TARGET_DIR" "$ORQ_PROOF_ROOT/sandbox"
            printf 'build' > "$CARGO_TARGET_DIR/output"
            exit 7
        "#].map(String::from);
        assert_eq!(proof(dir.path(), &command).await.unwrap(), 7);
        let captured = fs::read_to_string(dir.path().join("environment.txt")).unwrap();
        let paths: Vec<_> = captured.lines().map(PathBuf::from).collect();
        assert_eq!(paths.len(), 8);
        let root = &paths[0];
        assert!(
            paths
                .iter()
                .all(|path| path.starts_with(root) && !path.starts_with(dir.path()))
        );
        assert!(!root.exists());
        assert!(prune(dir.path(), false).unwrap().paths.is_empty());
    }
}
