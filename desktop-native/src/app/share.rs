//! "Compartilhar sessão" do dono: gera o link de convite, lista quem entrou e revoga. O link só existe na resposta de quem
//! o gerou (o backend guarda o hash), então ele aparece uma vez, até fechar o diálogo.
use super::*;
use super::device::Remote;
use crate::api::{PairLevel, ShareCreated, ShareEntry, ShareFailure, SharePrereqs};

const WATCH_EVERY: Duration = Duration::from_secs(3);
const WATCH_FOR: Duration = Duration::from_secs(5 * 60);

pub(super) fn whatsapp_url(text: &str) -> String {
    let text: String = url::form_urlencoded::byte_serialize(text.as_bytes()).collect();
    format!("https://wa.me/?text={text}")
}

pub(super) fn when_label(epoch: f64) -> String {
    chrono::DateTime::from_timestamp(epoch as i64, 0).map(|t| t.with_timezone(&chrono::Local).format("%d/%m %H:%M").to_string())
        .unwrap_or_default()
}

/// `Unreachable`: o link do Funnel não abriu de fora no prazo e o servidor já o revogou; gerar de novo é a nova tentativa.
enum Created { Link(ShareCreated), Pair(ShareCreated, PairLevel), Blocked(SharePrereqs), Unreachable { stage: String, detail: String } }

/// Nome do nível como a tela mostra.
pub(super) fn level_label(level: PairLevel) -> String {
    tr_shared(match level { PairLevel::Full => "pair_level_full", PairLevel::View => "pair_level_view" }, &[])
}

/// Com acesso completo, as sessões do grupo que já ficam abertas para a outra pessoa; ver e recado não abre nada.
pub(super) fn opens_line(level: PairLevel, group: &[String]) -> Option<String> {
    (level == PairLevel::Full && !group.is_empty()).then(|| tr_shared("pair_opens_sessions", &[("sessoes", &group.join(", "))]))
}

/// Os dois níveis com a explicação de cada; `pick` roda com o escolhido.
pub(super) fn level_choice<T: 'static>(id: &'static str, title: String, group: &[String], picked: Option<PairLevel>, disabled: bool,
    pick: impl Fn(&mut T, PairLevel, &mut Context<T>) + Clone + 'static, cx: &mut Context<T>) -> Div {
    [PairLevel::Full, PairLevel::View].into_iter().fold(div().flex().flex_col().gap_2()
        .child(div().text_sm().font_weight(FontWeight::SEMIBOLD).whitespace_normal().child(title)), |col, level| {
        let hint = tr_shared(if level == PairLevel::Full { "pair_level_full_hint" } else { "pair_level_view_hint" }, &[]);
        let pick = pick.clone();
        col.child(div().flex().flex_col().gap(px(2.))
            .child(div().child(Button::new((id, level as usize)).small().when(picked == Some(level), |b| b.primary()).label(level_label(level))
                .disabled(disabled).on_click(cx.listener(move |this, _, _, cx| pick(this, level, cx)))))
            .child(div().text_xs().text_color(theme::muted()).whitespace_normal().child(hint))
            .children(opens_line(level, group).map(|line| div().text_xs().text_color(theme::warning()).whitespace_normal().child(line))))
    })
}

/// Só a linha do comando: colar o `fix` inteiro num terminal rodaria também a frase do Funnel.
fn operator_command(p: &SharePrereqs) -> Option<&str> {
    p.missing.iter().any(|m| m == "operator").then(|| p.fix.lines().find(|l| l.contains("--operator=")))?
}

