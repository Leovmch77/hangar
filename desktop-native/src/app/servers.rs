//! Vários servidores ao mesmo tempo, como o web (`cp_servers` + `sessionsStore`): a lista de cada máquina chega pelo SSE
//! dela, e abrir uma sessão de outra máquina troca o servidor ativo sem perguntar.
use super::*;
use crate::api::sse::Update;

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, PartialEq)]
pub(crate) struct ServerEntry {
    pub id: String,
    pub label: String,
    pub address: String,
    pub token: String,
    #[serde(default)]
    pub disabled: bool,
    /// Servidor que só existe por um convite: nenhuma chamada geral do servidor, e 410 é "compartilhamento encerrado".
    #[serde(default)]
    pub invite: bool,
}

pub(crate) enum RemoteUpdate { Sessions(Result<Vec<SessionInfo>, Failure>), Stream(Update) }

/// A lista de uma máquina que não é a ativa. Fora do ar, fica a última lista boa, como no web.
#[derive(Default)]
pub(crate) struct RemoteList { pub sessions: Vec<SessionInfo>, pub loaded: bool, pub online: bool, pub error: Option<String> }

/// Mesma máquina escrita de dois jeitos (barra final, maiúsculas) é o mesmo servidor.
pub(crate) fn norm(address: &str) -> String { address.trim().trim_end_matches('/').to_ascii_lowercase() }

/// `label` padrão do web: o primeiro pedaço do host.
pub(crate) fn default_label(address: &str) -> String {
    url::Url::parse(address.trim()).ok().and_then(|u| u.host_str().map(|h| h.split('.').next().unwrap_or(h).to_owned()))
        .filter(|h| !h.is_empty()).unwrap_or_else(|| address.to_owned())
}

/// Entra na lista ou atualiza o de mesmo endereço; o rótulo existente fica quando o novo vem vazio.
pub(crate) fn upsert(list: &mut Vec<ServerEntry>, entry: ServerEntry) {
    match list.iter_mut().find(|s| norm(&s.address) == norm(&entry.address)) {
        Some(found) => {
            if !entry.label.is_empty() { found.label = entry.label; }
            found.token = entry.token;
            found.disabled = entry.disabled;
            // O upsert da primeira conexão chega sem a marca; ela só entra, nunca sai por aqui.
            found.invite |= entry.invite;
        }
        None => list.push(entry),
    }
}

pub(crate) fn new_id() -> String {
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    format!("srv-{:08x}", (stamp as u64) ^ std::process::id() as u64)
}

async fn run_list(api: Api, key: String, generation: u64, tx: async_channel::Sender<Envelope>) {
    let send = |update| Envelope { connection: 0, selection: None, payload: Payload::Remote(generation, key.clone(), update) };
    let first = api.sessions().await;
    let fatal = first.as_ref().err().is_some_and(|e| matches!(e.status, Some(401 | 403 | 410)));
    if tx.send(send(RemoteUpdate::Sessions(first))).await.is_err() || fatal { return; }
    let (updates, rx) = async_channel::bounded(128);
    let producer = async { api::sse::run(api, None, updates.clone()).await; updates.close(); };
    let consumer = async { while let Ok(update) = rx.recv().await {
        if tx.send(send(RemoteUpdate::Stream(update))).await.is_err() { break; }
    } };
    tokio::pin!(producer, consumer);
    tokio::select! { _ = &mut producer => { consumer.await; } _ = &mut consumer => {} }
}

impl Hangar {
    /// Um SSE de lista por servidor ligado que não é o ativo. Refeito a cada conexão: o ativo muda de lugar com os outros.
    pub(super) fn start_remote_lists(&mut self) {
        for task in self.remote_tasks.drain(..) { task.abort(); }
        self.remote_gen += 1;
        let active = self.server.as_deref().map(norm).unwrap_or_default();
        let wanted: Vec<ServerEntry> = self.servers.iter().filter(|s| !s.disabled && norm(&s.address) != active).cloned().collect();
        self.remote.retain(|key, _| wanted.iter().any(|s| &norm(&s.address) == key));
        for entry in wanted {
            let key = norm(&entry.address);
            let list = self.remote.entry(key.clone()).or_default();
            let api = match Api::new(&entry.address, &entry.token) {
                Ok(api) => api,
                Err(error) => { list.error = Some(Self::failure(&error)); continue; }
            };
            self.remote_tasks.push(self.runtime.spawn(run_list(api, key, self.remote_gen, self.tx.clone())));
        }
    }

