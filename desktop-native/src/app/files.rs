//! Arquivos sobre a conversa, no molde do visor do Zeron (`files/preview.rs`, MIT, ver `LICENSE-ZERON`): abas com o
//! ícone do tipo, trilha do caminho, Markdown com o estilo da conversa, código com cores e imagem. Cada aba conserva
//! seu rascunho e seu pedido.
use super::*;
use gpui_kit::component::input::{Editor, EditorState, Position, RopeExt};

actions!(file_view, [CloseFile, NextFile, PreviousFile, SaveFile]);

/// Lado maior da imagem decodificada: cabe numa tela grande sem guardar o original inteiro na memória.
const PICTURE_SIDE: u32 = 4096;
const UNREADABLE_PICTURE: &str = "file_image_unreadable";

pub(super) struct Files {
    owner: Option<(u64, String)>,
    hidden: bool,
    tabs: Vec<FileTab>,
    active: usize,
    serial: u64,
    /// O visor toma a janela: a lista de sessões e o painel direito saem enquanto ele está à vista.
    expanded: bool,
    focus: FocusHandle,
    return_focus: Option<FocusHandle>,
    _focus_lost: Subscription,
}

struct FileTab {
    id: u64,
    path: String,
    line: Option<u32>,
    content: Option<Result<Document, String>>,
    /// Imagem: mostrada, não editada.
    picture: Option<Picture>,
    /// Markdown abre na prévia, como no Zeron; o botão alterna para o código.
    preview: bool,
}

#[derive(serde::Deserialize)]
pub(super) struct Content { path: String, text: String, truncated: bool, digest: Option<String>, #[serde(skip)] external: bool }
impl Content {
    fn editable(&self) -> bool { !self.truncated && self.digest.as_ref().is_some_and(|digest| !digest.is_empty()) }
}
pub(super) enum FileReply {
    Read(u64, Result<Content, Failure>),
    Saved(u64, String, Result<Value, Failure>),
    Picture(u64, Result<Arc<RenderImage>, Failure>),
    /// Link relativo clicado na prévia de Markdown, já resolvido contra a pasta do documento.
    Open(String),
}

/// Da raiz, direto do disco (servidor nesta máquina); fora dela, pela rota de arquivo citado, que só serve o que a
/// conversa mencionou.
enum Picture { Disk(PathBuf), Loading, Ready(Arc<RenderImage>), Failed(String) }

struct Document {
    editor: Entity<EditorState>,
    base: Content,
    saving: bool,
    dirty: bool,
    saved: Option<Instant>,
    error: Option<String>,
    markdown: Option<Entity<TextViewState>>,
    _changed: Subscription,
}

impl Document {
    fn editable(&self) -> bool { self.base.editable() }
    fn dirty(&self) -> bool { self.dirty }
}

fn file_failure(error: &Failure) -> String {
    if error.detail.starts_with("erro_arq_") {
        return Hangar::fetch_failure(error);
    }
    match error.status {
        Some(409) => activity::web("erro_arq_mudou_no_disco"),
        Some(413) => activity::web("erro_arq_grande_demais"),
        Some(415) => activity::web("erro_arq_binario"),
        _ => Hangar::fetch_failure(error),
    }
}

pub(super) fn file_language(path: &str) -> &'static str {
    let extension = std::path::Path::new(path).extension().and_then(|s| s.to_str()).unwrap_or("").to_ascii_lowercase();
    match extension.as_str() {
        "rs" => "rust",
        "ts" | "mts" | "cts" => "typescript",
        "tsx" => "tsx",
        "js" | "mjs" | "cjs" | "jsx" => "javascript",
        "py" => "python",
        "json" => "json",
        "toml" => "toml",
        "yaml" | "yml" => "yaml",
        "md" | "markdown" => "markdown",
        "sh" | "bash" | "zsh" => "bash",
        "css" => "css",
        "html" | "htm" => "html",
        "vue" => "html",
        "svelte" => "svelte",
        "sql" => "sql",
        "c" | "h" => "c",
        "cc" | "cpp" | "hpp" => "cpp",
        "java" => "java",
        "cs" => "csharp",
        "kt" => "kotlin",
        "go" => "go",
        "rb" => "ruby",
        "lua" => "lua",
        "swift" => "swift",
        "php" => "php",
        _ => "text",
    }
}

