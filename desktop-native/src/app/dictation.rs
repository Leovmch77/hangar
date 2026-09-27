use super::*;
use std::{io::Read, process::{Child, Command, Stdio}, sync::Mutex, thread};

const STYLES: [&str; 3] = ["limpar", "prosa", "briefing"];
const PCM_LIMIT: usize = 16_000 * 2 * 180;
const SILENCE: Duration = Duration::from_secs(2);
const COUNTDOWN: Duration = Duration::from_secs(3);

#[derive(Default)]
struct Vad {
    peak: f32,
    last: Option<Instant>,
    quiet_since: Option<Instant>,
}

impl Vad {
    fn step(&mut self, rms: f32, now: Instant) -> bool {
        let elapsed = self.last.map(|last| now.duration_since(last).as_secs_f32() * 1000.).unwrap_or(0.);
        self.last = Some(now);
        let decayed = self.peak * 0.98_f32.powf(elapsed / 55.);
        self.peak = if rms > decayed { decayed + (rms - decayed) * 0.08 } else { decayed };
        if self.peak <= 0.01 || rms >= self.peak * 0.25 {
            self.quiet_since = None;
            return false;
        }
        let since = *self.quiet_since.get_or_insert(now);
        now.duration_since(since) >= SILENCE
    }
}

struct Recorder {
    child: Option<Child>,
    reader: Option<thread::JoinHandle<std::io::Result<()>>>,
    pcm: Arc<Mutex<Vec<u8>>>,
    playback: Option<Instant>,
    sampled: usize,
    last_signal: (f32, f32),
    last_pcm_at: Option<Instant>,
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
        let mut recorder = Self { child: None, reader: None, pcm: Default::default(), playback: None,
            sampled: 0, last_signal: (0., 0.), last_pcm_at: None };
        if let Some(path) = std::env::var_os("HANGAR_NATIVE_DICTATION_WAV") {
            let mut bytes = Vec::new();
            std::fs::File::open(path).and_then(|file| file.take((PCM_LIMIT + 4097) as u64).read_to_end(&mut bytes))
                .map_err(|_| Failure::local("dictation_wav_error"))?;
            *recorder.pcm.lock().unwrap() = wav_pcm(&bytes).ok_or_else(|| Failure::local("dictation_wav_error"))?.to_vec();
            recorder.playback = Some(Instant::now());
            return Ok(recorder);
        }
        if !cfg!(target_os = "linux") { return Err(Failure::local("dictation_platform")); }
        let mut command = Command::new("pw-record");
        if let Some(target) = microphone()? { command.args(["--target", &target]); }
        let mut child = command.args(["--raw", "--format", "s16", "--rate", "16000", "--channels", "1", "-"])
            .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn()
            .map_err(|error| Failure::local(if error.kind() == std::io::ErrorKind::NotFound {
                "dictation_recorder_missing" } else { "dictation_recorder_error" }))?;
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

