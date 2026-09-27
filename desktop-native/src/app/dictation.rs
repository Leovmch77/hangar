use super::*;
use std::{io::Read, process::{Child, Command, Stdio}, sync::Mutex, thread};

const STYLES: [&str; 3] = ["limpar", "prosa", "briefing"];
const PCM_LIMIT: usize = 16_000 * 2 * 180;

struct Recorder {
    child: Option<Child>,
    reader: Option<thread::JoinHandle<std::io::Result<()>>>,
    pcm: Arc<Mutex<Vec<u8>>>,
    playback: Option<Instant>,
}

impl Drop for Recorder {
    fn drop(&mut self) {
        if let Some(child) = &mut self.child {
            if let Err(error) = child.kill() { eprintln!("dictation stop: {error}"); }
            if let Err(error) = child.wait() { eprintln!("dictation reap: {error}"); }
        }
        if let Some(reader) = self.reader.take() { let _ = reader.join(); }
    }
}

impl Recorder {
    fn start() -> Result<Self, Failure> {
        let mut recorder = Self { child: None, reader: None, pcm: Default::default(), playback: None };
        if let Some(path) = std::env::var_os("HANGAR_NATIVE_DICTATION_WAV") {
            let mut bytes = Vec::new();
            std::fs::File::open(path).and_then(|file| file.take((PCM_LIMIT + 4097) as u64).read_to_end(&mut bytes))
                .map_err(|_| Failure::local("dictation_wav_error"))?;
            *recorder.pcm.lock().unwrap() = wav_pcm(&bytes).ok_or_else(|| Failure::local("dictation_wav_error"))?.to_vec();
            recorder.playback = Some(Instant::now());
            return Ok(recorder);
        }
        if !cfg!(target_os = "linux") { return Err(Failure::local("dictation_platform")); }
        let mut child = Command::new("pw-record").args(["--raw", "--format", "s16", "--rate", "16000", "--channels", "1", "-"])
            .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn()
            .map_err(|_| Failure::local("dictation_recorder_error"))?;
        let mut stdout = child.stdout.take().expect("piped recorder stdout");
        recorder.child = Some(child);
        let pcm = recorder.pcm.clone();
        recorder.reader = Some(thread::Builder::new().name("dictation-audio".into()).spawn(move || {
            let mut chunk = [0u8; 4096];
            loop {
                let n = stdout.read(&mut chunk)?;
                if n == 0 { return Ok(()); }
                let mut bytes = pcm.lock().unwrap();
                let n = n.min(PCM_LIMIT.saturating_sub(bytes.len()));
                bytes.extend_from_slice(&chunk[..n]);
            }
        }).map_err(|_| Failure::local("dictation_recorder_error"))?);
        Ok(recorder)
    }

    fn level(&self) -> f32 {
        let bytes = self.pcm.lock().unwrap();
        let end = self.playback.map(|start| (start.elapsed().as_millis() as usize * 32) % bytes.len()).unwrap_or(bytes.len()) & !1;
        bytes[end.saturating_sub(3200)..end].chunks_exact(2)
            .map(|b| i16::from_le_bytes([b[0], b[1]]).unsigned_abs() as f32 / 32768.).fold(0., f32::max)
    }

    fn finish(mut self) -> Result<Vec<u8>, Failure> {
        if let Some(mut child) = self.child.take() {
            let kill = child.kill();
            let wait = child.wait();
            if kill.is_err() || wait.is_err() { return Err(Failure::local("dictation_recorder_error")); }
        }
        if let Some(reader) = self.reader.take() {
            reader.join().map_err(|_| Failure::local("dictation_recorder_error"))?
                .map_err(|_| Failure::local("dictation_recorder_error"))?;
        }
        let pcm = self.pcm.lock().unwrap();
        if pcm.len() < 2 { return Err(Failure::local("dictation_empty_audio")); }
        Ok(wav(&pcm[..pcm.len() & !1]))
    }
}

fn wav(pcm: &[u8]) -> Vec<u8> {
    let mut bytes = b"RIFF".to_vec();
    bytes.extend_from_slice(&(36 + pcm.len() as u32).to_le_bytes());
    bytes.extend_from_slice(b"WAVEfmt \x10\0\0\0\x01\0\x01\0\x80\x3e\0\0\0\x7d\0\0\x02\0\x10\0data");
    bytes.extend_from_slice(&(pcm.len() as u32).to_le_bytes());
    bytes.extend_from_slice(pcm);
    bytes
}

