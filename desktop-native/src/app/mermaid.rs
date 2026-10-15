//! Diagramas Mermaid das respostas: o servidor da sessão desenha (`POST /api/mermaid`, com o Chromium dele) e a conversa
//! mostra a imagem no lugar do bloco. Um pedido por vez, porque o Chromium do servidor atende dois e é dividido com as
//! páginas; o resultado fica em memória pela chave (servidor, tema, largura, fonte). Enquanto não há imagem, e na falha,
//! o bloco continua sendo o código.
use std::{collections::VecDeque, sync::Mutex};

use gpui_kit::base::text::{markdown_ast, MarkdownNode, MarkdownParseContext, MarkdownPlugin};

use super::*;
use crate::api::{MermaidRefusal, MermaidReply, MermaidRetry};

/// Diagramas guardados; o T3 guarda 64 pelo mesmo motivo (uma conversa longa não cresce sem fim).
const CACHE_MAX: usize = 64;
/// Fonte acima disso a rota recusa; nem vai.
const SOURCE_MAX: usize = 50_000;
/// O servidor desenha no tamanho natural do diagrama, qualquer que seja a largura pedida: ela vai fixa, e mudar a
/// largura da janela não pede outro desenho. A tela encolhe a imagem até a coluna.
const REQUEST_WIDTH: u32 = 1600;

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(super) struct Job { server: String, dark: bool, width: u32, source: Arc<str> }

#[derive(Clone)]
enum Drawn {
    Waiting,
    Image { image: Arc<Image>, width: f32, height: f32 },
    Invalid(String),
    Unavailable(MermaidRetry),
    Refused(MermaidRefusal),
}

/// A linha acima do código quando não há imagem.
#[derive(Debug, PartialEq, Eq)]
enum Note {
    Drawing,
    /// `retry`: só a falha que pode passar numa nova tentativa (503, rede, prazo) oferece "Tentar de novo".
    Problem { line: String, retry: bool },
    /// A rota não é para este acesso (convidado, servidor sem a rota): só o código, sem linha de erro.
    Hidden,
}

impl From<MermaidReply> for Drawn {
    fn from(reply: MermaidReply) -> Self {
        match reply {
            MermaidReply::Image { png, width, height } => Drawn::Image { image: Arc::new(Image::from_bytes(ImageFormat::Png, png)), width, height },
            MermaidReply::Invalid(message) => Drawn::Invalid(message),
            MermaidReply::Unavailable(retry) => Drawn::Unavailable(retry),
            MermaidReply::Refused(refusal) => Drawn::Refused(refusal),
        }
    }
}

fn failed(message: &str) -> String {
    if message.trim().is_empty() { tr("mermaid_failed_plain") } else { tr("mermaid_failed").replace("{message}", message.trim()) }
}

fn note(drawn: &Drawn) -> Note {
    let problem = |line: String, retry: bool| Note::Problem { line, retry };
    match drawn {
        Drawn::Waiting | Drawn::Image { .. } => Note::Drawing,
        Drawn::Invalid(message) => problem(failed(message), false),
        Drawn::Unavailable(MermaidRetry::Busy(message)) if message.trim().is_empty() => problem(tr_shared("mermaid_unavailable", &[]), true),
        Drawn::Unavailable(MermaidRetry::Busy(message)) => problem(failed(message), true),
        Drawn::Unavailable(MermaidRetry::Offline) => problem(tr_shared("mermaid_offline", &[]), true),
        Drawn::Unavailable(MermaidRetry::Timeout) => problem(tr_shared("mermaid_timeout", &[]), true),
        Drawn::Refused(MermaidRefusal::BadRequest) => problem(tr_shared("mermaid_bad_request", &[]), false),
        Drawn::Refused(MermaidRefusal::Unauthorized) => problem(tr_shared("mermaid_unauthorized", &[]), false),
        Drawn::Refused(MermaidRefusal::Gone) => problem(tr_shared("mermaid_gone", &[]), false),
        Drawn::Refused(MermaidRefusal::Other) => problem(tr("mermaid_failed_plain"), false),
        Drawn::Refused(MermaidRefusal::Hidden) => Note::Hidden,
    }
}

