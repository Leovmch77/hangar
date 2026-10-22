//! Navegador de uma sessão de outra máquina: a tela chega pelo `nav-remoto` do servidor dela, o mesmo canal da tela
//! remota do celular, e clique, roda e tecla voltam por ele. O navegador continua sendo o do app daquela máquina.
use std::{cell::Cell, rc::Rc, time::{Duration, Instant}};

use base64::Engine as _;
use serde_json::{Value, json};

use super::*;
use crate::{api::Api, ws::{self, TextEvent, TextSocket}};

/// Movimento do mouse vai no máximo a cada este tempo: o socket tem fila curta e o outro lado é rede.
const MOVE_EVERY: Duration = Duration::from_millis(40);
/// Largura máxima do quadro pedido, a mesma que o servidor aceita.
const MAX_WIDTH: f32 = 1400.;
/// Tamanho do painel repassado à página no máximo a cada este tempo, enquanto ele é arrastado.
const RESIZE_EVERY: Duration = Duration::from_millis(500);

enum Status { Idle, Connecting, Live, Down(String) }

pub(super) struct RemoteBrowser {
    name: String,
    api: Api,
    token: String,
    runtime: tokio::runtime::Handle,
    socket: Option<TextSocket>,
    status: Status,
    url: Option<String>,
    frame: Option<Arc<RenderImage>>,
    /// Quadro tirado por print: a tela da outra máquina não está compondo a página.
    slow: bool,
    shown: bool,
    focus: FocusHandle,
    bounds: Rc<Cell<Bounds<Pixels>>>,
    scale: Rc<Cell<f32>>,
    last_move: Option<Instant>,
    /// Tamanho do painel já imposto à página da outra máquina, e quando.
    sent_size: Option<((u32, u32), Instant)>,
    /// Recusa da outra máquina ao tamanho pedido.
    notice: Option<String>,
    /// Sobe a cada conexão: evento de uma conexão anterior que chega atrasado é descartado.
    seq: u64,
    _read: Task<()>,
}

impl RemoteBrowser {
    pub(super) fn new(name: String, api: Api, token: String, runtime: tokio::runtime::Handle, cx: &mut Context<Self>) -> Self {
        Self { name, api, token, runtime, socket: None, status: Status::Idle, url: None, frame: None, slow: false, shown: false,
            focus: cx.focus_handle(), bounds: Rc::default(), scale: Rc::new(Cell::new(1.)), last_move: None, sent_size: None, notice: None, seq: 0, _read: Task::ready(()) }
    }

    /// Só conectado enquanto está na tela: o canal aceita um espectador por vez, e fechado ele volta a quem precisar.
    pub(super) fn set_shown(&mut self, shown: bool, cx: &mut Context<Self>) {
        if shown == self.shown { return; }
        self.shown = shown;
        if shown { self.connect(cx) } else { self.disconnect() }
        cx.notify();
    }

    fn disconnect(&mut self) {
        self.seq += 1;
        if let Some(mut socket) = self.socket.take() { socket.close(); }
        self._read = Task::ready(());
        self.status = Status::Idle;
    }

