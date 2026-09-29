//! Rodar o projeto (`RunSheet.svelte`): abre com o comando lembrado já rodando, ou a lista para escolher (personalizados e
//! detectados); rodando, mostra o espelho do pane e deixa trocar ou parar. Só as rotas `runners`, `run`, `run/stop`,
//! `run/pane` e `runners/custom` da sessão; nada roda sem gesto além do lembrado, que o web também dispara ao abrir.
use super::*;
use std::rc::Rc;

const LABEL_MAX: usize = 32;

#[derive(Clone)]
struct Runner { label: String, command: String, dev: bool }

fn runners(value: Option<&Value>) -> Vec<Runner> {
    value.and_then(Value::as_array).map(|list| list.iter().filter_map(|r| Some(Runner {
        label: r.get("label")?.as_str()?.to_owned(),
        command: r.get("command")?.as_str()?.to_owned(),
        dev: r.get("is_dev_guess").and_then(Value::as_bool).unwrap_or(false),
    })).collect()).unwrap_or_default()
}

/// `RunInfo` do servidor: `null` = nada rodando.
fn running(value: Option<&Value>) -> Option<String> {
    value.filter(|r| !r.is_null()).map(|r| r.get("command").and_then(Value::as_str).unwrap_or("").to_owned())
}

struct Form { editing: Option<usize>, label: Entity<InputState>, command: Entity<InputState> }

pub(super) struct RunPanel {
    api: Api,
    runtime: Arc<Runtime>,
    name: String,
    loaded: bool,
    detected: Vec<Runner>,
    custom: Vec<Runner>,
    running: Option<String>,
    picking: bool,
    pane: String,
    error: Option<String>,
    busy: bool,
    form: Option<Form>,
    /// Acende o botão Rodar do painel da sessão.
    report: Rc<dyn Fn(bool, &mut App)>,
    _poll: Task<()>,
}

impl RunPanel {
    fn new(api: Api, runtime: Arc<Runtime>, name: String, report: Rc<dyn Fn(bool, &mut App)>, cx: &mut Context<Self>) -> Self {
        // O espelho segue enquanto o diálogo existe; fechado, a entidade cai e a tarefa junto.
        let poll = cx.spawn(async move |this, cx| loop {
            cx.background_executor().timer(Duration::from_secs(1)).await;
            let job = match this.update(cx, |this, _| this.running.is_some().then(|| {
                let (api, name) = (this.api.clone(), this.name.clone());
                this.runtime.spawn(async move { api.read(&name, &["run", "pane"], &[], 10).await })
            })) { Ok(Some(job)) => job, Ok(None) => continue, Err(_) => break };
            // Falha de um quadro é transitória, como no web: o seguinte tenta de novo.
            let Ok(Ok(value)) = job.await else { continue };
            let pane = value.get("pane").and_then(Value::as_str).unwrap_or("").to_owned();
            if this.update(cx, |this, cx| if this.running.is_some() { this.pane = pane; cx.notify(); }).is_err() { break; }
        });
        Self { api, runtime, name, loaded: false, detected: Vec::new(), custom: Vec::new(), running: None, picking: false,
            pane: String::new(), error: None, busy: false, form: None, report, _poll: poll }
    }