#[derive(Default)]
pub(super) struct Store {
    entries: HashMap<Job, (Drawn, u64)>,
    queue: VecDeque<Job>,
    busy: bool,
    tick: u64,
    /// Largura medida da coluna de cada bloco (`mermaid-{linha}-{posição}`), em px CSS: o teto da imagem na tela. Uma
    /// por bloco, porque blocos em colunas de larguras diferentes (lista, citação) trocariam a medida um do outro a
    /// cada quadro e redesenhariam sem parar.
    columns: HashMap<String, f32>,
    /// Um diagrama já desenhado mudou de tamanho na tela: o remedir das linhas está marcado para o próximo quadro, um
    /// só para todos os blocos que mudaram neste.
    relayout: bool,
}

/// Medidas guardadas; acima disso as de blocos que já saíram da tela se perdem (o bloco mede de novo ao voltar).
const COLUMNS_MAX: usize = 256;

pub(super) type Shared = Arc<Mutex<Store>>;

/// Tamanho na tela: o do servidor, encolhido na mesma proporção quando passa da coluna.
fn display_size(width: f32, height: f32, column: f32) -> (f32, f32) {
    if width <= column || column <= 0. { return (width, height); }
    (column, height * column / width)
}

/// O PNG sobre uma cor sólida; `None` quando os bytes não abrem.
fn on_backdrop(png: &[u8], rgb: [u8; 3]) -> Option<Vec<u8>> {
    let top = image::load_from_memory_with_format(png, image::ImageFormat::Png).ok()?.to_rgba8();
    let mut out = image::RgbaImage::from_pixel(top.width(), top.height(), image::Rgba([rgb[0], rgb[1], rgb[2], 255]));
    image::imageops::overlay(&mut out, &top, 0, 0);
    let mut bytes = std::io::Cursor::new(Vec::new());
    out.write_to(&mut bytes, image::ImageFormat::Png).ok()?;
    Some(bytes.into_inner())
}

fn lock(store: &Shared) -> std::sync::MutexGuard<'_, Store> { store.lock().unwrap_or_else(|e| e.into_inner()) }

/// Bloco ```mermaid de uma resposta já assentada. A prévia não usa: ali o bloco segue código.
pub(super) struct Plugin { owner: WeakEntity<Hangar>, store: Shared, server: String, row: String }

pub(super) struct Diagram(Arc<str>);

impl MarkdownPlugin for Plugin {
    fn is_block(&self) -> bool { true }
    fn name(&self) -> &str { "mermaid" }

    fn parse(&self, node: &markdown_ast::Node, context: &MarkdownParseContext<'_>) -> Option<MarkdownNode> {
        let markdown_ast::Node::Code(code) = node else { return None };
        code.lang.as_deref().filter(|lang| lang.eq_ignore_ascii_case("mermaid"))?;
        if code.value.trim().is_empty() { return None; }
        // O texto do nó é a fonte: a busca e a cópia da seleção continuam achando o diagrama.
        Some(MarkdownNode::new(self.name(), Diagram(Arc::from(code.value.as_str()))).text(code.value.clone())
            .markdown(context.node_source(node).unwrap_or_default().to_owned()))
    }