impl Files {
    pub fn new(window: &mut Window, cx: &mut Context<Hangar>) -> Self {
        cx.bind_keys([
            KeyBinding::new("alt-w", CloseFile, Some("FileViewer")),
            KeyBinding::new("ctrl-pageup", PreviousFile, Some("FileViewer")),
            KeyBinding::new("ctrl-pagedown", NextFile, Some("FileViewer")),
            KeyBinding::new("secondary-s", SaveFile, Some("FileViewer")),
        ]);
        let focus = cx.focus_handle();
        let lost = cx.on_focus_lost(window, |this, window, cx| this.files_focus_lost(window, cx));
        Self { owner: None, hidden: false, tabs: Vec::new(), active: 0, serial: 0, expanded: false,
            focus, return_focus: None, _focus_lost: lost }
    }
}

async fn read_file(api: Api, name: String, mut path: String, candidates: Vec<String>, local: Option<PathBuf>) -> Result<Content, Failure> {
    // Servidor nesta máquina (a árvore já provou): caminho da raiz sai do disco, com as mesmas travas.
    if let Some(root) = local.filter(|root| !path.starts_with('/') && root.join(&path).exists()) {
        return tokio::task::spawn_blocking(move || super::tree::read_local(&root, &path).map(|read|
            Content { path, text: read.text, truncated: read.truncated, digest: read.digest, external: false }))
            .await.unwrap_or_else(|_| Err(Failure::local("invalid_response")));
    }
    let mut resolved = api.act(&name, &["files", "resolver"], Some(json!({"caminhos": [&path]})), false, 30).await?;
    if resolved.get("ok").and_then(|v| v.get(&path)).is_none() && !candidates.is_empty() {
        resolved = api.act(&name, &["files", "resolver"], Some(json!({"caminhos": candidates})), false, 30).await?;
        if let Some(found) = candidates.into_iter().find(|candidate| resolved.get("ok").and_then(|v| v.get(candidate)).is_some()) { path = found; }
    }
    let entry = resolved.get("ok").and_then(|v| v.get(&path)).ok_or_else(|| Failure::local("file_missing"))?;
    let (route, requested) = match entry.get("relativo") {
        Some(Value::String(relative)) => (["files", "read"], relative.as_str()),
        Some(Value::Null) => (["file", "text"], path.as_str()),
        _ => return Err(Failure::local("invalid_response")),
    };
    let mut content: Content = serde_json::from_value(api.read(&name, &route, &[("path", requested)], 30).await?)
        .map_err(|_| Failure::local("invalid_response"))?;
    content.external = route[0] == "file";
    Ok(content)
}

impl Hangar {
    fn files_visible(&self) -> bool {
        self.files.owner.is_some() && self.files.owner == self.session_owner() && !self.files.tabs.is_empty() && !self.files.hidden
            && (self.settings.is_none() || self.settings_live())
    }

    pub(super) fn open_file(&mut self, path: String, line: Option<u32>, window: &mut Window, cx: &mut Context<Self>) {
        let (Some(api), Some(key)) = (self.api.clone(), self.selected_key()) else { return };
        if !self.files_visible() {
            let owner = self.session_owner();
            if self.files.owner != owner { for tab in std::mem::take(&mut self.files.tabs) { release(tab, window, cx); } }
            self.files.owner = owner;
            self.files.hidden = false;
            self.files.return_focus = window.focused(cx);
        }
        if let Some(ix) = self.files.tabs.iter().position(|tab| tab.path == path) {
            self.files.active = ix;
            self.files.tabs[ix].line = line;
            self.focus_file(window, cx);
            return;
        }
        self.files.serial += 1;
        let id = self.files.serial;
        let local = self.tree.local_root(&self.session_owner());
        // A leitura de texto recusa binário: imagem vem do disco ou da rota de arquivo citado.
        let picture = is_image(&path).then(|| local.as_ref().and_then(|root| super::tree::resolve(root, &path).ok())
            .map_or(Picture::Loading, Picture::Disk));
        let fetch_picture = matches!(picture, Some(Picture::Loading));
        let is_picture = picture.is_some();
        let preview = file_language(&path) == "markdown";
        self.files.tabs.push(FileTab { id, path: path.clone(), line, content: None, picture, preview });
        self.files.active = self.files.tabs.len() - 1;
        self.focus_file(window, cx);
        let (connection, selection, tx) = (self.connection, None, self.tx.clone());
        if fetch_picture {
            let (api, name, path, tx) = (api.clone(), key.name.clone(), path.clone(), tx.clone());
            self.runtime.spawn(async move {
                let result = api.fetch(&name, &Source::Cited(path)).await.and_then(|bytes|
                    crate::media::decode(&bytes, PICTURE_SIDE, PICTURE_SIDE, None).ok_or_else(|| Failure::local(UNREADABLE_PICTURE)));
                let _ = tx.send(Envelope { connection, selection, payload: Payload::FileView(FileReply::Picture(id, result)) }).await;
            });
        }
        if is_picture { return; }
        let mut candidates = Vec::new();
        if !path.contains('/') {
            fn collect(value: &Value, name: &str, out: &mut Vec<String>) {
                match value {
                    Value::String(text) => for reference in composer::code_references(text) {
                        if reference.path.ends_with(&format!("/{name}")) && !out.contains(&reference.path) { out.push(reference.path); }
                    },
                    Value::Array(items) => for item in items { collect(item, name, out); },
                    Value::Object(items) => for item in items.values() { collect(item, name, out); },
                    _ => {},
                }
            }
            for event in &self.chat.events { collect(&json!([event.text, event.tool_input, event.result]), &path, &mut candidates); }
        }
        self.runtime.spawn(async move {
            let result = read_file(api, key.name, path, candidates, local).await;
            let _ = tx.send(Envelope { connection, selection, payload: Payload::FileView(FileReply::Read(id, result)) }).await;
        });
    }

