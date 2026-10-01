//! Convidados (Sincronização): o mesmo cadastro do web, no mesmo formato, pra um lado editar o que o outro gravou. A conta
//! do convidado mora no hub; o acesso, em cada servidor escolhido, criado com o token do dono daquele servidor.
use super::*;
use super::sync::{PBKDF2_ITERATIONS, decrypt_json, derive_keys, encrypt_json, random, sync_field};
use super::settings::Page;
use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicU64, Ordering};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct GuestServer { server_id: String, guest_id: String, token: String, root: String }

/// O `admin_blob`, cifrado com a chave do dono: a senha fica junto pra editar sem pedi-la de novo.
#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct GuestAdmin { user: String, password: String, sees_owner: bool, owner_sees: bool, servers: Vec<GuestServer> }

// À mão pra a senha nunca ir parar num log ou numa mensagem de teste.
impl std::fmt::Debug for GuestAdmin {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("GuestAdmin").field("user", &self.user).field("sees_owner", &self.sees_owner)
            .field("owner_sees", &self.owner_sees).field("servers", &self.servers).finish_non_exhaustive()
    }
}

/// Servidor da lista do dono, como o cofre guarda. `base_url` vazio é o próprio hub.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct OwnerServer {
    id: String,
    #[serde(default)] label: String,
    #[serde(default)] base_url: String,
    #[serde(default)] token: String,
    #[serde(default)] invite: bool,
}

struct Draft { user: String, password: String, sees_owner: bool, owner_sees: bool, servers: Vec<(String, String)> }

#[derive(Clone, Debug, PartialEq)]
pub(super) struct ServerFailure { label: String, message: String }

/// `expired`: o hub recusou o cookie (401); a sessão caiu e a página volta pra entrada.
pub(super) struct SaveOutcome { saved: GuestAdmin, errors: Vec<ServerFailure>, hub_failed: bool, expired: bool }

/// Sessão do dono no hub: só em memória, some ao sair da página.
#[derive(Clone)]
pub(super) struct Session { user: String, cookie: String, key: [u8; 32], servers: Vec<OwnerServer> }

trait GuestOps {
    async fn create(&self, server: &OwnerServer, draft: &Draft, root: &str) -> Result<(String, String), Failure>;
    async fn update(&self, server: &OwnerServer, id: &str, draft: &Draft, root: &str) -> Result<(), Failure>;
    async fn delete(&self, server: &OwnerServer, id: &str) -> Result<(), Failure>;
    async fn put_hub(&self, saved: &GuestAdmin, servers: Value) -> Result<(), Failure>;
    async fn delete_hub(&self, user: &str) -> Result<(), Failure>;
}

fn describe(error: &Failure) -> String { Hangar::setting_failure(error) }

fn hub_message(error: &Failure) -> String {
    match error.status {
        Some(401) => tr_shared("erro_nao_autorizado", &[]),
        Some(403) => tr_shared("erro_so_dono", &[]),
        _ => describe(error),
    }
}

fn validate(draft: &Draft, editing: bool, owner: &str, guests: &[GuestAdmin]) -> Option<&'static str> {
    let name = draft.user.as_str();
    if name.is_empty() { return Some("convidados_usuario_obrigatorio"); }
    // O hub recusa "/" depois de os servidores já terem criado o convidado.
    if name.contains('/') { return Some("convidados_usuario_barra"); }
    // Nome repetido sobrescreveria outro convidado (ou bateria no dono) depois de já ter criado acesso nos servidores.
    if !editing && (name == owner || guests.iter().any(|g| g.user == name)) { return Some("convidados_usuario_em_uso"); }
    if draft.password.chars().count() < 8 { return Some("sync_password_min"); }
    if draft.servers.is_empty() { return Some("convidados_servidor_obrigatorio"); }
    if draft.servers.iter().any(|(_, root)| root.is_empty()) { return Some("convidados_pasta_obrigatoria"); }
    None
}

