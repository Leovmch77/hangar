use serde::Deserialize;
use serde_json::Value;

#[derive(Clone, Debug, Default, Deserialize)]
pub struct SessionInfo {
    pub name: String,
    pub cwd: Option<String>,
    pub jsonl: Option<String>,
    #[serde(default)] pub provider: String,
    #[serde(default)] pub headless: bool,
    #[serde(default)] pub state: String,
    pub tracked: Option<bool>,
    pub question: Option<String>,
    pub options: Option<Vec<String>>,
    /// Perguntas esperando resposta fora do terminal (as assíncronas do Codex); a aba mostra "? N".
    #[serde(default)] pub pending_questions: u32,
    pub problema: Option<String>,
    pub label: Option<String>,
    pub last_activity: Option<f64>,
    pub branch: Option<String>,
    pub git_added: Option<i64>,
    pub git_removed: Option<i64>,
    pub git_dirty: Option<i64>,
    /// Commits a enviar / a trazer do upstream: o "↑N ↓M" da linha.
    pub git_ahead: Option<i64>,
    pub git_behind: Option<i64>,
    pub status_line: Option<String>,
    pub loop_status: Option<String>,
    pub loop_iter: Option<u32>,
    pub loop_max: Option<u32>,
    pub limited: Option<bool>,
    pub limit_reset: Option<String>,
    /// Sessão que recebe um prompt quando esta terminar (`PUT …/then`).
    pub then_target: Option<String>,
    /// Conta que a sessão usa ("claude:<pasta>", "codex:<pasta>"): selo da linha e id da lista de contas.
    pub conta: Option<String>,
    pub last_reply: Option<String>,
    pub last_reply_at: Option<f64>,
    pub worktree: Option<bool>,
    /// Membros do grupo de trabalho além dela; `srv::nome` é par de outro servidor.
    pub pair_peers: Option<Vec<String>>,
    /// Id estável do grupo: a lista junta num bloco quem tem o mesmo.
    pub pair_gid: Option<String>,
    /// Tarefa do grupo (ex: ABC-1234 …), o rótulo do cabeçalho do bloco.
    pub pair_task: Option<String>,
    /// Há convite ativo desta sessão (pendente ou já usado): o 🔗 da linha.
    #[serde(default)] pub shared: bool,
    /// Só na linha `orq`: a sessão do árbitro atual, que o "Falar com o árbitro" abre.
    pub orq_arbiter: Option<String>,
    /// Task em andamento do plano que a sessão executa, e o total delas.
    pub plan_task: Option<u32>,
    pub plan_task_total: Option<u32>,
}

impl SessionInfo {
    pub fn readable(&self) -> bool { self.tracked != Some(false) && self.jsonl.is_some() }
    pub fn peers(&self) -> &[String] { self.pair_peers.as_deref().unwrap_or_default() }
    /// O orquestrador sem LLM: tem linha do tempo, mas não recebe mensagem, nome novo, fechar nem interromper.
    pub fn orq(&self) -> bool { self.provider == "orq" }
    /// Tem compositor: a linha `orq` lê a linha do tempo, mas ninguém escreve nela.
    pub fn takes_messages(&self) -> bool { self.readable() && !self.orq() }
    /// O árbitro que esta linha `orq` aponta, entre as sessões da mesma lista.
    pub fn arbiter<'a>(&self, sessions: &'a [SessionInfo]) -> Option<&'a SessionInfo> {
        let name = self.orq_arbiter.as_deref()?;
        sessions.iter().find(|s| s.name == name)
    }
}

/// Resposta de juntar ou sair do grupo (`POST|DELETE …/pair`): o vínculo já mudou; `warning` diz quem não recebeu o aviso.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct PairResult { pub warning: Option<String> }

impl PairResult {
    pub fn from_value(value: &Value) -> Self {
        let warning = value.get("warning").filter(|w| !w.is_null()).map(|w| match w {
            Value::String(text) => text.clone(),
            _ => w.get("msg").and_then(Value::as_str).map(str::to_owned).unwrap_or_else(|| w.to_string()),
        });
        Self { warning }
    }
}

#[derive(Clone, Debug, Default, Deserialize)]
pub struct ChatEvent {
    pub kind: String,
    pub id: String,
    pub text: Option<String>,
    pub tool_name: Option<String>,
    pub tool_input: Option<Value>,
    pub tool_use_id: Option<String>,
    pub result: Option<String>,
    pub is_error: Option<bool>,
    pub ts: Option<f64>,
    pub queued_delivered: Option<bool>,
    pub queued_confirmed: Option<bool>,
    pub queued_ts: Option<f64>,
    pub desistiu: Option<bool>,
    pub hook_error: Option<String>,
    pub image_count: Option<u32>,
    /// Só em notice `skill_loaded`: a skill que o harness injetou como fala do usuário.
    pub skill: Option<SkillLoaded>,
    /// Cache de prompt do turno (só `assistant_msg`): tokens lidos dele e a janela medida em segundos (3600 ou 300).
    pub cache_read: Option<u64>,
    pub cache_ttl_s: Option<u64>,
}

#[derive(Clone, Debug, Default, Deserialize)]
pub struct SkillLoaded {
    pub name: String,
    #[serde(default)] pub body: String,
}

