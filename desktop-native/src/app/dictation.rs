use super::*;
use std::{io::Read, process::{Child, Command, Stdio}, sync::Mutex, thread};

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
}

impl Dictation {
    pub(super) fn result(&self) -> Option<&Value> { self.result.as_ref() }

    fn cancel(&mut self) {
        self.seq += 1;
        self.owner = None;
        self.recorder = None;
        if let Some(task) = self.request.take() { task.abort(); }
        self.started = None;
        self.level = 0.;
        self.result = None;
    }
}

impl Drop for Dictation { fn drop(&mut self) { self.cancel(); } }

impl Hangar {
    pub(super) fn watch_dictation(_window: &Window, cx: &mut Context<Self>) {
        cx.observe_self(move |this, cx| {
            if this.dictation.owner.is_some_and(|owner| owner != (this.connection, this.selection)) {
                this.dictation.cancel();
                this.redraw(panes::Area::Bottom, cx);
            }
        }).detach();
    }

    pub(super) fn toggle_dictation(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.dictation.request.is_some() { return; }
        if self.dictation.recorder.is_some() {
            self.stop_dictation(window, cx);
            self.composer.update(cx, |input, cx| input.focus(window, cx));
            return;
        }
        if self.connection_dialog || self.settings.is_some() || self.new_chat.is_some() || window.has_active_dialog(cx) { return; }
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
        let (tx, connection, selection, seq) = (self.tx.clone(), self.connection, self.selection, self.dictation.seq);
        self.dictation.request = Some(self.runtime.spawn(async move {
            let audio = tokio::task::spawn_blocking(move || recorder.finish()).await;
            let result = match audio {
                Ok(Ok(bytes)) => api.transcribe(&key.name, bytes, None).await,
                Ok(Err(error)) => Err(error), Err(_) => Err(Failure::local("dictation_recorder_error")),
            };
            let _ = tx.send(Envelope { connection, selection: Some(selection), payload: Payload::Dictation(seq, result) }).await;
        }));
        cx.notify();
    }

    pub(super) fn receive_dictation(&mut self, seq: u64, result: Result<Value, Failure>, window: &mut Window, cx: &mut Context<Self>) {
        if self.dictation.seq != seq || self.dictation.owner != Some((self.connection, self.selection)) { return; }
        self.dictation.request = None;
        self.dictation.started = None;
        self.dictation.level = 0.;
        match result {
            Ok(value) => {
                self.dictation.result = Some(value);
                let value = self.dictation.result().unwrap();
                let text = value.get("text").and_then(Value::as_str).unwrap_or("").trim().to_owned();
                let warning = value.get("aviso").and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_owned);
                if text.is_empty() {
                    self.dictation.result = None;
                    window.push_notification(Notification::error(tr("dictation_empty_text")), cx);
                } else {
                    self.composer.update(cx, |input, cx| {
                        let value = input.value().to_string();
                        let range = input.selected_range();
                        input.replace(dictation_insert(&value, range, &text), window, cx);
                    });
                    // Consome a mudança programática antes do observador de @menção.
                    self.refresh_mention(cx);
                    self.mention.close();
                    if let Some(warning) = warning { window.push_notification(Notification::warning(warning), cx); }
                }
            }
            Err(error) => window.push_notification(Notification::error(Self::dictation_failure(&error)), cx),
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
        let strip = (recording || transcribing).then(|| {
            let label = tr(if recording { "dictation_active" } else { "dictation_working" });
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

fn dictation_insert(value: &str, range: std::ops::Range<usize>, text: &str) -> String {
    let leading = value[..range.start].chars().next_back().is_some_and(|c| !c.is_whitespace());
    let trailing = value[range.end..].chars().next().is_some_and(|c| !c.is_whitespace());
    format!("{}{text}{}", if leading { " " } else { "" }, if trailing { " " } else { "" })
}

#[cfg(test)]
mod tests {
    use super::{dictation_insert, wav, wav_pcm, Dictation, Recorder};
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
