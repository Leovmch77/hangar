//! WPE WebKit no próprio processo. Uma thread dona do GMainContext padrão roda o WebKit; os quadros saem
//! como DMA-BUF, entram sem cópia no device wgpu do GPUI e são pintados como superfície da página.
mod ffi;

use std::{
    cell::{Cell, OnceCell, RefCell},
    collections::HashMap,
    ffi::{CStr, CString, c_char, c_int, c_uint, c_void},
    fs::File,
    mem::ManuallyDrop,
    os::{
        fd::{BorrowedFd, FromRawFd},
        unix::{ffi::OsStrExt, fs::MetadataExt},
    },
    path::{Path, PathBuf},
    ptr::{null, null_mut},
    sync::{
        Arc, Mutex, PoisonError,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    time::Duration,
};

use gpui_kit::*;
use gpui_wgpu::wgpu;
use grafting::vulkan_dmabuf::{VulkanDmaBufImport, VulkanDmaBufPlane, VulkanDmaBufQueueOwnership, import_dmabuf};

use super::{Event, Pointer, model};
use ffi::{Api, P};

type Texture = Arc<dyn std::any::Any + Send + Sync>;

#[derive(Clone)]
struct Frame {
    texture: Texture,
    width: u32,
    height: u32,
    scale: f32,
}

/// O que a thread do WebKit e a da GPUI dividem.
struct Shared {
    events: async_channel::Sender<Event>,
    frame: Mutex<Option<Frame>>,
    /// Há um `Event::Frame` ainda não pintado: não manda outro, o canal nunca enche.
    frame_pending: AtomicBool,
}

// Um display WPE por processo, e a thread do WebKit vive até o fim dele.
static STARTED: AtomicBool = AtomicBool::new(false);

enum Cmd {
    Load(CString),
    Back,
    Forward,
    Reload,
    Resize { width: c_int, height: c_int, scale: f64 },
    Button { down: bool, x: f64, y: f64, clicks: c_uint },
    Move { x: f64, y: f64, pressed: bool },
    Scroll { x: f64, y: f64, dx: f64, dy: f64 },
    Key { down: bool, keyval: c_uint, mods: c_uint },
    Focus(bool),
    Visible(bool),
}

pub struct Engine {
    api: &'static Api,
    shared: Arc<Shared>,
    /// Tamanho e escala do último resize pedido ao WebKit.
    placed: Cell<Option<(Size<Pixels>, f32)>>,
    visible: Cell<bool>,
    pressed: Cell<bool>,
}

impl Engine {
    pub fn available() -> Result<(), String> { ffi::api().map(|_| ()) }

    pub fn new(_window: &mut Window, events: async_channel::Sender<Event>) -> Result<Self, String> {
        let api = ffi::api()?;
        let (device, queue) = gpui_wgpu::WgpuContext::shared_device().ok_or("a GPUI não expôs o device wgpu")?;
        let host = grafting::HostWgpuContext::new(device, queue);
        if !host.dmabuf_support {
            return Err("o device wgpu não importa DMA-BUF (precisa de Vulkan com as extensões de DMA-BUF)".into());
        }
        if STARTED.swap(true, Ordering::SeqCst) {
            return Err("o navegador WPE já foi aberto neste processo".into());
        }
        let shared = Arc::new(Shared { events, frame: Mutex::new(None), frame_pending: AtomicBool::new(false) });
        let data_dir = crate::appearance::dir().map(|dir| dir.join("browser"));
        let (ready_tx, ready_rx) = mpsc::channel();
        let thread_shared = shared.clone();
        std::thread::Builder::new()
            .name("wpe".into())
            .spawn(move || run(api, host, thread_shared, data_dir, ready_tx))
            .map_err(|e| e.to_string())?;
        ready_rx.recv_timeout(Duration::from_secs(10)).map_err(|_| "o WPE não respondeu ao iniciar".to_string())??;
        Ok(Self { api, shared, placed: Cell::new(None), visible: Cell::new(false), pressed: Cell::new(false) })
    }

    /// Enfileira no contexto da thread do WebKit; nunca roda na thread da GPUI.
    fn post(&self, cmd: Cmd) {
        let api = self.api;
        let data = Box::into_raw(Box::new(cmd)).cast::<c_void>();
        // SAFETY: fonte nova anexada ao contexto padrão (o que a thread do WebKit roda); `run_command` retoma `data`.
        unsafe {
            let source = (api.g_idle_source_new)();
            (api.g_source_set_priority)(source, ffi::G_PRIORITY_DEFAULT);
            (api.g_source_set_callback)(source, run_command as *const c_void, data, null());
            (api.g_source_attach)(source, null_mut());
            (api.g_source_unref)(source);
        }
    }

    pub fn load(&self, url: &str) {
        // `normalize_address` já recusa caractere de controle; um NUL aqui não tem como virar URL.
        if let Ok(url) = CString::new(url) {
            self.post(Cmd::Load(url));
        }
    }
    pub fn back(&self) { self.post(Cmd::Back); }
    pub fn forward(&self) { self.post(Cmd::Forward); }
    pub fn reload(&self) { self.post(Cmd::Reload); }

    /// Chamado na pintura da página, a cada quadro visível.
    pub fn place(&self, bounds: Bounds<Pixels>, window: &mut Window) {
        if !self.visible.replace(true) {
            self.post(Cmd::Visible(true));
        }
        let scale = window.scale_factor();
        if self.placed.get() != Some((bounds.size, scale)) {
            self.placed.set(Some((bounds.size, scale)));
            self.post(Cmd::Resize {
                width: f32::from(bounds.size.width).round() as c_int,
                height: f32::from(bounds.size.height).round() as c_int,
                scale: scale as f64,
            });
        }
        // Zera antes de ler: um quadro que chegue no meio ainda avisa a tela.
        self.shared.frame_pending.store(false, Ordering::SeqCst);
        let frame = self.shared.frame.lock().unwrap_or_else(PoisonError::into_inner).clone();
        if let Some(frame) = frame {
            // No tamanho em que foi renderizado: 1:1, nunca esticado durante um resize.
            let drawn = size(px(frame.width as f32 / frame.scale), px(frame.height as f32 / frame.scale));
            window.with_content_mask(Some(ContentMask { bounds }), |window| {
                window.paint_surface(Bounds::new(bounds.origin, drawn), frame.texture)
            });
        }
    }

    /// Página fora da tela: o WebKit pode segurar a renderização.
    pub fn hide(&self) {
        if self.visible.replace(false) {
            self.post(Cmd::Visible(false));
        }
    }

    /// `at` relativo à origem da página, em px lógicos. Só o botão esquerdo.
    pub fn pointer(&self, kind: Pointer, at: Point<Pixels>, clicks: usize) {
        let (x, y) = (f32::from(at.x) as f64, f32::from(at.y) as f64);
        let cmd = match kind {
            Pointer::Down => {
                self.pressed.set(true);
                Cmd::Button { down: true, x, y, clicks: clicks.max(1) as c_uint }
            }
            Pointer::Up => {
                self.pressed.set(false);
                Cmd::Button { down: false, x, y, clicks: 0 }
            }
            Pointer::Move => Cmd::Move { x, y, pressed: self.pressed.get() },
        };
        self.post(cmd);
    }

    /// `delta` em px lógicos; `delta.y > 0` avança a página (rola rumo ao fim, como a roda girada para baixo).
    /// O `ScrollWheelEvent` da GPUI vem com o sinal oposto: quem chama passa `-delta`.
    pub fn wheel(&self, at: Point<Pixels>, delta: Point<Pixels>) {
        // O WPE usa o sentido do Wayland: positivo sobe o conteúdo.
        self.post(Cmd::Scroll {
            x: f32::from(at.x) as f64,
            y: f32::from(at.y) as f64,
            dx: -f32::from(delta.x) as f64,
            dy: -f32::from(delta.y) as f64,
        });
    }

    pub fn key(&self, down: bool, keystroke: &Keystroke) {
        let Some((key, mods)) = map_key(keystroke) else { return };
        let keyval = match key {
            Key::Sym(sym) => sym,
            // SAFETY: função pura de tabela, sem estado do WebKit.
            Key::Char(c) => unsafe { (self.api.wpe_unicode_to_keyval)(c as u32) },
        };
        self.post(Cmd::Key { down, keyval, mods });
    }

    pub fn focus(&self, focused: bool) { self.post(Cmd::Focus(focused)); }
}

#[derive(Debug, PartialEq)]
enum Key {
    Sym(c_uint),
    Char(char),
}

/// Tecla da GPUI → keyval do WPE (keysym X) + modificadores. Texto digitado vence, para "ç"/"ã" de tecla morta.
fn map_key(keystroke: &Keystroke) -> Option<(Key, c_uint)> {
    let m = &keystroke.modifiers;
    let mods = [
        (m.control, ffi::WPE_MODIFIER_KEYBOARD_CONTROL),
        (m.shift, ffi::WPE_MODIFIER_KEYBOARD_SHIFT),
        (m.alt, ffi::WPE_MODIFIER_KEYBOARD_ALT),
    ]
    .iter()
    .filter(|(on, _)| *on)
    .fold(0, |acc, (_, bit)| acc | bit);
    let typed = keystroke
        .key_char
        .as_deref()
        .filter(|_| !m.control && !m.alt)
        .and_then(single_char)
        .filter(|c| !c.is_control());
    let key = match (typed, keystroke.key.as_str()) {
        (Some(c), _) => Key::Char(c),
        (_, "enter") => Key::Sym(0xff0d),
        (_, "backspace") => Key::Sym(0xff08),
        (_, "delete") => Key::Sym(0xffff),
        (_, "escape") => Key::Sym(0xff1b),
        (_, "tab") => Key::Sym(0xff09),
        (_, "left") => Key::Sym(0xff51),
        (_, "up") => Key::Sym(0xff52),
        (_, "right") => Key::Sym(0xff53),
        (_, "down") => Key::Sym(0xff54),
        (_, "home") => Key::Sym(0xff50),
        (_, "end") => Key::Sym(0xff57),
        (_, "pageup") => Key::Sym(0xff55),
        (_, "pagedown") => Key::Sym(0xff56),
        (_, "space") => Key::Sym(0x20),
        // Ctrl/Alt + letra: a letra pura, o modificador vai à parte.
        (_, name) => Key::Char(single_char(name)?),
    };
    Some((key, mods))
}

fn single_char(text: &str) -> Option<char> {
    let mut chars = text.chars();
    let c = chars.next()?;
    chars.next().is_none().then_some(c)
}

// ---- thread do WebKit

/// Tudo aqui só é tocado pela thread do WebKit.
struct Web {
    api: &'static Api,
    shared: Arc<Shared>,
    web: P,
    view: P,
    host: RefCell<grafting::HostWgpuContext>,
    /// Uma textura por buffer do swapchain do WebKit (chave: inode do dma-buf).
    cache: RefCell<HashMap<u64, (Texture, u32, u32)>>,
    page: RefCell<model::PageState>,
    scale: Cell<f32>,
    import_failed: Cell<bool>,
}

thread_local! {
    static WEB: OnceCell<Web> = const { OnceCell::new() };
}

fn with_web(f: impl FnOnce(&Web)) {
    WEB.with(|cell| {
        if let Some(web) = cell.get() {
            f(web)
        }
    });
}

fn run(
    api: &'static Api,
    host: grafting::HostWgpuContext,
    shared: Arc<Shared>,
    data_dir: Option<PathBuf>,
    ready: mpsc::Sender<Result<(), String>>,
) {
    let started = start(api, host, shared, data_dir.as_deref());
    let ok = started.is_ok();
    let _ = ready.send(started);
    if ok {
        // SAFETY: laço do contexto padrão, nesta thread, até o fim do processo.
        unsafe { (api.g_main_loop_run)((api.g_main_loop_new)(null_mut(), 0)) };
    }
}

fn start(api: &'static Api, host: grafting::HostWgpuContext, shared: Arc<Shared>, data_dir: Option<&Path>) -> Result<(), String> {
    // SAFETY: chamadas na ordem do protótipo C, todas nesta thread; os objetos vivem até o fim do processo.
    let (web, view) = unsafe {
        let display = (api.wpe_display_headless_new)();
        if display.is_null() {
            return Err("o WPE não criou o display headless".into());
        }
        let mut error = null_mut();
        if (api.wpe_display_connect)(display, &mut error) == 0 {
            return Err(format!("o WPE não conectou o display: {}", take_error(api, error)));
        }
        (api.wpe_display_set_primary)(display);
        let session = network_session(api, data_dir);
        let web = (api.g_object_new)(
            (api.webkit_web_view_get_type)(),
            c"display".as_ptr(),
            display,
            c"network-session".as_ptr(),
            session,
            null::<c_char>(),
        );
        if web.is_null() {
            return Err("o WPE não criou a WebView".into());
        }
        let view = (api.webkit_web_view_get_wpe_view)(web);
        if view.is_null() {
            return Err("a WebView do WPE veio sem WPEView".into());
        }
        (web, view)
    };
    let state = Web {
        api,
        shared,
        web,
        view,
        host: RefCell::new(host),
        cache: RefCell::default(),
        page: RefCell::default(),
        scale: Cell::new(1.),
        import_failed: Cell::new(false),
    };
    WEB.with(|cell| {
        let _ = cell.set(state);
    });
    connect(api, view, c"buffer-rendered", on_buffer_rendered as *const c_void);
    connect(api, web, c"notify::uri", on_notify as *const c_void);
    connect(api, web, c"notify::title", on_notify as *const c_void);
    connect(api, web, c"load-changed", on_load_changed as *const c_void);
    connect(api, web, c"load-failed", on_load_failed as *const c_void);
    connect(api, web, c"decide-policy", on_decide_policy as *const c_void);
    // SAFETY: getter da WebView viva.
    let history = unsafe { (api.webkit_web_view_get_back_forward_list)(web) };
    if !history.is_null() {
        connect(api, history, c"changed", on_history_changed as *const c_void);
    }
    Ok(())
}

/// Sessão persistente (logins sobrevivem) ao lado das configurações; sem pasta, efêmera.
fn network_session(api: &Api, data_dir: Option<&Path>) -> P {
    let dirs = data_dir.and_then(|dir| {
        Some((CString::new(dir.as_os_str().as_bytes()).ok()?, CString::new(dir.join("cache").as_os_str().as_bytes()).ok()?))
    });
    // SAFETY: strings C válidas durante a chamada; o WebKit copia.
    unsafe {
        match dirs {
            Some((data, cache)) => (api.webkit_network_session_new)(data.as_ptr(), cache.as_ptr()),
            None => (api.webkit_network_session_new_ephemeral)(),
        }
    }
}

fn connect(api: &Api, instance: P, signal: &CStr, callback: *const c_void) {
    // SAFETY: cada callback tem a assinatura que o sinal emite (conferida no header/gir do sinal).
    unsafe { (api.g_signal_connect_data)(instance, signal.as_ptr(), callback, null_mut(), null(), 0) };
}

fn take_error(api: &Api, error: *mut ffi::GError) -> String {
    if error.is_null() {
        return "erro desconhecido".into();
    }
    // SAFETY: GError devolvido pela GLib, liberado aqui uma vez.
    unsafe {
        let message = text((*error).message).unwrap_or_default();
        (api.g_error_free)(error);
        message
    }
}

fn text(ptr: *const c_char) -> Option<String> {
    // SAFETY: string C terminada em NUL vinda da GLib/WebKit, lida na hora.
    (!ptr.is_null()).then(|| unsafe { CStr::from_ptr(ptr) }.to_string_lossy().into_owned())
}

extern "C" fn run_command(data: P) -> c_int {
    // SAFETY: `data` veio de `Box::into_raw` em `post`, e a fonte idle roda uma vez só.
    let cmd = unsafe { Box::from_raw(data.cast::<Cmd>()) };
    with_web(|web| web.run(*cmd));
    0 // G_SOURCE_REMOVE
}

extern "C" fn on_buffer_rendered(_view: P, buffer: P, _data: P) { with_web(|web| web.frame(buffer)); }

extern "C" fn on_notify(_object: P, _pspec: P, _data: P) { with_web(|web| web.publish(|_| {})); }

extern "C" fn on_history_changed(_list: P, _added: P, _removed: P, _data: P) { with_web(|web| web.publish(|_| {})); }

extern "C" fn on_load_changed(_web: P, event: c_int, _data: P) {
    with_web(|web| {
        web.publish(|page| {
            if event == ffi::WEBKIT_LOAD_STARTED {
                page.error = None;
            }
        })
    });
}

extern "C" fn on_load_failed(_web: P, _event: c_int, _uri: *const c_char, error: *const ffi::GError, _data: P) -> c_int {
    with_web(|web| {
        // SAFETY: o sinal entrega um GError válido durante a chamada.
        let Some(error) = (unsafe { error.as_ref() }) else { return };
        // SAFETY: função sem estado.
        let domain = unsafe { (web.api.webkit_network_error_quark)() };
        // Cancelado = o usuário navegou para outro lugar antes de terminar; não é falha.
        if error.domain == domain && error.code == ffi::WEBKIT_NETWORK_ERROR_CANCELLED {
            return;
        }
        let message = text(error.message).unwrap_or_default();
        web.publish(|page| page.error = Some(message));
    });
    0 // o WebKit mostra a página de erro dele
}

extern "C" fn on_decide_policy(_web: P, decision: P, kind: c_int, _data: P) -> c_int {
    let mut blocked = false;
    if kind == ffi::WEBKIT_POLICY_DECISION_TYPE_NAVIGATION_ACTION {
        with_web(|web| {
            // Mesmo filtro do wry: fora de http(s)/about/blob/data não navega, nem em iframe.
            if !web.request_uri(decision).is_some_and(|uri| model::allowed_request(&uri)) {
                // SAFETY: decisão viva durante o sinal.
                unsafe { (web.api.webkit_policy_decision_ignore)(decision) };
                blocked = true;
            }
        });
    }
    blocked as c_int
}

impl Web {
    fn run(&self, cmd: Cmd) {
        let (api, web, view) = (self.api, self.web, self.view);
        // SAFETY: WebView/WPEView vivos até o fim do processo; esta é a thread dona deles.
        unsafe {
            let time = ((api.g_get_monotonic_time)() / 1000) as u32;
            let event = match cmd {
                Cmd::Load(url) => {
                    (api.webkit_web_view_load_uri)(web, url.as_ptr());
                    null_mut()
                }
                Cmd::Back => {
                    (api.webkit_web_view_go_back)(web);
                    null_mut()
                }
                Cmd::Forward => {
                    (api.webkit_web_view_go_forward)(web);
                    null_mut()
                }
                Cmd::Reload => {
                    (api.webkit_web_view_reload)(web);
                    null_mut()
                }
                Cmd::Resize { width, height, scale } => {
                    let toplevel = (api.wpe_view_get_toplevel)(view);
                    if toplevel.is_null() {
                        eprintln!("navegador WPE: view sem toplevel, resize ignorado");
                    } else {
                        if (api.wpe_toplevel_get_scale)(toplevel) != scale {
                            (api.wpe_toplevel_scale_changed)(toplevel, scale);
                        }
                        (api.wpe_toplevel_resize)(toplevel, width, height);
                        self.scale.set(scale as f32);
                    }
                    null_mut()
                }
                Cmd::Button { down, x, y, clicks } => (api.wpe_event_pointer_button_new)(
                    if down { ffi::WPE_EVENT_POINTER_DOWN } else { ffi::WPE_EVENT_POINTER_UP },
                    view,
                    ffi::WPE_INPUT_SOURCE_MOUSE,
                    time,
                    if down { 0 } else { ffi::WPE_MODIFIER_POINTER_BUTTON1 },
                    ffi::WPE_BUTTON_PRIMARY,
                    x,
                    y,
                    clicks,
                ),
                Cmd::Move { x, y, pressed } => (api.wpe_event_pointer_move_new)(
                    ffi::WPE_EVENT_POINTER_MOVE,
                    view,
                    ffi::WPE_INPUT_SOURCE_MOUSE,
                    time,
                    if pressed { ffi::WPE_MODIFIER_POINTER_BUTTON1 } else { 0 },
                    x,
                    y,
                    0.,
                    0.,
                ),
                Cmd::Scroll { x, y, dx, dy } => {
                    (api.wpe_event_scroll_new)(view, ffi::WPE_INPUT_SOURCE_MOUSE, time, 0, dx, dy, 1, 0, x, y)
                }
                Cmd::Key { down, keyval, mods } => (api.wpe_event_keyboard_new)(
                    if down { ffi::WPE_EVENT_KEYBOARD_KEY_DOWN } else { ffi::WPE_EVENT_KEYBOARD_KEY_UP },
                    view,
                    ffi::WPE_INPUT_SOURCE_KEYBOARD,
                    time,
                    mods,
                    0,
                    keyval,
                ),
                Cmd::Focus(true) => {
                    (api.wpe_view_focus_in)(view);
                    null_mut()
                }
                Cmd::Focus(false) => {
                    (api.wpe_view_focus_out)(view);
                    null_mut()
                }
                Cmd::Visible(visible) => {
                    (api.wpe_view_set_visible)(view, visible as c_int);
                    null_mut()
                }
            };
            if !event.is_null() {
                (api.wpe_view_event)(view, event);
                (api.wpe_event_unref)(event);
            }
        }
    }

    /// Relê a WebView, aplica `edit` e manda o estado se mudou.
    fn publish(&self, edit: impl FnOnce(&mut model::PageState)) {
        let (api, web) = (self.api, self.web);
        // SAFETY: getters da WebView viva, nesta thread.
        let mut next = unsafe {
            model::PageState {
                url: text((api.webkit_web_view_get_uri)(web)),
                title: text((api.webkit_web_view_get_title)(web)).unwrap_or_default(),
                loading: (api.webkit_web_view_is_loading)(web) != 0,
                can_back: (api.webkit_web_view_can_go_back)(web) != 0,
                can_forward: (api.webkit_web_view_can_go_forward)(web) != 0,
                error: None,
            }
        };
        let mut page = self.page.borrow_mut();
        next.error = page.error.clone();
        edit(&mut next);
        if next == *page {
            return;
        }
        *page = next.clone();
        drop(page);
        let _ = self.shared.events.try_send(Event::State(next));
    }

    fn request_uri(&self, decision: P) -> Option<String> {
        let api = self.api;
        // SAFETY: decisão de navegação viva durante o sinal; os getters devolvem ponteiros emprestados.
        unsafe {
            let action = (api.webkit_navigation_policy_decision_get_navigation_action)(decision);
            if action.is_null() {
                return None;
            }
            let request = (api.webkit_navigation_action_get_request)(action);
            if request.is_null() {
                return None;
            }
            text((api.webkit_uri_request_get_uri)(request))
        }
    }

    fn frame(&self, buffer: P) {
        match self.import(buffer) {
            Ok(frame) => {
                self.import_failed.set(false);
                *self.shared.frame.lock().unwrap_or_else(PoisonError::into_inner) = Some(frame);
                if !self.shared.frame_pending.swap(true, Ordering::SeqCst) {
                    let _ = self.shared.events.try_send(Event::Frame);
                }
            }
            Err(error) => {
                if !self.import_failed.replace(true) {
                    eprintln!("navegador WPE: {error}");
                    self.publish(|page| page.error = Some(error));
                }
            }
        }
    }

    fn import(&self, buffer: P) -> Result<Frame, String> {
        let api = self.api;
        // SAFETY: `buffer` é o WPEBuffer do sinal, válido durante a chamada; os fds são emprestados.
        let (width, height, fourcc, modifier, planes) = unsafe {
            if (api.g_type_check_instance_is_a)(buffer, (api.wpe_buffer_dma_buf_get_type)()) == 0 {
                return Err("o WPE entregou um quadro que não é DMA-BUF".into());
            }
            let n = (api.wpe_buffer_dma_buf_get_n_planes)(buffer).min(4);
            let planes: Vec<(c_int, u32, u32)> = (0..n)
                .map(|i| {
                    (
                        (api.wpe_buffer_dma_buf_get_fd)(buffer, i),
                        (api.wpe_buffer_dma_buf_get_offset)(buffer, i),
                        (api.wpe_buffer_dma_buf_get_stride)(buffer, i),
                    )
                })
                .collect();
            (
                (api.wpe_buffer_get_width)(buffer),
                (api.wpe_buffer_get_height)(buffer),
                (api.wpe_buffer_dma_buf_get_format)(buffer),
                (api.wpe_buffer_dma_buf_get_modifier)(buffer),
                planes,
            )
        };
        let (Ok(width), Ok(height)) = (u32::try_from(width), u32::try_from(height)) else {
            return Err(format!("quadro com tamanho inválido {width}x{height}"));
        };
        let first = planes.first().map(|p| p.0).filter(|fd| *fd >= 0).ok_or("quadro DMA-BUF sem plano")?;
        // SAFETY: fd emprestado pelo WebKit durante o sinal; ManuallyDrop impede fechar o dele.
        let inode = ManuallyDrop::new(unsafe { File::from_raw_fd(first) }).metadata().map_err(|e| e.to_string())?.ino();
        self.refresh_host()?;
        let mut cache = self.cache.borrow_mut();
        if let Some((texture, w, h)) = cache.get(&inode)
            && (*w, *h) == (width, height)
        {
            return Ok(Frame { texture: texture.clone(), width, height, scale: self.scale.get() });
        }
        // Buffer novo (primeiro quadro ou swapchain recriado no resize): importa uma vez.
        if cache.len() >= 8 || cache.values().any(|(_, w, h)| (*w, *h) != (width, height)) {
            cache.clear();
        }
        let buffers = planes
            .iter()
            // SAFETY: fd emprestado, válido durante o sinal; o dup é nosso e vai para o import.
            .map(|p| unsafe { BorrowedFd::borrow_raw(p.0) }.try_clone_to_owned().map_err(|e| e.to_string()))
            .collect::<Result<Vec<_>, _>>()?;
        let layout = planes
            .iter()
            .enumerate()
            .map(|(i, p)| VulkanDmaBufPlane { buffer_index: i, offset: p.1 as u64, stride: p.2 as u64 })
            .collect();
        let texture = VulkanDmaBufImport::new(
            dpi::PhysicalSize::new(width, height),
            wgpu::TextureFormat::Bgra8Unorm,
            fourcc,
            modifier,
            buffers,
            layout,
            VulkanDmaBufQueueOwnership::LocalUninitialized,
        )
        .and_then(|import| import_dmabuf(import, &self.host.borrow()))
        .map_err(|e| format!("import do quadro DMA-BUF falhou ({width}x{height}, modifier {modifier:#x}): {e}"))?;
        let texture: Texture = Arc::new(texture);
        cache.insert(inode, (texture.clone(), width, height));
        Ok(Frame { texture, width, height, scale: self.scale.get() })
    }

    /// A GPUI troca o device ao se recuperar de perda de GPU; textura do device antigo não pinta.
    fn refresh_host(&self) -> Result<(), String> {
        let (device, queue) = gpui_wgpu::WgpuContext::shared_device().ok_or("a GPUI perdeu o device wgpu")?;
        if self.host.borrow().device != device {
            self.host.replace(grafting::HostWgpuContext::new(device, queue));
            self.cache.borrow_mut().clear();
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    // Sem `super::*`: o glob da gpui_kit traz um `test` próprio que sombreia o `#[test]` da std.
    use super::{Key, Keystroke, Modifiers, ffi, map_key};

    fn stroke(key: &str, key_char: Option<&str>, control: bool, shift: bool) -> Keystroke {
        Keystroke {
            modifiers: Modifiers { control, shift, ..Default::default() },
            key: key.into(),
            key_char: key_char.map(Into::into),
        }
    }

    #[test]
    fn maps_named_keys_text_and_modifiers() {
        let ctrl = ffi::WPE_MODIFIER_KEYBOARD_CONTROL;
        let shift = ffi::WPE_MODIFIER_KEYBOARD_SHIFT;
        for (keystroke, expected) in [
            (stroke("enter", Some("\n"), false, false), Some((Key::Sym(0xff0d), 0))),
            (stroke("tab", None, false, true), Some((Key::Sym(0xff09), shift))),
            (stroke("backspace", None, false, false), Some((Key::Sym(0xff08), 0))),
            (stroke("pagedown", None, false, false), Some((Key::Sym(0xff56), 0))),
            (stroke("space", Some(" "), false, false), Some((Key::Char(' '), 0))),
            (stroke("a", Some("A"), false, true), Some((Key::Char('A'), shift))),
            (stroke("c", Some("ç"), false, false), Some((Key::Char('ç'), 0))),
            (stroke("a", Some("a"), true, false), Some((Key::Char('a'), ctrl))),
            (stroke("z", None, true, true), Some((Key::Char('z'), ctrl | shift))),
            (stroke("f13", None, false, false), None),
        ] {
            assert_eq!(map_key(&keystroke), expected, "{keystroke:?}");
        }
    }
}
