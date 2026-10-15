use serde::{Deserialize, Serialize};

#[derive(Clone, Deserialize, Serialize, Default)]
#[serde(default)]
pub struct ProviderConfig {
    pub id: String,
    pub kind: String,
    pub name: String,
    pub base_url: String,
    pub api_key: String,
    pub model: String,
    pub executable_path: String,
    pub model_path: String,
    pub language: String,
    pub converter_path: String,
}

#[derive(Clone, Deserialize, Default)]
#[serde(default)]
pub struct ConfigSnapshot {
    pub providers: Vec<ProviderConfig>,
    pub legacy: Option<ProviderConfig>,
    pub vocabulary: String,
    pub user_vocabulary: Option<String>,
    pub state_path: String,
    pub dictation_max_minutes: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Transcription {
    pub text: String,
    pub provider: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub aviso: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct TranscriptionError {
    pub status: u16,
    pub code: String,
    pub detail: String,
}

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Profile {
    Dictation,
    File,
    Video,
}

/// (por serviço, total) do ditado: áudio mais longo leva mais num Whisper local.
pub fn dictation_limits(minutes: u64) -> (u64, u64) {
    let recording = if minutes == 0 { 5 } else { minutes.min(30) } * 60;
    ((recording / 2).max(60), recording.max(150))
}

impl Profile {
    pub fn limits(self) -> (u64, u64) {
        match self {
            Self::Dictation => (60, 150),
            Self::File => (120, 240),
            Self::Video => (60, 120),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn dictation_deadline_follows_the_recording_ceiling() {
        assert_eq!(dictation_limits(0), (150, 300), "sem escolha: 5 min");
        assert_eq!(dictation_limits(5), (150, 300));
        assert_eq!(dictation_limits(2), (60, 150), "gravação curta mantém o piso de antes");
        assert_eq!(dictation_limits(30), (900, 1800));
        assert_eq!(dictation_limits(90), (900, 1800), "acima de 30 não passa do teto");
    }
}
