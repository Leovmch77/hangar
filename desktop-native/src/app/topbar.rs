//! Barra do app acima de tudo, igual em qualquer tela: no meio o campo "Buscar conversas" que abre a paleta (Ctrl+K),
//! à direita a pílula do custo de hoje (abre Custos) e a engrenagem das Configurações. A barra vazia arrasta a janela e o
//! duplo clique maximiza, como a barra de título do Zeron e do Zed: a janela não tem decoração no Linux. No Windows e no
//! macOS a janela tem a barra do sistema, com os botões dela; aqui não se desenha nenhum.
//!
//! Colados, ela é a barra de título do Zeron: sem linha embaixo e o conteúdo um pouco abaixo do meio. Com a barra
//! lateral à esquerda, a lateral sobe até o topo e esta começa na borda dela, com a cor do chat; nas abas e nas páginas
//! vai de ponta a ponta com o material da lateral. Soltos, é a faixa do web: sem fundo, o papel de parede passa por
//! trás, só uma linha fina embaixo, e os painéis flutuam abaixo dela com a margem deles.
use super::*;
use super::device::Remote;
use super::costs::web;

/// Colada, a altura e o respiro de cima da barra de título do Zeron.
const TOPBAR_HEIGHT: f32 = 38.;
const TOPBAR_TOP_PAD: f32 = 4.;
/// Solta, a altura da faixa de abas do web.
const TOPBAR_FLOATING_HEIGHT: f32 = 44.;
/// O custo de hoje é relido de tempos em tempos, além de ao conectar e ao fim de um turno longo.
const TODAY_EVERY: Duration = Duration::from_secs(300);

#[derive(Default)]
pub(super) struct TopBar {
    today: Remote<f64>,
    /// Botão apertado na barra vazia: o próximo movimento com ele apertado passa o arrasto ao compositor.
    should_move: bool,
}

/// Controle dentro da barra: o apertar dele não chega à barra, que senão arrastaria a janela.
fn control(el: impl IntoElement) -> Div {
    div().flex_shrink_0().on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation()).child(el)
}

impl Hangar {
    pub(super) fn topbar_loading(&self) -> bool { self.topbar.today.loading }

    /// Custo de hoje, da mesma fonte da tela de Custos (`/api/costs?period=1d`).
    pub(super) fn load_today(&mut self, cx: &mut Context<Self>) {
        if self.api.is_none() { self.topbar.today = Remote::default(); return; }
        let seq = self.topbar.today.start();
        self.server_get(vec!["costs".into()], vec![("period".into(), "1d".into())], 120, cx, move |this, result, cx| {
            let parsed = match result {
                // Primeira leitura do histórico ainda em curso: o valor chega na próxima volta.
                Ok(v) if v.get("aquecendo") == Some(&Value::Bool(true)) => Err(web("comum_carregando")),
                Ok(v) => v.pointer("/totals/cost").and_then(Value::as_f64).ok_or_else(|| tr("invalid_response")),
                Err(e) => Err(Self::failure(&e)),
            };
            if !this.topbar.today.finish(seq, parsed) { return; }
            cx.notify();
            // Só a leitura mais nova agenda a próxima: reconectar ou reler antes não empilha relógios.
            cx.spawn(async move |this, cx| {
                cx.background_executor().timer(TODAY_EVERY).await;
                let _ = this.update(cx, |this, cx| if this.topbar.today.seq == seq && !this.topbar.today.loading {
                    this.load_today(cx);
                    this.refresh_default_account(cx);
                });
            }).detach();
        });
        cx.notify();
    }

