//! Aceite de convite de par: a sessão que vai parear vem do menu dela ou é escolhida aqui.
use super::*;
use super::machines::enter_to_focused;
use crate::api::{PairAccepted, ShareFailure, SharePrereqs};
use super::share::prerequisite_notice;

/// Só o link `https://host.ts.net:8443/par/CÓDIGO` do Funnel: outro host ou porta nunca recebe o resgate.
pub(super) fn parse_pair_link(raw: &str) -> Option<String> {
    let url = url::Url::parse(raw.trim()).ok()?;
    if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some() || url.query().is_some() || url.fragment().is_some() {
        return None;
    }
    let host = url.host_str().filter(|h| h.ends_with(".ts.net") && h.len() > ".ts.net".len())?;
    if url.port() != Some(8443) { return None; }
    let mut parts: Vec<&str> = url.path_segments()?.collect();
    if parts.last() == Some(&"") { parts.pop(); }
    let &["par", code] = parts.as_slice() else { return None };
    let code_ok = (1..=64).contains(&code.len()) && code.chars().all(|c| c.is_ascii_alphanumeric());
    code_ok.then(|| format!("https://{host}:8443/par/{code}"))
}

/// Código do convite (usado, vencido, revogado…) tem frase própria; `Hangar::failure` leria todo 410 como "encerrado".
fn accept_failure(error: &Failure) -> String {
    if error.detail.starts_with("erro_convite_") { tr_shared(&error.detail, &[]) } else { Hangar::failure(error) }
}

pub(super) struct PairAcceptDialog {
    hangar: WeakEntity<Hangar>,
    // Fixada na abertura: a máquina da sessão do menu, ou a ativa quando o link veio colado.
    api: Api,
    input: Entity<InputState>,
    fixed: Option<String>,
    choice: Option<String>,
    sessions: Vec<String>,
    busy: bool,
    error: Option<String>,
    // O túnel que o aceite sobe ainda não está pronto: o aviso é o mesmo do compartilhar.
    blocked: Option<SharePrereqs>,
}

impl PairAcceptDialog {
    fn submit(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.busy { return; }
        self.blocked = None;
        let Some(link) = parse_pair_link(&self.input.read(cx).value()) else {
            self.error = Some(tr_shared("erro_par_link_invalido", &[]));
            cx.notify();
            return;
        };
        let Some(session) = self.fixed.clone().or_else(|| self.choice.clone()) else {
            self.error = Some(tr("par_escolha_sessao"));
            cx.notify();
            return;
        };
        (self.busy, self.error, self.blocked) = (true, None, None);
        let (me, api) = (cx.entity().downgrade(), self.api.clone());
        let _ = self.hangar.update(cx, |this, cx| this.accept_pair(me, api, session, link, window, cx));
        cx.notify();
    }
}

impl Render for PairAcceptDialog {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let mut col = div().flex().flex_col().gap_3()
            .child(div().text_sm().text_color(theme::muted()).whitespace_normal().child(tr("par_aceitar_ajuda")))
            .child(Input::new(&self.input).aria_label(tr("par_campo_aria")));
        if self.fixed.is_none() {
            col = col.child(div().text_sm().font_weight(FontWeight::SEMIBOLD).child(tr("par_qual_sessao")));
            if self.sessions.is_empty() {
                col = col.child(div().text_sm().text_color(theme::muted()).whitespace_normal().child(tr("par_sem_sessao")));
            }
            for (i, name) in self.sessions.clone().into_iter().enumerate() {
                let picked = self.choice.as_deref() == Some(name.as_str());
                let label = name.clone();
                col = col.child(Button::new(("par-sessao", i)).small().when(picked, |b| b.primary()).label(label)
                    .on_click(cx.listener(move |this, _, _, cx| { this.choice = Some(name.clone()); cx.notify(); })));
            }
        }
        col.when(self.busy, |el| el.child(div().id("par-busy").role(Role::Status).text_sm().text_color(theme::muted()).child(tr("par_aceitando"))))
            .when_some(self.blocked.as_ref(), |el, prereqs| el.child(prerequisite_notice("par-blocked", prereqs, None, None)))
            .when_some(self.error.clone(), |el, error| el.child(div().id("par-error").role(Role::Alert).text_sm()
                .text_color(theme::danger()).whitespace_normal().child(error)))
            .child(div().flex().justify_end().child(Button::new("par-aceitar").primary().label(tr("par_aceitar")).disabled(self.busy)
                .on_click(cx.listener(|this, _, window, cx| this.submit(window, cx)))))
    }
}