/// O aviso de pré-requisito do túnel (o que falta e como resolver), igual no compartilhar e no aceite de par. `authorize` é o
/// botão que só o compartilhar tem; `on_enable` roda depois de abrir a página do Tailscale.
pub(super) fn prerequisite_notice(id: &'static str, prereqs: &SharePrereqs, authorize: Option<AnyElement>,
    on_enable: Option<Box<dyn Fn(&ClickEvent, &mut Window, &mut App)>>) -> Stateful<Div> {
    let fix = &prereqs.fix;
    let command = operator_command(prereqs).map(str::to_owned);
    let fix_copy = command.clone().unwrap_or_else(|| fix.clone());
    let is_url = command.is_none() && fix.starts_with("https://");
    div().id(id).role(Role::Alert).flex().flex_col().gap_2()
        .child(div().text_sm().text_color(theme::warning()).whitespace_normal().child(tr_shared("compartilhar_pre_requisito", &[])))
        .children(prereqs.missing.iter().map(|item| div().text_sm().text_color(theme::warning()).whitespace_normal().child(match item.as_str() {
            "operator" => tr_shared("compartilhar_falta_operador", &[]),
            "funnel" => tr_shared("compartilhar_falta_funnel", &[]),
            other => other.to_owned(),
        })))
        .when(!fix.is_empty(), |el| el
            .child(div().p_2().rounded_md().bg(theme::inset()).font_family(theme::MONO).text_sm().whitespace_normal().child(fix.clone())))
        .child(div().flex().flex_wrap().gap_2()
            .children(authorize)
            .when(!fix_copy.is_empty(), |el| el.child(Button::new(SharedString::from(format!("{id}-fix"))).small()
                .label(if is_url { tr("share_open_link") } else { tr_shared("compartilhar_copiar", &[]) })
                .on_click(move |_, _, cx| if is_url { cx.open_url(&fix_copy) } else { cx.write_to_clipboard(ClipboardItem::new_string(fix_copy.clone())) })))
            .when_some(prereqs.enable_url.clone(), |el, url| el.child(Button::new(SharedString::from(format!("{id}-enable"))).small().primary()
                .label(tr_shared("compartilhar_liberar_tailscale", &[]))
                .on_click(move |event, window, cx| { cx.open_url(&url); if let Some(after) = &on_enable { after(event, window, cx); } }))))
}

#[derive(Debug, PartialEq)]
enum Authorized { Done, Dismissed, Denied, NoPkexec, Failed(String) }

impl Authorized {
    fn message(&self) -> Option<String> {
        match self {
            Authorized::Done => None,
            Authorized::Dismissed => Some(tr("share_authorize_dismissed")),
            Authorized::Denied => Some(tr("share_authorize_denied")),
            Authorized::NoPkexec => Some(tr("share_authorize_missing")),
            Authorized::Failed(error) => Some(tr_shared("native_share_authorize_failed", &[("erro", error)])),
        }
    }
}

/// 126 = a pessoa fechou a janela de senha; 127 = o polkit negou ou não há agente na sessão.
fn pkexec_outcome(result: std::io::Result<std::process::Output>) -> Authorized {
    match result {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Authorized::NoPkexec,
        Err(e) => Authorized::Failed(e.to_string()),
        Ok(out) => match out.status.code() {
            Some(0) => Authorized::Done,
            Some(126) => Authorized::Dismissed,
            Some(127) => Authorized::Denied,
            code => {
                let text = String::from_utf8_lossy(&out.stderr).trim().to_owned();
                Authorized::Failed(if text.is_empty() { format!("exit {code:?}") } else { text })
            }
        },
    }
}

/// O mesmo usuário do backend: só oferecemos isto com o servidor em loopback, que roda nesta conta.
fn current_user() -> Option<String> {
    std::env::var("USER").ok().filter(|u| !u.is_empty()).or_else(|| {
        let out = std::process::Command::new("id").arg("-un").output().ok()?;
        Some(String::from_utf8_lossy(&out.stdout).trim().to_owned()).filter(|u| !u.is_empty())
    })
}

/// Roda na sessão gráfica (é o app, não o backend de systemd) para o polkit achar o agente que pede a senha.
fn authorize_operator() -> Authorized {
    let Some(user) = current_user() else { return Authorized::Failed("USER".into()) };
    pkexec_outcome(std::process::Command::new("pkexec").args(["tailscale", "set", &format!("--operator={user}")]).output())
}

