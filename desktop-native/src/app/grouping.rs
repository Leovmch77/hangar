//! Grupos de sessões como o web (Sidebar + dragToGroup + GrupoDropDialog): blocos na lista por `pair_gid`, arrastar uma
//! sessão sobre outra (ou sobre o cabeçalho do bloco) e soltar no fundo da lista para sair. O gesto nunca agrupa direto: abre
//! o diálogo, porque agrupar funde os grupos inteiros e sair avisa quem ficou, sem desfazer. O menu da sessão chega ao mesmo
//! diálogo por "Agrupar com…" e "Sair do grupo".
use super::*;
use super::activity::web;
use super::sidebar::{SidebarReply, Target};
use gpui_kit::base::AccordionTrigger;
use gpui_kit::component::{WindowExt, menu::PopupMenu};
use std::{cell::RefCell, rc::Rc};

/// Por que soltar a origem sobre o alvo não agrupa (`DropReason` do web).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Refusal { Same, OtherServer, Dead, SameGroup, CrossServer, Orq }

impl Refusal {
    pub(super) fn text(self) -> String {
        web(match self {
            Refusal::Same => "grupo_recusa_same",
            Refusal::OtherServer => "grupo_recusa_other_server",
            Refusal::Dead => "grupo_recusa_dead",
            Refusal::SameGroup => "grupo_recusa_same_group",
            Refusal::CrossServer => "grupo_recusa_cross_server",
            Refusal::Orq => "grupo_recusa_orq",
        })
    }
}

fn remote_peer(s: &SessionInfo) -> bool { s.peers().iter().any(|p| p.contains("::")) }

/// `canPair` do web. `same_server`: as duas são da mesma máquina (o grupo é resolvido pelo backend de uma só).
pub(super) fn can_pair(origin: &SessionInfo, target: &SessionInfo, same_server: bool) -> Result<(), Refusal> {
    if !same_server { return Err(Refusal::OtherServer); }
    if origin.name == target.name { return Err(Refusal::Same); }
    // O grupo da orquestração é montado pelo orq; agrupar a linha dele à mão desfaz a execução.
    if origin.orq() || target.orq() { return Err(Refusal::Orq); }
    if origin.state == "dead" || target.state == "dead" { return Err(Refusal::Dead); }
    if origin.pair_gid.is_some() && origin.pair_gid == target.pair_gid { return Err(Refusal::SameGroup); }
    if remote_peer(origin) || remote_peer(target) { return Err(Refusal::CrossServer); }
    Ok(())
}

/// `canLeave` do web: o par de outro servidor não tem `pair_gid`, por isso os pares também contam.
pub(super) fn can_leave(s: &SessionInfo) -> bool { !s.orq() && (s.pair_gid.is_some() || !s.peers().is_empty()) }

pub(super) enum ListRow<'a> {
    Header { gid: String, label: String, members: Vec<&'a SessionInfo> },
    Session(&'a SessionInfo),
}

/// `clusterByPair` do web: cada grupo vira um cabeçalho no lugar do primeiro membro, seguido dos membros; o resto fica onde
/// estava. O rótulo é a tarefa do primeiro que tiver uma, senão os nomes.
// ponytail: busca dos membros quadrática no tamanho da fatia; a lista de sessões é curta.
pub(super) fn cluster<'a>(list: &[&'a SessionInfo]) -> Vec<ListRow<'a>> {
    let mut out = Vec::new();
    let mut done: HashSet<&str> = HashSet::new();
    for s in list {
        let Some(gid) = s.pair_gid.as_deref() else { out.push(ListRow::Session(s)); continue };
        if !done.insert(gid) { continue; }
        let members: Vec<&SessionInfo> = list.iter().copied().filter(|m| m.pair_gid.as_deref() == Some(gid)).collect();
        let label = members.iter().filter_map(|m| m.pair_task.as_deref().map(str::trim)).find(|t| !t.is_empty()).map(str::to_owned)
            .unwrap_or_else(|| members.iter().map(|m| m.name.as_str()).collect::<Vec<_>>().join(", "));
        out.push(ListRow::Header { gid: gid.to_owned(), label, members: members.clone() });
        out.extend(members.into_iter().map(ListRow::Session));
    }
    out
}

/// `pairCodigo`/`pairResto` do web (`^([A-Za-z][\w.]*-\d+)\b\s*(.*)$`): a chave do ticket em destaque e o assunto em cinza.
pub(super) fn split_code(label: &str) -> (&str, &str) {
    let code = || -> Option<usize> {
        if !label.starts_with(|c: char| c.is_ascii_alphabetic()) { return None; }
        let dash = label.find(|c: char| !(c.is_ascii_alphanumeric() || c == '_' || c == '.'))?;
        if !label[dash..].starts_with('-') { return None; }
        let end = label[dash + 1..].find(|c: char| !c.is_ascii_digit()).map_or(label.len(), |n| dash + 1 + n);
        let word = |c: char| c.is_ascii_alphanumeric() || c == '_';
        (end > dash + 1 && !label[end..].starts_with(word)).then_some(end)
    };
    match code() { Some(end) => (&label[..end], label[end..].trim_start()), None => (label, "") }
}

