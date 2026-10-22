//! As reservas vivas, em memória, e o recibo em disco (`~/.hangar/prewarm/<chave>.json`) que só serve
//! para a subida do servidor limpar o que um servidor que caiu deixou.
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::{Launcher, Planned, Processes};
use crate::accounts::AccountKey;
use crate::runtime::process::Cano;
use crate::session_open::open::NameClaim;
use crate::session_open::{OpenError, PermissionMode, SessionOpenRequest, SessionSpec};

/// Sem renovação por este tempo, a reserva sai.
pub const EXPIRY: Duration = Duration::from_secs(90);
/// Vida máxima, mesmo renovada: a configuração lida no nascimento envelhece.
pub const MAX_LIFE: Duration = Duration::from_secs(600);
/// Reservas vivas no servidor; a mais velha sai.
pub const SERVER_LIMIT: usize = 3;
const SWEEP_EVERY: Duration = Duration::from_secs(5);

/// Para onde vão os eventos `sessao.prewarm`.
pub type Diary = Arc<dyn Fn(Value) + Send + Sync>;

/// A resposta do `PUT`: a reserva (o id é a chave), a impressão e o nome dela (o cliente que gera nome
/// sozinho o manda na abertura, para a adoção casar).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Ticket { pub id: String, pub fingerprint: String, pub name: String }

/// Uma reserva viva. A adoção usa a chave, o id da conversa, o nome (com o `NameClaim` dela) e o `cano`
/// inteiro (pid, escuta, token, versão, `process_birth`, `config_marca`), que vai ao sidecar como está.
pub struct Reserve {
    /// O id da reserva é a chave da sessão.
    pub id: String,
    pub client_id: String,
    pub key: String,
    pub session_id: String,
    pub name: String,
    pub cwd: String,
    pub fingerprint: String,
    /// O spec resolvido da reserva sem a identidade (`adoption_spec`): a adoção compara o do `POST` com
    /// ele, sem resolver nem montar o lançamento de novo.
    pub spec: SessionSpec,
    pub previous_non_plan: Option<PermissionMode>,
    /// As escolhas da conversa com que o processo subiu; a sessão adotada as grava no sidecar.
    pub settings: Option<Value>,
    /// A pasta efetiva da conta (onde o transcript nasce).
    pub config_dir: PathBuf,
    pub account: AccountKey,
    pub cano: Cano,
    /// O nome fica reservado enquanto a reserva vive; a adoção o leva para a abertura.
    pub(crate) claim: NameClaim,
    /// O pedido da última subida: o mesmo corpo na renovação só estende o prazo, sem resolver de novo.
    pub asked: SessionOpenRequest,
    pub born: Instant,
    pub renewed: Instant,
}

/// O recibo em disco: o que a limpeza da subida precisa, sem o token do cano.
#[derive(Serialize, Deserialize)]
struct Receipt { key: String, session_id: String, name: String, cwd: String, config_dir: PathBuf, cano: Cano }

#[derive(Default)]
struct Inner {
    reserves: BTreeMap<String, Reserve>,
    /// Nomes reservados de subidas em curso, com o `client_id` delas.
    pending: HashMap<String, String>,
    /// `PUT`s em curso por `client_id`: quantos e a geração, que o `DELETE` avança para soltá-los.
    inflight: HashMap<String, (usize, u64)>,
}

/// O que a limpeza precisa do `Store`, clonável para rodar destacada.
#[derive(Clone)]
struct Cleaner {
    processes: Arc<dyn Processes>,
    diary: Diary,
    sidecar_dir: PathBuf,
    receipts: PathBuf,
    customizations: PathBuf,
}

/// A reserva sem o `NameClaim`: o que a limpeza mata e apaga.
struct Traces { key: String, session_id: String, name: String, cwd: String, config_dir: PathBuf, cano: Cano }

fn split(reserve: Reserve) -> (Traces, NameClaim) {
    let Reserve { key, session_id, name, cwd, config_dir, cano, claim, .. } = reserve;
    (Traces { key, session_id, name, cwd, config_dir, cano }, claim)
}

/// O prazo vencido em `now`: sem renovação por `EXPIRY` ou com mais de `MAX_LIFE`.
fn expired(reserve: &Reserve, now: Instant) -> Option<&'static str> {
    if now.saturating_duration_since(reserve.born) >= MAX_LIFE { Some("vida_maxima") }
    else if now.saturating_duration_since(reserve.renewed) >= EXPIRY { Some("sem_renovacao") }
    else { None }
}