    fn spawn<T: Send + 'static>(&self, job: impl Future<Output = T> + Send + 'static, window: &mut Window, cx: &mut Context<Self>,
        done: impl FnOnce(&mut Self, T, &mut Window, &mut Context<Self>) + 'static) {
        let job = self.runtime.spawn(job);
        cx.spawn_in(window, async move |this, cx| {
            let Ok(value) = job.await else { return };
            let _ = this.update_in(cx, |this, window, cx| { done(this, value, window, cx); cx.notify(); });
        }).detach();
    }

    fn report(&self, cx: &mut App) { (self.report)(self.running.is_some(), cx); }

    fn load(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        (self.error, self.busy) = (None, true);
        let (api, name) = (self.api.clone(), self.name.clone());
        self.spawn(async move { api.read(&name, &["runners"], &[], 15).await }, window, cx, |this, result, window, cx| {
            this.busy = false;
            match result {
                Ok(value) => {
                    this.loaded = true;
                    (this.detected, this.custom) = (runners(value.get("detected")), runners(value.get("custom")));
                    this.running = running(value.get("running"));
                    let remembered = value.get("remembered").and_then(Value::as_str).filter(|c| !c.trim().is_empty()).map(str::to_owned);
                    this.picking = this.running.is_none() && remembered.is_none();
                    this.report(cx);
                    if let (None, Some(command)) = (&this.running, remembered) { this.run(command, window, cx); }
                }
                Err(error) => this.error = Some(Hangar::fetch_failure(&error)),
            }
        });
        cx.notify();
    }

    fn run(&mut self, command: String, window: &mut Window, cx: &mut Context<Self>) {
        if self.busy { return; }
        (self.error, self.busy) = (None, true);
        let (api, name) = (self.api.clone(), self.name.clone());
        self.spawn(async move { api.act(&name, &["run"], Some(json!({"command": command})), false, 30).await }, window, cx, |this, result, _, cx| {
            this.busy = false;
            match result {
                Ok(info) => {
                    (this.running, this.picking, this.pane) = (running(Some(&info)), false, String::new());
                    this.report(cx);
                }
                Err(error) => this.error = Some(Hangar::fetch_failure(&error)),
            }
        });
        cx.notify();
    }

    /// Parada recusada deixa o processo como está na tela: o servidor disse que ele segue vivo.
    fn stop(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.busy { return; }
        (self.error, self.busy) = (None, true);
        let (api, name) = (self.api.clone(), self.name.clone());
        self.spawn(async move { api.act(&name, &["run", "stop"], None, false, 30).await }, window, cx, |this, result, _, cx| {
            this.busy = false;
            match result {
                Ok(_) => {
                    (this.running, this.pane, this.picking) = (None, String::new(), true);
                    this.report(cx);
                }
                Err(error) => this.error = Some(Hangar::fetch_failure(&error)),
            }
        });
        cx.notify();
    }

    /// A lista inteira vai numa gravação só; volta como o servidor leu.
    fn save_custom(&mut self, commands: Vec<Runner>, window: &mut Window, cx: &mut Context<Self>) {
        if self.busy { return; }
        (self.error, self.busy) = (None, true);
        let (api, name) = (self.api.clone(), self.name.clone());
        let body = json!({"commands": commands.iter().map(|c| json!({"label": c.label, "command": c.command})).collect::<Vec<_>>()});
        self.spawn(async move { api.act(&name, &["runners", "custom"], Some(body), false, 15).await }, window, cx, |this, result, _, _| {
            this.busy = false;
            match result {
                Ok(list) => (this.custom, this.form) = (runners(Some(&list)), None),
                Err(error) => this.error = Some(Hangar::fetch_failure(&error)),
            }
        });
        cx.notify();
    }

    fn open_form(&mut self, editing: Option<usize>, window: &mut Window, cx: &mut Context<Self>) {
        let current = editing.and_then(|i| self.custom.get(i)).cloned();
        let field = |value: String, placeholder: String, window: &mut Window, cx: &mut Context<Self>| cx.new(|cx| {
            let mut state = InputState::new(window, cx).placeholder(placeholder);
            state.set_value(value, window, cx);
            state
        });
        let label = field(current.as_ref().map(|c| c.label.clone()).unwrap_or_default(), tr("run_label"), window, cx);
        let command = field(current.map(|c| c.command).unwrap_or_default(), tr("run_command_hint"), window, cx);
        label.update(cx, |state, cx| state.focus(window, cx));
        self.form = Some(Form { editing, label, command });
        cx.notify();
    }

    fn form_values(&self, cx: &App) -> Option<(Option<usize>, Runner)> {
        let form = self.form.as_ref()?;
        let label: String = form.label.read(cx).value().trim().chars().take(LABEL_MAX).collect();
        let command = form.command.read(cx).value().trim().to_owned();
        (!label.is_empty() && !command.is_empty()).then_some((form.editing, Runner { label, command, dev: false }))
    }

    fn submit_form(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some((editing, item)) = self.form_values(cx) else { return };
        let mut list = self.custom.clone();
        match editing.filter(|i| *i < list.len()) { Some(i) => list[i] = item, None => list.push(item) }
        self.save_custom(list, window, cx);
    }

    fn row(&self, id: String, runner: &Runner, cx: &mut Context<Self>) -> Button {
        let command = runner.command.clone();
        Button::new(SharedString::from(id))
            .custom(ButtonCustomVariant::new(cx).color(if runner.dev { theme::accent_dim() } else { transparent_black() })
                .foreground(theme::text()).hover(theme::hover()).active(theme::hover()))
            .flex_1().min_w_0().justify_start().px_3().py(px(8.)).h_auto().rounded(px(8.)).disabled(self.busy)
            .child(div().w_full().min_w_0().flex().items_center().gap_2()
                .child(div().flex_shrink_0().font_family(theme::MONO).font_weight(FontWeight::SEMIBOLD).child(runner.label.clone()))
                .child(div().flex_1().min_w_0().truncate().font_family(theme::MONO).text_xs().text_color(theme::muted()).child(runner.command.clone()))
                .when(runner.dev, |el| el.child(div().flex_shrink_0().px(px(6.)).py(px(2.)).rounded_full().bg(theme::accent_dim())
                    .text_size(px(10.)).font_weight(FontWeight::SEMIBOLD).text_color(theme::accent_text()).child("DEV"))))
            .on_click(cx.listener(move |this, _, window, cx| this.run(command.clone(), window, cx)))
    }

    fn render_picker(&self, cx: &mut Context<Self>) -> Div {
        let section = |text: String| div().mt(px(8.)).text_size(px(11.)).font_weight(FontWeight::BOLD).text_color(theme::muted()).child(text.to_uppercase());
        let mut body = div().flex().flex_col().gap_1();
        if !self.custom.is_empty() {
            body = body.child(section(tr("run_custom")));
            for (i, runner) in self.custom.iter().enumerate() {
                let key = format!("{}:{}", runner.label, runner.command);
                body = body.child(div().flex().items_center().gap(px(2.))
                    .child(self.row(format!("run-custom-{key}"), runner, cx))
                    .child(chrome::icon_button(SharedString::from(format!("run-edit-{key}")), IconName::Pencil, tr("shortcuts_edit"), cx).small()
                        .disabled(self.busy).on_click(cx.listener(move |this, _, window, cx| this.open_form(Some(i), window, cx))))
                    .child(chrome::icon_button(SharedString::from(format!("run-remove-{key}")), IconName::Close, tr("shortcuts_remove"), cx).small()
                        .disabled(self.busy).on_click(cx.listener(move |this, _, window, cx| {
                            let list = this.custom.iter().enumerate().filter(|(k, _)| *k != i).map(|(_, c)| c.clone()).collect();
                            this.save_custom(list, window, cx);
                        }))));
            }
        }
        body = body.child(match &self.form {
            Some(form) => div().my_2().p_3().flex().flex_col().gap_2().rounded(px(8.)).border_1().border_color(theme::border()).bg(theme::inset())
                .child(Input::new(&form.label).small()).child(Input::new(&form.command).small())
                .child(div().flex().justify_end().gap_2()
                    .child(Button::new("run-form-cancel").ghost().small().label(tr("cancel"))
                        .on_click(cx.listener(|this, _, _, cx| { this.form = None; cx.notify(); })))
                    .child(Button::new("run-form-ok").primary().small().label(tr("run_form_ok")).loading(self.busy)
                        .disabled(self.busy || self.form_values(cx).is_none())
                        .on_click(cx.listener(|this, _, window, cx| this.submit_form(window, cx))))),
            None => div().mt_1().flex().child(Button::new("run-add").outline().small().icon(IconName::Plus).label(tr("run_add"))
                .disabled(self.busy).on_click(cx.listener(|this, _, window, cx| this.open_form(None, window, cx)))),
        });
        if self.detected.is_empty() && self.custom.is_empty() {
            body = body.child(div().py_4().text_center().text_sm().text_color(theme::muted()).child(tr("run_none")));
        } else if !self.detected.is_empty() {
            if !self.custom.is_empty() { body = body.child(section(tr("run_detected"))); }
            for runner in &self.detected {
                body = body.child(div().flex().child(self.row(format!("run-detected-{}:{}", runner.label, runner.command), runner, cx)));
            }
        }
        body
    }
}