async fn save_guest(ops: &impl GuestOps, owner: &[OwnerServer], draft: &Draft, prev: Option<&GuestAdmin>) -> SaveOutcome {
    let find = |id: &str| owner.iter().find(|s| s.id == id);
    let before = |id: &str| prev.and_then(|p| p.servers.iter().find(|s| s.server_id == id));
    let gone = |error: &Failure| error.status == Some(404);
    let away = |label: &str| ServerFailure { label: label.to_owned(), message: tr_shared("convidados_servidor_fora_da_lista", &[]) };
    let (mut kept, mut errors) = (Vec::new(), Vec::new());
    for (id, root) in &draft.servers {
        let old = before(id);
        let Some(server) = find(id) else {
            // Sem o servidor na lista não dá pra agir nele; o token antigo fica no cadastro.
            errors.push(away(id));
            if let Some(old) = old { kept.push(old.clone()); }
            continue;
        };
        let create = || async {
            ops.create(server, draft, root).await
                .map(|(guest_id, token)| GuestServer { server_id: id.clone(), guest_id, token, root: root.clone() })
        };
        let result = match old {
            None => create().await,
            Some(old) => match ops.update(server, &old.guest_id, draft, root).await {
                Ok(()) => Ok(GuestServer { root: root.clone(), ..old.clone() }),
                // Sumiu no servidor: recria em vez de ficar com um id morto.
                Err(error) if gone(&error) => create().await,
                Err(error) => Err(error),
            },
        };
        match result {
            Ok(entry) => kept.push(entry),
            Err(error) => {
                errors.push(ServerFailure { label: server.label.clone(), message: describe(&error) });
                if let Some(old) = old { kept.push(old.clone()); }
            }
        }
    }
    for old in prev.map_or(&[][..], |p| &p.servers) {
        if draft.servers.iter().any(|(id, _)| *id == old.server_id) { continue; }
        let Some(server) = find(&old.server_id) else {
            errors.push(away(&old.server_id));
            kept.push(old.clone());
            continue;
        };
        match ops.delete(server, &old.guest_id).await {
            Ok(()) => {}
            Err(error) if gone(&error) => {} // já removido
            Err(error) => {
                // Fica no cadastro pra poder tentar remover de novo.
                errors.push(ServerFailure { label: server.label.clone(), message: describe(&error) });
                kept.push(old.clone());
            }
        }
    }
    let saved = GuestAdmin { user: draft.user.clone(), password: draft.password.clone(), sees_owner: draft.sees_owner,
        owner_sees: draft.owner_sees, servers: kept };
    // O endereço vai como está na lista do dono, inclusive vazio: o app do convidado resolve igual ao do dono.
    let list = saved.servers.iter().filter_map(|k| find(&k.server_id)
        .map(|s| json!({"id": s.id, "label": s.label, "baseUrl": s.base_url, "token": k.token}))).collect();
    if let Err(error) = ops.put_hub(&saved, Value::Array(list)).await {
        // Os servidores já mudaram: `saved` volta pro formulário e salvar de novo repete com ele, sem duplicar.
        errors.push(ServerFailure { label: tr_shared("sync_config_titulo", &[]), message: hub_message(&error) });
        return SaveOutcome { saved, errors, hub_failed: true, expired: error.status == Some(401) };
    }
    SaveOutcome { saved, errors, hub_failed: false, expired: false }
}

/// Devolve as falhas e se o hub recusou o cookie (401).
async fn remove_guest(ops: &impl GuestOps, owner: &[OwnerServer], guest: &GuestAdmin) -> (Vec<ServerFailure>, bool) {
    let draft = Draft { user: guest.user.clone(), password: guest.password.clone(), sees_owner: guest.sees_owner,
        owner_sees: guest.owner_sees, servers: Vec::new() };
    let out = save_guest(ops, owner, &draft, Some(guest)).await;
    // Só apaga a conta do hub quando todos os servidores largaram o acesso e o hub aceitou a gravação.
    if out.saved.servers.is_empty() && !out.hub_failed {
        if let Err(error) = ops.delete_hub(&guest.user).await {
            return (vec![ServerFailure { label: guest.user.clone(), message: hub_message(&error) }], error.status == Some(401));
        }
    }
    (out.errors, out.expired)
}

struct Live { hub: Api, session: Session }

impl Live {
    fn api(&self, server: &OwnerServer) -> Result<Api, Failure> {
        let identity = self.hub.identity();
        Api::new(if server.base_url.is_empty() { &identity } else { &server.base_url }, &server.token)
    }
}

impl GuestOps for Live {
    async fn create(&self, server: &OwnerServer, draft: &Draft, root: &str) -> Result<(String, String), Failure> {
        let body = json!({"name": draft.user, "root": root, "sees_owner": draft.sees_owner, "owner_sees": draft.owner_sees});
        let value = self.api(server)?.server_send(reqwest::Method::POST, &["guests"], Some(body), 30).await?;
        let field = |name: &str| value.get(name).and_then(Value::as_str).map(str::to_owned);
        field("id").zip(field("token")).ok_or_else(|| Failure::local("invalid_response"))
    }

    async fn update(&self, server: &OwnerServer, id: &str, draft: &Draft, root: &str) -> Result<(), Failure> {
        let body = json!({"root": root, "sees_owner": draft.sees_owner, "owner_sees": draft.owner_sees});
        self.api(server)?.server_send(reqwest::Method::POST, &["guests", id], Some(body), 30).await.map(|_| ())
    }

    async fn delete(&self, server: &OwnerServer, id: &str) -> Result<(), Failure> {
        self.api(server)?.server_post(&["guests", id, "delete"], 30).await.map(|_| ())
    }

    async fn put_hub(&self, saved: &GuestAdmin, servers: Value) -> Result<(), Failure> {
        let (saved, key) = (saved.clone(), self.session.key);
        // PBKDF2 com 600 mil voltas: fora das threads do runtime.
        let body = tokio::task::spawn_blocking(move || {
            let salt = random::<16>()?;
            let keys = derive_keys(&saved.password, &salt, PBKDF2_ITERATIONS)?;
            Some(json!({"user": saved.user, "salt": STANDARD.encode(salt), "auth_hash": keys.auth_hash,
                "enc_blob": encrypt_json(&keys.enc, &servers)?, "admin_blob": encrypt_json(&key, &saved)?}))
        }).await.ok().flatten().ok_or_else(|| Failure::local("sync_config_erro"))?;
        self.hub.hub(reqwest::Method::POST, &["sync", "guests"], &[], Some(body), Some(&self.session.cookie), 30).await.map(|_| ())
    }

    async fn delete_hub(&self, user: &str) -> Result<(), Failure> {
        match self.hub.hub(reqwest::Method::POST, &["sync", "guests", user, "delete"], &[], None, Some(&self.session.cookie), 30).await {
            Err(error) if error.status != Some(404) => Err(error),
            _ => Ok(()),
        }
    }
}

