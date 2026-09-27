//! Cartão do anel de uso do compositor (o `account_usage` do Zeron): as contas do provider da sessão, a que ela usa
//! primeiro, com plano e as janelas de sessão e semana. Lê a mesma lista da página Contas e só quando abre: o servidor
//! devolve a cota guardada, sem releitura periódica daqui.
use super::*;

impl Hangar {
    /// Abre ou fecha o cartão, fechando o painel que estiver aberto sobre o compositor.
    pub(in crate::app) fn toggle_usage_card(&mut self, cx: &mut Context<Self>) {
        let open = !self.accounts.card;
        self.close_popups();
        self.accounts.card = open;
        if open && !self.accounts.list.loading { self.load_accounts(false, cx); }
        cx.notify();
    }

    pub(in crate::app) fn render_usage_card(&self) -> AnyElement {
        let session = self.selected.as_ref();
        let kind = session.map(|s| s.provider.as_str()).filter(|p| !p.is_empty()).unwrap_or("claude");
        let name = match kind { "claude" => "Claude Code", "codex" => "Codex", other => other };
        // A conta da sessão; servidor sem esse campo cai na conta padrão do provider.
        let conta = session.and_then(|s| s.conta.as_deref());
        let in_use = |c: &Credential| conta.map_or(c.active, |id| id == c.id);
        let note = |text: String, color: Hsla| div().px(px(8.)).py(px(4.)).text_sm().text_color(color).whitespace_normal().child(text).into_any_element();
        let body = match (&self.accounts.list.value, self.accounts.list.ok()) {
            (_, Some(list)) => {
                let mut mine: Vec<&Credential> = list.iter().filter(|c| c.kind == kind).collect();
                mine.sort_by_key(|c| !in_use(c));
                if mine.is_empty() { note(tr("usage_card_empty").replace("{provider}", name), theme::muted()) } else {
                    let (engines, now) = (HashMap::new(), now());
                    div().flex().flex_col().gap(px(2.))
                        .children(mine.into_iter().map(|c| account_row(c, in_use(c), build_row(c, &engines, false, now).quota)))
                        .into_any_element()
                }
            }
            (Some(Err(error)), _) => note(tr("accounts_failed").replace("{reason}", error), theme::warning()),
            _ => popup::skeleton("usage-card-loading", 1).into_any_element(),
        };
        div().p(px(popup::INSET)).rounded_md().bg(theme::popup_content_fill()).flex().flex_col().gap(px(2.))
            .child(popup::title(tr("usage_card_title").replace("{provider}", name), None))
            .child(body)
            .into_any_element()
    }
}

fn account_row(c: &Credential, in_use: bool, quota: QuotaView) -> Div {
    let login = c.login.as_ref().filter(|l| l.logged_in == Some(true));
    let title = c.alias.clone().filter(|a| !a.is_empty()).or_else(|| login.and_then(|l| l.email.clone())).unwrap_or_else(|| c.name.clone());
    // O servidor manda o plano cru ("max", "pro").
    let plan = login.and_then(|l| l.plan.as_deref()).and_then(|p| {
        let mut chars = p.chars();
        chars.next().map(|first| first.to_uppercase().collect::<String>() + chars.as_str())
    });
    let meta = div().flex().items_center().gap(px(6.)).text_size(px(12.)).text_color(theme::muted())
        .when_some(plan.clone(), |el, plan| el.child(plan))
        .when(plan.is_some() && in_use, |el| el.child(div().text_color(theme::faint()).child("·")))
        .when(in_use, |el| el.child(div().text_color(theme::accent()).child(tr("usage_card_in_use"))));
    let meters = match quota {
        QuotaView::Bars { bars, stale } => div().flex().flex_col().gap(px(4.)).when(stale.is_some(), |el| el.opacity(0.6))
            .children(bars.iter().take(2).map(meter))
            .children(stale.map(|text| div().text_size(px(11.)).text_color(theme::faint()).child(text))),
        QuotaView::Note(text) => div().text_size(px(12.)).text_color(theme::muted()).whitespace_normal().child(text),
        QuotaView::Nothing => div(),
    };
    div().flex().items_center().gap(px(12.)).px(px(8.)).py(px(7.)).rounded(px(7.)).when(in_use, |el| el.bg(theme::accent_dim()))
        .child(div().flex_1().min_w_0().flex().flex_col().gap(px(2.))
            .child(div().truncate().text_size(px(13.)).font_weight(FontWeight::MEDIUM).text_color(theme::text()).child(title))
            .child(meta))
        .child(div().w(px(176.)).flex_shrink_0().child(meters))
}

/// Uma janela numa linha: rótulo, barra e %, como o medidor do Zeron.
fn meter(bar: &Bar) -> Div {
    let label = if bar.label == "5h" { tr("usage_card_session") } else { window_label(&bar.label) };
    div().flex().items_center().gap(px(8.)).text_size(px(12.))
        .child(div().w(px(52.)).flex_shrink_0().truncate().text_color(theme::muted()).child(label))
        .child(div().flex_1().h(px(4.)).rounded_full().bg(theme::border_strong())
            .child(div().h_full().rounded_full().bg(level(bar.pct)).w(relative((bar.pct.clamp(0., 100.) / 100.) as f32))))
        .child(div().w(px(34.)).flex_shrink_0().flex().justify_end().text_color(if bar.pct > 80. { level(bar.pct) } else { theme::muted() })
            .child(format!("{}%", bar.pct.round())))
}
