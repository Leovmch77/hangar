//! "Buscar conversas" (Ctrl+K): paleta no meio da janela, na superfície de vidro dos popovers, com o que o web mostra no
//! modo só-busca do `SessionSwitcherSheet.svelte` — busca de conteúdo em todas as conversas (vivas e arquivadas, `/api/search`),
//! trecho com a mensagem em volta (`/api/search/context`) e o "Perguntar" (`/api/ask-history`) — mais as sessões vivas
//! pelo nome, como a paleta do Zeron. Enter abre a sessão viva; a arquivada é retomada numa sessão nova
//! (`/api/archive/…/resume`), porque o nativo não tem a vista de arquivo do web.
use super::*;
use super::device::Remote;
use super::costs::web_with;
use serde::Deserialize;

/// Espera entre a última tecla e a busca, como o web.
const DEBOUNCE: Duration = Duration::from_millis(250);
const SESSIONS_MAX: usize = 8;

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default)]
struct Hit {
    project: String,
    session_id: String,
    session_name: Option<String>,
    cwd: Option<String>,
    line: String,
    mtime: f64,
    live: bool,
    role: Option<String>,
    event_id: Option<String>,
    ts: Option<f64>,
}

impl Hit {
    fn key(&self) -> String { format!("{}/{}/{}", self.project, self.session_id, self.event_id.as_deref().unwrap_or(&self.line)) }
    fn conversation(&self) -> String { format!("{}/{}", self.project, self.session_id) }
    fn folder(&self) -> String {
        self.cwd.as_deref().map(super::costs::project_label).unwrap_or_else(|| self.project.clone())
    }
    /// A sessão viva abre; a morta não tem nome de sessão.
    fn live_name(&self) -> Option<&str> { self.session_name.as_deref().filter(|_| self.live) }
}

/// O que as setas percorrem: sessões vivas pelo nome e trechos da busca, na ordem da tela.
#[derive(Clone, Debug, PartialEq)]
enum Entry { Session(String), Hit(usize), Answer(usize) }

#[derive(Default)]
pub(super) struct Search {
    pub(super) open: bool,
    input: Option<Entity<InputState>>,
    /// A busca que está na tela (ou em voo).
    query: String,
    hits: Remote<Vec<Hit>>,
    debounce: u64,
    active: usize,
    preview: Option<(String, Remote<Vec<ChatEvent>>)>,
    ask: Remote<(String, Vec<Hit>)>,
    /// Retomada em curso (a conversa) e o erro da última.
    resuming: Option<String>,
    resume_error: Option<String>,
    previous_focus: Option<FocusHandle>,
    scroll: ScrollHandle,
    _events: Option<Subscription>,
}

/// Palavras da busca, minúsculas e sem repetição (`termos` do backend).
fn terms(query: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for word in query.to_lowercase().split_whitespace() { if !out.iter().any(|w| w == word) { out.push(word.to_owned()); } }
    out
}

/// Faixas de `text` com qualquer um dos termos, sem diferenciar maiúsculas (o `<mark>` do web).
fn marks(text: &str, terms: &[String]) -> Vec<std::ops::Range<usize>> {
    let lower = text.to_lowercase();
    // Minúscula que muda o tamanho do texto desalinharia as faixas: aí não destaca nada.
    if lower.len() != text.len() { return Vec::new(); }
    let mut ranges: Vec<std::ops::Range<usize>> = terms.iter().filter(|t| !t.is_empty())
        .flat_map(|t| lower.match_indices(t.as_str()).map(|(at, m)| at..at + m.len()).collect::<Vec<_>>()).collect();
    ranges.sort_by_key(|r| r.start);
    let mut merged: Vec<std::ops::Range<usize>> = Vec::new();
    for r in ranges {
        match merged.last_mut() { Some(last) if r.start <= last.end => last.end = last.end.max(r.end), _ => merged.push(r) }
    }
    merged
}

