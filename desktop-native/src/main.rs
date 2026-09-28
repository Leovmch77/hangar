// Sem isto o Windows abre um console preto junto da janela. O build de desenvolvimento fica com ele, para ver o stderr.
#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]
mod api;
mod app;
mod appearance;
mod cards;
mod chat;
mod composer;
mod conversation;
mod delivery;
mod editdiff;
mod fileicons;
mod i18n;
mod interaction;
mod media;
mod effects;
mod electron;
mod mend;
mod motion;
mod term_view;
mod status;
mod tables;
mod ws;
mod theme;
mod ui_map;
mod update;
use gpui_kit::{component::{Root, Theme, ThemeMode}, *};
use std::{borrow::Cow, sync::Arc};

gpui_kit::assets::icon_assets!(ExtraIcons, [ArrowUp, GitBranch, RotateCcwClock, Paperclip, Plug, SquareSlash,
    Activity, Contrast, Droplet, Image, Keyboard, Layers, List, Mic, Monitor, RefreshCw, Server, SlidersHorizontal, Type, Users,
    SquarePen, FilePlus, Wrench, Circle, CircleDashed, ChartColumn, Table, ListChecks, Download, Clock, Languages, Banknote,
    Zap, Rocket, MessageCircle, Key, Pencil, GripVertical, AudioLines, Volume2, Hash, LogOut, Smartphone, FolderTree, ChevronsDownUp, FileCode,
    RotateCcw, CornerDownRight, MessageSquare, Sparkles, CircleAlert, CircleCheck, TriangleAlert]);

pub const HANGAR_MARK: &str = "brand/hangar-mark.svg";
pub const GROUP_GLYPH: &str = "brand/group-glyph.svg";
pub const NO_TERMINAL: &str = "signals/no-terminal.svg";

struct AppAssets;

impl AssetSource for AppAssets {
    fn load(&self, path: &str) -> Result<Option<Cow<'static, [u8]>>> {
        if path == HANGAR_MARK { return Ok(Some(Cow::Borrowed(include_bytes!("../assets/hangar-mark.svg")))); }
        if path == GROUP_GLYPH { return Ok(Some(Cow::Borrowed(include_bytes!("../assets/group-glyph.svg")))); }
        if path == NO_TERMINAL { return Ok(Some(Cow::Borrowed(include_bytes!("../assets/signals/no-terminal.svg")))); }
        match path {
            "providers/claude.svg" => return Ok(Some(Cow::Borrowed(include_bytes!("../assets/providers/claude.svg")))),
            "providers/codex.svg" => return Ok(Some(Cow::Borrowed(include_bytes!("../assets/providers/codex.svg")))),
            "providers/kimi.svg" => return Ok(Some(Cow::Borrowed(include_bytes!("../assets/providers/kimi.svg")))),
            _ => {}
        }
        if let Some(bytes) = fileicons::load(path) { return Ok(Some(Cow::Borrowed(bytes))); }
        if let Some(bytes) = ExtraIcons.load(path)? { return Ok(Some(bytes)); }
        gpui_kit::assets::Assets.load(path)
    }

    fn list(&self, path: &str) -> Result<Vec<SharedString>> {
        let mut paths = gpui_kit::assets::Assets.list(path)?;
        paths.extend(ExtraIcons.list(path)?);
        paths.sort();
        paths.dedup();
        Ok(paths)
    }
}

const FONTS: [&[u8]; 6] = [
    include_bytes!("../assets/fonts/Geist-Regular.ttf"), include_bytes!("../assets/fonts/Geist-Medium.ttf"),
    include_bytes!("../assets/fonts/Geist-SemiBold.ttf"), include_bytes!("../assets/fonts/Geist-Bold.ttf"),
    include_bytes!("../assets/fonts/Geist-Italic.ttf"),
    include_bytes!("../assets/fonts/jetbrains-mono/JetBrainsMono-Regular.ttf"),
];