/// Chave do bloco recolhido; noutra máquina leva a chave dela, como os grupos de projeto.
pub(super) fn pair_key(gid: &str, remote: Option<&str>) -> String {
    match remote { Some(key) => format!("{key}::pair:{gid}"), None => format!("pair:{gid}") }
}

/// O que anda com o arrasto: a sessão (máquina + nome).
#[derive(Clone)]
pub(super) struct SessionDrag { target: Target }

/// Onde o ponteiro está durante o arrasto. `Pair` é o cabeçalho do bloco, que vale pelo primeiro membro (agrupar funde o grupo
/// inteiro). Alvo de outra máquina que a da origem é recusado.
#[derive(Clone, Debug, PartialEq)]
pub(super) enum DropSpot { Row(Target), Pair { gid: String, rep: Target } }

enum DropAction { Join(Target), Leave }

/// `target` é da mesma máquina da origem: agrupar só existe dentro de uma.
enum AskMode { Join { origin: Target, target: String }, Leave { origin: Target } }

/// O que o diálogo mostra. Mora fora do `Hangar` porque o `open_dialog` desenha na hora, com o `Hangar` em atualização; a
/// lista nova de sessões refaz os campos vivos (`refresh_group_ask`).
#[derive(Default)]
struct AskView {
    join: bool,
    affected: Vec<String>,
    /// Entrando num grupo que já existe: a tarefa dele (vazia se não tem). `None` mostra o campo da tarefa.
    inherited: Option<String>,
    block: Option<String>,
    busy: bool,
    suggesting: bool,
    error: Option<String>,
    /// 409 do servidor: o grupo já tem outra tarefa, e o botão passa a ser "Substituir a tarefa".
    conflict: Option<String>,
    /// Feito, mas o aviso não chegou a alguém: resta fechar.
    done: bool,
}

struct GroupAsk { mode: AskMode, seq: u64, task: Entity<InputState>, view: Rc<RefCell<AskView>>, _events: Subscription }

pub(super) enum GroupReply { Paired(Result<PairResult, Failure>), Left(Result<PairResult, Failure>), Suggested(Result<String, Failure>) }

#[derive(Default)]
pub(super) struct Grouping {
    /// Sessão arrastada agora; só vale com um arrasto em curso (`has_active_drag`).
    origin: Option<Target>,
    spot: Option<DropSpot>,
    /// Ponteiro dentro da área visível da lista: linha rolada para fora ainda tem caixa, e só isto a separa da visível.
    in_list: bool,
    ask: Option<GroupAsk>,
    pub(super) seq: u64,
    /// Painel do grupo aberto pelo chip do compositor.
    pub(super) sheet: Option<super::group_sheet::Sheet>,
    /// "Mandar pro grupo" ligado nesta sessão, com os membros de quando ligou: grupo que muda desliga, como no web.
    pub(super) send_to_group: Option<(SessionKey, String)>,
}

impl Grouping {
    pub(super) fn reset(&mut self) {
        let seq = self.seq + 1;
        *self = Self { seq, ..Self::default() };
    }
}

/// A sessão presa ao ponteiro; embaixo, o motivo da recusa ou o aviso de saída, como o `title` do alvo no web.
struct DragChip { name: String, hangar: WeakEntity<Hangar> }

impl Render for DragChip {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let hint = self.hangar.upgrade().and_then(|hangar| hangar.read(cx).drop_hint(cx));
        div().max_w(px(280.)).px_3().py(px(6.)).flex().flex_col().gap(px(2.)).rounded(px(8.)).border_1().border_color(theme::border_strong())
            .bg(theme::raised()).shadow(theme::popover_shadow()).text_sm()
            .child(div().flex().items_center().gap(px(6.)).child(glyph(13., theme::accent()))
                .child(div().min_w_0().truncate().font_weight(FontWeight::MEDIUM).child(self.name.clone())))
            .when_some(hint, |el, (text, refused)| el.child(div().text_xs().whitespace_normal()
                .text_color(if refused { theme::danger() } else { theme::muted() }).child(text)))
    }
}

pub(super) fn glyph(size: f32, color: Hsla) -> Svg { svg().path(crate::GROUP_GLYPH).size(px(size)).flex_shrink_0().text_color(color) }

pub(super) fn web_with(key: &str, name: &str, value: &str) -> String {
    crate::i18n::tr_web(key, &HashMap::from([(name.to_owned(), value.to_owned())])).unwrap_or_else(|| key.to_owned())
}

impl Hangar {
    /// Sessão `name` da máquina `server`, pela lista viva dela.
    fn session(&self, server: &str, name: &str) -> Option<&SessionInfo> { self.target_session(&Target::new(server, name)) }

    /// O bloco deste membro está recolhido.
    pub(super) fn pair_collapsed(&self, s: &SessionInfo, remote: Option<&str>) -> bool {
        s.pair_gid.as_deref().is_some_and(|gid| self.sidebar.is_collapsed(&pair_key(gid, remote)))
    }

