# Cópia modificada do gpui-pre 0.3.6

Origem: crate `gpui-pre` 0.3.6 do crates.io, licença Apache-2.0 (`LICENSE-APACHE`).
Entra no build por `[patch.crates-io]` em `desktop-native/Cargo.toml`.

`src/scene.rs` e `src/window.rs` foram modificados pelo Hangar para receber regiões de desfoque do conteúdo já pintado. O mecanismo de ordem, repetição de cenas guardadas e a entrada de pintura foram portados de `zeronsh/zui` na revisão `18a89af`, também Apache-2.0. Cada arquivo alterado traz um aviso no cabeçalho.

O renderer usa essas regiões em uma etapa posterior. Sem suporte no renderer, `paint_backdrop_blur` não muda os pixels; quem chama deve manter um preenchimento translúcido como reserva.

`src/scene_damage.rs` (novo), `src/window.rs`, `src/platform.rs` e `src/scene.rs` foram portados do PR #62455 de
zed-industries/zed (`d9c29a3`, Apache-2.0): a janela compara a cena nova com a anterior, pula a apresentação quando
nada mudou e entrega a região mudada ao renderer (`PlatformWindow::draw_with_damage`). Os desfoques entram na
comparação. Ligado por padrão; `GPUI_EXPERIMENTAL_PRESENT_SKIP=0`, `GPUI_EXPERIMENTAL_PARTIAL_RENDER=0` e
`GPUI_EXPERIMENTAL_ORDER_TOLERANT_DAMAGE=0` desligam cada parte. `src/path_builder.rs` reexporta `LineCap`.

`src/window.rs` e `src/element.rs` também guardam, só enquanto houver um receptor instalado por `Window::set_element_map_sink`, os elementos com id do quadro (`ElementRecord`: caminho de ids, bounds lógicos, visível). Views em cache copiam a faixa junto com os hitboxes. Sem receptor nada é registrado. O app usa isso no mapa de elementos das provas (`HANGAR_NATIVE_UI_MAP`).