async fn load_guests(hub: &Api, session: &Session) -> Result<Vec<GuestAdmin>, Failure> {
    let (rows, _) = hub.hub(reqwest::Method::GET, &["sync", "guests"], &[], None, Some(&session.cookie), 15).await?;
    rows.as_array().ok_or_else(|| Failure::local("invalid_response"))?.iter()
        .map(|row| row.get("admin_blob").and_then(|blob| decrypt_json(&session.key, blob)).ok_or_else(|| Failure::local("invalid_response")))
        .collect()
}

/// Entra no hub como o web: prelogin → chaves → login (cookie) → cofre com a lista de servidores do dono.
async fn open_session(hub: &Api, user: String, password: String) -> Result<Session, String> {
    let get = |path: &'static [&'static str], query: Vec<(&'static str, String)>| {
        let hub = hub.clone();
        async move {
            let query: Vec<(&str, &str)> = query.iter().map(|(k, v)| (*k, v.as_str())).collect();
            hub.hub(reqwest::Method::GET, path, &query, None, None, 15).await
        }
    };
    let (pre, _) = get(&["sync", "prelogin"], vec![("user", user.clone())]).await.map_err(|e| describe(&e))?;
    let salt = pre.get("salt").and_then(Value::as_str).and_then(|s| STANDARD.decode(s).ok());
    let iterations = pre.get("iterations").and_then(Value::as_u64).and_then(|n| u32::try_from(n).ok());
    let (Some(salt), Some(iterations)) = (salt, iterations) else { return Err(tr("invalid_response")) };
    let keys = tokio::task::spawn_blocking(move || derive_keys(&password, &salt, iterations)).await.ok().flatten()
        .ok_or_else(|| tr("invalid_response"))?;
    let login = hub.hub(reqwest::Method::POST, &["sync", "login"], &[], Some(json!({"user": user, "auth_hash": keys.auth_hash})), None, 15).await;
    let cookie = match login {
        Ok((_, Some(cookie))) => cookie,
        Ok((_, None)) => return Err(tr("invalid_response")),
        Err(error) if error.status == Some(401) => return Err(tr_shared("sync_credenciais_invalidas", &[])),
        Err(error) if error.status == Some(429) => return Err(tr_shared("sync_muitas_tentativas", &[])),
        Err(error) => return Err(describe(&error)),
    };
    let (vault, _) = hub.hub(reqwest::Method::GET, &["sync", "vault"], &[], None, Some(&cookie), 15).await.map_err(|e| hub_message(&e))?;
    let servers: Vec<OwnerServer> = match vault.get("enc_blob") {
        None | Some(Value::Null) => Vec::new(),
        Some(blob) => decrypt_json(&keys.enc, blob).ok_or_else(|| tr("invalid_response"))?,
    };
    // Convite fica só no aparelho que resgatou: não é servidor do dono pra dar acesso.
    Ok(Session { user, cookie, key: keys.enc, servers: servers.into_iter().filter(|s| !s.invite).collect() })
}

struct LoginForm { user: Entity<InputState>, password: Entity<InputState>, _subscriptions: Vec<Subscription> }

struct GuestForm {
    editing: Option<GuestAdmin>,
    user: Entity<InputState>,
    password: Entity<InputState>,
    sees_owner: bool,
    owner_sees: bool,
    // Servidor marcado = tem pasta aqui; a ordem é a da marcação, como no web.
    roots: Vec<(String, Entity<InputState>)>,
    error: Option<String>,
}

#[derive(Default)]
pub(in crate::app) struct Guests {
    login: Option<LoginForm>,
    login_error: Option<String>,
    session: Option<Session>,
    list: Option<Result<Vec<GuestAdmin>, String>>,
    /// Pedido em voo; a resposta só vale se for deste número.
    waiting: Option<u64>,
    form: Option<GuestForm>,
    failures: Vec<ServerFailure>,
    saved_ok: bool,
    /// Cadastro salvo nos servidores cujo hub recusou o cookie: volta ao formulário depois da nova entrada, pra o próximo
    /// Salvar só atualizar (sem isso os acessos já criados ficariam órfãos).
    pending: Option<GuestAdmin>,
}

impl Guests {
    /// Aplica o resultado de um Salvar; `true` quando a sessão do hub caiu e a página deve voltar pra entrada.
    fn apply_saved(&mut self, SaveOutcome { saved, errors, expired, .. }: SaveOutcome) -> bool {
        self.failures = errors;
        if expired {
            self.pending = Some(saved);
            return true;
        }
        if let Some(Ok(list)) = self.list.as_mut() {
            list.retain(|g| g.user != saved.user);
            list.push(saved.clone());
        }
        // Com falha parcial o formulário fica aberto e salvar de novo repete só o que faltou.
        if let Some(form) = self.form.as_mut() { form.editing = Some(saved); }
        self.saved_ok = self.failures.is_empty();
        if self.saved_ok { self.form = None; }
        false
    }
}

pub(super) enum GuestsReply {
    LoggedIn(u64, Result<(Session, Result<Vec<GuestAdmin>, Failure>), String>),
    Loaded(u64, Result<Vec<GuestAdmin>, Failure>),
    Saved(u64, SaveOutcome),
    Removed(u64, Vec<ServerFailure>, bool),
}

// Número global: a página zera o estado ao sair, e uma resposta antiga não pode casar com o pedido novo.
fn ticket() -> u64 {
    static NEXT: AtomicU64 = AtomicU64::new(1);
    NEXT.fetch_add(1, Ordering::Relaxed)
}

