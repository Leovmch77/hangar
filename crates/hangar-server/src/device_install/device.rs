//! O aparelho de verdade, pelo usbmuxd (Linux/macOS) ou pelo serviço da Apple (Windows).
//! Portado do device-spike, provado num iPad com iPadOS 26.5.
use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::time::Duration;

use futures_util::future::BoxFuture;
use idevice::afc::errors::AfcError;
use idevice::afc::opcode::AfcFopenMode;
use idevice::afc::AfcClient;
use idevice::house_arrest::HouseArrestClient;
use idevice::installation_proxy::InstallationProxyClient;
use idevice::lockdown::LockdownClient;
use idevice::misagent::MisagentClient;
use idevice::provider::UsbmuxdProvider;
use idevice::remote_pairing::{RemotePairingLockdownService, RpPairingFile};
use idevice::usbmuxd::{Connection, UsbmuxdAddr, UsbmuxdConnection};
use idevice::{IdeviceError, IdeviceService};
use plist::Dictionary;

use super::pairing::{self, ALT_FILE, LOCKDOWN_FILE, REMOTE_FILE};
use super::{DeviceError, DeviceInfo, DeviceLink};

const LABEL: &str = "hangar";
// O aviso "Confiar" fica na tela até a pessoa responder; sem prazo o pedido nunca volta.
const TRUST_WAIT: Duration = Duration::from_secs(120);

pub struct UsbLink {
    /// Cache do RPPairing: gerar outro a cada gravação deixaria um pareamento novo no aparelho.
    state_dir: PathBuf,
}

impl UsbLink {
    /// `hangar_dir` é o `~/.hangar` do `AppState`.
    pub fn new(hangar_dir: &Path) -> Self {
        Self { state_dir: hangar_dir.join("devices") }
    }

    async fn pairing_files(&self, udid: &str, p: &UsbmuxdProvider) -> Result<Vec<(&'static str, Vec<u8>)>, DeviceError> {
        let mut pr = mux().await?.get_pair_record(udid).await.map_err(|_| DeviceError::NotTrusted)?;
        pr.udid = Some(udid.to_string());
        let mut lc = LockdownClient::connect(p).await.map_err(from_idevice)?;
        lc.start_session(&pr).await.map_err(from_idevice)?;
        // Aqui a versão escolhe os arquivos: erro de leitura sobe, nunca vira "".
        let ios = lc
            .get_value(Some("ProductVersion"), None)
            .await
            .map_err(from_idevice)?
            .as_string()
            .map(str::to_string)
            .unwrap_or_default();
        lc.set_value("EnableWifiDebugging", true.into(), Some("com.apple.mobile.wireless_lockdown"))
            .await
            .map_err(from_idevice)?;
        let lockdown = dict(&pr.serialize().map_err(from_idevice)?)?;
        let rp = if pairing::needs_rppairing(&ios) { Some(self.rppairing(udid, p).await?) } else { None };
        pairing::files(&ios, &lockdown, rp.as_ref())
    }

    async fn rppairing(&self, udid: &str, p: &UsbmuxdProvider) -> Result<Dictionary, DeviceError> {
        let file = self.rppairing_path(udid)?;
        if let Ok(cached) = std::fs::read(&file)
            && let Ok(d) = dict(&cached)
        {
            return Ok(d);
        }
        let host = format!("hangar-{}", &udid[udid.len().saturating_sub(6)..]);
        let svc = RemotePairingLockdownService::connect(p).await.map_err(from_idevice)?;
        let mut client = svc.into_client(&host).map_err(from_idevice)?;
        let mut rp = RpPairingFile::generate(&host);
        client.connect(&mut rp, async || "000000".to_string()).await.map_err(from_idevice)?;
        let bytes = rp.to_bytes();
        create_private_dir(&self.state_dir).map_err(io_err)?;
        crate::pages::store::write_atomic(&file, &bytes).map_err(io_err)?;
        dict(&bytes)
    }