fn wav_pcm(bytes: &[u8]) -> Option<&[u8]> {
    if bytes.len() > PCM_LIMIT + 4096 || bytes.get(..4)? != b"RIFF" || bytes.get(8..12)? != b"WAVE" { return None; }
    let (mut offset, mut format, mut data) = (12usize, false, None);
    while offset + 8 <= bytes.len() {
        let size = u32::from_le_bytes(bytes[offset + 4..offset + 8].try_into().ok()?) as usize;
        let chunk = bytes.get(offset + 8..offset.checked_add(8)?.checked_add(size)?)?;
        match &bytes[offset..offset + 4] {
            b"fmt " => format = chunk.get(..16) == Some(&b"\x01\0\x01\0\x80\x3e\0\0\0\x7d\0\0\x02\0\x10\0"[..]),
            b"data" => data = Some(chunk), _ => {}
        }
        offset += 8 + size + (size % 2);
    }
    data.filter(|pcm| format && !pcm.is_empty() && pcm.len() <= PCM_LIMIT && pcm.len() % 2 == 0)
}

#[derive(Default)]
pub(super) struct Dictation {
    seq: u64,
    owner: Option<(u64, u64)>,
    recorder: Option<Recorder>,
    request: Option<JoinHandle<()>>,
    started: Option<Instant>,
    level: f32,
    result: Option<Value>,
    style: Option<(u64, &'static str)>,
    style_writes: u64,
    style_task: Option<Task<()>>,
    audio: Arc<Mutex<Vec<u8>>>,
    versions: HashMap<String, Value>,
    inserted: Option<(String, std::ops::Range<usize>)>,
    cleaning: bool,
    error: Option<String>,
}

impl Dictation {
    fn style(&self, connection: u64) -> Option<&'static str> {
        self.style.filter(|(owner, _)| *owner == connection).map(|(_, style)| style)
    }

    fn text_in_field(&self, value: &str) -> bool {
        self.inserted.as_ref().is_some_and(|(draft, range)| value.get(range.clone()) == draft.get(range.clone()))
    }

    fn draft_matches(&self, value: &str) -> bool {
        self.inserted.as_ref().is_none_or(|(draft, _)| draft == value)
    }

    fn cancel(&mut self) {
        self.seq += 1;
        self.owner = None;
        self.recorder = None;
        if let Some(task) = self.request.take() { task.abort(); }
        self.started = None;
        self.level = 0.;
        self.result = None;
        self.audio = Default::default();
        self.versions.clear();
        self.inserted = None;
        self.cleaning = false;
        self.error = None;
    }
}

impl Drop for Dictation { fn drop(&mut self) { self.cancel(); } }

impl Hangar {
    pub(super) fn watch_dictation(_window: &Window, cx: &mut Context<Self>) {
        let mut style_connection = None;
        cx.observe_self(move |this, cx| {
            if this.dictation.owner.is_some_and(|owner| owner != (this.connection, this.selection)) {
                this.dictation.cancel();
                this.redraw(panes::Area::Bottom, cx);
            }
            if style_connection != Some(this.connection) {
                style_connection = Some(this.connection);
                this.dictation.style_task = None;
            }
            if this.api.is_some() && this.dictation.style(this.connection).is_none() && this.dictation.style_task.is_none() {
                this.load_dictation_style(cx);
            }
        }).detach();
    }

    fn load_dictation_style(&mut self, cx: &mut Context<Self>) {
        let Some(api) = self.api.clone() else { return; };
        let (connection, writes) = (self.connection, self.dictation.style_writes);
        let job = self.runtime.spawn(async move { api.config().await });
        self.dictation.style_task = Some(cx.spawn(async move |this, cx| {
            let result = job.await;
            let _ = this.update(cx, |this, cx| {
                if this.connection != connection || this.dictation.style_writes != writes { return; }
                if let Ok(Ok(value)) = result {
                    if let Some(style) = STYLES.into_iter().find(|style| value.pointer("/campos/ditado_estilo/valor").and_then(Value::as_str) == Some(*style)) {
                        this.dictation.style = Some((connection, style));
                        cx.notify();
                    }
                }
            });
        }));
    }