fn highlighted(text: String, terms: &[String]) -> StyledText {
    let style = HighlightStyle { color: Some(theme::text()), background_color: Some(theme::accent().alpha(0.28)), ..Default::default() };
    let ranges = marks(&text, terms);
    StyledText::new(text).with_highlights(ranges.into_iter().map(|r| (r, style)))
}

fn ago(ts: f64) -> String { side::ago(chrono::Local::now().timestamp() as f64 - ts) }

impl Hangar {
    /// Abre a busca de conversas (Ctrl+K e, depois, o botão da barra do topo); aberta, fecha.
    pub(super) fn toggle_search(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.search.open { self.close_search(window, cx) } else { self.open_search(window, cx) }
    }

    pub(super) fn open_search(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.connection_dialog || self.api.is_none() { return; }
        self.close_popups();
        let input = self.search.input.get_or_insert_with(|| cx.new(|cx| InputState::new(window, cx).placeholder(web_with("switcher_buscar_conversas", &[])))).clone();
        if self.search._events.is_none() {
            self.search._events = Some(cx.subscribe_in(&input, window, |this, _, event, window, cx| match event {
                InputEvent::Change => this.search_changed(cx),
                InputEvent::PressEnter { .. } => this.search_activate(None, window, cx),
                _ => {}
            }));
        }
        // Cada abertura começa vazia, como o web.
        input.update(cx, |input, cx| input.set_value("", window, cx));
        let previous = window.focused(cx);
        self.search = Search { open: true, input: Some(input.clone()), previous_focus: previous, _events: self.search._events.take(), ..Default::default() };
        input.update(cx, |input, cx| input.focus(window, cx));
        cx.notify();
    }

    pub(super) fn close_search(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if !self.search.open { return; }
        self.search.open = false;
        self.search.debounce += 1;
        match self.search.previous_focus.take() { Some(focus) => focus.focus(window, cx), None => self.root_focus.focus(window, cx) }
        cx.notify();
    }

    /// Outra conexão: o que a busca mostrava era do servidor anterior.
    pub(super) fn search_reconnected(&mut self, cx: &mut Context<Self>) {
        if self.search.open { self.search_changed(cx); }
    }

    fn search_text(&self, cx: &App) -> String { self.search.input.as_ref().map(|i| i.read(cx).value().to_string()).unwrap_or_default() }

    fn search_changed(&mut self, cx: &mut Context<Self>) {
        let query = self.search_text(cx).trim().to_owned();
        (self.search.active, self.search.preview, self.search.ask, self.search.resume_error) = (0, None, Remote::default(), None);
        self.search.scroll.set_offset(point(px(0.), px(0.)));
        self.search.debounce += 1;
        let seq = self.search.debounce;
        if query.is_empty() {
            (self.search.query, self.search.hits) = (String::new(), Remote::default());
            cx.notify();
            return;
        }
        self.search.hits.loading = true;
        cx.spawn(async move |this, cx| {
            cx.background_executor().timer(DEBOUNCE).await;
            let _ = this.update(cx, |this, cx| if this.search.debounce == seq { this.run_search(query, cx) });
        }).detach();
        cx.notify();
    }

    fn run_search(&mut self, query: String, cx: &mut Context<Self>) {
        self.search.query = query.clone();
        let seq = self.search.hits.start();
        // 30 s: a busca varre as conversas de todas as contas; termo raro percorre tudo antes de parar.
        self.server_get(vec!["search".into()], vec![("q".into(), query)], 30, cx, move |this, result, cx| {
            let parsed = result.map_err(|e| Self::failure(&e)).and_then(|v| serde_json::from_value::<Vec<Hit>>(v).map_err(|_| tr("invalid_response")))
                .map(|mut hits| { hits.sort_by(|a, b| b.mtime.total_cmp(&a.mtime)); hits });
            this.search.hits.finish(seq, parsed);
            cx.notify();
        });
    }

