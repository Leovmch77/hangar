//! iPhone/iPad no cabo: listar, pedir confiança, instalar o SideStore já assinado e gravar o
//! pareamento no container dele. Login Apple e assinatura moram em `apple`; o trabalho, em `job`.
pub mod apple;
pub mod device;
pub mod job;
pub mod pairing;
pub mod routes;

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use futures_util::future::BoxFuture;
use serde::{Serialize, Serializer, ser::SerializeMap};

pub use device::UsbLink;

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DeviceInfo {
    pub udid: String,
    pub name: String,
    pub ios_version: String,
    pub trusted: bool,
    /// Bloqueado, desconectado ou sem resposta: `trusted` aí não quer dizer "não confiado".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<job::Failure>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DeviceError {
    /// Sem usbmuxd (Linux) ou sem o serviço da Apple (Windows): nada fala com o aparelho.
    ServiceMissing,
    NotTrusted,
    Locked,
    Disconnected,
    Other(String),
}

impl DeviceError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::ServiceMissing => "device_service_missing",
            Self::NotTrusted => "device_not_trusted",
            Self::Locked => "device_locked",
            Self::Disconnected => "device_disconnected",
            Self::Other(_) => "device_error",
        }
    }
}

impl std::fmt::Display for DeviceError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Other(detail) => write!(f, "{}: {detail}", self.code()),
            _ => f.write_str(self.code()),
        }
    }
}

impl std::error::Error for DeviceError {}

impl Serialize for DeviceError {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let detail = match self {
            Self::Other(detail) => Some(detail),
            _ => None,
        };
        let mut map = s.serialize_map(Some(1 + usize::from(detail.is_some())))?;
        map.serialize_entry("code", self.code())?;
        if let Some(detail) = detail {
            map.serialize_entry("detail", detail)?;
        }
        map.end()
    }
}

pub trait DeviceLink: Send + Sync {
    /// Só aparelhos no cabo; vazio quando não há nenhum.
    fn list(&self) -> BoxFuture<'_, Result<Vec<DeviceInfo>, DeviceError>>;
    /// Faz aparecer "Confiar neste computador?" e espera a resposta.
    fn request_trust<'a>(&'a self, udid: &'a str) -> BoxFuture<'a, Result<(), DeviceError>>;
    /// Apps instalados com perfil de desenvolvimento válido: a Apple ID gratuita aceita três ativos.
    fn dev_apps<'a>(&'a self, udid: &'a str) -> BoxFuture<'a, Result<u32, DeviceError>>;
    /// Instala um `.ipa` ou `.app` já assinado.
    fn install_sidestore<'a>(&'a self, udid: &'a str, signed_ipa: &'a Path) -> BoxFuture<'a, Result<(), DeviceError>>;
    fn is_installed<'a>(&'a self, udid: &'a str, bundle: &'a str) -> BoxFuture<'a, Result<bool, DeviceError>>;
    /// `app_bundle` é o id real instalado, com o Team ID no fim.
    fn write_pairing<'a>(&'a self, udid: &'a str, app_bundle: &'a str) -> BoxFuture<'a, Result<(), DeviceError>>;
    /// Anisette do SideStore em `Library/Preferences/<app_bundle>.plist`, sem perder as outras chaves.
    fn write_sidestore_prefs<'a>(&'a self, udid: &'a str, app_bundle: &'a str) -> BoxFuture<'a, Result<(), DeviceError>>;
    /// O arquivo de pareamento principal desta versão do iOS, que a assinatura põe cifrado no bundle.
    fn pairing_file<'a>(&'a self, udid: &'a str) -> BoxFuture<'a, Result<Vec<u8>, DeviceError>>;
}

/// Aparelho de mentira para os testes deste módulo e das rotas.
#[derive(Default)]
pub struct FakeLink {
    pub devices: Vec<DeviceInfo>,
    /// Quando preenchido, toda operação devolve este erro.
    pub error: Option<DeviceError>,
    pub dev_apps: u32,
    pub installed: Mutex<Vec<String>>,
    pub installs: Mutex<Vec<(String, PathBuf)>>,
    pub trust_requests: Mutex<Vec<String>>,
    pub pairings: Mutex<Vec<(String, String)>>,
    pub prefs: Mutex<Vec<(String, String)>>,
}

impl FakeLink {
    fn run<T: Send + 'static>(&self, ok: impl FnOnce() -> T) -> BoxFuture<'static, Result<T, DeviceError>> {
        let result = match &self.error {
            Some(e) => Err(e.clone()),
            None => Ok(ok()),
        };
        Box::pin(async move { result })
    }
}

fn record<T: Clone>(log: &Mutex<Vec<T>>, item: T) {
    log.lock().unwrap_or_else(|e| e.into_inner()).push(item);
}

