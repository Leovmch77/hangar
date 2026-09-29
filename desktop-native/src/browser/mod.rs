//! Navegador embutido do painel lateral. Motor por sistema, mesma superfície de chamada:
//! Windows/macOS usam o webview do sistema (wry) como janela filha; Linux, WPE.
pub mod model;

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "linux")]
pub use linux::Engine;

#[cfg(any(target_os = "windows", target_os = "macos"))]
mod wry_engine;
#[cfg(any(target_os = "windows", target_os = "macos"))]
pub use wry_engine::Engine;

pub enum Event {
    State(model::PageState),
    /// Quadro novo para desenhar; só o motor que pinta pela GPUI manda.
    #[cfg(target_os = "linux")]
    Frame,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Pointer {
    Down,
    Up,
    Move,
}