impl Hangar {
    /// `target` fixa a sessão e a máquina dela (menu da linha); sem ele, o link veio colado e a sessão é escolhida na máquina ativa.
    pub(super) fn open_pair_accept_dialog(&mut self, target: Option<super::sidebar::Target>, link: Option<String>, window: &mut Window, cx: &mut Context<Self>) {
        let api = match &target {
            Some(t) => self.machine_api(&t.server),
            None => self.api.clone(),
        };
        let Some(api) = api else {
            let error = target.as_ref().map_or_else(|| tr("connection_failed"), |t| self.machine_error(&t.server));
            window.push_notification(Notification::error(error), cx);
            return;
        };
        let hangar = cx.entity().downgrade();
        let sessions = self.sessions.iter().filter(|s| s.state != "dead" && !s.orq()).map(|s| s.name.clone()).collect();
        let fixed = target.map(|t| t.name);
        let input = cx.new(|cx| InputState::new(window, cx).placeholder(tr("par_placeholder")).default_value(link.unwrap_or_default()));
        let dialog = cx.new(|_| PairAcceptDialog { hangar, api, input: input.clone(), fixed: fixed.clone(), choice: None, sessions, busy: false, error: None, blocked: None });
        let title = match &fixed { Some(s) => tr_shared("native_par_titulo_sessao", &[("sessao", s)]), None => tr("par_titulo") };
        window.open_dialog(cx, move |d, _, cx| {
            let busy = dialog.read(cx).busy;
            let confirm = dialog.clone();
            popup::dialog(d).w(px(520.)).title(title.clone()).child(dialog.clone()).keyboard(!busy).overlay_closable(!busy).close_button(!busy)
                .on_ok(move |event, window, cx| {
                    // Enter no campo aceita; em outro controle segue para ele, como no resto do app.
                    if confirm.read(cx).input.read(cx).focus_handle(cx).is_focused(window) { confirm.update(cx, |d, cx| d.submit(window, cx)); false }
                    else { enter_to_focused(event, window, cx) }
                })
        });
        input.update(cx, |input, cx| input.focus(window, cx));
    }

    fn accept_pair(&mut self, dialog: WeakEntity<PairAcceptDialog>, api: Api, session: String, link: String, window: &mut Window, cx: &mut Context<Self>) {
        let (done, result) = tokio::sync::oneshot::channel();
        self.runtime.spawn(async move { let _ = done.send(api.accept_pair(&session, &link).await); });
        cx.spawn_in(window, async move |this, cx| {
            let result: Result<PairAccepted, ShareFailure> = result.await.unwrap_or_else(|_| Err(ShareFailure::Other(Failure::local("network_error"))));
            let _ = this.update_in(cx, |this, window, cx| match result {
                Ok(ok) => {
                    window.close_all_dialogs(cx);
                    window.push_notification(Notification::success(tr_shared("native_par_aceito", &[("dono", &ok.owner), ("sessao", &ok.session)])), cx);
                    this.refresh_external_pairs(cx);
                }
                Err(failure) => { let _ = dialog.update(cx, |d, cx| {
                    d.busy = false;
                    match &failure {
                        ShareFailure::Blocked(prereqs) => (d.error, d.blocked) = (None, Some(prereqs.clone())),
                        ShareFailure::Other(e) => (d.error, d.blocked) = (Some(accept_failure(e)), None),
                    }
                    cx.notify();
                }); }
            });
        }).detach();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use core::prelude::v1::test;

    #[test]
    fn pair_link_accepts_funnel_par_links_only() {
        assert_eq!(parse_pair_link(" https://a.tail.ts.net:8443/par/ABC12 ").as_deref(), Some("https://a.tail.ts.net:8443/par/ABC12"));
        assert_eq!(parse_pair_link("https://a.tail.ts.net:8443/par/ABC12/").as_deref(), Some("https://a.tail.ts.net:8443/par/ABC12"));
        for raw in ["https://a.tail.ts.net:8443/convite/ABC12", "http://a.tail.ts.net:8443/par/ABC12", "https://evil.com:8443/par/ABC12",
            "https://a.tail.ts.net/par/ABC12", "https://a.tail.ts.net:9000/par/ABC12", "https://a.tail.ts.net:8443/par/",
            "https://a.tail.ts.net:8443/par/AB-C", "https://a.tail.ts.net:8443/par/ABC/x", "https://u:p@a.tail.ts.net:8443/par/ABC",
            "https://a.tail.ts.net:8443/par/ABC?x=1", "https://.ts.net:8443/par/ABC", "https://a.ts.net.evil.com:8443/par/ABC", "hangar://par/a.tail.ts.net:8443/ABC12"] {
            assert_eq!(parse_pair_link(raw), None, "{raw}");
        }
        assert_eq!(parse_pair_link(&format!("https://a.tail.ts.net:8443/par/{}", "A".repeat(65))), None);
    }
}
