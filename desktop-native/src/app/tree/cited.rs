//! A vista "citados" da aba Arquivos, como a do web: todo arquivo que a conversa citou, inclusive fora da pasta da
//! sessão. Sessão desta máquina confere no disco; de outra máquina, pelo `files/resolver` do backend, de uma vez.
//! O que não existe não aparece.
use super::*;

/// Teto de caminhos conferidos: os mais recentes primeiro.
const MAX: usize = 300;

#[derive(Clone)]
struct Cited { raw: String, real: String, relative: Option<String> }

#[derive(Default)]
pub(in crate::app) struct CitedView {
    pub(in crate::app) on: bool,
    list: Option<Result<Vec<Cited>, String>>,
    /// Geração da árvore e quantos eventos a conversa tinha na última leitura: só relê quando um dos dois muda.
    read_for: Option<(u64, usize)>,
    /// Índices da lista que passam na busca, refeitos a cada desenho.
    shown: Vec<usize>,
}

impl CitedView {
    /// Outra sessão: a lista da anterior some; a vista escolhida fica.
    pub(in crate::app) fn reset(&mut self) { (self.list, self.read_for) = (None, None); }
}

/// No disco: absoluto (ou `~/`) como está, relativo pela pasta da sessão e depois pelas pastas dos `cd` da conversa;
/// só arquivo comum, fora de `.git`.
fn resolve_local(root: &Path, paths: Vec<String>, dirs: Vec<String>) -> Vec<Cited> {
    let root = std::fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
    let home = std::env::var_os("HOME").map(PathBuf::from);
    let usable = |p: PathBuf| std::fs::canonicalize(p).ok().filter(|p| p.is_file() && !p.components().any(|c| c.as_os_str() == ".git"));
    let mut seen = HashSet::new();
    paths.into_iter().filter_map(|raw| {
        let real = match raw.strip_prefix("~/") {
            Some(rest) => usable(home.as_ref()?.join(rest)),
            None if raw.starts_with('/') => usable(PathBuf::from(&raw)),
            None => std::iter::once(root.clone()).chain(dirs.iter().map(PathBuf::from)).find_map(|dir| usable(dir.join(&raw))),
        }?;
        let relative = real.strip_prefix(&root).ok().map(|p| p.to_string_lossy().into_owned());
        let real = real.to_string_lossy().into_owned();
        seen.insert(real.clone()).then_some(Cited { raw, real, relative })
    }).collect()
}

impl Hangar {
    /// Os caminhos citados, dos mais recentes, e as pastas dos `cd` da conversa.
    fn cited_paths(&self) -> (Vec<String>, Vec<String>) {
        fn collect(value: &Value, out: &mut Vec<String>, dirs: &mut Vec<String>) {
            match value {
                Value::String(text) => {
                    for reference in composer::code_references(text) {
                        // Pedaço relativo pode ser o fim de um absoluto com espaço que o leitor cortou ("…/Área de trabalho/x.sql").
                        let whole = if reference.path.starts_with(['/', '~']) { Vec::new() } else { composer::spaced_paths(text, &reference.path) };
                        for path in whole.into_iter().chain(std::iter::once(reference.path)) {
                            if !out.contains(&path) { out.push(path); }
                        }
                    }
                    for dir in composer::cd_dirs(text) { if !dirs.contains(&dir) { dirs.push(dir); } }
                }
                Value::Array(items) => for item in items { collect(item, out, dirs); },
                Value::Object(items) => for item in items.values() { collect(item, out, dirs); },
                _ => {},
            }
        }
        let (mut out, mut dirs) = (Vec::new(), Vec::new());
        for event in self.chat.events.iter().rev() {
            collect(&json!([event.text, event.tool_input, event.result]), &mut out, &mut dirs);
            if out.len() >= MAX { break; }
        }
        out.truncate(MAX);
        (out, dirs)
    }