impl Hangar {
    fn guests_send_later(&self) -> impl Fn(GuestsReply) -> std::pin::Pin<Box<dyn Future<Output = ()> + Send>> + Send + 'static {
        let (tx, connection) = (self.tx.clone(), self.connection);
        move |reply| {
            let tx = tx.clone();
            Box::pin(async move {
                let payload = Payload::Sync(super::sync::SyncReply::Guests(reply));
                let _ = tx.send(Envelope { connection, selection: None, payload }).await;
            })
        }
    }

    /// Formulário de entrada do dono, criado quando a página mostra a seção e ainda não há sessão.
    pub(super) fn guests_login_form(&mut self, owner: Option<&str>, window: &mut Window, cx: &mut Context<Self>) {
        let guests = &mut self.sync.guests;
        if guests.login.is_some() || guests.session.is_some() || self.settings != Some(Page::Sync) { return; }
        let owner = owner.unwrap_or_default().to_owned();
        let user = cx.new(|cx| InputState::new(window, cx).default_value(owner));
        let password = cx.new(|cx| InputState::new(window, cx).masked(true));
        let subscriptions = [&user, &password].map(|input| cx.subscribe_in(input, window,
            |this: &mut Hangar, _, event: &InputEvent, _, cx| {
                if matches!(event, InputEvent::PressEnter { .. }) { this.guests_login(cx); }
            }));
        guests.login = Some(LoginForm { user, password, _subscriptions: subscriptions.into() });
    }

    fn guests_login(&mut self, cx: &mut Context<Self>) {
        let (Some(api), Some(form)) = (self.api.clone(), self.sync.guests.login.as_ref()) else { return };
        if self.sync.guests.waiting.is_some() { return; }
        let user = form.user.read(cx).value().trim().to_string();
        let password = form.password.read(cx).value().to_string();
        if user.is_empty() { self.sync.guests.login_error = Some(tr_shared("convidados_usuario_obrigatorio", &[])); cx.notify(); return; }
        let seq = ticket();
        (self.sync.guests.waiting, self.sync.guests.login_error) = (Some(seq), None);
        let done = self.guests_send_later();
        self.runtime.spawn(async move {
            let result = match open_session(&api, user, password).await {
                Ok(session) => { let list = load_guests(&api, &session).await; Ok((session, list)) }
                Err(error) => Err(error),
            };
            done(GuestsReply::LoggedIn(seq, result)).await
        });
        cx.notify();
    }

    fn guests_reload(&mut self, cx: &mut Context<Self>) {
        let (Some(api), Some(session)) = (self.api.clone(), self.sync.guests.session.clone()) else { return };
        if self.sync.guests.waiting.is_some() { return; }
        let seq = ticket();
        (self.sync.guests.waiting, self.sync.guests.list) = (Some(seq), None);
        let done = self.guests_send_later();
        self.runtime.spawn(async move { done(GuestsReply::Loaded(seq, load_guests(&api, &session).await)).await });
        cx.notify();
    }

    fn guests_open(&mut self, guest: Option<GuestAdmin>, window: &mut Window, cx: &mut Context<Self>) {
        let input = |value: String, masked: bool, window: &mut Window, cx: &mut Context<Self>|
            cx.new(|cx| InputState::new(window, cx).masked(masked).default_value(value));
        let user = input(guest.as_ref().map(|g| g.user.clone()).unwrap_or_default(), false, window, cx);
        let password = input(guest.as_ref().map(|g| g.password.clone()).unwrap_or_default(), true, window, cx);
        let roots = guest.iter().flat_map(|g| &g.servers).map(|s| (s.server_id.clone(), input(s.root.clone(), false, window, cx))).collect();
        let guests = &mut self.sync.guests;
        guests.form = Some(GuestForm { sees_owner: guest.as_ref().is_some_and(|g| g.sees_owner),
            owner_sees: guest.as_ref().is_none_or(|g| g.owner_sees), editing: guest, user, password, roots, error: None });
        (guests.failures, guests.saved_ok) = (Vec::new(), false);
        cx.notify();
    }

    fn guests_toggle(&mut self, id: String, on: bool, window: &mut Window, cx: &mut Context<Self>) {
        let Some(form) = self.sync.guests.form.as_mut() else { return };
        if !on { form.roots.retain(|(server, _)| *server != id); }
        else if !form.roots.iter().any(|(server, _)| *server == id) { form.roots.push((id, cx.new(|cx| InputState::new(window, cx)))); }
        cx.notify();
    }

    fn guests_submit(&mut self, cx: &mut Context<Self>) {
        let (Some(api), Some(session)) = (self.api.clone(), self.sync.guests.session.clone()) else { return };
        let guests = &mut self.sync.guests;
        let Some(form) = guests.form.as_mut() else { return };
        if guests.waiting.is_some() { return; }
        let draft = Draft { user: form.user.read(cx).value().trim().to_string(), password: form.password.read(cx).value().to_string(),
            sees_owner: form.sees_owner, owner_sees: form.owner_sees,
            servers: form.roots.iter().map(|(id, root)| (id.clone(), root.read(cx).value().trim().to_string())).collect() };
        let list = guests.list.as_ref().and_then(|l| l.as_ref().ok()).map_or(&[][..], Vec::as_slice);
        form.error = validate(&draft, form.editing.is_some(), &session.user, list).map(|key| tr_shared(key, &[]));
        if form.error.is_some() { cx.notify(); return; }
        let prev = form.editing.clone();
        let seq = ticket();
        guests.waiting = Some(seq);
        let done = self.guests_send_later();
        self.runtime.spawn(async move {
            let live = Live { hub: api, session };
            let outcome = save_guest(&live, &live.session.servers, &draft, prev.as_ref()).await;
            done(GuestsReply::Saved(seq, outcome)).await
        });
        cx.notify();
    }

    fn guests_confirm_remove(&mut self, guest: GuestAdmin, window: &mut Window, cx: &mut Context<Self>) {
        let this = cx.entity().downgrade();
        let text = tr_shared("convidados_remover_aviso", &[("usuario", &guest.user)]);
        chrome::confirm_alert(window, cx, tr_shared("convidados_remover", &[]), text, tr_shared("convidados_remover", &[]),
            ButtonVariant::Danger, move |_, cx| {
                let guest = guest.clone();
                let _ = this.update(cx, |this, cx| this.guests_remove(guest, cx));
                true
            });
    }

    fn guests_remove(&mut self, guest: GuestAdmin, cx: &mut Context<Self>) {
        let (Some(api), Some(session)) = (self.api.clone(), self.sync.guests.session.clone()) else { return };
        if self.sync.guests.waiting.is_some() { return; }
        let seq = ticket();
        (self.sync.guests.waiting, self.sync.guests.saved_ok) = (Some(seq), false);
        let done = self.guests_send_later();
        self.runtime.spawn(async move {
            let live = Live { hub: api, session };
            let (errors, expired) = remove_guest(&live, &live.session.servers, &guest).await;
            done(GuestsReply::Removed(seq, errors, expired)).await
        });
        cx.notify();
    }

    /// Lista lida: 401 é a sessão do hub que caiu e 403 é usuário que não é o dono; os dois voltam pra entrada.
    fn guests_loaded(&mut self, result: Result<Vec<GuestAdmin>, Failure>, window: &mut Window, cx: &mut Context<Self>) {
        let guests = &mut self.sync.guests;
        match result {
            Err(error) if matches!(error.status, Some(401 | 403)) => {
                self.guests_expired(window, cx);
                self.sync.guests.login_error = (error.status == Some(403)).then(|| tr_shared("erro_so_dono", &[]));
            }
            result => guests.list = Some(result.map_err(|error| describe(&error))),
        }
    }

    pub(super) fn receive_guests(&mut self, reply: GuestsReply, window: &mut Window, cx: &mut Context<Self>) {
        let seq = match &reply {
            GuestsReply::LoggedIn(seq, _) | GuestsReply::Loaded(seq, _) | GuestsReply::Saved(seq, _) | GuestsReply::Removed(seq, ..) => *seq,
        };
        if self.sync.guests.waiting != Some(seq) { return; }
        self.sync.guests.waiting = None;
        match reply {
            GuestsReply::LoggedIn(_, Err(error)) => self.sync.guests.login_error = Some(error),
            GuestsReply::LoggedIn(_, Ok((session, list))) => {
                let guests = &mut self.sync.guests;
                (guests.session, guests.login, guests.login_error) = (Some(session), None, None);
                self.guests_loaded(list, window, cx);
                if self.sync.guests.session.is_some() && let Some(pending) = self.sync.guests.pending.take() {
                    let failures = std::mem::take(&mut self.sync.guests.failures);
                    self.guests_open(Some(pending), window, cx);
                    self.sync.guests.failures = failures;
                }
            }
            GuestsReply::Loaded(_, list) => self.guests_loaded(list, window, cx),
            // Cookie vencido: sem voltar pra entrada, salvar falharia pra sempre até sair da página.
            GuestsReply::Saved(_, outcome) => if self.sync.guests.apply_saved(outcome) { self.guests_expired(window, cx); },
            GuestsReply::Removed(_, errors, true) => {
                self.guests_expired(window, cx);
                self.sync.guests.failures = errors;
            }
            GuestsReply::Removed(_, errors, _) => {
                self.sync.guests.failures = errors;
                self.guests_reload(cx);
            }
        }
        cx.notify();
    }

    fn guests_expired(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let guests = &mut self.sync.guests;
        (guests.session, guests.list, guests.form, guests.saved_ok) = (None, None, None, false);
        let owner = self.sync.owner();
        self.guests_login_form(owner.as_deref(), window, cx);
    }

    pub(super) fn render_guests(&mut self, cx: &mut Context<Self>) -> Div {
        let guests = &self.sync.guests;
        let busy = guests.waiting.is_some();
        let mut section = div().flex().flex_col().gap_3().pt_2()
            .child(div().text_lg().font_weight(FontWeight::SEMIBOLD).child(tr_shared("convidados_titulo", &[])))
            .child(div().text_sm().text_color(theme::muted()).whitespace_normal().child(tr_shared("convidados_descricao", &[])));
        let alert = |id: SharedString, text: String| div().id(id).role(Role::Alert).text_sm().text_color(theme::danger()).whitespace_normal().child(text);
        // Antes da entrada também: a queda da sessão no meio de um Salvar não pode sumir calada.
        for (n, failure) in guests.failures.iter().enumerate() {
            section = section.child(alert(SharedString::from(format!("guests-failure-{n}")),
                tr_shared("convidados_falha_servidor", &[("servidor", &failure.label), ("erro", &failure.message)])));
        }
        let Some(session) = &guests.session else {
            let Some(form) = &guests.login else { return section };
            return section.child(div().text_sm().text_color(theme::muted()).whitespace_normal().child(tr_shared("convidados_entrar_nativo", &[])))
                .child(sync_field(tr("login_usuario"), &form.user, busy))
                .child(sync_field(tr("login_senha"), &form.password, busy))
                .when_some(guests.login_error.clone(), |el, error| el.child(alert("guests-login-error".into(), error)))
                .child(Button::new("guests-login").primary().small().label(tr_shared("login_entrar", &[])).disabled(busy).loading(busy)
                    .on_click(cx.listener(|this, _, _, cx| this.guests_login(cx))));
        };
        if guests.saved_ok {
            section = section.child(div().id("guests-saved").role(Role::Status).text_sm().font_weight(FontWeight::SEMIBOLD).child(tr_shared("convidados_salvo", &[])));
        }
        let list = match &guests.list {
            None => return section.child(div().id("guests-loading").role(Role::Status).text_sm().text_color(theme::muted()).child(tr_shared("comum_carregando", &[]))),
            Some(Err(error)) => return section.child(alert("guests-load-error".into(), tr_shared("convidados_erro", &[("erro", error)])))
                .child(Button::new("guests-retry").outline().small().label(tr_shared("lista_tentar_novamente", &[]))
                    .on_click(cx.listener(|this, _, _, cx| this.guests_reload(cx)))),
            Some(Ok(list)) => list,
        };
        if list.is_empty() {
            section = section.child(div().text_sm().text_color(theme::muted()).child(tr_shared("convidados_vazio", &[])));
        }
        for guest in list {
            let (edit, remove) = (guest.clone(), guest.clone());
            let count = guest.servers.len().to_string();
            section = section.child(div().flex().items_center().gap_3().px_3().py_2().rounded(px(8.)).border_1().border_color(theme::border())
                .child(div().font_weight(FontWeight::SEMIBOLD).truncate().child(guest.user.clone()))
                .child(div().flex_1().min_w_0().text_sm().text_color(theme::muted()).truncate()
                    .child(tr_shared("convidados_resumo", &[("servidores", &count)])))
                .child(Button::new(SharedString::from(format!("guests-edit-{}", guest.user))).outline().small()
                    .label(tr_shared("convidados_editar", &[])).disabled(busy)
                    .on_click(cx.listener(move |this, _, window, cx| this.guests_open(Some(edit.clone()), window, cx))))
                .child(Button::new(SharedString::from(format!("guests-remove-{}", guest.user))).outline().small()
                    .label(tr_shared("convidados_remover", &[])).disabled(busy)
                    .on_click(cx.listener(move |this, _, window, cx| this.guests_confirm_remove(remove.clone(), window, cx)))));
        }
        let Some(form) = &guests.form else {
            return section.child(Button::new("guests-add").outline().small().label(tr_shared("convidados_adicionar", &[])).disabled(busy)
                .on_click(cx.listener(|this, _, window, cx| this.guests_open(None, window, cx))));
        };
        let mut servers = div().flex().flex_col().gap_2().p_3().rounded(px(8.)).border_1().border_color(theme::border())
            .child(div().text_sm().font_weight(FontWeight::MEDIUM).child(tr_shared("convidados_servidores", &[])));
        for server in &session.servers {
            let root = form.roots.iter().find(|(id, _)| *id == server.id).map(|(_, input)| input);
            let id = server.id.clone();
            servers = servers.child(Checkbox::new(SharedString::from(format!("guests-server-{}", server.id))).small()
                .label(server.label.clone()).checked(root.is_some()).disabled(busy)
                .on_click(cx.listener(move |this, on: &bool, window, cx| this.guests_toggle(id.clone(), *on, window, cx))))
                .when_some(root, |el, input| el.child(sync_field(tr_shared("convidados_pasta", &[("servidor", &server.label)]), input, busy)));
        }
        section.child(div().flex().flex_col().gap_3()
            .child(sync_field(tr("login_usuario"), &form.user, busy || form.editing.is_some()))
            .child(sync_field(tr("login_senha"), &form.password, busy))
            .child(Checkbox::new("guests-sees-owner").small().label(tr_shared("convidados_ve_minhas", &[])).checked(form.sees_owner).disabled(busy)
                .on_click(cx.listener(|this, on: &bool, _, cx| {
                    if let Some(form) = this.sync.guests.form.as_mut() { form.sees_owner = *on; }
                    cx.notify();
                })))
            .child(Checkbox::new("guests-owner-sees").small().label(tr_shared("convidados_eu_vejo", &[])).checked(form.owner_sees).disabled(busy)
                .on_click(cx.listener(|this, on: &bool, _, cx| {
                    if let Some(form) = this.sync.guests.form.as_mut() { form.owner_sees = *on; }
                    cx.notify();
                })))
            .child(servers)
            .when_some(form.error.clone(), |el, error| el.child(alert("guests-form-error".into(), error)))
            .child(div().flex().gap_2()
                .child(Button::new("guests-save").primary().small().disabled(busy).loading(busy)
                    .label(tr_shared(if busy { "convidados_salvando" } else { "convidados_salvar" }, &[]))
                    .on_click(cx.listener(|this, _, _, cx| this.guests_submit(cx))))
                .child(Button::new("guests-cancel").outline().small().label(tr_shared("comum_cancelar", &[])).disabled(busy)
                    .on_click(cx.listener(|this, _, _, cx| { this.sync.guests.form = None; cx.notify(); })))))
    }
}