    pub(super) fn receive_remote(&mut self, generation: u64, key: String, update: RemoteUpdate, cx: &mut Context<Self>) {
        if generation != self.remote_gen { return; }
        let invite = self.server_entry(&key).is_some_and(|s| s.invite);
        // 401 só é "encerrado" num convite; nos outros continua sendo login perdido.
        let ended = |error: &Failure| error.status == Some(410) || (invite && error.status == Some(401));
        let Some(list) = self.remote.get_mut(&key) else { return };
        match update {
            RemoteUpdate::Sessions(Ok(sessions)) => { list.sessions = sessions; list.loaded = true; list.error = None; }
            RemoteUpdate::Sessions(Err(error)) if ended(&error) => {
                self.invite_ended.insert(key.clone());
                list.sessions.clear();
                list.error = Some(tr_shared("convite_encerrado", &[]));
            }
            RemoteUpdate::Sessions(Err(error)) => list.error = Some(Self::failure(&error)),
            RemoteUpdate::Stream(Update::Online) => list.online = true,
            RemoteUpdate::Stream(Update::Offline(error)) => {
                list.online = false;
                list.error = Some(if ended(&error) {
                    self.invite_ended.insert(key.clone());
                    list.sessions.clear();
                    tr_shared("convite_encerrado", &[])
                } else { Self::failure(&error) });
            }
            RemoteUpdate::Stream(Update::Frame(frame)) => {
                let applied = match frame.event.as_str() {
                    "sessions" => match serde_json::from_value(frame.data) {
                        Ok(sessions) => { list.sessions = sessions; list.loaded = true; list.error = None; true }
                        Err(_) => { list.error = Some(tr("invalid_response")); false }
                    },
                    "list_error" => { list.error = Some(tr("list_stale")); true }
                    _ => true,
                };
                let _ = frame.applied.send(applied);
            }
        }
        self.redraw(panes::Area::Nav, cx);
        cx.notify();
    }

    pub(super) fn server_entry(&self, key: &str) -> Option<&ServerEntry> { self.servers.iter().find(|s| norm(&s.address) == key) }

    /// Clique numa sessão de outra máquina: ela vira a ativa (a lista dela já está na mão) e a sessão abre quando a lista chega.
    pub(super) fn open_remote(&mut self, key: &str, name: String, window: &mut Window, cx: &mut Context<Self>) {
        let Some(entry) = self.server_entry(key).cloned() else { return };
        self.pending_open = Some(name);
        self.activate_server(entry, window, cx);
    }

    /// Troca o servidor ativo sem diálogo, como o `selectServer` do web. Sem sessão aberta, o texto do compositor fica.
    pub(super) fn activate_server(&mut self, entry: ServerEntry, window: &mut Window, cx: &mut Context<Self>) {
        self.ready_sessions = self.remote.get(&norm(&entry.address)).filter(|l| l.loaded).map(|l| l.sessions.clone());
        let draft = self.selected.is_none().then(|| self.composer.read(cx).value().to_string()).filter(|d| !d.is_empty());
        self.address.update(cx, |input, cx| input.set_value(entry.address, window, cx));
        self.token.update(cx, |input, cx| input.set_value(entry.token, window, cx));
        self.connect(window, cx);
        if let Some(draft) = draft { self.composer.update(cx, |input, cx| input.set_value(draft, window, cx)); }
    }

    /// A sessão criada em outra máquina: ela vira a ativa uma vez, já com a sessão nova na lista guardada, para a lista que
    /// chega primeiro não fechá-la.
    pub(super) fn activate_for_created(&mut self, key: &str, session: &SessionInfo, window: &mut Window, cx: &mut Context<Self>) {
        let Some(entry) = self.server_entry(key).cloned() else { return };
        if let Some(list) = self.remote.get_mut(key).filter(|l| l.loaded && !l.sessions.iter().any(|s| s.name == session.name)) {
            list.sessions.push(session.clone());
        }
        self.activate_server(entry, window, cx);
    }