pub(super) struct ShareDialog {
    // Fixada na abertura: trocar de servidor com o diálogo aberto não pode mandar o pedido para outra máquina. O diálogo fala
    // com a API sozinho: voltar ao `Hangar` daqui reentraria nele quando o clique do menu ainda o está atualizando.
    api: Api,
    runtime: tokio::runtime::Handle,
    name: String,
    list: Remote<Vec<ShareEntry>>,
    created: Option<Result<Created, String>>,
    revoke_error: Option<String>,
    copied: bool,
    busy: bool,
    // A conferência morre com o diálogo: soltar a `Task` a cancela.
    watch: Option<Task<()>>,
    watching: bool,
    authorizing: bool,
    authorize_error: Option<String>,
    /// "Convidar para parear" pedido: o nível é escolhido antes de gerar.
    choosing_level: bool,
    /// A sessão e os membros locais do grupo dela, que o acesso completo já abre.
    group: Vec<String>,
}

impl ShareDialog {
    fn reload(&mut self, cx: &mut Context<Self>) {
        let seq = self.list.start();
        let name = self.name.clone();
        self.call(move |api| async move {
            let result = api.shares(&name).await.map_err(|e| Hangar::failure(&e));
            move |d: &mut ShareDialog| { d.list.finish(seq, result); }
        }, cx);
        cx.notify();
    }

    /// `pair` gera o convite de par com o nível dado em vez do de compartilhamento: mesma rota de túnel, mesmos pré-requisitos.
    fn create(&mut self, pair: Option<PairLevel>, cx: &mut Context<Self>) {
        if self.busy { return; }
        (self.busy, self.copied, self.created, self.authorize_error, self.choosing_level) = (true, false, None, None, false);
        let name = self.name.clone();
        self.call(move |api| async move {
            let made = match pair {
                Some(level) => api.create_pair_invite(&name, level).await.map(|c| Created::Pair(c, level)),
                None => api.share_create(&name).await.map(Created::Link),
            };
            let result = match made {
                Ok(created) => Ok(created),
                Err(ShareFailure::Blocked(prereqs)) => Ok(Created::Blocked(prereqs)),
                Err(ShareFailure::Other(e)) => Err(Hangar::failure(&e)),
                Err(ShareFailure::NeedsRust) => Err(tr_shared("share_create_needs_rust", &[])),
                Err(ShareFailure::Unreachable { stage, detail }) => Ok(Created::Unreachable { stage, detail }),
            };
            move |d: &mut ShareDialog| { d.busy = false; d.created = Some(result); }
        }, cx);
        cx.notify();
    }

    fn revoke(&mut self, id: Option<String>, cx: &mut Context<Self>) {
        self.revoke_error = None;
        let name = self.name.clone();
        self.call(move |api| async move {
            let all = id.is_none();
            let result = api.share_revoke(&name, id.as_deref()).await.map_err(|e| Hangar::failure(&e));
            move |d: &mut ShareDialog| match result {
                // Encerrar todos invalida o link recém-gerado na tela; o convite de par segue valendo no backend.
                Ok(()) => if all && matches!(d.created, Some(Ok(Created::Link(_)))) { d.created = None; },
                Err(e) => d.revoke_error = Some(e),
            }
        }, cx);
    }

    /// Pergunta ao backend o que falta a cada 3 s, por até 5 min, até não faltar nada. Liberado, some o aviso e o "Gerar"
    /// volta; a resposta vem para este diálogo, nunca para o `Hangar`.
    fn watch(&mut self, cx: &mut Context<Self>) {
        let (api, runtime, deadline) = (self.api.clone(), self.runtime.clone(), Instant::now() + WATCH_FOR);
        self.watching = true;
        self.watch = Some(cx.spawn(async move |this, cx| {
            while Instant::now() < deadline {
                let (done, result) = tokio::sync::oneshot::channel();
                let api = api.clone();
                runtime.spawn(async move { let _ = done.send(api.share_prereqs().await); });
                // Erro (sem tailscale, rede) não encerra: a liberação pode estar a caminho.
                if let Ok(Ok(prereqs)) = result.await {
                    let cleared = prereqs.missing.is_empty();
                    let alive = this.update(cx, |d, cx| {
                        d.created = if cleared { None } else { Some(Ok(Created::Blocked(prereqs))) };
                        cx.notify();
                    });
                    if cleared || alive.is_err() { break; }
                }
                cx.background_executor().timer(WATCH_EVERY).await;
            }
            let _ = this.update(cx, |d, cx| { d.watching = false; cx.notify(); });
        }));
        cx.notify();
    }

