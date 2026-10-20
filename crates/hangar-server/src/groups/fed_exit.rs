//! Sair, morrer e renomear em grupo entre máquinas (sidecar com `fed`). A máquina do membro grava
//! na hora e põe o `Leave`/`Rename` na fila no mesmo passo, sob o lock, sem esperar a dona; a dona
//! aplica (`remove_member`) e, quando sobra uma máquina só com membros, dissolve: o registro sai e
//! a máquina que ficou fica com grupo local comum, mesmo gid, com os pares de fora que já tinha.
use std::collections::{BTreeSet, HashSet};
use std::path::PathBuf;

use axum::http::StatusCode;
use serde_json::{Value, json};

use super::federation::{Refusal, of, remove_member};
use super::local::{self, Snapshot, is_remote};
use super::model::{Fed, GroupRecord, Member, PROTOCOL, Sidecar};
use super::outbox::{Outbox, OutboxItem};
use super::routes::{PREFIX, outside_addresses};
use super::service::{GroupError, GroupService};
use super::store::{PairDir, StoreError};
use crate::routes::AppState;
use crate::session_write::detail_body;
use crate::session_write::input::deliver_text;

fn pair_dir(groups: &GroupService) -> PairDir { PairDir::new(groups.pair_root().to_path_buf(), PathBuf::new()) }

fn view(me: &str, who: &Member) -> String { if who.server == me { who.name.clone() } else { format!("{}::{}", who.server, who.name) } }

fn same(a: &Member, b: &Member) -> bool { a.server == b.server && a.name == b.name }

fn member(server: &str, name: &str) -> Member { Member { server: server.into(), name: name.into(), provider: String::new() } }

/// Máquinas com membro no registro (a dona só conta se tiver membro).
fn machines(record: &GroupRecord) -> usize { record.members.iter().map(|m| m.server.as_str()).collect::<BTreeSet<_>>().len() }

fn io_error(e: impl std::fmt::Display) -> GroupError { GroupError::Store(StoreError::Io(std::io::Error::other(e.to_string()))) }

fn refused(Refusal(status, body): Refusal) -> GroupError { io_error(format!("{status} {}", body["detail"]["code"])) }