    pub(super) fn receive_file_view(&mut self, reply: FileReply, window: &mut Window, cx: &mut Context<Self>) {
        let (id, result) = match reply {
            FileReply::Read(id, result) => (id, result),
            FileReply::Saved(id, text, result) => { self.file_saved(id, text, result, cx); return; }
            FileReply::Open(path) => { self.open_file(path, None, window, cx); return; }
            FileReply::Picture(id, result) => {
                let slot = self.files.tabs.iter_mut().find(|tab| tab.id == id).and_then(|tab| tab.picture.as_mut());
                match (slot, result) {
                    (Some(slot), Ok(image)) => *slot = Picture::Ready(image),
                    (Some(slot), Err(error)) => *slot = Picture::Failed(if error.detail == UNREADABLE_PICTURE { tr(UNREADABLE_PICTURE) } else { file_failure(&error) }),
                    // A aba fechou enquanto a imagem chegava.
                    (None, Ok(image)) => cx.drop_image(image, Some(window)),
                    (None, Err(_)) => {}
                }
                cx.notify();
                return;
            }
        };
        let Some(ix) = self.files.tabs.iter().position(|tab| tab.id == id) else { return };
        let path = &self.files.tabs[ix].path;
        self.files.tabs[ix].content = Some(result.map(|content| {
            let editor = cx.new(|cx| EditorState::new(window, cx).language(file_language(path)).default_value(content.text.clone()).soft_wrap(true));
            let changed = cx.subscribe_in(&editor, window, move |this: &mut Self, _, event: &InputEvent, _, cx| {
                if matches!(event, InputEvent::Change) {
                    if let Some(tab) = this.files.tabs.iter_mut().find(|tab| tab.id == id) {
                        if let Some(Ok(doc)) = &mut tab.content {
                            doc.dirty = doc.editor.read(cx).value().as_ref() != doc.base.text;
                            doc.saved = None;
                        }
                    }
                    cx.notify();
                }
            });
            let markdown = (file_language(path) == "markdown").then(|| cx.new(|cx| TextViewState::markdown(&content.text, cx)));
            let doc = Document { editor, base: content, saving: false, dirty: false, saved: None, error: None, markdown, _changed: changed };
            doc.editor.update(cx, |state, cx| state.set_readonly(!doc.editable(), cx));
            doc
        }).map_err(|error| match error.status {
            Some(415) => activity::web("erro_arq_binario"),
            Some(404) => activity::web("erro_arq_inexistente"),
            None if error.detail == "file_missing" => activity::web("erro_arq_inexistente"),
            _ => file_failure(&error),
        }));
        // A leitura não toma o foco de outra aba, diálogo ou campo aberto enquanto esperava.
        if ix == self.files.active && self.files.focus.contains_focused(window, cx) { self.focus_file(window, cx); }
        cx.notify();
    }