    fn authorize(&mut self, cx: &mut Context<Self>) {
        if self.authorizing { return; }
        (self.authorizing, self.authorize_error) = (true, None);
        let (done, result) = tokio::sync::oneshot::channel();
        self.runtime.spawn_blocking(move || { let _ = done.send(authorize_operator()); });
        cx.spawn(async move |this, cx| {
            let Ok(outcome) = result.await else { return };
            let _ = this.update(cx, |d, cx| {
                d.authorizing = false;
                d.authorize_error = outcome.message();
                if outcome == Authorized::Done { d.watch(cx); }
                cx.notify();
            });
        }).detach();
        cx.notify();
    }

    /// Pedido no runtime do app; a resposta volta ao diálogo se ele ainda existir, e a lista se relê depois de mudar.
    fn call<F, Fut, A>(&mut self, call: F, cx: &mut Context<Self>)
    where F: FnOnce(Api) -> Fut + Send + 'static, Fut: std::future::Future<Output = A> + Send + 'static, A: FnOnce(&mut ShareDialog) + Send + 'static {
        let (done, result) = tokio::sync::oneshot::channel();
        let api = self.api.clone();
        self.runtime.spawn(async move { let _ = done.send(call(api).await); });
        cx.spawn(async move |this, cx| {
            let Ok(apply) = result.await else { return };
            let _ = this.update(cx, |d, cx| {
                let reread = !d.list.loading;
                apply(d);
                if reread { d.reload(cx); }
                cx.notify();
            });
        }).detach();
    }

    fn render_created(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        // A criação espera no servidor o link do Funnel abrir de fora (até ~3 min).
        if self.busy {
            return Some(div().id("share-reach").role(Role::Status).flex().items_center().gap_2().text_sm().text_color(theme::muted())
                .child(chrome::Spinner::new("share-reach-spin", IconName::LoaderCircle, px(14.), theme::accent()))
                .child(div().flex_1().whitespace_normal().child(tr_shared("share_reach_checking", &[]))).into_any_element());
        }
        Some(match self.created.as_ref()? {
            Ok(Created::Unreachable { stage, detail }) => div().id("share-reach").role(Role::Alert).flex().flex_col().gap_2()
                .child(div().text_sm().text_color(theme::danger()).whitespace_normal().child(super::pair_accept::unreachable_text(stage)))
                .when(!detail.is_empty(), |el| el.child(div().text_xs().text_color(theme::muted()).whitespace_normal().child(detail.clone())))
                .into_any_element(),
            Ok(Created::Link(c) | Created::Pair(c, _)) => {
                let level = match self.created { Some(Ok(Created::Pair(_, level))) => Some(level), _ => None };
                let key = if level.is_some() { "native_par_whatsapp" } else { "compartilhar_whatsapp_texto" };
                let (copy, send) = (c.link.clone(), whatsapp_url(&tr_shared(key, &[("link", &c.link)])));
                div().flex().flex_col().gap_2()
                    .child(div().text_sm().font_weight(FontWeight::SEMIBOLD).text_color(theme::muted()).child(tr_shared("compartilhar_link_novo", &[])))
                    .children(level.map(|level| div().text_sm().whitespace_normal()
                        .child(format!("{} · {}", tr_shared("pair_level_title", &[]), level_label(level)))))
                    .child(div().p_2().rounded_md().bg(theme::inset()).font_family(theme::MONO).text_sm().whitespace_normal().child(c.link.clone()))
                    .child(div().text_xs().text_color(theme::muted()).child(tr_shared("compartilhar_vale_ate", &[("quando", &when_label(c.expires_at))])))
                    .child(div().flex().gap_2()
                        .child(Button::new("share-copy").small().icon(IconName::Copy)
                            .label(tr_shared(if self.copied { "compartilhar_copiado" } else { "compartilhar_copiar" }, &[]))
                            .on_click(cx.listener(move |d, _, _, cx| { cx.write_to_clipboard(ClipboardItem::new_string(copy.clone())); d.copied = true; cx.notify(); })))
                        .child(Button::new("share-whatsapp").small().icon(IconName::MessageCircle).label(tr_shared("compartilhar_whatsapp", &[]))
                            .on_click(move |_, _, cx| cx.open_url(&send))))
                    .into_any_element()
            }
            Ok(Created::Blocked(prereqs)) => {
                // `pkexec` precisa do agente de senha da sessão gráfica: só aqui, e só com o backend nesta máquina.
                let can_authorize = operator_command(prereqs).is_some() && cfg!(target_os = "linux") && self.api.is_loopback();
                let authorize = can_authorize.then(|| Button::new("share-authorize").small().primary()
                    .label(tr(if self.authorizing { "share_authorizing" } else { "share_authorize" })).disabled(self.authorizing)
                    .on_click(cx.listener(|d, _, _, cx| d.authorize(cx))).into_any_element());
                let on_enable: Box<dyn Fn(&ClickEvent, &mut Window, &mut App)> = Box::new(cx.listener(|d, _, _, cx| d.watch(cx)));
                prerequisite_notice("share-blocked", prereqs, authorize, Some(on_enable))
                    .when_some(self.authorize_error.clone(), |el, error| el.child(div().id("share-authorize-error").role(Role::Alert)
                        .text_sm().text_color(theme::danger()).whitespace_normal().child(error)))
                    .when(self.watching, |el| el.child(div().id("share-watching").role(Role::Status).text_sm().text_color(theme::muted())
                        .whitespace_normal().child(tr_shared("compartilhar_conferindo", &[]))))
                    .into_any_element()
            }
            Err(error) => div().id("share-error").role(Role::Alert).text_sm().text_color(theme::danger()).whitespace_normal().child(error.clone()).into_any_element(),
        })
    }
}

