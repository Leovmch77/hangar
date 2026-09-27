//! Servidor nesta máquina: anexos, atalhos de programa e o editor vão direto ao disco e ao processo, com as regras de
//! `backend/app/uploads.py` e das rotas `upload`, `shortcut-shell` e `open-editor` de `backend/app/api.py`. Servidor
//! remoto, pasta que não existe aqui ou vídeo (quadros e fala saem do backend) seguem pelo backend.
use super::*;
use crate::api::MAX_BYTES;
use std::{path::Path, process::{Command, Stdio}};

/// Os `VIDEO_EXTS` de `backend/app/video.py`.
const VIDEO_EXTS: [&str; 6] = ["mp4", "mov", "webm", "mkv", "m4v", "avi"];

fn refusal(status: u16, detail: impl Into<String>) -> Failure {
    Failure { status: Some(status), detail: detail.into(), retry_after: None, uncertain: false }
}

/// `_slug`: nome de pasta seguro. O backend normaliza acento (NFKD) antes; aqui só nome ASCII, o resto vai ao backend.
// ponytail: sem NFKD no nativo; nome de pasta ou sessão com acento cai no backend. Trazer a normalização se isso pesar.
fn slug(text: &str) -> Option<String> {
    if !text.is_ascii() { return None; }
    let mapped: String = text.chars().map(|c| if c.is_ascii_alphanumeric() || "._-".contains(c) { c } else { '-' }).collect();
    let trimmed = mapped.trim_matches('-');
    let slug = if trimmed.is_empty() || trimmed == "." || trimmed == ".." { "_" } else { trimmed };
    Some(slug.chars().take(64).collect())
}

/// `session_key` de `backend/app/models.py`: id durável do transcript (Kimi: pasta da sessão; Codex: uuid do rollout).
fn session_id(jsonl: &str) -> Option<String> {
    let path = Path::new(jsonl);
    let name = |p: Option<&Path>| p.and_then(Path::file_name).and_then(|n| n.to_str()).map(str::to_owned);
    if path.file_name().is_some_and(|n| n == "wire.jsonl") {
        let agents = path.parent().and_then(Path::parent);
        if name(agents).as_deref() == Some("agents") { return name(agents.and_then(Path::parent)); }
    }
    let stem = path.file_stem()?.to_str()?;
    let uuid = |id: &str| id.len() == 36 && id.char_indices().all(|(i, c)| if [8, 13, 18, 23].contains(&i) { c == '-' } else { c.is_ascii_hexdigit() });
    if stem.is_ascii() && stem.starts_with("rollout-") && stem.len() >= 45 && &stem[stem.len() - 37..stem.len() - 36] == "-" {
        let id = &stem[stem.len() - 36..];
        if uuid(id) { return Some(id.to_owned()); }
    }
    Some(stem.to_owned())
}

/// `_projeto`: nome da pasta do projeto + 6 hex do sha256 do caminho real (caminho fora de UTF-8 vai ao backend).
fn project(cwd: &Path) -> Option<String> {
    let digest = ring::digest::digest(&ring::digest::SHA256, cwd.to_str()?.as_bytes());
    let hex: String = digest.as_ref().iter().take(3).map(|b| format!("{b:02x}")).collect();
    Some(format!("{}-{hex}", slug(cwd.file_name()?.to_str()?)?))
}

/// `_base`: `~/.hangar/uploads/<projeto>/<id da sessão>/`; sem transcript, o id é o nome da sessão.
fn uploads_dir(home: &Path, cwd: &Path, id: &str) -> Option<PathBuf> {
    Some(home.join(".hangar").join("uploads").join(project(cwd)?).join(slug(id)?))
}

/// `list_uploads`: arquivos da pasta, mais recente primeiro; um item que falha no stat é pulado.
fn list(dir: &Path) -> Vec<UploadFile> {
    let Ok(entries) = std::fs::read_dir(dir) else { return Vec::new() };
    let mut files: Vec<UploadFile> = entries.flatten().filter_map(|entry| {
        let meta = std::fs::metadata(entry.path()).ok().filter(|m| m.is_file())?;
        let mtime = meta.modified().ok()?.duration_since(std::time::UNIX_EPOCH).ok()?.as_secs_f64();
        Some(UploadFile { filename: entry.file_name().into_string().ok()?, size: meta.len(), mtime })
    }).collect();
    files.sort_by(|a, b| b.mtime.total_cmp(&a.mtime));
    files
}

