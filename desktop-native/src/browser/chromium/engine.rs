//! Navegador do painel no Linux: um alvo do Chromium sem janela por sessão. A página chega como screencast, cada
//! quadro gravado numa textura do device da GPUI, e a entrada do painel vira `Input.*`.
use std::{
    cell::{Cell, RefCell},
    collections::HashSet,
    future::Future,
    pin::pin,
    rc::Rc,
    sync::{
        Arc, Condvar, Mutex, PoisonError,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use base64::Engine as _;
use futures::future::{Either, select};
use gpui_kit::*;
use gpui_wgpu::wgpu;
use serde_json::{Value, json};

use super::{
    launch,
    pipe::{Acker, Browser, CLOSED, Session},
};
use crate::browser::{Event, Pointer, model};

/// Último quadro do screencast, já na GPU.
struct Shown {
    texture: wgpu::Texture,
    device: wgpu::Device,
}

/// Dividido com a thread de leitura do pipe, que só guarda o quadro, e com a que o decodifica: nada passa pela interface.
struct Surface {
    shown: Mutex<Option<Shown>>,
    slot: Mutex<Slot>,
    wake: Condvar,
    /// A textura foi recriada (primeiro quadro, outro tamanho): um desenho guardado ainda aponta para a antiga.
    replaced: AtomicBool,
    events: async_channel::Sender<Event>,
    /// JPEG no painel, PNG nas páginas da conversa.
    format: image::ImageFormat,
    /// Confirma um quadro ao Chromium. Ele só manda o próximo com poucos sem confirmação, então confirmar depois de
    /// desenhar faz a página produzir quadros no ritmo da tela, e nenhum quando a janela não desenha.
    ack: Acker,
}

#[derive(Default)]
struct Slot {
    /// Último quadro chegado (base64 e número para a confirmação): o que chega antes de ele ser decodificado o substitui.
    data: Option<(String, Value)>,
    /// Há um `Event::Frame` que a tela ainda não desenhou: o próximo quadro espera, sem decodificar à toa.
    unseen: bool,
    /// Número do quadro decodificado, confirmado quando a tela o desenhar.
    drawn: Option<Value>,
    /// Quadros trocados antes de decodificar, confirmados junto com o próximo desenho: confirmar na hora liberaria o
    /// Chromium a mandar outro, e ele seguiria a todo vapor com a tela parada.
    owed: Vec<Value>,
    closed: bool,
}

impl Slot {
    /// O quadro a decodificar agora: só o mais recente, e só depois de a tela ter desenhado o anterior.
    fn next(&mut self) -> Option<(String, Value)> { if self.unseen { None } else { self.data.take() } }
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> { m.lock().unwrap_or_else(PoisonError::into_inner) }

/// Só para medir: com `HANGAR_NATIVE_NAV_TRACE` no ambiente, uma linha por segundo no stderr com os quadros que
/// chegaram, os decodificados (e o tempo médio deles) e as pinturas da página.
mod trace {
    use std::sync::{OnceLock, atomic::{AtomicU64, Ordering::Relaxed}};
    pub static ARRIVED: AtomicU64 = AtomicU64::new(0);
    pub static DECODED: AtomicU64 = AtomicU64::new(0);
    pub static DECODE_US: AtomicU64 = AtomicU64::new(0);
    pub static PAINTED: AtomicU64 = AtomicU64::new(0);

    pub fn on() -> bool {
        static ON: OnceLock<bool> = OnceLock::new();
        *ON.get_or_init(|| {
            let on = std::env::var_os("HANGAR_NATIVE_NAV_TRACE").is_some();
            if on {
                let _ = std::thread::Builder::new().name("nav-trace".into()).spawn(|| loop {
                    std::thread::sleep(std::time::Duration::from_secs(1));
                    let (a, d, us, p) = (ARRIVED.swap(0, Relaxed), DECODED.swap(0, Relaxed), DECODE_US.swap(0, Relaxed), PAINTED.swap(0, Relaxed));
                    eprintln!("nav chegaram={a} decodificados={d} decod_ms={:.1} pinturas={p}", if d > 0 { us as f64 / d as f64 / 1000. } else { 0. });
                });
            }
            on
        })
    }

    pub fn add(counter: &AtomicU64, n: u64) { if on() { counter.fetch_add(n, Relaxed); } }
}

impl Surface {
    fn new(events: async_channel::Sender<Event>, format: image::ImageFormat, ack: Acker) -> Arc<Self> {
        let surface = Arc::new(Surface {
            shown: Mutex::new(None), slot: Mutex::default(), wake: Condvar::new(), replaced: AtomicBool::new(false), events, format, ack,
        });
        let worker = surface.clone();
        if let Err(e) = std::thread::Builder::new().name("chromium-frames".into()).spawn(move || worker.decode_loop()) {
            eprintln!("[nav] sem thread para os quadros: {e}");
        }
        surface
    }

    /// Na thread de leitura do pipe: guarda e acorda quem decodifica.
    fn frame(&self, mut params: Value) {
        let id = params["sessionId"].take();
        let Some(Value::String(data)) = params.get_mut("data").map(Value::take) else { return (self.ack)(id) };
        trace::add(&trace::ARRIVED, 1);
        let mut slot = lock(&self.slot);
        if let Some((_, old)) = slot.data.replace((data, id)) { slot.owed.push(old); }
        drop(slot);
        self.wake.notify_one();
    }

    fn decode_loop(&self) {
        // Buffers da thread, reaproveitados de um quadro para o outro: um quadro do painel tem megabytes.
        let (mut bytes, mut pixels) = (Vec::new(), Vec::new());
        loop {
            let (data, id) = {
                let mut slot = lock(&self.slot);
                loop {
                    if slot.closed { return; }
                    if let Some(next) = slot.next() { break next; }
                    slot = self.wake.wait(slot).unwrap_or_else(PoisonError::into_inner);
                }
            };
            let started = std::time::Instant::now();
            match self.upload(&data, &mut bytes, &mut pixels) {
                Ok(()) => {
                    trace::add(&trace::DECODED, 1);
                    trace::add(&trace::DECODE_US, started.elapsed().as_micros() as u64);
                    let mut slot = lock(&self.slot);
                    slot.unseen = true;
                    if let Some(old) = slot.drawn.replace(id) { slot.owed.push(old); }
                    drop(slot);
                    let _ = self.events.try_send(Event::Frame);
                }
                Err(e) => { eprintln!("[nav] quadro do Chromium descartado: {e}"); (self.ack)(id); }
            }
        }
    }

    /// A tela desenhou: confirma o quadro ao Chromium e libera o próximo para decodificar.
    fn seen(&self) {
        let (drawn, owed) = { let mut slot = lock(&self.slot); slot.unseen = false; (slot.drawn.take(), std::mem::take(&mut slot.owed)) };
        if drawn.is_some() { trace::add(&trace::PAINTED, 1); }
        for id in drawn.into_iter().chain(owed) { (self.ack)(id); }
        self.wake.notify_one();
    }

    fn close(&self) {
        lock(&self.slot).closed = true;
        self.wake.notify_one();
    }

    fn upload(&self, data: &str, bytes: &mut Vec<u8>, pixels: &mut Vec<u8>) -> Result<(), String> {
        bytes.clear();
        base64::engine::general_purpose::STANDARD.decode_vec(data, bytes).map_err(|e| e.to_string())?;
        let (width, height) = if self.format == image::ImageFormat::Jpeg {
            use zune_jpeg::{JpegDecoder, zune_core::{bytestream::ZCursor, colorspace::ColorSpace, options::DecoderOptions}};
            let options = DecoderOptions::default().jpeg_set_out_colorspace(ColorSpace::RGBA);
            let mut decoder = JpegDecoder::new_with_options(ZCursor::new(&bytes[..]), options);
            decoder.decode_headers().map_err(|e| e.to_string())?;
            let size = decoder.output_buffer_size().ok_or("quadro JPEG sem tamanho")?;
            pixels.resize(size, 0);
            decoder.decode_into(pixels).map_err(|e| e.to_string())?;
            let info = decoder.info().ok_or("quadro JPEG sem cabeçalho")?;
            (u32::from(info.width), u32::from(info.height))
        } else {
            let rgba = image::load_from_memory_with_format(bytes, self.format).map_err(|e| e.to_string())?.into_rgba8();
            let size = rgba.dimensions();
            *pixels = rgba.into_raw();
            size
        };
        let (device, queue) = gpui_wgpu::WgpuContext::shared_device().ok_or("a GPUI não expôs o device wgpu")?;
        let mut shown = lock(&self.shown);
        // Mesma textura enquanto o tamanho e o device não mudam: a fila do wgpu ordena a escrita depois do último desenho.
        let reuse = shown.as_ref().filter(|s| s.device == device && s.texture.width() == width && s.texture.height() == height);
        if reuse.is_none() { self.replaced.store(true, Ordering::SeqCst); }
        let texture = match reuse {
            Some(s) => s.texture.clone(),
            None => device.create_texture(&wgpu::TextureDescriptor {
                label: Some("navegador"),
                size: wgpu::Extent3d { width, height, depth_or_array_layers: 1 },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: wgpu::TextureFormat::Rgba8Unorm,
                usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
                view_formats: &[],
            }),
        };
        queue.write_texture(
            wgpu::TexelCopyTextureInfo { texture: &texture, mip_level: 0, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All },
            pixels,
            wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(4 * width), rows_per_image: Some(height) },
            wgpu::Extent3d { width, height, depth_or_array_layers: 1 },
        );
        *shown = Some(Shown { texture, device });
        Ok(())
    }
}

/// Início do erro de uma abertura cuja página em branco caiu antes de ficar pronta.
const BORN_DEAD: &str = "page_crashed_at_start";

/// A janela da GPUI não entra: o Chromium não tem janela. Guarda os executores para os eventos do pipe e os prazos.
pub struct Starter {
    executor: ForegroundExecutor,
    background: BackgroundExecutor,
}

/// Mantém o Chromium compartilhado de pé enquanto existir, para a primeira página não esperar o processo nascer.
pub struct Warm { _browser: Rc<Browser> }

/// Resposta do CDP sem travar a interface, com o prazo das chamadas que bloqueavam.
async fn answer<T>(background: &BackgroundExecutor, method: &str, call: impl Future<Output = Result<T, String>>) -> Result<T, String> {
    let timer = background.timer(Duration::from_secs(10));
    match select(pin!(call), pin!(timer)).await {
        Either::Left((reply, _)) => reply,
        Either::Right(_) => Err(format!("{method}: o Chromium nao respondeu")),
    }
}

/// Documento do agente posto direto na página: HTML, largura da coluna e fundo opaco (tema próprio).
type Document = (Rc<str>, f32, Option<(u8, u8, u8)>);

type Publish = Rc<dyn Fn(&dyn Fn(&mut model::PageState))>;

pub struct Engine {
    session: Rc<Session>,
    /// Edita o estado da barra e o manda ao painel se mudou.
    publish: Publish,
    target: String,
    window: i64,
    /// Altura da barra que o Chrome completo sem janela ainda desconta da janela (o shell não tem).
    decoration: f32,
    executor: ForegroundExecutor,
    background: BackgroundExecutor,
    surface: Arc<Surface>,
    placed: Cell<Option<(Size<Pixels>, f32)>>,
    /// Conta os tamanhos pedidos durante um arrasto: só o último, parado por um instante, chega ao Chromium.
    resizes: Rc<Cell<u64>>,
    visible: Rc<Cell<bool>>,
    pressed: Cell<bool>,
    /// A página caiu ou se soltou com o Chromium vivo.
    dead: Rc<Cell<bool>>,
    /// Desenhada no dobro da tela (página e site da conversa).
    double: bool,
    /// Contexto próprio da página da conversa, fechado junto com ela.
    context: Option<String>,
}

impl Engine {
    pub fn available() -> Result<(), String> { launch::find().map(|_| ()) }

    pub fn prepare(_window: &Window, cx: &App) -> Result<Starter, String> {
        Ok(Starter { executor: cx.foreground_executor().clone(), background: cx.background_executor().clone() })
    }

    /// Sobe o Chromium agora, sem esperar ele responder.
    pub fn warm(_window: &Window, cx: &App) -> Result<Warm, String> {
        Browser::shared_async(cx.foreground_executor(), cx.background_executor()).map(|browser| Warm { _browser: browser })
    }
}

impl Starter {
    /// O navegador do painel: sobe o Chromium (se ainda não há um) e abre o alvo desta sessão sem travar a interface.
    pub fn start(self, events: async_channel::Sender<Event>) -> impl Future<Output = Result<Engine, String>> + use<> {
        async move { self.fresh(async |browser| self.open(browser, None, None, events.clone(), true).await).await }
    }

    /// Site de verdade na conversa: o mesmo perfil do painel (cookies e login), navegação livre dentro do site e popup
    /// no próprio alvo, como o painel. Nasce sem travar a interface.
    pub fn start_url(self, url: String, events: async_channel::Sender<Event>) -> impl Future<Output = Result<Engine, String>> + use<> {
        async move {
            let engine = self.fresh(async |browser| self.open(browser, None, None, events.clone(), false).await).await?;
            engine.load(&url);
            Ok(engine)
        }
    }

    /// Página da conversa: alvo num contexto próprio (sem os cookies do painel) e documento posto direto, sem travar a
    /// interface. Sem `background` o fundo é transparente; com ele, opaco nessa cor.
    pub fn start_page(self, html: Rc<str>, width: f32, background: Option<(u8, u8, u8)>, events: async_channel::Sender<Event>)
        -> impl Future<Output = Result<Engine, String>> + use<> {
        async move {
            self.fresh(async |browser| {
                let created = self.browser_call(browser, "Target.createBrowserContext", json!({"disposeOnDetach": true})).await?;
                let context = created["browserContextId"].as_str().ok_or("createBrowserContext sem id")?.to_owned();
                let opened = self.open(browser, Some(context.clone()), Some((html.clone(), width, background)), events.clone(), false).await;
                // Falhou no meio: fechar o contexto fecha junto o alvo que já tenha nascido nele.
                if opened.is_err() { drop(browser.call(None, "Target.disposeBrowserContext", json!({"browserContextId": context}))); }
                opened
            }).await
        }
    }

    /// Abre no Chromium compartilhado e, se ele morreu no meio ou não consegue mais criar página (o zygote caiu e toda
    /// página nova cai ao nascer), descarta esse processo e tenta uma vez num novo. Aberturas simultâneas esperam o mesmo
    /// processo novo: o `shared_async` devolve o que já está subindo.
    async fn fresh(&self, open: impl AsyncFn(&Rc<Browser>) -> Result<Engine, String>) -> Result<Engine, String> {
        let browser = self.browser().await?;
        match open(&browser).await {
            Err(e) if !browser.alive() || e.starts_with(BORN_DEAD) => {
                browser.retire(&e);
                open(&self.browser().await?).await
            }
            opened => opened,
        }
    }

    async fn browser(&self) -> Result<Rc<Browser>, String> {
        let browser = Browser::shared_async(&self.executor, &self.background)?;
        browser.ready().await?;
        Ok(browser)
    }

    async fn browser_call(&self, browser: &Browser, method: &str, params: Value) -> Result<Value, String> {
        answer(&self.background, method, browser.call(None, method, params)).await
    }

    async fn page_call(&self, session: &Session, method: &str, params: Value) -> Result<Value, String> {
        answer(&self.background, method, session.call(method, params)).await
    }

    /// Alvo do painel (`panel`: JPEG na escala da tela) ou da conversa (PNG no dobro). Falhou depois de nascer: o alvo
    /// fecha aqui, que ninguém mais o conhece.
    async fn open(&self, browser: &Rc<Browser>, context: Option<String>, document: Option<Document>, events: async_channel::Sender<Event>,
        panel: bool) -> Result<Engine, String> {
        let mut create = json!({"url": "about:blank", "newWindow": true});
        if let Some(context) = &context { create["browserContextId"] = context.as_str().into(); }
        let created = self.browser_call(browser, "Target.createTarget", create).await?;
        let target = created["targetId"].as_str().ok_or("createTarget sem targetId")?.to_owned();
        browser.own(&target, true);
        browser.close_initial();
        let opened = self.open_target(browser, &target, context, document, events, panel).await;
        if opened.is_err() {
            browser.own(&target, false);
            drop(browser.call(None, "Target.closeTarget", json!({"targetId": target})));
        }
        opened
    }

    async fn open_target(
        &self, browser: &Rc<Browser>, target: &str, context: Option<String>, document: Option<Document>, events: async_channel::Sender<Event>,
        panel: bool,
    ) -> Result<Engine, String> {
        let session = Rc::new(answer(&self.background, "Target.attachToTarget", Session::attach_async(browser, target)).await?);
        // Caiu antes de haver ouvinte (renderer que nem subiu): sem isto o `Page.enable` espera o prazo inteiro.
        if browser.crashed(target) { return Err(format!("{BORN_DEAD}: a pagina caiu ao nascer")); }
        // Ouvintes antes de qualquer espera: a interface segue rodando, e o que a página mandar enquanto nasce (a altura,
        // um pedido pausado) não pode chegar sem dono.
        let state = Rc::new(RefCell::new(model::PageState::default()));
        let surface = Surface::new(events.clone(), image::ImageFormat::Png, browser.acker(session.id()));
        let sink = surface.clone();
        browser.sink(session.id(), Box::new(move |params| sink.frame(params)));
        let dead = Rc::new(Cell::new(false));
        let publish = listen(&session, target, &state, &events, &self.executor, &dead, document.is_some());
        let host = events.clone();
        let _ = session.on("Runtime.bindingCalled", move |params| {
            if params["name"] == "hangarHost" { let _ = host.try_send(Event::Host(params["payload"].as_str().unwrap_or("").to_owned())); }
        });
        // Falhou aqui: quem fecha o alvo é o `open`, o único que chama.
        match self.setup_target(browser, &session, target, &document).await {
            // Página em branco que cai antes de nascer não é a página: é o Chromium que não consegue mais criá-las.
            Err(e) if dead.get() => { surface.close(); Err(format!("{BORN_DEAD}: a pagina caiu ao nascer ({e})")) }
            _ if dead.get() => { surface.close(); Err(format!("{BORN_DEAD}: a pagina caiu ao nascer")) }
            Ok((window, decoration)) => Ok(Engine {
                session, publish, target: target.to_owned(), window, decoration, executor: self.executor.clone(), background: self.background.clone(),
                surface, dead, double: !panel, context, placed: Cell::new(None), resizes: Rc::default(), visible: Rc::default(),
                pressed: Cell::new(false),
            }),
            Err(e) => { surface.close(); Err(e) }
        }
    }

    /// Janela, domínios e documento do alvo; devolve a janela e o desconto da barra.
    async fn setup_target(&self, browser: &Rc<Browser>, session: &Session, target: &str, document: &Option<Document>) -> Result<(i64, f32), String> {
        let window = self.browser_call(browser, "Browser.getWindowForTarget", json!({"targetId": target})).await?["windowId"]
            .as_i64().ok_or("getWindowForTarget sem windowId")?;
        self.page_call(session, "Page.enable", json!({})).await?;
        // Queda do renderer chega só por aqui (`Inspector.targetCrashed`, na sessão da página).
        self.page_call(session, "Inspector.enable", json!({})).await?;
        if let Some((_, _, background)) = &document {
            self.page_call(session, "Runtime.enable", json!({})).await?;
            self.page_call(session, "Runtime.addBinding", json!({"name": "hangarHost"})).await?;
            let (r, g, b, a) = background.map_or((0, 0, 0, 0), |(r, g, b)| (r, g, b, 1));
            self.page_call(session, "Emulation.setDefaultBackgroundColorOverride", json!({"color": {"r": r, "g": g, "b": b, "a": a}})).await?;
        }
        // Várias páginas abertas não disputam o foco: `focus`/`release_focus` contam com isto.
        self.page_call(session, "Emulation.setFocusEmulationEnabled", json!({"enabled": true})).await?;
        // Mesma regra de endereço do painel: só web (http/https sem usuário e senha); o resto não carrega.
        self.page_call(session, "Fetch.enable", json!({"patterns": [{"resourceType": "Document", "requestStage": "Request"}]})).await?;
        let (width, height) = document.as_ref().map_or((1280, 800), |(_, width, _)| (width.round() as i64, 600));
        self.browser_call(browser, "Browser.setWindowBounds", json!({"windowId": window, "bounds": {"width": width, "height": height}})).await?;
        let measured = self.page_call(session, "Runtime.evaluate", json!({"expression": "outerHeight-innerHeight", "returnByValue": true})).await?;
        let decoration = measured["result"]["value"].as_f64().unwrap_or(0.).max(0.) as f32;
        if let Some((html, _, _)) = &document {
            let tree = self.page_call(session, "Page.getFrameTree", json!({})).await?;
            let frame = tree["frameTree"]["frame"]["id"].as_str().unwrap_or_default().to_owned();
            self.page_call(session, "Page.setDocumentContent", json!({"frameId": frame, "html": &**html})).await?;
        }
        Ok((window, decoration))
    }
}

/// Estado da barra (endereço, título, carregando, voltar/avançar), diálogos e janelas novas. `block_documents`:
/// o frame principal não navega para documento nenhum (a página da conversa já nasce com o seu).
fn listen(
    session: &Rc<Session>, target: &str, state: &Rc<RefCell<model::PageState>>, events: &async_channel::Sender<Event>, executor: &ForegroundExecutor,
    dead: &Rc<Cell<bool>>, block_documents: bool,
) -> Publish {
    let publish: Publish = {
        let (state, events) = (state.clone(), events.clone());
        Rc::new(move |edit: &dyn Fn(&mut model::PageState)| {
            let mut page = state.borrow_mut();
            let before = page.clone();
            edit(&mut page);
            if *page != before { let _ = events.try_send(Event::State(page.clone())); }
        })
    };
    let history = {
        let (session, publish, executor) = (Rc::downgrade(session), publish.clone(), executor.clone());
        Rc::new(move || {
            let Some(session) = session.upgrade() else { return };
            let (call, publish) = (session.call("Page.getNavigationHistory", json!({})), publish.clone());
            executor.spawn(async move {
                let Ok(h) = call.await else { return };
                let (index, count) = (h["currentIndex"].as_i64().unwrap_or(0), h["entries"].as_array().map_or(0, Vec::len) as i64);
                publish(&|page| { page.can_back = index > 0; page.can_forward = index + 1 < count; });
            }).detach();
        })
    };
    let main = target.to_owned();
    let (p, h) = (publish.clone(), history.clone());
    let _ = session.on("Page.frameNavigated", move |params| {
        let frame = &params["frame"];
        if !frame["parentId"].is_null() { return; }
        // Página de erro do Chromium: o endereço é o que não abriu (`unreachableUrl`), e o erro da carga fica.
        let failed = frame["unreachableUrl"].as_str().filter(|u| !u.is_empty());
        let url = failed.unwrap_or(frame["url"].as_str().unwrap_or("")).to_owned();
        let keep = failed.is_some();
        // A página de erro de uma navegação bloqueada traz o aviso do bloqueio: ele fica com ela.
        p(&|page| { page.url = Some(url.clone()); page.dialog = None; if !keep { page.error = None; page.notice = None; } });
        h();
    });
    let (p, h, m) = (publish.clone(), history.clone(), main.clone());
    let _ = session.on("Page.navigatedWithinDocument", move |params| {
        if params["frameId"] != m.as_str() { return; }
        let url = params["url"].as_str().unwrap_or("").to_owned();
        p(&|page| page.url = Some(url.clone()));
        h();
    });
    for (event, loading) in [("Page.frameStartedLoading", true), ("Page.frameStoppedLoading", false)] {
        let (p, m) = (publish.clone(), main.clone());
        let _ = session.on(event, move |params| if params["frameId"] == m.as_str() { p(&|page| page.loading = loading) });
    }
    let (weak, p, m) = (Rc::downgrade(session), publish.clone(), main.clone());
    let _ = session.on("Fetch.requestPaused", move |params| {
        let Some(session) = weak.upgrade() else { return };
        let (id, url) = (params["requestId"].clone(), params["request"]["url"].as_str().unwrap_or("").to_owned());
        // `Aborted` deixa a página onde está; `BlockedByClient` a trocaria pela tela de erro do Chromium.
        if block_documents && params["frameId"] == m.as_str() {
            return drop(session.call("Fetch.failRequest", json!({"requestId": id, "errorReason": "Aborted"})));
        }
        if model::allowed_request(&url) { return drop(session.call("Fetch.continueRequest", json!({"requestId": id}))); }
        drop(session.call("Fetch.failRequest", json!({"requestId": id, "errorReason": "BlockedByClient"})));
        // Bloqueio é aviso, não tela de falha: tentar de novo bloquearia de novo.
        if params["frameId"] == m.as_str() {
            let text = crate::i18n::tr("browser_blocked").replace("{url}", &url);
            p(&|page| { page.notice = Some(text.clone()); page.notice_seq += 1; });
        }
    });
    // O diálogo fica aberto até alguém responder: o agente (verbo `dialog`) ou a pessoa (caixa do painel). Testar
    // um "Excluir? OK/Cancelar" exige escolher. Só o `beforeunload` passa sozinho: sem isso a navegação travaria.
    let (weak, p) = (Rc::downgrade(session), publish.clone());
    let _ = session.on("Page.javascriptDialogOpening", move |params| {
        let kind = params["type"].as_str().unwrap_or("").to_owned();
        if kind == "beforeunload" {
            if let Some(session) = weak.upgrade() { drop(session.call("Page.handleJavaScriptDialog", json!({"accept": true}))); }
            return;
        }
        let dialog = model::Dialog { kind, message: params["message"].as_str().unwrap_or("").chars().take(500).collect(),
            default: params["defaultPrompt"].as_str().unwrap_or("").to_owned() };
        p(&|page| page.dialog = Some(dialog.clone()));
    });
    let p = publish.clone();
    let _ = session.on("Page.javascriptDialogClosed", move |_| p(&|page| page.dialog = None));
    // O download é negado no navegador inteiro (`Browser.setDownloadBehavior`); sem aviso o clique parecia não fazer nada.
    let p = publish.clone();
    let _ = session.on("Page.downloadWillBegin", move |params| {
        let file = params["suggestedFilename"].as_str().filter(|f| !f.is_empty()).or(params["url"].as_str()).unwrap_or("").to_owned();
        let text = crate::i18n::tr("browser_download_denied").replace("{file}", &file);
        p(&|page| { page.notice = Some(text.clone()); page.notice_seq += 1; });
    });
    let (p, m) = (publish.clone(), main.clone());
    session.watch("Target.targetInfoChanged", move |params| {
        let info = &params["targetInfo"];
        if info["targetId"] == m.as_str() {
            let title = info["title"].as_str().unwrap_or("").to_owned();
            // Sem título o Chromium devolve o endereço; a barra mostra o nome do app nesse caso.
            let title = if info["url"].as_str() == Some(title.as_str()) { String::new() } else { title };
            p(&|page| page.title = title.clone());
        }
    });
    // O nativo não tem abas: link com `target=_blank` e `window.open` abrem nesta mesma página. Página que nenhum
    // navegador do app abriu (popup `noopener`, sem dono) fecha: sem painel, ninguém veria o JS dela rodando.
    let (weak, m, closing) = (Rc::downgrade(session), main.clone(), Rc::new(RefCell::new(HashSet::<String>::new())));
    for event in ["Target.targetCreated", "Target.targetInfoChanged"] {
        let (weak, m, closing) = (weak.clone(), m.clone(), closing.clone());
        session.watch(event, move |params| {
            let info = &params["targetInfo"];
            let Some(id) = info["targetId"].as_str() else { return };
            let Some(session) = weak.upgrade() else { return };
            let browser = session.browser();
            let (opener, url) = (info["openerId"].as_str().unwrap_or(""), info["url"].as_str().unwrap_or(""));
            // Sem opener só nasce do `createTarget` de outra sessão do app, que o anuncia antes de responder e de marcá-lo
            // como dela: fechá-lo derrubava a abertura dela e o Chromium inteiro. Popup, mesmo `noopener`, traz o opener.
            if info["type"] != "page" || opener.is_empty() || browser.owns(id) { return; }
            let mine = opener == m;
            // Aberta por esta página: espera o endereço chegar. Por outra do app: o navegador dela cuida.
            if (mine && (url.is_empty() || url == "about:blank")) || (!mine && browser.owns(opener)) { return; }
            if !closing.borrow_mut().insert(id.to_owned()) { return; }
            if mine { drop(session.call("Page.navigate", json!({"url": url}))); }
            drop(browser.call(None, "Target.closeTarget", json!({"targetId": id})));
        });
    }
    session.watch("Target.targetDestroyed", move |params| { if let Some(id) = params["targetId"].as_str() { closing.borrow_mut().remove(id); } });
    let p = publish.clone();
    session.watch(CLOSED, move |_| p(&|page| { page.loading = false; page.dialog = None; page.error = Some(crate::i18n::tr("browser_err_closed")); }));
    // A página caiu com o Chromium vivo: sem isto o painel congela no último quadro, calado.
    let fell: Rc<dyn Fn(&str, &Value)> = {
        let (weak, p, dead) = (Rc::downgrade(session), publish.clone(), dead.clone());
        Rc::new(move |event, params| {
            if dead.replace(true) { return; }
            eprintln!("[nav] a pagina caiu ({event} {params})");
            if let Some(session) = weak.upgrade() { session.fail_pending(); }
            p(&|page| { page.loading = false; page.dialog = None; page.error = Some(crate::i18n::tr("browser_err_crashed")); });
        })
    };
    // Renderer morto por fora (sem zygote) só manda `Inspector.detached`, e o `Page.enable` pendente nunca responde.
    for event in ["Inspector.targetCrashed", "Inspector.detached"] {
        let f = fell.clone();
        let _ = session.on(event, move |params| f(event, &params));
    }
    for (event, key, id) in [("Target.targetCrashed", "targetId", main.clone()), ("Target.detachedFromTarget", "sessionId", session.id().to_owned())] {
        let f = fell.clone();
        session.watch(event, move |params| { if params[key] == id.as_str() { f(event, &params); } });
    }
    publish
}

impl Engine {
    pub fn alive(&self) -> bool { self.session.browser().alive() && !self.dead.get() }

    /// A sessão do painel, para o controlador do hangar-preview.
    pub fn cdp(&self) -> Rc<Session> { self.session.clone() }

    /// O pipe e a página visível desta sessão, para o cliente CDP de fora (`/cdp/browser`).
    pub fn port(&self) -> (super::pipe::Port, String) { (self.session.browser().port(), self.target.clone()) }

    /// Sessão própria para a tela remota do celular: o screencast dela tem o tamanho do aparelho, sem mexer no do painel.
    pub fn viewer_session(&self) -> impl Future<Output = Result<Rc<Session>, String>> + use<> {
        let (attach, background) = (Session::attach_async(self.session.browser(), &self.target), self.background.clone());
        async move {
            let session = answer(&background, "Target.attachToTarget", attach).await?;
            answer(&background, "Page.enable", session.call("Page.enable", json!({}))).await?;
            Ok(Rc::new(session))
        }
    }

    fn send(&self, method: &str, params: Value) { drop(self.session.call(method, params)); }

    /// Roda um script na página sem esperar o resultado.
    pub fn evaluate(&self, expression: &str) { self.send("Runtime.evaluate", json!({"expression": expression})); }

    pub fn load(&self, url: &str) {
        let (call, publish, target) = (self.session.call("Page.navigate", json!({"url": url})), self.publish.clone(), url.to_owned());
        self.executor.spawn(async move {
            // Falha de rede: o Chromium mostra a página de erro dele, e a barra o motivo.
            // ABORTED = a página não saiu do lugar (download, 204, navegação trocada por outra); BLOCKED_BY_CLIENT já
            // virou aviso no `Fetch.requestPaused`. Nenhum dos dois traz página de erro que limpe o erro depois.
            let error = match call.await {
                Ok(r) => r["errorText"].as_str().filter(|e| !e.is_empty() && !e.ends_with("ERR_ABORTED") && !e.ends_with("ERR_BLOCKED_BY_CLIENT"))
                    .map(|e| crate::browser::model::load_error(e, &target)),
                Err(e) => Some(crate::browser::model::load_error(&e, &target)),
            };
            if let Some(error) = error { publish(&|page| { page.loading = false; page.error = Some(error.clone()); }); }
        }).detach();
    }

    pub fn back(&self) { self.history_step(-1); }
    pub fn forward(&self) { self.history_step(1); }
    pub fn reload(&self) { self.send("Page.reload", json!({})); }
    pub fn stop(&self) { self.send("Page.stopLoading", json!({})); }

    /// Responde o diálogo aberto; o `javascriptDialogClosed` tira a caixa do painel.
    pub fn answer_dialog(&self, accept: bool, text: Option<&str>) -> impl std::future::Future<Output = Result<(), String>> + 'static + use<> {
        let mut params = json!({"accept": accept});
        if let Some(text) = text { params["promptText"] = text.into(); }
        let call = self.session.call("Page.handleJavaScriptDialog", params);
        async move { call.await.map(|_| ()) }
    }

    fn history_step(&self, step: i64) {
        let (call, session) = (self.session.call("Page.getNavigationHistory", json!({})), Rc::downgrade(&self.session));
        self.executor.spawn(async move {
            let Ok(h) = call.await else { return };
            let index = h["currentIndex"].as_i64().unwrap_or(0) + step;
            let Some(entry) = usize::try_from(index).ok().and_then(|i| h["entries"].get(i)) else { return };
            if let Some(session) = session.upgrade() { drop(session.call("Page.navigateToHistoryEntry", json!({"entryId": entry["id"]}))); }
        }).detach();
    }

    /// Chamado na pintura da página, a cada quadro visível.
    pub fn place(&self, bounds: Bounds<Pixels>, window: &mut Window) {
        let scale = window.scale_factor();
        let (w, h) = (f32::from(bounds.size.width), f32::from(bounds.size.height));
        // A página da conversa é desenhada no dobro da tela e reduzida pela GPU: em 1x o Chromium sem janela só suaviza o
        // texto em cinza (o fundo é transparente) e ela sai com cara de vídeo em baixa resolução ao lado do texto do app.
        let frame_scale = if self.double { (scale * 2.).ceil() } else { scale };
        let resized = self.placed.get() != Some((bounds.size, scale));
        let first = !self.visible.replace(true);
        if resized { self.placed.set(Some((bounds.size, scale))); }
        if first || resized {
            let fit = Fit { session: self.session.clone(), window: self.window, decoration: self.decoration, double: self.double, w, h, frame_scale };
            let turn = self.resizes.get() + 1;
            self.resizes.set(turn);
            if first {
                // O tamanho aplicado antes de esconder pode ter ficado para trás (ajuste pendente descartado).
                fit.apply(true);
            } else {
                // Durante um arrasto o quadro antigo estica até o painel; o Chromium só recebe o tamanho em que ele parou.
                let (resizes, visible, timer) = (self.resizes.clone(), self.visible.clone(), self.background.timer(Duration::from_millis(RESIZE_SETTLE_MS)));
                self.executor.spawn(async move { timer.await; if resizes.get() == turn && visible.get() { fit.apply(true); } }).detach();
            }
        }
        // Antes de ler: um quadro que chegue no meio ainda avisa a tela.
        self.surface.seen();
        let device = gpui_wgpu::WgpuContext::shared_device().map(|(device, _)| device);
        let shown = {
            let mut latest = lock(&self.surface.shown);
            if latest.as_ref().is_some_and(|s| Some(&s.device) != device.as_ref()) { *latest = None; }
            latest.as_ref().map(|s| s.texture.clone())
        };
        // Esticado até o painel: durante um resize o quadro do tamanho antigo cobre tudo até chegar o do novo.
        if let Some(texture) = shown { window.paint_surface(pixel_aligned(bounds, &texture, scale, frame_scale), Arc::new(texture)); }
    }

    /// A tela desenhou o último quadro: o próximo já pode ser decodificado.
    pub fn frame_seen(&self) { self.surface.seen(); }

    /// A textura mudou desde a última pergunta: um desenho guardado ainda mostraria a antiga.
    pub fn texture_replaced(&self) -> bool { self.surface.replaced.swap(false, Ordering::SeqCst) }

    /// Página fora da tela: sem screencast e sem a textura na GPU. O controlador cuida do tamanho dela para o `shot`.
    pub fn hide(&self) {
        if self.visible.replace(false) { self.send("Page.stopScreencast", json!({})); }
        *lock(&self.surface.shown) = None;
    }

    /// `at` relativo à origem da página, em px lógicos. Botão esquerdo, sem modificador.
    pub fn pointer(&self, kind: Pointer, at: Point<Pixels>, clicks: usize) { self.mouse(kind, MouseButton::Left, at, clicks, &Modifiers::default()) }

    /// Qualquer botão, com os modificadores. O `clickCount` da soltura repete o do aperto: sem ele o Chromium não
    /// dispara `dblclick`. Arrasto só se acompanha com o esquerdo.
    pub fn mouse(&self, kind: Pointer, button: MouseButton, at: Point<Pixels>, clicks: usize, modifiers: &Modifiers) {
        let (x, y) = (f32::from(at.x) as f64, f32::from(at.y) as f64);
        let (name, bit) = match button { MouseButton::Right => ("right", 2), MouseButton::Middle => ("middle", 4), _ => ("left", 1) };
        let left = name == "left";
        let (kind, button, buttons, clicks) = match kind {
            Pointer::Down => { if left { self.pressed.set(true) } ("mousePressed", name, bit, clicks.max(1)) }
            Pointer::Up => { if left { self.pressed.set(false) } ("mouseReleased", name, 0, clicks.max(1)) }
            Pointer::Move if self.pressed.get() => ("mouseMoved", "left", 1, 0),
            Pointer::Move => ("mouseMoved", "none", 0, 0),
        };
        self.send("Input.dispatchMouseEvent", json!({"type": kind, "x": x, "y": y, "button": button, "buttons": buttons,
            "clickCount": clicks, "modifiers": modifier_bits(modifiers)}));
    }

    /// `delta` em px lógicos; `delta.y > 0` avança a página. Quem chama já inverteu o sinal da GPUI.
    pub fn wheel(&self, at: Point<Pixels>, delta: Point<Pixels>) { self.scroll(at, delta, &Modifiers::default()) }

    /// Com modificadores: Ctrl+roda é zoom da página e Shift+roda rola de lado.
    pub fn scroll(&self, at: Point<Pixels>, delta: Point<Pixels>, modifiers: &Modifiers) {
        self.send("Input.dispatchMouseEvent", json!({
            "type": "mouseWheel", "x": f32::from(at.x), "y": f32::from(at.y),
            "deltaX": f32::from(delta.x), "deltaY": f32::from(delta.y), "button": "none", "modifiers": modifier_bits(modifiers),
        }));
    }

    pub fn key(&self, down: bool, keystroke: &Keystroke) {
        if let Some(event) = key_event(down, keystroke) { self.send("Input.dispatchKeyEvent", event); }
    }

    pub fn insert_text(&self, text: &str) { self.send("Input.insertText", json!({"text": text})); }

    /// A página finge estar sempre focada (`setFocusEmulationEnabled`): o foco do painel não precisa ir a ela.
    pub fn focus(&self, _focused: bool) {}
    pub fn release_focus(&self) {}
}

const RESIZE_SETTLE_MS: u64 = 120;

/// Tamanho e escala da página no painel, e como pedir ao Chromium.
struct Fit { session: Rc<Session>, window: i64, decoration: f32, double: bool, w: f32, h: f32, frame_scale: f32 }

impl Fit {
    fn apply(&self, resized: bool) {
        let Fit { session, window, decoration, double, w, h, frame_scale } = self;
        if resized {
            let size = json!({"width": w.round() as i64, "height": (h + decoration).round() as i64});
            drop(session.browser().call(None, "Browser.setWindowBounds", json!({"windowId": window, "bounds": size})));
            // Só a janela nova não muda a página no Chromium sem janela, e depois de redimensionar o quadro chegava no
            // tamanho antigo, esticado; em tela 1,25 sem a densidade dela o quadro também era esticado. Com layout pedido
            // pelo agente o tamanho é dele, e nem se guarda este: aí o painel recebe a tela emulada encaixada, não a sua.
            let viewport = &session.viewport;
            if !viewport.held.get() {
                let (width, height) = (w.round() as u32, h.round() as u32);
                viewport.panel.set(Some((width, height, *frame_scale)));
                drop(session.call("Emulation.setDeviceMetricsOverride", json!({
                    "width": width, "height": height, "deviceScaleFactor": frame_scale, "mobile": false,
                })));
            }
        }
        let (pw, ph) = ((w * frame_scale).round() as i64, (h * frame_scale).round() as i64);
        // PNG: o painel tem que mostrar a página como o navegador mostra; JPEG borrava o texto.
        let params = json!({"format": "png", "maxWidth": pw.max(1), "maxHeight": ph.max(1), "everyNthFrame": 1});
        drop(session.call("Page.startScreencast", params));
    }
}

/// Retângulo em pixels inteiros da tela, do tamanho do quadro: posição ou largura fracionada faz a GPU reamostrar a
/// textura inteira e o texto da página perde a nitidez.
fn pixel_aligned(bounds: Bounds<Pixels>, texture: &wgpu::Texture, scale: f32, frame_scale: f32) -> Bounds<Pixels> {
    let snap = |v: Pixels| px((f32::from(v) * scale).round() / scale);
    let origin = point(snap(bounds.origin.x), snap(bounds.origin.y));
    let fits = (texture.width() as f32 - f32::from(bounds.size.width) * frame_scale).abs() <= 2. * frame_scale
        && (texture.height() as f32 - f32::from(bounds.size.height) * frame_scale).abs() <= 2. * frame_scale;
    // Durante um resize o quadro antigo ainda tem outro tamanho: aí ele estica até o painel, como antes.
    let size = if fits { size(snap(px(texture.width() as f32 / frame_scale)), snap(px(texture.height() as f32 / frame_scale))) }
        else { size(snap(bounds.size.width), snap(bounds.size.height)) };
    Bounds { origin, size }
}

impl Drop for Engine {
    fn drop(&mut self) {
        self.surface.close();
        self.session.browser().own(&self.target, false);
        drop(self.session.browser().call(None, "Target.closeTarget", json!({"targetId": self.target})));
        if let Some(context) = &self.context {
            drop(self.session.browser().call(None, "Target.disposeBrowserContext", json!({"browserContextId": context})));
        }
    }
}

/// Tecla da GPUI → `Input.dispatchKeyEvent`. Texto digitado vence, para "ç"/"ã" de tecla morta; tecla morta ainda
/// compondo (sem texto) não vai à página.
fn modifier_bits(m: &Modifiers) -> u8 {
    [(m.alt, 1), (m.control, 2), (m.platform, 4), (m.shift, 8)].iter().filter(|(on, _)| *on).fold(0, |a, (_, b)| a | b)
}

/// `code` e `keyCode` da pontuação como no teclado americano, que é o que o Chromium reporta sem saber a tecla
/// física: atalho de página que lê `e.code`/`e.keyCode` ("/" para buscar, "-" para diminuir) volta a funcionar.
fn punctuation(c: char) -> Option<(&'static str, u32)> {
    Some(match c {
        ';' | ':' => ("Semicolon", 186), '=' | '+' => ("Equal", 187), ',' | '<' => ("Comma", 188), '-' | '_' => ("Minus", 189),
        '.' | '>' => ("Period", 190), '/' | '?' => ("Slash", 191), '`' | '~' => ("Backquote", 192), '[' | '{' => ("BracketLeft", 219),
        '\\' | '|' => ("Backslash", 220), ']' | '}' => ("BracketRight", 221), '\'' | '"' => ("Quote", 222),
        '!' => ("Digit1", 49), '@' => ("Digit2", 50), '#' => ("Digit3", 51), '$' => ("Digit4", 52), '%' => ("Digit5", 53),
        '^' => ("Digit6", 54), '&' => ("Digit7", 55), '*' => ("Digit8", 56), '(' => ("Digit9", 57), ')' => ("Digit0", 48),
        _ => return None,
    })
}

fn key_event(down: bool, keystroke: &Keystroke) -> Option<Value> {
    let m = &keystroke.modifiers;
    let modifiers = modifier_bits(m);
    let typed = keystroke.key_char.as_deref().filter(|_| !m.control && !m.alt).and_then(single_char).filter(|c| !c.is_control());
    let named = match keystroke.key.as_str() {
        "enter" => Some("Enter"), "backspace" => Some("Backspace"), "delete" => Some("Delete"), "escape" => Some("Escape"),
        "tab" => Some("Tab"), "left" => Some("ArrowLeft"), "up" => Some("ArrowUp"), "right" => Some("ArrowRight"),
        "down" => Some("ArrowDown"), "home" => Some("Home"), "end" => Some("End"), "pageup" => Some("PageUp"),
        "pagedown" => Some("PageDown"), "space" => Some("Space"), _ => None,
    };
    // Espaço digitado vai como texto; a tabela só o usa sem texto.
    let mut event = if let Some(name) = named.filter(|n| *n != "Space" || typed.is_none()) {
        crate::browser::preview_fmt::key_event(name)
    } else if let Some(c) = typed {
        let text = c.to_string();
        let upper = c.to_ascii_uppercase();
        let (code, vk) = match c {
            _ if upper.is_ascii_alphabetic() => (format!("Key{upper}"), upper as u32),
            _ if c.is_ascii_digit() => (format!("Digit{c}"), c as u32),
            ' ' => ("Space".into(), 32),
            _ => punctuation(c).map_or((String::new(), 0), |(code, vk)| (code.into(), vk)),
        };
        json!({"key": text, "code": code, "text": text, "unmodifiedText": text, "windowsVirtualKeyCode": vk})
    } else if m.control || m.alt {
        // Ctrl/Alt + letra: atalho da página (Ctrl+A, Ctrl+Z), sem texto.
        let c = single_char(&keystroke.key)?;
        let upper = c.to_ascii_uppercase();
        // O próprio caractere como código virtual erra a pontuação: "." é 46, o Delete, e Ctrl+. apagava a palavra.
        let (code, vk) = if upper.is_ascii_alphabetic() || upper.is_ascii_digit() {
            (if upper.is_ascii_alphabetic() { format!("Key{upper}") } else { format!("Digit{upper}") }, upper as u32)
        } else {
            punctuation(c).map_or((String::new(), 0), |(code, vk)| (code.into(), vk))
        };
        json!({"key": c.to_string(), "code": code, "windowsVirtualKeyCode": vk})
    } else {
        return None;
    };
    event["type"] = (if down { "keyDown" } else { "keyUp" }).into();
    event["modifiers"] = modifiers.into();
    if !down || m.control || m.alt {
        let object = event.as_object_mut()?;
        object.remove("text");
        object.remove("unmodifiedText");
    }
    Some(event)
}

fn single_char(text: &str) -> Option<char> {
    let mut chars = text.chars();
    let c = chars.next()?;
    chars.next().is_none().then_some(c)
}

#[cfg(test)]
mod tests {
    // Sem `super::*`: o glob da gpui_kit traz um `test` próprio que sombreia o `#[test]` da std.
    use super::{Keystroke, Modifiers, Slot, key_event};
    use serde_json::json;

    #[test]
    fn only_the_latest_frame_is_decoded_after_the_last_one_was_drawn() {
        let mut slot = Slot::default();
        let frame = |d: &str| Some((d.to_owned(), serde_json::Value::Null));
        slot.data = frame("a");
        slot.data = frame("b");
        assert_eq!(slot.next().map(|f| f.0).as_deref(), Some("b"), "o quadro trocado antes de decodificar não volta");
        slot.unseen = true;
        slot.data = frame("c");
        slot.data = frame("d");
        assert_eq!(slot.next(), None, "quadro anterior ainda não desenhado: espera");
        slot.unseen = false;
        assert_eq!(slot.next().map(|f| f.0).as_deref(), Some("d"));
        assert_eq!(slot.next(), None);
    }

    /// Prova de ponta a ponta com o Chromium da máquina e a GPUI sem janela, num perfil e num HOME descartáveis:
    /// processo morto (SIGSEGV) e processo doente (sem zygote, toda página nova cai ao nascer) são trocados pela
    /// abertura seguinte, e aberturas simultâneas sobem um processo só.
    #[test]
    #[ignore = "sobe o Chromium da máquina"]
    fn a_dead_or_sick_chromium_is_replaced_by_the_next_open() {
        use std::{cell::RefCell, rc::Rc, time::{Duration, Instant}};
        super::launch::find().unwrap();
        let home = std::env::temp_dir().join(format!("hangar-relaunch-{}", std::process::id()));
        std::fs::create_dir_all(&home).unwrap();
        // SAFETY: antes de qualquer outra thread; o Chromium já foi achado com o HOME de verdade.
        unsafe { std::env::set_var("XDG_CONFIG_HOME", home.join("config")); std::env::set_var("HOME", &home); }
        let outcome: Rc<RefCell<Option<Result<(), String>>>> = Rc::default();
        let out = outcome.clone();
        gpui_kit::platform::headless().run(move |cx| {
            let (executor, background) = (cx.foreground_executor().clone(), cx.background_executor().clone());
            let starter = move || super::Starter { executor: executor.clone(), background: background.clone() };
            cx.spawn(async move |cx| {
                *out.borrow_mut() = Some(scenario(starter).await);
                let _ = cx.update(|cx| cx.quit());
            }).detach();
        });
        let native_log = std::fs::read_to_string(home.join(".hangar/logs/privado/native.log")).unwrap_or_default();
        let _ = std::fs::remove_dir_all(&home);
        outcome.take().expect("o cenario nao terminou").unwrap();
        // A queda vai ao diário com o sinal e o fim do chromium.log; o fim do doente vai como descarte, não queda. Sem
        // zygote o doente às vezes aborta sozinho antes do descarte, e aí o fim dele é queda de verdade.
        let (exits, retired) = (native_log.matches("chromium_exited").count(), native_log.matches("Chromium descartado").count());
        assert_eq!((exits + retired, retired <= 1), (2, true), "{native_log}");
        assert!(native_log.contains("(sinal 11); fim do chromium.log:") && native_log.contains("Received signal 11"), "{native_log}");

        async fn scenario(starter: impl Fn() -> super::Starter) -> Result<(), String> {
            let check = |ok: bool, what: String| if ok { Ok(()) } else { Err(what) };
            let pid = |e: &super::Engine| e.session.browser().pid().unwrap_or(0);
            let (events, _kept) = async_channel::unbounded();
            let first = starter().start(events.clone()).await?;
            let old = pid(&first);
            let hanging = first.cdp().call("Runtime.evaluate", json!({"expression": "new Promise(() => {})", "awaitPromise": true}));
            // SAFETY: o Chromium que este teste subiu.
            unsafe { libc::kill(old as i32, libc::SIGSEGV); }
            let crashed = Instant::now();
            let failed = hanging.await.err().ok_or("a chamada pendente nao falhou")?;
            check(failed.contains("chromium_exited") && failed.contains("sinal 11"), format!("erro da chamada pendente: {failed}"))?;
            check(crashed.elapsed() < Duration::from_secs(5), format!("pendente falhou em {:?}", crashed.elapsed()))?;
            check(!first.alive(), "o motor do Chromium morto segue vivo".into())?;
            let (a, b) = futures::join!(starter().start(events.clone()), starter().start(events.clone()));
            let (a, b) = (a?, b?);
            eprintln!("refeito {:?} depois da queda", crashed.elapsed());
            check(crashed.elapsed() < Duration::from_secs(10), format!("refeito em {:?}", crashed.elapsed()))?;
            check(pid(&a) == pid(&b) && pid(&a) != old, format!("aberturas simultaneas: {} e {} (antigo {old})", pid(&a), pid(&b)))?;
            // Doente: sem zygote o processo segue de pé, mas toda página nova cai ao nascer.
            let sick = pid(&a);
            for entry in std::fs::read_dir("/proc").map_err(|e| e.to_string())?.flatten() {
                let Ok(stat) = std::fs::read_to_string(entry.path().join("stat")) else { continue };
                let parent = stat.rsplit(')').next().and_then(|r| r.split_whitespace().nth(1)).and_then(|p| p.parse::<u32>().ok());
                let cmdline = std::fs::read(entry.path().join("cmdline")).unwrap_or_default();
                if parent == Some(sick) && cmdline.windows(13).any(|w| w == b"--type=zygote")
                    && let Some(zygote) = entry.file_name().to_str().and_then(|p| p.parse::<i32>().ok()) {
                    // SAFETY: filho do Chromium que este teste subiu.
                    unsafe { libc::kill(zygote, libc::SIGKILL); }
                }
            }
            let asked = Instant::now();
            let c = starter().start(events.clone()).await?;
            eprintln!("doente trocado em {:?}", asked.elapsed());
            check(pid(&c) != sick && c.alive(), format!("abertura no Chromium doente: pid {} (doente {sick})", pid(&c)))?;
            check(asked.elapsed() < Duration::from_secs(10), format!("troca do doente em {:?}", asked.elapsed()))?;
            check(!a.alive() && !b.alive(), "motores do Chromium descartado seguem vivos".into())?;
            Ok(())
        }
    }

    /// Duas sessões no mesmo Chromium: a página que a segunda abre não é popup de ninguém, e a primeira não a fecha (o
    /// que derrubava a abertura, descartava o processo e levava junto a página da primeira).
    #[test]
    #[ignore = "sobe o Chromium da máquina"]
    fn a_second_session_opens_beside_the_first_in_the_same_chromium() {
        use std::{cell::RefCell, rc::Rc, time::Duration};
        super::launch::find().unwrap();
        let home = std::env::temp_dir().join(format!("hangar-second-{}", std::process::id()));
        std::fs::create_dir_all(&home).unwrap();
        // SAFETY: antes de qualquer outra thread; o Chromium já foi achado com o HOME de verdade.
        unsafe { std::env::set_var("XDG_CONFIG_HOME", home.join("config")); std::env::set_var("HOME", &home); }
        let outcome: Rc<RefCell<Option<Result<(), String>>>> = Rc::default();
        let out = outcome.clone();
        gpui_kit::platform::headless().run(move |cx| {
            let (executor, background) = (cx.foreground_executor().clone(), cx.background_executor().clone());
            let starter = move || super::Starter { executor: executor.clone(), background: background.clone() };
            cx.spawn(async move |cx| {
                *out.borrow_mut() = Some(scenario(starter).await);
                let _ = cx.update(|cx| cx.quit());
            }).detach();
        });
        let _ = std::fs::remove_dir_all(&home);
        outcome.take().expect("o cenario nao terminou").unwrap();

        async fn scenario(starter: impl Fn() -> super::Starter) -> Result<(), String> {
            let pid = |e: &super::Engine| e.session.browser().pid().unwrap_or(0);
            let (events, _kept) = async_channel::unbounded();
            let first = starter().start(events.clone()).await?;
            let old = pid(&first);
            for round in 0..3 {
                let second = starter().start(events.clone()).await?;
                // O fechamento indevido chega depois da resposta: dá tempo dele aparecer.
                starter().background.timer(Duration::from_millis(500)).await;
                if !(first.alive() && second.alive() && pid(&second) == old) {
                    return Err(format!("rodada {round}: primeira viva {}, segunda viva {}, pid {} (antes {old})",
                        first.alive(), second.alive(), pid(&second)));
                }
            }
            // Popup `noopener` de página do app segue fechando: ele traz o opener, que o filtro acima exige.
            let browser = first.session.browser();
            let (born, gone): (Rc<RefCell<Vec<(String, String)>>>, Rc<RefCell<Vec<String>>>) = (Rc::default(), Rc::default());
            let b = born.clone();
            browser.watch("teste", "Target.targetCreated", move |p| b.borrow_mut().push((
                p["targetInfo"]["targetId"].as_str().unwrap_or("").into(), p["targetInfo"]["openerId"].as_str().unwrap_or("").into())));
            let g = gone.clone();
            browser.watch("teste", "Target.targetDestroyed", move |p| g.borrow_mut().push(p["targetId"].as_str().unwrap_or("").into()));
            first.cdp().call("Runtime.evaluate", json!({"expression": "window.open('http://127.0.0.1:9/', '_blank', 'noopener')", "userGesture": true})).await?;
            starter().background.timer(Duration::from_secs(2)).await;
            let popup = born.borrow().iter().find(|(id, _)| *id != first.target).cloned().ok_or("o popup nao nasceu")?;
            if popup.1 != first.target || !gone.borrow().contains(&popup.0) {
                return Err(format!("popup {popup:?} (opener esperado {}), fechados {:?}", first.target, gone.borrow()));
            }
            Ok(())
        }
    }

    fn stroke(key: &str, key_char: Option<&str>, control: bool, shift: bool) -> Keystroke {
        Keystroke { modifiers: Modifiers { control, shift, ..Default::default() }, key: key.into(), key_char: key_char.map(Into::into) }
    }

    #[test]
    fn maps_named_keys_text_and_shortcuts() {
        let enter = key_event(true, &stroke("enter", Some("\n"), false, false)).unwrap();
        assert_eq!((enter["key"].as_str(), enter["windowsVirtualKeyCode"].as_u64(), enter["text"].as_str()), (Some("Enter"), Some(13), Some("\r")));
        let up = key_event(false, &stroke("enter", Some("\n"), false, false)).unwrap();
        assert_eq!((up["type"].as_str(), up.get("text")), (Some("keyUp"), None));
        let shift_tab = key_event(true, &stroke("tab", None, false, true)).unwrap();
        assert_eq!((shift_tab["key"].as_str(), shift_tab["modifiers"].as_u64()), (Some("Tab"), Some(8)));
        let cedilla = key_event(true, &stroke("c", Some("ç"), false, false)).unwrap();
        assert_eq!((cedilla["key"].as_str(), cedilla["text"].as_str()), (Some("ç"), Some("ç")));
        let capital = key_event(true, &stroke("a", Some("A"), false, true)).unwrap();
        assert_eq!((capital["text"].as_str(), capital["windowsVirtualKeyCode"].as_u64()), (Some("A"), Some(65)));
        let space = key_event(true, &stroke("space", Some(" "), false, false)).unwrap();
        assert_eq!(space["text"], json!(" "));
        let select_all = key_event(true, &stroke("a", Some("a"), true, false)).unwrap();
        assert_eq!((select_all["code"].as_str(), select_all["modifiers"].as_u64(), select_all.get("text")), (Some("KeyA"), Some(2), None));
        assert_eq!(key_event(true, &stroke("f13", None, false, false)), None);
        // Tecla morta compondo (ABNT2 "~"): nada vai à página até o "ã" chegar.
        assert_eq!(key_event(true, &stroke("'", None, false, false)), None);
    }
}