impl Render for ShareDialog {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let list: AnyElement = match &self.list.value {
            _ if self.list.loading => div().id("share-loading").role(Role::Status).text_sm().text_color(theme::muted()).child(tr_shared("compartilhar_carregando", &[])).into_any_element(),
            None => div().into_any_element(),
            Some(Err(error)) => div().flex().flex_col().gap_2().items_start()
                .child(div().id("share-list-error").role(Role::Alert).text_sm().text_color(theme::danger()).whitespace_normal()
                    .child(tr_shared("compartilhar_erro_lista", &[("erro", error)])))
                .child(Button::new("share-retry").small().label(tr_shared("compartilhar_tentar_de_novo", &[])).on_click(cx.listener(|d, _, _, cx| d.reload(cx))))
                .into_any_element(),
            Some(Ok(items)) if items.is_empty() => div().text_sm().text_color(theme::muted()).whitespace_normal().child(tr_shared("compartilhar_vazio", &[])).into_any_element(),
            Some(Ok(items)) => div().flex().flex_col().gap_1().children(items.iter().map(|s| {
                let id = s.id.clone();
                let (who, when) = if s.pending {
                    (tr_shared("compartilhar_link_aguardando", &[]), tr_shared("compartilhar_pendente", &[("quando", &when_label(s.expires_at))]))
                } else {
                    (s.device.clone().filter(|d| !d.is_empty()).unwrap_or_else(|| tr_shared("compartilhar_aparelho_sem_nome", &[])),
                        tr_shared("compartilhar_entrou", &[("quando", &when_label(s.redeemed_at.unwrap_or(s.created_at)))]))
                };
                div().flex().items_center().gap_2()
                    .child(div().flex_1().min_w_0().flex().flex_col()
                        .child(div().truncate().text_sm().child(who))
                        .child(div().truncate().text_xs().text_color(theme::muted()).child(when)))
                    .child(Button::new(SharedString::from(format!("share-revoke-{id}"))).ghost().xsmall().label(tr_shared("compartilhar_revogar", &[]))
                        .on_click(cx.listener(move |d, _, _, cx| d.revoke(Some(id.clone()), cx))))
            })).into_any_element(),
        };
        let any = self.list.ok().is_some_and(|l| !l.is_empty());
        let link_shown = matches!(self.created, Some(Ok(Created::Link(_) | Created::Pair(..))));
        let choosing = self.choosing_level && !link_shown && !self.busy;
        let choice = choosing.then(|| level_choice("share-pair-level", tr_shared("pair_level_title", &[]), &self.group, None, self.watching,
            |d: &mut ShareDialog, level, cx| d.create(Some(level), cx), cx));
        div().flex().flex_col().gap_3()
            .child(div().p_2().rounded_md().bg(theme::accent_dim()).text_sm().whitespace_normal().child(tr_shared("compartilhar_aviso_confianca", &[])))
            .children(self.render_created(cx))
            .children(choice)
            .when(!link_shown && !choosing, |el| el.child(div().flex().flex_wrap().gap_2()
                .child(Button::new("share-create").primary()
                    .label(tr_shared(if self.busy { "compartilhar_gerando" } else { "compartilhar_gerar" }, &[])).disabled(self.busy || self.watching)
                    .on_click(cx.listener(|d, _, _, cx| d.create(None, cx))))
                .child(Button::new("share-create-pair")
                    .label(tr("par_convidar")).disabled(self.busy || self.watching)
                    .on_click(cx.listener(|d, _, _, cx| { d.choosing_level = true; cx.notify(); })))))
            .child(chrome::section_label(tr_shared("compartilhar_quem_entrou", &[])))
            .child(list)
            .when_some(self.revoke_error.clone(), |el, error| el.child(div().id("share-revoke-error").role(Role::Alert).text_sm()
                .text_color(theme::danger()).whitespace_normal().child(error)))
            .when(any, |el| el.child(Button::new("share-revoke-all").ghost().small().label(tr_shared("compartilhar_encerrar_todos", &[]))
                .on_click(cx.listener(|d, _, _, cx| d.revoke(None, cx)))))
    }
}

