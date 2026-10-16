//! "Escolher elemento" do painel do navegador: liga o modo de inspeção do Chromium, recebe o elemento clicado e o
//! manda ao campo de mensagem da sessão como referência, com a foto recortada como anexo.
use std::rc::Rc;

use super::*;
use crate::browser::control::CdpPage;
use crate::browser::pick::{self as reader, Picked, inspect_mode};
use crate::context_refs::Element;

/// O realce do modo é o do navegador, menos no Linux: o `chrome-headless-shell` não pinta o overlay de inspeção, e lá
/// quem desenha é o painel, por cima do quadro.
const BROWSER_HIGHLIGHT: bool = cfg!(not(target_os = "linux"));

#[derive(Default)]
pub(super) struct Picking {
    /// O modo está ligado: os cliques na página escolhem elemento em vez de chegar a ela.
    pub(super) on: bool,
    /// Muda a cada ligar e desligar: o que volta de um `await` de outra vez do modo não mexe nesta.
    generation: u64,
    /// Shift no último aperto do botão esquerdo na página (Linux): Shift+clique soma e o modo continua.
    #[cfg(target_os = "linux")]
    pub(super) shift: bool,
    /// Caixa sob o mouse em px CSS da área visível (x0, y0, x1, y1), desenhada pelo painel (Linux).
    #[cfg(target_os = "linux")]
    pub(super) hover: Option<[f32; 4]>,
}

/// Shift agora (Windows). O clique vai direto à janela do WebView2, de outro processo: o `GetKeyState` da thread da
/// interface não vê essa tecla, e o `GetAsyncKeyState` lê o teclado de verdade. O evento chega milissegundos depois do
/// clique, com a tecla ainda apertada.
#[cfg(target_os = "windows")]
fn shift_now() -> Option<bool> {
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_SHIFT};
    // SAFETY: só lê o estado da tecla.
    let state = unsafe { GetAsyncKeyState(i32::from(VK_SHIFT.0)) };
    Some(state as u16 & 0x8000 != 0)
}

/// No Linux o Shift vem do evento de mouse da GPUI, guardado no aperto (`Picking::shift`).
#[cfg(target_os = "linux")]
fn shift_now() -> Option<bool> { None }

impl Picking {
    /// Desliga e invalida o que estava em voo; devolve se estava ligado.
    pub(super) fn reset(&mut self) -> bool {
        let was = self.on;
        *self = Picking { generation: self.generation + 1, ..Default::default() };
        was
    }
}

impl BrowserPanel {
    /// Ouvintes do modo de escolha, uma vez por motor: o CDP não tira ouvinte, então eles leem o estado do painel.
    pub(super) fn listen_pick(&mut self, cdp: &Rc<crate::browser::cdp::Cdp>, cx: &mut Context<Self>) {
        self.pick.reset();
        let (picked, picks) = async_channel::unbounded::<(i64, Option<bool>)>();
        let listened = cdp.on("Overlay.inspectNodeRequested", move |p| {
            if let Some(id) = p["backendNodeId"].as_i64() { let _ = picked.try_send((id, shift_now())); }
        });
        if let Err(e) = listened { eprintln!("[nav] evento Overlay.inspectNodeRequested sem ouvinte: {e}"); }
        // O próprio Chromium encerra o modo no Esc que ele trata (foco dentro de um iframe, a página sem o script do
        // Esc): sem ouvir isto, o painel seguiria achando que o modo está ligado.
        let (canceled, cancels) = async_channel::unbounded::<()>();
        let listened = cdp.on("Overlay.inspectModeCanceled", move |_| { let _ = canceled.try_send(()); });
        if let Err(e) = listened { eprintln!("[nav] evento Overlay.inspectModeCanceled sem ouvinte: {e}"); }
        cx.spawn(async move |this, cx| {
            while cancels.recv().await.is_ok() {
                if this.update(cx, |this, cx| this.pick_canceled(cx)).is_err() { break; }
            }
        }).detach();
        // Um elemento por vez, na ordem dos cliques: Shift+cliques seguidos entram na mensagem na mesma ordem.
        cx.spawn(async move |this, cx| {
            while let Ok((id, shift)) = picks.recv().await {
                let job = match this.update(cx, |this, cx| this.picked(shift, cx)) { Ok(job) => job, Err(_) => break };
                let Some((page, url, title)) = job else { continue };
                let result = reader::capture(&page, id, url, title).await;
                if this.update(cx, |this, cx| this.finish_pick(result, cx)).is_err() { break; }
            }
        }).detach();
        #[cfg(target_os = "linux")]
        {
            let (hovered, hovers) = async_channel::unbounded::<i64>();
            let listened = cdp.on("Overlay.nodeHighlightRequested", move |p| {
                if let Some(id) = p["nodeId"].as_i64() { let _ = hovered.try_send(id); }
            });
            if let Err(e) = listened { eprintln!("[nav] evento Overlay.nodeHighlightRequested sem ouvinte: {e}"); }
            // Fraca: o emissor do canal mora no ouvinte, dentro da sessão; segurá-la aqui a manteria viva para sempre.
            let cdp = Rc::downgrade(cdp);
            cx.spawn(async move |this, cx| {
                while let Ok(mut id) = hovers.recv().await {
                    // O mouse andou mais rápido que a medida: só o nó mais novo importa.
                    while let Ok(newer) = hovers.try_recv() { id = newer; }
                    let Some(cdp) = cdp.upgrade() else { break };
                    let model = cdp.call("DOM.getBoxModel", serde_json::json!({"nodeId": id})).await;
                    let rect = model.ok().and_then(|model| reader::quad_bounds(&reader::border(&model))).map(|b| b.map(|v| v as f32));
                    if this.update(cx, |this, cx| if this.pick.on && this.pick.hover != rect { this.pick.hover = rect; cx.notify(); }).is_err() { break; }
                }
            }).detach();
        }
    }