    fn rppairing_path(&self, udid: &str) -> Result<PathBuf, DeviceError> {
        // O udid vem do cliente e vira nome de arquivo.
        if udid.is_empty() || !udid.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
            return Err(DeviceError::Other(format!("invalid udid {udid:?}")));
        }
        Ok(self.state_dir.join(format!("rppairing-{udid}.plist")))
    }
}

impl DeviceLink for UsbLink {
    fn list(&self) -> BoxFuture<'_, Result<Vec<DeviceInfo>, DeviceError>> {
        Box::pin(async move {
            let mut m = mux().await?;
            let mut out = Vec::new();
            for d in m.get_devices().await.map_err(from_idevice)? {
                if !matches!(d.connection_type, Connection::Usb) {
                    continue;
                }
                let p = d.to_provider(addr()?, LABEL);
                let mut lc = LockdownClient::connect(&p).await.map_err(from_idevice)?;
                let name = lockdown_str(&mut lc, "DeviceName").await;
                let ios_version = lockdown_str(&mut lc, "ProductVersion").await;
                // Confiado = há registro de pareamento E o aparelho aceita sessão com ele.
                let trusted = match m.get_pair_record(&d.udid).await {
                    Ok(pr) => lc.start_session(&pr).await.is_ok(),
                    Err(_) => false,
                };
                out.push(DeviceInfo { udid: d.udid, name, ios_version, trusted });
            }
            Ok(out)
        })
    }

    fn request_trust<'a>(&'a self, udid: &'a str) -> BoxFuture<'a, Result<(), DeviceError>> {
        Box::pin(async move {
            let p = provider(udid).await?;
            let mut m = mux().await?;
            if let Ok(pr) = m.get_pair_record(udid).await {
                let mut lc = LockdownClient::connect(&p).await.map_err(from_idevice)?;
                if lc.start_session(&pr).await.is_ok() {
                    return Ok(());
                }
            }
            let buid = m.get_buid().await.map_err(from_idevice)?;
            let host_id = crate::session_open::open::uuid4(&crate::mods::state::random_hex(16)).to_uppercase();
            let mut lc = LockdownClient::connect(&p).await.map_err(from_idevice)?;
            let pr = tokio::time::timeout(TRUST_WAIT, lc.pair(host_id, buid, Some("Hangar")))
                .await
                .map_err(|_| DeviceError::NotTrusted)?
                .map_err(from_idevice)?;
            m.save_pair_record(udid, pr.serialize().map_err(from_idevice)?).await.map_err(from_idevice)
        })
    }

    fn dev_apps<'a>(&'a self, udid: &'a str) -> BoxFuture<'a, Result<u32, DeviceError>> {
        Box::pin(async move {
            let p = provider(udid).await?;
            let mut mis = MisagentClient::connect(&p).await.map_err(from_idevice)?;
            let profiles = mis.copy_all().await.map_err(from_idevice)?;
            Ok(profiles.iter().filter(|raw| is_development_profile(raw)).count() as u32)
        })
    }

    fn install_sidestore<'a>(&'a self, udid: &'a str, signed_ipa: &'a Path) -> BoxFuture<'a, Result<(), DeviceError>> {
        Box::pin(async move {
            let p = provider(udid).await?;
            idevice::utils::installation::install_package(&p, signed_ipa, None).await.map_err(from_idevice)
        })
    }

    fn is_installed<'a>(&'a self, udid: &'a str, bundle: &'a str) -> BoxFuture<'a, Result<bool, DeviceError>> {
        Box::pin(async move {
            let p = provider(udid).await?;
            let mut ip = InstallationProxyClient::connect(&p).await.map_err(from_idevice)?;
            let apps = ip.get_apps(Some("User"), Some(vec![bundle.to_string()])).await.map_err(from_idevice)?;
            Ok(apps.contains_key(bundle))
        })
    }

    fn write_pairing<'a>(&'a self, udid: &'a str, app_bundle: &'a str) -> BoxFuture<'a, Result<(), DeviceError>> {
        Box::pin(async move {
            let p = provider(udid).await?;
            let files = self.pairing_files(udid, &p).await?;
            let ha = HouseArrestClient::connect(&p).await.map_err(from_idevice)?;
            let mut afc = ha.vend_documents(app_bundle.to_string()).await.map_err(from_idevice)?;
            ignore_already_done(afc.mk_dir("/Documents").await)?;
            // Arquivo de uma gravação anterior que não vale mais nesta versão deixa o SideStore "ambiguous".
            for stale in [ALT_FILE, REMOTE_FILE, LOCKDOWN_FILE] {
                if !files.iter().any(|(n, _)| *n == stale) {
                    ignore_already_done(afc.remove(format!("/Documents/{stale}")).await)?;
                }
            }
            for (name, bytes) in &files {
                write_file(&mut afc, &format!("/Documents/{name}"), bytes).await?;
            }
            Ok(())
        })
    }

    fn write_sidestore_prefs<'a>(&'a self, udid: &'a str, app_bundle: &'a str) -> BoxFuture<'a, Result<(), DeviceError>> {
        Box::pin(async move {
            let p = provider(udid).await?;
            let ha = HouseArrestClient::connect(&p).await.map_err(from_idevice)?;
            let mut afc = ha.vend_container(app_bundle.to_string()).await.map_err(from_idevice)?;
            let path = format!("/Library/Preferences/{app_bundle}.plist");
            let existing = match afc.open(path.clone(), AfcFopenMode::RdOnly).await {
                Ok(mut f) => {
                    let bytes = f.read_entire().await.map_err(from_idevice)?;
                    f.close().await.map_err(from_idevice)?;
                    bytes
                }
                Err(e) if is_not_found(&e) => Vec::new(),
                Err(e) => return Err(from_idevice(e)),
            };
            let merged = pairing::merge_sidestore_prefs(&existing)?;
            ignore_already_done(afc.mk_dir("/Library/Preferences").await)?;
            write_file(&mut afc, &path, &merged).await
        })
    }
}

