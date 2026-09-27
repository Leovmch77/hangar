//! Git da sessão, aberto pela faixa embaixo do compositor: o `Git.svelte` + `GitTabs` do web no desktop, um diálogo
//! centrado com abas. Só as rotas `/git*`, `/branches` e `/checkout` do backend; nada é escrito sem gesto.
use super::*;
use super::device::Remote;
use gpui_kit::component::{WindowExt, tab::{Tab, TabBar}};

/// Tamanho do diálogo do web no desktop: `min(1100px, 92vw)` por `min(72vh, 720px)`.
const MAX_W: f32 = 1100.;
const MAX_H: f32 = 720.;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
enum Pane { #[default] Changes }

#[derive(Clone, Debug)]
struct Changed { path: String, code: String, added: Option<i64>, removed: Option<i64> }

#[derive(Debug, Default)]
struct Repo { files: Vec<Changed>, current: Option<String>, dirty: bool }

fn changed(value: &Value) -> Vec<Changed> {
    value.get("files").and_then(Value::as_array).map(|list| list.iter().filter_map(|f| Some(Changed {
        path: f.get("path")?.as_str()?.to_owned(),
        code: f.get("code").and_then(Value::as_str).unwrap_or("").to_owned(),
        added: f.get("added").and_then(Value::as_i64),
        removed: f.get("removed").and_then(Value::as_i64),
    })).collect()).unwrap_or_default()
}

fn repo(branches: &Value, files: &Value) -> Repo {
    Repo {
        files: changed(files),
        current: branches.get("current").and_then(Value::as_str).map(str::to_owned),
        dirty: branches.get("dirty").and_then(Value::as_bool).unwrap_or(false),
    }
}

/// O git roda com `LC_ALL=C`: fora de um repositório a frase vem sempre igual, e a linha crua do git não ajuda ninguém.
fn failure(error: &Failure) -> String {
    if error.detail.contains("not a git repository") { tr("git_not_repo") } else { Hangar::fetch_failure(error) }
}

/// Código XY do porcelain em uma letra, como a coluna do web: `??` é arquivo novo.
fn code_tag(code: &str) -> (String, Hsla) {
    let code = code.trim();
    if code == "??" { return ("U".into(), theme::accent()); }
    let first = code.chars().next().unwrap_or('M');
    (first.to_string(), if first == 'D' { theme::removed() } else { theme::warning() })
}

pub(super) struct GitPanel {
    api: Api,
    runtime: Arc<Runtime>,
    name: String,
    title: String,
    pane: Pane,
    repo: Remote<Repo>,
    error: Option<String>,
}

impl GitPanel {
    fn new(api: Api, runtime: Arc<Runtime>, name: String, title: String) -> Self {
        Self { api, runtime, name, title, pane: Pane::default(), repo: Remote::default(), error: None }
    }

    /// Roda no runtime do app e devolve ao painel; painel fechado, a resposta cai.
    fn spawn<T: Send + 'static>(&self, job: impl Future<Output = T> + Send + 'static, window: &mut Window, cx: &mut Context<Self>,
        done: impl FnOnce(&mut Self, T, &mut Window, &mut Context<Self>) + 'static) {
        let job = self.runtime.spawn(job);
        cx.spawn_in(window, async move |this, cx| {
            let Ok(value) = job.await else { return };
            let _ = this.update_in(cx, |this, window, cx| { done(this, value, window, cx); cx.notify(); });
        }).detach();
    }

    /// Branches e arquivos alterados juntos, como o `refresh` do web.
    fn load(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let seq = self.repo.start();
        let (api, name) = (self.api.clone(), self.name.clone());
        self.spawn(async move {
            let (branches, files) = tokio::join!(api.read(&name, &["branches"], &[], 30), api.read(&name, &["git", "files"], &[], 30));
            Ok::<_, Failure>(repo(&branches?, &files?))
        }, window, cx, move |this, result, _, _| { this.repo.finish(seq, result.map_err(|error| failure(&error))); });
        cx.notify();
    }

    fn render_changes(&self, repo: &Repo) -> AnyElement {
        if repo.files.is_empty() {
            return div().p_4().text_sm().text_color(theme::muted()).child(tr("git_clean")).into_any_element();
        }
        div().id("git-files").size_full().overflow_y_scroll().flex().flex_col().gap(px(2.))
            .children(repo.files.iter().map(|file| self.file_row(file)))
            .into_any_element()
    }