    fn connect(&mut self, cx: &mut Context<Self>) {
        self.disconnect();
        let seq = self.seq;
        let width = f32::from(self.bounds.get().size.width) * self.scale.get();
        let width = if width > 0. { width.min(MAX_WIDTH) } else { MAX_WIDTH };
        let path = format!("/api/sessions/{}/nav-remoto?w={}", self.name, width.round() as u32);
        let socket = TextSocket::open(&self.runtime, &self.api, &path, self.token.clone());
        let events = socket.events();
        self.socket = Some(socket);
        self.status = Status::Connecting;
        (self.sent_size, self.notice) = (None, None);
        self._read = cx.spawn(async move |this, cx| {
            let mut said: Option<String> = None;
            while let Ok(event) = events.recv().await {
                let text = match event {
                    Ok(TextEvent::Connected) => {
                        if this.update(cx, |this, cx| if this.seq == seq { this.status = Status::Live; this.sync_size(); cx.notify(); }).is_err() { return; }
                        continue;
                    }
                    Ok(TextEvent::Text(text)) => text,
                    Ok(TextEvent::Closed) => break,
                    Err(error) => { said.get_or_insert_with(|| failure_text(error)); break; }
                };
                let Ok(msg) = serde_json::from_str::<Value>(&text) else { continue };
                match msg["t"].as_str() {
                    Some("q") => {
                        let (data, slow) = (msg["d"].as_str().unwrap_or("").to_owned(), msg["lento"].as_bool().unwrap_or(false));
                        let image = cx.background_spawn(async move {
                            let bytes = base64::engine::general_purpose::STANDARD.decode(data).ok()?;
                            crate::media::decode(&bytes, 4096, 4096, None)
                        }).await;
                        let Some(image) = image else { continue };
                        let kept = this.update(cx, |this, cx| {
                            if this.seq != seq { return cx.drop_image(image, None); }
                            if let Some(old) = this.frame.replace(image) { cx.drop_image(old, None); }
                            this.slow = slow;
                            this.sync_size();
                            cx.notify();
                        });
                        if kept.is_err() { return; }
                    }
                    Some("url") => {
                        let url = msg["url"].as_str().map(str::to_owned);
                        if this.update(cx, |this, cx| if this.seq == seq { this.url = url; cx.notify(); }).is_err() { return; }
                    }
                    Some("layout") => {
                        let refused = msg["resposta"].as_str().filter(|r| !r.starts_with("layout:")).map(str::to_owned);
                        if this.update(cx, |this, cx| if this.seq == seq { this.notice = refused; cx.notify(); }).is_err() { return; }
                    }
                    Some("erro") => said = msg["m"].as_str().map(str::to_owned),
                    _ => {}
                }
            }
            let reason = said.unwrap_or_else(|| tr_shared("nav_remoto_caiu", &[]));
            let _ = this.update(cx, |this, cx| if this.seq == seq {
                this.socket = None;
                this.status = Status::Down(reason);
                cx.notify();
            });
        });
    }

    /// A página da outra máquina toma o tamanho deste painel; ela devolve o de antes quando a conexão fecha.
    fn sync_size(&mut self) {
        let size = self.bounds.get().size;
        let (w, h) = (f32::from(size.width).round() as u32, f32::from(size.height).round() as u32);
        if w < 50 || h < 50 || !matches!(self.status, Status::Live) { return; }
        if let Some(((sw, sh), at)) = self.sent_size
            && ((sw.abs_diff(w) < 16 && sh.abs_diff(h) < 16) || at.elapsed() < RESIZE_EVERY) { return; }
        self.sent_size = Some(((w, h), Instant::now()));
        self.send(json!({"t": "layout", "w": w, "h": h}));
    }

    fn send(&self, msg: Value) {
        if let (Some(socket), Status::Live) = (&self.socket, &self.status) { let _ = socket.send(&msg.to_string()); }
    }

    /// Ponto da tela em fração (0..1) do quadro desenhado; fora dele, `None`.
    fn at(&self, p: Point<Pixels>) -> Option<(f32, f32)> {
        // A proporção desenhada é a da imagem: no modo de print o tamanho anunciado não é o da página.
        let size = self.frame.as_ref()?.size(0);
        fraction(self.bounds.get(), (size.width.0 as f32, size.height.0 as f32), p)
    }

    fn mouse(&mut self, action: &str, button: MouseButton, p: Point<Pixels>, modifiers: &Modifiers) {
        let Some((x, y)) = self.at(p) else { return };
        let b = match button { MouseButton::Right => "right", MouseButton::Middle => "middle", _ => "left" };
        self.send(json!({"t": "m", "acao": action, "b": b, "x": x, "y": y, "mod": modifier_bits(modifiers)}));
    }

