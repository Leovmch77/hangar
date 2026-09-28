//! Convite de sessão compartilhada, do lado de quem recebe: o link vira um servidor marcado `invite`, com a sessão do dono
//! na lista junto das próprias.
use super::*;
use super::machines::enter_to_focused;

/// Endereço e código do link `https://host:porta/convite/CÓDIGO` ou `hangar://convite/host:porta/CÓDIGO`.
pub(super) fn parse_invite_link(raw: &str) -> Option<(String, String)> {
    let raw = raw.trim().trim_end_matches('/');
    let (address, code) = if let Some(rest) = raw.strip_prefix("hangar://convite/") {
        let (host, code) = rest.rsplit_once('/')?;
        (format!("https://{host}"), code.to_owned())
    } else {
        let url = url::Url::parse(raw).ok()?;
        if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some() { return None; }
        let mut parts = url.path_segments()?;
        let (Some("convite"), Some(code), None) = (parts.next(), parts.next(), parts.next()) else { return None };
        (url.origin().ascii_serialization(), code.to_owned())
    };
    // O endereço vira o servidor gravado: credencial embutida e host torto não passam, como no web.
    let host_ok = url::Url::parse(&address).ok().is_some_and(|u| u.host_str().is_some_and(|h| !h.is_empty()) && u.path() == "/"
        && u.username().is_empty() && u.password().is_none() && u.query().is_none() && u.fragment().is_none());
    let code_ok = !code.is_empty() && code.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    (host_ok && code_ok).then_some((address, code))
}

/// O nome desta máquina, que o dono vê na lista de quem entrou.
pub(super) fn device_label() -> String {
    let name = if cfg!(windows) { std::env::var("COMPUTERNAME").ok() }
        else { std::fs::read_to_string("/etc/hostname").ok().or_else(|| std::env::var("HOSTNAME").ok()) };
    name.map(|n| n.trim().to_owned()).filter(|n| !n.is_empty()).unwrap_or_else(|| "Hangar".into())
}

/// 404, 410 e 503 têm frase própria: código errado, convite gasto e túnel do dono fora do ar pedem coisas diferentes de quem
/// recebeu (só o último vale tentar de novo, com o mesmo código).
fn redeem_failure(error: &Failure) -> String {
    match error.status {
        Some(404) => tr_shared("erro_convite_inexistente", &[]),
        // O `msg` do 410 já diz qual dos três (usado, vencido, revogado), igual ao web.
        Some(410) if !error.detail.is_empty() && !error.detail.starts_with("erro_") => error.detail.clone(),
        Some(410) => tr("invite_gone"),
        Some(503) => tr_shared("erro_sessao_indisponivel", &[]),
        None if matches!(error.detail.as_str(), "network_error" | "delivery_uncertain") => tr_shared("convite_erro_rede", &[]),
        _ => Hangar::failure(error),
    }
}

pub(super) struct InviteDialog { hangar: WeakEntity<Hangar>, input: Entity<InputState>, busy: bool, error: Option<String> }

impl InviteDialog {
    fn submit(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.busy { return; }
        let Some((address, code)) = parse_invite_link(&self.input.read(cx).value()) else {
            self.error = Some(tr_shared("convite_link_invalido", &[]));
            cx.notify();
            return;
        };
        (self.busy, self.error) = (true, None);
        let me = cx.entity().downgrade();
        let _ = self.hangar.update(cx, |this, cx| this.redeem_invite(me, address, code, window, cx));
        cx.notify();
    }
}

impl Render for InviteDialog {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        div().flex().flex_col().gap_3()
            .child(div().text_sm().text_color(theme::muted()).whitespace_normal().child(tr_shared("convite_colar_ajuda", &[])))
            .child(Input::new(&self.input).aria_label(tr_shared("convite_campo_aria", &[])))
            .when(self.busy, |el| el.child(div().id("invite-busy").role(Role::Status).text_sm().text_color(theme::muted()).child(tr_shared("convite_entrando", &[]))))
            .when_some(self.error.clone(), |el, error| el.child(div().id("invite-error").role(Role::Alert).text_sm()
                .text_color(theme::danger()).whitespace_normal().child(error)))
            .child(div().flex().justify_end().child(Button::new("invite-enter").primary().label(tr_shared("convite_entrar", &[])).disabled(self.busy)
                .on_click(cx.listener(|this, _, window, cx| this.submit(window, cx)))))
    }
}