/// `resolve_upload`: só um nome solto, e o caminho real tem de ser `<pasta real>/<nome>` (symlink para fora é recusado).
fn resolve(dir: &Path, filename: &str) -> Result<PathBuf, Failure> {
    if filename.is_empty() || filename.contains(['/', '\\']) || filename.contains("..") { return Err(refusal(400, "filename invalido")); }
    let missing = || refusal(404, "arquivo nao encontrado");
    let base = std::fs::canonicalize(dir).map_err(|_| missing())?;
    let real = std::fs::canonicalize(dir.join(filename)).map_err(|_| missing())?;
    if real != base.join(filename) { return Err(refusal(400, "caminho invalido")); }
    if !real.is_file() { return Err(missing()); }
    Ok(real)
}

fn read(dir: &Path, filename: &str) -> Result<Vec<u8>, Failure> {
    let path = resolve(dir, filename)?;
    if std::fs::metadata(&path).map_err(|_| Failure::local("invalid_response"))?.len() > MAX_BYTES { return Err(Failure::local("attach_too_big")); }
    std::fs::read(&path).map_err(|_| Failure::local("invalid_response"))
}

/// `_safe_ext` sobre o nome como ele iria no `X-Filename` (percent-encoded): [a-z0-9] até 8, ou `bin`.
fn safe_ext(filename: &str) -> String {
    let encoded = composer::encode_component(if filename.is_empty() { "arquivo" } else { filename });
    let suffix = encoded.rfind('.').filter(|&i| i > 0).map_or("", |i| &encoded[i + 1..]);
    let ext: String = suffix.to_lowercase().chars().filter(|c| c.is_ascii_lowercase() || c.is_ascii_digit()).take(8).collect();
    if ext.is_empty() { "bin".into() } else { ext }
}

/// `save_upload`: nome gerado aqui (segundos + 6 hex), só a extensão vem do arquivo; nunca sobrescreve.
fn save(dir: &Path, filename: &str, bytes: &[u8]) -> Result<Uploaded, Failure> {
    if bytes.is_empty() { return Err(refusal(400, "arquivo vazio")); }
    if bytes.len() as u64 > MAX_BYTES { return Err(refusal(413, "arquivo maior que 100 MiB")); }
    let mut token = [0u8; 3];
    ring::rand::SecureRandom::fill(&ring::rand::SystemRandom::new(), &mut token).map_err(|_| Failure::local("invalid_response"))?;
    let seconds = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let name = format!("{seconds}-{}.{}", token.iter().map(|b| format!("{b:02x}")).collect::<String>(), safe_ext(filename));
    std::fs::create_dir_all(dir).map_err(|error| refusal(500, error.to_string()))?;
    let path = std::fs::canonicalize(dir).map_err(|error| refusal(500, error.to_string()))?.join(&name);
    use std::io::Write;
    std::fs::OpenOptions::new().write(true).create_new(true).open(&path).and_then(|mut file| file.write_all(bytes))
        .map_err(|error| refusal(500, error.to_string()))?;
    Ok(Uploaded { path: path.to_string_lossy().into_owned(), frames: Vec::new(), transcript: Some(String::new()) })
}

/// `prune_old`: apaga do projeto inteiro (todas as sessões) o que passou de `days` dias; erro de um arquivo não para a
/// varredura. Pasta ligada por symlink não é percorrida, como o `rglob` do backend.
fn prune(project: &Path, days: i64) {
    if days <= 0 { return; }
    let Some(cut) = std::time::SystemTime::now().checked_sub(std::time::Duration::from_secs(days as u64 * 86_400)) else { return };
    let Ok(entries) = std::fs::read_dir(project) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if entry.file_type().is_ok_and(|t| t.is_dir()) { prune(&path, days); continue; }
        if std::fs::metadata(&path).is_ok_and(|m| m.is_file() && m.modified().is_ok_and(|t| t < cut)) { let _ = std::fs::remove_file(&path); }
    }
}