    fn render_page(&self, cx: &mut Context<Self>) -> AnyElement {
        let note = |text: String, color: Hsla| div().size_full().flex().items_center().justify_center().p_4()
            .text_size(px(12.)).text_color(color).text_center().whitespace_normal().child(text);
        let (bounds, scale) = (self.bounds.clone(), self.scale.clone());
        div().id("remote-browser-page").relative().flex_1().min_h_0().overflow_hidden().bg(theme::background())
            .track_focus(&self.focus).key_context("BrowserPage").role(Role::Application).aria_label(tr_shared("nav_remoto_tela", &[]))
            .child(canvas(|_, _, _| {}, move |b, _, window, _| { bounds.set(b); scale.set(window.scale_factor()); }).absolute().inset_0())
            .map(|el| match (&self.frame, &self.status) {
                (Some(image), _) => el.child(img(image.clone()).absolute().inset_0().size_full().object_fit(ObjectFit::Contain)),
                (None, Status::Down(_)) => el.child(note(tr_shared("nav_remoto_caiu", &[]), theme::muted())),
                (None, _) => el.child(note(tr_shared("nav_remoto_ligando", &[]), theme::muted())),
            })
            .on_any_mouse_down(cx.listener(|this, event: &MouseDownEvent, window, cx| {
                this.focus.focus(window, cx);
                this.mouse("press", event.button, event.position, &event.modifiers);
            }))
            .on_mouse_up(MouseButton::Left, cx.listener(|this, e: &MouseUpEvent, _, _| this.mouse("release", e.button, e.position, &e.modifiers)))
            .on_mouse_up(MouseButton::Right, cx.listener(|this, e: &MouseUpEvent, _, _| this.mouse("release", e.button, e.position, &e.modifiers)))
            .on_mouse_up(MouseButton::Middle, cx.listener(|this, e: &MouseUpEvent, _, _| this.mouse("release", e.button, e.position, &e.modifiers)))
            .on_mouse_move(cx.listener(|this, e: &MouseMoveEvent, _, _| {
                if this.last_move.is_some_and(|t| t.elapsed() < MOVE_EVERY) { return; }
                this.last_move = Some(Instant::now());
                this.mouse("move", MouseButton::Left, e.position, &e.modifiers);
            }))
            .on_scroll_wheel(cx.listener(|this, e: &ScrollWheelEvent, _, _| {
                let Some((x, y)) = this.at(e.position) else { return };
                // Mesma conta do navegador local: 17,78 px por linha, e o sinal oposto ao da página.
                let d = e.delta.pixel_delta(px(17.78));
                this.send(json!({"t": "w", "x": x, "y": y, "dx": -f32::from(d.x), "dy": -f32::from(d.y)}));
            }))
            .on_key_down(cx.listener(|this, e: &KeyDownEvent, _, cx| {
                let k = &e.keystroke;
                let paste = (k.modifiers.control && !k.modifiers.alt && k.key == "v") || (k.modifiers.shift && k.key == "insert");
                match paste.then(|| cx.read_from_clipboard().and_then(|item| item.text())).flatten() {
                    Some(text) => this.send(json!({"t": "txt", "s": text})),
                    None => if let Some(msg) = key_message(k) { this.send(msg) },
                }
                cx.stop_propagation();
            }))
            .into_any_element()
    }
}

impl Render for RemoteBrowser {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let down = match &self.status { Status::Down(reason) => Some(reason.clone()), _ => None };
        let url = self.url.clone().filter(|u| !u.is_empty()).unwrap_or_else(|| tr_shared("nav_remoto_sem_url", &[]));
        let toolbar = div().id("remote-browser-toolbar").flex_shrink_0().flex().items_center().gap_2().px_3().py(px(8.))
            .border_b_1().border_color(theme::border())
            .child(div().flex_1().min_w_0().truncate().text_size(px(12.)).font_family("monospace").text_color(theme::muted()).child(url))
            .when(matches!(self.status, Status::Connecting), |el| el.child(chrome::Spinner::new("remote-browser-loading", IconName::LoaderCircle, px(12.), theme::muted())));
        div().size_full().flex().flex_col().key_context("BrowserPanel")
            .child(toolbar)
            .when_some(down, |el, reason| el.child(div().id("remote-browser-down").flex_shrink_0().flex().items_center().gap_2().px_3().py(px(6.))
                .role(Role::Alert)
                .child(div().flex_1().min_w_0().text_size(px(11.)).text_color(theme::danger()).whitespace_normal().child(reason))
                .child(Button::new("remote-browser-retry").outline().xsmall().icon(IconName::RotateCw).label(tr_shared("nav_remoto_religar", &[]))
                    .on_click(cx.listener(|this, _, _, cx| { this.connect(cx); cx.notify(); })))))
            .when_some(self.notice.clone(), |el, text| el.child(div().id("remote-browser-notice").flex_shrink_0().px_3().py(px(4.)).role(Role::Status)
                .text_size(px(11.)).text_color(theme::warning()).whitespace_normal().child(text)))
            .when(self.slow && matches!(self.status, Status::Live), |el| el.child(div().flex_shrink_0().px_3().py(px(4.))
                .text_size(px(11.)).text_color(theme::muted()).child(tr_shared("nav_remoto_lento", &[]))))
            .child(self.render_page(cx))
    }
}

fn failure_text(error: ws::Error) -> String {
    match error {
        // O servidor recusa com 403 tanto a sessão sem navegador aberto quanto o token que não vale.
        ws::Error::Http(401 | 403 | 404) => tr("browser_remote_no_browser"),
        _ => tr_shared("nav_remoto_caiu", &[]),
    }
}