    pub(super) fn toggle_pick(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.pick.on { self.stop_pick(cx) } else { self.start_pick(window, cx) }
    }

    fn start_pick(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(cdp) = self.cdp.clone() else { return };
        self.pick.reset();
        self.pick.on = true;
        let generation = self.pick.generation;
        self.set_agent_picking(true);
        // O Esc tem de chegar a quem cancela: no Linux à raiz do painel, no Windows à página, que o devolve pelo IPC.
        self.focus.focus(window, cx);
        cx.spawn(async move |this, cx| {
            let prepared = async {
                cdp.call("DOM.enable", serde_json::json!({})).await?;
                cdp.call("Overlay.enable", serde_json::json!({})).await?;
                // O realce do Linux mede pelo `nodeId`, que só existe com o documento pedido.
                #[cfg(target_os = "linux")]
                cdp.call("DOM.getDocument", serde_json::json!({"depth": 0})).await?;
                Ok::<_, String>(())
            }.await;
            // Desligado durante os pedidos acima: ligar agora deixaria o modo preso sem o painel saber.
            let on = match prepared {
                Ok(()) if this.read_with(cx, |this, _| this.pick.on && this.pick.generation == generation).unwrap_or(false) => cdp.call("Overlay.setInspectMode", inspect_mode(true, BROWSER_HIGHLIGHT)).await.map(drop),
                other => other,
            };
            let _ = this.update(cx, |this, cx| {
                let mine = this.pick.generation == generation;
                match on {
                    Err(e) if mine => {
                        eprintln!("[nav] modo de escolher elemento nao ligou: {e}");
                        this.pick.reset();
                        this.set_agent_picking(false);
                        this.local_notice = Some(tr("browser_pick_failed").replace("{e}", &e));
                        cx.notify();
                    }
                    // Ligou depois de desligado (o `stop_pick` saiu antes deste pedido): desliga de novo.
                    Ok(()) if !this.pick.on => drop(cdp.call("Overlay.setInspectMode", inspect_mode(false, BROWSER_HIGHLIGHT))),
                    _ => {}
                }
            });
        }).detach();
        cx.notify();
    }

    /// Esc, o botão de novo, clique simples, outra página, painel escondido ou motor refeito.
    pub(super) fn stop_pick(&mut self, cx: &mut Context<Self>) {
        if !self.pick.reset() { return; }
        self.set_agent_picking(false);
        if let Some(cdp) = self.cdp.clone() {
            let off = cdp.call("Overlay.setInspectMode", inspect_mode(false, BROWSER_HIGHLIGHT));
            cx.spawn(async move |_, _| if let Err(e) = off.await { eprintln!("[nav] modo de escolher elemento nao desligou: {e}") }).detach();
        }
        cx.notify();
    }

    /// O Chromium já saiu do modo: só o painel volta, sem pedir de novo.
    fn pick_canceled(&mut self, cx: &mut Context<Self>) {
        if !self.pick.reset() { return; }
        self.set_agent_picking(false);
        cx.notify();
    }

    /// O agente não age na página enquanto a pessoa escolhe: o clique dele viraria a escolha.
    fn set_agent_picking(&self, picking: bool) {
        if let Some(ctl) = &self.controller { ctl.set_picking(picking); }
    }

    /// Elemento clicado no modo: sem Shift o modo acaba aqui, antes da leitura, para o próximo clique já ir à página.
    fn picked(&mut self, shift: Option<bool>, cx: &mut Context<Self>) -> Option<(CdpPage, String, String)> {
        // Evento atrasado de um modo já cancelado.
        if !self.pick.on { return None; }
        #[cfg(target_os = "linux")]
        let shift = shift.unwrap_or(self.pick.shift);
        #[cfg(not(target_os = "linux"))]
        let shift = shift.unwrap_or(false);
        if !shift { self.stop_pick(cx); }
        let cdp = self.cdp.clone()?;
        let page = CdpPage { cdp, executor: cx.background_executor().clone() };
        Some((page, self.page.url.clone().unwrap_or_default(), self.page.title.clone()))
    }