    /// Sessões vivas cujo nome ou pasta tem a busca, as mais recentes primeiro.
    fn search_sessions(&self, query: &str) -> Vec<SessionInfo> {
        let q = query.to_lowercase();
        let mut list: Vec<SessionInfo> = self.sessions.iter()
            .filter(|s| q.is_empty() || s.name.to_lowercase().contains(&q) || s.cwd.as_deref().is_some_and(|c| c.to_lowercase().contains(&q)))
            .cloned().collect();
        list.sort_by(|a, b| b.last_activity.unwrap_or(0.).total_cmp(&a.last_activity.unwrap_or(0.)));
        list.truncate(SESSIONS_MAX);
        list
    }

    /// Os trechos na ordem da tela: por conversa, a mais recente primeiro.
    fn search_groups(&self) -> Vec<(String, Vec<usize>)> {
        let mut groups: Vec<(String, Vec<usize>)> = Vec::new();
        for (i, hit) in self.search.hits.ok().map(Vec::as_slice).unwrap_or(&[]).iter().enumerate() {
            let key = hit.conversation();
            match groups.iter_mut().find(|g| g.0 == key) { Some(g) => g.1.push(i), None => groups.push((key, vec![i])) }
        }
        groups
    }

    fn search_entries(&self, cx: &App) -> Vec<Entry> {
        let query = self.search_text(cx).trim().to_owned();
        let mut out: Vec<Entry> = self.search_sessions(&query).into_iter().map(|s| Entry::Session(s.name)).collect();
        if let Some((_, hits)) = self.search.ask.ok() { out.extend((0..hits.len()).map(Entry::Answer)); }
        out.extend(self.search_groups().into_iter().flat_map(|(_, hits)| hits.into_iter().map(Entry::Hit)));
        out
    }

    fn search_move(&mut self, delta: isize, cx: &mut Context<Self>) {
        let count = self.search_entries(cx).len();
        if count == 0 { return; }
        self.search.active = (self.search.active as isize + delta).rem_euclid(count as isize) as usize;
        self.search.scroll.scroll_to_item(self.search.active);
        cx.notify();
    }

    fn hit_of(&self, entry: &Entry) -> Option<Hit> {
        match entry {
            Entry::Hit(i) => self.search.hits.ok()?.get(*i).cloned(),
            Entry::Answer(i) => self.search.ask.ok()?.1.get(*i).cloned(),
            Entry::Session(_) => None,
        }
    }

    /// Enter (ou o botão): abre a sessão viva, retoma a arquivada.
    fn search_activate(&mut self, entry: Option<Entry>, window: &mut Window, cx: &mut Context<Self>) {
        let Some(entry) = entry.or_else(|| self.search_entries(cx).get(self.search.active).cloned()) else { return };
        match entry {
            Entry::Session(name) => self.search_open_session(&name, window, cx),
            other => {
                let Some(hit) = self.hit_of(&other) else { return };
                match hit.live_name() {
                    Some(name) => { let name = name.to_owned(); self.search_open_session(&name, window, cx) }
                    None => self.search_resume(hit, window, cx),
                }
            }
        }
    }

    fn search_open_session(&mut self, name: &str, window: &mut Window, cx: &mut Context<Self>) {
        let Some(session) = self.sessions.iter().find(|s| s.name == name).cloned() else {
            self.search.resume_error = Some(tr("search_session_gone").replace("{name}", name));
            cx.notify();
            return;
        };
        self.search.previous_focus = None;
        self.close_search(window, cx);
        self.close_costs(window, cx);
        self.close_settings(window, cx);
        let readable = session.readable();
        self.select(session, window, cx);
        if readable { self.composer.update(cx, |input, cx| input.focus(window, cx)); }
    }