impl DeviceLink for FakeLink {
    fn list(&self) -> BoxFuture<'_, Result<Vec<DeviceInfo>, DeviceError>> {
        self.run(|| self.devices.clone())
    }
    fn request_trust<'a>(&'a self, udid: &'a str) -> BoxFuture<'a, Result<(), DeviceError>> {
        self.run(|| record(&self.trust_requests, udid.to_string()))
    }
    fn dev_apps<'a>(&'a self, _udid: &'a str) -> BoxFuture<'a, Result<u32, DeviceError>> {
        self.run(|| self.dev_apps)
    }
    fn install_sidestore<'a>(&'a self, udid: &'a str, signed_ipa: &'a Path) -> BoxFuture<'a, Result<(), DeviceError>> {
        self.run(|| record(&self.installs, (udid.to_string(), signed_ipa.to_path_buf())))
    }
    fn is_installed<'a>(&'a self, _udid: &'a str, bundle: &'a str) -> BoxFuture<'a, Result<bool, DeviceError>> {
        self.run(|| self.installed.lock().unwrap_or_else(|e| e.into_inner()).iter().any(|b| b == bundle))
    }
    fn write_pairing<'a>(&'a self, udid: &'a str, app_bundle: &'a str) -> BoxFuture<'a, Result<(), DeviceError>> {
        self.run(|| record(&self.pairings, (udid.to_string(), app_bundle.to_string())))
    }
    fn write_sidestore_prefs<'a>(&'a self, udid: &'a str, app_bundle: &'a str) -> BoxFuture<'a, Result<(), DeviceError>> {
        self.run(|| record(&self.prefs, (udid.to_string(), app_bundle.to_string())))
    }
    fn pairing_file<'a>(&'a self, udid: &'a str) -> BoxFuture<'a, Result<Vec<u8>, DeviceError>> {
        self.run(|| format!("pairing-{udid}").into_bytes())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ipad(trusted: bool) -> DeviceInfo {
        DeviceInfo { udid: "00008101-00113CEC3CBA601E".into(), name: "iPad".into(), ios_version: "26.5".into(), trusted, error: None }
    }

    #[tokio::test]
    async fn no_device_lists_empty() {
        assert_eq!(FakeLink::default().list().await.unwrap(), vec![]);
    }

    #[tokio::test]
    async fn untrusted_device_is_listed_as_not_trusted() {
        let link = FakeLink { devices: vec![ipad(false)], ..Default::default() };
        let list = link.list().await.unwrap();
        assert!(!list[0].trusted);
        assert_eq!(serde_json::to_value(&list[0]).unwrap()["trusted"], false);
    }

    #[test]
    fn errors_serialize_as_codes() {
        assert_eq!(serde_json::to_value(DeviceError::ServiceMissing).unwrap(), serde_json::json!({"code": "device_service_missing"}));
        assert_eq!(serde_json::to_value(DeviceError::NotTrusted).unwrap(), serde_json::json!({"code": "device_not_trusted"}));
        assert_eq!(serde_json::to_value(DeviceError::Locked).unwrap(), serde_json::json!({"code": "device_locked"}));
        assert_eq!(serde_json::to_value(DeviceError::Disconnected).unwrap(), serde_json::json!({"code": "device_disconnected"}));
        assert_eq!(serde_json::to_value(DeviceError::Other("x".into())).unwrap(), serde_json::json!({"code": "device_error", "detail": "x"}));
    }

    #[tokio::test]
    async fn fake_error_reaches_every_operation() {
        let link = FakeLink { devices: vec![ipad(true)], error: Some(DeviceError::ServiceMissing), ..Default::default() };
        assert_eq!(link.list().await, Err(DeviceError::ServiceMissing));
        assert_eq!(link.request_trust("u").await, Err(DeviceError::ServiceMissing));
        assert_eq!(link.write_pairing("u", "b").await, Err(DeviceError::ServiceMissing));
    }

    #[tokio::test]
    async fn write_pairing_gets_the_exact_bundle_with_team_id() {
        let link = FakeLink { devices: vec![ipad(true)], ..Default::default() };
        let (udid, bundle) = ("00008101-00113CEC3CBA601E", "com.SideStore.SideStore.ABCDE12345");
        link.write_pairing(udid, bundle).await.unwrap();
        assert_eq!(*link.pairings.lock().unwrap(), vec![(udid.to_string(), bundle.to_string())]);
        link.write_sidestore_prefs(udid, bundle).await.unwrap();
        assert_eq!(*link.prefs.lock().unwrap(), vec![(udid.to_string(), bundle.to_string())]);
    }

    #[tokio::test]
    async fn install_then_is_installed() {
        let link = FakeLink { devices: vec![ipad(true)], ..Default::default() };
        let bundle = "com.SideStore.SideStore.ABCDE12345";
        assert!(!link.is_installed("u", bundle).await.unwrap());
        link.installed.lock().unwrap().push(bundle.into());
        assert!(link.is_installed("u", bundle).await.unwrap());
        link.install_sidestore("u", Path::new("/tmp/SideStore.ipa")).await.unwrap();
        assert_eq!(link.installs.lock().unwrap()[0].1, PathBuf::from("/tmp/SideStore.ipa"));
    }
}