impl Hangar {
    /// Aberto pelo botão da página Máquinas e pelo link `hangar://`: o link chega preenchido e só entra com o clique.
    pub(super) fn open_invite_dialog(&mut self, link: Option<String>, window: &mut Window, cx: &mut Context<Self>) {
        let hangar = cx.entity().downgrade();
        let input = cx.new(|cx| InputState::new(window, cx).placeholder(tr_shared("convite_placeholder", &[])).default_value(link.unwrap_or_default()));
        let dialog = cx.new(|_| InviteDialog { hangar, input: input.clone(), busy: false, error: None });
        window.open_dialog(cx, move |d, _, cx| {
            let busy = dialog.read(cx).busy;
            let confirm = dialog.clone();
            popup::dialog(d).w(px(520.)).title(tr_shared("convite_colar_titulo", &[])).child(dialog.clone()).keyboard(!busy).overlay_closable(!busy).close_button(!busy)
                .on_ok(move |event, window, cx| {
                    // Enter no campo entra; em outro controle segue para ele, como no resto do app.
                    if confirm.read(cx).input.read(cx).focus_handle(cx).is_focused(window) { confirm.update(cx, |d, cx| d.submit(window, cx)); false }
                    else { enter_to_focused(event, window, cx) }
                })
        });
        input.update(cx, |input, cx| input.focus(window, cx));
    }

    fn redeem_invite(&mut self, dialog: WeakEntity<InviteDialog>, address: String, code: String, window: &mut Window, cx: &mut Context<Self>) {
        let device = device_label();
        let (done, result) = tokio::sync::oneshot::channel();
        self.runtime.spawn(async move { let _ = done.send(api::redeem_invite(&address, &code, &device).await); });
        cx.spawn_in(window, async move |this, cx| {
            let result = result.await.unwrap_or_else(|_| Err(Failure::local("network_error")));
            let _ = this.update_in(cx, |this, window, cx| match result {
                Ok(redeemed) => { window.close_all_dialogs(cx); this.add_invite_server(redeemed, window, cx); }
                Err(error) => { let _ = dialog.update(cx, |d, cx| { (d.busy, d.error) = (false, Some(redeem_failure(&error))); cx.notify(); }); }
            });
        }).detach();
    }

    /// O convite vira um servidor a mais e a sessão compartilhada abre na hora, como a de qualquer outra máquina.
    fn add_invite_server(&mut self, redeemed: api::Redeemed, window: &mut Window, cx: &mut Context<Self>) {
        let key = servers::norm(&redeemed.address);
        self.invite_ended.remove(&key);
        servers::upsert(&mut self.servers, servers::ServerEntry { id: servers::new_id(), label: tr_shared("convite_rotulo", &[("dono", &redeemed.owner)]),
            address: redeemed.address, token: redeemed.token, disabled: false, invite: true });
        self.servers_rev += 1;
        self.persist_servers();
        self.start_remote_lists();
        self.open_remote(&key, redeemed.session, window, cx);
    }

    pub(super) fn active_invite(&self) -> bool {
        self.server.as_deref().and_then(|a| self.server_entry(&servers::norm(a))).is_some_and(|s| s.invite)
    }

    /// Num servidor de convite, 401 e 410 são o compartilhamento que acabou e 403 é rota fora do convite: nenhum abre a tela
    /// de conexão. Nos outros, 401/403 continuam sendo login perdido.
    pub(super) fn auth_lost(&mut self, error: &Failure) -> bool {
        if !self.active_invite() { return matches!(error.status, Some(401 | 403)); }
        if matches!(error.status, Some(401 | 410)) && let Some(address) = self.server.as_deref() {
            self.invite_ended.insert(servers::norm(address));
        }
        false
    }
}

#[cfg(test)]
mod tests {
    use super::parse_invite_link;
    use core::prelude::v1::test;

    #[test]
    fn https_and_deep_link_give_the_same_address_and_code() {
        let expected = Some(("https://notebook.tailcac351.ts.net:8443".to_owned(), "K7P29QX4ABCD".to_owned()));
        assert_eq!(parse_invite_link("https://notebook.tailcac351.ts.net:8443/convite/K7P29QX4ABCD"), expected);
        assert_eq!(parse_invite_link("  hangar://convite/notebook.tailcac351.ts.net:8443/K7P29QX4ABCD/ \n"), expected);
    }

    #[test]
    fn anything_else_is_not_an_invite() {
        for raw in ["", "K7P29QX4ABCD", "http://host:8443/convite/ABC", "https://host:8443/api/sessions",
            "https://host:8443/convite/", "https://host:8443/convite/AB C", "hangar://convite/host:8443",
            "hangar://outra/host:8443/ABC", "https://user:pw@host:8443/convite/ABC", "hangar://convite/user@host:8443/ABC"] {
            assert_eq!(parse_invite_link(raw), None, "{raw}");
        }
    }
}
