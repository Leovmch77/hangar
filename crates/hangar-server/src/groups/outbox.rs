//! Fila de saída entre máquinas (`.hangar-pair/groups/outbox.json`), só do Rust. O item vai ao
//! disco antes da rede; um trabalhador por máquina de destino entrega em ordem e só existe com
//! item. Quem monta o pedido HTTP de cada item é o `OutboxSend` de quem usa a fila.
use std::collections::{BTreeSet, HashMap};
use std::io;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::Notify;

use super::model::{GroupRecord, OutsideRef};
use super::peers::PeerError;
use super::service::BoxFuture;
use super::store::{OUTBOX_STEM, replace_atomic};

/// `origin` = server_id de quem enfileirou: o token de dono não diz quem chamou.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum OutboxItem {
    Push { server: String, gid: String, version: u64, joining: Vec<String>, origin: String },
    Dissolved { server: String, gid: String, version: u64, origin: String },
    Leave { owner: String, gid: String, member: String, origin: String },
    Rename { owner: String, gid: String, from: String, to: String, origin: String },
    /// Par de fora ligado ou desfeito num grupo entre máquinas, avisado à dona.
    Outside { owner: String, gid: String, op: OutsideOp, origin: String },
}

impl OutboxItem {
    /// A máquina que recebe o item.
    pub fn destination(&self) -> &str {
        match self {
            OutboxItem::Push { server, .. } | OutboxItem::Dissolved { server, .. } => server,
            OutboxItem::Leave { owner, .. } | OutboxItem::Rename { owner, .. } | OutboxItem::Outside { owner, .. } => owner,
        }
    }