    fn signal(&mut self) -> (f32, f32) {
        let bytes = self.pcm.lock().unwrap();
        let end = self.playback.map(|start| (start.elapsed().as_millis() as usize * 32).min(bytes.len())).unwrap_or(bytes.len()) & !1;
        let start = self.sampled.min(end);
        self.sampled = end;
        // `pw-record` entrega blocos; um intervalo sem bloco ainda é áudio recente, mas uma captura travada não é fala eterna.
        if start == end {
            return if self.last_pcm_at.is_some_and(|at| at.elapsed() < Duration::from_millis(4096 / 32 + 55)) {
                self.last_signal
            } else { (0., 0.) };
        }
        let mut peak: f32 = 0.;
        let mut sum = 0.;
        let mut count = 0;
        for sample in bytes[start..end].chunks_exact(2) {
            let value = i16::from_le_bytes([sample[0], sample[1]]) as f32 / 32768.;
            peak = peak.max(value.abs());
            sum += value * value;
            count += 1;
        }
        self.last_signal = (peak, if count == 0 { 0. } else { (sum / count as f32).sqrt() });
        self.last_pcm_at = Some(Instant::now());
        self.last_signal
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

/// Sem fonte padrão o `pw-record` sai na hora com "no target node available"; aí grava do microfone que o PipeWire
/// mais prioriza. Sem `pw-dump` legível segue como antes e deixa o `pw-record` decidir.
fn microphone() -> Result<Option<String>, Failure> {
    let Ok(output) = Command::new("pw-dump").stdin(Stdio::null()).stderr(Stdio::null()).output() else { return Ok(None); };
    let Ok(Value::Array(objects)) = serde_json::from_slice(&output.stdout) else { return Ok(None); };
    pick_microphone(&objects).ok_or_else(|| Failure::local("dictation_no_microphone"))
}

/// `Some(None)`: há fonte padrão. `Some(Some(nome))`: sem padrão, o microfone de maior prioridade. `None`: nenhum.
fn pick_microphone(objects: &[Value]) -> Option<Option<String>> {
    let has_default = objects.iter()
        .filter(|object| object.pointer("/props/metadata.name").and_then(Value::as_str) == Some("default"))
        .flat_map(|object| object["metadata"].as_array().into_iter().flatten())
        .any(|entry| entry["key"] == "default.audio.source");
    if has_default { return Some(None); }
    objects.iter().filter_map(|object| object.pointer("/info/props"))
        .filter(|props| props["media.class"].as_str().is_some_and(|class| class.starts_with("Audio/Source")))
        .max_by_key(|props| props["priority.session"].as_i64().unwrap_or(0))
        .and_then(|props| props["node.name"].as_str()).map(|name| Some(name.to_owned()))
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
    owner: Option<(u64, String)>,
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
    hands_free: bool,
    auto_send: bool,
    timed_out: bool,
    vad: Vad,
    countdown: Option<Instant>,
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
        self.hands_free = false;
        self.auto_send = false;
        self.timed_out = false;
        self.vad = Vad::default();
        self.countdown = None;
    }
}

impl Drop for Dictation { fn drop(&mut self) { self.cancel(); } }

impl Hangar {
    pub(super) fn watch_dictation(_window: &Window, cx: &mut Context<Self>) {
        let mut style_connection = None;
        cx.observe_self(move |this, cx| {
            if this.dictation.owner.is_some() && this.dictation.owner != this.session_owner() {
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
        let owner = cx.entity().downgrade();
        cx.intercept_keystrokes(move |_, _, cx| {
            let _ = owner.update(cx, |this, cx| this.cancel_dictation_countdown(cx));
        }).detach();
    }

    fn cancel_dictation_countdown(&mut self, cx: &mut Context<Self>) {
        if self.dictation.countdown.take().is_some() {
            self.redraw(panes::Area::Bottom, cx);
            cx.notify();
        }
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
        self.cancel_dictation_countdown(cx);
        if self.dictation.request.is_some() { return; }
        if self.dictation.recorder.is_some() {
            self.stop_dictation(false, false, cx);
            self.composer.update(cx, |input, cx| input.focus(window, cx));
            return;
        }
        if self.connection_dialog || self.settings.is_some() || window.has_active_dialog(cx) { return; }
        if self.selected_key().is_none() || !self.chat_online || !self.history_installed { return; }
        self.dictation.cancel();
        match Recorder::start() {
            Ok(recorder) => {
                self.dictation.owner = self.session_owner();
                self.dictation.hands_free = appearance::get().hands_free;
                self.dictation.recorder = Some(recorder);
                self.dictation.started = Some(Instant::now());
                let seq = self.dictation.seq;
                cx.spawn_in(window, async move |this, cx| {
                    loop {
                        cx.background_executor().timer(Duration::from_millis(55)).await;
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
                            let (level, rms) = recorder.signal();
                            this.dictation.level = level;
                            if this.dictation.hands_free && this.dictation.vad.step(rms, Instant::now()) {
                                this.stop_dictation(true, false, cx);
                                this.redraw(panes::Area::Bottom, cx);
                                return false;
                            }
                            this.redraw(panes::Area::Bottom, cx);
                            if this.dictation.started.is_some_and(|start| start.elapsed() >= Duration::from_secs(180)) {
                                this.stop_dictation(false, this.dictation.hands_free, cx);
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

    fn stop_dictation(&mut self, silence: bool, timed_out: bool, cx: &mut Context<Self>) {
        let Some(recorder) = self.dictation.recorder.take() else { return; };
        let (Some(api), Some(key)) = (self.api.clone(), self.selected_key()) else { self.dictation.cancel(); return; };
        self.dictation.auto_send = silence && self.dictation.hands_free;
        self.dictation.timed_out = timed_out;
        let audio_cache = self.dictation.audio.clone();
        let style = self.dictation.style(self.connection);
        let (tx, connection, seq) = (self.tx.clone(), self.connection, self.dictation.seq);
        self.dictation.request = Some(self.runtime.spawn(async move {
            let audio = tokio::task::spawn_blocking(move || recorder.finish()).await;
            let result = match audio {
                Ok(Ok(bytes)) => {
                    *audio_cache.lock().unwrap() = bytes.clone();
                    api.transcribe(&key.name, bytes, style).await
                },
                Ok(Err(error)) => Err(error), Err(_) => Err(Failure::local("dictation_recorder_error")),
            };
            let _ = tx.send(Envelope { connection, selection: None, payload: Payload::Dictation(seq, result) }).await;
        }));
        cx.notify();
    }

    fn start_dictation_countdown(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let deadline = Instant::now() + COUNTDOWN;
        let seq = self.dictation.seq;
        self.dictation.countdown = Some(deadline);
        cx.spawn_in(window, async move |this, cx| {
            loop {
                cx.background_executor().timer(Duration::from_millis(250)).await;
                let keep = this.update_in(cx, |this, window, cx| {
                    if this.dictation.seq != seq || this.dictation.countdown != Some(deadline)
                        || this.dictation.owner.is_none() || this.dictation.owner != this.session_owner() { return false; }
                    if Instant::now() < deadline {
                        this.redraw(panes::Area::Bottom, cx);
                        cx.notify();
                        return true;
                    }
                    this.dictation.countdown = None;
                    let key = this.selected_key();
                    if !this.can_send() || key.as_ref().is_none_or(|key| this.delivery.pending(key)
                        || this.uploading.contains_key(key) || this.attachments.get(key).is_some_and(|files| !files.is_empty())) {
                        this.dictation.error = Some(tr("dictation_auto_send_failed"));
                    } else {
                        this.submit(false, false, window, cx);
                        if key.as_ref().is_some_and(|key| !this.delivery.pending(key)) {
                            this.dictation.error = Some(tr("dictation_auto_send_failed"));
                        }
                    }
                    this.redraw(panes::Area::Bottom, cx);
                    cx.notify();
                    false
                });
                if !matches!(keep, Ok(true)) { break; }
            }
        }).detach();
        self.redraw(panes::Area::Bottom, cx);
        cx.notify();
    }

    fn revise_dictation(&mut self, style: Option<&'static str>, window: &mut Window, cx: &mut Context<Self>) {
        if self.dictation.request.is_some() || self.dictation.recorder.is_some()
            || self.dictation.owner.is_none() || self.dictation.owner != self.session_owner() { return; }
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
        let (tx, connection, seq) = (self.tx.clone(), self.connection, self.dictation.seq);
        self.dictation.request = Some(self.runtime.spawn(async move {
            let result = if let Some(style) = style {
                api.server_send(reqwest::Method::POST, &["ditado", "relimpar"], Some(json!({"texto": raw, "estilo": style})), 180).await
                    .and_then(|mut value| {
                        let fields = value.as_object_mut().ok_or_else(|| Failure::local("invalid_response"))?;
                        fields.insert("raw".into(), json!(raw));
                        Ok(value)
                    })
            } else { api.transcribe(&key.name, audio, recording_style).await };
            let _ = tx.send(Envelope { connection, selection: None, payload: Payload::Dictation(seq, result) }).await;
        }));
        cx.notify();
    }

    pub(super) fn receive_dictation(&mut self, seq: u64, result: Result<Value, Failure>, window: &mut Window, cx: &mut Context<Self>) {
        if self.dictation.seq != seq || self.dictation.owner.is_none() || self.dictation.owner != self.session_owner() { return; }
        let auto_send = std::mem::take(&mut self.dictation.auto_send);
        let timed_out = std::mem::take(&mut self.dictation.timed_out);
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
                    let draft_still_empty = self.composer.read(cx).value().trim().is_empty()
                        && self.selected_key().is_some_and(|key| self.attachments.get(&key).is_none_or(Vec::is_empty));
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
                    let warning = value.get("aviso").and_then(Value::as_str).is_some_and(|s| !s.is_empty());
                    self.dictation.result = Some(value);
                    if timed_out && !warning { self.dictation.error = Some(tr("dictation_silence_timeout")); }
                    if auto_send && draft_still_empty && !warning { self.start_dictation_countdown(window, cx); }
                }
            }
            Err(error) => self.dictation.error = Some(Self::dictation_failure(&error)),
        }
        cx.notify();
    }

    /// O microfone, a pílula do estilo (ao lado dele, como no web) e a faixa de estado do ditado, só quando há o que mostrar.
    pub(super) fn render_dictation(&self, readable: bool, cx: &mut Context<Self>) -> (Button, Option<AnyElement>, Option<AnyElement>) {
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
        let owner = self.dictation.owner.is_some() && self.dictation.owner == self.session_owner();
        let style = self.dictation.style(self.connection).unwrap_or("prosa");
        let entity = cx.entity().downgrade();
        // Gravando, some: trocar no meio não muda nada (o backend lê o estilo no fim) e o espaço é do botão de parar.
        let pill = (!recording).then(|| chrome::pill_button("dictation-style", cx).pl(px(10.)).gap(px(6.))
            .tooltip(tr("dictation_style")).accessibility_label(format!("{}: {}", tr("dictation_style"), style_label(style)))
            .disabled(transcribing || !readable)
            .child(div().text_xs().text_color(theme::muted()).child(style_label(style)))
            .child(chrome::small_icon(IconName::ChevronDown, 12., theme::faint()))
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
            }).into_any_element());
        let versions = owner && self.dictation.result.is_some() && (transcribing || self.dictation.text_in_field(&self.composer.read(cx).value()));
        let again = owner && self.dictation.result.is_none() && !self.dictation.audio.lock().unwrap().is_empty();
        let controls = (versions || again).then(|| div().flex().flex_wrap().items_center().gap_2()
            .when(versions, |el| {
                let applied = self.dictation.result.as_ref().and_then(|v| v.get("estilo_aplicado")).and_then(Value::as_str).unwrap_or("cru");
                el.child(div().text_xs().text_color(theme::muted()).child(tr("dictation_versions")))
                    .children(["cru", "limpar", "prosa", "briefing"].into_iter().map(|version| {
                        Button::new(SharedString::from(format!("dictation-version-{version}"))).ghost().small()
                            .label(style_label(version)).selected(version == applied).disabled(recording || transcribing)
                            .on_click(cx.listener(move |this, _, window, cx| this.revise_dictation(Some(version), window, cx)))
                    }))
            })
            .when(again, |el| el.child(
                Button::new("dictation-retranscribe").ghost().small().label(tr("dictation_again"))
                    .disabled(recording || transcribing)
                    .on_click(cx.listener(|this, _, window, cx| this.revise_dictation(None, window, cx))))));
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
        let countdown = self.dictation.countdown.map(|deadline| {
            let seconds = ((deadline.saturating_duration_since(Instant::now()).as_millis() + 999) / 1000).clamp(1, 3);
            let label = tr("dictation_countdown").replace("{seconds}", &seconds.to_string());
            let owner = cx.entity().downgrade();
            div().flex().items_center().gap_2()
                .child(div().id("dictation-countdown").role(Role::Status).aria_label(label.clone())
                    .text_sm().text_color(theme::accent_text()).child(label))
                .child(Button::new("dictation-countdown-cancel").ghost().small().label(tr("dictation_countdown_cancel"))
                    .on_click(cx.listener(|this, _, _, cx| this.cancel_dictation_countdown(cx))))
                .child(canvas(|_, _, _| (), move |_, _, window, _| {
                    window.on_mouse_event::<MouseDownEvent>(move |_, phase, _, cx| {
                        if phase == DispatchPhase::Capture {
                            let _ = owner.update(cx, |this, cx| this.cancel_dictation_countdown(cx));
                        }
                    });
                }).w_0().h_0())
                .into_any_element()
        });
        let error = self.dictation.error.clone().map(|error| div().id("dictation-error").role(Role::Alert)
            .text_sm().text_color(theme::danger()).child(error));
        let busy = controls.is_some() || status.is_some() || countdown.is_some() || error.is_some();
        let strip = (readable && busy).then(|| div().flex().flex_col().gap_2().children(controls).children(status).children(countdown)
            .children(error).into_any_element());
        (mic, pill.filter(|_| readable), strip)
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
    use super::{dictation_insert, pick_microphone, wav, wav_pcm, Dictation, Recorder, Vad};
    use std::time::{Duration, Instant};
    #[test]
    fn microphone_uses_default_or_highest_priority_source() {
        use serde_json::json;
        let source = |name: &str, class: &str, priority: i64| json!({"type": "PipeWire:Interface:Node",
            "info": {"props": {"media.class": class, "node.name": name, "priority.session": priority}}});
        let default = |key: &str| json!({"type": "PipeWire:Interface:Metadata", "props": {"metadata.name": "default"},
            "metadata": [{"subject": 0, "key": key, "value": {"name": "x"}}]});
        let nodes = vec![source("sink", "Audio/Sink", 3000), source("low", "Audio/Source", 1000),
            source("mic", "Audio/Source", 2009), default("default.audio.sink")];
        assert_eq!(pick_microphone(&nodes), Some(Some("mic".into())));
        let mut with_default = nodes.clone();
        with_default.push(default("default.audio.source"));
        assert_eq!(pick_microphone(&with_default), Some(None));
        assert_eq!(pick_microphone(&[source("sink", "Audio/Sink", 1)]), None);
    }
    #[test]
    fn hands_free_waits_for_speech_and_two_seconds_of_silence() {
        let base = Instant::now();
        let mut vad = Vad::default();
        for tick in 0..40 { assert!(!vad.step(0., base + Duration::from_millis(tick * 55))); }
        for tick in 40..70 { assert!(!vad.step(0.3, base + Duration::from_millis(tick * 55))); }
        for tick in 70..107 { assert!(!vad.step(0., base + Duration::from_millis(tick * 55))); }
        assert!(vad.step(0., base + Duration::from_millis(107 * 55)));
    }
    #[test]
    fn versions_preserve_surroundings_and_cancel_releases_audio_without_changing_style() {
        let mut state = Dictation::default();
        assert_eq!(state.style(1), None);
        state.style = Some((1, "limpar"));
        assert_eq!(state.style(2), None);
        state.owner = Some((1, "s".into()));
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
        state.owner = Some((1, "s".into()));
        let old = state.seq;
        state.cancel();
        assert_ne!(state.seq, old);
        assert!(state.owner.is_none());
        let mut pcm = vec![0; 3203];
        pcm[3201] = 128;
        let mut recorder = Recorder { child: None, reader: None, pcm: std::sync::Arc::new(std::sync::Mutex::new(pcm)),
            playback: None, sampled: 0, last_signal: (0., 0.), last_pcm_at: None };
        assert_eq!(recorder.signal().0, 1.);
        recorder.last_pcm_at = Some(Instant::now() - Duration::from_millis(200));
        assert_eq!(recorder.signal(), (0., 0.));
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