impl Hangar {
    /// A sessão e os membros do grupo dela nesta máquina: o que um par com acesso completo passa a abrir.
    pub(super) fn local_group(&self, target: &super::sidebar::Target) -> Vec<String> {
        let peers = self.target_session(target).map(|s| s.peers().to_vec()).unwrap_or_default();
        std::iter::once(target.name.clone()).chain(peers.into_iter().filter(|p| !p.contains("::"))).collect()
    }

    /// O convite nasce na máquina da sessão: é o backend dela que guarda o código e abre a porta do convidado.
    pub(super) fn open_share_dialog(&mut self, target: super::sidebar::Target, window: &mut Window, cx: &mut Context<Self>) {
        let Some(api) = self.machine_api(&target.server) else {
            window.push_notification(Notification::error(self.machine_error(&target.server)), cx);
            return;
        };
        let group = self.local_group(&target);
        let (runtime, name) = (self.runtime.handle().clone(), target.name);
        let dialog = cx.new(|_| ShareDialog { api, runtime, name: name.clone(), list: Remote::default(), created: None,
            revoke_error: None, copied: false, busy: false, watch: None, watching: false, authorizing: false, authorize_error: None,
            choosing_level: false, group });
        dialog.update(cx, |d, cx| d.reload(cx));
        let title = tr_shared("compartilhar_titulo", &[("nome", &name)]);
        window.open_dialog(cx, move |d, _, _| popup::dialog(d).w(px(560.)).title(title.clone()).child(dialog.clone()));
    }
}

#[cfg(test)]
mod tests {
    use super::{whatsapp_url, when_label, operator_command, pkexec_outcome, Authorized};
    use crate::api::SharePrereqs;
    use crate::i18n::tr_shared;
    use core::prelude::v1::test;