    fn save_file(&mut self, cx: &mut Context<Self>) {
        if !self.files_visible() { return; }
        let (Some(api), Some(key)) = (self.api.clone(), self.selected_key()) else { return };
        let tab = &mut self.files.tabs[self.files.active];
        let Some(Ok(doc)) = &mut tab.content else { return };
        if doc.saving || !doc.editable() || !doc.dirty() { return; }
        let text = doc.editor.read(cx).value().to_string();
        let body = json!({"path": doc.base.path, "text": text, "digest": doc.base.digest});
        let route = if doc.base.external { ["file", "text"] } else { ["files", "write"] };
        (doc.saving, doc.saved, doc.error) = (true, None, None);
        // A resposta não pode apagar uma edição feita depois do envio.
        doc.editor.update(cx, |state, cx| state.set_readonly(true, cx));
        let (id, connection, selection, tx) = (tab.id, self.connection, None, self.tx.clone());
        self.runtime.spawn(async move {
            let result = api.act(&key.name, &route, Some(body), false, 30).await;
            let _ = tx.send(Envelope { connection, selection, payload: Payload::FileView(FileReply::Saved(id, text, result)) }).await;
        });
        cx.notify();
    }

    fn file_saved(&mut self, id: u64, text: String, result: Result<Value, Failure>, cx: &mut Context<Self>) {
        let Some(tab) = self.files.tabs.iter_mut().find(|tab| tab.id == id) else { return };
        let Some(Ok(doc)) = &mut tab.content else { return };
        doc.saving = false;
        doc.editor.update(cx, |state, cx| state.set_readonly(!doc.editable(), cx));
        match result.and_then(|value| value.get("digest").and_then(Value::as_str).filter(|s| !s.is_empty())
            .map(str::to_owned).ok_or_else(|| Failure::local("invalid_response"))) {
            Ok(digest) => {
                (doc.base.text, doc.base.digest) = (text, Some(digest));
                doc.dirty = false;
                let saved = Instant::now();
                doc.saved = Some(saved);
                cx.spawn(async move |this, cx| {
                    cx.background_executor().timer(Duration::from_secs(2)).await;
                    let _ = this.update(cx, |this, cx| {
                        if let Some(tab) = this.files.tabs.iter_mut().find(|tab| tab.id == id) {
                            if let Some(Ok(doc)) = &mut tab.content {
                                if doc.saved == Some(saved) { doc.saved = None; cx.notify(); }
                            }
                        }
                    });
                }).detach();
            }
            Err(error) => doc.error = Some(file_failure(&error)),
        }
        cx.notify();
    }

    fn discard_file(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if !self.files_visible() { return; }
        let Some(Ok(doc)) = &mut self.files.tabs[self.files.active].content else { return };
        if doc.saving { return; }
        doc.editor.update(cx, |state, cx| state.set_value(doc.base.text.clone(), window, cx));
        doc.dirty = false;
        (doc.error, doc.saved) = (None, None);
        cx.notify();
    }

    fn toggle_preview(&mut self, cx: &mut Context<Self>) {
        let tab = &mut self.files.tabs[self.files.active];
        tab.preview = !tab.preview;
        // A prévia mostra o texto do editor, com o que ainda não foi salvo.
        if let (true, Some(Ok(doc))) = (tab.preview, &tab.content) {
            let text = doc.editor.read(cx).value().to_string();
            if let Some(view) = &doc.markdown { view.update(cx, |view, cx| view.set_text(&text, cx)); }
        }
        cx.notify();
    }

    fn focus_file(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let tab = &mut self.files.tabs[self.files.active];
        let id = tab.id;
        if let Some(Ok(doc)) = &tab.content {
            let line = tab.line.take();
            let row = doc.editor.update(cx, |state, cx| {
                if let Some(line) = line {
                    let row = line.saturating_sub(1).min(state.text().lines_len().saturating_sub(1) as u32);
                    state.set_cursor_position(Position::new(row, 0), window, cx);
                    Some(row)
                }
                else { state.focus(window, cx); None }
            });
            if let Some(row) = row {
                // O editor novo só tem medida depois do primeiro desenho.
                cx.on_next_frame(window, move |_, window, cx| cx.on_next_frame(window,
                    move |this, window, cx| this.reveal_file_line(id, row, window, cx)));
            }
        } else { self.files.focus.focus(window, cx); }
        cx.notify();
    }

    fn reveal_file_line(&mut self, id: u64, row: u32, window: &mut Window, cx: &mut Context<Self>) {
        if !self.files_visible() { return; }
        let tab = &self.files.tabs[self.files.active];
        if tab.id != id { return; }
        if let Some(Ok(doc)) = &tab.content {
            doc.editor.update(cx, |state, cx| {
                let position = Position::new(row, 0);
                if state.focus_handle(cx).is_focused(window) && state.cursor_position() == position {
                    state.set_cursor_position(position, window, cx);
                }
            });
        }
    }

