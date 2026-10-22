//! Chromium sem janela do servidor: mede a altura da página, guarda o console e tira print.
//! Porta de depuração em vez de pipe: o pipe por fd 3/4 não existe no Windows.
use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;
use std::time::Duration;
use tokio::sync::{Semaphore, SemaphorePermit};
use tokio_tungstenite::tungstenite::{Message, protocol::WebSocketConfig};

use super::Theme;

const DEADLINE: Duration = Duration::from_secs(8);
const STOP_WAIT: Duration = Duration::from_secs(10);
const CONSOLE_MAX: usize = 50;
const LINE_MAX: usize = 500;
static SLOTS: LazyLock<Semaphore> = LazyLock::new(|| Semaphore::new(2));

/// Mesma conta do script `HOST` (theme.rs), para a altura medida aqui bater com a que a página anuncia.
const MEASURE: &str = "(()=>{const d=document.documentElement,b=document.body;\
return Math.ceil(d.scrollHeight>d.clientHeight?d.scrollHeight:Math.max(d.getBoundingClientRect().height,b?b.getBoundingClientRect().height:0))})()";
// Recurso externo que nunca responde segura o `load`: passados 3 s, mede o que já desenhou.
const LOADED: &str = "Promise.race([new Promise(r=>document.readyState===\"complete\"?r():addEventListener(\"load\",()=>r(),{once:true})),\
new Promise(r=>setTimeout(r,3000))])";

/// Uma largura a medir e, com `shot`, a fotografar.
pub struct Job { pub width: u32, pub theme: Theme, pub shot: Option<Shot> }

/// O print dos clientes sai no dobro e transparente, sobre a conversa deles. O do rascunho é o que o modelo lê, sem a
/// conversa atrás: em densidade 1, sobre o fundo da conversa no tema do trabalho, e não conta como medição da coluna.
pub struct Shot { pub path: PathBuf, pub draft: bool }

impl Shot {
    pub fn cache(path: PathBuf) -> Self { Shot { path, draft: false } }
    pub fn draft(path: PathBuf) -> Self { Shot { path, draft: true } }
}
/// `unpainted`: página de tema próprio que não pintou o fundo e ganhou o da reserva (`theme::OWN_FALLBACK`).
pub struct Rendered { pub heights: BTreeMap<u32, u32>, pub console: Vec<ConsoleLine>, pub unpainted: bool }
/// Desenho sem rede: o print recortado, ou o `error` que o próprio script devolveu; `blocked` conta as
/// requisições recusadas.
pub struct Offline { pub drawn: Result<Drawn, String>, pub blocked: u32 }
/// PNG em escala 2 do recorte; `width`/`height` em px CSS.
pub struct Drawn { pub png: Vec<u8>, pub width: u32, pub height: u32 }
/// Lado máximo do recorte em px CSS: em escala 2 fica abaixo dos 16384 px por lado do Skia.
pub const CLIP_MAX: u32 = 8192;
#[derive(Serialize, Clone, Debug)]
pub struct ConsoleLine { pub level: String, pub text: String }
#[derive(Debug)]
pub enum ChromeError { Absent, Failed(&'static str) }
impl ChromeError {
    pub fn status(&self) -> &'static str { match self { ChromeError::Absent => "ausente", ChromeError::Failed(_) => "falhou" } }
    pub fn reason(&self) -> &'static str { match self { ChromeError::Absent => "sem Chromium no servidor", ChromeError::Failed(r) => r } }
}

#[cfg(target_os = "macos")]
const KNOWN: &[&str] = &["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium"];
#[cfg(target_os = "windows")]
const KNOWN: &[&str] = &[r"C:\Program Files\Google\Chrome\Application\chrome.exe", r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"];
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
const KNOWN: &[&str] = &[];
#[cfg(not(target_os = "windows"))]
const ON_PATH: &[&str] = &["google-chrome-stable", "google-chrome", "chromium", "chromium-browser"];
#[cfg(target_os = "windows")]
const ON_PATH: &[&str] = &["chrome.exe", "msedge.exe"];

/// Mesma variável e mesmo baixado do app nativo; depois a marca do `install-chromium.sh`, o PATH e os caminhos fixos.
pub fn find() -> Option<PathBuf> {
    let native = std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".hangar/native"));
    let downloaded = native.as_ref().map(|n| n.join("chromium/chrome-headless-shell"));
    let marker = native.and_then(|n| std::fs::read_to_string(n.join("chromium-ok")).ok());
    let mut known: Vec<PathBuf> = Vec::new();
    if let Some(path) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path) { for n in ON_PATH { known.push(dir.join(n)); } }
    }
    known.extend(KNOWN.iter().map(PathBuf::from));
    // Chrome instalado só para o usuário fica no perfil dele, não em Program Files.
    #[cfg(target_os = "windows")]
    known.extend(std::env::var_os("LOCALAPPDATA").map(|d| PathBuf::from(d).join(r"Google\Chrome\Application\chrome.exe")));
    find_with(std::env::var_os("HANGAR_CHROMIUM"), downloaded, marker.as_deref(), &known)
}

