//! Git da pasta escolhida na tela sem sessão: branch, remota, atrás e à frente (do último fetch), alterações e hora do fetch;
//! fetch, pull que só avança, trocar e criar branch. As rotas `/fs/git*` recusam pasta suja e pedem confirmação quando há
//! sessões abertas no mesmo checkout; aqui a mesma regra aparece antes do clique, e a recusa do servidor vira o mesmo texto.
use super::*;

#[derive(Clone, Debug, Default, Deserialize)]
pub(super) struct FolderGit {
    #[serde(default)] repo: bool,
    current: Option<String>,
    upstream: Option<String>,
    #[serde(default)] dirty: u64,
    ahead: Option<u64>,
    behind: Option<u64>,
    last_fetch: Option<f64>,
    #[serde(default)] sessions: Vec<String>,
}

impl FolderGit {
    fn diverged(&self) -> bool { self.ahead.unwrap_or(0) > 0 && self.behind.unwrap_or(0) > 0 }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(in crate::app) enum GitAction { Fetch, Pull, Switch, Create }

impl GitAction {
    fn route(self) -> &'static str {
        match self { GitAction::Fetch => "fetch", GitAction::Pull => "pull", GitAction::Switch => "switch", GitAction::Create => "branch" }
    }
}

/// O que a última ação deixou: a recusa, com o texto montado do estado relido, ou o aviso do que mudou.
#[derive(Clone, Debug)]
enum GitNote { Refused(&'static str), Failed(String), Done(String) }

#[derive(Default)]
pub(super) struct GitPanel {
    status: Remote<FolderGit>,
    busy: Option<GitAction>,
    note: Option<GitNote>,
    /// A troca (ou criação que troca) parada esperando a confirmação por causa das sessões na pasta.
    confirm: Option<(GitAction, String)>,
    create_tab: bool,
    /// Base da branch nova; vazia é a atual.
    base: String,
    checkout: bool,
    /// Pasta que já ganhou o fetch automático desta abertura.
    fetched: Option<String>,
}

/// O resumo da pílula: atrás, à frente e alterações; sem nada disso, "Atualizada" (ou só "Git" sem remota).
fn summary(git: &FolderGit) -> String {
    let parts: Vec<String> = [
        git.behind.filter(|n| *n > 0).map(|n| format!("↓{n}")),
        git.ahead.filter(|n| *n > 0).map(|n| format!("↑{n}")),
        (git.dirty > 0).then(|| tr("folder_git_changes").replace("{n}", &git.dirty.to_string())),
    ].into_iter().flatten().collect();
    if !parts.is_empty() { return parts.join(" · "); }
    tr(if git.upstream.is_some() { "folder_git_up_to_date" } else { "folder_git_label" })
}

/// A linha de estado do painel: remota, atrás/à frente, alterações e quando foi o último fetch.
fn status_line(git: &FolderGit, now: f64) -> String {
    let mut parts = vec![git.upstream.clone().unwrap_or_else(|| tr("folder_git_no_upstream"))];
    if git.upstream.is_some() {
        match (git.behind.unwrap_or(0), git.ahead.unwrap_or(0)) {
            (0, 0) => parts.push(tr("folder_git_up_to_date")),
            (behind, ahead) => {
                if behind > 0 { parts.push(tr("folder_git_behind").replace("{n}", &behind.to_string())); }
                if ahead > 0 { parts.push(tr("folder_git_ahead").replace("{n}", &ahead.to_string())); }
            }
        }
    }
    if git.dirty > 0 { parts.push(tr("folder_git_changes").replace("{n}", &git.dirty.to_string())); }
    parts.push(match git.last_fetch {
        Some(at) => tr("folder_git_fetched").replace("{quando}", &crate::app::side::ago(now - at)),
        None => tr("folder_git_never_fetched"),
    });
    parts.join(" · ")
}

fn refusal_text(code: &str, git: Option<&FolderGit>) -> String {
    let n = |f: fn(&FolderGit) -> u64| git.map(f).unwrap_or(0).to_string();
    match code {
        "dirty" => tr("folder_git_dirty").replace("{n}", &n(|g| g.dirty)),
        "diverged" => tr("folder_git_diverged").replace("{upstream}", git.and_then(|g| g.upstream.as_deref()).unwrap_or("?"))
            .replace("{ahead}", &n(|g| g.ahead.unwrap_or(0))).replace("{behind}", &n(|g| g.behind.unwrap_or(0))),
        "no_upstream" => tr("folder_git_no_upstream_pull"),
        _ => tr("folder_git_not_repo"),
    }
}

impl NewSession {
    pub(super) fn load_git(&mut self, cx: &mut Context<Self>) {
        let (Some(root), Some(path)) = (self.root.as_ref().map(|r| r.path.clone()), self.picked.clone()) else { return };
        let seq = self.git.status.start();
        self.request(cx, move |api, send| Box::pin(async move {
            send(CreateReply::Git(seq, api.server_read(&["fs", "git"], &[("root", root.as_str()), ("path", path.as_str())], 30).await)).await
        }));
    }

    /// Pasta nova: o painel volta ao começo.
    pub(super) fn reset_git(&mut self) {
        // O número dos pedidos continua: resposta da pasta anterior não entra nesta.
        let mut status = std::mem::take(&mut self.git.status);
        status.value = None;
        self.git = GitPanel { status, ..Default::default() };
    }

    /// Abrir o painel busca as remotas uma vez por pasta: é assim que se sabe se ela está atualizada.
    pub(super) fn git_opened(&mut self, cx: &mut Context<Self>) {
        if self.picked.is_some() && self.git.fetched != self.picked && self.git.status.ok().is_some_and(|g| g.repo) {
            self.git.fetched = self.picked.clone();
            self.git_act(GitAction::Fetch, String::new(), false, cx);
        }
    }

    fn git_act(&mut self, action: GitAction, branch: String, confirm: bool, cx: &mut Context<Self>) {
        if self.git.busy.is_some() || self.creating { return; }
        let (Some(root), Some(path)) = (self.root.as_ref().map(|r| r.path.clone()), self.picked.clone()) else { return };
        let mut body = json!({"root": root, "path": path});
        match action {
            GitAction::Switch => { body["branch"] = json!(branch); body["confirm_sessions"] = json!(confirm); }
            GitAction::Create => {
                body["name"] = json!(branch);
                body["checkout"] = json!(self.git.checkout);
                body["confirm_sessions"] = json!(confirm);
                if !self.git.base.is_empty() { body["base"] = json!(self.git.base); }
            }
            GitAction::Fetch | GitAction::Pull => {}
        }
        (self.git.busy, self.git.note, self.git.confirm) = (Some(action), None, None);
        self.request(cx, move |api, send| Box::pin(async move {
            let result = api.server_send(reqwest::Method::POST, &["fs", "git", action.route()], Some(body), 150).await;
            send(CreateReply::GitDone(action, branch, result)).await
        }));
        cx.notify();
    }

    /// Troca pedida na lista ou criação que troca: pasta suja recusa antes de pedir; sessões na pasta pedem confirmação.
    fn git_switch(&mut self, action: GitAction, branch: String, cx: &mut Context<Self>) {
        let Some(git) = self.git.status.ok() else { return };
        let switching = action == GitAction::Switch || self.git.checkout;
        if switching && git.dirty > 0 { self.git.note = Some(GitNote::Refused("dirty")); }
        else if switching && !git.sessions.is_empty() { (self.git.confirm, self.git.note) = (Some((action, branch)), None); }
        else { return self.git_act(action, branch, false, cx); }
        cx.notify();
    }

    pub(super) fn git_create(&mut self, cx: &mut Context<Self>) {
        let name = self.git_name.read(cx).value().trim().to_owned();
        if !name.is_empty() { self.git_switch(GitAction::Create, name, cx); }
    }

    pub(super) fn receive_git(&mut self, reply: CreateReply, window: &mut Window, cx: &mut Context<Self>) {
        match reply {
            CreateReply::Git(seq, result) => {
                let status = result.map_err(|e| Hangar::fetch_failure(&e))
                    .and_then(|v| serde_json::from_value(v).map_err(|_| tr("invalid_response")));
                self.git.status.finish(seq, status);
            }
            CreateReply::GitDone(action, branch, result) => {
                self.git.busy = None;
                match result.map(serde_json::from_value::<FolderGit>) {
                    Ok(Ok(status)) => {
                        let seq = self.git.status.start();
                        let upstream = status.upstream.clone().unwrap_or_default();
                        let current = status.current.clone().unwrap_or_default();
                        self.git.status.finish(seq, Ok(status));
                        let done = match action {
                            GitAction::Fetch => tr("folder_git_fetch_done"),
                            GitAction::Pull => tr("folder_git_pull_done").replace("{upstream}", &upstream),
                            GitAction::Switch => tr("folder_git_switched").replace("{branch}", &current),
                            GitAction::Create => tr("folder_git_created").replace("{branch}", &branch),
                        };
                        if action == GitAction::Create {
                            self.git_name.update(cx, |input, cx| input.set_value("", window, cx));
                            self.git.base = String::new();
                        }
                        // A branch e as remotas mudaram: a pílula de branch e a lista releem.
                        self.load_branches(cx);
                        self.git.note = Some(GitNote::Done(done));
                    }
                    Ok(Err(_)) => self.git.note = Some(GitNote::Failed(tr("invalid_response"))),
                    Err(failure) => {
                        self.git.note = match failure.detail.strip_prefix("erro_git_folder_") {
                            Some("sessions") => { self.git.confirm = Some((action, branch)); None }
                            Some("dirty") => Some(GitNote::Refused("dirty")),
                            Some("diverged") => Some(GitNote::Refused("diverged")),
                            Some("no_upstream") => Some(GitNote::Refused("no_upstream")),
                            Some(_) => Some(GitNote::Refused("not_repo")),
                            None => Some(GitNote::Failed(Hangar::fetch_failure(&failure))),
                        };
                        // O texto da recusa usa os números de agora, não os de quando a pílula foi lida.
                        self.load_git(cx);
                    }
                }
            }
            _ => {}
        }
    }

    /// A pílula do Git ao lado da de branch: some fora de repositório; lendo, fica parada com o nome.
    pub(super) fn render_git_pill(&self, open: bool, cx: &mut Context<Self>) -> Option<Div> {
        let label = match (&self.git.status.value, self.git.status.ok()) {
            (_, Some(git)) if !git.repo => return None,
            (_, Some(git)) => summary(git),
            (Some(Err(_)), _) => tr("folder_git_label"),
            (None, _) if self.git.status.loading => tr("folder_git_label"),
            _ => return None,
        };
        let waiting = self.git.status.loading && self.git.status.value.is_none();
        Some(quiet_pill(Menu::Git, open, IconName::RefreshCw, label, tr("folder_git_title"), waiting, cx))
    }

    /// `room`: a altura livre abaixo da pílula; o painel rola dentro dela.
    pub(super) fn render_git_menu(&mut self, room: Pixels, cx: &mut Context<Self>) -> AnyElement {
        let frame = |body: AnyElement| div().id("new-chat-git-menu").w(rems(26.)).max_w_full().max_h(room).overflow_y_scroll()
            .p(px(popup::INSET)).flex().flex_col().gap(px(6.)).child(body).into_any_element();
        let git = match (&self.git.status.value, self.git.status.ok()) {
            (_, Some(git)) => git.clone(),
            (Some(Err(error)), _) => return frame(Self::menu_failure("new-chat-git-error", error.clone(), |this, _, cx| this.load_git(cx), cx)),
            _ => return frame(popup::skeleton("new-chat-git", 3).into_any_element()),
        };
        if !git.repo { return frame(div().p(px(8.)).child(muted(tr("folder_git_not_repo"))).into_any_element()); }
        let busy = self.git.busy;
        let locked = busy.is_some() || self.creating;
        let now = chrono::Local::now().timestamp() as f64;
        let folder = self.picked.as_deref().map(basename).unwrap_or_default().to_owned();
        let head = div().px(px(8.)).pt(px(4.)).flex().flex_col().gap(px(2.))
            .child(div().flex().items_center().gap(px(6.)).text_sm()
                .child(div().font_weight(FontWeight::SEMIBOLD).truncate().child(folder))
                .child(chrome::small_icon(IconName::GitBranch, 13., theme::faint()))
                .child(div().truncate().child(git.current.clone().unwrap_or_else(|| "HEAD".into()))))
            .child(div().id("new-chat-git-status").role(Role::Status).text_xs().text_color(theme::muted()).whitespace_normal()
                .child(status_line(&git, now)));
        let pull_blocked = git.dirty > 0 || git.upstream.is_none() || git.diverged();
        let actions = div().px(px(8.)).flex().gap_2()
            .child(Button::new("new-chat-git-fetch").outline().small().icon(IconName::RefreshCw).label(tr("folder_git_fetch"))
                .loading(busy == Some(GitAction::Fetch)).disabled(locked)
                .on_click(cx.listener(|this, _, _, cx| this.git_act(GitAction::Fetch, String::new(), false, cx))))
            .child(Button::new("new-chat-git-pull").small().icon(IconName::ArrowDown).label(tr("folder_git_pull"))
                .map(|b| if git.behind.unwrap_or(0) > 0 && !pull_blocked { b.primary() } else { b.outline() })
                .loading(busy == Some(GitAction::Pull)).disabled(locked || pull_blocked)
                .on_click(cx.listener(|this, _, _, cx| this.git_act(GitAction::Pull, String::new(), false, cx))));
        // A razão do bloqueio fica à vista, não só no botão apagado.
        let standing = if git.dirty > 0 { Some("dirty") } else if git.diverged() { Some("diverged") } else { None };
        let note = match (&self.git.note, standing) {
            (Some(GitNote::Refused(code)), _) => Some((refusal_text(code, Some(&git)), theme::warning())),
            (Some(GitNote::Failed(text)), _) => Some((text.clone(), theme::danger())),
            (Some(GitNote::Done(text)), None) => Some((text.clone(), theme::success())),
            (_, Some(code)) => Some((refusal_text(code, Some(&git)), theme::warning())),
            (None, None) => None,
        };
        let note = note.map(|(text, color)| div().id("new-chat-git-note").role(Role::Alert).px(px(8.)).text_xs()
            .whitespace_normal().text_color(color).child(text));
        let confirm = self.git.confirm.clone().map(|(action, branch)| {
            let target = branch.clone();
            div().id("new-chat-git-confirm").role(Role::Alert).mx(px(8.)).p(px(8.)).rounded(px(6.)).border_1().border_color(theme::warning())
                .flex().flex_col().gap_2()
                .child(div().text_xs().whitespace_normal().text_color(theme::text()).child(tr("folder_git_sessions")
                    .replace("{sessoes}", &git.sessions.join(", ")).replace("{branch}", &target)))
                .child(div().flex().gap_2()
                    .child(Button::new("new-chat-git-confirm-go").small().danger().label(tr("folder_git_switch_anyway")).disabled(locked)
                        .on_click(cx.listener(move |this, _, _, cx| this.git_act(action, branch.clone(), true, cx))))
                    .child(Button::new("new-chat-git-confirm-cancel").small().ghost().label(tr("cancel"))
                        .on_click(cx.listener(|this, _, _, cx| { this.git.confirm = None; cx.notify(); }))))
        });
        let tabs = div().px(px(4.)).flex().gap_1()
            .child(Button::new("new-chat-git-tab-switch").ghost().xsmall().selected(!self.git.create_tab).label(tr("folder_git_switch_tab"))
                .on_click(cx.listener(|this, _, _, cx| { this.git.create_tab = false; cx.notify(); })))
            .child(Button::new("new-chat-git-tab-create").ghost().xsmall().selected(self.git.create_tab).label(tr("folder_git_create_tab"))
                .on_click(cx.listener(|this, _, _, cx| { this.git.create_tab = true; cx.notify(); })));
        let body = if self.git.create_tab { self.render_git_create(&git, locked, cx) } else { self.render_git_switch(&git, locked, cx) };
        frame(div().flex().flex_col().gap(px(8.))
            .child(head).child(actions).children(note).children(confirm)
            .child(popup::separator()).child(tabs).child(body)
            .into_any_element())
    }

    /// As branches locais e as remotas sem local, filtradas pela busca; `pick` diz o que o clique faz.
    fn git_rows(&self, git: &FolderGit, chosen: &str, disabled: bool, pick: fn(&mut Self, String, &mut Context<Self>), cx: &mut Context<Self>) -> AnyElement {
        let query = self.menu_filter(cx);
        let Some(Some(checkout)) = self.checkout.ok() else {
            return if self.checkout.loading { popup::skeleton("new-chat-git-branches", 3).into_any_element() } else { div().into_any_element() };
        };
        let current = git.current.clone().unwrap_or_default();
        let remote = tr("folder_git_remote");
        let rows = checkout.branches.iter().map(|b| (b, false)).chain(checkout.remotes.iter().map(|b| (b, true)))
            .filter(|(b, is_remote)| wanted(&query, b, if *is_remote { &remote } else { "" }))
            .map(|(b, is_remote)| {
                let on = if chosen.is_empty() { *b == current } else { b == chosen };
                let hint = if *b == current { tr("folder_git_current") } else if is_remote { remote.clone() } else { String::new() };
                let name = b.clone();
                menu_row(SharedString::from(format!("new-chat-git-branch-{b}")), on, b.clone(), hint).disabled(disabled)
                    .on_click(cx.listener(move |this, _, _, cx| { pick(this, name.clone(), cx); cx.notify(); }))
                    .into_any_element()
            }).collect();
        Self::menu_list("new-chat-git-branch-list", rows)
    }

    fn render_git_switch(&self, git: &FolderGit, locked: bool, cx: &mut Context<Self>) -> AnyElement {
        div().flex().flex_col().gap(px(2.)).child(self.menu_search())
            .child(self.git_rows(git, "", locked || git.dirty > 0, |this, name, cx| {
                let current = this.git.status.ok().and_then(|g| g.current.clone()).unwrap_or_default();
                if name != current { this.git_switch(GitAction::Switch, name, cx); }
            }, cx))
            .into_any_element()
    }

    fn render_git_create(&self, git: &FolderGit, locked: bool, cx: &mut Context<Self>) -> AnyElement {
        let name = self.git_name.read(cx).value().trim().to_owned();
        let blocked = self.git.checkout && git.dirty > 0;
        div().flex().flex_col().gap(px(6.))
            .child(div().px(px(4.)).child(Input::new(&self.git_name).small().aria_label(tr("folder_git_name")).disabled(locked)))
            .child(div().px(px(8.)).text_xs().text_color(theme::faint()).child(tr("folder_git_base")))
            .child(self.menu_search())
            .child(self.git_rows(git, &self.git.base, locked, |this, name, _| {
                let current = this.git.status.ok().and_then(|g| g.current.clone());
                this.git.base = if Some(&name) == current.as_ref() { String::new() } else { name };
            }, cx))
            .child(div().px(px(8.)).flex().items_center().justify_between().gap_2()
                .child(Checkbox::new("new-chat-git-checkout").label(tr("folder_git_checkout")).checked(self.git.checkout).disabled(locked)
                    .on_change(cx.listener(|this, checked: &bool, _, cx| { this.git.checkout = *checked; cx.notify(); })))
                .child(Button::new("new-chat-git-create").small().primary().label(tr("folder_git_create"))
                    .loading(self.git.busy == Some(GitAction::Create)).disabled(locked || name.is_empty() || blocked)
                    .on_click(cx.listener(|this, _, _, cx| this.git_create(cx)))))
            .into_any_element()
    }
}

#[cfg(test)]
mod tests {
    use super::{FolderGit, status_line, summary, tr};

    #[test]
    fn the_pill_says_behind_ahead_and_changes_or_up_to_date() {
        let git = |behind, ahead, dirty, upstream: Option<&str>| FolderGit { repo: true, behind: Some(behind), ahead: Some(ahead), dirty,
            upstream: upstream.map(str::to_owned), ..Default::default() };
        assert_eq!(summary(&git(0, 0, 0, Some("origin/main"))), tr("folder_git_up_to_date"));
        assert_eq!(summary(&git(0, 0, 0, None)), tr("folder_git_label"));
        assert_eq!(summary(&git(2, 1, 0, Some("origin/main"))), "↓2 · ↑1");
        assert!(summary(&git(0, 0, 3, Some("origin/main"))).contains('3'));
        let never = status_line(&git(0, 0, 0, Some("origin/main")), 100.);
        assert!(never.starts_with("origin/main") && never.ends_with(&tr("folder_git_never_fetched")));
        assert!(git(1, 1, 0, Some("o/m")).diverged() && !git(1, 0, 0, Some("o/m")).diverged());
    }
}
