//! Par externo do lado de quem o tem: a sessão da outra pessoa aparece abaixo do grupo e abre pelo servidor de convite da
//! máquina dela, só leitura.
use super::*;

/// Monta ou remove as entradas só do par e devolve os attach pendentes (endereço, token da entrada, token do par).
pub(super) fn reconcile_pair_entries(list: &mut Vec<servers::ServerEntry>, pairs: &[api::ExternalPairDto]) -> Vec<(String, String, String)> {
    let at = |address: &str| { let key = servers::norm(address); pairs.iter().filter(move |p| servers::norm(&p.address) == key) };
    list.retain(|s| !s.ephemeral || at(&s.address).next().is_some());
    let mut pending = Vec::new();
    for p in pairs {
        let key = servers::norm(&p.address);
        match list.iter_mut().find(|s| servers::norm(&s.address) == key) {
            // Servidor próprio no mesmo endereço: o token do par não entra nele.
            Some(s) if !s.invite => {}
            Some(s) => {
                // Par que acabou levaria a entrada junto: ela passa ao token de um par vivo.
                if s.ephemeral && !at(&s.address).any(|q| q.token == s.token) { s.token = p.token.clone(); }
                if s.token != p.token { pending.push((s.address.clone(), s.token.clone(), p.token.clone())); }
            }
            None => list.push(servers::ServerEntry { id: servers::new_id(), label: tr_shared("native_par_rotulo", &[("dono", &p.owner)]),
                address: p.address.clone(), token: p.token.clone(), disabled: false, invite: true, lan: None, ephemeral: true }),
        }
    }
    pending
}

impl Hangar {
    /// A sessão aberta é a da outra pessoa num par: as rotas que não são de leitura da conversa levariam 403.
    pub(super) fn open_read_only(&self) -> bool { self.selected.as_ref().is_some_and(SessionInfo::read_only) }

    /// Lista própria mudou: relê os pares só quando muda quem tem par externo (e uma vez, na primeira lista).
    pub(super) fn external_pairs_changed(&mut self, cx: &mut Context<Self>) {
        let mut seen = Vec::new();
        for s in self.servers.iter().filter(|s| !s.invite && !s.disabled) {
            let key = servers::norm(&s.address);
            let list = if self.is_active_key(&key) { Some(&self.sessions) } else { self.remote.get(&key).map(|l| &l.sessions) };
            seen.extend(list.into_iter().flatten().filter(|x| x.pair_external.is_some())
                .map(|x| (key.clone(), x.name.clone(), x.pair_external.clone())));
        }
        if self.external_seen.as_ref() == Some(&seen) { return; }
        self.external_seen = Some(seen);
        self.refresh_external_pairs(cx);
    }

    /// Lê os pares de cada servidor próprio. Servidor que não respondeu fica com os pares que já tinha.
    pub(super) fn refresh_external_pairs(&mut self, cx: &mut Context<Self>) {
        let own: Vec<(String, Api)> = self.servers.iter().filter(|s| !s.invite && !s.disabled)
            .filter_map(|s| { let key = servers::norm(&s.address); self.machine_api(&key).map(|api| (key, api)) }).collect();
        self.external_seq += 1;
        let seq = self.external_seq;
        let (done, result) = tokio::sync::oneshot::channel();
        self.runtime.spawn(async move {
            let reads = own.into_iter().map(|(key, api)| async move { (key, api.external_pairs().await) });
            let _ = done.send(futures::future::join_all(reads).await);
        });
        cx.spawn(async move |this, cx| {
            let Ok(results) = result.await else { return };
            let _ = this.update(cx, |this, cx| {
                if seq != this.external_seq { return; }
                let own: HashSet<String> = this.servers.iter().filter(|s| !s.invite).map(|s| servers::norm(&s.address)).collect();
                let read: HashSet<String> = results.iter().filter(|(_, r)| r.is_ok()).map(|(key, _)| key.clone()).collect();
                let mut pairs: Vec<(String, api::ExternalPairDto)> = std::mem::take(&mut this.external_pairs).into_iter()
                    .filter(|(key, _)| own.contains(key) && !read.contains(key)).collect();
                for (key, result) in results {
                    match result {
                        Ok(list) => pairs.extend(list.into_iter().map(|p| (key.clone(), p))),
                        Err(error) => eprintln!("pares externos de {key} não lidos: {}", error.detail),
                    }
                }
                this.external_pairs = pairs;
                this.apply_external_pairs(cx);
            });
        }).detach();
    }

    /// Acerta as entradas do par na lista de máquinas; as listas recomeçam só quando a entrada muda ou o attach entra.
    pub(super) fn apply_external_pairs(&mut self, cx: &mut Context<Self>) {
        let pairs: Vec<api::ExternalPairDto> = self.external_pairs.iter().map(|(_, p)| p.clone()).collect();
        let before = self.servers.clone();
        let pending = reconcile_pair_entries(&mut self.servers, &pairs);
        if self.servers != before { self.restart_lists_for_pairs(cx); }
        for attach in pending {
            if !self.attached.insert(attach.clone()) { continue; }
            let (address, holder, other) = attach.clone();
            let (done, result) = tokio::sync::oneshot::channel();
            self.runtime.spawn(async move { let _ = done.send(api::attach_guest(&address, &holder, &other).await); });
            cx.spawn(async move |this, cx| {
                let result = result.await.unwrap_or_else(|_| Err(Failure::local("network_error")));
                let _ = this.update(cx, |this, cx| match result {
                    Ok(()) => this.restart_lists_for_pairs(cx),
                    // Fica fora do conjunto: a próxima releitura dos pares tenta de novo.
                    Err(error) => { this.attached.remove(&attach); eprintln!("attach do par em {} falhou: {}", attach.0, error.detail); }
                });
            }).detach();
        }
    }

