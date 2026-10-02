//! Tocar áudio dentro do app: o `symphonia` decodifica (mp3, wav, ogg, flac, m4a) e o `cpal`, o mesmo do ditado, toca.
//! Vídeo não passa por aqui: abre no player do sistema.
use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

// ponytail: decodifica o arquivo inteiro na memória (10 min de estéreo a 48 kHz em i16 = ~110 MB); áudio maior pede
// decodificação em fluxo, com o decodificador alimentando a saída por um canal.
const MAX_SECONDS: u64 = 10 * 60;

/// Amostras intercaladas, em i16 para caber o dobro na mesma memória.
pub struct Clip { samples: Vec<i16>, channels: usize, rate: u32 }

impl Clip {
    fn frames(&self) -> usize { self.samples.len() / self.channels }
    pub fn duration(&self) -> f64 { self.frames() as f64 / self.rate as f64 }
}

pub fn decode(bytes: Vec<u8>, extension: Option<&str>) -> Result<Clip, String> {
    use symphonia::core::{audio::SampleBuffer, codecs::DecoderOptions, errors::Error, formats::FormatOptions,
        io::MediaSourceStream, meta::MetadataOptions, probe::Hint};
    let stream = MediaSourceStream::new(Box::new(std::io::Cursor::new(bytes)), Default::default());
    let mut hint = Hint::new();
    if let Some(extension) = extension { hint.with_extension(extension); }
    let probed = symphonia::default::get_probe()
        .format(&hint, stream, &FormatOptions::default(), &MetadataOptions::default()).map_err(|e| e.to_string())?;
    let mut format = probed.format;
    let track = format.default_track().ok_or_else(|| "sem faixa de áudio".to_owned())?;
    let track_id = track.id;
    let mut decoder = symphonia::default::get_codecs().make(&track.codec_params, &DecoderOptions::default())
        .map_err(|e| e.to_string())?;
    let (mut samples, mut channels, mut rate) = (Vec::new(), 0usize, 0u32);
    loop {
        let packet = match format.next_packet() {
            Ok(packet) => packet,
            Err(Error::IoError(e)) if e.kind() == std::io::ErrorKind::UnexpectedEof => break,
            Err(Error::ResetRequired) => break,
            Err(e) => return Err(e.to_string()),
        };
        if packet.track_id() != track_id { continue; }
        let decoded = match decoder.decode(&packet) {
            Ok(decoded) => decoded,
            // Pacote estragado no meio: pula e segue, como os players fazem.
            Err(Error::DecodeError(_)) => continue,
            Err(e) => return Err(e.to_string()),
        };
        let spec = *decoded.spec();
        (channels, rate) = (spec.channels.count(), spec.rate);
        let mut buffer = SampleBuffer::<i16>::new(decoded.capacity() as u64, spec);
        buffer.copy_interleaved_ref(decoded);
        samples.extend_from_slice(buffer.samples());
        if rate > 0 && channels > 0 && samples.len() as u64 > MAX_SECONDS * rate as u64 * channels as u64 {
            return Err("áudio longo demais para tocar aqui".to_owned());
        }
    }
    if channels == 0 || rate == 0 || samples.is_empty() { return Err("áudio vazio".to_owned()); }
    Ok(Clip { samples, channels, rate })
}

/// Um áudio tocando ou pausado. A posição é contada em quadros do arquivo; a saída converte a taxa ao vivo.
pub struct Playback {
    stream: cpal::Stream,
    clip: Arc<Clip>,
    position: Arc<AtomicU64>,
    // A pausa vale no `fill`: há backend em que `stream.pause()` falha ou não para a saída.
    paused: Arc<AtomicBool>,
    failed: Arc<Mutex<Option<String>>>,
}

impl Playback {
    pub fn start(clip: Arc<Clip>) -> Result<Self, String> {
        use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
        let device = cpal::default_host().default_output_device().ok_or_else(|| "sem saída de som".to_owned())?;
        let config = device.default_output_config().map_err(|e| e.to_string())?;
        let position = Arc::new(AtomicU64::new(0f64.to_bits()));
        let paused = Arc::new(AtomicBool::new(false));
        let failed = Arc::new(Mutex::new(None));
        let (out_channels, out_rate) = (config.channels().max(1) as usize, config.sample_rate());
        macro_rules! output {
            ($t:ty) => {{
                let (clip, position, paused, failed) = (clip.clone(), position.clone(), paused.clone(), failed.clone());
                device.build_output_stream::<$t, _, _>(config.clone().into(),
                    move |data: &mut [$t], _| fill(data, &clip, &position, &paused, out_channels, out_rate),
                    move |error| {
                        eprintln!("audio stream: {error}");
                        *failed.lock().unwrap() = Some(error.to_string());
                    }, None)
            }};
        }
        let stream = match config.sample_format() {
            cpal::SampleFormat::F32 => output!(f32),
            cpal::SampleFormat::I16 => output!(i16),
            cpal::SampleFormat::I32 => output!(i32),
            cpal::SampleFormat::U16 => output!(u16),
            cpal::SampleFormat::U8 => output!(u8),
            cpal::SampleFormat::I8 => output!(i8),
            cpal::SampleFormat::F64 => output!(f64),
            other => return Err(format!("formato de saída {other:?}")),
        }.map_err(|e| e.to_string())?;
        stream.play().map_err(|e| e.to_string())?;
        Ok(Self { stream, clip, position, paused, failed })
    }

    /// Terminado (mesmo antes do `settle` marcar a pausa): recomeça do início. Senão, alterna.
    pub fn toggle(&mut self) {
        let paused = if self.finished() { self.seek(0.); false } else { !self.paused() };
        self.set_paused(paused);
    }