    fn files_focus_lost(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if !self.files_visible() { return; }
        window.focus_lost_restore_target(cx).unwrap_or_else(|| self.root_focus.clone()).focus(window, cx);
    }

    fn step_file(&mut self, forward: bool, window: &mut Window, cx: &mut Context<Self>) {
        if !self.files_visible() { return; }
        let n = self.files.tabs.len();
        self.files.active = (self.files.active + if forward { 1 } else { n - 1 }) % n;
        self.focus_file(window, cx);
    }

    fn close_file(&mut self, id: u64, window: &mut Window, cx: &mut Context<Self>) {
        let Some(ix) = self.files.tabs.iter().position(|tab| tab.id == id) else { return };
        release(self.files.tabs.remove(ix), window, cx);
        if self.files.tabs.is_empty() { self.restore_file_focus(window, cx); }
        else {
            if ix < self.files.active { self.files.active -= 1; }
            self.files.active = self.files.active.min(self.files.tabs.len() - 1);
            self.focus_file(window, cx);
        }
        cx.notify();
    }

    fn restore_file_focus(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.files.return_focus.take().filter(|focus| self.root_focus.contains(focus, window))
            .unwrap_or_else(|| self.root_focus.clone()).focus(window, cx);
    }

    pub(super) fn files_escape(&mut self, window: &mut Window, cx: &mut Context<Self>) -> bool {
        if !self.files_visible() { return false; }
        self.files.hidden = true;
        self.restore_file_focus(window, cx);
        cx.notify();
        true
    }

    pub(super) fn files_expanded(&self) -> bool { self.files.expanded && self.files_visible() }

    /// O "+" do Zeron abre outro arquivo: aqui, a busca da aba Arquivos do painel.
    fn file_add(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.files.expanded = false;
        if !self.side.open { self.toggle_side(cx); }
        self.choose_side_tab(crate::appearance::SideTab::Files, window, cx);
        self.tree_focus_search(window, cx);
    }

    /// Abrir pasta: a árvore do painel abre as pastas até o arquivo e o deixa marcado.
    fn file_reveal(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let path = self.files.tabs[self.files.active].path.clone();
        self.files.expanded = false;
        if !self.side.open { self.toggle_side(cx); }
        self.choose_side_tab(crate::appearance::SideTab::Files, window, cx);
        self.tree_reveal_path(path, cx);
    }