    fn file_row(&self, file: &Changed) -> AnyElement {
        let (tag, tag_color) = code_tag(&file.code);
        let (dir, base) = match file.path.rfind('/') { Some(at) => (&file.path[..at], &file.path[at + 1..]), None => ("", file.path.as_str()) };
        div().flex().items_center().gap_2().px_2().py(px(5.)).rounded(px(8.)).text_sm().min_w_0()
            .child(div().flex_shrink_0().w(px(14.)).font_family(theme::MONO).text_xs().text_color(tag_color).child(tag))
            .child(div().flex_shrink_0().max_w(relative(0.6)).truncate().text_color(theme::text()).child(base.to_owned()))
            .child(div().flex_1().min_w_0().truncate().text_xs().text_color(theme::faint()).child(dir.to_owned()))
            .when_some(file.added.zip(file.removed), |el, (a, r)| el.child(div().flex_shrink_0().flex().gap_1().font_family(theme::MONO).text_xs()
                .child(div().text_color(theme::success()).child(format!("+{a}")))
                .child(div().text_color(theme::removed()).child(format!("−{r}")))))
            .into_any_element()
    }
}

impl Render for GitPanel {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let height = (f32::from(window.viewport_size().height) * 0.72).min(MAX_H);
        let repo = self.repo.ok();
        let branch = repo.and_then(|r| r.current.clone());
        let dirty = repo.is_some_and(|r| r.dirty);
        // Cabeçalho do web: de qual repositório é, a branch e o reler; o × é o do diálogo.
        let header = div().flex().items_center().gap_2().pr(px(36.)).h(px(28.))
            .child(div().min_w(px(80.)).truncate().font_weight(FontWeight::SEMIBOLD).text_color(theme::text()).child(self.title.clone()))
            .when_some(branch, |el, branch| el.child(div().min_w_0().truncate().px(px(8.)).py(px(1.)).rounded_full().border_1()
                .border_color(theme::border_strong()).font_family(theme::MONO).text_xs().text_color(theme::muted()).child(branch)))
            .when(dirty, |el| el.child(div().text_color(theme::warning()).child("*")))
            .child(div().flex_1())
            .child(chrome::icon_button("git-reload", IconName::RefreshCw, tr("git_reload"), cx).disabled(self.repo.loading)
                .on_click(cx.listener(|this, _, window, cx| this.load(window, cx))));
        let count = |n: usize| div().px(px(6.)).rounded_full().bg(theme::raised()).font_family(theme::MONO).text_size(px(10.))
            .text_color(theme::muted()).child(n.to_string());
        let tabs = TabBar::new("git-tabs").underline().small().selected_index(0)
            .child(Tab::new().label(tr("git_changes")).when_some(repo.map(|r| r.files.len()).filter(|n| *n > 0), |tab, n| tab.suffix(count(n))));
        let body = match &self.repo.value {
            None => popup::skeleton("git-loading", 6).into_any_element(),
            Some(Err(reason)) => div().id("git-failed").p_4().flex().flex_col().items_start().gap_3().role(Role::Alert)
                .child(div().text_sm().text_color(theme::warning()).whitespace_normal().child(reason.clone()))
                .child(Button::new("git-retry").small().label(tr("retry")).on_click(cx.listener(|this, _, window, cx| this.load(window, cx))))
                .into_any_element(),
            Some(Ok(repo)) => match self.pane { Pane::Changes => self.render_changes(repo) },
        };
        div().h(px(height)).flex().flex_col().gap_3()
            .child(header)
            .child(div().flex_shrink_0().border_b_1().border_color(theme::border()).child(tabs))
            .child(div().flex_1().min_h_0().child(body))
            .when_some(self.error.clone(), |el, error| el.child(div().id("git-error").flex_shrink_0().role(Role::Alert).text_sm()
                .text_color(theme::danger()).whitespace_normal().child(error)))
    }
}

impl Hangar {
    /// A faixa do compositor abre o git da sessão aberta, como o chip do repositório do web.
    pub(super) fn open_git_panel(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let (Some(api), Some(session)) = (self.api.clone(), self.selected.clone()) else { return };
        let title = folder_name(&session).unwrap_or_else(|| session.name.clone());
        let runtime = self.runtime.clone();
        let panel = cx.new(|_| GitPanel::new(api, runtime, session.name.clone(), title));
        panel.update(cx, |panel, cx| panel.load(window, cx));
        window.open_dialog(cx, move |dialog, window, _| {
            let width = (f32::from(window.viewport_size().width) * 0.92).min(MAX_W);
            popup::dialog(dialog).w(px(width)).on_ok(super::machines::enter_to_focused).child(panel.clone())
        });
    }
}