/// Só para medir: HANGAR_NATIVE_WINDOW=LxA abre a janela nesse tamanho lógico. Sem a variável, 1180×800.
fn window_size() -> Size<Pixels> {
    let parsed = std::env::var("HANGAR_NATIVE_WINDOW").ok().and_then(|v| {
        let (w, h) = v.split_once('x')?;
        Some((w.trim().parse::<f32>().ok()?, h.trim().parse::<f32>().ok()?))
    }).filter(|(w, h)| *w >= 640. && *h >= 480.);
    let (w, h) = parsed.unwrap_or((1180., 800.));
    size(px(w), px(h))
}

/// Pasta de logs do Hangar, a mesma do backend e do shell Electron (`log_paths.base()`).
fn log_dir() -> std::path::PathBuf {
    if cfg!(windows) {
        let root = std::env::var_os("LOCALAPPDATA").map(std::path::PathBuf::from).unwrap_or_else(|| home_dir().join("AppData/Local"));
        root.join("hangar/logs/privado")
    } else {
        home_dir().join(".hangar/logs/privado")
    }
}

fn home_dir() -> std::path::PathBuf {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(std::path::PathBuf::from).unwrap_or_default()
}

/// Aberto pelo lançador, o stderr vai pro nada: sem isto um pânico fecha a janela sem deixar rastro.
fn log_panics() {
    let default = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        use std::io::Write;
        let dir = log_dir();
        let _ = std::fs::create_dir_all(&dir);
        if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(dir.join("native.log")) {
            let when = chrono::Local::now().format("%Y-%m-%d %H:%M:%S");
            let thread = std::thread::current().name().unwrap_or("?").to_owned();
            let _ = writeln!(file, "[{when}] pânico na thread {thread} (v{}): {info}", env!("CARGO_PKG_VERSION"));
        }
        default(info);
    }));
}

fn main() {
    log_panics();
    let runtime = Arc::new(tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().expect("async runtime"));
    // Lida antes da primeira janela: o tema já nasce na escolha salva. Falha de leitura abre no padrão e aparece na tela.
    let appearance_error = match appearance::load() { Ok(value) => { appearance::set(value); None } Err(e) => Some(e) };
    i18n::set_language(appearance::get().language);
    gpui_kit::application().with_assets(AppAssets).run(move |cx| {
        gpui_kit::init(cx);
        // Só para provar: HANGAR_NATIVE_REDUCE_MOTION=1 liga o movimento reduzido onde o sistema não informa.
        if std::env::var_os("HANGAR_NATIVE_REDUCE_MOTION").is_some() { cx.set_reduce_motion(true); }
        Theme::change(ThemeMode::Dark, None, cx);
        if let Err(error) = cx.text_system().add_fonts(FONTS.iter().map(|bytes| Cow::Borrowed(*bytes)).collect()) {
            eprintln!("fonte embutida recusada: {error}");
        }
        theme::sync_kit(None, cx);
        update::start(runtime.clone(), cx);
        cx.open_window(WindowOptions {
            window_bounds: Some(WindowBounds::Windowed(Bounds::centered(None, window_size(), cx))),
            app_id: Some("com.hangar.native".into()),
            titlebar: Some(TitlebarOptions { title: Some("Hangar".into()), ..Default::default() }),
            // A raiz pinta o fundo escolhido; o Vidro troca para Blurred no Windows e no macOS (`refresh_backdrop`).
            window_background: WindowBackgroundAppearance::Transparent,
            // Resposta chegando com o foco no outro monitor anda no ritmo da tela, não a 30 quadros.
            inactive_frame_interval: None,
            ..Default::default()
        }, |window, cx| {
            ui_map::install(window);
            let view = cx.new(|cx| app::Hangar::new(runtime.clone(), appearance_error.clone(), window, cx));
            cx.new(|cx| Root::new(view, window, cx).bg(rgba(0x00000000)))
        }).expect("open native window");
        update::report_alive();
        cx.on_window_closed(|cx, _| { if cx.windows().is_empty() { cx.quit(); } }).detach();
        cx.activate(true);
    });
}