    fn render(&self, node: &MarkdownNode, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let Some(Diagram(source)) = node.data::<Diagram>() else { return div().into_any_element() };
        let at = node.source_range().map_or(0, |range| range.start);
        let element = SharedString::from(format!("mermaid-{}-{at}", self.row));
        let column = lock(&self.store).columns.get(element.as_ref()).copied();
        let drawn = self.lookup(source, cx);
        let size = match &drawn { Drawn::Image { width, height, .. } => Some((*width, *height)), _ => None };
        // A medida da coluna vem do próprio bloco. Só o diagrama já desenhado que muda de tamanho na tela pede remedir
        // as linhas; o código se ajusta sozinho.
        let (store, owner, measured) = (self.store.clone(), self.owner.clone(), element.clone());
        let measure = canvas(move |bounds, window, _| {
            let width = f32::from(bounds.size.width);
            let mut store = lock(&store);
            let old = store.columns.get(measured.as_ref()).copied();
            if width <= 0. || old.is_some_and(|old| (old - width).abs() < 1.) { return; }
            if store.columns.len() >= COLUMNS_MAX && old.is_none() { store.columns.clear(); }
            store.columns.insert(measured.to_string(), width);
            let resized = size.is_some_and(|(w, h)| display_size(w, h, old.unwrap_or(w)) != display_size(w, h, width));
            if !resized || store.relayout { return; }
            store.relayout = true;
            // A conversa é guardada entre quadros: quem redesenha é ela, não só a janela.
            let owner = owner.clone();
            window.on_next_frame(move |_, cx| { let _ = owner.update(cx, |this, cx| this.mermaid_relayout(cx)); });
        }, |_, _, _, _| {}).absolute().top_0().left_0().size_full();
        let body = match drawn {
            Drawn::Image { image, width, height } => {
                let (w, h) = display_size(width, height, column.unwrap_or(width));
                let (owner, open, shown) = (self.owner.clone(), tr_shared("mermaid_open", &[]), image.clone());
                div().id(element).w(px(w)).h(px(h)).cursor_pointer().focusable().tab_stop(true)
                    .role(Role::Button).aria_label(open.clone())
                    .tooltip(move |window, cx| gpui_kit::component::tooltip::Tooltip::new(open.clone()).build(window, cx))
                    .on_click(move |_, window, cx| { let _ = owner.update(cx, |this, cx| this.open_mermaid(image.clone(), window, cx)); })
                    .child(img(shown).size_full().object_fit(ObjectFit::Contain))
                    .into_any_element()
            }
            // Desenhando ou sem imagem: o código, com a linha do estado.
            drawn => self.fallback(element, source, note(&drawn), window, cx),
        };
        div().relative().w_full().my(px(4.)).child(measure).child(body).into_any_element()
    }
}

impl Plugin {
    /// O que já há para esta fonte; sem nada, entra na fila e o desenho é pedido depois deste quadro.
    fn lookup(&self, source: &Arc<str>, cx: &mut App) -> Drawn {
        let job = Job { server: self.server.clone(), dark: theme::is_dark(), width: REQUEST_WIDTH, source: source.clone() };
        let mut store = lock(&self.store);
        store.tick += 1;
        let tick = store.tick;
        if let Some((drawn, seen)) = store.entries.get_mut(&job) { *seen = tick; return drawn.clone(); }
        if source.chars().count() > SOURCE_MAX {
            let drawn = Drawn::Invalid(tr("mermaid_too_long"));
            store.entries.insert(job, (drawn.clone(), tick));
            return drawn;
        }
        store.entries.insert(job.clone(), (Drawn::Waiting, tick));
        store.queue.push_back(job);
        drop(store);
        // Daqui a entidade está sendo desenhada: o pedido sai depois do quadro.
        let owner = self.owner.clone();
        cx.defer(move |cx| { let _ = owner.update(cx, |this, cx| this.pump_mermaid(cx)); });
        Drawn::Waiting
    }

    /// O código como o resto da conversa o mostra, com a linha do estado em cima.
    fn fallback(&self, element: SharedString, source: &Arc<str>, problem: Note, window: &mut Window, cx: &mut App) -> AnyElement {
        let view = window.use_keyed_state((element.clone(), 0usize), cx, |_, cx| {
            TextViewState::markdown(&format!("```mermaid\n{}\n```", source.trim_end_matches('\n')), cx)
        });
        let note = match problem {
            Note::Hidden => None,
            Note::Drawing => Some(div().text_xs().text_color(theme::muted()).child(tr_shared("mermaid_drawing", &[])).into_any_element()),
            Note::Problem { line, retry } => {
                let (store, owner, source) = (self.store.clone(), self.owner.clone(), source.clone());
                Some(div().flex().flex_wrap().items_center().gap_2()
                    .child(div().min_w_0().text_sm().text_color(theme::warning()).whitespace_normal().child(line))
                    .when(retry, |el| el.child(Button::new(SharedString::from(format!("{element}-retry"))).outline().xsmall()
                        .label(tr_shared("mermaid_retry", &[]))
                        .on_click(move |_, _, cx| {
                            // Só a falha tentável sai do guardado: na próxima vez que o bloco aparece, pede de novo.
                            lock(&store).entries.retain(|job, (drawn, _)| !(job.source == source && matches!(drawn, Drawn::Unavailable(_))));
                            let _ = owner.update(cx, |this, cx| this.mermaid_changed(Some(&source), cx));
                        })))
                    .into_any_element())
            }
        };
        div().w_full().flex().flex_col().gap_1().children(note).child(chat_text(&view, cx)).into_any_element()
    }
}