fn find_with(env: Option<OsString>, downloaded: Option<PathBuf>, marker: Option<&str>, known: &[PathBuf]) -> Option<PathBuf> {
    // Pedido explícito e inválido não cai para outro navegador: quem definiu a variável quer saber que errou.
    if let Some(p) = env.map(PathBuf::from) { return p.is_file().then_some(p); }
    downloaded.filter(|p| p.is_file())
        .or_else(|| marker.and_then(marker_path).filter(|p| p.is_file()))
        .or_else(|| known.iter().find(|p| p.is_file()).cloned())
}

/// A marca é `<palavra>: <caminho>`, às vezes seguida de ` (<versão>…)`; as linhas sem caminho não passam no `is_file`.
fn marker_path(text: &str) -> Option<PathBuf> {
    let (_, rest) = text.lines().next()?.split_once(": ")?;
    let path = rest.split_once(" (").map_or(rest, |(p, _)| p).trim();
    (!path.is_empty()).then(|| PathBuf::from(path))
}

pub async fn render(html: &str, jobs: &[Job]) -> Result<Rendered, ChromeError> {
    render_with(find(), html, jobs, false).await
}

pub async fn render_with(bin: Option<PathBuf>, html: &str, jobs: &[Job], own_theme: bool) -> Result<Rendered, ChromeError> {
    run(bin, |url| async move { drive(&url, html, jobs, own_theme).await }).await
}

/// Página sem rede nenhuma (`Fetch` recusa tudo): carrega o `html`, avalia `expression` (promessa que
/// devolve `{clip:{x,y,width,height}}` ou `{error}`) e tira o PNG do recorte, com fundo transparente.
pub async fn render_offline(bin: Option<PathBuf>, html: &str, width: u32, theme: Theme, expression: &str) -> Result<Offline, ChromeError> {
    run(bin, |url| async move { offline(&url, html, width, theme, expression).await }).await
}

/// Vaga, lançamento, prazo e encerramento comuns aos dois caminhos; `work` recebe a URL do CDP.
async fn run<T, F, Fut>(bin: Option<PathBuf>, work: F) -> Result<T, ChromeError>
where F: FnOnce(String) -> Fut, Fut: std::future::Future<Output = Result<T, ChromeError>> {
    let bin = bin.ok_or(ChromeError::Absent)?;
    // A vaga só volta quando o Chrome anterior morre: sem prazo aqui, a fila presa segura quem chega.
    let slot = tokio::time::timeout(DEADLINE, SLOTS.acquire()).await
        .map_err(|_| ChromeError::Failed("fila do navegador do servidor cheia"))?
        .map_err(|_| ChromeError::Failed("fila do navegador fechada"))?;
    let profile = tempfile::tempdir().map_err(|_| ChromeError::Failed("perfil temporário"))?;
    let child = tokio::process::Command::new(&bin)
        .args(["--headless", "--remote-debugging-port=0", "--no-first-run", "--no-default-browser-check", "--hide-scrollbars",
               "--disable-gpu", "--mute-audio", "--font-render-hinting=none"])
        .arg(format!("--user-data-dir={}", profile.path().display()))
        .arg("about:blank")
        .stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .spawn().map_err(|_| ChromeError::Failed("navegador do servidor não subiu"))?;
    let mut running = Running(Some((child, profile, slot)));
    let (child, profile, _) = running.0.as_mut().expect("preenchido até o drop");
    // O prazo cobre só o desenho: no Windows o Chrome leva segundos para morrer depois de desenhar.
    tokio::time::timeout(DEADLINE, async {
        let url = ws_url(profile.path(), child).await?;
        work(url).await
    }).await.unwrap_or(Err(ChromeError::Failed("navegador do servidor passou do prazo")))
}