    fn set_dictation_style(&mut self, style: &'static str, cx: &mut Context<Self>) {
        if self.dictation.recorder.is_some() || self.dictation.request.is_some() { return; }
        let Some(api) = self.api.clone() else { return; };
        let (connection, before) = (self.connection, self.dictation.style);
        self.dictation.style = Some((connection, style));
        self.dictation.style_writes += 1;
        self.dictation.error = None;
        let mine = self.dictation.style_writes;
        let job = self.runtime.spawn(async move {
            api.server_send(reqwest::Method::POST, &["config"], Some(json!({"ditado_estilo": style})), 8).await
        });
        cx.spawn(async move |this, cx| {
            let result = job.await.unwrap_or_else(|_| Err(Failure::local("invalid_response")));
            let _ = this.update(cx, |this, cx| {
                if this.connection != connection || this.dictation.style_writes != mine { return; }
                if let Err(error) = result {
                    this.dictation.style = before;
                    this.dictation.error = Some(Self::failure(&error));
                    cx.notify();
                }
            });
        }).detach();
        cx.notify();
    }

    pub(super) fn toggle_dictation(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.dictation.request.is_some() { return; }
        if self.dictation.recorder.is_some() {
            self.stop_dictation(window, cx);
            self.composer.update(cx, |input, cx| input.focus(window, cx));
            return;
        }
        if self.connection_dialog || self.settings.is_some() || window.has_active_dialog(cx) { return; }
        if self.selected_key().is_none() || !self.chat_online || !self.history_installed { return; }
        self.dictation.cancel();
        match Recorder::start() {
            Ok(recorder) => {
                self.dictation.owner = Some((self.connection, self.selection));
                self.dictation.recorder = Some(recorder);
                self.dictation.started = Some(Instant::now());
                let seq = self.dictation.seq;
                cx.spawn_in(window, async move |this, cx| {
                    loop {
                        cx.background_executor().timer(Duration::from_millis(100)).await;
                        let keep = this.update_in(cx, |this, window, cx| {
                            if this.dictation.seq != seq { return false; }
                            let Some(recorder) = &mut this.dictation.recorder else { return false; };
                            let failed = recorder.child.as_mut().is_some_and(|child| !matches!(child.try_wait(), Ok(None)));
                            if failed {
                                this.dictation.cancel();
                                window.push_notification(Notification::error(tr("dictation_recorder_error")), cx);
                                this.redraw(panes::Area::Bottom, cx);
                                return false;
                            }
                            this.dictation.level = recorder.level();
                            this.redraw(panes::Area::Bottom, cx);
                            if this.dictation.started.is_some_and(|start| start.elapsed() >= Duration::from_secs(180)) {
                                this.stop_dictation(window, cx);
                            }
                            true
                        });
                        if !matches!(keep, Ok(true)) { break; }
                    }
                }).detach();
            }
            Err(error) => window.push_notification(Notification::error(Self::dictation_failure(&error)), cx),
        }
        cx.notify();
    }

    fn stop_dictation(&mut self, _window: &mut Window, cx: &mut Context<Self>) {
        let Some(recorder) = self.dictation.recorder.take() else { return; };
        let (Some(api), Some(key)) = (self.api.clone(), self.selected_key()) else { self.dictation.cancel(); return; };
        let audio_cache = self.dictation.audio.clone();
        let style = self.dictation.style(self.connection);
        let (tx, connection, selection, seq) = (self.tx.clone(), self.connection, self.selection, self.dictation.seq);
        self.dictation.request = Some(self.runtime.spawn(async move {
            let audio = tokio::task::spawn_blocking(move || recorder.finish()).await;
            let result = match audio {
                Ok(Ok(bytes)) => {
                    *audio_cache.lock().unwrap() = bytes.clone();
                    api.transcribe(&key.name, bytes, style).await
                },
                Ok(Err(error)) => Err(error), Err(_) => Err(Failure::local("dictation_recorder_error")),
            };
            let _ = tx.send(Envelope { connection, selection: Some(selection), payload: Payload::Dictation(seq, result) }).await;
        }));
        cx.notify();
    }