    pub(super) fn render_file_view(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        if !self.files_visible() { return None; }
        let tab = &self.files.tabs[self.files.active];
        let name = composer::basename(&tab.path).to_owned();
        let tabs = div().id("file-tabs").role(Role::TabList).aria_label(tr("file_tabs")).min_w_0().flex().items_center().gap_1().overflow_x_scroll()
            .children(self.files.tabs.iter().enumerate().map(|(ix, tab)| {
                let (id, active) = (tab.id, ix == self.files.active);
                let mark = match &tab.content {
                    Some(Ok(doc)) if doc.error.is_some() => Some(true),
                    Some(Ok(doc)) if doc.dirty() => Some(false),
                    _ => None,
                };
                let tip = mark.map_or(tab.path.clone(), |failed| format!("{} · {}", tab.path,
                    activity::web(if failed { "arq_falhou_salvar" } else { "arq_nao_salvo" })));
                let group = SharedString::from(format!("file-tab-{id}"));
                let name = composer::basename(&tab.path).to_owned();
                div().id(("file-tab", id)).group(group.clone()).role(Role::Tab).aria_selected(active).aria_label(tab.path.clone())
                    .h(px(28.)).pl(px(8.)).pr(px(2.)).flex().items_center().gap(px(6.)).flex_shrink_0().rounded(px(6.)).cursor_pointer()
                    .map(|el| if active { el.bg(theme::elevated()) } else { el.hover(|el| el.bg(theme::hover())) })
                    .tooltip(move |window, cx| gpui_kit::component::tooltip::Tooltip::new(tip.clone()).build(window, cx))
                    .on_click(cx.listener(move |this, _, window, cx| {
                        if let Some(ix) = this.files.tabs.iter().position(|t| t.id == id) { this.files.active = ix; this.focus_file(window, cx); }
                    }))
                    .child(crate::fileicons::tree_icon(&name, false, false))
                    .child(div().max_w(px(120.)).truncate().text_size(px(12.)).text_color(if active { theme::text() } else { theme::muted() }).child(name))
                    .when_some(mark, |el, failed| el.child(div().size(px(6.)).flex_shrink_0().rounded_full()
                        .bg(if failed { theme::danger() } else { theme::accent() })))
                    // Como no Zeron, o X aparece na aba ativa e na que está sob o ponteiro.
                    .child(div().opacity(if active { 1. } else { 0. }).group_hover(group, |s| s.opacity(1.))
                        .child(Button::new(("file-close", id)).ghost().xsmall().icon(IconName::Close).accessibility_label(tr("file_close"))
                            .tooltip(tr("file_close")).on_click(cx.listener(move |this, _, window, cx| this.close_file(id, window, cx)))))
            }));
        let expanded = self.files.expanded;
        let strip = div().h(px(40.)).flex_shrink_0().flex().items_center().gap_1().px_2()
            .child(tabs)
            .child(chrome::icon_button("file-add", IconName::Plus, tr("file_add"), cx)
                .on_click(cx.listener(|this, _, window, cx| this.file_add(window, cx))))
            .child(div().flex_1())
            .child(chrome::icon_button("file-expand", if expanded { IconName::Minimize } else { IconName::Maximize },
                    tr(if expanded { "file_restore" } else { "file_expand" }), cx).selected(expanded)
                .on_click(cx.listener(|this, _, _, cx| { this.files.expanded = !this.files.expanded; cx.notify(); })))
            .child(Button::new("file-back").ghost().small().label(tr("file_back"))
                .on_click(cx.listener(|this, _, window, cx| { this.files_escape(window, cx); })));
        let parts = trail(self.selected.as_ref().and_then(|s| s.cwd.as_deref()), &tab.path);
        let last = parts.len().saturating_sub(1);
        let full = tab.path.clone();
        let crumbs = div().id("file-trail").min_w_0().flex_1().flex().items_center().overflow_hidden()
            .tooltip(move |window, cx| gpui_kit::component::tooltip::Tooltip::new(full.clone()).build(window, cx))
            .children(parts.into_iter().enumerate().flat_map(|(ix, part)| [
                (ix > 0).then(|| div().mx(px(4.)).flex_shrink_0().text_size(px(11.)).text_color(theme::faint()).child("›").into_any_element()),
                Some(div().min_w_0().truncate().text_size(px(11.))
                    .text_color(if ix == last { theme::muted() } else { theme::faint() }).child(part).into_any_element()),
            ]).flatten());
        let doc = tab.content.as_ref().and_then(|result| result.as_ref().ok());
        let toolbar = div().h(px(34.)).flex_shrink_0().flex().items_center().gap_1().px_2().border_t_1().border_b_1().border_color(theme::border())
            .child(div().pl_1().flex_shrink_0().child(crate::fileicons::tree_icon(&name, false, false)))
            .child(crumbs)
            .when_some(doc, |el, doc| el
                .when(doc.saved.is_some(), |el| el.child(div().px_1().text_xs().text_color(theme::success()).child(tr("file_saved"))))
                .when(doc.editable() && doc.dirty(), |el| el
                    .child(Button::new("file-discard").ghost().xsmall().label(tr("file_discard")).disabled(doc.saving)
                        .on_click(cx.listener(|this, _, window, cx| this.discard_file(window, cx))))
                    .child(Button::new("file-save").primary().xsmall().label(tr(if doc.saving { "file_saving" } else { "file_save" }))
                        .tooltip(tr("file_save_shortcut")).disabled(doc.saving)
                        .on_click(cx.listener(|this, _, _, cx| this.save_file(cx)))))
                .when(doc.markdown.is_some(), |el| el.child(chrome::icon_button("file-preview",
                        if tab.preview { IconName::FileCode } else { IconName::Eye }, tr(if tab.preview { "file_source" } else { "file_preview" }), cx)
                    .selected(tab.preview).on_click(cx.listener(|this, _, _, cx| this.toggle_preview(cx))))))
            // Arquivo citado fora da raiz não está na árvore da sessão.
            .child(chrome::icon_button("file-reveal", IconName::FolderOpen, tr("file_reveal"), cx).disabled(tab.path.starts_with(['/', '~']))
                .on_click(cx.listener(|this, _, window, cx| this.file_reveal(window, cx))));
        let state = |text: String, color: Hsla| div().size_full().flex().items_center().justify_center().p_4().text_sm().text_color(color)
            .child(text).into_any_element();
        let content = match (&tab.picture, &tab.content) {
            (Some(Picture::Disk(path)), _) => div().size_full().p_4().flex().items_center().justify_center()
                .child(img(path.clone()).max_w_full().max_h_full().object_fit(ObjectFit::Contain)).into_any_element(),
            (Some(Picture::Ready(image)), _) => div().size_full().p_4().flex().items_center().justify_center()
                .child(img(image.clone()).max_w_full().max_h_full().object_fit(ObjectFit::Contain)).into_any_element(),
            (Some(Picture::Loading), _) | (None, None) => state(tr("file_loading"), theme::faint()),
            (Some(Picture::Failed(error)), _) | (None, Some(Err(error))) => state(error.clone(), theme::danger()),
            (None, Some(Ok(doc))) if tab.preview && doc.markdown.is_some() => {
                let (tx, connection, document) = (self.tx.clone(), self.connection, tab.path.clone());
                div().id("file-markdown").size_full().overflow_y_scroll().flex().justify_center().items_start().px_6().py_4()
                    .child(conversation_text(div().w_full().max_w(px(900.)), false).children(doc.markdown.as_ref().map(|view| chat_text(view, cx)
                        .on_link_click(move |url, event, window, cx| match link_target(&document, url) {
                            Some(path) => { let _ = tx.try_send(Envelope { connection, selection: None, payload: Payload::FileView(FileReply::Open(path)) }); }
                            None => open_web_link(url, event, window, cx),
                        }))))
                    .into_any_element()
            }
            (None, Some(Ok(doc))) => div().flex().flex_col().size_full().min_h_0()
                .when(doc.base.truncated, |el| el.child(div().px_4().py_2().text_xs().text_color(theme::warning()).child(tr("file_truncated"))))
                .when_some(doc.error.as_ref(), |el, error| el.child(div().id("file-save-error").role(Role::Alert)
                    .flex_shrink_0().px_4().py_2().text_sm().text_color(theme::danger()).child(error.clone())))
                .child(div().flex_1().min_h_0().overflow_hidden()
                    .child(Editor::new(&doc.editor).readonly(!doc.editable() || doc.saving).bordered(false).h_full().font_family(theme::MONO).text_sm()
                        .line_height(relative(1.7)).aria_label(tab.path.clone())))
                .into_any_element(),
        };
        Some(div().id("file-viewer").absolute().inset_0().occlude().flex().flex_col().min_h_0().bg(theme::surface())
            .border_1().border_color(theme::border()).rounded_lg().overflow_hidden()
            .key_context("FileViewer").track_focus(&self.files.focus)
            .on_action(cx.listener(|this, _: &CloseFile, window, cx| {
                if let Some(tab) = this.files.tabs.get(this.files.active) { this.close_file(tab.id, window, cx); }
            }))
            .on_action(cx.listener(|this, _: &NextFile, window, cx| this.step_file(true, window, cx)))
            .on_action(cx.listener(|this, _: &PreviousFile, window, cx| this.step_file(false, window, cx)))
            .on_action(cx.listener(|this, _: &SaveFile, _, cx| this.save_file(cx)))
            .child(strip)
            .child(toolbar)
            .child(div().flex_1().min_h_0().overflow_hidden().child(content)).into_any_element())
    }
}

