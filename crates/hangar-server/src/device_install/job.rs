//! O trabalho de instalação: login (com o código de 2FA vindo da tela), limite de apps, download do
//! IPA provado, assinatura, instalação, pareamento e a conferência no aparelho. Um por aparelho.
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;
use tokio::sync::oneshot;
use zeroize::Zeroizing;

use super::apple::{AppleSigner, AskCode, CodeReply, Login, SignRequest, anisette_servers};
use super::device::create_private_dir;
use super::{DeviceError, DeviceLink};

/// O SideStore que foi provado no iPad, numa cópia nossa: o asset `nightly` do GitHub é
/// sobrescrito a cada build. Atualizar: baixar o nightly novo, provar no aparelho, subir o IPA na
/// release `sidestore-pinned` deste repositório e trocar aqui versão, sha256 e tamanho juntos.
/// SideStore é AGPL-3.0 (fonte no commit `d97ec133` de github.com/SideStore/SideStore).
pub const SIDESTORE_IPA: Pinned = Pinned {
    url: "https://github.com/jeffer1312/hangar/releases/download/sidestore-pinned/SideStore.ipa",
    version: "0.7.0-20261016.1506+d97ec133",
    sha256: "b6855f5a055e3068e136f2bafb97d6da1cbea188a7d1778dd26d3d8d8a4caad2",
    size: 31_137_643,
};

/// Fonte de apps que o SideStore abre já com o Hangar.
pub const SOURCE_URL: &str = "https://github.com/jeffer1312/hangar/releases/download/mobile-latest/sidestore-source.json";

const SIDESTORE_BUNDLE: &str = "com.SideStore.SideStore";
/// A Apple ID gratuita aceita três apps ativos por aparelho.
const FREE_APP_LIMIT: u32 = 3;
const CODE_WAIT: Duration = Duration::from_secs(600);
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(300);

#[derive(Clone, Copy, Debug)]
pub struct Pinned {
    pub url: &'static str,
    pub version: &'static str,
    pub sha256: &'static str,
    pub size: u64,
}

pub const WRONG_CODE: &str = "device_install_wrong_code";
pub const CODE_TIMEOUT: &str = "device_install_code_timeout";
pub const APP_LIMIT: &str = "device_install_app_limit";
pub const APPID_LIMIT: &str = "device_install_appid_limit";
pub const CERT_LIMIT: &str = "device_install_cert_limit";
pub const DISCONNECTED: &str = "device_install_disconnected";
pub const LOCKED: &str = "device_install_locked";
pub const SERVICE_MISSING: &str = "device_service_missing";
pub const NOT_TRUSTED: &str = "device_not_trusted";
pub const DEVICE_ERROR: &str = "device_error";
pub const LOGIN_REFUSED: &str = "device_install_login_refused";
pub const APPLE_BUSY: &str = "device_install_apple_busy";
pub const ANISETTE_UNREACHABLE: &str = "device_install_anisette_unreachable";
pub const DOWNLOAD_FAILED: &str = "device_install_download_failed";
pub const DOWNLOAD_MISMATCH: &str = "device_install_download_mismatch";
pub const SIGN_FAILED: &str = "device_install_sign_failed";
pub const NOT_INSTALLED: &str = "device_install_not_installed";
pub const BUSY: &str = "device_install_busy";
pub const FORBIDDEN: &str = "device_install_forbidden";
pub const UNKNOWN_JOB: &str = "device_install_unknown_job";
pub const NOT_WAITING: &str = "device_install_not_waiting";

/// Erro que a tela explica: código fixo e, quando ajuda, o detalhe.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Failure {
    pub code: &'static str,
    pub detail: Option<String>,
}

impl Failure {
    pub fn new(code: &'static str) -> Self {
        Self { code, detail: None }
    }
    pub fn with(code: &'static str, detail: impl Into<String>) -> Self {
        Self { code, detail: Some(detail.into()) }
    }
}