    fn revise_dictation(&mut self, style: Option<&'static str>, window: &mut Window, cx: &mut Context<Self>) {
        if self.dictation.request.is_some() || self.dictation.recorder.is_some()
            || self.dictation.owner != Some((self.connection, self.selection)) { return; }
        if !self.dictation.draft_matches(&self.composer.read(cx).value()) {
            self.dictation.error = Some(tr("dictation_draft_changed"));
            cx.notify();
            return;
        }
        self.dictation.error = None;
        if let Some(value) = style.and_then(|style| self.dictation.versions.get(style)).cloned() {
            self.receive_dictation(self.dictation.seq, Ok(value), window, cx);
            return;
        }
        let (Some(api), Some(key)) = (self.api.clone(), self.selected_key()) else { return; };
        let raw = self.dictation.result.as_ref().and_then(|v| v.get("raw")).and_then(Value::as_str).unwrap_or("").to_owned();
        let audio = self.dictation.audio.lock().unwrap().clone();
        if (style.is_some() && raw.is_empty()) || (style.is_none() && audio.is_empty()) { return; }
        self.dictation.seq += 1;
        self.dictation.cleaning = style.is_some();
        let recording_style = self.dictation.style(self.connection);
        let (tx, connection, selection, seq) = (self.tx.clone(), self.connection, self.selection, self.dictation.seq);
        self.dictation.request = Some(self.runtime.spawn(async move {
            let result = if let Some(style) = style {
                api.server_send(reqwest::Method::POST, &["ditado", "relimpar"], Some(json!({"texto": raw, "estilo": style})), 180).await
                    .and_then(|mut value| {
                        let fields = value.as_object_mut().ok_or_else(|| Failure::local("invalid_response"))?;
                        fields.insert("raw".into(), json!(raw));
                        Ok(value)
                    })
            } else { api.transcribe(&key.name, audio, recording_style).await };
            let _ = tx.send(Envelope { connection, selection: Some(selection), payload: Payload::Dictation(seq, result) }).await;
        }));
        cx.notify();
    }

    pub(super) fn receive_dictation(&mut self, seq: u64, result: Result<Value, Failure>, window: &mut Window, cx: &mut Context<Self>) {
        if self.dictation.seq != seq || self.dictation.owner != Some((self.connection, self.selection)) { return; }
        self.dictation.request = None;
        self.dictation.started = None;
        self.dictation.level = 0.;
        self.dictation.cleaning = false;
        self.dictation.error = None;
        match result {
            Ok(value) => {
                let text = value.get("text").and_then(Value::as_str).unwrap_or("").trim();
                let raw = value.get("raw").and_then(Value::as_str).unwrap_or(text);
                let applied = value.get("estilo_aplicado").and_then(Value::as_str).unwrap_or("cru");
                if text.is_empty() {
                    self.dictation.error = Some(tr("dictation_empty_text"));
                } else if !self.dictation.draft_matches(&self.composer.read(cx).value()) {
                    self.dictation.error = Some(tr("dictation_draft_changed"));
                } else {
                    let previous = self.dictation.inserted.as_ref().map(|(_, range)| range.clone());
                    let inserted = self.composer.update(cx, |input, cx| {
                        let draft = input.value().to_string();
                        let range = previous.unwrap_or_else(|| input.selected_range());
                        let replacement = dictation_insert(&draft, range.clone(), text);
                        input.set_selected_range(range.clone(), cx);
                        input.replace(replacement.clone(), window, cx);
                        (input.value().to_string(), range.start..range.start + replacement.len())
                    });
                    self.dictation.inserted = Some(inserted);
                    *self.dictation.audio.lock().unwrap() = Vec::new();
                    if self.dictation.result.as_ref().and_then(|v| v.get("raw")) != value.get("raw") {
                        self.dictation.versions.clear();
                    }
                    self.dictation.versions.insert("cru".into(), json!({"text": raw, "raw": raw, "estilo_aplicado": "cru"}));
                    self.dictation.versions.insert(applied.to_owned(), value.clone());
                    // Consome a mudança programática antes do observador de @menção.
                    self.refresh_mention(cx);
                    self.mention.close();
                    if let Some(warning) = value.get("aviso").and_then(Value::as_str).filter(|s| !s.is_empty()) {
                        window.push_notification(Notification::warning(warning.to_owned()), cx);
                    }
                    self.dictation.result = Some(value);
                }
            }
            Err(error) => self.dictation.error = Some(Self::dictation_failure(&error)),
        }
        cx.notify();
    }

