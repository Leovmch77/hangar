//! Navegador embutido do painel lateral. Motor por sistema, mesma superfície de chamada:
//! Windows/macOS usam o webview do sistema (wry) como janela filha; Linux, um Chromium sem janela pintado pela GPUI.
//! Windows e Linux falam CDP, e neles o app atende o hangar-preview e a tela remota.
pub mod model;
pub mod preview_fmt;
#[cfg(not(target_os = "macos"))]
pub mod chrome_import;
#[cfg_attr(target_os = "macos", allow(dead_code))]
pub mod control;
#[cfg_attr(target_os = "macos", allow(dead_code))]
pub mod server;
#[cfg_attr(target_os = "macos", allow(dead_code))]
pub mod relay;
#[cfg_attr(target_os = "macos", allow(dead_code))]
pub mod external;
#[cfg(target_os = "windows")]
pub mod cdp;
#[cfg(not(target_os = "macos"))]
pub mod keys;
#[cfg(target_os = "windows")]
pub(crate) mod frames;
/// Mesmo nome nos dois sistemas: uma sessão CDP no pipe do Chromium faz o papel do CDP do WebView2.
#[cfg(target_os = "linux")]
pub mod cdp {
    pub use super::chromium::pipe::Session as Cdp;
}

#[cfg(target_os = "linux")]
mod chromium;
#[cfg(target_os = "linux")]
pub use chromium::{Engine, Warm, carry::take_notice as take_cookie_notice};

#[cfg(any(target_os = "windows", target_os = "macos"))]
mod wry_engine;
#[cfg(any(target_os = "windows", target_os = "macos"))]
pub use wry_engine::Engine;

pub enum Event {
    State(model::PageState),
    /// Quadro novo para desenhar; só o motor que pinta pela GPUI manda.
    // Fica em todo sistema para o `if let` de quem recebe não virar padrão irrefutável.
    #[cfg_attr(not(target_os = "linux"), allow(dead_code))]
    Frame,
    /// Mensagem da página da conversa (`window.hangarHost`), JSON cru no formato do MCP Apps.
    #[cfg_attr(not(target_os = "linux"), allow(dead_code))]
    Host(String),
    /// Clique ou tecla da pessoa dentro da página nativa (Windows): a GPUI não os vê.
    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    UserInput,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Pointer {
    Down,
    Up,
    Move,
}

/// Ponto da tela (px lógicos, relativo à página) em px CSS da página ampliada: com zoom, ela vê `1/zoom` do espaço.
#[cfg_attr(target_os = "macos", allow(dead_code))]
pub fn unzoom(p: gpui_kit::Point<gpui_kit::Pixels>, zoom: f32) -> gpui_kit::Point<gpui_kit::Pixels> {
    let z = if zoom > 0. { zoom } else { 1. };
    gpui_kit::point(gpui_kit::px(f32::from(p.x) / z), gpui_kit::px(f32::from(p.y) / z))
}

#[cfg(test)]
mod tests {
    use super::unzoom;
    use gpui_kit::{point, px};

    #[test]
    fn unzoom_divides_screen_points() {
        assert_eq!(unzoom(point(px(200.), px(100.)), 2.), point(px(100.), px(50.)));
        assert_eq!(unzoom(point(px(200.), px(100.)), 0.5), point(px(400.), px(200.)));
        assert_eq!(unzoom(point(px(7.), px(9.)), 0.), point(px(7.), px(9.)), "zoom inválido não divide por zero");
    }
}