    fn set_paused(&self, paused: bool) {
        use cpal::traits::StreamTrait;
        self.paused.store(paused, Ordering::Relaxed);
        if let Err(error) = if paused { self.stream.pause() } else { self.stream.play() } {
            eprintln!("audio stream: {error}");
        }
    }

    /// Erro do fluxo (saída de som caiu) volta aqui; no fim, pausa a saída e o próximo play recomeça.
    pub fn settle(&mut self) -> Result<(), String> {
        if let Some(error) = self.failed.lock().unwrap().take() { return Err(error); }
        if self.finished() && !self.paused() { self.set_paused(true); }
        Ok(())
    }

    pub fn paused(&self) -> bool { self.paused.load(Ordering::Relaxed) }
    pub fn duration(&self) -> f64 { self.clip.duration() }
    pub fn elapsed(&self) -> f64 { f64::from_bits(self.position.load(Ordering::Relaxed)) / self.clip.rate as f64 }
    pub fn finished(&self) -> bool { self.elapsed() >= self.duration() }

    pub fn seek(&mut self, fraction: f64) {
        let frame = fraction.clamp(0., 1.) * self.clip.frames() as f64;
        self.position.store(frame.to_bits(), Ordering::Relaxed);
    }
}

fn fill<T: cpal::SizedSample + cpal::FromSample<f32>>(data: &mut [T], clip: &Clip, position: &AtomicU64, paused: &AtomicBool,
    out_channels: usize, out_rate: u32) {
    if paused.load(Ordering::Relaxed) {
        data.fill(T::from_sample(0f32));
        return;
    }
    let (frames, step) = (clip.frames(), clip.rate as f64 / out_rate as f64);
    let mut at = f64::from_bits(position.load(Ordering::Relaxed));
    for frame in data.chunks_mut(out_channels) {
        let index = at as usize;
        let mix = at - index as f64;
        for (channel, sample) in frame.iter_mut().enumerate() {
            let source = channel.min(clip.channels - 1);
            let value = |i: usize| clip.samples.get(i * clip.channels + source).map_or(0., |s| *s as f32 / 32768.);
            let level = if index < frames { value(index) * (1. - mix as f32) + value(index + 1) * mix as f32 } else { 0. };
            *sample = T::from_sample(level);
        }
        if index < frames { at += step; }
    }
    position.store(at.to_bits(), Ordering::Relaxed);
}

/// Extensões que o player do app toca; vídeo e o resto abrem no programa do sistema.
pub fn is_audio(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    // Sem opus/oga: o symphonia não decodifica Opus, e esses abrem no programa do sistema.
    ["mp3", "wav", "ogg", "flac", "m4a", "aac"].iter().any(|ext| lower.ends_with(&format!(".{ext}")))
}

pub fn is_video(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    ["mp4", "mov", "webm", "mkv", "avi", "m4v"].iter().any(|ext| lower.ends_with(&format!(".{ext}")))
}

/// "1:05": minutos e segundos do player.
pub fn clock(seconds: f64) -> String {
    let total = seconds.max(0.) as u64;
    format!("{}:{:02}", total / 60, total % 60)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wav(rate: u32, samples: &[i16]) -> Vec<u8> {
        let data: Vec<u8> = samples.iter().flat_map(|s| s.to_le_bytes()).collect();
        let mut out = b"RIFF".to_vec();
        out.extend((36 + data.len() as u32).to_le_bytes());
        out.extend(b"WAVEfmt ");
        out.extend(16u32.to_le_bytes());
        out.extend(1u16.to_le_bytes());
        out.extend(1u16.to_le_bytes());
        out.extend(rate.to_le_bytes());
        out.extend((rate * 2).to_le_bytes());
        out.extend(2u16.to_le_bytes());
        out.extend(16u16.to_le_bytes());
        out.extend(b"data");
        out.extend((data.len() as u32).to_le_bytes());
        out.extend(data);
        out
    }

    #[test]
    fn decodes_the_dictation_wav_and_fills_stereo_at_another_rate() {
        let clip = decode(wav(16_000, &[0, 16_384, -16_384, 0]), Some("wav")).unwrap();
        assert_eq!((clip.channels, clip.rate, clip.frames()), (1, 16_000, 4));
        let position = AtomicU64::new(1f64.to_bits());
        let mut out = [0f32; 4];
        // Saída a 32 kHz: cada quadro do arquivo vira dois, e o mono vai para os dois lados.
        fill(&mut out, &clip, &position, &AtomicBool::new(false), 2, 32_000);
        assert_eq!(out, [0.5, 0.5, 0.0, 0.0]);
        assert_eq!(f64::from_bits(position.load(Ordering::Relaxed)), 2.);
        // Pausado: silêncio e a posição não anda.
        let mut out = [1f32; 4];
        fill(&mut out, &clip, &position, &AtomicBool::new(true), 2, 32_000);
        assert_eq!(out, [0.; 4]);
        assert_eq!(f64::from_bits(position.load(Ordering::Relaxed)), 2.);
        assert!(decode(b"nada".to_vec(), Some("wav")).is_err());
    }

    #[test]
    fn audio_and_video_by_extension_and_clock() {
        assert!(is_audio("ditado.WAV") && is_audio("a.mp3") && is_audio("a.ogg") && !is_audio("a.mp4"));
        assert!(!is_audio("voz.opus") && !is_audio("voz.oga"));
        assert!(is_video("clip.mkv") && !is_video("a.ogg"));
        assert_eq!(clock(65.4), "1:05");
    }
}
