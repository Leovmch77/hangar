//! Atualização do próprio app pela release fixa `native-latest`, reescrita pelo CI a cada push na main.
//! Lê só o manifesto (pelo endereço de download, que não gasta a cota da API do GitHub), ao abrir e a cada 6 h.
//! Atualizar baixa o binário da plataforma, confere o sha256 do manifesto e troca o arquivo guardando o anterior em
//! `<exe>.old`. O processo velho continua de pé até o novo gravar o próprio pid em `<exe>.alive`: se ele morrer ou
//! não der sinal a tempo, o anterior volta para o lugar e este processo segue aberto. Nunca fica sem app.
use crate::{i18n::tr, theme};
use gpui_kit::{assets::IconName, component::{button::*, notification::Notification, *}, *};
use serde::Deserialize;
use std::{collections::HashMap, ffi::OsString, path::{Path, PathBuf}, sync::Arc, time::Duration};
use tokio::runtime::Runtime;

const RELEASE: &str = "https://github.com/jeffer1312/hangar/releases/download/native-latest";
const EVERY: Duration = Duration::from_secs(6 * 3600);
/// Janela GPUI fria num disco lento leva segundos; 30 s cobre com folga sem deixar o usuário esperando à toa.
const ALIVE_WAIT: Duration = Duration::from_secs(30);
const ALIVE_ENV: &str = "HANGAR_NATIVE_ALIVE";
pub const CURRENT: &str = env!("HANGAR_NATIVE_RELEASE");

/// Só para provas: HANGAR_NATIVE_UPDATE_URL aponta para uma release falsa local.
fn base() -> String { std::env::var("HANGAR_NATIVE_UPDATE_URL").unwrap_or_else(|_| RELEASE.to_owned()) }

/// Nome do binário cru desta plataforma na release. Plataforma sem build no CI não procura nada.
fn asset() -> Option<&'static str> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("linux", "x86_64") => Some("Hangar-linux-x86_64"),
        ("windows", "x86_64") => Some("Hangar-windows-x86_64.exe"),
        ("macos", "aarch64") => Some("Hangar-macos-aarch64"),
        _ => None,
    }
}

/// `0.1.0.2533` contra `0.1.0.2540`, número a número. Texto que não é versão nunca é "mais novo".
fn newer(remote: &str, local: &str) -> bool {
    let parse = |v: &str| v.split('.').map(str::parse::<u64>).collect::<Result<Vec<_>, _>>().ok();
    matches!((parse(remote), parse(local)), (Some(r), Some(l)) if r > l)
}

fn sha256_hex(bytes: &[u8]) -> String {
    ring::digest::digest(&ring::digest::SHA256, bytes).as_ref().iter().map(|b| format!("{b:02x}")).collect()
}

#[derive(Deserialize)]
struct Manifest { version: String, files: HashMap<String, String> }

#[derive(Clone)]
struct Offer { version: String, url: String, sha256: String }

async fn check(client: &reqwest::Client) -> Result<Option<Offer>, String> {
    let Some(name) = asset() else { return Ok(None) };
    let response = client.get(format!("{}/native-latest.json", base())).send().await.map_err(|e| e.to_string())?;
    // Sem release ainda (ou repositório sem ela): nada a oferecer, não é erro.
    if response.status() == reqwest::StatusCode::NOT_FOUND { return Ok(None); }
    let manifest: Manifest = response.error_for_status().map_err(|e| e.to_string())?.json().await.map_err(|e| e.to_string())?;
    let Some(sha256) = manifest.files.get(name) else { return Ok(None) };
    Ok(newer(&manifest.version, CURRENT).then(|| Offer { version: manifest.version, url: format!("{}/{name}", base()), sha256: sha256.to_lowercase() }))
}

fn sibling(exe: &Path, suffix: &str) -> PathBuf {
    let mut name: OsString = exe.as_os_str().to_owned();
    name.push(suffix);
    PathBuf::from(name)
}

