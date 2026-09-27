# Cópia modificada do gpui-pre-linux 0.3.6

Origem: crate `gpui-pre-linux` 0.3.6 do crates.io, licença Apache-2.0 (`LICENSE-APACHE`).
Entra no build por `[patch.crates-io]` em `desktop-native/Cargo.toml`.

`src/linux/wayland/window.rs` e `src/linux/x11/window.rs` implementam `PlatformWindow::draw_with_damage`, que repassa
ao renderer wgpu a região da cena que mudou desde o último quadro. Portado do PR #62455 de zed-industries/zed
(revisão `d9c29a3`), Apache-2.0. Cada arquivo alterado traz um aviso no cabeçalho.