    /// Servidores trazidos de fora (o app Electron): entram na lista, gravada junto da conexão.
    pub(super) fn merge_servers(&mut self, incoming: Vec<ServerEntry>, cx: &mut Context<Self>) {
        for entry in incoming { upsert(&mut self.servers, entry); }
        self.servers_rev += 1;
        self.persist_servers();
        self.start_remote_lists();
        self.sync_updater(cx);
    }

    /// Dá ao atualizador o servidor ativo (aviso de desatualizado) e o desta máquina ("Atualizar tudo"), este só loopback:
    /// sem o recuo para o servidor ativo do `desktop_api`, que atualizaria outra máquina com o rótulo "desta máquina".
    pub(super) fn sync_updater(&self, cx: &mut Context<Self>) {
        let local = self.api.as_ref().filter(|api| api.is_loopback()).cloned()
            .or_else(|| self.servers.iter().filter(|s| !s.disabled).find_map(|s| Api::new(&s.address, &s.token).ok().filter(Api::is_loopback)));
        let active = self.api.clone().filter(|_| !self.active_invite());
        let Some(updater) = cx.try_global::<crate::update::Handle>().map(|handle| handle.0.clone()) else { return };
        updater.update(cx, |updater, cx| updater.set_servers(local, active, cx));
    }

    /// Só as máquinas do app Electron; a aparência é o Importar das configurações que traz.
    pub(super) fn adopt_electron_servers(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let base = crate::appearance::get();
        let (done, result) = tokio::sync::oneshot::channel();
        self.runtime.spawn_blocking(move || { let _ = done.send(crate::electron::load(base).map(|imported| imported.servers)); });
        cx.spawn_in(window, async move |this, cx| {
            let result = result.await.unwrap_or_else(|_| Err(crate::electron::Failure::Read(tr("electron_import_stopped"))));
            let _ = this.update_in(cx, |this, window, cx| {
                match result {
                    Ok(list) => this.merge_servers(list, cx),
                    // Sem app Electron neste computador não há o que adotar.
                    Err(crate::electron::Failure::Missing) => {}
                    Err(crate::electron::Failure::Read(reason)) => window.push_notification(
                        Notification::warning(tr("electron_import_failed").replace("{reason}", &reason)), cx),
                }
                cx.notify();
            });
        }).detach();
    }

    pub(super) fn persist_servers(&self) {
        let (address, token) = (self.server.clone().unwrap_or_default(), self.active_token.clone());
        if address.is_empty() || token.is_empty() { return; }
        let (servers, connection, tx) = (self.servers.clone(), self.connection, self.tx.clone());
        self.runtime.spawn(async move {
            let saved = tokio::task::spawn_blocking(move || save_connection(&address, &token, &servers).map_err(|e| e.to_string())).await;
            if let Err(error) = saved.map_err(|e| e.to_string()).and_then(|r| r) {
                let _ = tx.send(Envelope { connection, selection: None, payload: Payload::ConnectionNotSaved(error) }).await;
            }
        });
    }

    /// As máquinas ligadas, para os seletores de máquina da Nova sessão.
    pub(super) fn server_choices(&self) -> Vec<super::create::ServerChoice> {
        self.servers.iter().filter(|s| !s.disabled).map(|s| {
            let key = norm(&s.address);
            let offline = self.remote.get(&key).is_some_and(|l| l.error.is_some());
            super::create::ServerChoice { key, label: s.label.clone(), address: s.address.clone(), token: s.token.clone(), offline }
        }).collect()
    }

    /// Paleta e papel de parede são desta máquina, como no web (o Hangar da própria origem): com outra máquina ativa, pede ao
    /// servidor local da lista.
    pub(super) fn desktop_api(&self) -> Option<Api> {
        if let Some(api) = self.api.as_ref().filter(|api| api.is_loopback()) { return Some(api.clone()); }
        self.servers.iter().filter(|s| !s.disabled).find_map(|s| Api::new(&s.address, &s.token).ok().filter(Api::is_loopback))
            .or_else(|| self.api.clone())
    }

