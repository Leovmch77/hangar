//! "Compartilhar sessão" do dono: gera o link de convite, lista quem entrou e revoga. O link só existe na resposta de quem
//! o gerou (o backend guarda o hash), então ele aparece uma vez, até fechar o diálogo.
use super::*;
use super::device::Remote;
use crate::api::{ShareCreated, ShareEntry, ShareFailure};

pub(super) fn whatsapp_url(text: &str) -> String {
    let text: String = url::form_urlencoded::byte_serialize(text.as_bytes()).collect();
    format!("https://wa.me/?text={text}")
}

pub(super) fn when_label(epoch: f64) -> String {
    chrono::DateTime::from_timestamp(epoch as i64, 0).map(|t| t.with_timezone(&chrono::Local).format("%d/%m %H:%M").to_string())
        .unwrap_or_default()
}

enum Created { Link(ShareCreated), Blocked { missing: Vec<String>, fix: String } }

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

    fn create(&mut self, cx: &mut Context<Self>) {
        if self.busy { return; }
        (self.busy, self.copied, self.created) = (true, false, None);
        let name = self.name.clone();
        self.call(move |api| async move {
            let result = match api.share_create(&name).await {
                Ok(link) => Ok(Created::Link(link)),
                Err(ShareFailure::Blocked { missing, fix }) => Ok(Created::Blocked { missing, fix }),
                Err(ShareFailure::Other(e)) => Err(Hangar::failure(&e)),
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
                // Encerrar todos invalida também o link recém-gerado que ainda está na tela.
                Ok(()) => if all { d.created = None; },
                Err(e) => d.revoke_error = Some(e),
            }
        }, cx);
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
        Some(match self.created.as_ref()? {
            Ok(Created::Link(c)) => {
                let (copy, send) = (c.link.clone(), whatsapp_url(&tr_shared("compartilhar_whatsapp_texto", &[("link", &c.link)])));
                div().flex().flex_col().gap_2()
                    .child(div().text_sm().font_weight(FontWeight::SEMIBOLD).text_color(theme::muted()).child(tr_shared("compartilhar_link_novo", &[])))
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
            Ok(Created::Blocked { missing, fix }) => {
                let (fix_copy, is_url) = (fix.clone(), fix.starts_with("https://"));
                div().id("share-blocked").role(Role::Alert).flex().flex_col().gap_2()
                    .child(div().text_sm().text_color(theme::warning()).whitespace_normal().child(tr_shared("compartilhar_pre_requisito", &[])))
                    .children(missing.iter().map(|item| div().text_sm().text_color(theme::warning()).whitespace_normal().child(match item.as_str() {
                        "operator" => tr_shared("compartilhar_falta_operador", &[]),
                        "funnel" => tr_shared("compartilhar_falta_funnel", &[]),
                        other => other.to_owned(),
                    })))
                    .when(!fix.is_empty(), |el| el
                        .child(div().p_2().rounded_md().bg(theme::inset()).font_family(theme::MONO).text_sm().whitespace_normal().child(fix.clone()))
                        .child(Button::new("share-fix").small().label(if is_url { tr("share_open_link") } else { tr_shared("compartilhar_copiar", &[]) })
                            .on_click(move |_, _, cx| if is_url { cx.open_url(&fix_copy) } else { cx.write_to_clipboard(ClipboardItem::new_string(fix_copy.clone())) })))
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
        let link_shown = matches!(self.created, Some(Ok(Created::Link(_))));
        div().flex().flex_col().gap_3()
            .child(div().p_2().rounded_md().bg(theme::accent_dim()).text_sm().whitespace_normal().child(tr_shared("compartilhar_aviso_confianca", &[])))
            .children(self.render_created(cx))
            .when(!link_shown, |el| el.child(Button::new("share-create").primary()
                .label(tr_shared(if self.busy { "compartilhar_gerando" } else { "compartilhar_gerar" }, &[])).disabled(self.busy)
                .on_click(cx.listener(|d, _, _, cx| d.create(cx)))))
            .child(chrome::section_label(tr_shared("compartilhar_quem_entrou", &[])))
            .child(list)
            .when_some(self.revoke_error.clone(), |el, error| el.child(div().id("share-revoke-error").role(Role::Alert).text_sm()
                .text_color(theme::danger()).whitespace_normal().child(error)))
            .when(any, |el| el.child(Button::new("share-revoke-all").ghost().small().label(tr_shared("compartilhar_encerrar_todos", &[]))
                .on_click(cx.listener(|d, _, _, cx| d.revoke(None, cx)))))
    }
}

impl Hangar {
    pub(super) fn open_share_dialog(&mut self, name: String, window: &mut Window, cx: &mut Context<Self>) {
        let Some(api) = self.api.clone() else { return };
        let runtime = self.runtime.handle().clone();
        let dialog = cx.new(|_| ShareDialog { api, runtime, name: name.clone(), list: Remote::default(), created: None,
            revoke_error: None, copied: false, busy: false });
        dialog.update(cx, |d, cx| d.reload(cx));
        let title = tr_shared("compartilhar_titulo", &[("nome", &name)]);
        window.open_dialog(cx, move |d, _, _| popup::dialog(d).w(px(560.)).title(title.clone()).child(dialog.clone()));
    }
}

#[cfg(test)]
mod tests {
    use super::{whatsapp_url, when_label};
    use crate::i18n::tr_shared;
    use core::prelude::v1::test;

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