    fn is_push_to(&self, to: &str, of: &str) -> bool {
        matches!(self, OutboxItem::Push { server, gid, .. } if server == to && gid == of)
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OutsideOp { Link(OutsideRef), Unlink(OutsideRef) }

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Delivery { Confirmed, Refused { code: String }, Pending }

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Verdict { Retry, Refused(String) }

/// Entrega um item à máquina dele; o erro decide, por `verdict`, se a fila tenta de novo.
pub trait OutboxSend: Send + Sync {
    fn send<'a>(&'a self, item: &'a OutboxItem) -> BoxFuture<'a, Result<(), PeerError>>;
}

/// Escada da regra "servidor que não responde": depois da última, fica nela.
pub const LADDER: [Duration; 9] = [
    Duration::from_secs(2), Duration::from_secs(5), Duration::from_secs(30), Duration::from_secs(60),
    Duration::from_secs(120), Duration::from_secs(240), Duration::from_secs(300), Duration::from_secs(600),
    Duration::from_secs(1800),
];

/// Só tenta de novo o que passa sozinho (rede, outra máquina em modo `python`, sessão ocupada,
/// limite, token recusado por enquanto, prazo, máquina que ainda não está no `peers.json`); o
/// resto é recusa definitiva com o código de quem recusou.
pub fn verdict(err: &PeerError) -> Verdict {
    match err {
        PeerError::Transport(_) | PeerError::Unknown => Verdict::Retry,
        PeerError::OldVersion => Verdict::Refused("erro_grupo_peer_versao_antiga".into()),
        PeerError::IdentityMismatch { .. } => Verdict::Refused("erro_grupo_identificador_divergente".into()),
        PeerError::Refused { status, detail } => {
            let code = detail.get("code").and_then(Value::as_str);
            let busy = code.is_some_and(|c| c == "session_transfer_busy" || crate::runtime::claude_reopen::busy_message(c).is_some());
            match status {
                401 | 408 | 429 => Verdict::Retry,
                409 if busy => Verdict::Retry,
                503 if code == Some("groups_need_rust_server") => Verdict::Retry,
                _ => Verdict::Refused(code.map_or_else(|| format!("http_{status}"), str::to_owned)),
            }
        }
    }
}

/// Subida da dona: reenvia cada registro dela a cada outra máquina com membro.
pub fn restart_pushes(records: &[GroupRecord], me: &str) -> Vec<OutboxItem> {
    records.iter().filter(|r| r.owner == me).flat_map(|r| {
        let servers: BTreeSet<&str> = r.members.iter().map(|m| m.server.as_str()).filter(|s| *s != me).collect();
        servers.into_iter().map(|server| OutboxItem::Push {
            server: server.to_owned(), gid: r.gid.clone(), version: r.version, joining: Vec::new(), origin: me.to_owned(),
        }).collect::<Vec<_>>()
    }).collect()
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Entry { id: u64, item: OutboxItem }

#[derive(Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct OutboxFile { next: u64, items: Vec<Entry> }

/// Resultado do último `Push` entregue ou recusado por (máquina, gid), para o `wait`.
#[derive(Default)]
struct Outcome { confirmed: Option<u64>, refused: Option<(u64, String)> }

/// O trabalhador de um destino: `wake` interrompe a espera, `reset` zera a escada.
#[derive(Default)]
struct Slot { wake: Notify, reset: AtomicBool }

#[derive(Default)]
struct State { next: u64, items: Vec<Entry>, workers: HashMap<String, Arc<Slot>>, outcomes: HashMap<(String, String), Outcome> }

struct Inner {
    path: PathBuf,
    sender: Arc<dyn OutboxSend>,
    ladder: Vec<Duration>,
    runtime: tokio::runtime::Handle,
    state: Mutex<State>,
    /// Acorda quem espera no `wait` a cada entrega ou recusa.
    settled: Notify,
}

#[derive(Clone)]
pub struct Outbox { inner: Arc<Inner> }

impl Outbox {
    /// Abre a fila em `dir` (a pasta `groups/`) e já põe para andar o que ficou no disco.
    /// Precisa de um runtime tokio; arquivo torto é erro, nunca fila vazia calada.
    pub fn open(dir: PathBuf, sender: Arc<dyn OutboxSend>) -> io::Result<Outbox> {
        Self::open_with_ladder(dir, sender, LADDER.to_vec())
    }

    pub fn open_with_ladder(dir: PathBuf, sender: Arc<dyn OutboxSend>, ladder: Vec<Duration>) -> io::Result<Outbox> {
        let path = dir.join(format!("{OUTBOX_STEM}.json"));
        let file: OutboxFile = match std::fs::read(&path) {
            Ok(raw) => serde_json::from_slice(&raw).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?,
            Err(e) if e.kind() == io::ErrorKind::NotFound => OutboxFile::default(),
            Err(e) => return Err(e),
        };
        // `next` torto não pode repetir id de item vivo.
        let next = file.items.iter().map(|e| e.id + 1).max().unwrap_or(0).max(file.next);
        let ladder = if ladder.is_empty() { LADDER.to_vec() } else { ladder };
        let outbox = Outbox { inner: Arc::new(Inner {
            path, sender, ladder, runtime: tokio::runtime::Handle::current(),
            state: Mutex::new(State { next, items: file.items, ..State::default() }), settled: Notify::new(),
        }) };
        let mut state = outbox.inner.lock();
        let destinations: BTreeSet<String> = state.items.iter().map(|e| e.item.destination().to_owned()).collect();
        for dest in destinations { outbox.inner.start(&mut state, &dest); }
        drop(state);
        Ok(outbox)
    }

    /// Grava os itens com as regras de coalescência e acorda o trabalhador de cada destino, com a
    /// escada zerada. Escreve em disco: chamar de contexto que pode bloquear (sob o lock de grupo).
    pub fn enqueue(&self, items: Vec<OutboxItem>) -> io::Result<()> {
        let mut state = self.inner.lock();
        let (mut queue, mut next) = (state.items.clone(), state.next);
        let mut touched = BTreeSet::new();
        for item in items {
            touched.insert(item.destination().to_owned());
            match item {
                OutboxItem::Push { ref server, ref gid, version, ref joining, ref origin } if joining.is_empty() => {
                    let pending = queue.iter_mut().rev().find(|e| e.item.is_push_to(server, gid));
                    if let Some(Entry { item: OutboxItem::Push { version: v, origin: o, .. }, .. }) = pending {
                        *v = (*v).max(version);
                        o.clone_from(origin);
                        continue;
                    }
                }
                OutboxItem::Dissolved { ref server, ref gid, .. } => queue.retain(|e| !e.item.is_push_to(server, gid)),
                _ => {}
            }
            queue.push(Entry { id: next, item });
            next += 1;
        }
        self.inner.persist(&queue, next)?;
        (state.items, state.next) = (queue, next);
        for dest in touched { self.inner.start(&mut state, &dest); }
        Ok(())
    }

    /// Tira `member` do `joining` de todo `Push` pendente para (`server`, `gid`).
    pub fn cancel_joining(&self, server: &str, gid: &str, member: &str) -> io::Result<()> {
        let mut state = self.inner.lock();
        let mut queue = state.items.clone();
        for entry in &mut queue {
            if let OutboxItem::Push { server: s, gid: g, joining, .. } = &mut entry.item && s == server && g == gid {
                joining.retain(|m| m != member);
            }
        }
        self.inner.persist(&queue, state.next)?;
        state.items = queue;
        Ok(())
    }

    /// Espera o `Push` de (`server`, `gid`) com versão `version` ou maior ser entregue ou recusado;
    /// no prazo, `Pending` (continua na fila).
    pub async fn wait(&self, server: &str, gid: &str, version: u64, deadline: Duration) -> Delivery {
        let key = (server.to_owned(), gid.to_owned());
        let check = || {
            let state = self.inner.lock();
            let outcome = state.outcomes.get(&key)?;
            if outcome.confirmed.is_some_and(|v| v >= version) { return Some(Delivery::Confirmed); }
            outcome.refused.as_ref().filter(|(v, _)| *v >= version).map(|(_, code)| Delivery::Refused { code: code.clone() })
        };
        let wait = async {
            loop {
                let settled = self.inner.settled.notified();
                tokio::pin!(settled);
                settled.as_mut().enable();
                if let Some(delivery) = check() { return delivery; }
                settled.await;
            }
        };
        tokio::time::timeout(deadline, wait).await.unwrap_or(Delivery::Pending)
    }

    /// Itens ainda na fila, em ordem.
    pub fn pending(&self) -> Vec<OutboxItem> { self.inner.lock().items.iter().map(|e| e.item.clone()).collect() }

    /// Destinos com trabalhador vivo.
    pub fn workers(&self) -> Vec<String> {
        let mut found: Vec<String> = self.inner.lock().workers.keys().cloned().collect();
        found.sort();
        found
    }
}

impl Inner {
    fn lock(&self) -> MutexGuard<'_, State> { self.state.lock().unwrap_or_else(|e| e.into_inner()) }

    /// Sem fsync: o pior caso de uma queda é reenviar, e o outro lado ignora versão repetida.
    fn persist(&self, items: &[Entry], next: u64) -> io::Result<()> {
        #[derive(Serialize)]
        struct View<'a> { next: u64, items: &'a [Entry] }
        if let Some(dir) = self.path.parent() { std::fs::create_dir_all(dir)?; }
        let body = serde_json::to_vec(&View { next, items }).map_err(io::Error::other)?;
        replace_atomic(&self.path, &body)
    }

    /// Acorda o trabalhador de `dest` zerando a escada, ou cria um.
    fn start(self: &Arc<Self>, state: &mut State, dest: &str) {
        if let Some(slot) = state.workers.get(dest) {
            slot.reset.store(true, Ordering::SeqCst);
            slot.wake.notify_one();
            return;
        }
        let slot = Arc::new(Slot::default());
        state.workers.insert(dest.to_owned(), slot.clone());
        self.runtime.spawn(self.clone().work(dest.to_owned(), slot));
    }

    /// Primeiro item de `dest`; sem item, o trabalhador sai do mapa no mesmo passo.
    fn head(&self, dest: &str, slot: &Arc<Slot>) -> Option<Entry> {
        let mut state = self.lock();
        let found = state.items.iter().find(|e| e.item.destination() == dest).cloned();
        if found.is_none() && state.workers.get(dest).is_some_and(|s| Arc::ptr_eq(s, slot)) {
            state.workers.remove(dest);
        }
        found
    }

    async fn work(self: Arc<Self>, dest: String, slot: Arc<Slot>) {
        let mut step = 0usize;
        while let Some(entry) = self.head(&dest, &slot) {
            let delivery = match self.sender.send(&entry.item).await {
                Ok(()) => Some(Delivery::Confirmed),
                Err(error) => match verdict(&error) {
                    Verdict::Refused(code) => {
                        tracing::warn!(code = "grupos.recusado", server = %dest, refusal = %code, "groups: a outra máquina recusou o item da fila");
                        Some(Delivery::Refused { code })
                    }
                    Verdict::Retry => {
                        if matches!(error, PeerError::Unknown) && crate::warn_limit::allow(Some(&dest), "grupos.peer_desconhecido") {
                            tracing::warn!(code = "grupos.peer_desconhecido", server = %dest, "groups: máquina fora do peers.json, o item fica na fila");
                        }
                        None
                    }
                },
            };
            match delivery {
                Some(delivery) => {
                    step = 0;
                    let inner = self.clone();
                    if let Err(error) = tokio::task::spawn_blocking(move || inner.settle(entry, delivery)).await {
                        tracing::error!(code = "groups_outbox_settle_failed", server = %dest, %error, "groups: a baixa do item da fila não rodou");
                    }
                }
                None => {
                    let delay = self.ladder[step.min(self.ladder.len() - 1)];
                    step += 1;
                    tokio::select! { _ = tokio::time::sleep(delay) => {}, _ = slot.wake.notified() => {} }
                    if slot.reset.swap(false, Ordering::SeqCst) { step = 0; }
                }
            }
        }
    }

    /// Dá baixa no item entregue ou recusado. Item que mudou durante o envio (coalescido ou com
    /// `joining` cortado) fica para a próxima volta.
    fn settle(&self, sent: Entry, delivery: Delivery) {
        let mut state = self.lock();
        if let Some(at) = state.items.iter().position(|e| *e == sent) {
            let mut queue = state.items.clone();
            queue.remove(at);
            if let Err(error) = self.persist(&queue, state.next) {
                // Fica só na memória: na subida o item é reenviado, e versão repetida é ignorada.
                tracing::warn!(code = "groups_outbox_write_failed", %error, "groups: a baixa da fila não foi ao disco");
            }
            state.items = queue;
        }
        if let OutboxItem::Push { server, gid, version, .. } = sent.item {
            let outcome = state.outcomes.entry((server, gid)).or_default();
            match delivery {
                Delivery::Confirmed => outcome.confirmed = Some(outcome.confirmed.unwrap_or(0).max(version)),
                Delivery::Refused { code } => outcome.refused = Some((version, code)),
                Delivery::Pending => {}
            }
        }
        drop(state);
        self.settled.notify_waiters();
    }
}