    /// Candidatas do "Agrupar com…": as outras da mesma máquina que o arrastar aceitaria, na ordem da barra.
    pub(super) fn group_candidates(&self, origin: &Target) -> Vec<String> {
        let Some(session) = self.target_session(origin) else { return Vec::new() };
        let mut list: Vec<&SessionInfo> = self.sessions_of(&origin.server).iter().filter(|s| !self.sidebar.is_hidden(&origin.server, &s.name)).collect();
        list.sort_by_cached_key(|s| s.name.to_lowercase());
        list.into_iter().filter(|s| can_pair(session, s, true).is_ok()).map(|s| s.name.clone()).collect()
    }

    // ── Arrastar ──

    fn dragging<'a>(&'a self, cx: &App) -> Option<&'a Target> { self.sidebar.grouping.origin.as_ref().filter(|_| cx.has_active_drag()) }

    /// `None`: ponteiro fora da lista. `Some(None)`: no fundo dela.
    fn current_spot(&self) -> Option<Option<&DropSpot>> {
        let g = &self.sidebar.grouping;
        g.in_list.then_some(g.spot.as_ref())
    }

    /// O que soltar ali faria, pela sessão viva: `None` é nada (fundo sem grupo, sessão sumida).
    fn verdict(&self, origin: &Target, spot: Option<&DropSpot>) -> Option<Result<DropAction, Refusal>> {
        // Convidado não agrupa nem desagrupa: parear é rota do servidor inteiro do dono.
        if self.invite_target(origin) { return None; }
        let session = self.target_session(origin)?;
        match spot {
            None => can_leave(session).then_some(Ok(DropAction::Leave)),
            Some(DropSpot::Row(target) | DropSpot::Pair { rep: target, .. }) => {
                let other = self.target_session(target)?;
                Some(can_pair(session, other, target.server == origin.server).map(|_| DropAction::Join(target.clone())))
            }
        }
    }

    fn drop_hint(&self, cx: &App) -> Option<(String, bool)> {
        match self.verdict(self.dragging(cx)?, self.current_spot()?)? {
            Ok(DropAction::Leave) => Some((tr("group_drop_leave"), false)),
            Ok(DropAction::Join(_)) => None,
            Err(refusal) => Some((refusal.text(), true)),
        }
    }

    /// Este alvo está sob o ponteiro: `Some(true)` aceita, `Some(false)` recusa.
    fn targeted(&self, spot: &DropSpot, cx: &App) -> Option<bool> {
        let origin = self.dragging(cx)?;
        if self.current_spot()? != Some(spot) { return None; }
        match self.verdict(origin, Some(spot))? { Ok(_) => Some(true), Err(_) => Some(false) }
    }

    fn start_session_drag(&mut self, target: Target, cx: &mut Context<Self>) {
        self.row_release(); // senão o pressionar longo abre o renomear no meio do arrasto
        self.hide_preview();
        let g = &mut self.sidebar.grouping;
        (g.origin, g.spot, g.in_list) = (Some(target), None, true);
        cx.notify();
    }

    /// Cada alvo diz se o ponteiro está dentro dele; a lista diz se ele está na parte visível.
    fn drag_moved(&mut self, spot: Option<DropSpot>, inside: bool, cx: &mut Context<Self>) {
        let g = &mut self.sidebar.grouping;
        let before = (g.spot.clone(), g.in_list);
        match spot {
            None => g.in_list = inside,
            Some(spot) if inside => g.spot = Some(spot),
            Some(spot) => if g.spot.as_ref() == Some(&spot) { g.spot = None },
        }
        if before != (g.spot.clone(), g.in_list) { cx.notify(); }
    }

    pub(super) fn end_session_drag(&mut self, cx: &mut Context<Self>) {
        let g = &mut self.sidebar.grouping;
        (g.origin, g.spot, g.in_list) = (None, None, false);
        cx.notify();
    }

    /// Soltou: confere de novo pela sessão viva e abre o pedido; recusado não faz nada.
    fn drop_session(&mut self, origin: Target, spot: Option<DropSpot>, window: &mut Window, cx: &mut Context<Self>) {
        let verdict = self.verdict(&origin, spot.as_ref());
        self.end_session_drag(cx);
        match verdict {
            Some(Ok(DropAction::Join(target))) => self.request_group(origin, target.name, window, cx),
            Some(Ok(DropAction::Leave)) => self.request_leave(origin, window, cx),
            _ => {}
        }
    }

    /// Alvo de soltar: realce de aceite (contorno e fundo de destaque) ou de recusa (tracejado), como o web.
    fn drop_target<E: InteractiveElement + Styled + ParentElement + IntoElement>(&self, el: E, spot: DropSpot, radius: f32,
        cx: &mut Context<Self>) -> E {
        let state = self.targeted(&spot, cx);
        let moved = spot.clone();
        el.on_drag_move(cx.listener(move |this, event: &DragMoveEvent<SessionDrag>, _, cx| {
                this.drag_moved(Some(moved.clone()), event.bounds.contains(&event.event.position), cx);
            }))
            .on_drop(cx.listener(move |this, dragged: &SessionDrag, window, cx| this.drop_session(dragged.target.clone(), Some(spot.clone()), window, cx)))
            .when_some(state, |el, ok| el.when(ok, |el| el.bg(theme::accent_dim()))
                .child(div().absolute().inset_0().rounded(px(radius)).border_2()
                    .map(|b| if ok { b.border_color(theme::accent()) } else { b.border_dashed().border_color(theme::muted()) })))
    }

    /// Fundo da lista: sabe se o ponteiro está nela e, soltando ali, pede a saída do grupo.
    pub(super) fn drop_background(&self, el: Stateful<Div>, cx: &mut Context<Self>) -> Stateful<Div> {
        el.on_drag_move(cx.listener(|this, event: &DragMoveEvent<SessionDrag>, _, cx| {
                this.drag_moved(None, event.bounds.contains(&event.event.position), cx);
            }))
            .on_drop(cx.listener(|this, dragged: &SessionDrag, window, cx| this.drop_session(dragged.target.clone(), None, window, cx)))
    }

    /// Linha da lista, de qualquer máquina: arrastável, alvo de soltar e, no bloco, recuada com a faixa do grupo (âmbar
    /// quando espera resposta, como o web). `remote` é a chave da máquina quando ela não é a ativa.
    pub(super) fn group_row(&self, el: Stateful<Div>, session: &SessionInfo, remote: Option<&str>, radius: f32, cx: &mut Context<Self>) -> Stateful<Div> {
        let target = Target::new(&remote.map(str::to_owned).unwrap_or_else(|| self.active_key()), &session.name);
        let member = session.pair_gid.is_some();
        let lifted = self.dragging(cx) == Some(&target);
        let bar = if session.state == "awaiting_input" { theme::warning() } else { theme::accent() };
        let el = el.when(member, |el| el.ml(px(8.)).child(div().absolute().left_0().top(px(6.)).bottom(px(6.)).w(px(2.)).rounded_full().bg(bar)))
            .when(lifted, |el| el.opacity(0.45));
        let weak = cx.entity().downgrade();
        let el = el.on_drag(SessionDrag { target: target.clone() }, move |dragged, _, _, cx| {
            let _ = weak.update(cx, |this, cx| this.start_session_drag(dragged.target.clone(), cx));
            cx.new(|_| DragChip { name: dragged.target.name.clone(), hangar: weak.clone() })
        });
        self.drop_target(el, DropSpot::Row(target), radius, cx)
    }

    /// Cabeçalho do bloco (`.pair-head` do web): ▾, glifo, chave da tarefa em destaque e o resto em cinza, quantas esperam e o
    /// total. Clicar recolhe; soltar sobre ele agrupa com o bloco.
    pub(super) fn render_pair_header(&self, gid: &str, label: &str, members: &[&SessionInfo], remote: Option<&str>, window: &mut Window,
        cx: &mut Context<Self>) -> AnyElement {
        let key = pair_key(gid, remote);
        let open = !self.sidebar.is_collapsed(&key);
        let awaiting = members.iter().filter(|s| s.state == "awaiting_input").count();
        let (code, rest) = split_code(label);
        let id = SharedString::from(format!("pair-head-{key}"));
        let focus = window.use_keyed_state(SharedString::from(format!("{id}-focus")), cx, |_, cx| cx.focus_handle().tab_stop(true)).read(cx).clone();
        let title = web_with("sessao_grupo_pareado", "label", label);
        let tip = title.clone();
        let server = remote.map(str::to_owned).unwrap_or_else(|| self.active_key());
        let rep = members.first().map_or_else(String::new, |rep| rep.name.clone());
        let spot = DropSpot::Pair { gid: gid.to_owned(), rep: Target::new(&server, &rep) };
        let pill = |text: String, color: Hsla, bg: Hsla| div().flex_shrink_0().min_w(px(18.)).px(px(6.)).rounded_full().bg(bg)
            .flex().justify_center().font_family(theme::MONO).text_size(px(11.)).font_weight(FontWeight::SEMIBOLD).text_color(color).child(text);
        let weak = cx.entity().downgrade();
        let header = AccordionTrigger::new(id).open(open).track_focus(&focus).aria_label(format!("{title} · {}", members.len()))
            .relative().flex_shrink_0().mt(px(4.)).min_h(px(26.)).px(px(8.)).rounded(px(8.)).border_1().border_color(transparent_black())
            .flex().items_center().gap(px(6.)).cursor_pointer().hover(|el| el.bg(theme::hover())).focus_visible(|el| el.border_color(theme::accent_focus()))
            .tooltip(move |window, cx| gpui_kit::component::tooltip::Tooltip::new(tip.clone()).build(window, cx))
            .child(chrome::small_icon(if open { IconName::ChevronDown } else { IconName::ChevronRight }, 14., theme::faint()))
            .child(glyph(13., theme::accent()))
            .child(div().flex_1().min_w_0().flex().items_center().gap(px(4.)).text_xs()
                .child(div().flex_shrink_0().max_w_full().truncate().font_weight(FontWeight::SEMIBOLD).text_color(theme::accent_text()).child(code.to_owned()))
                .when(!rest.is_empty(), |el| el.child(div().min_w_0().truncate().text_color(theme::muted()).child(rest.to_owned()))))
            .when(awaiting > 0, |el| el.child(pill(awaiting.to_string(), theme::warning(), theme::warning().opacity(0.14))))
            .child(pill(members.len().to_string(), theme::muted(), theme::inset()))
            .on_change(move |_, _, _, cx| { let _ = weak.update(cx, |this, cx| this.toggle_group(key.clone(), cx)); });
        self.drop_target(header, spot, 8., cx).into_any_element()
    }

    // ── Diálogo ──

    /// `target` é outra sessão da máquina de `origin`.
    pub(super) fn request_group(&mut self, origin: Target, target: String, window: &mut Window, cx: &mut Context<Self>) {
        // Tarefa que já existe entra no campo (a do alvo antes), como o web.
        let task = [&target, &origin.name].into_iter().filter_map(|n| self.session(&origin.server, n)?.pair_task.clone()).find(|t| !t.trim().is_empty());
        self.open_group_ask(AskMode::Join { origin, target }, task.unwrap_or_default(), window, cx);
    }

    pub(super) fn request_leave(&mut self, origin: Target, window: &mut Window, cx: &mut Context<Self>) {
        self.open_group_ask(AskMode::Leave { origin }, String::new(), window, cx);
    }

    fn open_group_ask(&mut self, mode: AskMode, task: String, window: &mut Window, cx: &mut Context<Self>) {
        let origin = ask_origin(&mode).clone();
        let join = matches!(mode, AskMode::Join { .. });
        let input = cx.new(|cx| InputState::new(window, cx).placeholder(web("grupo_drop_tarefa")).default_value(task));
        let events = cx.subscribe_in(&input, window, |this, _, event: &InputEvent, window, cx| match event {
            // Enter faz o que o botão principal à vista faz.
            InputEvent::PressEnter { .. } => {
                let replace = this.sidebar.grouping.ask.as_ref().is_some_and(|a| a.view.borrow().conflict.is_some());
                this.confirm_group(replace, window, cx);
            }
            // Mexer na tarefa desfaz o "Substituir": o 409 era da tarefa anterior.
            InputEvent::Change => {
                if let Some(ask) = this.sidebar.grouping.ask.as_ref() { ask.view.borrow_mut().conflict = None; }
                cx.notify();
            }
            _ => {}
        });
        let g = &mut self.sidebar.grouping;
        g.seq += 1;
        let seq = g.seq;
        let view = Rc::new(RefCell::new(AskView { join, ..AskView::default() }));
        g.ask = Some(GroupAsk { mode, seq, task: input.clone(), view: view.clone(), _events: events });
        self.refresh_group_ask();
        if join && view.borrow().inherited.is_none() {
            let field = input.clone();
            cx.defer_in(window, move |_, window, cx| field.update(cx, |state, cx| state.focus(window, cx)));
        }
        // O diálogo devolve ao fechar o foco de quando abriu: o da linha de origem.
        self.focus_origin(&origin, window, cx);
        let weak = cx.entity().downgrade();
        window.open_dialog(cx, move |dialog, _, _| {
            let v = view.borrow();
            let title = web(match (v.join, v.done) {
                (true, false) => "grupo_drop_titulo", (true, true) => "grupo_drop_titulo_feito",
                (false, false) => "grupo_drop_sair_titulo", (false, true) => "grupo_drop_sair_titulo_feito",
            });
            let act = |id: &'static str, label: String, run: fn(&mut Hangar, &mut Window, &mut Context<Hangar>)| {
                let weak = weak.clone();
                Button::new(id).label(label).on_click(move |_, window, cx| { let _ = weak.update(cx, |this, cx| run(this, window, cx)); })
            };
            let affected = (!v.affected.is_empty()).then(|| div().flex().flex_col().gap(px(4.))
                .child(div().text_sm().text_color(theme::muted()).child(web("grupo_drop_afetadas")))
                .child(div().flex().flex_col().gap(px(2.)).text_sm()
                    .children(v.affected.iter().map(|name| div().min_w_0().truncate().font_family(theme::MONO).child(name.clone())))));
            let task_row = match (&v.inherited, v.join && !v.done) {
                (_, false) => None,
                (Some(task), true) => (!task.trim().is_empty()).then(|| div().text_sm().text_color(theme::muted()).whitespace_normal()
                    .child(web_with("grupo_drop_tarefa_herdada", "tarefa", task)).into_any_element()),
                (None, true) => Some(div().flex().items_center().gap_2()
                    .child(div().flex_1().min_w_0().child(Input::new(&input).disabled(v.busy || v.suggesting).aria_label(web("grupo_drop_tarefa"))))
                    .child(act("group-suggest", web(if v.suggesting { "grupo_drop_sugerindo" } else { "grupo_drop_sugerir" }), |this, _, cx| this.suggest_group_task(cx))
                        .loading(v.suggesting).disabled(v.busy || v.suggesting || v.block.is_some()))
                    .into_any_element()),
            };
            let alert = |id: &'static str, text: String| div().id(id).role(Role::Alert).text_sm().whitespace_normal().text_color(theme::danger()).child(text);
            let alerts = [
                v.error.clone().map(|t| alert("group-error", t)),
                v.conflict.clone().map(|t| alert("group-conflict", t)),
                v.block.clone().filter(|_| v.error.is_none() && v.conflict.is_none() && !v.busy).map(|t| alert("group-block", t)),
            ];
            let variant = if v.join { ButtonVariant::Primary } else { ButtonVariant::Danger };
            let footer = div().flex().justify_end().gap_2().map(|el| if v.done {
                el.child(Button::new("group-close").label(web("sessao_fechar")).with_variant(variant).on_click(|_, window, cx| window.close_dialog(cx)))
            } else {
                let replace = v.join && v.conflict.is_some();
                let label = web(if replace { "grupo_drop_substituir_tarefa" } else if v.join { "grupo_drop_confirmar" } else { "grupo_drop_sair_confirmar" });
                let confirm = weak.clone();
                el.child(Button::new("group-cancel").label(tr("cancel")).disabled(v.busy).on_click(|_, window, cx| window.close_dialog(cx)))
                    .child(Button::new("group-ok").label(label).with_variant(variant).loading(v.busy).disabled(v.busy || v.suggesting || v.block.is_some())
                        .on_click(move |_, window, cx| { let _ = confirm.update(cx, |this, cx| this.confirm_group(replace, window, cx)); }))
            });
            let close = weak.clone();
            // Com a chamada em voo o diálogo não fecha: a resposta (aviso, 409, erro) cairia no vazio.
            popup::dialog(dialog).w(px(420.)).title(title).keyboard(!v.busy).overlay_closable(!v.busy).close_button(!v.busy)
                .child(div().flex().flex_col().gap(px(12.)).children(affected).children(task_row).children(alerts.into_iter().flatten()))
                .footer(footer)
                .on_ok(super::machines::enter_to_focused)
                .on_close(move |_, _, cx| { let _ = close.update(cx, |this, _| {
                    if this.sidebar.grouping.ask.as_ref().is_some_and(|a| a.seq == seq) { this.sidebar.grouping.ask = None; }
                }); })
        });
        cx.notify();
    }

    /// Relê o pedido aberto na lista viva: sessão que morreu ou mudou de grupo durante a confirmação decide aqui, não o clique.
    pub(super) fn refresh_group_ask(&self) {
        let Some(ask) = self.sidebar.grouping.ask.as_ref() else { return };
        let mut v = ask.view.borrow_mut();
        match &ask.mode {
            AskMode::Join { origin, target } => {
                let (o, t) = (self.target_session(origin), self.session(&origin.server, target));
                // Agrupar funde os grupos inteiros: todos os afetados, não só os dois.
                let mut names: Vec<String> = Vec::new();
                for s in [o, t].into_iter().flatten() {
                    for name in std::iter::once(&s.name).chain(s.peers()) { if !names.contains(name) { names.push(name.clone()); } }
                }
                v.affected = names;
                // Com a chamada em voo fica o que se via no clique.
                if !v.busy { v.inherited = existing_group(o, t).map(|g| g.pair_task.clone().unwrap_or_default()); }
                v.block = match (o, t) { (Some(o), Some(t)) => can_pair(o, t, true).err().map(Refusal::text), _ => Some(Refusal::Dead.text()) };
            }
            AskMode::Leave { origin } => {
                let o = self.target_session(origin);
                v.affected = o.map(|s| s.peers().to_vec()).unwrap_or_default();
                v.block = o.is_none().then(|| Refusal::Dead.text());
            }
        }
    }

    fn confirm_group(&mut self, replace: bool, _window: &mut Window, cx: &mut Context<Self>) {
        self.refresh_group_ask();
        let Some(ask) = self.sidebar.grouping.ask.as_ref() else { return };
        let mut v = ask.view.borrow_mut();
        if v.busy || v.done || v.suggesting { return; }
        if let Some(block) = v.block.clone() { v.error = Some(block); cx.notify(); return; }
        let Some(api) = self.machine_api(ask_origin(&ask.mode).server.as_str()) else { v.error = Some(tr("connection_failed")); cx.notify(); return };
        let (seq, tell) = (ask.seq, self.sidebar_tell());
        // Entrando num grupo que existe, a tarefa é a dele: o campo nem aparece.
        let task = if v.inherited.is_some() { String::new() } else { ask.task.read(cx).value().trim().to_owned() };
        (v.busy, v.error) = (true, None);
        match &ask.mode {
            AskMode::Join { origin, target } => {
                let (origin, target) = (origin.name.clone(), target.clone());
                self.runtime.spawn(async move {
                    let result = api.pair(&target, &[origin], &task, replace).await;
                    tell.send(SidebarReply::Group(seq, GroupReply::Paired(result))).await;
                });
            }
            AskMode::Leave { origin } => {
                let origin = origin.name.clone();
                self.runtime.spawn(async move { tell.send(SidebarReply::Group(seq, GroupReply::Left(api.unpair(&origin).await))).await; });
            }
        }
        cx.notify();
    }

    fn suggest_group_task(&mut self, cx: &mut Context<Self>) {
        let Some(ask) = self.sidebar.grouping.ask.as_ref() else { return };
        let mut v = ask.view.borrow_mut();
        if v.busy || v.suggesting || v.block.is_some() { return; }
        let Some(api) = self.machine_api(ask_origin(&ask.mode).server.as_str()) else { v.error = Some(tr("connection_failed")); cx.notify(); return };
        let (seq, tell, names) = (ask.seq, self.sidebar_tell(), v.affected.clone());
        (v.suggesting, v.error) = (true, None);
        self.runtime.spawn(async move {
            tell.send(SidebarReply::Group(seq, GroupReply::Suggested(api.suggest_group_task(&names).await))).await;
        });
        cx.notify();
    }

    /// Resposta de um pedido: só o diálogo que a pediu a recebe; fechado, ela não mexe em nada.
    pub(super) fn receive_group(&mut self, seq: u64, reply: GroupReply, window: &mut Window, cx: &mut Context<Self>) {
        let Some(ask) = self.sidebar.grouping.ask.as_ref().filter(|a| a.seq == seq) else { return };
        let task = ask.task.clone();
        let mut close = false;
        {
            let mut v = ask.view.borrow_mut();
            match reply {
                GroupReply::Paired(Ok(result)) | GroupReply::Left(Ok(result)) => {
                    v.busy = false;
                    match result.warning {
                        // O vínculo mudou, mas alguém não foi avisado: fica à vista, com o título de feito.
                        Some(warning) => (v.done, v.conflict, v.error) = (true, None, Some(warning)),
                        None => close = true,
                    }
                }
                GroupReply::Paired(Err(error)) => {
                    v.busy = false;
                    if error.status == Some(409) { v.conflict = Some(Self::fetch_failure(&error)); }
                    else { (v.conflict, v.error) = (None, Some(failed(&error, "grupo_drop_falhou"))); }
                }
                GroupReply::Left(Err(error)) => (v.busy, v.error) = (false, Some(failed(&error, "grupo_drop_sair_falhou"))),
                GroupReply::Suggested(Ok(text)) => {
                    (v.suggesting, v.conflict) = (false, None);
                    drop(v);
                    task.update(cx, |state, cx| state.set_value(text, window, cx));
                }
                GroupReply::Suggested(Err(error)) => (v.suggesting, v.error) = (false, Some(failed(&error, "grupo_drop_falhou"))),
            }
        }
        if close {
            self.sidebar.grouping.ask = None;
            window.close_dialog(cx);
        }
        cx.notify();
    }
}