/// Erro do idevice para o que a tela sabe explicar.
pub fn from_idevice(e: IdeviceError) -> DeviceError {
    match e {
        IdeviceError::DeviceNotFound | IdeviceError::Socket(_) => DeviceError::Disconnected,
        IdeviceError::DeviceLocked | IdeviceError::PasswordProtected => DeviceError::Locked,
        IdeviceError::InvalidHostID
        | IdeviceError::UserDeniedPairing
        | IdeviceError::PairingDialogResponsePending
        | IdeviceError::SessionInactive => DeviceError::NotTrusted,
        e => DeviceError::Other(e.to_string()),
    }
}

fn io_err(e: std::io::Error) -> DeviceError {
    DeviceError::Other(e.to_string())
}

fn addr() -> Result<UsbmuxdAddr, DeviceError> {
    UsbmuxdAddr::from_env_var().map_err(|e| DeviceError::Other(format!("USBMUXD_SOCKET_ADDRESS: {e}")))
}

// Não conectar no usbmuxd (ou no serviço da Apple no Windows) é sempre "falta o serviço".
async fn mux() -> Result<UsbmuxdConnection, DeviceError> {
    mux_at(addr()?).await
}

async fn mux_at(addr: UsbmuxdAddr) -> Result<UsbmuxdConnection, DeviceError> {
    addr.connect(0).await.map_err(|_| DeviceError::ServiceMissing)
}

async fn provider(udid: &str) -> Result<UsbmuxdProvider, DeviceError> {
    let d = mux().await?.get_device(udid).await.map_err(from_idevice)?;
    Ok(d.to_provider(addr()?, LABEL))
}

async fn lockdown_str(lc: &mut LockdownClient, key: &str) -> String {
    lc.get_value(Some(key), None).await.ok().and_then(|v| v.as_string().map(str::to_string)).unwrap_or_default()
}