fn released_error() -> OpenError { OpenError::new(409, "erro_prewarm_solta", "a reserva foi solta pelo cliente") }

pub struct Store {
    inner: std::sync::Mutex<Inner>,
    clients: std::sync::Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    /// `~/.hangar/prewarm`: os recibos.
    dir: PathBuf,
    /// `~/.hangar/claude-headless`: a pasta do cano (socket e log), a mesma das sessões.
    sidecar_dir: PathBuf,
    processes: Arc<dyn Processes>,
    diary: Diary,
    clock: Clock,
}

/// O relógio dos prazos; os testes o adiantam.
pub type Clock = Arc<dyn Fn() -> Instant + Send + Sync>;

impl Store {
    pub fn new(dir: PathBuf, sidecar_dir: PathBuf, processes: Arc<dyn Processes>, diary: Diary) -> Self {
        Self { inner: Default::default(), clients: Default::default(), dir, sidecar_dir, processes, diary, clock: Arc::new(Instant::now) }
    }

    #[cfg(test)]
    pub fn with_clock(mut self, clock: Clock) -> Self {
        self.clock = clock;
        self
    }

    /// O do servidor: recibos em `<hangar>/prewarm`, cano em `<hangar>/claude-headless`, diário exportável.
    pub fn server(hangar_dir: &Path) -> Self {
        let diary: Diary = Arc::new(|event| { crate::diag::record(crate::diag::diary_dir(), vec![event], "prewarm"); });
        Self::new(hangar_dir.join("prewarm"), hangar_dir.join("claude-headless"), Arc::new(super::RealProcesses), diary)
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> { self.inner.lock().unwrap_or_else(std::sync::PoisonError::into_inner) }

    /// Uma trava por `client_id`; as de quem ninguém segura saem do mapa.
    fn client_lock(&self, client_id: &str) -> Arc<tokio::sync::Mutex<()>> {
        let mut clients = self.clients.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        clients.retain(|_, lock| Arc::strong_count(lock) > 1);
        clients.entry(client_id.to_owned()).or_default().clone()
    }

    fn receipt(&self, key: &str) -> PathBuf { self.dir.join(format!("{key}.json")) }

    fn cleaner(&self) -> Cleaner {
        // `<hangar>/claude-customizations`, irmã de `<hangar>/prewarm`: a mesma raiz do `store_root` das escolhas.
        Cleaner { processes: self.processes.clone(), diary: self.diary.clone(), sidecar_dir: self.sidecar_dir.clone(),
            receipts: self.dir.clone(), customizations: self.dir.with_file_name("claude-customizations") }
    }

    /// O `DELETE` passou depois que este `PUT` do `client_id` chegou.
    fn released(&self, client_id: &str, generation: u64) -> bool {
        self.lock().inflight.get(client_id).is_some_and(|(_, current)| *current != generation)
    }

    /// O nome que a reserva `id` segura.
    #[cfg(test)]
    pub fn name_of(&self, id: &str) -> Option<String> { self.lock().reserves.get(id).map(|r| r.name.clone()) }

    #[cfg(test)]
    pub fn len(&self) -> usize { self.lock().reserves.len() }
    #[cfg(test)]
    pub fn is_empty(&self) -> bool { self.len() == 0 }

    /// Renova ou sobe a reserva da tela `client_id`. Mesma impressão = a mesma reserva com o prazo
    /// renovado; impressão nova (ou processo morto) = a velha sai e outra sobe. A recusa é a da abertura.
    /// Um `DELETE` do mesmo `client_id` no meio solta o que este `PUT` subir.
    pub async fn reserve(&self, launcher: &dyn Launcher, request: &SessionOpenRequest, client_id: &str) -> Result<Ticket, OpenError> {
        if let Err(error) = super::scope(request) {
            // A tela saiu do escopo: a reserva que ela tinha não serve mais.
            self.release_client(client_id, "fora_do_escopo").await;
            return Err(error);
        }
        let generation = {
            let mut inner = self.lock();
            let entry = inner.inflight.entry(client_id.to_owned()).or_default();
            entry.0 += 1;
            entry.1
        };
        let result = self.reserve_held(launcher, request, client_id, generation).await;
        let released = {
            let mut inner = self.lock();
            let released = inner.inflight.get(client_id).is_some_and(|(_, current)| *current != generation);
            if let Some(entry) = inner.inflight.get_mut(client_id) {
                entry.0 -= 1;
                if entry.0 == 0 { inner.inflight.remove(client_id); }
            }
            released
        };
        if !released { return result; }
        let ticket = result?;
        self.drop_reserve(&ticket.id, "descartada", "cliente").await;
        Err(released_error())
    }

    async fn reserve_held(&self, launcher: &dyn Launcher, request: &SessionOpenRequest, client_id: &str, generation: u64)
        -> Result<Ticket, OpenError> {
        let lock = self.client_lock(client_id);
        let _held = lock.lock().await;
        let existing = self.lock().reserves.values().find(|r| r.client_id == client_id)
            .map(|r| (r.id.clone(), r.session_id.clone(), r.fingerprint.clone(), r.cano.clone(), r.name.clone(), r.asked == *request));
        if let Some((id, sid, fingerprint, cano, name, same_body)) = existing {
            // O mesmo corpo só estende o prazo: resolver de novo a cada renovação custa caro, e a adoção compara o spec que a abertura resolve.
            if same_body && self.processes.alive(&cano, &id).await
                && let Some(reserve) = self.lock().reserves.get_mut(&id)
                && expired(reserve, (self.clock)()).is_none() {
                reserve.renewed = (self.clock)();
                return Ok(Ticket { id, fingerprint, name });
            }
            let motivo = match launcher.plan(request, &sid).await {
                Err(error) => {
                    // 5xx é falha do servidor (ex.: escolhas da conversa ocupadas), não do pedido: a reserva fica.
                    if error.status < 500 { self.drop_reserve(&id, "descartada", "pedido_recusado").await; }
                    return Err(error);
                }
                Ok(planned) if planned.fingerprint == fingerprint => {
                    if self.processes.alive(&cano, &id).await
                        && let Some(reserve) = self.lock().reserves.get_mut(&id) {
                        reserve.renewed = (self.clock)();
                        reserve.asked = request.clone();
                        // O mesmo processo com o pedido novo: a adoção compara com o spec e as escolhas deste plano.
                        reserve.spec = super::adoption_spec(&planned.spec);
                        reserve.previous_non_plan = planned.previous_non_plan;
                        reserve.settings = planned.settings;
                        return Ok(Ticket { id, fingerprint, name });
                    }
                    "processo_morto"
                }
                Ok(_) => "impressao_nova",
            };
            self.drop_reserve(&id, "descartada", motivo).await;
        }
        // Solta no meio: não sobe um processo só para matá-lo.
        if self.released(client_id, generation) { return Err(released_error()); }
        // Depois de soltar a velha: o nome dela volta a valer para a nova.
        let planned = launcher.plan(request, &launcher.new_session_id()).await?;
        self.spawn_new(launcher, planned, request, client_id).await
    }

    async fn spawn_new(&self, launcher: &dyn Launcher, planned: Planned, request: &SessionOpenRequest, client_id: &str) -> Result<Ticket, OpenError> {
        let name = planned.spec.name.clone();
        let claim = NameClaim::reserve(&planned.home, &name)?;
        self.lock().pending.insert(name.clone(), client_id.to_owned());
        let result = self.start(launcher, planned, request, client_id, claim).await;
        self.lock().pending.remove(&name);
        if let Err(error) = &result {
            (self.diary)(super::diary_event(&name, "descartada", error.code.unwrap_or("falhou")));
            return result;
        }
        self.enforce_limit().await;
        result
    }

    async fn start(&self, launcher: &dyn Launcher, planned: Planned, request: &SessionOpenRequest, client_id: &str, claim: NameClaim)
        -> Result<Ticket, OpenError> {
        let spawned = launcher.spawn(&planned, &self.sidecar_dir).await?;
        let Planned { spec, session_id, fingerprint, config_dir, account, previous_non_plan, settings, .. } = planned;
        let adoption = super::adoption_spec(&spec);
        let mut kept = spawned.cano.clone();
        kept.token.clear();
        let receipt = Receipt { key: spec.key.clone(), session_id: session_id.clone(), name: spec.name.clone(), cwd: spec.cwd.clone(),
            config_dir: config_dir.clone(), cano: kept };
        let (dir, path) = (self.dir.clone(), self.receipt(&spec.key));
        let written = tokio::task::spawn_blocking(move || {
            std::fs::create_dir_all(&dir)?;
            crate::runtime::queue::atomic_write(&path, &serde_json::to_vec(&receipt)?)
        }).await.unwrap_or_else(|e| Err(std::io::Error::other(e.to_string())));
        if let Err(error) = written {
            // Sem recibo, um servidor que cai deixaria o processo sem quem o limpe.
            if let Err(code) = self.processes.kill(&spawned.cano, &spec.key, &self.sidecar_dir).await {
                tracing::warn!(code, "processo da reserva sem recibo não foi encerrado");
            }
            return Err(OpenError::new(500, "erro_prewarm_recibo", format!("o recibo da reserva não foi gravado: {:?}", error.kind())));
        }
        let now = (self.clock)();
        let ticket = Ticket { id: spec.key.clone(), fingerprint: fingerprint.clone(), name: spec.name.clone() };
        let reserve = Reserve { id: spec.key.clone(), client_id: client_id.to_owned(), key: spec.key, session_id, name: spec.name.clone(),
            cwd: spec.cwd, fingerprint, spec: adoption, previous_non_plan, settings, config_dir, account, cano: spawned.cano, claim, asked: request.clone(), born: now, renewed: now };
        self.lock().reserves.insert(ticket.id.clone(), reserve);
        // Só agora: a exclusão da conta, que espera esta guarda, acha a reserva no `Store`.
        drop(spawned.guard);
        (self.diary)(super::diary_event(&spec.name, "reservada", "nova"));
        Ok(ticket)
    }

    async fn enforce_limit(&self) {
        let oldest = {
            let inner = self.lock();
            (inner.reserves.len() > SERVER_LIMIT).then(|| inner.reserves.values().min_by_key(|r| r.born).map(|r| r.id.clone())).flatten()
        };
        if let Some(id) = oldest { self.drop_reserve(&id, "descartada", "limite_servidor").await; }
    }

    /// Fecha a reserva `id` (inexistente: `false`).
    #[cfg(test)]
    pub async fn discard(&self, id: &str, motivo: &str) -> bool { self.drop_reserve(id, "descartada", motivo).await }

    async fn drop_reserve(&self, id: &str, etapa: &str, motivo: &str) -> bool {
        let Some(reserve) = self.lock().reserves.remove(id) else { return false };
        self.cleanup(reserve, etapa, motivo).await;
        true
    }

    /// O `DELETE` do cliente: solta `id` e tudo da tela `client_id`, inclusive o `PUT` que ainda está subindo.
    pub async fn release(&self, id: &str, client_id: Option<&str>) {
        self.drop_reserve(id, "descartada", "cliente").await;
        if let Some(client) = client_id { self.release_client(client, "cliente").await; }
    }

    /// Tudo da tela `client`, inclusive o `PUT` que ainda está subindo.
    async fn release_client(&self, client: &str, motivo: &str) {
        let ids: Vec<String> = {
            let mut inner = self.lock();
            if let Some((_, generation)) = inner.inflight.get_mut(client) { *generation += 1; }
            inner.reserves.values().filter(|r| r.client_id == client).map(|r| r.id.clone()).collect()
        };
        for id in ids { self.drop_reserve(&id, "descartada", motivo).await; }
    }

    /// Tira a reserva para a adoção: quem tira primeiro leva. O recibo fica até `adopted`. Vencida conta
    /// como ausente: o nome solta já (a abertura vai querê-lo) e o processo morre destacado.
    pub fn take(&self, id: &str) -> Option<Reserve> {
        let reserve = self.lock().reserves.remove(id)?;
        let Some(motivo) = expired(&reserve, (self.clock)()) else { return Some(reserve) };
        let (traces, claim) = split(reserve);
        drop(claim);
        let cleaner = self.cleaner();
        tokio::spawn(async move { cleaner.run(traces, "expirada", motivo).await });
        None
    }

    /// A adoção gravou o sidecar com o `cano` da reserva: o recibo sai (a subida não pode matar a sessão).
    pub async fn adopted(&self, key: &str, name: &str) {
        let path = self.receipt(key);
        if let Ok(Err(error)) = tokio::task::spawn_blocking(move || remove(&path)).await {
            tracing::warn!(kind = ?error.kind(), "recibo da reserva adotada ficou");
        }
        (self.diary)(super::diary_event(name, "adotada", "abertura"));
    }

    /// A reserva tirada que a adoção recusou (impressão, login, configuração, processo morto).
    pub async fn discard_taken(&self, reserve: Reserve, motivo: &str) { self.cleanup(reserve, "descartada", motivo).await; }

    /// O nome digitado (ou o derivado) cai numa reserva: ela sai antes de a abertura decidir o nome.
    /// Uma subida em curso com esse nome é esperada e sai também.
    pub async fn discard_name(&self, name: &str, motivo: &str) -> bool {
        let pending = self.lock().pending.get(name).cloned();
        if let Some(client) = pending { drop(self.client_lock(&client).lock().await); }
        let id = self.lock().reserves.values().find(|r| r.name == name).map(|r| r.id.clone());
        match id { Some(id) => self.drop_reserve(&id, "descartada", motivo).await, None => false }
    }

    /// A conta saiu (exclusão ou logout): as reservas dela saem.
    pub async fn discard_account(&self, account: &AccountKey, motivo: &str) {
        let ids: Vec<String> = self.lock().reserves.values().filter(|r| r.account == *account).map(|r| r.id.clone()).collect();
        for id in ids { self.drop_reserve(&id, "descartada", motivo).await; }
    }

    /// A saída limpa do servidor.
    pub async fn discard_all(&self, motivo: &str) {
        let all: Vec<Reserve> = std::mem::take(&mut self.lock().reserves).into_values().collect();
        futures_util::future::join_all(all.into_iter().map(|r| self.cleanup(r, "descartada", motivo))).await;
    }

    /// Prazo vencido agora: sem renovação por `EXPIRY` ou com mais de `MAX_LIFE`.
    pub async fn sweep(&self) {
        let now = (self.clock)();
        let due: Vec<(String, &'static str)> = self.lock().reserves.values()
            .filter_map(|r| expired(r, now).map(|motivo| (r.id.clone(), motivo))).collect();
        for (id, motivo) in due { self.drop_reserve(&id, "expirada", motivo).await; }
    }

    /// O varredor de prazo do servidor.
    pub fn spawn_sweeper(self: &Arc<Self>) -> tokio::task::JoinHandle<()> {
        let store = Arc::downgrade(self);
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(SWEEP_EVERY);
            tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                tick.tick().await;
                let Some(store) = store.upgrade() else { return };
                store.sweep().await;
            }
        })
    }

    async fn cleanup(&self, reserve: Reserve, etapa: &str, motivo: &str) {
        let (traces, claim) = split(reserve);
        // Antes do kill (até 2 s): a reserva já saiu do mapa, e o nome preso daria 409 a uma abertura que não a vê.
        drop(claim);
        self.cleaner().run(traces, etapa, motivo).await;
    }

    /// Subida do servidor: todo recibo que sobrou é de um servidor que caiu. O da reserva já adotada
    /// (chave num sidecar) só sai; o resto passa pela limpeza completa. Devolve quantas foram limpas.
    pub async fn clean_receipts(&self) -> usize {
        let (dir, sidecars) = (self.dir.clone(), self.sidecar_dir.clone());
        let found = tokio::task::spawn_blocking(move || read_receipts(&dir, &sidecars)).await
            .unwrap_or_else(|error| { tracing::warn!(%error, "prewarm: leitura dos recibos caiu"); Vec::new() });
        let mut cleaned = 0;
        for (path, receipt, adopted) in found {
            if adopted {
                if let Err(error) = remove(&path) { tracing::warn!(kind = ?error.kind(), "recibo de reserva adotada ficou"); }
                continue;
            }
            match self.processes.kill(&receipt.cano, &receipt.key, &self.sidecar_dir).await {
                Ok(()) => {
                    let Receipt { config_dir, cwd, session_id, name, .. } = receipt;
                    let customizations = self.cleaner().customizations;
                    if let Err(error) = tokio::task::spawn_blocking(move || remove_traces(&config_dir, &cwd, &session_id, &path, &customizations)).await {
                        tracing::warn!(%error, "prewarm: limpeza dos rastros caiu");
                    }
                    (self.diary)(super::diary_event(&name, "descartada", "sobra_da_subida"));
                    cleaned += 1;
                }
                Err(code) => tracing::warn!(code, "processo de reserva que sobrou não foi encerrado; recibo conservado"),
            }
        }
        cleaned
    }
}