    /// Conversa arquivada: sobe uma sessão nova com `--resume` na conta dona dela, pela rota do Arquivo do web.
    fn search_resume(&mut self, hit: Hit, window: &mut Window, cx: &mut Context<Self>) {
        let Some(api) = self.api.clone() else { return };
        if self.search.resuming.is_some() { return; }
        self.search.resuming = Some(hit.conversation());
        self.search.resume_error = None;
        let connection = self.connection;
        let task = self.runtime.spawn(async move {
            api.server_send(reqwest::Method::POST, &["archive", &hit.project, &hit.session_id, "resume"], Some(json!({})), 120).await
        });
        cx.spawn_in(window, async move |this, cx| {
            let Ok(result) = task.await else { return };
            let _ = this.update_in(cx, |this, window, cx| {
                if this.connection != connection { return; }
                this.search.resuming = None;
                match result.map_err(|e| Self::fetch_failure(&e)).and_then(|v| serde_json::from_value::<SessionInfo>(v).map_err(|_| tr("invalid_response"))) {
                    Ok(session) => {
                        this.search.previous_focus = None;
                        this.close_search(window, cx);
                        this.close_costs(window, cx);
                        this.close_settings(window, cx);
                        let readable = session.readable();
                        this.select(session, window, cx);
                        if readable { this.composer.update(cx, |input, cx| input.focus(window, cx)); }
                    }
                    Err(error) => this.search.resume_error = Some(error),
                }
                cx.notify();
            });
        }).detach();
        cx.notify();
    }

    /// Clique no trecho: abre ou fecha a mensagem inteira com as vizinhas, sem sair da busca.
    fn search_toggle_preview(&mut self, hit: Hit, cx: &mut Context<Self>) {
        let key = hit.key();
        if self.search.preview.as_ref().is_some_and(|(k, _)| *k == key) { self.search.preview = None; cx.notify(); return; }
        let mut remote = Remote::default();
        let Some(event) = hit.event_id.clone() else {
            remote.value = Some(Err(web_with("busca_contexto_indisponivel", &[])));
            self.search.preview = Some((key, remote));
            cx.notify();
            return;
        };
        let seq = remote.start();
        self.search.preview = Some((key.clone(), remote));
        let query = vec![("project".into(), hit.project.clone()), ("session_id".into(), hit.session_id.clone()), ("event_id".into(), event)];
        self.server_get(vec!["search".into(), "context".into()], query, 15, cx, move |this, result, cx| {
            let Some((k, remote)) = this.search.preview.as_mut().filter(|(k, _)| *k == key) else { return };
            let _ = k;
            remote.finish(seq, result.map_err(|e| Self::fetch_failure(&e))
                .and_then(|v| serde_json::from_value::<Vec<ChatEvent>>(v).map_err(|_| tr("invalid_response"))));
            cx.notify();
        });
        cx.notify();
    }

    /// "Perguntar": o backend acha os trechos e um modelo responde onde o assunto apareceu (só neste servidor, como o web).
    fn search_ask(&mut self, cx: &mut Context<Self>) {
        let question = self.search_text(cx).trim().to_owned();
        if question.is_empty() || self.search.ask.loading { return; }
        let Some(api) = self.api.clone() else { return };
        let seq = self.search.ask.start();
        let connection = self.connection;
        let task = self.runtime.spawn(async move {
            api.server_send(reqwest::Method::POST, &["ask-history"], Some(json!({ "question": question })), 90).await
        });
        cx.spawn(async move |this, cx| {
            let Ok(result) = task.await else { return };
            let _ = this.update(cx, |this, cx| {
                if this.connection != connection { return; }
                let parsed = result.map_err(|e| Self::failure(&e)).and_then(|v| {
                    let answer = v.get("answer").and_then(Value::as_str).unwrap_or_default().to_owned();
                    let hits = serde_json::from_value::<Vec<Hit>>(v.get("hits").cloned().unwrap_or(json!([]))).map_err(|_| tr("invalid_response"))?;
                    Ok((answer, hits))
                });
                this.search.ask.finish(seq, parsed);
                cx.notify();
            });
        }).detach();
        cx.notify();
    }

    // ── Desenho ─────────────────────────────────────────────────────────────

