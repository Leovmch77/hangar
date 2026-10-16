//! Preferências de worktrees do servidor selecionado.
use super::*;
use super::settings::{Page, settings_box};
use serde::{Deserialize, Serialize};
use gpui_kit::component::{switch::Switch, select::{Select, SelectEvent, SelectState}, searchable_list::SearchableListItem};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
enum KeepWhen { UncommittedChanges, TrackedChanges, AnyLocalFiles }
impl KeepWhen {
    const ALL: [Self; 3] = [Self::UncommittedChanges, Self::TrackedChanges, Self::AnyLocalFiles];
    fn key(self) -> &'static str { match self {
        Self::UncommittedChanges => "worktree_settings_keep_uncommitted",
        Self::TrackedChanges => "worktree_settings_keep_tracked", Self::AnyLocalFiles => "worktree_settings_keep_any",
    } }
    fn help(self) -> String { tr(&format!("{}_help", self.key())) }
}
impl SearchableListItem for KeepWhen {
    type Value = Self;
    fn title(&self) -> SharedString { tr(self.key()).into() }
    fn value(&self) -> &Self { self }
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Preferences {
    location: String,
    inactive_days: Option<u16>,
    delete_merged: bool,
    delete_unchanged: bool,
    keep_when: KeepWhen,
}
impl Preferences {
    fn parse(value: Value) -> Result<Self, String> {
        let parsed: Self = serde_json::from_value(value).map_err(|_| tr("invalid_response"))?;
        if parsed.inactive_days.is_some_and(|days| !(1..=3650).contains(&days)) { return Err(tr("invalid_response")); }
        Ok(parsed)
    }
}

#[derive(Default)]
struct Editor {
    generation: u64, connection: u64, current: Option<Preferences>, draft: Option<Preferences>,
    days: String, loading: bool, saving: bool, error: Option<String>, saved: bool,
}
impl Editor {
    fn start(&mut self, connection: u64) -> u64 {
        let generation = self.generation + 1;
        *self = Self { generation, connection, loading: true, ..Self::default() };
        generation
    }
    fn accepts(&self, connection: u64, generation: u64) -> bool { self.connection == connection && self.generation == generation }
    fn receive(&mut self, connection: u64, generation: u64, value: Preferences) -> bool {
        if !self.accepts(connection, generation) { return false; }
        self.saved = self.saving;
        self.days = value.inactive_days.unwrap_or(8).to_string();
        self.draft = Some(value.clone()); self.current = Some(value);
        (self.loading, self.saving, self.error) = (false, false, None);
        true
    }
    fn fail(&mut self, connection: u64, generation: u64, error: String) -> bool {
        if !self.accepts(connection, generation) { return false; }
        (self.loading, self.saving, self.error, self.saved) = (false, false, Some(error), false);
        true
    }
    fn value(&self) -> Result<Preferences, String> {
        let mut draft = self.draft.clone().ok_or_else(|| tr("invalid_response"))?;
        if draft.inactive_days.is_some() {
            draft.inactive_days = Some(self.days.trim().parse::<u16>().ok().filter(|n| (1..=3650).contains(n))
                .ok_or_else(|| tr("worktree_settings_days_invalid"))?);
        }
        Ok(draft)
    }
    fn dirty(&self) -> bool { self.current.is_some() && self.value().as_ref().ok() != self.current.as_ref() }
    fn begin_save(&mut self) -> Option<(u64, Preferences)> {
        if self.loading || self.saving || !self.dirty() { return None; }
        let value = self.value().ok()?;
        self.generation += 1;
        (self.saving, self.saved, self.error) = (true, false, None);
        Some((self.generation, value))
    }
    fn changed(&mut self) { self.saved = false; self.error = None; }
}

struct Inputs {
    location: Entity<InputState>, days: Entity<InputState>, keep: Entity<SelectState<Vec<KeepWhen>>>, _subscriptions: Vec<Subscription>,
}
#[derive(Default)]
pub(super) struct WorktreeSettings { editor: Editor, inputs: Option<Inputs> }
pub(super) struct WorktreeSettingsReply { connection: u64, generation: u64, result: Result<Value, Failure> }

async fn request(api: &Api, value: Option<&Preferences>) -> Result<Value, Failure> {
    match value {
        None => api.server_read(&["worktrees", "settings"], &[], 15).await,
        Some(value) => api.server_send(reqwest::Method::PUT, &["worktrees", "settings"], Some(json!(value)), 15).await,
    }
}

impl Hangar {
    pub(super) fn relabel_worktree_settings(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(inputs) = &self.worktree_settings.inputs {
            inputs.location.update(cx, |input, cx| input.set_placeholder(tr("worktree_settings_location_default"), window, cx));
        }
    }
    pub(super) fn worktree_settings_opened(&mut self, cx: &mut Context<Self>) {
        // A conexão muda também ao reconectar: nenhum rascunho ou resposta pertence à máquina seguinte.
        if self.worktree_settings.editor.connection == self.connection
            && (self.worktree_settings.editor.current.is_some() || self.worktree_settings.editor.loading) { return; }
        self.load_worktree_settings(cx);
    }
    fn load_worktree_settings(&mut self, cx: &mut Context<Self>) {
        let generation = self.worktree_settings.editor.start(self.connection);
        self.worktree_settings.inputs = None;
        self.request_worktree_settings(generation, None, cx);
    }
    fn request_worktree_settings(&self, generation: u64, value: Option<Preferences>, cx: &mut Context<Self>) {
        let Some(api) = self.api.clone() else { return; };
        let (tx, connection) = (self.tx.clone(), self.connection);
        self.runtime.spawn(async move {
            let result = request(&api, value.as_ref()).await;
            let _ = tx.send(Envelope { connection, selection: None,
                payload: Payload::WorktreeSettings(WorktreeSettingsReply { connection, generation, result }) }).await;
        });
        cx.notify();
    }
    fn save_worktree_settings(&mut self, cx: &mut Context<Self>) {
        let Some((generation, value)) = self.worktree_settings.editor.begin_save() else { return; };
        self.request_worktree_settings(generation, Some(value), cx);
    }
    pub(super) fn receive_worktree_settings(&mut self, reply: WorktreeSettingsReply, window: &mut Window, cx: &mut Context<Self>) {
        let WorktreeSettingsReply { connection, generation, result } = reply;
        let editor = &mut self.worktree_settings.editor;
        if !editor.accepts(connection, generation) { return; }
        let parsed = result.map_err(|error| Self::fetch_failure(&error)).and_then(Preferences::parse);
        match parsed {
            Ok(value) => { editor.receive(connection, generation, value); self.make_worktree_inputs(window, cx); }
            Err(error) => { editor.fail(connection, generation, error); }
        }
        cx.notify();
    }
    fn make_worktree_inputs(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(value) = self.worktree_settings.editor.draft.clone() else { return; };
        let location = cx.new(|cx| InputState::new(window, cx).placeholder(tr("worktree_settings_location_default")).default_value(value.location.clone()));
        let days = cx.new(|cx| InputState::new(window, cx).default_value(self.worktree_settings.editor.days.clone()));
        let keep = cx.new(|cx| SelectState::new(KeepWhen::ALL.to_vec(), None, window, cx));
        keep.update(cx, |state, cx| state.set_selected_value(&value.keep_when, window, cx));
        let mut subscriptions = Vec::new();
        subscriptions.push(cx.subscribe_in(&location, window, |this: &mut Hangar, input, event: &InputEvent, _, cx| {
            if !matches!(event, InputEvent::Change) || this.worktree_settings.editor.saving { return; }
            if let Some(draft) = &mut this.worktree_settings.editor.draft { draft.location = input.read(cx).value().to_string(); }
            this.worktree_settings.editor.changed(); cx.notify();
        }));
        subscriptions.push(cx.subscribe_in(&days, window, |this: &mut Hangar, input, event: &InputEvent, _, cx| {
            if !matches!(event, InputEvent::Change) || this.worktree_settings.editor.saving { return; }
            this.worktree_settings.editor.days = input.read(cx).value().to_string();
            this.worktree_settings.editor.changed(); cx.notify();
        }));
        subscriptions.push(cx.subscribe_in(&keep, window, |this: &mut Hangar, _, event: &SelectEvent<Vec<KeepWhen>>, _, cx| {
            let SelectEvent::Confirm(Some(value)) = event else { return; };
            if this.worktree_settings.editor.saving { return; }
            if let Some(draft) = &mut this.worktree_settings.editor.draft { draft.keep_when = *value; }
            this.worktree_settings.editor.changed(); cx.notify();
        }));
        self.worktree_settings.inputs = Some(Inputs { location, days, keep, _subscriptions: subscriptions });
    }
    pub(super) fn render_worktree_settings(&mut self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let mut page = div().flex().flex_col().gap_4()
            .child(div().text_xl().font_weight(FontWeight::SEMIBOLD).child(Page::Worktrees.title()))
            .child(div().text_sm().text_color(theme::muted()).whitespace_normal().child(tr("worktree_settings_intro")));
        if self.api.is_none() { return page.child(div().text_sm().text_color(theme::muted()).child(tr("settings_offline"))).into_any_element(); }
        let s = &self.worktree_settings;
        if s.editor.loading {
            return page.child(div().id("worktree-settings-loading").role(Role::Status).aria_label(tr("loading"))
                .text_sm().text_color(theme::muted()).child(tr("loading"))).into_any_element();
        }
        if let Some(error) = &s.editor.error {
            page = page.child(div().id("worktree-settings-error").role(Role::Alert).text_sm().text_color(theme::danger()).whitespace_normal().child(error.clone()));
            if s.editor.current.is_none() {
                return page.child(Button::new("worktree-settings-retry").outline().small().label(tr("server_retry"))
                    .on_click(cx.listener(|this, _, _, cx| this.load_worktree_settings(cx)))).into_any_element();
            }
        }
        if s.inputs.is_none() && s.editor.draft.is_some() { self.make_worktree_inputs(window, cx); }
        let s = &self.worktree_settings;
        let (Some(value), Some(inputs)) = (&s.editor.draft, &s.inputs) else { return page.into_any_element(); };
        let off = s.editor.saving;
        let location = self.row_with(IconName::Folder, "worktree_settings_location",
            div().whitespace_normal().child(tr("worktree_settings_location_help"))
                .child(div().mt_2().child(Input::new(&inputs.location).id("worktree-settings-location").small().disabled(off).accessibility_id("worktree-settings-location")
                    .aria_label(tr("worktree_settings_location")))), true, div().into_any_element());
        let inactive_control = div().flex().items_center().gap_3()
            .when(value.inactive_days.is_some(), |el| el
                .child(div().w(px(72.)).child(Input::new(&inputs.days).id("worktree-settings-days").small().disabled(off).accessibility_id("worktree-settings-days").aria_label(tr("worktree_settings_days"))))
                .child(div().text_sm().text_color(theme::muted()).child(tr("worktree_settings_days"))))
            .child(Switch::new("worktree-settings-inactive").checked(value.inactive_days.is_some()).disabled(off)
                .accessibility_label(tr("worktree_settings_inactive"))
                .on_click(cx.listener(|this, on: &bool, window, cx| {
                    let editor = &mut this.worktree_settings.editor;
                    if editor.saving { return; }
                    if let Some(draft) = &mut editor.draft { draft.inactive_days = on.then_some(8); }
                    if *on {
                        editor.days = "8".into();
                        if let Some(inputs) = &this.worktree_settings.inputs { inputs.days.update(cx, |input, cx| input.set_value("8", window, cx)); }
                    }
                    editor.changed(); cx.notify();
                })));
        let inactive = self.row(IconName::Clock, "worktree_settings_inactive", Some(tr("worktree_settings_inactive_help")), true, inactive_control.into_any_element());
        let merged = self.row(IconName::GitBranch, "worktree_settings_merged", Some(tr("worktree_settings_merged_help")), true,
            Switch::new("worktree-settings-merged").checked(value.delete_merged).disabled(off).accessibility_label(tr("worktree_settings_merged"))
                .on_click(cx.listener(|this, on: &bool, _, cx| {
                    if this.worktree_settings.editor.saving { return; }
                    if let Some(draft) = &mut this.worktree_settings.editor.draft { draft.delete_merged = *on; }
                    this.worktree_settings.editor.changed(); cx.notify();
                })).into_any_element());
        let unchanged = self.row(IconName::GitBranch, "worktree_settings_unchanged", Some(tr("worktree_settings_unchanged_help")), true,
            Switch::new("worktree-settings-unchanged").checked(value.delete_unchanged).disabled(off).accessibility_label(tr("worktree_settings_unchanged"))
                .on_click(cx.listener(|this, on: &bool, _, cx| {
                    if this.worktree_settings.editor.saving { return; }
                    if let Some(draft) = &mut this.worktree_settings.editor.draft { draft.delete_unchanged = *on; }
                    this.worktree_settings.editor.changed(); cx.notify();
                })).into_any_element());
        let keep = self.row_with(IconName::FileText, "worktree_settings_keep",
            div().whitespace_normal().child(tr("worktree_settings_keep_help"))
                .child(div().mt_2().text_color(theme::warning()).child(value.keep_when.help())), true,
            div().w(px(220.)).child(Select::new(&inputs.keep).id("worktree-settings-keep").small().disabled(off)
                .accessibility_label(tr("worktree_settings_keep"))).into_any_element());
        page = page.child(settings_box().child(location).child(inactive).child(merged).child(unchanged).child(keep))
            .child(div().text_sm().text_color(theme::muted()).whitespace_normal().child(tr("worktree_settings_protection")));
        let invalid = s.editor.value().err();
        page.when_some(invalid.clone(), |el, error| el.child(div().id("worktree-settings-validation").role(Role::Alert)
                .text_sm().text_color(theme::danger()).child(error)))
            .child(div().flex().items_center().justify_end().gap_3()
                .when(s.editor.saved, |el| el.child(div().id("worktree-settings-saved").role(Role::Status).text_sm()
                    .text_color(theme::success()).child(tr("server_saved"))))
                .child(Button::new("worktree-settings-save").primary().small()
                    .label(tr(if off { "server_saving" } else { "server_save" })).loading(off).disabled(off || !s.editor.dirty() || invalid.is_some())
                    .on_click(cx.listener(|this, _, _, cx| this.save_worktree_settings(cx)))))
            .into_any_element()
    }
}

#[cfg(test)]
mod tests {
    use super::{Preferences, Editor, request};
    use crate::api::Api;
    use serde_json::{Value, json};
    fn fixture() -> Value { json!({"location":"", "inactive_days":null, "delete_merged":false,
        "delete_unchanged":false, "keep_when":"uncommitted-changes"}) }
    #[test]
    fn worktree_settings_contract_rejects_days_outside_server_limits() {
        for days in [0, 3651] {
            let mut value = fixture(); value["inactive_days"] = json!(days);
            assert!(Preferences::parse(value).is_err(), "prazo inválido: {days}");
        }
    }
    #[test]
    fn worktree_settings_old_server_reply_cannot_replace_current_server() {
        let mut editor = Editor::default();
        let old = editor.start(10);
        let current = editor.start(11);
        let mut next = fixture(); next["location"] = json!("~/novas");
        assert!(editor.receive(11, current, Preferences::parse(next).unwrap()));
        assert!(!editor.receive(10, old, Preferences::parse(fixture()).unwrap()));
        assert_eq!(editor.current.unwrap().location, "~/novas");
    }
    #[test]
    fn worktree_settings_save_is_complete_and_busy_until_current_response() {
        let mut editor = Editor::default();
        let loaded = editor.start(11);
        editor.receive(11, loaded, Preferences::parse(fixture()).unwrap());
        assert!(!editor.dirty());
        editor.draft.as_mut().unwrap().delete_merged = true;
        let (saving, value) = editor.begin_save().unwrap();
        assert!(value.delete_merged);
        assert!(editor.saving);
        assert!(editor.begin_save().is_none());
        assert!(!editor.receive(10, saving, Preferences::parse(fixture()).unwrap()));
        assert!(editor.saving);
        assert!(editor.receive(11, saving, value));
        assert!(editor.saved);
        assert!(!editor.dirty());
    }
    #[test]
    fn worktree_settings_invalid_typed_days_cannot_be_saved() {
        let mut editor = Editor::default();
        let loaded = editor.start(11);
        editor.receive(11, loaded, Preferences::parse(fixture()).unwrap());
        editor.draft.as_mut().unwrap().inactive_days = Some(8);
        for typed in ["", "0", "3651", "oito", "8.5"] {
            editor.days = typed.into();
            assert!(editor.dirty());
            assert!(editor.begin_save().is_none(), "prazo digitado: {typed}");
            assert!(!editor.saving);
        }
        editor.days = "3650".into();
        assert_eq!(editor.begin_save().unwrap().1.inactive_days, Some(3650));
    }
    #[tokio::test]
    async fn worktree_settings_http_contract_reads_and_replaces_complete_preferences() {
        use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let replacement = json!({"location":"~/worktrees", "inactive_days":8, "delete_merged":true,
            "delete_unchanged":false, "keep_when":"any-local-files"});
        let expected = replacement.clone();
        let server = tokio::spawn(async move {
            for method in ["GET", "PUT"] {
                let (stream, _) = listener.accept().await.unwrap();
                let mut stream = BufReader::new(stream);
                let mut first = String::new(); stream.read_line(&mut first).await.unwrap();
                assert_eq!(first.trim(), format!("{method} /api/worktrees/settings HTTP/1.1"));
                let mut length = 0; let mut auth = false;
                loop {
                    let mut line = String::new(); stream.read_line(&mut line).await.unwrap();
                    if line == "\r\n" { break; }
                    if let Some((name, value)) = line.split_once(':') {
                        if name.eq_ignore_ascii_case("content-length") { length = value.trim().parse::<usize>().unwrap(); }
                        if name.eq_ignore_ascii_case("authorization") { auth = value.trim() == "Bearer fixture-owner"; }
                    }
                }
                assert!(auth);
                let mut bytes = vec![0; length]; stream.read_exact(&mut bytes).await.unwrap();
                if method == "PUT" { assert_eq!(serde_json::from_slice::<Value>(&bytes).unwrap(), expected); }
                let body = if method == "GET" { fixture() } else { expected.clone() }.to_string();
                stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
            }
        });
        let api = Api::new(&format!("http://{address}"), "fixture-owner").unwrap();
        assert_eq!(Preferences::parse(request(&api, None).await.unwrap()).unwrap(), Preferences::parse(fixture()).unwrap());
        let next = Preferences::parse(replacement).unwrap();
        assert_eq!(Preferences::parse(request(&api, Some(&next)).await.unwrap()).unwrap(), next);
        server.await.unwrap();
    }
}