    pub(super) fn render_dictation(&self, readable: bool, cx: &mut Context<Self>) -> (Button, Option<AnyElement>) {
        let recording = self.dictation.recorder.is_some();
        let transcribing = self.dictation.request.is_some();
        let label = tr(if recording { "dictation_stop" } else if transcribing { "dictation_working" } else { "dictation_start" });
        let mic = if recording {
            Button::new("dictation-toggle").ghost().size_7().rounded_md()
                .child(div().size_3().rounded_sm().bg(theme::danger()))
        } else { chrome::icon_button("dictation-toggle", IconName::Mic, label.clone(), cx) };
        let mic = mic.accessibility_label(label.clone())
            .disabled(transcribing || (!recording && (!readable || !self.chat_online || !self.history_installed)))
            .loading(transcribing)
            .tooltip(format!("{label} · {}", tr("dictation_shortcut")))
            .on_click(cx.listener(|this, _, window, cx| this.toggle_dictation(window, cx)));
        let owner = self.dictation.owner == Some((self.connection, self.selection));
        let style = self.dictation.style(self.connection).unwrap_or("prosa");
        let entity = cx.entity().downgrade();
        let pill = chrome::pill_button("dictation-style", cx).label(style_label(style)).icon(IconName::ChevronDown)
            .accessibility_label(tr("dictation_style")).disabled(recording || transcribing || !readable)
            .dropdown_menu(move |menu, _, cx| {
                let _ = entity.update(cx, |this, cx| this.load_dictation_style(cx));
                STYLES.into_iter().fold(menu, |menu, next| {
                    let entity = entity.clone();
                    menu.item(PopupMenuItem::element(move |_, _| div().flex().flex_col().gap_1().max_w(px(320.))
                        .child(style_label(next)).child(div().text_xs().text_color(theme::muted()).whitespace_normal()
                            .child(tr(&format!("voice_style_{next}_hint")))))
                    .checked(next == style).on_click(move |_, _, cx| {
                        let _ = entity.update(cx, |this, cx| this.set_dictation_style(next, cx));
                    }))
                })
            });
        let controls = div().flex().flex_wrap().items_center().gap_2().child(pill)
            .when(owner && self.dictation.result.is_some() && (transcribing || self.dictation.text_in_field(&self.composer.read(cx).value())), |el| {
                let applied = self.dictation.result.as_ref().and_then(|v| v.get("estilo_aplicado")).and_then(Value::as_str).unwrap_or("cru");
                el.child(div().text_xs().text_color(theme::muted()).child(tr("dictation_versions")))
                    .children(["cru", "limpar", "prosa", "briefing"].into_iter().map(|version| {
                        Button::new(SharedString::from(format!("dictation-version-{version}"))).ghost().small()
                            .label(style_label(version)).selected(version == applied).disabled(recording || transcribing)
                            .on_click(cx.listener(move |this, _, window, cx| this.revise_dictation(Some(version), window, cx)))
                    }))
            })
            .when(owner && self.dictation.result.is_none() && !self.dictation.audio.lock().unwrap().is_empty(), |el| el.child(
                Button::new("dictation-retranscribe").ghost().small().label(tr("dictation_again"))
                    .disabled(recording || transcribing)
                    .on_click(cx.listener(|this, _, window, cx| this.revise_dictation(None, window, cx)))));
        let status = (recording || transcribing).then(|| {
            let label = tr(if recording { "dictation_active" } else if self.dictation.cleaning { "dictation_cleaning" } else { "dictation_working" });
            let seconds = self.dictation.started.map(|start| start.elapsed().as_secs()).unwrap_or(0);
            div().flex().items_center().gap_2().text_sm().text_color(theme::muted())
                .child(div().id("dictation-status").role(Role::Status).aria_label(label.clone()).child(label))
                .when(recording, |el| el
                    .child(div().font_family(theme::MONO).child(format!("{}:{:02}", seconds / 60, seconds % 60)))
                    .child(div().id("dictation-level").role(Role::Meter).aria_label(tr("dictation_level"))
                        .aria_min_numeric_value(0.).aria_max_numeric_value(100.).aria_numeric_value((self.dictation.level * 100.) as f64)
                        .w_16().h_1().rounded_full().bg(theme::raised())
                        .child(div().h_full().w(relative(self.dictation.level)).rounded_full().bg(theme::accent()))))
                .child(div().flex_1())
                .child(Button::new("dictation-cancel").ghost().small().label(tr("dictation_cancel"))
                    .on_click(cx.listener(|this, _, window, cx| {
                        this.dictation.cancel();
                        this.composer.update(cx, |input, cx| input.focus(window, cx));
                        cx.notify();
                    })))
                .into_any_element()
        });
        let strip = readable.then(|| div().flex().flex_col().gap_2().child(controls).children(status)
            .children(self.dictation.error.clone().map(|error| div().id("dictation-error").role(Role::Alert)
                .text_sm().text_color(theme::danger()).child(error))).into_any_element());
        (mic, strip)
    }