impl ChatEvent {
    pub fn queued(&self) -> bool { self.id.starts_with("queued-") }
    pub fn body(&self) -> String {
        self.text.clone().or_else(|| self.result.clone()).unwrap_or_else(|| {
            self.tool_input.as_ref().map(|v| serde_json::to_string_pretty(v).unwrap_or_default()).unwrap_or_default()
        })
    }
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
pub struct SessionState {
    #[serde(default)] pub state: String,
    pub label: Option<String>,
    pub question: Option<String>,
    pub options: Option<Vec<String>>,
    pub problema: Option<String>,
    pub problema_detalhe: Option<String>,
    pub login: Option<bool>,
    pub claude_plan_pending: Option<PlanPending>,
    pub status_line: Option<String>,
    pub codex_mode: Option<String>,
    pub claude_permission_mode: Option<String>,
    pub claude_previous_non_plan: Option<String>,
    pub recarregar_motivo: Option<String>,
    pub limited: Option<bool>,
    pub limit_reset: Option<String>,
    pub loop_status: Option<String>,
    pub loop_iter: Option<u32>,
    pub loop_max: Option<u32>,
    // Processos de fundo que a sessão deixou vivos, lidos do sistema pelo backend.
    #[serde(default)] pub shells: Vec<ShellAlive>,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
pub struct ShellAlive {
    pub pid: i64,
    #[serde(default)] pub cmd: String,
    /// Epoch em segundos; ausente quando o sistema não soube dizer.
    pub desde: Option<f64>,
}

/// Evento SSE `stats`: só turns/steps/in/out são garantidos; o resto aparece quando o backend mede.
#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
pub struct Stats {
    #[serde(default)] pub turns: u64,
    #[serde(default)] pub steps: u64,
    #[serde(default)] pub in_tok: u64,
    #[serde(default)] pub out_tok: u64,
    pub llm_ms: Option<f64>,
    pub tool_ms: Option<f64>,
    pub tok_s: Option<f64>,
    pub cache_pct: Option<f64>,
    pub ttft_ms: Option<f64>,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
pub struct PlanPending {
    #[serde(default)] pub plan: String,
    pub path: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
pub struct AskOption {
    #[serde(default)] pub label: String,
    #[serde(default)] pub description: String,
    #[serde(default)] pub preview: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AskItem {
    pub id: Option<String>,
    #[serde(default)] pub header: String,
    #[serde(default)] pub question: String,
    #[serde(default)] pub multi_select: bool,
    #[serde(default)] pub options: Vec<AskOption>,
    #[serde(default)] pub is_other: bool,
    #[serde(default)] pub is_secret: bool,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct AskPayload {
    pub provider: Option<String>,
    // Valor cru: o Codex recusa id com outro tipo JSON (número × texto).
    pub request_id: Option<Value>,
    #[serde(default)] pub is_async: bool,
    #[serde(default)] pub questions: Vec<AskItem>,
}

#[derive(Clone, Debug, Default, Deserialize)]
pub struct Preview {
    #[serde(default)] pub text: String,
    #[serde(default)] pub md: bool,
    #[serde(default)] pub full: bool,
    #[serde(default)] pub vivo: bool,
}

#[derive(Clone, Debug, Deserialize)]
pub struct Delivery {
    pub ok: bool,
    #[serde(default)] pub delivered: bool,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CommandInfo {
    pub name: String,
    #[serde(default)] pub display: String,
    pub description: Option<String>,
    pub argument_hint: Option<String>,
    #[serde(default)] pub source: String,
    #[serde(default)] pub destructive: bool,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
pub struct Uploaded {
    pub path: String,
    #[serde(default)] pub frames: Vec<String>,
    pub transcript: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct UploadFile {
    pub filename: String,
    #[serde(default)] pub size: u64,
    #[serde(default)] pub mtime: f64,
}

#[derive(Clone, Debug, Default, Deserialize)]
pub struct Steered {
    #[serde(default)] pub promoted: bool,
    #[serde(default)] pub confirmed: u32,
    #[serde(default)] pub queued_ids: Vec<String>,
}

#[cfg(test)]
mod tests {
    use super::SessionInfo;
    use serde_json::json;

    #[test]
    fn orq_row_reads_the_arbiter_and_finds_it_in_the_list() {
        let orq: SessionInfo = serde_json::from_value(json!({"name": "g1-orq", "provider": "orq", "jsonl": "/r/timeline-x.jsonl",
            "orq_arbiter": "arb"})).unwrap();
        assert!(orq.orq() && orq.readable(), "a linha do tempo é lida como conversa");
        let list = [SessionInfo { name: "arb".into(), ..Default::default() }, orq.clone()];
        assert_eq!(orq.arbiter(&list).map(|s| s.name.as_str()), Some("arb"));
        let old: SessionInfo = serde_json::from_value(json!({"name": "a", "provider": "claude"})).unwrap();
        assert!(!old.orq() && old.orq_arbiter.is_none(), "backend sem o campo continua lendo");
        let gone = SessionInfo { orq_arbiter: Some("sumiu".into()), ..orq };
        assert!(gone.arbiter(&list).is_none(), "árbitro fora da lista: o botão fica desligado");
    }

    #[test]
    fn only_readable_non_orq_rows_take_the_composer_focus() {
        let orq = SessionInfo { provider: "orq".into(), jsonl: Some("/r/t.jsonl".into()), ..Default::default() };
        assert!(orq.readable() && !orq.takes_messages(), "o compositor da linha `orq` não é desenhado");
        let chat = SessionInfo { provider: "claude".into(), ..orq.clone() };
        assert!(chat.takes_messages());
        assert!(!SessionInfo { jsonl: None, ..chat }.takes_messages());
    }
}