/// Imagem decodificada aqui sai da memória de vídeo junto com a aba.
fn release(tab: FileTab, window: &mut Window, cx: &mut App) {
    if let Some(Picture::Ready(image)) = tab.picture { cx.drop_image(image, Some(window)); }
}

/// A trilha do Zeron: a pasta da sessão e as partes do caminho. Caminho absoluto (arquivo citado fora da raiz) já diz
/// de onde vem e não leva a pasta da sessão.
fn trail(root: Option<&str>, path: &str) -> Vec<String> {
    let mut parts = Vec::new();
    if !path.starts_with('/') && !path.starts_with('~') {
        parts.extend(root.and_then(|root| std::path::Path::new(root).file_name()).map(|name| name.to_string_lossy().into_owned()));
    }
    parts.extend(path.split('/').filter(|part| !part.is_empty() && *part != ".").map(str::to_owned));
    parts
}

/// Destino de um link da prévia de Markdown dentro da sessão: relativo à pasta do documento, sem sair da raiz. Web,
/// âncora e caminho absoluto ficam de fora.
fn link_target(document: &str, url: &str) -> Option<String> {
    if url.starts_with(['#', '/']) || url.contains([':', '\\']) { return None; }
    let target = url.split(['#', '?']).next().filter(|target| !target.is_empty())?;
    let mut decoded = Vec::new();
    let mut bytes = target.bytes();
    while let Some(byte) = bytes.next() {
        if byte != b'%' { decoded.push(byte); continue; }
        let hex = [bytes.next()?, bytes.next()?];
        decoded.push(u8::from_str_radix(std::str::from_utf8(&hex).ok()?, 16).ok()?);
    }
    let target = String::from_utf8(decoded).ok()?;
    let mut parts: Vec<&str> = document.split('/').collect();
    parts.pop();
    for part in target.split('/') {
        match part {
            "" | "." => {}
            // O primeiro pedaço vazio é a raiz de um caminho absoluto: dali não se sobe.
            ".." => { if parts.last().is_none_or(|last| last.is_empty()) { return None; } parts.pop(); }
            part => parts.push(part),
        }
    }
    Some(parts.join("/"))
}