/// `shortcut-shell`: o comando pelo shell, no cwd da sessão, desprendido e sem saída.
fn shell(cwd: &Path, command: &str) -> Result<Value, Failure> {
    let command = command.trim();
    if command.is_empty() { return Err(refusal(400, "comando vazio")); }
    launch(Command::new("/bin/sh").arg("-c").arg(command).current_dir(cwd)).map_err(|error| refusal(500, error.to_string()))
}

/// `open-editor`: o binário da configuração do servidor com a pasta como único argumento, sem shell.
fn editor(binary: &str, cwd: &str) -> Result<Value, Failure> {
    launch(Command::new(binary).arg(cwd)).map_err(|error| refusal(500, format!("editor '{binary}' falhou: {error}")))
}

fn launch(command: &mut Command) -> std::io::Result<Value> {
    // Grupo próprio: fechar o app ou um Ctrl-C no terminal que o abriu não leva o programa junto.
    // ponytail: o backend usa setsid; grupo próprio basta sem terminal de controle. setsid via libc se precisar.
    #[cfg(unix)] { use std::os::unix::process::CommandExt; command.process_group(0); }
    let mut child = command.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn()?;
    // Quem espera é uma thread, senão o filho que termina fica zumbi até o app fechar.
    std::thread::spawn(move || { let _ = child.wait(); });
    Ok(json!({"ok": true}))
}

async fn blocking<T: Send + 'static>(job: impl FnOnce() -> Result<T, Failure> + Send + 'static) -> Result<T, Failure> {
    tokio::task::spawn_blocking(job).await.map_err(|_| Failure::local("invalid_response"))?
}

/// Onde os anexos de uma sessão são lidos e gravados.
#[derive(Clone)]
pub(super) enum Uploads { Local(PathBuf), Remote }

impl Uploads {
    pub(super) async fn list(&self, api: &Api, name: &str) -> Result<Vec<UploadFile>, Failure> {
        match self {
            Uploads::Local(dir) => { let dir = dir.clone(); blocking(move || Ok(list(&dir))).await }
            Uploads::Remote => api.uploads(name).await,
        }
    }

    pub(super) async fn fetch(&self, api: &Api, name: &str, source: &Source) -> Result<Vec<u8>, Failure> {
        match (self, source) {
            (Uploads::Local(dir), Source::Upload(file)) => { let (dir, file) = (dir.clone(), file.clone()); blocking(move || read(&dir, &file)).await }
            _ => api.fetch(name, source).await,
        }
    }

    /// Vídeo sobe pelo backend, que extrai quadros e transcreve a fala; o resto grava aqui e varre os vencidos do projeto.
    pub(super) async fn upload(&self, api: &Api, name: &str, filename: &str, bytes: Vec<u8>, retention: Option<i64>) -> Result<Uploaded, Failure> {
        match self {
            Uploads::Local(dir) if !VIDEO_EXTS.contains(&safe_ext(filename).as_str()) => {
                let (dir, filename) = (dir.clone(), filename.to_owned());
                blocking(move || {
                    let saved = save(&dir, &filename, &bytes)?;
                    if let (Some(days), Some(project)) = (retention, dir.parent()) { prune(project, days); }
                    Ok(saved)
                }).await
            }
            _ => api.upload(name, filename, composer::mime_for(filename), bytes).await,
        }
    }
}

/// Retenção dos anexos (`upload_retention_days`); sem a configuração, a varredura fica para o próximo envio.
pub(super) async fn retention(api: &Api) -> Option<i64> {
    api.config().await.ok()?.pointer("/campos/upload_retention_days/valor")?.as_i64()
}

