# Cópia do gpui-pre-wgpu 0.3.7

Origem: crate `gpui-pre-wgpu` 0.3.7 do crates.io, licença Apache-2.0 (`LICENSE-APACHE`).
Entra no build por `[patch.crates-io]` em `desktop-native/Cargo.toml`. Arquivos alterados: `src/wgpu_renderer.rs`,
`src/shaders.wgsl`, `src/gpui_wgpu.rs` e o novo `src/blur_kernel.rs`.

O desfoque de fundo foi portado do zui `18a89af`: kernel, WGSL e renderer wgpu. O renderer intercala as passadas pela ordem da cena, usa `COPY_SRC` na superfície quando disponível ou um alvo copiável intermediário, reutiliza o scratch e o libera após 30 quadros sem desfoque.

O redesenho parcial foi portado do PR #62455 de zed-industries/zed (`d9c29a3`, Apache-2.0): `draw_with_damage` desenha
numa textura que persiste entre quadros, redesenha só as regiões que mudaram (cada draw sob o scissor da região) e copia
a textura para a imagem da swapchain, que precisa aceitar `COPY_DST`; sem isso, volta ao desenho inteiro. Diferente do
Zed, a região que toca o que um desfoque lê cresce até a área inteira dele (incluindo o alcance das amostras das
passadas reduzidas), porque os pixels guardados ali já estão compostos, e desfoque fora das regiões não é refeito.
`GPUI_EXPERIMENTAL_PARTIAL_RENDER=0` (lido no `gpui-pre`) desliga.

Na 0.3.7 o renderer foi dividido em `WgpuRenderer` (superfície) e `WgpuRendererCore` (dispositivo, usado também pelo
renderer headless de teste). O desfoque, o scratch e a textura persistente moram no core e somem com ele; as dimensões
vêm da textura do quadro, não da configuração da superfície. O dano pendente e as flags `COPY_SRC`/`COPY_DST` da
superfície ficam no `WgpuRenderer`.