fn is_image(path: &str) -> bool {
    let extension = std::path::Path::new(path).extension().and_then(|s| s.to_str()).unwrap_or("").to_ascii_lowercase();
    matches!(extension.as_str(), "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp")
}

#[cfg(test)]
mod tests {
    #[test]
    fn file_language_maps_compiled_grammars_and_plain_text() {
        for (path, expected) in [
            ("main.rs", "rust"), ("app.ts", "typescript"), ("view.tsx", "tsx"),
            ("app.js", "javascript"), ("script.py", "python"), ("data.json", "json"),
            ("config.toml", "toml"), ("config.yml", "yaml"), ("README.md", "markdown"),
            ("run.sh", "bash"), ("app.css", "css"), ("index.html", "html"),
            ("App.svelte", "svelte"), ("query.sql", "sql"), ("main.c", "c"),
            ("header.h", "c"), ("main.cc", "cpp"), ("main.cpp", "cpp"),
            ("header.hpp", "cpp"), ("Main.java", "java"), ("Program.cs", "csharp"),
            ("Main.kt", "kotlin"), ("Main.kts", "text"), ("main.go", "go"),
            ("main.rb", "ruby"), ("main.lua", "lua"), ("Main.swift", "swift"),
            ("index.php", "php"), ("README.markdown", "markdown"),
            ("run.zsh", "bash"), ("App.vue", "html"),
            ("sample.unknown", "text"), ("config.jsonc", "text"),
            ("notes.mdx", "text"), ("theme.scss", "text"),
            ("types.pyi", "text"), ("main.pas", "text"), ("main.dart", "text"),
        ] {
            assert_eq!(super::file_language(path), expected, "{path}");
        }
    }

    #[test]
    fn trail_starts_at_the_session_folder_unless_the_path_is_absolute() {
        assert_eq!(super::trail(Some("/home/j/hangar"), "docs/a.md"), ["hangar", "docs", "a.md"]);
        assert_eq!(super::trail(Some("/home/j/hangar/"), "./mobile/app.json"), ["hangar", "mobile", "app.json"]);
        assert_eq!(super::trail(Some("/home/j/hangar"), "/etc/hosts"), ["etc", "hosts"]);
        assert_eq!(super::trail(None, "a.md"), ["a.md"]);
    }

    #[test]
    fn markdown_links_resolve_inside_the_session_only() {
        let target = |url| super::link_target("docs/guide/intro.md", url);
        assert_eq!(target("setup.md").as_deref(), Some("docs/guide/setup.md"));
        assert_eq!(target("../../README.md#topo").as_deref(), Some("README.md"));
        assert_eq!(target("./img/a%20b.png").as_deref(), Some("docs/guide/img/a b.png"));
        assert_eq!(target("../../../etc/passwd"), None);
        for outside in ["https://x.dev/a.md", "#topo", "/etc/hosts", "mailto:a@b.c", "a%2"] { assert_eq!(target(outside), None, "{outside}"); }
        assert_eq!(super::link_target("/tmp/notes/a.md", "../b.md").as_deref(), Some("/tmp/b.md"));
        assert_eq!(super::link_target("/a.md", "../b.md"), None);
    }

    #[test]
    fn editing_requires_a_complete_read_and_digest() {
        let mut content: super::Content = serde_json::from_value(serde_json::json!({
            "path": "empty.txt", "text": "", "truncated": false, "digest": "read-digest"
        })).unwrap();
        assert!(content.editable());
        content.truncated = true;
        assert!(!content.editable());
        content.truncated = false;
        content.digest = None;
        assert!(!content.editable());
        content.digest = Some(String::new());
        assert!(!content.editable());
    }
}
