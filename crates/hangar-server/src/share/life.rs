//! Vida da sessão (`share_life.py`) e veredito do convite (`share_gate._verdict`).
//!
//! Não depende do `ListHub`: ele só roda com lista aberta, e o convidado chega sem ela.
use std::collections::{HashMap, HashSet};
use std::ffi::OsString;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use futures_util::future::BoxFuture;
use serde_json::Value;

use super::store::{Guest, Share, ShareStore};
use crate::list::discover_other::sanitize_session_name;
use crate::list::links::session_life;
use crate::state::capture::MuxProcess;

// ponytail: cache de 2 s por nome; cada consulta é um processo do tmux e o chat faz vários
// pedidos por segundo. Revogar vale na hora: o registro é lido a cada pedido.
const LIFE_TTL: Duration = Duration::from_secs(2);
const MUX_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verdict { Ok, Ended, Unsure }

#[derive(Default)]
struct FactsState {
    lives: HashMap<String, String>,
    changing: HashSet<String>,
    snapshot: bool,
}

/// Fatos que só o Python sabe (transferência, troca de modo), empurrados por ele.
#[derive(Default)]
pub struct LifeFacts { state: Mutex<FactsState> }

impl LifeFacts {
    fn lock(&self) -> std::sync::MutexGuard<'_, FactsState> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }
    /// Vida de origem de uma transferência em curso; `None` quando ela termina.
    pub fn set_life(&self, name: &str, life: Option<String>) {
        let mut s = self.lock();
        match life {
            Some(life) => { s.lives.insert(name.into(), life); }
            None => { s.lives.remove(name); }
        }
    }
    pub fn begin_mode_change(&self, name: &str) {
        self.lock().changing.insert(name.into());
    }
    pub fn end_mode_change(&self, name: &str) {
        self.lock().changing.remove(name);
    }
    /// Fotografia completa: substitui o que foi empurrado antes.
    pub fn apply_snapshot(&self, lives: HashMap<String, String>, changing: HashSet<String>) {
        *self.lock() = FactsState { lives, changing, snapshot: true };
    }
    pub fn snapshot_received(&self) -> bool {
        self.lock().snapshot
    }
    pub fn changing_mode(&self, name: &str) -> bool {
        self.lock().changing.contains(name)
    }
    fn transfer_life(&self, name: &str) -> Option<String> {
        self.lock().lives.get(name).cloned()
    }
}

/// O que se pergunta ao multiplexador e aos sidecars; os testes trocam por um falso.
pub trait LifeProbe: Send + Sync {
    /// Nascimento do terminal; `None` também quando o multiplexador não respondeu.
    fn birth<'a>(&'a self, name: &'a str) -> BoxFuture<'a, Option<u64>>;
    /// `None` = o multiplexador não respondeu, que não é sessão morta.
    fn has_session<'a>(&'a self, name: &'a str) -> BoxFuture<'a, Option<bool>>;
    /// Chave do sidecar sem terminal ou Codex, nessa ordem.
    fn sidecar_key(&self, name: &str) -> Option<String>;
    fn sidecar_exists(&self, name: &str) -> bool;
}

pub struct MuxProbe { program: OsString, home: PathBuf, mux: MuxProcess }

impl MuxProbe {
    /// `home`: o `Path.home()` do Python, base de `~/.hangar/<sidecars>`.
    pub fn new(program: impl Into<OsString>, home: PathBuf) -> Self {
        let program = program.into();
        Self { mux: MuxProcess::new(program.clone(), MUX_TIMEOUT), program, home }
    }

    fn sidecar_paths(&self, name: &str) -> [PathBuf; 2] {
        let file = format!("{}.json", sanitize_session_name(name));
        let base = self.home.join(".hangar");
        [base.join("claude-headless").join(&file), base.join("codex-sessions").join(&file)]
    }
}

impl LifeProbe for MuxProbe {
    fn birth<'a>(&'a self, name: &'a str) -> BoxFuture<'a, Option<u64>> {
        Box::pin(async move {
            let mut command = crate::terminal_input::child_command(&self.program);
            // `-t =nome` sem os dois pontos imprime linha vazia com rc 0 no tmux 3.x.
            command.args(["display-message", "-p", "-t", &format!("={name}:"), "#{session_created}"])
                .stdin(std::process::Stdio::null()).kill_on_drop(true);
            let out = tokio::time::timeout(MUX_TIMEOUT, command.output()).await.ok()?.ok()?;
            if !out.status.success() {
                return None;
            }
            let secs: f64 = String::from_utf8_lossy(&out.stdout).trim().parse().ok()?;
            (secs.is_finite() && secs > 0.0).then_some(secs as u64)
        })
    }
    fn has_session<'a>(&'a self, name: &'a str) -> BoxFuture<'a, Option<bool>> {
        Box::pin(self.mux.has_session(name))
    }
    fn sidecar_key(&self, name: &str) -> Option<String> {
        self.sidecar_paths(name).iter().find_map(|path| {
            let meta: Value = serde_json::from_slice(&std::fs::read(path).ok()?).ok()?;
            meta.get("key").and_then(Value::as_str).filter(|k| !k.is_empty()).map(str::to_owned)
        })
    }
    fn sidecar_exists(&self, name: &str) -> bool {
        self.sidecar_paths(name).iter().any(|p| p.exists())
    }
}