fn ask_origin(mode: &AskMode) -> &Target { match mode { AskMode::Join { origin, .. } | AskMode::Leave { origin } => origin } }

/// Motivo do servidor; sem ele, a frase do web.
pub(super) fn failed(error: &Failure, fallback: &str) -> String {
    let text = Hangar::fetch_failure(error);
    if text.trim().is_empty() { web(fallback) } else { text }
}

/// Sessão solta + grupo que já existe = só entrar, herdando a tarefa dele. Duas soltas ou dois grupos: nasce/funde, com o campo.
fn existing_group<'a>(origin: Option<&'a SessionInfo>, target: Option<&'a SessionInfo>) -> Option<&'a SessionInfo> {
    let (o, t) = (origin?, target?);
    let grouped = |s: &SessionInfo| !s.peers().is_empty();
    if grouped(o) == grouped(t) { return None; }
    Some(if grouped(t) { t } else { o })
}

/// Submenu "Agrupar com…": as candidatas em mono; escolher abre o diálogo.
pub(super) fn fill_group(menu: PopupMenu, hangar: &WeakEntity<Hangar>, origin: &Target, candidates: &[String]) -> PopupMenu {
    let menu = sidebar::menu_style(menu).label(tr("group_with"));
    if candidates.is_empty() { return menu.item(PopupMenuItem::new(tr("group_none")).disabled(true)); }
    candidates.iter().fold(menu.min_w(px(220.)).max_h(px(260.)).scrollable(true), |menu, target| {
        let (hangar, origin, target) = (hangar.clone(), origin.clone(), target.clone());
        menu.item(sidebar::mono_item(target.clone(), false).on_click(move |_, window, cx| {
            let _ = hangar.update(cx, |this, cx| this.request_group(origin.clone(), target.clone(), window, cx));
        }))
    })
}

