//! A chegada da primeira mensagem da tela sem sessão: o compositor desce do meio ao pé da tela, o cabeçalho, a conversa e
//! o painel entram, e as pílulas da tela inicial saem. Tempos e curvas do catálogo de movimento do Zeron (`motion.rs`):
//! `fade-in` 500 ms `cubic-bezier(0.16,1,0.3,1)` com translateY 4→0 para o que entra (e para a descida do compositor), e
//! `splash-out` 500 ms `ease` com 150 ms de atraso, opacidade e translateY −6, para o que sai. Toda a animação do envio
//! mora aqui; `render` e `pane_element` só aplicam o quadro.
use super::*;
use super::create::NewSession;

const FADE_IN: Duration = Duration::from_millis(500);
const SPLASH_OUT: Duration = Duration::from_millis(500);
const SPLASH_DELAY: Duration = Duration::from_millis(150);
/// translateY do `fade-in` (entra de 4 px abaixo) e do `splash-out` (sai 6 px para cima).
const RISE: f32 = 4.;
const LIFT: f32 = 6.;
/// Folga sob o compositor no pé da faixa de baixo (`pb` do `#composer`).
const COMPOSER_GAP: f32 = 10.;

/// `cubic-bezier(x1, y1, x2, y2)` do CSS no ponto `x`, por bisseção.
fn bezier(x1: f32, y1: f32, x2: f32, y2: f32, x: f32) -> f32 {
    let curve = |s: f32, a: f32, b: f32| 3. * (1. - s) * (1. - s) * s * a + 3. * (1. - s) * s * s * b + s * s * s;
    let (mut lo, mut hi) = (0f32, 1f32);
    for _ in 0..20 {
        let mid = (lo + hi) / 2.;
        if curve(mid, x1, x2) < x { lo = mid } else { hi = mid }
    }
    curve((lo + hi) / 2., y1, y2)
}

fn ease_out_expo(x: f32) -> f32 { bezier(0.16, 1., 0.3, 1., x) }
fn ease(x: f32) -> f32 { bezier(0.25, 0.1, 0.25, 1., x) }

/// A chegada em curso. `travel`: quantos pixels o compositor desce; `ghost`: a tela inicial que sai, com o lugar das
/// pílulas de cima e de baixo no último desenho dela.
pub(super) struct Landing { start: Instant, travel: f32, ghost: Entity<NewSession>, top: Option<Bounds<Pixels>>, bottom: Option<Bounds<Pixels>> }

/// Um quadro: o quanto o compositor ainda está acima do lugar (`drop`), e a opacidade e o deslocamento de quem entra.
pub(super) struct Frame { pub drop: f32, pub shown: f32, pub rise: f32 }

impl Frame {
    const REST: Frame = Frame { drop: 0., shown: 1., rise: 0. };
}

/// Âncoras das duas fileiras de pílulas da tela inicial (`render_new_chat`).
pub(super) const TOP: &str = "new-chat-top";
pub(super) const BOTTOM: &str = "new-chat-bottom";

impl Hangar {
    /// Começa a chegada; a tela inicial que sai (`ghost`) ainda desenha as pílulas dela enquanto somem.
    pub(super) fn start_landing(&mut self, ghost: Entity<NewSession>, window: &Window) {
        let travel = popup::anchor_bounds("composer")
            .map_or(0., |b| f32::from(window.viewport_size().height - b.bottom()) - COMPOSER_GAP).max(0.);
        self.landing = Some(Landing { start: Instant::now(), travel, ghost,
            top: popup::anchor_bounds(TOP), bottom: popup::anchor_bounds(BOTTOM) });
    }

    pub(super) fn landing_active(&self) -> bool { self.landing.is_some() }

    pub(super) fn landing_frame(&mut self, window: &mut Window) -> Frame {
        let Some(landing) = self.landing.as_ref().filter(|_| self.selected.is_some()) else { self.landing = None; return Frame::REST };
        window.request_animation_frame();
        let t = ease_out_expo((landing.start.elapsed().as_secs_f32() / FADE_IN.as_secs_f32()).min(1.));
        Frame { drop: landing.travel * (1. - t), shown: t, rise: RISE * (1. - t) }
    }

    /// As pílulas da tela inicial saindo no lugar em que estavam; nada de clique chega a elas.
    pub(super) fn render_landing_ghost(&mut self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let landing = self.landing.as_ref()?;
        let t = ease(((landing.start.elapsed().as_secs_f32() - SPLASH_DELAY.as_secs_f32()) / SPLASH_OUT.as_secs_f32()).clamp(0., 1.));
        if t >= 1. { return None; }
        let (top, bottom, ghost) = (landing.top, landing.bottom, landing.ghost.clone());
        let (top_row, bottom_row) = ghost.update(cx, |view, cx| (view.render_top_pills(cx), view.render_bottom_pills(cx)));
        let place = |bounds: Bounds<Pixels>, row: Div| div().absolute().left(bounds.origin.x).top(bounds.origin.y - px(LIFT * t))
            .w(bounds.size.width).h(bounds.size.height).opacity(1. - t).occlude().child(row);
        Some(div().absolute().inset_0()
            .children(top.map(|b| place(b, top_row)))
            .children(bottom.map(|b| place(b, bottom_row)))
            .into_any_element())
    }

    /// Terminou: as áreas voltam a ser guardadas, redesenhadas uma vez, porque a última cópia guardada delas é de antes da
    /// tela sem sessão.
    pub(super) fn finish_landing(&mut self, window: &mut Window) {
        if self.landing.as_ref().is_none_or(|l| l.start.elapsed() < FADE_IN.max(SPLASH_DELAY + SPLASH_OUT)) { return; }
        self.landing = None;
        let panes = [self.panes.conversation.clone(), self.panes.bottom.clone(), self.panes.side.clone()];
        window.on_next_frame(move |_, cx| for pane in &panes { pane.update(cx, |_, cx| cx.notify()); });
    }
}