#[cfg(test)]
mod tests {
    // Sem glob: o `test` do gpui_kit, que o `super::*` traz, esconderia o `#[test]` da linguagem.
    use super::{Draft, Failure, GuestAdmin, GuestOps, GuestServer, Guests, OwnerServer, SaveOutcome, ServerFailure, STANDARD, decrypt_json, derive_keys, encrypt_json,
        remove_guest, save_guest, validate};
    use base64::Engine as _;
    use crate::i18n::tr_shared;
    use serde_json::{Value, json};
    use std::cell::RefCell;

    #[test]
    fn keys_match_the_web_derivation() {
        // Vetor calculado com o `deriveKeys` do web (WebCrypto no Node) pra mesma senha, sal e voltas.
        let keys = derive_keys("senha-teste", b"0123456789abcdef", 1000).unwrap();
        assert_eq!(keys.auth_hash, WEB_AUTH_HASH);
        let blob = encrypt_json(&keys.enc, &json!({"a": 1})).unwrap();
        assert_eq!(decrypt_json::<Value>(&keys.enc, &blob).unwrap(), json!({"a": 1}));
        assert_eq!(STANDARD.decode(blob["iv"].as_str().unwrap()).unwrap().len(), 12);
        // Cifrado pelo web com a chave `cp-enc` desta senha.
        assert_eq!(decrypt_json::<Value>(&keys.enc, &json!({"iv": WEB_IV, "data": WEB_DATA})).unwrap(), json!({"web": true}));
    }