#[cfg(test)]
mod tests {
    // Sem glob: o `test` do gpui_kit, que o `super::*` traz, esconderia o `#[test]` da linguagem.
    use super::{ListRow, Refusal, SessionInfo, can_leave, can_pair, cluster, existing_group, split_code};
    use crate::api::dto::PairResult;

    fn s(name: &str, gid: Option<&str>, peers: &[&str]) -> SessionInfo {
        SessionInfo { name: name.into(), state: "idle".into(), pair_gid: gid.map(str::to_owned),
            pair_peers: (!peers.is_empty()).then(|| peers.iter().map(|p| (*p).to_owned()).collect()), ..Default::default() }
    }

    #[test]
    fn can_pair_refuses_like_the_web() {
        let (a, b) = (s("a", None, &[]), s("b", None, &[]));
        assert_eq!(can_pair(&a, &b, true), Ok(()));
        assert_eq!(can_pair(&a, &a, true), Err(Refusal::Same));
        assert_eq!(can_pair(&a, &b, false), Err(Refusal::OtherServer));
        assert_eq!(can_pair(&a, &SessionInfo { state: "dead".into(), ..b.clone() }, true), Err(Refusal::Dead));
        assert_eq!(can_pair(&s("a", Some("g"), &["b"]), &s("b", Some("g"), &["a"]), true), Err(Refusal::SameGroup));
        assert_eq!(can_pair(&s("a", Some("g"), &["b"]), &s("c", Some("h"), &["d"]), true), Ok(()), "grupos diferentes se fundem");
        assert_eq!(can_pair(&a, &s("b", None, &["srv::x"]), true), Err(Refusal::CrossServer));
        let orq = SessionInfo { provider: "orq".into(), ..s("o", None, &[]) };
        assert_eq!(can_pair(&orq, &b, true), Err(Refusal::Orq));
        assert_eq!(can_pair(&a, &orq, true), Err(Refusal::Orq));
    }