    pub(super) fn render_search(&mut self, window: &mut Window, cx: &mut Context<Self>) -> Option<AnyElement> {
        if !self.search.open { return None; }
        let input = self.search.input.clone()?;
        let query = self.search_text(cx).trim().to_owned();
        let words = terms(&query);
        let entries = self.search_entries(cx);
        self.search.active = self.search.active.min(entries.len().saturating_sub(1));
        let active = entries.get(self.search.active).cloned();
        let viewport = window.viewport_size();
        let width = (viewport.width - px(32.)).min(px(760.));
        let list_h = (viewport.height * 0.72 - px(150.)).max(px(160.));

        let mut rows: Vec<AnyElement> = Vec::new();
        let section = |title: String| div().px(px(10.)).pt(px(10.)).pb(px(4.)).text_size(px(11.5)).font_weight(FontWeight::MEDIUM)
            .text_color(theme::faint()).child(title).into_any_element();

        let sessions = self.search_sessions(&query);
        if !sessions.is_empty() {
            rows.push(section(tr("search_sessions")));
            for s in sessions {
                let on = active.as_ref() == Some(&Entry::Session(s.name.clone()));
                let name = s.name.clone();
                let entry = Entry::Session(name.clone());
                rows.push(self.search_row(format!("search-session-{name}"), on, entry, cx)
                    .child(div().size(px(8.)).flex_shrink_0().rounded_full().bg(theme::status(&s.state)))
                    .child(div().flex_1().min_w_0().flex().flex_col().gap(px(1.))
                        .child(div().truncate().text_size(px(13.5)).font_weight(FontWeight::MEDIUM).child(highlighted(s.name.clone(), &words)))
                        .children(s.cwd.clone().map(|c| div().truncate().font_family(theme::MONO).text_size(px(11.5)).text_color(theme::faint()).child(c))))
                    .children(s.last_activity.map(|t| div().flex_shrink_0().text_size(px(12.)).text_color(theme::faint()).child(ago(t))))
                    .into_any_element());
            }
        }

        if !query.is_empty() {
            rows.push(div().px(px(6.)).pt(px(8.)).child(Button::new("search-ask").ghost().small().w_full().loading(self.search.ask.loading)
                .disabled(self.search.ask.loading)
                .label(web_with(if self.search.ask.loading { "switcher_perguntando" } else { "switcher_perguntar" }, &[]))
                .on_click(cx.listener(|this, _, _, cx| this.search_ask(cx)))).into_any_element());
            match &self.search.ask.value {
                Some(Err(error)) => rows.push(div().px(px(10.)).py(px(4.)).text_size(px(13.)).text_color(theme::danger()).child(error.clone()).into_any_element()),
                Some(Ok((answer, hits))) => {
                    let mut card = div().mx(px(6.)).mt(px(6.)).p(px(12.)).rounded(px(10.)).border_1().border_color(theme::border()).bg(theme::inset())
                        .flex().flex_col().gap(px(6.)).child(div().text_size(px(13.)).whitespace_normal().child(answer.clone()));
                    for (i, hit) in hits.iter().enumerate() {
                        card = card.child(self.render_hit(Entry::Answer(i), hit, true, active.as_ref(), &words, cx));
                    }
                    rows.push(card.into_any_element());
                }
                None => {}
            }
        }

        rows.push(section(tr("search_conversations")));
        let state_line = |text: String, color: Hsla| div().px(px(10.)).py(px(14.)).flex().justify_center().text_size(px(13.)).text_color(color)
            .whitespace_normal().child(text).into_any_element();
        if query.is_empty() {
            rows.push(state_line(web_with("busca_digite_todas", &[]), theme::muted()));
        } else if self.search.hits.loading || self.search.query != query {
            rows.push(state_line(web_with("switcher_buscando", &[]), theme::muted()));
        } else {
            match &self.search.hits.value {
                Some(Err(error)) => rows.push(state_line(web_with("busca_servidor_falhou", &[("servidor", format!("{} ({error})", self.server_label(cx)))]), theme::danger())),
                Some(Ok(hits)) if hits.is_empty() => rows.push(state_line(web_with("busca_nenhum_todas", &[("termos", words.join(", "))]), theme::muted())),
                Some(Ok(hits)) => {
                    let hits = hits.clone();
                    let groups = self.search_groups();
                    let summary = format!("{} · {}",
                        if hits.len() == 1 { web_with("busca_um_trecho", &[]) } else { web_with("busca_n_trechos", &[("n", hits.len().to_string())]) },
                        if groups.len() == 1 { web_with("busca_uma_conversa", &[]) } else { web_with("busca_n_conversas", &[("n", groups.len().to_string())]) });
                    rows.push(div().px(px(10.)).pb(px(4.)).text_size(px(12.)).text_color(theme::faint()).child(summary).into_any_element());
                    for (n, (_, indexes)) in groups.iter().enumerate() {
                        let first = &hits[indexes[0]];
                        let title = first.live_name().map(str::to_owned).unwrap_or_else(|| first.folder());
                        let mut meta = Vec::new();
                        if first.live_name().is_some_and(|name| name != first.folder()) { meta.push(div().font_family(theme::MONO).child(first.folder())); }
                        meta.push(div().when(first.live, |el| el.text_color(theme::success()).font_weight(FontWeight::SEMIBOLD))
                            .child(web_with(if first.live { "switcher_ativa" } else { "switcher_arquivo" }, &[])));
                        if first.mtime > 0. { meta.push(div().child(ago(first.mtime))); }
                        let mut group = div().flex().flex_col().gap(px(2.)).pt(px(6.)).when(n > 0, |el| el.mt(px(4.)).border_t_1().border_color(theme::border()))
                            .child(div().px(px(10.)).pb(px(2.)).flex().items_center().gap(px(8.)).min_w_0()
                                .child(div().flex_shrink(1.).min_w_0().truncate().text_size(px(13.5)).font_weight(FontWeight::SEMIBOLD).child(title))
                                .child(div().flex().items_center().gap(px(6.)).text_size(px(12.)).text_color(theme::faint())
                                    .children(meta.into_iter().enumerate().flat_map(|(i, el)| [(i > 0).then(|| div().child("·")), Some(el)].into_iter().flatten()))));
                        for i in indexes {
                            group = group.child(self.render_hit(Entry::Hit(*i), &hits[*i], false, active.as_ref(), &words, cx));
                        }
                        rows.push(group.into_any_element());
                    }
                }
                None => rows.push(state_line(web_with("switcher_buscando", &[]), theme::muted())),
            }
        }
        if let Some(error) = self.search.resume_error.clone() {
            rows.insert(0, div().mx(px(6.)).mt(px(6.)).px(px(10.)).py(px(8.)).rounded(px(8.)).bg(theme::danger().alpha(0.12))
                .text_size(px(13.)).text_color(theme::danger()).whitespace_normal().child(error).into_any_element());
        }

        let header = div().h(px(52.)).flex_shrink_0().px(px(14.)).flex().items_center().gap(px(10.)).border_b_1().border_color(theme::border())
            .child(chrome::small_icon(IconName::Search, 17., theme::muted()))
            .child(div().flex_1().min_w_0()
                .capture_action(cx.listener(|this, _: &MoveUp, _, cx| { this.search_move(-1, cx); cx.stop_propagation(); }))
                .capture_action(cx.listener(|this, _: &MoveDown, _, cx| { this.search_move(1, cx); cx.stop_propagation(); }))
                .capture_action(cx.listener(|this, _: &Escape, window, cx| { this.close_search(window, cx); cx.stop_propagation(); }))
                .child(Input::new(&input).appearance(false).aria_label(web_with("lista_buscar", &[]))))
            .child(chrome::kbd("Ctrl K"));
        let footer = div().h(px(34.)).flex_shrink_0().px(px(14.)).flex().items_center().border_t_1().border_color(theme::border())
            .text_size(px(11.5)).text_color(theme::faint()).child(web_with("busca_atalhos", &[]));
        let card = div().id("search-palette").w(width).max_h(viewport.height * 0.8).flex().flex_col().rounded(px(16.)).border_1()
            .border_color(theme::glass_border()).bg(theme::popup_fill(theme::raised())).shadow(theme::popover_shadow()).overflow_hidden().occlude()
            .on_any_mouse_down(|_, _, cx| cx.stop_propagation())
            .child(header)
            .child(div().id("search-results").max_h(list_h).overflow_y_scroll().track_scroll(&self.search.scroll).px(px(6.)).pb(px(8.))
                .flex().flex_col().children(rows))
            .child(footer);
        let card = if appearance::get().surface_material == appearance::SurfaceMaterial::Glass { chrome::Glass::new(card, px(16.)).into_any_element() }
            else { card.into_any_element() };
        Some(deferred(div().absolute().inset_0().bg(cx.theme().overlay).occlude()
            .on_any_mouse_down(cx.listener(|this, _, window, cx| { this.close_search(window, cx); cx.stop_propagation(); }))
            .flex().items_start().justify_center().pt(viewport.height / 10.).child(card))
            .with_priority(gpui_kit::base::POPUP_PRIORITY + 1).into_any_element())
    }