fn store_refusal(error: impl std::fmt::Display) -> Refusal {
    tracing::error!(code = "groups_store_failed", %error, "groups: o grupo entre máquinas não foi lido ou gravado");
    Refusal(StatusCode::SERVICE_UNAVAILABLE, detail_body("erro_grupo_indisponivel", "os grupos estão indisponíveis agora", json!({"detalhe": "groups_store_failed"})))
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> Result<T, GroupError> {
    tokio::task::spawn_blocking(f).await.map_err(io_error)
}

fn apply(dir: &PairDir, clears: &[String], writes: &[(String, Sidecar)]) -> Result<(), StoreError> {
    for name in clears { dir.clear_sidecar(name)?; }
    for (name, s) in writes { dir.write_sidecar(name, s)?; }
    Ok(())
}

fn restore(dir: &PairDir, before: &Snapshot) {
    for (name, state) in before {
        let done = match state { None => dir.clear_sidecar(name), Some(s) => dir.write_sidecar(name, s) };
        if let Err(error) = done { tracing::warn!(code = "groups_restore_failed", name, %error, "groups: o sidecar não voltou ao estado anterior"); }
    }
}

/// Plano local (`clears`, `writes`, `before`) gravado e o item da fila no mesmo passo; fila que
/// recusa desfaz o disco.
fn apply_and_enqueue(dir: &PairDir, outbox: &Outbox, clears: &[String], writes: &[(String, Sidecar)], before: &Snapshot, item: Option<OutboxItem>) -> Result<(), GroupError> {
    let done = apply(dir, clears, writes).map_err(GroupError::from)
        .and_then(|()| item.map_or(Ok(()), |i| outbox.enqueue(vec![i]).map_err(io_error)));
    if done.is_err() { restore(dir, before); }
    done
}

/// Saída de `name` se o grupo dela é entre máquinas; `None` = grupo comum (segue o caminho local).
/// Devolve os ex-companheiros.
pub async fn leave(st: &AppState, groups: &GroupService, name: &str) -> Option<Result<Vec<String>, GroupError>> {
    let link = groups.link(name).await.ok().flatten()?;
    let fed = link.fed.clone()?;
    let me = groups.server_id().to_owned();
    if fed.owner == me {
        return Some(match remove_and_dissolve(st, groups, &link.gid, &member(&me, name)).await {
            Ok(Some(_)) => Ok(link.peers),
            // Sem registro aqui o grupo não é mais desta dona: sai como grupo comum.
            Ok(None) => groups.leave(name).await,
            Err(r) => Err(refused(r)),
        });
    }
    let outbox = match of(st, groups).await { Ok(f) => f.outbox().clone(), Err(r) => return Some(Err(refused(r))) };
    let (dir, name) = (pair_dir(groups), name.to_owned());
    Some(groups.locked(blocking(move || -> Result<Vec<String>, GroupError> {
        let read = |n: &str| dir.sidecar(n).ok().flatten();
        let Some(link) = read(&name) else { return Ok(Vec::new()) };
        let Some(plan) = local::plan_leave(&read, &name, false) else { return Ok(Vec::new()) };
        // O `Leave` entra junto da saída: um envio da dona no meio do caminho já o vê pendente.
        let item = link.fed.filter(|f| f.owner != me).map(|f| OutboxItem::Leave { owner: f.owner, gid: link.gid.clone(), member: name.clone(), origin: me });
        apply_and_enqueue(&dir, &outbox, &plan.clears, &plan.writes, &plan.before, item)?;
        Ok(plan.ex_peers)
    })).await.and_then(|r| r))
}

/// Dos ex-companheiros, quem o `notify_exit` ainda avisa: sem as máquinas do dono, que a dona avisa
/// pela fila.
pub fn notified(st: &AppState, ex: &[String]) -> Vec<String> {
    let outside = outside_addresses(st);
    ex.iter().filter(|p| !is_remote(p) || outside.contains(*p)).cloned().collect()
}

/// Renomear sessão de grupo entre máquinas; `None` = grupo comum.
pub async fn rename(st: &AppState, groups: &GroupService, old: &str, new: &str) -> Option<Result<(), GroupError>> {
    let fed = groups.link(old).await.ok().flatten()?.fed?;
    let me = groups.server_id().to_owned();
    let outbox = match of(st, groups).await { Ok(f) => f.outbox().clone(), Err(r) => return Some(Err(refused(r))) };
    let (dir, old, new) = (pair_dir(groups), old.to_owned(), new.to_owned());
    let done = groups.locked(blocking(move || -> Result<(), GroupError> {
        let read = |n: &str| dir.sidecar(n).ok().flatten();
        let Some(link) = read(&old) else { return Ok(()) };
        let (clears, writes) = local::plan_rename(&read, &old, &new);
        let before: Snapshot = clears.iter().chain(writes.iter().map(|(n, _)| n)).map(|n| (n.clone(), read(n))).collect();
        // Na participante o `Rename` entra com o disco: o `Push` com o nome velho já o vê pendente.
        let item = (fed.owner != me).then(|| OutboxItem::Rename { owner: fed.owner.clone(), gid: link.gid.clone(), from: old.clone(), to: new.clone(), origin: me.clone() });
        apply_and_enqueue(&dir, &outbox, &clears, &writes, &before, item)?;
        if fed.owner == me
            && let Err(Refusal(status, body)) = owner_rename(&dir, &outbox, &me, &link.gid, &member(&me, &old), &new) {
            restore(&dir, &before);
            return Err(io_error(format!("{status} {}", body["detail"]["code"])));
        }
        Ok(())
    })).await.and_then(|r| r);
    if done.is_ok() { groups.changed(); }
    Some(done)
}

/// Na dona: `from` passa a se chamar `to` no registro e nos sidecars daqui; versão nova a todos.
/// Membro que não está no registro (rename repetido) não muda nada.
fn owner_rename(dir: &PairDir, outbox: &Outbox, me: &str, gid: &str, from: &Member, to: &str) -> Result<u64, Refusal> {
    let Some(mut record) = dir.record(gid).map_err(store_refusal)?.filter(|r| r.owner == me) else { return Ok(0) };
    let Some(m) = record.members.iter_mut().find(|m| same(m, from)) else { return Ok(record.version) };
    m.name = to.to_owned();
    let renamed = m.clone();
    record.version += 1;
    dir.write_record(&record).map_err(store_refusal)?;
    let (old_view, new_view) = (view(me, from), view(me, &renamed));
    for m in record.members.iter().filter(|m| m.server == me) {
        let Some(mut s) = dir.sidecar(&m.name).ok().flatten().filter(|s| s.gid == gid) else { continue };
        for p in s.peers.iter_mut().filter(|p| **p == old_view) { p.clone_from(&new_view); }
        if let Some(provider) = s.harness.remove(&old_view) { s.harness.insert(new_view.clone(), provider); }
        s.fed = Some(Fed { owner: me.into(), local: true, version: record.version });
        dir.write_sidecar(&m.name, &s).map_err(store_refusal)?;
    }
    let servers: BTreeSet<String> = record.members.iter().map(|m| m.server.clone()).filter(|s| s != me).collect();
    outbox.enqueue(servers.into_iter().map(|server| OutboxItem::Push { server, gid: gid.into(), version: record.version, joining: Vec::new(), origin: me.into() }).collect())
        .map_err(store_refusal)?;
    Ok(record.version)
}

/// `op: leave` na dona: `member` de `origin` saiu. Repetido ou de grupo que não existe mais: nada muda.
pub async fn leave_op(st: &AppState, groups: &GroupService, gid: &str, origin: &str, name: &str) -> Result<Value, Refusal> {
    let who = member(origin, name);
    let dir = pair_dir(groups);
    let g = gid.to_owned();
    let current = blocking(move || dir.record(&g)).await.map_err(store_refusal)?.map_err(store_refusal)?;
    let version = match current {
        Some(r) if r.owner == groups.server_id() && r.members.iter().any(|m| same(m, &who)) =>
            remove_and_dissolve(st, groups, gid, &who).await?.map_or(0, |r| r.version),
        Some(r) => r.version,
        None => 0,
    };
    Ok(json!({"protocol": PROTOCOL, "version": version}))
}

/// `op: rename` na dona.
pub async fn rename_op(st: &AppState, groups: &GroupService, gid: &str, origin: &str, from: &str, to: &str) -> Result<Value, Refusal> {
    let me = groups.server_id().to_owned();
    let outbox = of(st, groups).await?.outbox().clone();
    let (dir, gid, from, to) = (pair_dir(groups), gid.to_owned(), member(origin, from), to.to_owned());
    let version = groups.locked(blocking(move || owner_rename(&dir, &outbox, &me, &gid, &from, &to))).await.map_err(store_refusal)??;
    groups.changed();
    Ok(json!({"protocol": PROTOCOL, "version": version}))
}

/// Par 1:1 antigo que a outra máquina ainda desfaz por `/unpair-remote`, num sidecar já `fed`:
/// `peer` (`srv::x`) sai pela dona.
pub async fn peer_left(st: &AppState, groups: &GroupService, link: &Sidecar, peer: &str) -> Result<(), Refusal> {
    let (Some(fed), Some((srv, name))) = (&link.fed, peer.split_once("::")) else { return Ok(()) };
    let who = member(srv, name);
    if fed.owner == groups.server_id() { return remove_and_dissolve(st, groups, &link.gid, &who).await.map(drop); }
    let outbox = of(st, groups).await?.outbox().clone();
    let item = OutboxItem::Leave { owner: fed.owner.clone(), gid: link.gid.clone(), member: who.name, origin: who.server };
    blocking(move || outbox.enqueue(vec![item])).await.map_err(store_refusal)?.map_err(store_refusal)
}

/// `remove_member` e, com uma máquina só com membros, a dissolução. Devolve o registro depois da
/// saída (`None` sem registro desta dona).
pub async fn remove_and_dissolve(st: &AppState, groups: &GroupService, gid: &str, who: &Member) -> Result<Option<GroupRecord>, Refusal> {
    let Some(record) = remove_member(st, groups, gid, who).await? else { return Ok(None) };
    if machines(&record) > 1 { return Ok(Some(record)); }
    let dropped = dissolve(st, groups, gid, &who.server).await?;
    for n in &dropped {
        let text = format!("{PREFIX} Você saiu do grupo de trabalho entre máquinas. Volte a operar independente; use hangar-send só quando o usuário pedir.");
        if let Err(error) = deliver_text(st, n, &text).await {
            tracing::warn!(code = "groups_exit_notice_failed", session = %n, error = %error["code"], "groups: o aviso de saída não chegou");
        }
    }
    Ok(Some(record))
}

/// O registro sai, cada outra máquina recebe `Dissolved` e os sidecars daqui viram grupo local
/// comum (sem `fed`, sem membros de outra máquina, com os pares de fora). Devolve quem ficou sozinho.
/// Dona sem membro próprio continua dona enquanto houver membros em duas máquinas.
async fn dissolve(st: &AppState, groups: &GroupService, gid: &str, gone_server: &str) -> Result<Vec<String>, Refusal> {
    let me = groups.server_id().to_owned();
    let outbox = of(st, groups).await?.outbox().clone();
    let outside: HashSet<String> = outside_addresses(st);
    let (dir, gid, gone_server) = (pair_dir(groups), gid.to_owned(), gone_server.to_owned());
    let dropped = groups.locked(blocking(move || -> Result<Vec<String>, Refusal> {
        // Alguém pode ter entrado entre a saída e aqui.
        let Some(record) = dir.record(&gid).map_err(store_refusal)?.filter(|r| r.owner == me && machines(r) <= 1) else { return Ok(Vec::new()) };
        let mut servers: BTreeSet<String> = record.members.iter().map(|m| m.server.clone()).collect();
        servers.insert(gone_server);
        servers.remove(&me);
        let mut dropped = Vec::new();
        for m in record.members.iter().filter(|m| m.server == me) {
            let Some(mut s) = dir.sidecar(&m.name).ok().flatten().filter(|s| s.gid == gid) else { continue };
            s.fed = None;
            s.peers.retain(|p| !is_remote(p) || outside.contains(p));
            if s.peers.is_empty() && !s.orq {
                dir.clear_sidecar(&m.name).map_err(store_refusal)?;
                dropped.push(m.name.clone());
            } else {
                dir.write_sidecar(&m.name, &s).map_err(store_refusal)?;
            }
        }
        dir.remove_record(&gid).map_err(store_refusal)?;
        let version = record.version + 1;
        outbox.enqueue(servers.into_iter().map(|server| OutboxItem::Dissolved { server, gid: gid.clone(), version, origin: me.clone() }).collect())
            .map_err(store_refusal)?;
        Ok(dropped)
    })).await.map_err(store_refusal)??;
    groups.changed();
    Ok(dropped)
}