impl Hangar {
    /// Extensões de uma resposta assentada: as citações de arquivo e o Mermaid.
    pub(super) fn answer_extensions(&self, row: &str, cx: &mut Context<Self>) -> gpui_kit::base::text::MarkdownExtensions {
        citation_extensions(row, cx.weak_entity()).plugin(Plugin {
            owner: cx.weak_entity(), store: self.mermaid.clone(), server: self.session_server().unwrap_or_default(), row: row.to_owned(),
        })
    }

    /// Manda o próximo da fila, se nenhum estiver em voo. O que não é mais do tema da tela sai da fila.
    pub(super) fn pump_mermaid(&mut self, cx: &mut Context<Self>) {
        let dark = theme::is_dark();
        let (job, api) = loop {
            let job = {
                let mut store = lock(&self.mermaid);
                if store.busy { return; }
                let Some(job) = store.queue.pop_front() else { return };
                let waiting = matches!(store.entries.get(&job), Some((Drawn::Waiting, _)));
                if waiting && job.dark != dark { store.entries.remove(&job); }
                if !waiting || job.dark != dark { continue; }
                job
            };
            // Servidor que saiu da lista: este pedido cai (volta a ser pedido se o bloco reaparecer), e a fila segue.
            match self.api_for(&job.server) {
                Some(api) => break (job, api),
                None => { lock(&self.mermaid).entries.remove(&job); }
            }
        };
        lock(&self.mermaid).busy = true;
        let (connection, tx) = (self.connection, self.tx.clone());
        self.runtime.spawn(async move {
            let reply = api.mermaid(&job.source, job.dark, job.width).await;
            let _ = tx.send(Envelope { connection, selection: None, payload: Payload::Mermaid(job, reply) }).await;
        });
        cx.notify();
    }

    /// Chegou um desenho: guarda, solta o próximo e redesenha as linhas que mostram a fonte.
    pub(super) fn receive_mermaid(&mut self, job: Job, reply: MermaidReply, window: &mut Window, cx: &mut Context<Self>) {
        let source = job.source.clone();
        let evicted = {
            let mut store = lock(&self.mermaid);
            store.busy = false;
            store.tick += 1;
            let tick = store.tick;
            store.entries.insert(job, (Drawn::from(reply), tick));
            let mut evicted = Vec::new();
            while store.entries.len() > CACHE_MAX {
                let Some(oldest) = store.entries.iter().filter(|(_, (d, _))| !matches!(d, Drawn::Waiting))
                    .min_by_key(|(_, (_, seen))| *seen).map(|(job, _)| job.clone()) else { break };
                if let Some((Drawn::Image { image, .. }, _)) = store.entries.remove(&oldest) { evicted.push(image); }
            }
            evicted
        };
        for image in evicted { release_image(image, window, cx); }
        self.mermaid_changed(Some(&source), cx);
        self.pump_mermaid(cx);
    }

    /// O remedir marcado pelos blocos que mudaram de tamanho no quadro passado.
    fn mermaid_relayout(&mut self, cx: &mut Context<Self>) {
        if std::mem::take(&mut lock(&self.mermaid).relayout) { self.mermaid_changed(None, cx); }
    }