/// Confere o sha256 e troca o binário em disco. Devolve o caminho do anterior guardado, ou a frase da falha.
fn swap(exe: &Path, bytes: &[u8], sha256: &str) -> Result<PathBuf, String> {
    use std::io::Write;
    if sha256_hex(bytes) != sha256 { return Err(tr("app_update_bad_sha")); }
    let fail = |e: std::io::Error| tr("app_update_swap_failed").replace("{reason}", &e.to_string());
    let (new, old) = (sibling(exe, ".new"), sibling(exe, ".old"));
    let mut file = std::fs::File::create(&new).map_err(fail)?;
    file.write_all(bytes).and_then(|_| file.sync_all()).map_err(fail)?;
    drop(file);
    #[cfg(unix)] {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&new, std::fs::Permissions::from_mode(0o755)).map_err(fail)?;
        // Cópia, não rename: entre dois renames o caminho do app ficaria vazio.
        std::fs::copy(exe, &old).map_err(fail)?;
        std::fs::rename(&new, exe).map_err(fail)?;
    }
    // No Windows o executável em uso não pode ser sobrescrito, mas pode ser renomeado.
    #[cfg(windows)] {
        let _ = std::fs::remove_file(&old);
        std::fs::rename(exe, &old).map_err(fail)?;
        if let Err(error) = std::fs::rename(&new, exe) {
            // Sem desfazer, o caminho do app fica vazio: essa falha não pode sair como "nada foi trocado".
            if let Err(back) = std::fs::rename(&old, exe) {
                return Err(tr("app_update_rollback_failed").replace("{reason}", &format!("{error}; {back}")));
            }
            return Err(fail(error));
        }
    }
    Ok(old)
}

fn rollback(exe: &Path, old: &Path) -> std::io::Result<()> {
    // No Windows o `.old` é a imagem deste processo: renomear continua valendo, sobrescrever o novo exige tirá-lo antes.
    #[cfg(windows)] { let _ = std::fs::remove_file(exe); }
    std::fs::rename(old, exe)
}