/// Encerra também quando quem pediu o desenho desiste no meio (cliente que caiu): sem isso a vaga voltaria
/// com o Chrome vivo.
struct Running(Option<(tokio::process::Child, tempfile::TempDir, SemaphorePermit<'static>)>);
impl Drop for Running {
    fn drop(&mut self) {
        if let Some((child, profile, slot)) = self.0.take() { tokio::spawn(shutdown(child, profile, slot)); }
    }
}

/// Encerra a árvore inteira (no Windows os filhos do Chrome sobrevivem ao pai) e só então apaga o perfil,
/// que fica preso enquanto algum deles vive. A vaga da fila só volta aqui: Chrome que não morre segura a fila
/// em vez de acumular.
async fn shutdown(mut child: tokio::process::Child, profile: tempfile::TempDir, slot: SemaphorePermit<'static>) {
    #[cfg(windows)]
    if let Some(pid) = child.id() {
        let kill = tokio::process::Command::new("taskkill").args(["/T", "/F", "/PID", &pid.to_string()])
            .stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null())
            .kill_on_drop(true).status();
        match tokio::time::timeout(STOP_WAIT, kill).await {
            // 128 = o processo já não existe.
            Ok(Ok(status)) if matches!(status.code(), Some(0 | 128)) => {}
            outcome => tracing::warn!(code = "page_chrome_tree_kill_failed", ?outcome, "árvore do navegador do servidor não encerrada"),
        }
    }
    if let Err(e) = child.start_kill() {
        tracing::warn!(code = "page_chrome_kill_failed", io_kind = ?e.kind(), "pedido de parada do navegador do servidor recusado");
    }
    let exited = match tokio::time::timeout(STOP_WAIT, child.wait()).await {
        Ok(r) => r,
        Err(_) => {
            tracing::warn!(code = "page_chrome_still_alive", "navegador do servidor não morreu; a vaga fica presa até ele sair");
            child.wait().await
        }
    };
    match exited {
        Ok(_) => drop(slot),
        Err(e) => {
            tracing::warn!(code = "page_chrome_wait_failed", io_kind = ?e.kind(), "saída do navegador do servidor não confirmada; a vaga fica presa");
            std::mem::forget(slot);
        }
    }
    let mut last = None;
    for _ in 0..10 {
        match tokio::fs::remove_dir_all(profile.path()).await {
            Ok(()) => return,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return,
            Err(e) => { last = Some(e.kind()); tokio::time::sleep(Duration::from_secs(1)).await; }
        }
    }
    tracing::warn!(code = "page_chrome_profile_left", io_kind = ?last, path = %profile.path().display(), "perfil temporário do navegador do servidor não foi apagado");
}

async fn ws_url(profile: &Path, child: &mut tokio::process::Child) -> Result<String, ChromeError> {
    let file = profile.join("DevToolsActivePort");
    for _ in 0..100 {
        if let Ok(Some(_)) = child.try_wait() { return Err(ChromeError::Failed("navegador do servidor morreu na partida")); }
        if let Ok(text) = tokio::fs::read_to_string(&file).await {
            let mut lines = text.lines();
            if let (Some(port), Some(path)) = (lines.next(), lines.next()) { return Ok(format!("ws://127.0.0.1:{port}{path}")); }
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    Err(ChromeError::Failed("navegador do servidor não anunciou a porta"))
}

type Ws = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

struct Cdp { ws: Ws, next_id: u64, console: Vec<ConsoleLine>, blocked: u32 }

impl Cdp {
    async fn send(&mut self, session: Option<&str>, method: &str, params: Value) -> Result<u64, ChromeError> {
        self.next_id += 1;
        let mut msg = json!({"id": self.next_id, "method": method, "params": params});
        if let Some(s) = session { msg["sessionId"] = json!(s); }
        self.ws.send(Message::text(msg.to_string())).await.map_err(|_| ChromeError::Failed("CDP do servidor caiu"))?;
        Ok(self.next_id)
    }

    /// Lê até a resposta do mesmo `id`; no caminho, recusa o que o `Fetch` pausou e guarda o console.
    async fn call(&mut self, session: Option<&str>, method: &str, params: Value) -> Result<Value, ChromeError> {
        let id = self.send(session, method, params).await?;
        loop {
            let msg = self.ws.next().await.ok_or(ChromeError::Failed("CDP do servidor caiu"))?
                .map_err(|_| ChromeError::Failed("CDP do servidor caiu"))?;
            let Message::Text(text) = msg else { continue };
            let Ok(mut v) = serde_json::from_str::<Value>(text.as_str()) else { continue };
            if v["id"].as_u64() == Some(id) {
                if v.get("error").is_some() { return Err(ChromeError::Failed("CDP do servidor recusou um comando")); }
                return Ok(v.get_mut("result").map(Value::take).unwrap_or(Value::Null));
            }
            self.event(&v).await?;
        }
    }

    async fn event(&mut self, v: &Value) -> Result<(), ChromeError> {
        match v["method"].as_str() {
            Some("Fetch.requestPaused") => {
                self.blocked += 1;
                let params = json!({"requestId": v["params"]["requestId"], "errorReason": "BlockedByClient"});
                self.send(v["sessionId"].as_str(), "Fetch.failRequest", params).await?;
            }
            Some(m @ ("Runtime.consoleAPICalled" | "Runtime.exceptionThrown")) if self.console.len() < CONSOLE_MAX => {
                self.console.push(console_line(m, &v["params"]));
            }
            _ => {}
        }
        Ok(())
    }
}

fn console_line(method: &str, p: &Value) -> ConsoleLine {
    let (level, text) = if method == "Runtime.exceptionThrown" {
        let d = &p["exceptionDetails"];
        ("error".to_owned(), d["exception"]["description"].as_str().or(d["text"].as_str()).unwrap_or_default().to_owned())
    } else {
        let text = p["args"].as_array().map(|args| args.iter().map(arg_text).collect::<Vec<_>>().join(" ")).unwrap_or_default();
        (p["type"].as_str().unwrap_or("log").to_owned(), text)
    };
    ConsoleLine { level, text: text.chars().take(LINE_MAX).collect() }
}

fn arg_text(a: &Value) -> String {
    match &a["value"] {
        Value::String(s) => s.clone(),
        Value::Null => a["description"].as_str().or(a["unserializableValue"].as_str())
            .or(a["subtype"].as_str()).or(a["type"].as_str()).unwrap_or_default().to_owned(),
        v => v.to_string(),
    }
}

/// Exceção ou valor que não é número não vira a altura mínima: a página sairia cortada calada.
fn measured(eval: &Value) -> Result<u32, ChromeError> {
    match eval["result"]["value"].as_f64() {
        Some(h) if eval.get("exceptionDetails").is_none() && h.is_finite() => Ok((h as u32).clamp(super::HEIGHT_MIN, super::HEIGHT_MAX)),
        _ => Err(ChromeError::Failed("altura não medida")),
    }
}

/// Abre a aba, recusa o que casar com `blocked` e espera o `html` carregar; devolve o CDP e a sessão da aba.
async fn load(url: &str, html: &str, blocked: &str, transparent: bool) -> Result<(Cdp, String), ChromeError> {
    // Print de página alta em escala 2 passa do limite de quadro padrão do tungstenite.
    let config = WebSocketConfig::default().max_frame_size(None).max_message_size(None);
    let (ws, _) = tokio_tungstenite::connect_async_with_config(url, Some(config), true).await
        .map_err(|_| ChromeError::Failed("CDP do servidor recusou a conexão"))?;
    let mut cdp = Cdp { ws, next_id: 0, console: Vec::new(), blocked: 0 };
    let target = cdp.call(None, "Target.createTarget", json!({"url": "about:blank"})).await?["targetId"].as_str().unwrap_or_default().to_owned();
    let session = cdp.call(None, "Target.attachToTarget", json!({"targetId": target, "flatten": true})).await?["sessionId"].as_str().unwrap_or_default().to_owned();
    let s = Some(session.as_str());
    cdp.call(s, "Page.enable", json!({})).await?;
    cdp.call(s, "Runtime.enable", json!({})).await?;
    cdp.call(s, "Fetch.enable", json!({"patterns": [{"urlPattern": blocked}]})).await?;
    if transparent {
        cdp.call(s, "Emulation.setDefaultBackgroundColorOverride", json!({"color": {"r": 0, "g": 0, "b": 0, "a": 0}})).await?;
    }
    let frame = cdp.call(s, "Page.getFrameTree", json!({})).await?["frameTree"]["frame"]["id"].as_str().unwrap_or_default().to_owned();
    cdp.call(s, "Page.setDocumentContent", json!({"frameId": frame, "html": html})).await?;
    cdp.call(s, "Runtime.evaluate", json!({"expression": LOADED, "awaitPromise": true})).await?;
    Ok((cdp, session))
}

async fn png(cdp: &mut Cdp, s: Option<&str>, clip: Value) -> Result<Vec<u8>, ChromeError> {
    let shot = cdp.call(s, "Page.captureScreenshot", json!({"format": "png", "captureBeyondViewport": true, "clip": clip})).await?;
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD.decode(shot["data"].as_str().unwrap_or("")).map_err(|_| ChromeError::Failed("print inválido"))
}

async fn drive(url: &str, html: &str, jobs: &[Job], own_theme: bool) -> Result<Rendered, ChromeError> {
    // Tema próprio fica com o branco padrão do Chromium: o print mostra a página como foi desenhada.
    let (mut cdp, session) = load(url, html, "file:*", !own_theme).await?;
    let s = Some(session.as_str());
    let unpainted = own_theme && {
        let read = cdp.call(s, "Runtime.evaluate", json!({"expression": "document.documentElement.dataset.hangarFallback===\"1\"", "returnByValue": true})).await?;
        let flag = read["result"]["value"].as_bool();
        if flag.is_none() { tracing::warn!(code = "page_fallback_unread", "marca da reserva de fundo não lida; a página segue sem aviso"); }
        flag.unwrap_or(false)
    };
    let mut heights = BTreeMap::new();
    for job in jobs {
        cdp.call(s, "Emulation.setEmulatedMedia", json!({"features": [{"name": "prefers-color-scheme", "value": job.theme.as_str()}]})).await?;
        // Viewport baixa: com ela alta, `scrollHeight` nunca fica abaixo dela e a página curta mediria alta.
        let draft = job.shot.as_ref().is_some_and(|s| s.draft);
        let density = if draft { 1 } else { 2 };
        cdp.call(s, "Emulation.setDeviceMetricsOverride", json!({"width": job.width, "height": super::HEIGHT_MIN, "deviceScaleFactor": density, "mobile": false})).await?;
        tokio::time::sleep(Duration::from_millis(150)).await;
        let h = cdp.call(s, "Runtime.evaluate", json!({"expression": MEASURE, "returnByValue": true})).await?;
        let height = measured(&h)?;
        if !draft { heights.insert(job.width, height); }
        if let Some(Shot { path, .. }) = &job.shot {
            if !own_theme {
                let (r, g, b, a) = if draft { let (r, g, b) = job.theme.backdrop(); (r, g, b, 1) } else { (0, 0, 0, 0) };
                cdp.call(s, "Emulation.setDefaultBackgroundColorOverride", json!({"color": {"r": r, "g": g, "b": b, "a": a}})).await?;
            }
            let bytes = png(&mut cdp, s, json!({"x": 0, "y": 0, "width": job.width, "height": height, "scale": 1})).await?;
            super::store::write_atomic(path, &bytes).map_err(|_| ChromeError::Failed("print não gravado"))?;
        }
    }
    Ok(Rendered { heights, console: cdp.console, unpainted })
}

async fn offline(url: &str, html: &str, width: u32, theme: Theme, expression: &str) -> Result<Offline, ChromeError> {
    let (mut cdp, session) = load(url, html, "*", true).await?;
    let s = Some(session.as_str());
    // Rede desligada antes do script de quem pede, também para o que o `Fetch` não intercepta (WebSocket).
    // É camada extra sobre a política da página: Chrome que recusar o comando desenha do mesmo jeito.
    let offline = json!({"offline": true, "latency": 0, "downloadThroughput": -1, "uploadThroughput": -1});
    if cdp.call(s, "Network.enable", json!({})).await.is_err() || cdp.call(s, "Network.emulateNetworkConditions", offline).await.is_err() {
        tracing::debug!(code = "page_chrome_offline_refused", "emulação de rede desligada recusada pelo navegador do servidor");
    }
    cdp.call(s, "Emulation.setEmulatedMedia", json!({"features": [{"name": "prefers-color-scheme", "value": theme.as_str()}]})).await?;
    cdp.call(s, "Emulation.setDeviceMetricsOverride", json!({"width": width, "height": super::HEIGHT_MIN, "deviceScaleFactor": 2, "mobile": false})).await?;
    let eval = cdp.call(s, "Runtime.evaluate", json!({"expression": expression, "awaitPromise": true, "returnByValue": true})).await?;
    if eval.get("exceptionDetails").is_some() { return Err(ChromeError::Failed("script do desenho falhou")); }
    let value = &eval["result"]["value"];
    if let Some(error) = value["error"].as_str() { return Ok(Offline { drawn: Err(error.to_owned()), blocked: cdp.blocked }); }
    let (x, y, w, h) = pixel_clip(&value["clip"]).ok_or(ChromeError::Failed("recorte inválido"))?;
    let png = png(&mut cdp, s, json!({"x": x, "y": y, "width": w, "height": h, "scale": 1})).await?;
    Ok(Offline { drawn: Ok(Drawn { png, width: w, height: h }), blocked: cdp.blocked })
}

/// Recorte em px CSS inteiros que cobre o retângulo pedido: em escala 2 o PNG mede o dobro, exato.
fn pixel_clip(clip: &Value) -> Option<(f64, f64, u32, u32)> {
    let [x, y, w, h] = ["x", "y", "width", "height"].map(|k| clip[k].as_f64());
    let (x, y, w, h) = (x?, y?, w?, h?);
    if w <= 0.0 || h <= 0.0 { return None; }
    let (left, top) = (x.floor().max(0.0), y.floor().max(0.0));
    let (w, h) = ((x + w).ceil() - left, (y + h).ceil() - top);
    let max = f64::from(CLIP_MAX);
    (w >= 1.0 && h >= 1.0 && w <= max && h <= max).then_some((left, top, w as u32, h as u32))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn touch(dir: &Path, name: &str) -> PathBuf {
        let p = dir.join(name);
        std::fs::write(&p, "").unwrap();
        p
    }

    #[test]
    fn height_that_is_not_a_number_is_an_error() {
        assert_eq!(measured(&json!({"result": {"value": 512.6}})).unwrap(), 512);
        assert_eq!(measured(&json!({"result": {"value": 10}})).unwrap(), super::super::HEIGHT_MIN);
        for bad in [json!({"result": {"value": null}}), json!({"result": {"type": "undefined"}}),
            json!({"result": {"value": 300}, "exceptionDetails": {"text": "x"}}), json!({"result": {"value": "300"}})] {
            assert_eq!(measured(&bad).unwrap_err().reason(), "altura não medida", "{bad}");
        }
    }

    #[test]
    fn marker_formats_of_the_installer() {
        assert_eq!(marker_path("sistema: /x/chrome\n"), Some(PathBuf::from("/x/chrome")));
        assert_eq!(marker_path("HANGAR_CHROMIUM: /opt/c\n"), Some(PathBuf::from("/opt/c")));
        assert_eq!(marker_path("baixado: /x/chrome (131.0.6778.85)\n"), Some(PathBuf::from("/x/chrome")));
        assert_eq!(marker_path("baixado: /x/chrome (131.0; renovar falhou: sem rede)\n"), Some(PathBuf::from("/x/chrome")));
        assert_eq!(marker_path("sem chromium (aarch64)\n"), None);
    }

    #[test]
    fn env_override_wins() {
        let dir = tempfile::tempdir().unwrap();
        let bin = touch(dir.path(), "chrome");
        let shell = touch(dir.path(), "shell");
        assert_eq!(find_with(Some(bin.clone().into_os_string()), Some(shell), None, &[]), Some(bin));
    }

    #[test]
    fn env_set_but_missing_is_absent() {
        let dir = tempfile::tempdir().unwrap();
        let shell = touch(dir.path(), "shell");
        let known = [touch(dir.path(), "known")];
        assert_eq!(find_with(Some(dir.path().join("nope").into_os_string()), Some(shell), None, &known), None);
    }

    #[test]
    fn downloaded_before_marker() {
        let dir = tempfile::tempdir().unwrap();
        let shell = touch(dir.path(), "shell");
        let sys = touch(dir.path(), "sys");
        let marker = format!("sistema: {}\n", sys.display());
        assert_eq!(find_with(None, Some(shell.clone()), Some(&marker), &[]), Some(shell));
    }

    #[test]
    fn marker_points_to_binary() {
        let dir = tempfile::tempdir().unwrap();
        let bin = touch(dir.path(), "c");
        let known = [touch(dir.path(), "known")];
        let marker = format!("baixado: {} (131.0.6778.85)\n", bin.display());
        assert_eq!(find_with(None, Some(dir.path().join("absent")), Some(&marker), &known), Some(bin));
    }

    #[test]
    fn marker_without_binary_falls_to_known() {
        let dir = tempfile::tempdir().unwrap();
        let known = [dir.path().join("missing"), touch(dir.path(), "known")];
        assert_eq!(find_with(None, None, Some("download falhou: sem rede\n"), &known), Some(known[1].clone()));
    }

    #[test]
    fn nothing_found_is_absent() {
        assert_eq!(find_with(None, None, None, &[]), None);
    }

    #[test]
    fn clip_covers_the_rectangle_in_whole_css_pixels() {
        assert_eq!(pixel_clip(&json!({"x": 0.4, "y": 0, "width": 100.2, "height": 50.5})), Some((0.0, 0.0, 101, 51)));
        assert_eq!(pixel_clip(&json!({"x": -3, "y": 2.5, "width": 10, "height": 10})), Some((0.0, 2.0, 7, 11)));
        for bad in [json!({"x": 0, "y": 0, "width": 0, "height": 10}), json!({"x": 0, "y": 0, "width": "10", "height": 10}),
            json!({"x": 0, "y": 0, "width": 10}), json!({"x": 0, "y": 0, "width": 10, "height": CLIP_MAX + 1}), json!(null)] {
            assert_eq!(pixel_clip(&bad), None, "{bad}");
        }
    }

    #[tokio::test]
    async fn no_binary_is_absent() {
        let r = render_with(None, "<p>x</p>", &[Job { width: 360, theme: Theme::Dark, shot: None }], false).await;
        assert_eq!(r.err().map(|e| e.status()), Some("ausente"));
    }

    #[test]
    fn console_lines_from_cdp_events() {
        let log = console_line("Runtime.consoleAPICalled", &json!({"type": "warning", "args": [{"type": "string", "value": "a"}, {"type": "number", "value": 2}, {"type": "undefined"}]}));
        assert_eq!((log.level.as_str(), log.text.as_str()), ("warning", "a 2 undefined"));
        let exc = console_line("Runtime.exceptionThrown", &json!({"exceptionDetails": {"text": "Uncaught", "exception": {"description": "Error: x"}}}));
        assert_eq!((exc.level.as_str(), exc.text.as_str()), ("error", "Error: x"));
        let long = console_line("Runtime.consoleAPICalled", &json!({"type": "log", "args": [{"type": "string", "value": "é".repeat(900)}]}));
        assert_eq!(long.text.chars().count(), LINE_MAX);
    }

    #[tokio::test(start_paused = true)]
    async fn full_queue_fails_instead_of_waiting_forever() {
        let _held = SLOTS.acquire_many(2).await.unwrap();
        let job = [Job { width: 360, theme: Theme::Dark, shot: None }];
        let r = tokio::time::timeout(Duration::from_secs(60), render_with(Some(PathBuf::from("chrome")), "<p>x</p>", &job, false)).await;
        assert_eq!(r.expect("espera pela vaga sem prazo").err().map(|e| e.reason()), Some("fila do navegador do servidor cheia"));
    }

    /// Alfa do primeiro pixel de um PNG RGBA 8 bits: o primeiro pixel da primeira linha sai cru em qualquer filtro.
    fn corner_alpha(png: &[u8]) -> u8 {
        use std::io::Read as _;
        let (mut at, mut idat) = (8, Vec::new());
        while at + 8 <= png.len() {
            let len = u32::from_be_bytes(png[at..at + 4].try_into().unwrap()) as usize;
            let kind = &png[at + 4..at + 8];
            let data = &png[at + 8..at + 8 + len];
            if kind == b"IHDR" { assert_eq!((data[8], data[9]), (8, 6), "PNG não é RGBA 8 bits"); }
            if kind == b"IDAT" { idat.extend_from_slice(data); }
            at += 12 + len;
        }
        let mut raw = [0u8; 5];
        flate2::read::ZlibDecoder::new(&idat[..]).read_exact(&mut raw).unwrap();
        raw[4]
    }

    /// Mesmo pedido do `html_render`, seguido: no Windows o fim do Chrome anterior não pode comer o prazo do próximo.
    #[tokio::test]
    #[ignore = "sobe o Chrome da máquina"]
    async fn renders_all_widths_back_to_back() {
        let dir = tempfile::tempdir().unwrap();
        let html = super::super::theme::inject("<!doctype html><h1>oi</h1>", true);
        for _ in 0..3 {
            let started = std::time::Instant::now();
            let jobs: Vec<Job> = super::super::WIDTHS.iter()
                .map(|w| Job { width: *w, theme: Theme::Dark, shot: (*w == 728).then(|| Shot::cache(dir.path().join("s.png"))) }).collect();
            let r = render(&html, &jobs).await.unwrap();
            eprintln!("render {:?}", started.elapsed());
            assert_eq!(r.heights.len(), super::super::WIDTHS.len());
        }
    }

    #[tokio::test]
    #[ignore = "sobe o Chrome da máquina"]
    async fn measures_real_page() {
        let dir = tempfile::tempdir().unwrap();
        let shot = dir.path().join("s.png");
        let html = super::super::theme::inject("<!doctype html><div style=\"height:333px\"></div><script>console.error('oi')</script>", true);
        dbg!(find());
        let r = render(&html, &[Job { width: 728, theme: Theme::Dark, shot: Some(Shot::cache(shot.clone())) }]).await.unwrap();
        dbg!(&r.heights, &r.console, &shot);
        assert_eq!(r.heights[&728], 333);
        assert!(r.console.iter().any(|c| c.level == "error" && c.text.contains("oi")));
        let png = std::fs::read(&shot).unwrap();
        assert!(!png.is_empty());
        assert_eq!(corner_alpha(&png), 0, "fundo do print não é transparente");
    }
}