    const WEB_AUTH_HASH: &str = "fewlsDVCTvVcrbrLvNFlw10sAtj5G+YyqW3dt+XxYeg=";
    const WEB_IV: &str = "JQty6M7zR3xv37QM";
    const WEB_DATA: &str = "Uud7Id6F3q4oKV0LhFLyMIYDqTe3tsd8pZ5QPQ==";

    #[test]
    fn admin_blob_keeps_the_web_shape() {
        let web = json!({"user": "ana", "password": "12345678", "seesOwner": false, "ownerSees": true,
            "servers": [{"serverId": "srv-1", "guestId": "g1", "token": "t", "root": "/home/ana"}]});
        let admin: GuestAdmin = serde_json::from_value(web.clone()).unwrap();
        assert_eq!(serde_json::to_value(&admin).unwrap(), web);
    }

    fn draft(user: &str, password: &str, servers: &[(&str, &str)]) -> Draft {
        Draft { user: user.into(), password: password.into(), sees_owner: false, owner_sees: true,
            servers: servers.iter().map(|(a, b)| ((*a).into(), (*b).into())).collect() }
    }

    #[test]
    fn validation_follows_the_web_order() {
        let existing = [GuestAdmin { user: "bia".into(), password: "x".into(), sees_owner: false, owner_sees: true, servers: vec![] }];
        let check = |d: Draft, editing| validate(&d, editing, "dono", &existing);
        assert_eq!(check(draft("", "12345678", &[("s", "/")]), false), Some("convidados_usuario_obrigatorio"));
        assert_eq!(check(draft("a/b", "12345678", &[("s", "/")]), false), Some("convidados_usuario_barra"));
        assert_eq!(check(draft("dono", "12345678", &[("s", "/")]), false), Some("convidados_usuario_em_uso"));
        assert_eq!(check(draft("bia", "12345678", &[("s", "/")]), false), Some("convidados_usuario_em_uso"));
        assert_eq!(check(draft("bia", "12345678", &[("s", "/")]), true), None);
        assert_eq!(check(draft("ana", "1234567", &[("s", "/")]), false), Some("sync_password_min"));
        assert_eq!(check(draft("ana", "12345678", &[]), false), Some("convidados_servidor_obrigatorio"));
        assert_eq!(check(draft("ana", "12345678", &[("s", "")]), false), Some("convidados_pasta_obrigatoria"));
    }