/// O novo processo prova que subiu gravando o próprio pid; pid e não "arquivo existe", para um resto antigo não enganar.
async fn alive(child: &mut std::process::Child, path: &Path) -> bool {
    let deadline = tokio::time::Instant::now() + ALIVE_WAIT;
    while tokio::time::Instant::now() < deadline {
        if std::fs::read_to_string(path).is_ok_and(|pid| pid.trim() == child.id().to_string()) { return true; }
        if !matches!(child.try_wait(), Ok(None)) { return false; }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    let _ = child.kill();
    let _ = child.wait();
    false
}

async fn install(client: reqwest::Client, exe: Option<PathBuf>, offer: Offer) -> Result<(), String> {
    let bytes = client.get(&offer.url).send().await.and_then(reqwest::Response::error_for_status).map_err(|e| e.to_string())?
        .bytes().await.map_err(|e| e.to_string())?;
    let exe = exe.ok_or_else(|| tr("app_update_swap_failed").replace("{reason}", "current_exe"))?;
    // Dezenas de MB conferidos, gravados e copiados: fora das duas threads do runtime.
    let target = exe.clone();
    let old = tokio::task::spawn_blocking(move || swap(&target, &bytes, &offer.sha256)).await.map_err(|e| e.to_string())??;
    let signal = sibling(&exe, ".alive");
    let _ = std::fs::remove_file(&signal);
    let started = std::process::Command::new(&exe).args(std::env::args_os().skip(1)).env(ALIVE_ENV, &signal).spawn();
    let up = match started { Ok(mut child) => alive(&mut child, &signal).await, Err(_) => false };
    let _ = std::fs::remove_file(&signal);
    if up { return Ok(()); }
    rollback(&exe, &old).map_err(|e| tr("app_update_rollback_failed").replace("{reason}", &e.to_string()))?;
    Err(tr("app_update_rolled_back"))
}

/// Chamado pelo processo novo quando a janela abriu: é a prova de vida que o antigo espera.
pub fn report_alive() {
    if let Some(path) = std::env::var_os(ALIVE_ENV) { let _ = std::fs::write(path, std::process::id().to_string()); }
}

enum State { Idle, Available(Offer), Updating, Failed(Offer, String) }

pub struct Updater {
    runtime: Arc<Runtime>,
    client: reqwest::Client,
    /// Lido ao abrir: depois da primeira troca o Linux passa a responder "<caminho> (deleted)" para este processo.
    exe: Option<PathBuf>,
    state: State,
}

pub struct Handle(pub Entity<Updater>);
impl Global for Handle {}

/// Cria o indicador e começa a procurar. A barra do topo o encontra pelo `Handle` global.
pub fn start(runtime: Arc<Runtime>, cx: &mut App) {
    let client = reqwest::Client::builder().timeout(Duration::from_secs(300)).user_agent(concat!("hangar-native/", env!("HANGAR_NATIVE_RELEASE")))
        .build().unwrap_or_default();
    let entity = cx.new(|_| Updater { runtime, client, exe: std::env::current_exe().ok(), state: State::Idle });
    let weak = entity.downgrade();
    cx.spawn(async move |cx| loop {
        let Ok(task) = weak.update(cx, |this, _| { let client = this.client.clone(); this.runtime.spawn(async move { check(&client).await }) }) else { return };
        // Falha de rede ou limite do GitHub não vira aviso na tela: vai para o stderr e a próxima volta tenta de novo.
        match task.await {
            Ok(Ok(found)) => { let _ = weak.update(cx, |this, cx| if matches!(this.state, State::Idle | State::Available(_)) {
                this.state = found.map_or(State::Idle, State::Available);
                cx.notify();
            }); }
            Ok(Err(error)) => eprintln!("procura de atualização do app falhou: {error}"),
            Err(error) => eprintln!("procura de atualização do app interrompida: {error}"),
        }
        cx.background_executor().timer(EVERY).await;
    }).detach();
    cx.set_global(Handle(entity));
}

impl Updater {
    fn run(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let offer = match &self.state { State::Available(o) | State::Failed(o, _) => o.clone(), _ => return };
        self.state = State::Updating;
        cx.notify();
        let task = self.runtime.spawn(install(self.client.clone(), self.exe.clone(), offer.clone()));
        let handle = window.window_handle();
        cx.spawn(async move |this, cx| {
            let result = task.await.unwrap_or_else(|e| Err(e.to_string()));
            let _ = this.update(cx, |this, cx| match result {
                Ok(()) => cx.quit(),
                Err(reason) => {
                    // O motivo não cabe na barra: vai no aviso e fica no tooltip do "Tentar de novo".
                    let _ = handle.update(cx, |_, window, cx| window.push_notification(Notification::error(reason.clone()).id::<Updater>(), cx));
                    this.state = State::Failed(offer, reason);
                    cx.notify();
                }
            });
        }).detach();
    }
}

impl Render for Updater {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let (id, label, tip, color) = match &self.state {
            State::Idle => return div().into_any_element(),
            State::Available(o) => ("topbar-update", tr("app_update_now"), tr("app_update_available").replace("{version}", &o.version), theme::accent()),
            State::Updating => ("topbar-update", tr("app_update_running"), tr("app_update_running"), theme::accent()),
            State::Failed(_, reason) => ("topbar-update-retry", tr("app_update_retry"), reason.clone(), theme::danger()),
        };
        Button::new(id).ghost().small().h(px(26.)).px(px(10.)).rounded_full().border_1().border_color(color)
            .disabled(matches!(self.state, State::Updating))
            .child(div().flex().items_center().gap(px(6.)).text_size(px(12.5))
                .child(Icon::new(IconName::Download).size(px(14.)).text_color(color))
                .child(label))
            .accessibility_label(tip.clone()).tooltip(tip)
            .on_click(cx.listener(|this, _, window, cx| this.run(window, cx)))
            .into_any_element()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    // O glob pode trazer o `test` da gpui, que colide com o atributo padrão; o nome explícito vence o glob.
    use core::prelude::v1::test;

    #[test]
    fn newer_compares_number_by_number() {
        assert!(newer("0.1.0.2540", "0.1.0.2533"));
        assert!(newer("0.1.0.10", "0.1.0.9"));
        assert!(newer("0.2.0.1", "0.1.0.9999"));
        assert!(newer("0.1.0.1", "0.1.0"), "build sem git recebe a release");
        assert!(!newer("0.1.0.2533", "0.1.0.2533"));
        assert!(!newer("0.1.0.2500", "0.1.0.2533"));
        assert!(!newer("lixo", "0.1.0.1"));
        assert!(!newer("0.1.0.1", "2026.09.27-abc"));
    }

    #[test]
    fn sha256_matches_known_digest() {
        assert_eq!(sha256_hex(b"abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    }
}