impl Cleaner {
    /// Mata o processo e apaga o que ele deixou: o transcript sem mensagem do usuário, os marcadores
    /// de estado e as escolhas da conversa e o recibo. Processo que não morreu deixa os arquivos e o
    /// recibo para a próxima subida.
    async fn run(self, traces: Traces, etapa: &str, motivo: &str) {
        let Traces { key, session_id, name, cwd, config_dir, cano } = traces;
        let killed = self.processes.kill(&cano, &key, &self.sidecar_dir).await;
        let motivo = match killed {
            Ok(()) => {
                let (receipt, customizations) = (self.receipts.join(format!("{key}.json")), self.customizations.clone());
                if tokio::task::spawn_blocking(move || remove_traces(&config_dir, &cwd, &session_id, &receipt, &customizations)).await.is_err() {
                    tracing::warn!("limpeza da reserva não terminou");
                }
                motivo.to_owned()
            }
            Err(code) => {
                tracing::warn!(code, "processo da reserva não foi encerrado; recibo conservado para a próxima subida");
                format!("{motivo}; processo_vivo:{code}")
            }
        };
        (self.diary)(super::diary_event(&name, etapa, &motivo));
    }
}

fn remove(path: &Path) -> std::io::Result<()> {
    match std::fs::remove_file(path) {
        Err(error) if error.kind() != std::io::ErrorKind::NotFound => Err(error),
        _ => Ok(()),
    }
}