impl From<DeviceError> for Failure {
    fn from(e: DeviceError) -> Self {
        match e {
            DeviceError::ServiceMissing => Self::new(SERVICE_MISSING),
            DeviceError::NotTrusted => Self::new(NOT_TRUSTED),
            DeviceError::Locked => Self::new(LOCKED),
            DeviceError::Disconnected => Self::new(DISCONNECTED),
            DeviceError::Other(detail) => Self::with(DEVICE_ERROR, detail),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Stage {
    Login,
    AwaitingCode,
    CheckingLimit,
    Downloading,
    Signing,
    Installing,
    Pairing,
    Verifying,
    Done,
    Failed,
}

#[derive(Clone, Debug, Serialize)]
pub struct Progress {
    pub stage: Stage,
    pub error: Option<Failure>,
    pub source_url: &'static str,
}

struct Job {
    udid: String,
    progress: Mutex<Progress>,
    /// Quem espera o código: só existe enquanto o trabalho está em `awaiting_code`.
    code: Mutex<Option<oneshot::Sender<CodeReply>>>,
    timed_out: std::sync::atomic::AtomicBool,
}

impl Job {
    fn set(&self, stage: Stage, error: Option<Failure>) {
        let mut p = lock(&self.progress);
        p.stage = stage;
        p.error = error;
    }
    fn running(&self) -> bool {
        !matches!(lock(&self.progress).stage, Stage::Done | Stage::Failed)
    }
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// Pedido de início; a senha nunca sai daqui a não ser para o login.
#[derive(serde::Deserialize)]
pub struct Start {
    pub udid: String,
    pub apple_id: String,
    pub password: Zeroizing<String>,
}

pub struct DeviceInstall {
    pub link: Arc<dyn DeviceLink>,
    signer: Arc<dyn AppleSigner>,
    /// `~/.hangar/devices`: estado do isideload e downloads temporários (0700).
    dir: PathBuf,
    pinned: Pinned,
    config: Arc<dyn Fn() -> Value + Send + Sync>,
    code_wait: Duration,
    http: reqwest::Client,
    jobs: Mutex<HashMap<String, Arc<Job>>>,
}

impl DeviceInstall {
    pub fn new(link: Arc<dyn DeviceLink>, signer: Arc<dyn AppleSigner>, hangar_dir: &Path) -> Self {
        Self {
            link,
            signer,
            dir: hangar_dir.join("devices"),
            pinned: SIDESTORE_IPA,
            config: Arc::new(|| Value::Null),
            code_wait: CODE_WAIT,
            http: reqwest::Client::builder().timeout(DOWNLOAD_TIMEOUT).build().unwrap_or_default(),
            jobs: Mutex::default(),
        }
    }
    /// O `runtime-config.json` lido a cada trabalho (a chave `device_install_anisette`).
    pub fn with_config(mut self, config: Arc<dyn Fn() -> Value + Send + Sync>) -> Self {
        self.config = config;
        self
    }
    pub fn with_pinned(mut self, pinned: Pinned) -> Self {
        self.pinned = pinned;
        self
    }
    pub fn with_code_wait(mut self, wait: Duration) -> Self {
        self.code_wait = wait;
        self
    }

    /// Começa o trabalho; outro ainda rodando no mesmo aparelho é `device_install_busy`.
    pub fn start(self: &Arc<Self>, start: Start) -> Result<String, Failure> {
        let id = crate::mods::state::random_hex(16);
        let job = Arc::new(Job {
            udid: start.udid.clone(),
            progress: Mutex::new(Progress { stage: Stage::Login, error: None, source_url: SOURCE_URL }),
            code: Mutex::default(),
            timed_out: Default::default(),
        });
        {
            let mut jobs = lock(&self.jobs);
            if jobs.values().any(|j| j.udid == start.udid && j.running()) {
                return Err(Failure::new(BUSY));
            }
            // ponytail: só o último trabalho de cada aparelho fica para consulta.
            jobs.retain(|_, j| j.udid != start.udid);
            jobs.insert(id.clone(), job.clone());
        }
        let svc = self.clone();
        tokio::spawn(async move {
            match svc.run(&job, start).await {
                Ok(()) => job.set(Stage::Done, None),
                Err(f) => {
                    tracing::warn!(code = f.code, "device install failed");
                    job.set(Stage::Failed, Some(f));
                }
            }
            lock(&job.code).take();
        });
        Ok(id)
    }

    pub fn progress(&self, id: &str) -> Option<Progress> {
        lock(&self.jobs).get(id).map(|j| lock(&j.progress).clone())
    }

    /// Entrega o código (ou o pedido de reenvio) ao login que está esperando.
    pub fn answer(&self, id: &str, reply: CodeReply) -> Result<(), Failure> {
        let job = lock(&self.jobs).get(id).cloned().ok_or_else(|| Failure::new(UNKNOWN_JOB))?;
        let tx = lock(&job.code).take().ok_or_else(|| Failure::new(NOT_WAITING))?;
        job.set(Stage::Login, None);
        tx.send(reply).map_err(|_| Failure::new(NOT_WAITING))
    }

    async fn run(&self, job: &Arc<Job>, start: Start) -> Result<(), Failure> {
        let Start { udid, apple_id, password } = start;
        let device = self.link.list().await?.into_iter().find(|d| d.udid == udid).ok_or_else(|| Failure::new(DISCONNECTED))?;
        if !device.trusted {
            return Err(Failure::new(NOT_TRUSTED));
        }
        // Problema no aparelho aparece antes de a senha ir para a Apple.
        let pairing = self.link.pairing_file(&udid).await?;
        create_private_dir(&self.dir).map_err(|e| Failure::with(DEVICE_ERROR, e.to_string()))?;

        let login = Login { apple_id, password, anisette: anisette_servers(&(self.config)()), storage: self.dir.join("apple") };
        let mut session = self.signer.login(login, self.ask_code(job)).await.map_err(|f| {
            if job.timed_out.load(std::sync::atomic::Ordering::Relaxed) { Failure::new(CODE_TIMEOUT) } else { f }
        })?;

        job.set(Stage::CheckingLimit, None);
        let bundle = format!("{SIDESTORE_BUNDLE}.{}", session.team_id().await?);
        // Reinstalar o SideStore não ocupa vaga nova.
        if self.link.dev_apps(&udid).await? >= FREE_APP_LIMIT && !self.link.is_installed(&udid, &bundle).await? {
            return Err(Failure::new(APP_LIMIT));
        }

        job.set(Stage::Downloading, None);
        let tmp = tempfile::tempdir_in(&self.dir).map_err(|e| Failure::with(DOWNLOAD_FAILED, e.to_string()))?;
        let ipa = download(&self.http, &self.pinned, tmp.path()).await?;

        job.set(Stage::Signing, None);
        let signed = session.sign(SignRequest { ipa: &ipa, udid: &udid, device_name: &device.name, pairing: &pairing }).await?;
        drop(session);

        job.set(Stage::Installing, None);
        let installed = self.link.install_sidestore(&udid, &signed).await;
        let _ = std::fs::remove_dir_all(&signed);
        installed?;

        // Antes de a pessoa abrir o SideStore: aberto, ele guardaria as preferências antigas.
        job.set(Stage::Pairing, None);
        self.link.write_pairing(&udid, &bundle).await?;
        self.link.write_sidestore_prefs(&udid, &bundle).await?;

        job.set(Stage::Verifying, None);
        if !self.link.is_installed(&udid, &bundle).await? {
            return Err(Failure::with(NOT_INSTALLED, bundle));
        }
        Ok(())
    }

    /// Ponte do 2FA: o trabalho fica em `awaiting_code` até a rota `/code` responder ou o prazo vencer.
    fn ask_code(&self, job: &Arc<Job>) -> AskCode {
        let (job, wait) = (job.clone(), self.code_wait);
        Arc::new(move |wrong: bool| {
            let job = job.clone();
            Box::pin(async move {
                let (tx, rx) = oneshot::channel();
                *lock(&job.code) = Some(tx);
                job.set(Stage::AwaitingCode, wrong.then(|| Failure::new(WRONG_CODE)));
                match tokio::time::timeout(wait, rx).await {
                    Ok(Ok(reply)) => Some(reply),
                    _ => {
                        lock(&job.code).take();
                        job.timed_out.store(true, std::sync::atomic::Ordering::Relaxed);
                        None
                    }
                }
            })
        })
    }
}

/// Baixa o IPA e confere tamanho e sha256 antes de qualquer assinatura.
async fn download(http: &reqwest::Client, pinned: &Pinned, dir: &Path) -> Result<PathBuf, Failure> {
    let failed = |e: reqwest::Error| Failure::with(DOWNLOAD_FAILED, e.to_string());
    let mut resp = http.get(pinned.url).send().await.and_then(reqwest::Response::error_for_status).map_err(failed)?;
    let mut bytes = Vec::with_capacity(pinned.size as usize);
    while let Some(chunk) = resp.chunk().await.map_err(failed)? {
        bytes.extend_from_slice(&chunk);
        if bytes.len() as u64 > pinned.size {
            break;
        }
    }
    let sha = hex(ring::digest::digest(&ring::digest::SHA256, &bytes).as_ref());
    if bytes.len() as u64 != pinned.size || sha != pinned.sha256 {
        return Err(Failure::with(DOWNLOAD_MISMATCH, format!("{} bytes sha256 {sha}", bytes.len())));
    }
    let path = dir.join("SideStore.ipa");
    std::fs::write(&path, &bytes).map_err(|e| Failure::with(DOWNLOAD_FAILED, e.to_string()))?;
    Ok(path)
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