    fn cited_sync(&mut self, cx: &mut Context<Self>) {
        let stamp = (self.tree.generation, self.chat.events.len());
        if !self.tree.cited.on || self.tree.cited.read_for == Some(stamp) { return; }
        // Espera a árvore saber se a pasta é desta máquina; antes disso não dá para escolher entre disco e backend.
        let Some(source) = self.tree.source.as_ref() else { return };
        let local = source.root().map(Path::to_path_buf);
        let (Some(api), Some(session)) = (self.session_api(), self.selected.as_ref()) else { return };
        self.tree.cited.read_for = Some(stamp);
        let (paths, dirs) = self.cited_paths();
        if paths.is_empty() { self.tree.cited.list = Some(Ok(Vec::new())); return; }
        let name = session.name.clone();
        let job = self.runtime.spawn(async move {
            if let Some(root) = local {
                return tokio::task::spawn_blocking(move || resolve_local(&root, paths, dirs)).await.map_err(|_| Failure::local("invalid_response"));
            }
            api.act(&name, &["files", "resolver"], Some(json!({"caminhos": paths.clone()})), false, 30).await.map(|value| {
                let mut seen = HashSet::new();
                paths.into_iter().filter_map(|raw| {
                    let entry = value.get("ok")?.get(&raw)?;
                    let real = entry.get("real").and_then(Value::as_str).unwrap_or(&raw).to_owned();
                    let relative = entry.get("relativo").and_then(Value::as_str).map(str::to_owned);
                    seen.insert(real.clone()).then_some(Cited { raw, real, relative })
                }).collect::<Vec<_>>()
            })
        });
        cx.spawn(async move |this, cx| {
            let Ok(result) = job.await else { return };
            let _ = this.update(cx, |this, cx| {
                if this.tree.cited.read_for != Some(stamp) { return; }
                this.tree.cited.list = Some(result.map_err(|error| Self::fetch_failure(&error)));
                this.redraw(Area::Side, cx);
            });
        }).detach();
    }

    pub(super) fn cited_count(&self) -> Option<usize> { self.tree.cited.list.as_ref()?.as_ref().ok().map(Vec::len) }

    pub(super) fn cited_toggle(&mut self, on: bool, cx: &mut Context<Self>) {
        self.tree.cited.on = on;
        self.redraw(Area::Side, cx);
    }

    fn cited_row(&self, ix: usize, cx: &mut Context<Self>) -> Option<AnyElement> {
        let at = *self.tree.cited.shown.get(ix)?;
        let item = self.tree.cited.list.as_ref()?.as_ref().ok()?.get(at)?.clone();
        let shown = item.relative.clone().unwrap_or_else(|| abbreviate(&item.real));
        let (folder, name) = shown.rsplit_once('/').map_or((String::new(), shown.clone()), |(f, n)| (f.to_owned(), n.to_owned()));
        let open = item.relative.clone().unwrap_or(item.raw.clone());
        Some(div().h(px(ROW_H)).w_full().px_1().child(div().id(SharedString::from(format!("tree-cited-{}", item.real)))
            .role(Role::ListBoxOption).aria_label(shown.clone())
            .size_full().px_2().flex().items_center().gap(px(8.)).rounded(px(6.)).cursor_pointer()
            .hover(|el| el.bg(theme::hover()))
            .on_click(cx.listener(move |this, _, window, cx| this.open_file(open.clone(), None, window, cx)))
            .child(crate::fileicons::tree_icon(&name, false, false))
            .child(div().flex_none().max_w(relative(0.6)).truncate().text_size(px(12.)).text_color(theme::text()).child(name))
            .child(div().flex_1().min_w_0().truncate().text_size(px(11.)).text_color(theme::faint()).child(folder)))
            .into_any_element())
    }

    pub(super) fn render_cited(&mut self, cx: &mut Context<Self>) -> AnyElement {
        self.cited_sync(cx);
        let note = |text: String, color: Hsla| div().px_4().py_2().text_xs().text_color(color).whitespace_normal().child(text).into_any_element();
        let query = self.tree.query.to_lowercase();
        let shown: Vec<usize> = match &self.tree.cited.list {
            Some(Ok(list)) => list.iter().enumerate()
                .filter(|(_, c)| query.is_empty() || c.relative.as_deref().unwrap_or(&c.real).to_lowercase().contains(&query))
                .map(|(ix, _)| ix).collect(),
            _ => Vec::new(),
        };
        self.tree.cited.shown = shown;
        match &self.tree.cited.list {
            None => note(activity::web("arq_carregando"), theme::muted()),
            Some(Err(reason)) => note(reason.clone(), theme::warning()),
            Some(Ok(list)) if list.is_empty() => note(activity::web("arq_citados_vazio"), theme::muted()),
            Some(Ok(_)) if self.tree.cited.shown.is_empty() => note(activity::web("arq_sem_nome"), theme::muted()),
            Some(Ok(_)) => uniform_list("tree-cited", self.tree.cited.shown.len(), cx.processor(|this, range: std::ops::Range<usize>, _, cx| {
                range.filter_map(|ix| this.cited_row(ix, cx)).collect::<Vec<_>>()
            })).flex_1().into_any_element(),
        }
    }
}

/// `/home/<usuário>/x` vira `~/x`, como a pasta mostrada no web.
fn abbreviate(path: &str) -> String {
    match std::env::var("HOME") {
        Ok(home) if path.starts_with(&format!("{home}/")) => format!("~{}", &path[home.len()..]),
        _ => path.to_owned(),
    }
}