    fn dictation_failure(error: &Failure) -> String {
        match error.status {
            Some(503) => tr("dictation_unconfigured"),
            Some(401 | 403 | 429) => Self::failure(error),
            Some(_) => error.detail.clone(),
            None if error.uncertain => tr("connection_failed"),
            None => tr(&error.detail),
        }
    }
}

fn style_label(style: &str) -> String {
    tr(match style { "limpar" => "voice_style_limpar", "briefing" => "voice_style_briefing", "cru" => "dictation_style_raw", _ => "voice_style_prosa" })
}

fn dictation_insert(value: &str, range: std::ops::Range<usize>, text: &str) -> String {
    let leading = value[..range.start].chars().next_back().is_some_and(|c| !c.is_whitespace());
    let trailing = value[range.end..].chars().next().is_some_and(|c| !c.is_whitespace());
    format!("{}{text}{}", if leading { " " } else { "" }, if trailing { " " } else { "" })
}

#[cfg(test)]
mod tests {
    use super::{dictation_insert, wav, wav_pcm, Dictation, Recorder};
    #[test]
    fn versions_preserve_surroundings_and_cancel_releases_audio_without_changing_style() {
        let mut state = Dictation::default();
        assert_eq!(state.style(1), None);
        state.style = Some((1, "limpar"));
        assert_eq!(state.style(2), None);
        state.owner = Some((1, 2));
        let mut draft = "antes ação depois".to_owned();
        state.inserted = Some((draft.clone(), 6..12));
        assert!(!state.text_in_field(""));
        assert!(state.text_in_field(&draft));
        assert!(state.text_in_field("antes ação depois com acréscimo"));
        assert!(!state.text_in_field("antes edição depois"));
        assert!(state.draft_matches(&draft));
        assert!(!state.draft_matches("antes edição depois"));
        let range = state.inserted.as_ref().unwrap().1.clone();
        let replacement = dictation_insert(&draft, range.clone(), "reorganização");
        draft.replace_range(range, &replacement);
        assert_eq!(draft, "antes reorganização depois");
        state.versions.insert("cru".into(), serde_json::json!({"text": "ação"}));
        *state.audio.lock().unwrap() = vec![1, 2];
        let in_flight_audio = state.audio.clone();
        let seq = state.seq;
        state.cancel();
        in_flight_audio.lock().unwrap().push(3);
        assert!(state.audio.lock().unwrap().is_empty());
        assert!(state.versions.is_empty() && state.inserted.is_none() && state.owner.is_none());
        assert_ne!(state.seq, seq);
        assert_eq!(state.style(1), Some("limpar"));
    }
    #[test]
    fn dictation_preserves_draft_around_cursor_or_selection_and_cancels_old_result() {
        for (value, range, expected) in [
            ("depois", 0..0, "fala depois"), ("antes", 5..5, "antes fala"),
            ("antes depois", 6..6, "antes fala depois"), ("trocar isto", 0..6, "fala isto"),
            ("ação fim", 0..6, "fala fim"), ("tudo", 0..4, "fala"),
            ("", 0..0, "fala"), ("antes\n", 6..6, "antes\nfala"),
        ] {
            let mut result = value.to_owned();
            result.replace_range(range.clone(), &dictation_insert(value, range, "fala"));
            assert_eq!(result, expected);
        }
        let mut state = Dictation::default();
        state.owner = Some((1, 2));
        let old = state.seq;
        state.cancel();
        assert_ne!(state.seq, old);
        assert!(state.owner.is_none());
        let mut pcm = vec![0; 3203];
        pcm[3201] = 128;
        let recorder = Recorder { child: None, reader: None, pcm: std::sync::Arc::new(std::sync::Mutex::new(pcm)), playback: None };
        assert_eq!(recorder.level(), 1.);
    }
    #[test]
    fn wav_roundtrip_rejects_truncation_and_wrong_format() {
        let pcm = [0, 0, 0xff, 0x7f, 0, 0x80];
        let mut bytes = wav(&pcm);
        assert_eq!(wav_pcm(&bytes), Some(pcm.as_slice()));
        assert!(wav_pcm(&bytes[..bytes.len() - 1]).is_none());
        bytes[22] = 2;
        assert!(wav_pcm(&bytes).is_none());
    }
}