    /// Linha escolhível da paleta: o ponteiro que se move sobre ela leva o destaque (teclado e mouse nunca acendem duas).
    fn search_row(&self, id: String, on: bool, entry: Entry, cx: &mut Context<Self>) -> Stateful<Div> {
        let hover_entry = entry.clone();
        div().id(SharedString::from(id)).w_full().min_h(px(40.)).px(px(10.)).py(px(6.)).rounded(px(8.)).flex().items_center().gap(px(10.))
            .cursor_pointer().when(on, |el| el.bg(theme::accent_dim()))
            .on_mouse_move(cx.listener(move |this, _: &MouseMoveEvent, _, cx| {
                if let Some(ix) = this.search_entries(cx).iter().position(|e| *e == hover_entry).filter(|ix| *ix != this.search.active) {
                    this.search.active = ix;
                    cx.notify();
                }
            }))
            .on_click(cx.listener(move |this, _, window, cx| this.search_click(entry.clone(), window, cx)))
    }

    /// Clique: a sessão viva abre na hora; a conversa arquivada abre a prévia, e retomar (que cria uma sessão) fica no botão
    /// dela ou no Enter.
    fn search_click(&mut self, entry: Entry, window: &mut Window, cx: &mut Context<Self>) {
        match self.hit_of(&entry).filter(|hit| hit.live_name().is_none()) {
            Some(hit) => self.search_toggle_preview(hit, cx),
            None => self.search_activate(Some(entry), window, cx),
        }
    }