    /// Servidores de mentira: `fail` diz que status cada operação devolve por servidor.
    #[derive(Default)]
    struct Fake { fail: Vec<(&'static str, &'static str, u16)>, hub_fails: Option<u16>, calls: RefCell<Vec<String>>, hub: RefCell<Option<Value>> }

    impl Fake {
        fn run(&self, op: &str, server: &str) -> Result<(), Failure> {
            self.calls.borrow_mut().push(format!("{op} {server}"));
            match self.fail.iter().find(|(o, s, _)| *o == op && *s == server) {
                Some((_, _, status)) => Err(Failure { status: Some(*status), detail: "boom".into(), retry_after: None, uncertain: false }),
                None => Ok(()),
            }
        }
    }

    impl GuestOps for Fake {
        async fn create(&self, server: &OwnerServer, _: &Draft, _: &str) -> Result<(String, String), Failure> {
            self.run("create", &server.id).map(|_| (format!("new-{}", server.id), format!("tok-{}", server.id)))
        }
        async fn update(&self, server: &OwnerServer, _: &str, _: &Draft, _: &str) -> Result<(), Failure> { self.run("update", &server.id) }
        async fn delete(&self, server: &OwnerServer, _: &str) -> Result<(), Failure> { self.run("delete", &server.id) }
        async fn put_hub(&self, _: &GuestAdmin, servers: Value) -> Result<(), Failure> {
            *self.hub.borrow_mut() = Some(servers);
            match self.hub_fails {
                Some(status) => Err(Failure { status: Some(status), detail: "boom".into(), retry_after: None, uncertain: false }),
                None => Ok(()),
            }
        }
        async fn delete_hub(&self, user: &str) -> Result<(), Failure> { self.run("delete_hub", user) }
    }