fn dict(bytes: &[u8]) -> Result<Dictionary, DeviceError> {
    plist::Value::from_reader(Cursor::new(bytes))
        .ok()
        .and_then(plist::Value::into_dictionary)
        .ok_or_else(|| DeviceError::Other("plist is not a dictionary".into()))
}

/// Perfis vêm embrulhados em CMS; o plist XML está em claro dentro deles.
fn is_development_profile(raw: &[u8]) -> bool {
    let Some(start) = raw.windows(5).position(|w| w == b"<?xml") else { return false };
    let Some(end) = raw.windows(8).rposition(|w| w == b"</plist>") else { return false };
    dict(&raw[start..end + 8])
        .ok()
        .and_then(|d| d.get("Entitlements")?.as_dictionary()?.get("get-task-allow")?.as_boolean())
        .unwrap_or(false)
}

fn is_not_found(e: &IdeviceError) -> bool {
    matches!(e, IdeviceError::Afc(AfcError::ObjectNotFound))
}

/// Pasta que já existe ou arquivo que já não existe: o estado pedido já está lá.
fn ignore_already_done(r: Result<(), IdeviceError>) -> Result<(), DeviceError> {
    match r {
        Err(e) if !is_not_found(&e) && !matches!(e, IdeviceError::Afc(AfcError::ObjectExists)) => Err(from_idevice(e)),
        _ => Ok(()),
    }
}

async fn write_file(afc: &mut AfcClient, path: &str, bytes: &[u8]) -> Result<(), DeviceError> {
    let mut f = afc.open(path.to_string(), AfcFopenMode::Wr).await.map_err(from_idevice)?;
    f.write_entire(bytes).await.map_err(from_idevice)?;
    f.close().await.map_err(from_idevice)
}

fn create_private_dir(dir: &Path) -> std::io::Result<()> {
    let mut b = std::fs::DirBuilder::new();
    b.recursive(true);
    #[cfg(unix)]
    std::os::unix::fs::DirBuilderExt::mode(&mut b, 0o700);
    b.create(dir)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn idevice_errors_map_to_screen_codes() {
        assert_eq!(from_idevice(IdeviceError::DeviceNotFound), DeviceError::Disconnected);
        assert_eq!(from_idevice(IdeviceError::Socket(std::io::ErrorKind::BrokenPipe.into())), DeviceError::Disconnected);
        assert_eq!(from_idevice(IdeviceError::DeviceLocked), DeviceError::Locked);
        assert_eq!(from_idevice(IdeviceError::PasswordProtected), DeviceError::Locked);
        assert_eq!(from_idevice(IdeviceError::UserDeniedPairing), DeviceError::NotTrusted);
        assert_eq!(from_idevice(IdeviceError::InvalidHostID), DeviceError::NotTrusted);
        assert!(matches!(from_idevice(IdeviceError::Timeout), DeviceError::Other(_)));
    }

    #[tokio::test]
    async fn no_usbmuxd_is_service_missing() {
        let nobody = UsbmuxdAddr::TcpSocket("127.0.0.1:1".parse().unwrap());
        assert_eq!(mux_at(nobody).await.err(), Some(DeviceError::ServiceMissing));
    }

    #[test]
    fn udid_that_is_not_hex_never_becomes_a_path() {
        let link = UsbLink::new(Path::new("/h"));
        assert!(link.rppairing_path("../x").is_err());
        assert_eq!(link.rppairing_path("0000-AB").unwrap(), Path::new("/h/devices/rppairing-0000-AB.plist"));
    }

    #[test]
    fn development_profile_is_read_from_inside_the_cms() {
        let plist = br#"<?xml version="1.0"?><plist version="1.0"><dict><key>Entitlements</key><dict><key>get-task-allow</key><true/></dict></dict></plist>"#;
        let mut raw = b"\x30\x82junk".to_vec();
        raw.extend_from_slice(plist);
        raw.extend_from_slice(b"\x00sig");
        assert!(is_development_profile(&raw));
        assert!(!is_development_profile(b"no plist"));
    }
}