    #[test]
    fn leaving_needs_a_group_or_a_remote_pair() {
        assert!(!can_leave(&s("a", None, &[])));
        assert!(can_leave(&s("a", Some("g"), &["b"])));
        assert!(can_leave(&s("a", None, &["srv::x"])), "par de outro servidor não tem gid");
        assert!(!can_leave(&SessionInfo { provider: "orq".into(), ..s("o", Some("g"), &["b"]) }), "o grupo do orq é dele");
    }

    #[test]
    fn cluster_puts_the_header_where_the_first_member_was() {
        let all = [s("a", None, &[]), s("b", Some("g"), &["d"]), s("c", None, &[]), s("d", Some("g"), &["b"])];
        let list: Vec<&SessionInfo> = all.iter().collect();
        let shape: Vec<String> = cluster(&list).iter().map(|row| match row {
            ListRow::Header { gid, label, members } => format!("[{gid} {label} {}]", members.len()),
            ListRow::Session(s) => s.name.clone(),
        }).collect();
        assert_eq!(shape, ["a", "[g b, d 2]", "b", "d", "c"], "sem tarefa o rótulo são os nomes");
        let tasked = [s("x", Some("g"), &["y"]), SessionInfo { pair_task: Some(" ABC-1 tela ".into()), ..s("y", Some("g"), &["x"]) }];
        let list: Vec<&SessionInfo> = tasked.iter().collect();
        assert!(matches!(&cluster(&list)[0], ListRow::Header { label, .. } if label == "ABC-1 tela"));
    }