    fn owner() -> Vec<OwnerServer> {
        serde_json::from_value(json!([{"id": "a", "label": "A", "baseUrl": "", "token": "ta"},
            {"id": "b", "label": "B", "baseUrl": "https://b", "token": "tb"}])).unwrap()
    }

    fn entry(id: &str, root: &str) -> GuestServer {
        GuestServer { server_id: id.into(), guest_id: format!("old-{id}"), token: format!("old-tok-{id}"), root: root.into() }
    }

    fn prev(servers: Vec<GuestServer>) -> GuestAdmin {
        GuestAdmin { user: "ana".into(), password: "12345678".into(), sees_owner: false, owner_sees: true, servers }
    }

    #[test]
    fn save_creates_updates_recreates_and_reports() {
        let fake = Fake { fail: vec![("update", "a", 404), ("create", "b", 500)], ..Fake::default() };
        let old = prev(vec![entry("a", "/old"), entry("b", "/b")]);
        // b já existia: o update dele passa; a sumiu no servidor e é recriado.
        let out = futures::executor::block_on(save_guest(&fake, &owner(), &draft("ana", "12345678", &[("a", "/new"), ("b", "/b2")]), Some(&old)));
        assert_eq!(out.errors, vec![]);
        assert_eq!(out.saved.servers, vec![GuestServer { server_id: "a".into(), guest_id: "new-a".into(), token: "tok-a".into(), root: "/new".into() },
            GuestServer { root: "/b2".into(), ..entry("b", "/b") }]);
        // O endereço vazio do hub vai como está.
        assert_eq!(fake.hub.borrow().clone().unwrap(), json!([{"id": "a", "label": "A", "baseUrl": "", "token": "tok-a"},
            {"id": "b", "label": "B", "baseUrl": "https://b", "token": "old-tok-b"}]));
        // Novo em b falha: erro com o rótulo do servidor e nada guardado dele.
        let out = futures::executor::block_on(save_guest(&fake, &owner(), &draft("ana", "12345678", &[("b", "/b")]), None));
        assert_eq!(out.errors.len(), 1);
        assert_eq!(out.errors[0].label, "B");
        assert!(out.saved.servers.is_empty());
    }

    #[test]
    fn save_keeps_entries_it_could_not_touch() {
        let fake = Fake { fail: vec![("delete", "b", 500)], hub_fails: Some(500), ..Fake::default() };
        let old = prev(vec![entry("a", "/a"), entry("b", "/b"), entry("gone", "/g")]);
        let out = futures::executor::block_on(save_guest(&fake, &owner(), &draft("ana", "12345678", &[]), Some(&old)));
        // a removido; b falhou e fica; "gone" saiu da lista do dono e fica; o hub falhou e vira erro, sem estourar.
        assert_eq!(out.saved.servers, vec![entry("b", "/b"), entry("gone", "/g")]);
        assert!(out.hub_failed && !out.expired);
        assert_eq!(out.errors.iter().map(|e| e.label.as_str()).collect::<Vec<_>>(), ["B", "gone", tr_shared("sync_config_titulo", &[]).as_str()]);
    }

    #[test]
    fn remove_deletes_the_hub_account_only_when_everything_let_go() {
        let fake = Fake { fail: vec![("delete", "a", 404)], ..Fake::default() };
        let (errors, expired) = futures::executor::block_on(remove_guest(&fake, &owner(), &prev(vec![entry("a", "/a")])));
        assert!(errors.is_empty() && !expired);
        assert!(fake.calls.borrow().contains(&"delete_hub ana".to_string()));
        let fake = Fake { fail: vec![("delete", "a", 500)], ..Fake::default() };
        let (errors, _) = futures::executor::block_on(remove_guest(&fake, &owner(), &prev(vec![entry("a", "/a")])));
        assert_eq!(errors.len(), 1);
        assert!(!fake.calls.borrow().contains(&"delete_hub ana".to_string()));
    }

    #[test]
    fn hub_refusing_the_cookie_marks_the_session_expired() {
        // Sem isso o formulário ficaria aberto e cada Salvar bateria no mesmo 401.
        let fake = Fake { hub_fails: Some(401), ..Fake::default() };
        let out = futures::executor::block_on(save_guest(&fake, &owner(), &draft("ana", "12345678", &[("a", "/a")]), None));
        assert!(out.hub_failed && out.expired);
        let (_, expired) = futures::executor::block_on(remove_guest(&fake, &owner(), &prev(vec![entry("a", "/a")])));
        assert!(expired);
    }

    #[test]
    fn expired_save_keeps_the_record_for_after_login() {
        let saved = prev(vec![entry("a", "/a")]);
        let failure = ServerFailure { label: "hub".into(), message: "401".into() };
        let mut guests = Guests::default();
        let outcome = SaveOutcome { saved: saved.clone(), errors: vec![failure.clone()], hub_failed: true, expired: true };
        assert!(guests.apply_saved(outcome));
        assert_eq!(guests.pending, Some(saved.clone()));
        assert_eq!(guests.failures, vec![failure]);
        let mut guests = Guests { list: Some(Ok(vec![])), ..Guests::default() };
        assert!(!guests.apply_saved(SaveOutcome { saved: saved.clone(), errors: vec![], hub_failed: false, expired: false }));
        assert!(guests.pending.is_none() && guests.saved_ok);
        assert_eq!(guests.list, Some(Ok(vec![saved])));
    }

    #[test]
    fn debug_hides_the_password() {
        assert!(!format!("{:?}", prev(vec![])).contains("12345678"));
    }
}