/// O transcript tem alguma linha do usuário: vira conversa de verdade e fica.
fn has_user_line(text: &str) -> bool {
    text.lines().any(|line| line.contains(r#""type":"user""#)
        || serde_json::from_str::<Value>(line).is_ok_and(|event| event["type"] == "user"))
}

/// Bloqueante. Falha de remoção vai ao log; o que não existe já está limpo.
pub(crate) fn remove_traces(config_dir: &Path, cwd: &str, session_id: &str, receipt: &Path, customizations: &Path) {
    let jsonl = config_dir.join("projects").join(hangar_workspace::worktrees::sanitize_cwd(cwd)).join(format!("{session_id}.jsonl"));
    let keep = match std::fs::read(&jsonl) {
        Ok(raw) => has_user_line(&String::from_utf8_lossy(&raw)),
        Err(error) => error.kind() != std::io::ErrorKind::NotFound,
    };
    let mut paths: Vec<PathBuf> = [".hangar-active", ".hangar-state", ".hangar-prompt"].iter()
        .map(|dir| config_dir.join(dir).join(format!("{session_id}.json"))).collect();
    // A conversa que fica guarda as escolhas dela (a retomada as lê).
    if !keep {
        paths.push(jsonl);
        paths.extend(crate::claude_customizations::record_path(customizations, session_id));
    }
    paths.push(receipt.to_owned());
    for path in paths {
        if let Err(error) = remove(&path) { tracing::warn!(kind = ?error.kind(), "rastro da reserva não foi apagado"); }
    }
}

/// Os recibos da pasta e se a chave de cada um já está no sidecar do nome dele (a adoção grava
/// `<nome>.json` com o nome da reserva). Ilegível fica e vai ao log.
fn read_receipts(dir: &Path, sidecars: &Path) -> Vec<(PathBuf, Receipt, bool)> {
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Vec::new(),
        Err(error) => { tracing::warn!(%error, dir = %dir.display(), "prewarm: recibos ilegíveis; sobras não limpas"); return Vec::new() }
    };
    let adopted = |receipt: &Receipt| std::fs::read(sidecars.join(format!("{}.json", receipt.name))).ok()
        .and_then(|raw| serde_json::from_slice::<Value>(&raw).ok())
        .is_some_and(|meta| meta["key"] == receipt.key.as_str());
    entries.flatten().map(|e| e.path()).filter(|p| p.extension().is_some_and(|x| x == "json")).filter_map(|path| {
        match std::fs::read(&path).ok().and_then(|raw| serde_json::from_slice::<Receipt>(&raw).ok()) {
            Some(receipt) => { let adopted = adopted(&receipt); Some((path, receipt, adopted)) }
            None => { tracing::warn!(file = %path.display(), "recibo de reserva ilegível; ficou"); None }
        }
    }).collect()
}