impl Hangar {
    /// A sessão roda nesta máquina: servidor em loopback e a pasta dela existe aqui (o mesmo critério do painel de git).
    /// Fora do Unix tudo segue pelo backend: shell, pasta pessoal e separador de caminho mudam.
    fn local_cwd(&self, name: &str) -> Option<(String, PathBuf)> {
        if !cfg!(unix) || !self.api.as_ref()?.is_loopback() { return None; }
        let cwd = self.sessions.iter().chain(self.selected.as_ref()).find(|s| s.name == name)?.cwd.clone()?;
        let real = std::fs::canonicalize(&cwd).ok().filter(|p| p.is_dir())?;
        Some((cwd, real))
    }

    /// Anexos da sessão aberta: da pasta desta máquina quando dá, senão pelo backend.
    pub(super) fn uploads_for(&self, key: &SessionKey) -> Uploads {
        let local = self.local_cwd(&key.name).and_then(|(_, real)| {
            let id = if key.jsonl.is_empty() { Some(key.name.clone()) } else { session_id(&key.jsonl) }?;
            uploads_dir(&std::env::home_dir()?, &real, &id)
        });
        local.map_or(Uploads::Remote, Uploads::Local)
    }

    /// `shortcut-shell` local quando a sessão é desta máquina; `None` manda ao backend.
    pub(super) fn local_shell(&self, name: &str, command: String) -> Option<impl Future<Output = Result<Value, Failure>> + use<>> {
        let (_, real) = self.local_cwd(name)?;
        Some(blocking(move || shell(&real, &command)))
    }

    /// `open-editor` local quando a sessão é desta máquina: o editor vem da configuração do servidor.
    pub(super) fn local_editor(&self, name: &str) -> Option<impl Future<Output = Result<Value, Failure>> + use<>> {
        let (cwd, _) = self.local_cwd(name)?;
        let api = self.api.clone()?;
        Some(async move {
            let config = api.config().await?;
            let binary = config.pointer("/campos/editor/valor").and_then(Value::as_str).filter(|b| !b.is_empty()).map(str::to_owned)
                .ok_or_else(|| Failure::local("invalid_response"))?;
            blocking(move || editor(&binary, &cwd)).await
        })
    }
}

#[cfg(test)]
mod tests {
    use super::{resolve, safe_ext, session_id, slug, uploads_dir};
    use std::path::Path;

    #[test]
    fn upload_folder_follows_the_backend_rule() {
        // hashlib.sha256(b"/home/u/meu projeto").hexdigest()[:6] == "1c77cd", o `_projeto` do backend.
        let dir = uploads_dir(Path::new("/home/u"), Path::new("/home/u/meu projeto"), "abc/../x").unwrap();
        assert_eq!(dir, Path::new("/home/u/.hangar/uploads/meu-projeto-1c77cd/abc-..-x"));
        assert_eq!(slug(".."), Some("_".into()));
        assert_eq!(slug("Área"), None);
        assert_eq!(session_id("/p/0f1e.jsonl").as_deref(), Some("0f1e"));
        assert_eq!(session_id("/s/wd/sid-1/agents/main/wire.jsonl").as_deref(), Some("sid-1"));
        assert_eq!(session_id("/c/rollout-2026-09-27T10-00-00-0199a1b2-c3d4-e5f6-a7b8-c9d0e1f2a3b4.jsonl").as_deref(),
            Some("0199a1b2-c3d4-e5f6-a7b8-c9d0e1f2a3b4"));
        assert_eq!((safe_ext("foto.PNG").as_str(), safe_ext("x").as_str(), safe_ext("a.tar gz").as_str()), ("png", "bin", "tar20gz"));
    }

    #[cfg(unix)]
    #[test]
    fn a_file_outside_the_folder_is_refused() {
        let root = std::env::temp_dir().join(format!("hangar-uploads-{}", std::process::id()));
        let dir = root.join("sessao");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(root.join("fora.txt"), b"x").unwrap();
        std::fs::write(dir.join("dentro.txt"), b"x").unwrap();
        std::os::unix::fs::symlink(root.join("fora.txt"), dir.join("link.txt")).unwrap();
        assert!(resolve(&dir, "dentro.txt").is_ok());
        for name in ["../fora.txt", "link.txt", "a/b", ""] { assert!(resolve(&dir, name).is_err(), "{name}"); }
        let _ = std::fs::remove_dir_all(&root);
    }
}
