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

/// Servidor próprio ligado: só ele tem pares lidos e entradas de par.
fn is_own(s: &servers::ServerEntry) -> bool { !s.invite && !s.disabled }

impl Hangar {
    /// A sessão aberta é a da outra pessoa num par: as rotas que não são de leitura da conversa levariam 403.
    pub(super) fn open_read_only(&self) -> bool { self.selected.as_ref().is_some_and(SessionInfo::read_only) }

    /// Lista própria mudou: relê os pares só quando muda quem tem par externo (e uma vez, na primeira lista).
    pub(super) fn external_pairs_changed(&mut self, cx: &mut Context<Self>) {
        let mut seen = Vec::new();
        for s in self.servers.iter().filter(|s| is_own(s)) {
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
        let own: Vec<(String, Api)> = self.servers.iter().filter(|s| is_own(s))
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
                let own: HashSet<String> = this.servers.iter().filter(|s| is_own(s)).map(|s| servers::norm(&s.address)).collect();
                let read: HashSet<String> = results.iter().filter(|(_, r)| r.is_ok()).map(|(key, _)| key.clone()).collect();
                let mut pairs: Vec<(String, api::ExternalPairDto)> = std::mem::take(&mut this.external_pairs).into_iter()
                    .filter(|(key, _)| own.contains(key) && !read.contains(key)).collect();
                for (key, result) in results {
                    match result {
                        Ok(list) => pairs.extend(list.into_iter().map(|p| (key.clone(), p))),
                        Err(error) => {
                            // Sem a marca, a próxima lista igual à de antes não releria: falha precisa poder tentar de novo.
                            this.external_seen = None;
                            eprintln!("pares externos de {key} não lidos: {}", error.detail);
                        }
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
        // Par que acabou tira a marca do attach dele: um par novo no mesmo token precisa ligar de novo.
        self.attached.retain(|(address, _, other)| pairs.iter().any(|p| servers::norm(&p.address) == servers::norm(address) && &p.token == other));
        if self.servers != before { self.restart_lists_for_pairs(cx); }
        let fresh: Vec<_> = pending.into_iter().filter(|attach| self.attached.insert(attach.clone())).collect();
        if fresh.is_empty() { return; }
        let (done, result) = tokio::sync::oneshot::channel();
        self.runtime.spawn(async move {
            let calls = fresh.into_iter().map(|attach| async move {
                let result = api::attach_guest(&attach.0, &attach.1, &attach.2).await;
                (attach, result)
            });
            let _ = done.send(futures::future::join_all(calls).await);
        });
        cx.spawn(async move |this, cx| {
            let Ok(results) = result.await else { return };
            let _ = this.update(cx, |this, cx| {
                let mut any_ok = false;
                for (attach, result) in results {
                    match result {
                        Ok(()) => any_ok = true,
                        Err(error) => {
                            // Fora do conjunto e sem a marca de lista vista: o próximo aviso de lista relê os pares e tenta de novo.
                            this.attached.remove(&attach);
                            this.external_seen = None;
                            eprintln!("attach do par em {} falhou: {}", attach.0, error.detail);
                        }
                    }
                }
                if any_ok { this.restart_lists_for_pairs(cx); }
            });
        }).detach();
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
        let Some(key) = address.map(|a| servers::norm(&a)) else {
            window.push_notification(Notification::warning(tr("search_session_gone").replace("{name}", session)), cx);
            return;
        };
        // Entrada da máquina dela tirada da lista: volta a do par antes de abrir, senão o clique esperaria uma lista que não vem.
        if !self.remote.contains_key(&key) && !self.is_active_key(&key) { self.apply_external_pairs(cx); }
        if self.is_active_key(&key) { self.open_target(&super::sidebar::Target::new(&key, session), window, cx); }
        else if self.remote.contains_key(&key) { self.open_remote(&key, session.to_owned(), window, cx); }
        else {
            let text = tr("remote_open_failed").replace("{name}", session).replace("{erro}", &self.machine_error(&key));
            window.push_notification(Notification::warning(text), cx);
        }
    }

    /// Linha recuada sob o grupo, com a faixa dele: ícone de link, "dono · sessão" e a marca de externo.
    pub(super) fn render_external_pair_row(&self, gid: &str, owner: &str, session: &str, alias: &str, remote: Option<&str>, window: &mut Window,
        cx: &mut Context<Self>) -> AnyElement {
        let own = remote.map(str::to_owned).unwrap_or_else(|| self.active_key());
        let id = SharedString::from(format!("pair-ext-{own}-{gid}-{alias}-{session}"));
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

    const ADDR: &str = "https://a.ts.net:8443";

    fn pair(addr: &str, token: &str) -> api::ExternalPairDto {
        api::ExternalPairDto { local_session: "X".into(), alias: "pc-ana".into(), owner: "pc-ana".into(), session: "Y".into(),
            address: addr.into(), token: token.into() }
    }
    fn entry(addr: &str, token: &str, ephemeral: bool) -> servers::ServerEntry {
        servers::ServerEntry { address: addr.into(), token: token.into(), invite: true, ephemeral, ..Default::default() }
    }

    #[test]
    fn pair_without_entry_gets_an_ephemeral_one() {
        let mut list = vec![];
        assert!(reconcile_pair_entries(&mut list, &[pair(ADDR, "tp")]).is_empty());
        assert!(list[0].ephemeral && list[0].invite && list[0].token == "tp");
    }

    #[test]
    fn pair_on_an_existing_invite_attaches_to_its_token() {
        let mut list = vec![entry(ADDR, "ti", false)];
        let pend = reconcile_pair_entries(&mut list, &[pair(ADDR, "tp")]);
        assert_eq!(pend, vec![(ADDR.to_owned(), "ti".to_owned(), "tp".to_owned())]);
        assert_eq!(list.len(), 1);
    }

    #[test]
    fn ephemeral_entry_without_pair_is_dropped() {
        let mut list = vec![entry("https://b.ts.net:8443", "tp", true)];
        reconcile_pair_entries(&mut list, &[]);
        assert!(list.is_empty());
    }

    #[test]
    fn two_pairs_on_the_same_machine_share_one_entry() {
        let mut list = vec![];
        let pend = reconcile_pair_entries(&mut list, &[pair(ADDR, "t1"), pair(ADDR, "t2")]);
        assert_eq!((list.len(), list[0].token.as_str()), (1, "t1"));
        assert_eq!(pend, vec![(ADDR.to_owned(), "t1".to_owned(), "t2".to_owned())]);
    }

    #[test]
    fn ephemeral_entry_moves_to_a_live_pair_token_when_its_own_ends() {
        let mut list = vec![entry(ADDR, "t1", true)];
        let pend = reconcile_pair_entries(&mut list, &[pair(ADDR, "t2")]);
        assert!(pend.is_empty());
        assert_eq!(list[0].token, "t2");
    }

    #[test]
    fn own_server_at_the_pair_address_is_never_touched() {
        let mut list = vec![servers::ServerEntry { address: ADDR.into(), token: "own".into(), ..Default::default() }];
        assert!(reconcile_pair_entries(&mut list, &[pair("https://a.ts.net:8443/", "tp")]).is_empty());
        assert_eq!((list.len(), list[0].token.as_str()), (1, "own"));
    }

    #[test]
    fn ephemeral_entry_is_never_persisted() {
        let list = vec![entry(ADDR, "tp", true), entry("https://b.ts.net:8443", "ti", false)];
        let saved = servers::persistable(&list);
        assert_eq!(saved.len(), 1);
        assert_eq!(saved[0].token, "ti");
    }

    #[test]
    fn upsert_over_an_ephemeral_entry_makes_it_persistent_with_the_new_token() {
        let mut list = vec![entry(ADDR, "tp", true)];
        servers::upsert(&mut list, servers::ServerEntry { address: ADDR.into(), token: "own".into(), ..Default::default() });
        assert_eq!((list.len(), list[0].token.as_str(), list[0].ephemeral, list[0].invite), (1, "own", false, false));
        assert_eq!(servers::persistable(&list).len(), 1);
    }
}