fn modifier_bits(m: &Modifiers) -> u8 {
    [(m.alt, 1), (m.control, 2), (m.platform, 4), (m.shift, 8)].iter().filter(|(on, _)| *on).fold(0, |a, (_, b)| a | b)
}

/// Ponto da tela em fração do quadro desenhado com `ObjectFit::Contain` (centrado, sem esticar).
fn fraction(bounds: Bounds<Pixels>, (fw, fh): (f32, f32), p: Point<Pixels>) -> Option<(f32, f32)> {
    let (bw, bh) = (f32::from(bounds.size.width), f32::from(bounds.size.height));
    if fw <= 0. || fh <= 0. || bw <= 0. || bh <= 0. { return None; }
    let s = (bw / fw).min(bh / fh);
    let (dw, dh) = (fw * s, fh * s);
    let x = (f32::from(p.x - bounds.origin.x) - (bw - dw) / 2.) / dw;
    let y = (f32::from(p.y - bounds.origin.y) - (bh - dh) / 2.) / dh;
    ((0.0..=1.0).contains(&x) && (0.0..=1.0).contains(&y)).then_some((x, y))
}

/// Tecla no formato do `nav-remoto`: nomeada vai como tecla, texto digitado como texto, Ctrl/Alt + letra como atalho.
fn key_message(k: &Keystroke) -> Option<Value> {
    let m = &k.modifiers;
    let bits = modifier_bits(m);
    let named = match k.key.as_str() {
        "enter" => "Enter", "backspace" => "Backspace", "delete" => "Delete", "escape" => "Escape", "tab" => "Tab",
        "left" => "ArrowLeft", "up" => "ArrowUp", "right" => "ArrowRight", "down" => "ArrowDown", "home" => "Home",
        "end" => "End", "pageup" => "PageUp", "pagedown" => "PageDown", _ => "",
    };
    if !named.is_empty() { return Some(json!({"t": "k", "key": named, "mod": bits})); }
    if !m.control && !m.alt && !m.platform
        && let Some(text) = k.key_char.as_deref().filter(|t| !t.is_empty() && !t.chars().any(char::is_control)) {
        return Some(json!({"t": "txt", "s": text}));
    }
    if !(m.control || m.alt) { return None; }
    let mut chars = k.key.chars();
    let c = chars.next()?;
    if chars.next().is_some() { return None; }
    let upper = c.to_ascii_uppercase();
    let code = if upper.is_ascii_alphanumeric() { upper as u32 } else { 0 };
    Some(json!({"t": "k", "key": c.to_string(), "mod": bits, "code": code}))
}

#[cfg(test)]
mod tests {
    use super::{Keystroke, Modifiers, fraction, key_message};
    use gpui_kit::{Bounds, point, px, size};
    use serde_json::json;

    #[test]
    fn fraction_follows_the_centered_frame() {
        // Painel 1000×400 com página 1280×800: o quadro ocupa 640×400, centrado com 180 px de cada lado.
        let card = Bounds { origin: point(px(10.), px(20.)), size: size(px(1000.), px(400.)) };
        assert_eq!(fraction(card, (1280., 800.), point(px(190.), px(20.))), Some((0., 0.)));
        assert_eq!(fraction(card, (1280., 800.), point(px(510.), px(220.))), Some((0.5, 0.5)));
        assert_eq!(fraction(card, (1280., 800.), point(px(100.), px(220.))), None, "faixa vazia ao lado não é página");
        assert_eq!(fraction(card, (0., 800.), point(px(510.), px(220.))), None);
    }

    fn stroke(key: &str, key_char: Option<&str>, control: bool) -> Keystroke {
        Keystroke { modifiers: Modifiers { control, ..Default::default() }, key: key.into(), key_char: key_char.map(Into::into) }
    }

    #[test]
    fn keys_become_nav_remoto_messages() {
        assert_eq!(key_message(&stroke("enter", Some("\n"), false)), Some(json!({"t": "k", "key": "Enter", "mod": 0})));
        assert_eq!(key_message(&stroke("c", Some("ç"), false)), Some(json!({"t": "txt", "s": "ç"})));
        assert_eq!(key_message(&stroke("a", Some("a"), true)), Some(json!({"t": "k", "key": "a", "mod": 2, "code": 65})));
        assert_eq!(key_message(&stroke("'", None, false)), None, "tecla morta compondo não vai");
    }
}