impl Render for RunPanel {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let error = self.error.clone().map(|e| div().mb_2().text_sm().text_color(theme::danger()).whitespace_normal().child(e));
        let content = if !self.loaded {
            // Sem a primeira leitura não há lista nem estado: carregando, ou a falha com o tentar de novo.
            let retry = (self.error.is_some() && !self.busy).then(|| Button::new("run-retry").outline().small().icon(IconName::RefreshCw)
                .label(tr("shortcuts_retry")).on_click(cx.listener(|this, _, window, cx| this.load(window, cx))));
            div().flex().flex_col().gap_2()
                .when(self.busy, |el| el.child(div().text_sm().text_color(theme::muted()).child(tr("run_loading"))))
                .children(retry)
        } else if self.picking || self.running.is_none() {
            self.render_picker(cx)
        } else {
            let head = div().mb_3().flex().items_center().justify_between().gap_2()
                .child(div().flex_1().min_w_0().truncate().font_family(theme::MONO).text_xs().text_color(theme::muted())
                    .child(self.running.clone().unwrap_or_default()))
                .child(div().flex().flex_shrink_0().gap_2()
                    .child(Button::new("run-switch").ghost().small().label(tr("run_switch")).disabled(self.busy)
                        .on_click(cx.listener(|this, _, _, cx| { this.picking = true; cx.notify(); })))
                    .child(Button::new("run-stop").danger().small().icon(IconName::CircleStop).label(tr("run_stop")).loading(self.busy)
                        .disabled(self.busy).on_click(cx.listener(|this, _, window, cx| this.stop(window, cx)))));
            let mirror = div().id("run-pane").max_h(px(420.)).overflow_y_scroll().p_3().rounded(px(8.)).bg(theme::inset())
                .font_family(theme::MONO).text_xs().text_color(theme::muted()).whitespace_normal()
                .child(if self.pane.is_empty() { tr("run_pane_empty") } else { self.pane.clone() });
            div().flex().flex_col().child(head).child(mirror)
        };
        div().w_full().flex().flex_col().children(error).child(content)
    }
}