    #[test]
    fn creation_refusals_become_screen_states() {
        use crate::api::{share_refusal, ShareFailure};
        use serde_json::json;
        let unreachable = json!({"detail": {"code": "share_reach_failed", "msg": "x", "params": {"stage": "dns", "detail": "sem nome"}}});
        assert!(matches!(share_refusal(409, &unreachable),
            Some(ShareFailure::Unreachable { stage, detail }) if stage == "dns" && detail == "sem nome"));
        for status in [404, 405] {
            assert!(matches!(share_refusal(status, &json!({"detail": "Not Found"})), Some(ShareFailure::NeedsRust)), "{status}");
        }
        let blocked = json!({"detail": {"code": "erro_compartilhar_pre_requisito", "params": {"missing": ["funnel"], "fix": "x"}}});
        assert!(matches!(share_refusal(409, &blocked), Some(ShareFailure::Blocked(_))));
        assert!(share_refusal(409, &json!({"detail": {"code": "outro"}})).is_none());
        assert!(share_refusal(502, &serde_json::Value::Null).is_none());
    }

    #[test]
    fn only_full_access_lists_the_sessions_it_opens() {
        use super::{opens_line, level_label};
        use crate::api::PairLevel;
        let group = ["a".to_owned(), "b".to_owned()];
        let line = opens_line(PairLevel::Full, &group).expect("acesso completo diz o que abre");
        assert!(line.contains("a, b") && line != "pair_opens_sessions", "{line}");
        assert_eq!(opens_line(PairLevel::View, &group), None);
        assert_ne!(level_label(PairLevel::Full), level_label(PairLevel::View));
    }

    #[test]
    fn operator_command_is_only_the_command_line() {
        let both = SharePrereqs { missing: vec!["operator".into(), "funnel".into()],
            fix: "sudo tailscale set --operator=$USER\nlibere o Funnel".into(), enable_url: None };
        assert_eq!(operator_command(&both), Some("sudo tailscale set --operator=$USER"));
        let funnel = SharePrereqs { missing: vec!["funnel".into()], fix: "libere o Funnel".into(), enable_url: None };
        assert_eq!(operator_command(&funnel), None);
    }

    #[cfg(unix)]
    #[test]
    fn pkexec_exit_codes_become_clear_outcomes() {
        use std::os::unix::process::ExitStatusExt;
        let out = |code: i32, stderr: &str| Ok(std::process::Output {
            status: std::process::ExitStatus::from_raw(code << 8), stdout: vec![], stderr: stderr.as_bytes().to_vec() });
        assert_eq!(pkexec_outcome(out(0, "")), Authorized::Done);
        assert_eq!(pkexec_outcome(out(126, "")), Authorized::Dismissed);
        assert_eq!(pkexec_outcome(out(127, "")), Authorized::Denied);
        assert_eq!(pkexec_outcome(out(1, " access denied \n")), Authorized::Failed("access denied".into()));
        assert_eq!(pkexec_outcome(Err(std::io::ErrorKind::NotFound.into())), Authorized::NoPkexec);
        assert!(Authorized::Done.message().is_none());
        assert!(Authorized::NoPkexec.message().is_some_and(|m| !m.starts_with("share_")));
    }

    #[test]
    fn whatsapp_link_carries_the_invite_encoded() {
        // O texto sai no idioma da tela: confere a forma (mensagem inteira, link codificado), não a frase.
        let text = tr_shared("compartilhar_whatsapp_texto", &[("link", "https://h.ts.net:8443/convite/AB12")]);
        let url = whatsapp_url(&text);
        let query = url.strip_prefix("https://wa.me/?text=").expect("wa.me prefix");
        assert!(query.ends_with("https%3A%2F%2Fh.ts.net%3A8443%2Fconvite%2FAB12"), "{url}");
        assert!(query.len() > "https%3A%2F%2Fh.ts.net%3A8443%2Fconvite%2FAB12".len(), "{url}");
        assert!(!query.contains(['/', ':', ' ']), "{url}");
    }

    #[test]
    fn timestamps_render_as_local_date_and_time() {
        let text = when_label(1_790_000_000.0);
        assert_eq!(text.len(), "28/09 14:05".len(), "{text}");
        assert_eq!(&text[2..3], "/");
    }
}