    #[test]
    fn task_code_splits_like_the_web_regex() {
        assert_eq!(split_code("ABC-1234 Assunto comprido"), ("ABC-1234", "Assunto comprido"));
        assert_eq!(split_code("XYZ-42: tela"), ("XYZ-42", ": tela"), "\\b antes da pontuação");
        assert_eq!(split_code("hangar.v2-12"), ("hangar.v2-12", ""));
        assert_eq!(split_code("ABC-12x resto"), ("ABC-12x resto", ""), "dígito colado em letra não é chave");
        assert_eq!(split_code("a, b"), ("a, b", ""));
        assert_eq!(split_code("1-2 x"), ("1-2 x", ""));
    }

    #[test]
    fn joining_an_existing_group_inherits_its_task() {
        let (lone, grouped) = (s("a", None, &[]), s("b", Some("g"), &["c"]));
        assert_eq!(existing_group(Some(&lone), Some(&grouped)).map(|g| g.name.as_str()), Some("b"));
        assert!(existing_group(Some(&lone), Some(&s("z", None, &[]))).is_none(), "duas soltas: grupo novo");
        assert!(existing_group(Some(&grouped), Some(&s("d", Some("h"), &["e"]))).is_none(), "dois grupos: fundem");
    }

    #[test]
    fn pair_warning_reads_the_envelope_message() {
        assert_eq!(PairResult::from_value(&serde_json::json!({"ok": true, "warning": null})).warning, None);
        assert_eq!(PairResult::from_value(&serde_json::json!({"warning": {"code": "x", "msg": "aviso falhou em: b"}})).warning.as_deref(),
            Some("aviso falhou em: b"));
        assert_eq!(PairResult::from_value(&serde_json::json!({"warning": "cru"})).warning.as_deref(), Some("cru"));
    }
}