    /// Cabeçalho do bloco de uma máquina, como o do web: seta, ponto na cor da máquina, nome em caixa alta e a contagem numa
    /// pílula. Clicar recolhe; a falha vem por extenso embaixo.
    pub(super) fn render_server_header(&self, id: &str, key: &str, label: &str, count: usize, invite: bool, error: Option<String>, cx: &mut Context<Self>) -> AnyElement {
        let group = format!("server:{key}");
        let open = !self.sidebar.is_collapsed(&group);
        div().id(SharedString::from(format!("server-header-{key}"))).flex_shrink_0().mt(px(8.)).px(px(8.)).py(px(4.)).rounded(px(8.))
            .flex().flex_col().gap(px(2.)).cursor_pointer().text_color(theme::faint()).hover(|el| el.text_color(theme::muted()))
            .role(Role::Button).aria_expanded(open).aria_label(format!("{label} · {count}"))
            .child(div().flex().items_center().gap(px(8.))
                .child(chrome::small_icon(if open { IconName::ChevronDown } else { IconName::ChevronRight }, 12., theme::faint()))
                .child(div().size(px(7.)).flex_shrink_0().rounded_full().bg(theme::server_color(id)))
                .child(div().flex_1().min_w_0().truncate().text_size(px(11.)).font_weight(FontWeight::BOLD).child(label.to_uppercase()))
                .when(invite, |el| el.child(div().flex_shrink_0().px(px(6.)).rounded_full().bg(theme::accent_dim())
                    .text_size(px(10.5)).text_color(theme::accent_text()).child(tr("invite_badge"))))
                .when(count > 0, |el| el.child(div().flex_shrink_0().min_w(px(18.)).px(px(6.)).rounded_full().bg(theme::inset())
                    .flex().justify_center().text_size(px(11.)).font_weight(FontWeight::SEMIBOLD).child(count.to_string()))))
            .when_some(error, |el, text| el.child(div().pl(px(24.)).text_xs().text_color(theme::warning()).truncate().child(text)))
            .on_click(cx.listener(move |this, _, _, cx| this.toggle_group(group.clone(), cx)))
            .into_any_element()
    }

    /// Com mais de uma máquina, a barra separa por servidor (o "Servidor" padrão do web); a ativa vem na ordem da lista.
    pub(super) fn multi_server(&self) -> bool { !self.remote.is_empty() }
}

#[cfg(test)]
mod tests {
    use super::*;
    // O glob pode trazer o `test` da gpui, que colide com o atributo padrão; o nome explícito vence o glob.
    use core::prelude::v1::test;

    #[test]
    fn upsert_matches_same_machine_and_keeps_label() {
        let entry = |label: &str, address: &str, token: &str| ServerEntry { id: "x".into(), label: label.into(), address: address.into(), token: token.into(), disabled: false, invite: false };
        let mut list = vec![entry("PC", "http://127.0.0.1:8765", "a")];
        upsert(&mut list, entry("", "http://127.0.0.1:8765/", "b"));
        upsert(&mut list, entry("notebook", "https://notebook.ts.net", "c"));
        assert_eq!(list.len(), 2);
        assert_eq!((list[0].label.as_str(), list[0].token.as_str()), ("PC", "b"));
        assert_eq!(default_label("https://notebook-jefferson.tailcac351.ts.net"), "notebook-jefferson");
    }

    #[test]
    fn invite_flag_survives_the_plain_upsert_of_the_first_connection() {
        let mut list = vec![ServerEntry { id: "i".into(), label: "Convite · Jefferson".into(), address: "https://h:8443".into(),
            token: "g".into(), disabled: false, invite: true }];
        // O `Sessions(Ok)` da conexão faz upsert sem a marca: ela não pode cair.
        upsert(&mut list, ServerEntry { id: "x".into(), label: String::new(), address: "https://h:8443/".into(),
            token: "g".into(), disabled: false, invite: false });
        assert!(list[0].invite);
        let old: ServerEntry = serde_json::from_str(r#"{"id":"a","label":"PC","address":"http://127.0.0.1:8765","token":"t"}"#).unwrap();
        assert!(!old.invite);
    }
}