    fn finish_pick(&mut self, result: Result<Picked, String>, cx: &mut Context<Self>) {
        match result {
            Ok(Picked { element, png }) => {
                if let Err(e) = &png { self.local_notice = Some(tr("browser_pick_no_image").replace("{e}", &pick_reason(e))); }
                cx.emit(PanelEvent::Element { key: self.key.clone(), element, png: png.ok() });
            }
            Err(e) => self.local_notice = Some(tr("browser_pick_failed").replace("{e}", &pick_reason(&e))),
        }
        cx.notify();
    }

    pub(super) fn pick_button(&self, ready: bool, cx: &mut Context<Self>) -> Button {
        let (on, tip) = (self.pick.on, tr(if self.pick.on { "browser_pick_cancel" } else { "browser_pick" }));
        chrome::icon_button("browser-pick", IconName::MousePointerClick, tip, cx).selected(on)
            .when(on, |b| b.icon(Icon::new(IconName::MousePointerClick).size(px(16.)).text_color(theme::accent())))
            .disabled(!on && (!ready || self.page.url.is_none() || self.cdp.is_none()))
            .on_click(cx.listener(|this, _, window, cx| this.toggle_pick(window, cx)))
    }

    /// Faixa enquanto o modo está ligado: no Windows o painel não desenha por cima da página, então é ela que diz que
    /// o clique não vai à página.
    pub(super) fn render_pick(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        if !self.pick.on { return None; }
        Some(div().id("browser-pick-strip").flex_shrink_0().flex().items_center().gap_2().px_3().py(px(5.))
            .bg(theme::accent().opacity(0.14)).border_b_1().border_color(theme::accent().opacity(0.4)).text_size(px(12.)).role(Role::Status)
            .child(Icon::new(IconName::MousePointerClick).size(px(14.)).text_color(theme::accent()))
            .child(div().flex_1().min_w_0().whitespace_normal().child(tr("browser_pick_hint")))
            .child(Button::new("browser-pick-stop").outline().small().label(tr("cancel"))
                .on_click(cx.listener(|this, _, _, cx| this.stop_pick(cx))))
            .into_any_element())
    }
}

/// Motivo da falha como a pessoa lê: os conhecidos traduzidos, o resto como o Chromium disse.
fn pick_reason(e: &str) -> String {
    match e {
        reader::TIMEOUT => tr("browser_shot_timeout"),
        reader::OFFSCREEN => tr("browser_pick_offscreen"),
        reader::GONE => tr("browser_pick_gone"),
        e => e.to_owned(),
    }
}

/// Caixa do realce no painel (Linux): inverso do `page_point`, de px CSS da área visível para a tela.
#[cfg(target_os = "linux")]
pub(super) fn hover_bounds(rect: [f32; 4], placed: Bounds<Pixels>, page_scale: f32, zoom: (f32, f32, f32)) -> Bounds<Pixels> {
    let (z, ox, oy) = zoom;
    let s = page_scale / z;
    let at = |x: f32, y: f32| point(placed.origin.x + px((x - ox) / s), placed.origin.y + px((y - oy) / s));
    let (a, b) = (at(rect[0], rect[1]), at(rect[2], rect[3]));
    Bounds::from_corners(a, b)
}

impl Hangar {
    /// O elemento entra no campo de mensagem da sessão aberta como referência, e a foto dele como anexo. Como no print,
    /// troca de sessão no meio descarta. O mesmo elemento escolhido de novo não entra outra vez, nem a foto dele.
    pub(super) fn attach_page_element(&mut self, owner: &str, element: Element, png: Option<Vec<u8>>, cx: &mut Context<Self>) {
        let Some(key) = self.page_composer(owner, "elemento") else { return };
        if self.has_element_ref(&key, &element) { return cx.notify(); }
        let shot = png.and_then(|bytes| self.attach_png(&key, "elemento", bytes));
        self.add_element_ref(&key, element, shot, cx);
    }
}

#[cfg(test)]
mod tests {
    // Sem `super::*`: ele traz o `test` da GPUI, que tomaria o lugar do `#[test]`.
    #[cfg(target_os = "linux")]
    use super::hover_bounds;
    #[cfg(target_os = "linux")]
    use gpui_kit::{Bounds, point, px, size};

    #[cfg(target_os = "linux")]
    #[test]
    fn hover_box_is_the_inverse_of_the_pointer_mapping() {
        let placed = Bounds { origin: point(px(100.), px(50.)), size: size(px(400.), px(300.)) };
        // Sem emulação: px CSS = px do painel.
        assert_eq!(hover_bounds([10., 20., 30., 40.], placed, 1., (1., 0., 0.)),
            Bounds { origin: point(px(110.), px(70.)), size: size(px(20.), px(20.)) });
        // Tela emulada reduzida pela metade e afastada (zoom 0,5, deslocada 8 px na vertical).
        assert_eq!(hover_bounds([10., 28., 30., 48.], placed, 2., (0.5, 0., 8.)),
            Bounds { origin: point(px(102.5), px(55.)), size: size(px(5.), px(5.)) });
    }
}