pub struct Lives {
    probe: Arc<dyn LifeProbe>,
    facts: Arc<LifeFacts>,
    cache: Mutex<HashMap<String, (Instant, Option<String>)>>,
}

impl Lives {
    pub fn new(probe: Arc<dyn LifeProbe>, facts: Arc<LifeFacts>) -> Self {
        Self { probe, facts, cache: Mutex::default() }
    }

    pub fn facts(&self) -> &LifeFacts {
        &self.facts
    }

    pub async fn life(&self, name: &str, fresh: bool) -> Option<String> {
        // Durante a transferência terminal e sidecar somem: a vida de origem é a que vale.
        if let Some(life) = self.facts.transfer_life(name) {
            return Some(life);
        }
        if !fresh
            && let Some((at, life)) = self.cache.lock().unwrap_or_else(|e| e.into_inner()).get(name)
            && at.elapsed() < LIFE_TTL
        {
            return life.clone();
        }
        let life = match self.probe.sidecar_key(name) {
            Some(key) => session_life(Some(&key), None),
            None => session_life(None, self.probe.birth(name).await),
        };
        self.cache.lock().unwrap_or_else(|e| e.into_inner()).insert(name.into(), (Instant::now(), life.clone()));
        life
    }

    /// Só o multiplexador respondendo "não há" e nenhum sidecar sobrando: vida `None` sozinha
    /// também é o tmux que falhou.
    pub async fn confirmed_absent(&self, name: &str) -> bool {
        self.probe.has_session(name).await == Some(false) && !self.probe.sidecar_exists(name)
    }
}

async fn record_verdict(share: &Share, lives: &Lives) -> Verdict {
    if share.revoked_at.is_some() {
        return Verdict::Ended;
    }
    let facts = lives.facts();
    if facts.changing_mode(&share.session) {
        return Verdict::Unsure;
    }
    let mut life = lives.life(&share.session, false).await;
    if life.is_some() && life != share.life {
        // O cache pode ser de antes de a troca de modo mover o convite para a vida nova.
        life = lives.life(&share.session, true).await;
    }
    if life.is_some() && life == share.life {
        return Verdict::Ok;
    }
    // Sem a fotografia do Python, uma transferência em curso parece sessão morta ou renascida.
    if !facts.snapshot_received() {
        return Verdict::Unsure;
    }
    match life {
        Some(_) => Verdict::Ended,
        None if lives.confirmed_absent(&share.session).await => Verdict::Ended,
        None => Verdict::Unsure,
    }
}

/// Veredito do token para a rota: com sessão, o registro dela; sem, vale se algum vale.
pub async fn verdict(guest: &Guest, session: Option<&str>, lives: &Lives) -> Verdict {
    if let Some(name) = session {
        return match guest.share_for(name) {
            Some(share) => record_verdict(share, lives).await,
            None => Verdict::Ended,
        };
    }
    let mut unsure = false;
    for share in &guest.records {
        match record_verdict(share, lives).await {
            Verdict::Ok => return Verdict::Ok,
            Verdict::Unsure => unsure = true,
            Verdict::Ended => {}
        }
    }
    if unsure { Verdict::Unsure } else { Verdict::Ended }
}

/// `share_api._sweep_once` sem o túnel: só a ausência confirmada ou outra vida revogam.
pub async fn sweep(store: &ShareStore, lives: &Lives) -> std::io::Result<usize> {
    let facts = lives.facts();
    if !facts.snapshot_received() {
        return store.sweep(|_, _| true);
    }
    // A consulta é assíncrona e a closure do `sweep` não: lê antes, decide dentro.
    let sessions: HashSet<String> = store.all().into_iter()
        .filter(|s| s.revoked_at.is_none()).map(|s| s.session).collect();
    let mut current = HashMap::new();
    for name in sessions {
        let life = lives.life(&name, true).await;
        let absent = life.is_none() && lives.confirmed_absent(&name).await;
        current.insert(name, (life, absent));
    }
    store.sweep(|session, life| {
        if facts.changing_mode(session) {
            return true;
        }
        match current.get(session) {
            None => true,
            Some((None, absent)) => !absent,
            Some((Some(now), _)) => life == Some(now.as_str()),
        }
    })
}