    /// Altura das linhas que mostram esta fonte (sem fonte, qualquer diagrama) mudou: remede e redesenha só elas.
    fn mermaid_changed(&mut self, source: Option<&str>, cx: &mut Context<Self>) {
        let rows: HashSet<String> = self.rich.values().filter(|rich| rich.source.contains(source.unwrap_or("mermaid")))
            .map(|rich| rich.row.clone()).collect();
        for rich in self.rich.values().filter(|rich| rows.contains(&rich.row)) { rich.view.update(cx, |_, cx| cx.notify()); }
        for row in &rows {
            if let Some(i) = self.row_ids.iter().position(|id| id == row) { self.list_state.remeasure_items(i..i + 1); }
        }
        if !rows.is_empty() { self.follow_content_changed(cx); }
        self.redraw(panes::Area::Conversation, cx);
    }

    /// O diagrama no visor, com o zoom dele; a imagem vai da memória, sem passar pela rede. O PNG do servidor é
    /// transparente: no visor ganha o fundo da conversa, senão as linhas somem no que estiver atrás. A composição
    /// decodifica e recodifica o PNG, fora da thread da janela.
    fn open_mermaid(&mut self, image: Arc<Image>, window: &mut Window, cx: &mut Context<Self>) {
        let Some(key) = self.selected_key() else { return };
        let fill = Rgba::from(theme::background().alpha(1.));
        let rgb = [fill.r, fill.g, fill.b].map(|c| (c * 255.).round() as u8);
        let solid = cx.background_executor().spawn(async move { on_backdrop(image.bytes(), rgb).unwrap_or_else(|| image.bytes().to_vec()) });
        cx.spawn_in(window, async move |this, cx| {
            let solid = Arc::new(solid.await);
            let _ = this.update_in(cx, |this, window, cx| {
                this.open_image(key, vec![Source::Memory(tr_shared("mermaid_file", &[]), api::Shared(solid))], 0, window, cx);
            });
        }).detach();
    }
}

#[cfg(test)]
mod tests {
    use super::{display_size, note, on_backdrop, Drawn, Note};
    use crate::api::{mermaid_failure, MermaidRefusal, MermaidReply, MermaidRetry};

    fn drawn(reply: MermaidReply) -> Drawn { Drawn::from(reply) }

    #[test]
    fn only_busy_offline_and_timeout_offer_retry_and_guests_see_just_the_code() {
        let retry = |reply: MermaidReply| matches!(note(&drawn(reply)), Note::Problem { retry: true, .. });
        assert!(retry(mermaid_failure(503, "fila cheia".into())));
        assert!(retry(MermaidReply::Unavailable(MermaidRetry::Offline)));
        assert!(retry(MermaidReply::Unavailable(MermaidRetry::Timeout)));
        for status in [400, 401, 410, 422, 500] { assert!(!retry(mermaid_failure(status, String::new())), "{status}"); }
        assert_eq!(note(&drawn(mermaid_failure(404, String::new()))), Note::Hidden);
        assert_eq!(note(&drawn(mermaid_failure(403, String::new()))), Note::Hidden);
        assert_eq!(mermaid_failure(410, String::new()), MermaidReply::Refused(MermaidRefusal::Gone));
        // Nenhuma linha leva o código HTTP cru.
        for status in [400, 401, 410, 500, 503] {
            if let Note::Problem { line, .. } = note(&drawn(mermaid_failure(status, String::new()))) {
                assert!(!line.contains("http") && !line.contains(&status.to_string()), "{status}: {line}");
            }
        }
    }

    #[test]
    fn backdrop_fills_the_transparent_pixels() {
        let mut png = std::io::Cursor::new(Vec::new());
        image::RgbaImage::from_pixel(2, 1, image::Rgba([0, 0, 0, 0])).write_to(&mut png, image::ImageFormat::Png).unwrap();
        let out = on_backdrop(png.get_ref(), [10, 20, 30]).unwrap();
        let back = image::load_from_memory(&out).unwrap().to_rgba8();
        assert_eq!(back.get_pixel(1, 0).0, [10, 20, 30, 255]);
        assert!(on_backdrop(b"nada", [0, 0, 0]).is_none());
    }

    #[test]
    fn wide_diagram_shrinks_to_the_column_keeping_the_shape() {
        assert_eq!(display_size(400., 300., 800.), (400., 300.));
        assert_eq!(display_size(1000., 500., 500.), (500., 250.));
    }
}