    fn restart_lists_for_pairs(&mut self, cx: &mut Context<Self>) {
        self.servers_rev += 1;
        self.start_remote_lists();
        self.redraw(panes::Area::Nav, cx);
        cx.notify();
    }

    /// Clique na linha da outra pessoa: abre a sessão dela pela entrada da máquina dela.
    fn open_external_pair(&mut self, own: &str, alias: &str, session: &str, window: &mut Window, cx: &mut Context<Self>) {
        let address = self.external_pairs.iter().find(|(key, p)| key == own && p.alias == alias && p.session == session)
            .map(|(_, p)| p.address.clone());
        match address {
            Some(address) => self.open_remote(&servers::norm(&address), session.to_owned(), window, cx),
            None => window.push_notification(Notification::warning(tr("search_session_gone").replace("{name}", session)), cx),
        }
    }

    /// Linha recuada sob o grupo, com a faixa dele: ícone de link, "dono · sessão" e a marca de externo.
    pub(super) fn render_external_pair_row(&self, owner: &str, session: &str, alias: &str, remote: Option<&str>, window: &mut Window,
        cx: &mut Context<Self>) -> AnyElement {
        let own = remote.map(str::to_owned).unwrap_or_else(|| self.active_key());
        let id = SharedString::from(format!("pair-ext-{own}-{alias}-{session}"));
        let focus = window.use_keyed_state(SharedString::from(format!("{id}-focus")), cx, |_, cx| cx.focus_handle().tab_stop(true)).read(cx).clone();
        let label = format!("{owner} · {session}");
        let mark = tr("par_externo");
        let (click, key) = ((own.clone(), alias.to_owned(), session.to_owned()), (own, alias.to_owned(), session.to_owned()));
        let row_focus = focus.clone();
        div().id(id).relative().flex_shrink_0().ml(px(8.)).px(px(8.)).py(px(7.)).rounded(px(10.))
            .track_focus(&focus)
            .when(focus.is_focused(window), |el| el.focus_ring_style(window, cx))
            .hover(|el| el.bg(theme::hover())).cursor_pointer()
            .flex().items_center().gap(px(8.))
            .child(div().absolute().left_0().top(px(6.)).bottom(px(6.)).w(px(2.)).rounded_full().bg(theme::accent()))
            .child(div().size(px(18.)).flex_shrink_0().flex().items_center().justify_center().child(chrome::small_icon(IconName::Link, 14., theme::accent())))
            .child(div().flex_1().min_w_0().truncate().font_weight(FontWeight::MEDIUM).child(label.clone()))
            .child(badge(mark.clone(), theme::muted()))
            .role(Role::Button).aria_label(format!("{label} · {mark}"))
            .on_click(cx.listener(move |this, _, window, cx| this.open_external_pair(&click.0, &click.1, &click.2, window, cx)))
            .on_key_down(cx.listener(move |this, event: &KeyDownEvent, window, cx| {
                if !matches!(event.keystroke.key.as_str(), "enter" | "space") || !row_focus.is_focused(window) { return; }
                this.open_external_pair(&key.0, &key.1, &key.2, window, cx);
                cx.stop_propagation();
            }))
            .into_any_element()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use core::prelude::v1::test;

    #[test]
    fn pair_entry_is_ephemeral_or_attaches_to_existing_invite() {
        let pair = |addr: &str| api::ExternalPairDto { local_session: "X".into(), alias: "pc-ana".into(), owner: "pc-ana".into(),
            session: "Y".into(), address: addr.into(), token: "tp".into() };
        let mut list = vec![];
        assert!(reconcile_pair_entries(&mut list, &[pair("https://a.ts.net:8443")]).is_empty());
        assert!(list[0].ephemeral && list[0].invite && list[0].token == "tp");
        let mut list = vec![servers::ServerEntry { address: "https://a.ts.net:8443".into(), token: "ti".into(), invite: true, ..Default::default() }];
        let pend = reconcile_pair_entries(&mut list, &[pair("https://a.ts.net:8443")]);
        assert_eq!(pend, vec![("https://a.ts.net:8443".to_owned(), "ti".to_owned(), "tp".to_owned())]);
        assert_eq!(list.len(), 1);
        let mut list = vec![servers::ServerEntry { address: "https://b.ts.net:8443".into(), token: "tp".into(), invite: true, ephemeral: true, ..Default::default() }];
        reconcile_pair_entries(&mut list, &[]);
        assert!(list.is_empty());
    }

    #[test]
    fn own_server_at_the_pair_address_is_never_touched() {
        let mut list = vec![servers::ServerEntry { address: "https://a.ts.net:8443".into(), token: "own".into(), ..Default::default() }];
        let pair = api::ExternalPairDto { local_session: "X".into(), alias: "a".into(), owner: "Ana".into(), session: "Y".into(),
            address: "https://a.ts.net:8443/".into(), token: "tp".into() };
        assert!(reconcile_pair_entries(&mut list, &[pair]).is_empty());
        assert_eq!((list.len(), list[0].token.as_str()), (1, "own"));
    }
}