impl Hangar {
    /// O atalho Rodar: diálogo do projeto da sessão aberta; o estado dele acende o botão do painel.
    pub(super) fn open_run(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let (Some(api), Some(key)) = (self.session_api(), self.selected_key()) else { return };
        let hangar = cx.entity().downgrade();
        let owner = key.clone();
        let report: Rc<dyn Fn(bool, &mut App)> = Rc::new(move |on, cx| {
            let _ = hangar.update(cx, |this, cx| { this.side.run = Some((owner.clone(), on)); cx.notify(); });
        });
        let (runtime, name) = (self.runtime.clone(), key.name.clone());
        let panel = cx.new(|cx| RunPanel::new(api, runtime, name, report, cx));
        panel.update(cx, |panel, cx| panel.load(window, cx));
        window.open_dialog(cx, move |dialog, _, _| popup::dialog(dialog).w(px(640.)).title(tr("run_title")).child(panel.clone()));
    }

    /// O botão já nasce aceso quando há um run vivo no projeto, como o web ao abrir a conversa.
    pub(super) fn load_run_state(&mut self) {
        let (Some(api), Some(key)) = (self.session_api(), self.selected_key()) else { return };
        let (connection, tx) = (self.connection, self.tx.clone());
        self.runtime.spawn(async move {
            let result = api.read(&key.name, &["runners"], &[], 15).await;
            let _ = tx.send(Envelope { connection, selection: None, payload: Payload::Reply(key, Reply::RunState, result) }).await;
        });
    }

    pub(super) fn receive_run_state(&mut self, key: SessionKey, result: Result<Value, Failure>) {
        // Só acende o indicador; leitura que falhou não diz nada sobre o processo e deixa o botão como está.
        if let Ok(value) = result { self.side.run = Some((key, running(value.get("running")).is_some())); }
    }
}