    /// `beside`: ao lado da barra lateral, com a largura do painel direito aberto (0 fechado); a busca fica no meio do chat.
    pub(super) fn render_topbar(&mut self, beside: Option<f32>, cx: &mut Context<Self>) -> AnyElement {
        let floating = theme::is_floating();
        let online = self.api.is_some();
        let settings_open = self.settings.is_some() && !self.settings_live();
        let search = Button::new("topbar-search")
            .custom(ButtonCustomVariant::new(cx).color(theme::inset()).foreground(theme::muted()).hover(theme::hover()).active(theme::hover()))
            .w(px(420.)).max_w_full().h(px(26.)).px(px(10.)).rounded(px(8.)).border_1().border_color(theme::border()).disabled(!online)
            .accessibility_label(web("lista_buscar"))
            .child(div().w_full().flex().items_center().gap(px(8.))
                .child(chrome::small_icon(IconName::Search, 14., theme::faint()))
                .child(div().flex_1().min_w_0().truncate().text_left().text_size(px(13.)).text_color(theme::faint()).child(format!("{}…", web("lista_buscar"))))
                .child(chrome::kbd("Ctrl K")))
            .on_click(cx.listener(|this, _, window, cx| this.toggle_search(window, cx)));
        let today = match (&self.topbar.today.value, self.topbar.today.loading) {
            (Some(Ok(usd)), _) => self.money(*usd),
            (None, true) => "…".into(),
            _ => "—".into(),
        };
        let error = self.topbar.today.value.as_ref().and_then(|v| v.as_ref().err().cloned());
        let pill = Button::new("topbar-cost").ghost().small().selected(self.costs.view.is_some()).disabled(!online)
            .h(px(26.)).px(px(10.)).rounded_full().border_1().border_color(theme::border())
            .child(div().flex().items_center().gap(px(6.)).text_size(px(12.5))
                .child(div().text_color(theme::muted()).child(tr("topbar_today")))
                .child(div().font_weight(FontWeight::SEMIBOLD).child(today)))
            .tooltip_with_action(error.unwrap_or_else(|| web("nav_custos")), &OpenCosts, None)
            .on_click(cx.listener(|this, _, window, cx| this.toggle_costs(window, cx)));
        // A conta padrão do Claude, como a pílula de cota do web: glifo, anel e "44% 5h · nome"; clique abre o cartão de contas.
        let account = self.default_account().map(|(name, window)| {
            let label = match &window {
                Some((label, pct)) => format!("{}% {label} · {name}", pct.round()),
                None => format!("{} · {name}", tr("no_data")),
            };
            Button::new("topbar-account").ghost().small().selected(self.accounts.card && self.accounts.card_top).disabled(!online)
                .h(px(26.)).px(px(8.)).rounded_full().max_w(px(280.))
                .child(div().min_w_0().flex().items_center().gap(px(6.)).text_size(px(12.5))
                    .child(chrome::provider_glyph("claude", 14.))
                    .child(chrome::ring(window.as_ref().map(|w| w.1)))
                    .child(div().min_w_0().truncate().text_color(theme::muted()).child(label)))
                .accessibility_label(tr("ring_account"))
                .on_click(cx.listener(|this, _, _, cx| this.toggle_top_usage_card(cx)))
        });
        let gear = Button::new("topbar-settings").custom(ButtonCustomVariant::new(cx).color(transparent_black()).foreground(theme::muted())
                .hover(theme::hover()).active(theme::hover()))
            .icon(chrome::small_icon(IconName::Settings, 16., theme::muted())).size(px(28.)).rounded(px(6.)).selected(settings_open)
            .accessibility_label(tr("settings")).tooltip_with_action(tr("settings_open"), &OpenSettings, None)
            .on_click(cx.listener(|this, _, window, cx| {
                if this.settings.is_some() && !this.settings_live() { this.close_settings(window, cx) }
                else { this.open_settings(settings::Page::Appearance, window, cx) }
            }));
        // Colada, a barra continua a lateral que está embaixo dela: a de conversas tem superfície própria.
        let page_open = settings_open || self.costs.view.is_some();
        let wall = if !page_open && appearance::get().navigation == appearance::Navigation::Conversations { theme::conversation_sidebar().0 }
            else { theme::chrome() };
        let bar = div().id("topbar").w_full().flex_shrink_0().flex().items_center().gap(px(8.))
            .map(|el| if floating { el.h(px(TOPBAR_FLOATING_HEIGHT)).px(px(8.)).border_b_1().border_color(theme::border_strong()) }
                else { el.h(px(TOPBAR_HEIGHT)).pt(px(TOPBAR_TOP_PAD)).pl(px(10.)).pr(px(6.)) })
            // Ao lado da lateral, sem fundo próprio: o que está atrás é o do chat.
            .when(!floating && beside.is_none(), |el| el.bg(wall))
            .window_control_area(WindowControlArea::Drag)
            .on_mouse_down(MouseButton::Left, cx.listener(|this, _, _, _| this.topbar.should_move = true))
            .on_mouse_up(MouseButton::Left, cx.listener(|this, _, _, _| this.topbar.should_move = false))
            .on_mouse_down_out(cx.listener(|this, _, _, _| this.topbar.should_move = false))
            .on_mouse_move(cx.listener(|this, event: &MouseMoveEvent, window, _| {
                // Só com o botão de fato apertado: um apertar antigo não pode arrastar a janela com o ponteiro solto.
                if this.topbar.should_move && event.pressed_button == Some(MouseButton::Left) {
                    this.topbar.should_move = false;
                    window.start_window_move();
                }
            }))
            .on_click(|event, window, _| if event.click_count() == 2 {
                if cfg!(target_os = "macos") { window.titlebar_double_click() } else { window.zoom_window() }
            })
            .map(|el| {
                let controls = div().flex().justify_end().gap(px(6.))
                    .children(account.map(|account| control(popup::anchor(div().min_w_0(), "topbar-account").child(account))))
                    .child(control(pill)).child(control(gear));
                match beside {
                    // Com o painel direito aberto, a busca centra no chat e os controles ficam sobre o painel; mais largos que
                    // ele, invadem o vazio do chat sem empurrar a busca.
                    Some(side) if side > 0. => el.child(div().flex_1().min_w_0().flex().child(div().flex_1()).child(control(search)).child(div().flex_1()))
                        .child(controls.flex_shrink_0().w(px(side))),
                    _ => el.child(div().flex_1()).child(control(search)).child(controls.flex_1().min_w_0()),
                }
            });
        if floating || beside.is_some() { bar.into_any_element() } else { chrome::glass_panel(bar, px(0.)) }
    }
}