    fn render_hit(&self, entry: Entry, hit: &Hit, with_folder: bool, active: Option<&Entry>, words: &[String], cx: &mut Context<Self>) -> AnyElement {
        let on = active == Some(&entry);
        let key = hit.key();
        let open = self.search.preview.as_ref().filter(|(k, _)| *k == key);
        let mine = hit.role.as_deref() == Some("user");
        let resuming = self.search.resuming.as_deref() == Some(hit.conversation().as_str());
        let who = div().text_size(px(12.)).font_weight(FontWeight::SEMIBOLD).text_color(if mine { theme::accent() } else { theme::muted() })
            .child(web_with(if mine { "busca_voce" } else { "busca_assistente" }, &[]));
        let preview_hit = hit.clone();
        let head = div().w_full().flex().items_center().gap(px(8.)).child(who)
            .when(with_folder, |el| el.child(div().truncate().font_family(theme::MONO).text_size(px(11.5)).text_color(theme::faint())
                .child(hit.live_name().map(str::to_owned).unwrap_or_else(|| hit.folder()))))
            .child(div().flex_1())
            .children(hit.ts.or(Some(hit.mtime)).filter(|t| *t > 0.).map(|t| div().text_size(px(12.)).text_color(theme::faint()).child(ago(t))))
            .child(Button::new(SharedString::from(format!("search-preview-{key}"))).ghost().xsmall()
                .icon(if open.is_some() { IconName::ChevronDown } else { IconName::ChevronRight })
                .tooltip(web_with("busca_carregando_contexto", &[]).trim_end_matches('…').to_owned())
                .on_click(cx.listener(move |this, _, _, cx| { cx.stop_propagation(); this.search_toggle_preview(preview_hit.clone(), cx); })));
        let line: String = hit.line.chars().take(400).collect();
        let row = self.search_row(format!("search-hit-{}-{key}", matches!(entry, Entry::Answer(_))), on, entry.clone(), cx)
            .flex_col().items_start().gap(px(3.))
            .child(head)
            .child(div().w_full().text_size(px(13.)).line_height(relative(1.45)).text_color(theme::text()).whitespace_normal()
                .child(highlighted(line, words)))
            .when(resuming, |el| el.child(div().text_size(px(12.)).text_color(theme::muted()).child(tr("search_resuming"))));
        let Some((_, preview)) = open else { return row.into_any_element() };
        let body = match &preview.value {
            None => div().text_size(px(12.5)).text_color(theme::muted()).child(web_with("busca_carregando_contexto", &[])),
            Some(Err(error)) => div().text_size(px(12.5)).text_color(theme::danger()).child(error.clone()),
            Some(Ok(events)) => div().flex().flex_col().gap(px(10.)).children(events.iter().map(|ev| {
                let target = hit.event_id.as_deref() == Some(ev.id.as_str());
                let mine = ev.kind == "user_msg";
                let text: String = ev.text.clone().unwrap_or_default().chars().take(1200).collect();
                div().pl(px(10.)).border_l_2().border_color(if target { theme::accent() } else { theme::border() }).flex().flex_col().gap(px(3.))
                    .child(div().text_size(px(11.5)).font_weight(FontWeight::SEMIBOLD).text_color(if mine { theme::accent() } else { theme::muted() })
                        .child(web_with(if mine { "busca_voce" } else { "busca_assistente" }, &[])))
                    .child(div().text_size(px(12.5)).text_color(if target { theme::text() } else { theme::muted() }).whitespace_normal().child(text))
            })),
        };
        let action_hit = hit.clone();
        let label = if hit.live_name().is_some() { web_with("busca_abrir_sessao", &[]) } else { tr("search_resume") };
        div().flex().flex_col().rounded(px(8.)).bg(theme::inset()).border_1().border_color(theme::border())
            .child(row)
            .child(div().px(px(12.)).pb(px(12.)).flex().flex_col().gap(px(10.)).child(body)
                .child(div().flex().child(Button::new(SharedString::from(format!("search-open-{key}"))).primary().small().label(label)
                    .loading(resuming).disabled(self.search.resuming.is_some())
                    .on_click(cx.listener(move |this, _, window, cx| {
                        match action_hit.live_name() {
                            Some(name) => { let name = name.to_owned(); this.search_open_session(&name, window, cx) }
                            None => this.search_resume(action_hit.clone(), window, cx),
                        }
                    })))))
            .into_any_element()
    }
}

#[cfg(test)]
mod tests {
    use super::{marks, terms};

    #[test]
    fn highlights_every_term_without_overlaps() {
        let words = terms("Hangar  hangar busca");
        assert_eq!(words, ["hangar", "busca"]);
        assert_eq!(marks("O Hangar busca no hangar", &words), vec![2..8, 9..14, 18..24]);
        assert!(marks("ÁRVORE", &terms("árvore")).is_empty() || marks("ÁRVORE", &terms("árvore")) == vec![0..7]);
    }
}
