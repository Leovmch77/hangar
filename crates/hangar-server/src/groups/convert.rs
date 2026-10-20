//! Par 1:1 antigo entre máquinas (sidecar sem `fed` com um só peer `srv::x`) vira grupo entre
//! máquinas sozinho (I-8B). As duas pontas chegam à mesma dona (menor `server_id`) e ao mesmo
//! `gid` sem conversar; só a dona age, e só grava depois de a outra confirmar. Máquina antiga ou
//! que não responde: o par segue 1:1 e a dona tenta de novo na próxima subida.
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Arc;

use axum::http::StatusCode;
use serde_json::{Value, json};

use super::exit::segment;
use super::federation::{PushBody, Refusal};
use super::local::is_remote;
use super::model::{Fed, GroupRecord, Member, PROTOCOL, Sidecar};
use super::outbox::OutboxItem;
use super::peers::PeerError;
use super::routes::outside_addresses;
use super::service::GroupService;
use super::store::{PairDir, StoreError};
use crate::routes::AppState;
use crate::session_write::detail_body;

/// `gid` do par convertido: 12 hex do sha1 dos dois nomes qualificados, em ordem de bytes.
pub fn group_id(a: &str, b: &str) -> String {
    let (lo, hi) = if a <= b { (a, b) } else { (b, a) };
    sha1_smol::Sha1::from(format!("{lo}\n{hi}")).digest().to_string()[..12].to_owned()
}

fn pair_dir(groups: &GroupService) -> PairDir { PairDir::new(groups.pair_root().to_path_buf(), PathBuf::new()) }

/// `name` daqui em par antigo com `remote` da máquina `server` (chave do `peers.json`).
struct Legacy { name: String, server: String, remote: String, sidecar: Sidecar }

/// Pares antigos desta máquina (`names` vazio = todos) e os ambíguos com par de fora.
fn find(dir: &PairDir, peers: &HashSet<String>, aliases: &HashSet<String>, outside: &HashSet<String>, names: &[String]) -> (Vec<Legacy>, Vec<String>) {
    let all = match dir.sidecars() {
        Ok(all) => all,
        Err(error) => { tracing::warn!(code = "groups_convert_unreadable", %error, "groups: os pares antigos não foram lidos"); return (Vec::new(), Vec::new()) }
    };
    let (mut found, mut ambiguous) = (Vec::new(), Vec::new());
    for (name, s) in all {
        if !names.is_empty() && !names.contains(&name) { continue; }
        let [peer] = s.peers.as_slice() else { continue };
        if s.fed.is_some() || s.orq || !is_remote(peer) { continue; }
        let Some((server, remote)) = peer.split_once("::") else { continue };
        if !peers.contains(server) { continue; }
        // Apelido de par de fora igual ao nome da máquina: não dá para saber qual dos dois é.
        if aliases.contains(server) || outside.contains(peer)
            || crate::list::links::external_local_session(&name, std::slice::from_ref(peer), dir.root()).is_some() {
            ambiguous.push(name);
            continue;
        }
        found.push(Legacy { server: server.to_owned(), remote: remote.to_owned(), name, sidecar: s });
    }
    (found, ambiguous)
}

/// Converte os pares antigos desta máquina em que ela é a dona. Falha só ao log e ao diário.
pub async fn run(st: &Arc<AppState>, groups: &Arc<GroupService>, names: &[String]) {
    let me = groups.server_id().to_owned();
    if me.is_empty() { return; }
    let peers = st.peers.ids();
    let aliases: HashSet<String> = st.share.as_ref().map(|s| s.pairs.all().into_iter().map(|r| r.alias).collect()).unwrap_or_default();
    let (outside, dir, names) = (outside_addresses(st), pair_dir(groups), names.to_vec());
    let Ok((found, ambiguous)) = tokio::task::spawn_blocking(move || find(&dir, &peers, &aliases, &outside, &names)).await else { return };
    for name in &ambiguous {
        st.diag.report("rust.grupos_conversao_ambigua", name, "grupos_conversao_ambigua", "par 1:1 antigo que também parece par de fora; não convertido");
    }
    // Chave igual ao id (conferido abaixo) dá a mesma dona que o id: a de chave maior espera a outra.
    for legacy in found.into_iter().filter(|l| me < l.server) {
        convert(st, groups, &me, legacy).await;
    }
}

async fn convert(st: &Arc<AppState>, groups: &Arc<GroupService>, me: &str, l: Legacy) {
    let server = l.server.as_str();
    // A sessão de lá como a máquina de lá a vê: quem atendeu, e se o par ainda é este.
    let seen = match st.peers.call(server, reqwest::Method::GET, &format!("/api/sessions/{}/group", segment(&l.remote)), None).await {
        Ok(Some(body)) => body,
        Ok(None) => return old(server),
        Err(PeerError::Refused { status: 404, detail }) if detail.get("code").is_none() => return old(server),
        Err(error) => {
            tracing::warn!(code = "groups_convert_not_confirmed", %server, error = %error.text(server), "groups: o par antigo não foi conferido na outra máquina");
            return;
        }
    };
    let reported = seen["server_id"].as_str().unwrap_or_default();
    if reported != server {
        st.diag.report("rust.grupos_conversao_identidade", &l.name, "erro_grupo_identificador_divergente", "a chave do peers.json não é o id da outra máquina");
        tracing::warn!(code = "erro_grupo_identificador_divergente", key = %server, %reported, "groups: par antigo não convertido");
        return;
    }
    let (a, b) = (format!("{me}::{}", l.name), format!("{server}::{}", l.remote));
    let gid = group_id(&a, &b);
    let members: Vec<Member> = serde_json::from_value(seen["members"].clone()).unwrap_or_default();
    let back = members.len() == 2 && members.iter().any(|m| m.server == me && m.name == l.name);
    let legacy_there = seen["owner"] == server && seen["version"] == 0;
    let converted_there = seen["owner"] == me && seen["gid"] == gid.as_str();
    if !back || !(legacy_there || converted_there) {
        tracing::warn!(code = "groups_convert_pair_differs", %server, "groups: a outra máquina não tem o mesmo par antigo; não convertido");
        return;
    }
    let provider = |m: &str| l.sidecar.harness.get(m).cloned().unwrap_or_default();
    let theirs = members.iter().find(|m| m.server == server).map(|m| m.provider.clone()).filter(|p| !p.is_empty()).unwrap_or_else(|| provider(&b));
    let task = l.sidecar.task.clone().unwrap_or_default();
    let record = GroupRecord { protocol: PROTOCOL, gid: gid.clone(), owner: me.into(), version: 1, task: task.clone(),
        members: vec![Member { server: me.into(), name: l.name.clone(), provider: provider(&l.name) }, Member { server: server.into(), name: l.remote.clone(), provider: theirs }],
        outside: Vec::new() };
    let body = json!({"protocol": PROTOCOL, "owner": me, "version": 1, "task": task, "members": record.members, "outside": [], "joining": [],
        "convert_from_legacy": a});
    match st.peers.call_group(server, reqwest::Method::PUT, &format!("/api/groups/{}", segment(&gid)), Some(&body)).await {
        Ok(_) => {}
        Err(PeerError::OldVersion) => return old(server),
        Err(error) => {
            tracing::warn!(code = "groups_convert_not_confirmed", %server, error = %error.text(server), "groups: a outra máquina não confirmou a conversão");
            return;
        }
    }
    // Confirmado: só agora a dona grava registro e `fed`, se o par daqui não mudou no meio.
    let (dir, me_owned, name, peer) = (pair_dir(groups), me.to_owned(), l.name.clone(), b.clone());
    let written = groups.locked(async move {
        tokio::task::spawn_blocking(move || write_owner(&dir, &me_owned, &name, &peer, record)).await
    }).await;
    match written {
        Ok(Ok(Written::Done)) => groups.changed(),
        Ok(Ok(Written::Already)) => {}
        // Id trocado não desfaz o grupo na outra ponta: só o diário diz por quê.
        Ok(Ok(Written::IdChanged)) => tracing::error!(code = "erro_grupo_identificador_trocado", "groups: conversão confirmada não gravada: o CP_SERVER_ID desta máquina mudou"),
        Ok(Ok(Written::Gone)) => {
            // A outra já converteu: o grupo acaba lá também, como acabou aqui.
            tracing::warn!(code = "groups_convert_pair_gone", %server, "groups: o par antigo mudou durante a conversão; o grupo foi desfeito");
            let item = OutboxItem::Dissolved { server: server.to_owned(), gid, version: 2, origin: me.to_owned() };
            match super::federation::of(st, groups).await {
                Ok(fed) => {
                    let outbox = fed.outbox().clone();
                    if !matches!(tokio::task::spawn_blocking(move || outbox.enqueue(vec![item])).await, Ok(Ok(()))) {
                        tracing::error!(code = "groups_convert_undo_failed", %server, "groups: a dissolução da conversão não entrou na fila");
                    }
                }
                Err(_) => tracing::error!(code = "groups_convert_undo_failed", %server, "groups: a dissolução da conversão não entrou na fila"),
            }
        }
        Ok(Err(error)) => tracing::error!(code = "groups_convert_store_failed", %error, "groups: a conversão confirmada não foi gravada; tenta de novo na subida"),
        Err(error) => tracing::error!(code = "groups_convert_store_failed", %error, "groups: a conversão confirmada não foi gravada; tenta de novo na subida"),
    }
}

fn old(server: &str) {
    tracing::info!(code = "groups_convert_old_version", %server, "groups: a outra máquina é de versão antiga; o par segue 1:1");
}

enum Written { Done, Already, Gone, IdChanged }

fn write_owner(dir: &PairDir, me: &str, name: &str, peer: &str, record: GroupRecord) -> Result<Written, StoreError> {
    if dir.identity_check(me)?.is_some() { return Ok(Written::IdChanged); }
    let Some(s) = dir.sidecar(name)? else { return Ok(Written::Gone) };
    if s.gid == record.gid && s.fed.as_ref().is_some_and(|f| f.owner == me) { return Ok(Written::Already); }
    if s.fed.is_some() || s.orq || s.peers != [peer] { return Ok(Written::Gone); }
    dir.write_record(&record)?;
    let converted = Sidecar { task: Some(record.task.clone()), gid: record.gid.clone(), fed: Some(Fed { owner: me.into(), local: true, version: record.version }), ..s };
    if let Err(error) = dir.write_sidecar(name, &converted) {
        if let Err(undo) = dir.remove_record(&record.gid) {
            tracing::error!(code = "groups_record_restore_failed", gid = %record.gid, error = %undo, "groups: o registro da conversão não foi desfeito");
        }
        return Err(error);
    }
    remember(dir, me);
    Ok(Written::Done)
}

fn remember(dir: &PairDir, me: &str) {
    if matches!(dir.self_id(), Ok(None)) && let Err(error) = dir.remember_self(me) {
        tracing::warn!(code = "groups_identity_not_saved", %error, "groups: o id desta máquina não foi gravado");
    }
}

fn differs(name: &str) -> Refusal {
    Refusal(StatusCode::CONFLICT, detail_body("erro_grupo_mudou", &format!("'{name}' não está no par antigo que a dona quer converter"), json!({"membro": name})))
}

/// A participante recebe o `PUT` da dona com `convert_from_legacy`: converte o próprio sidecar se
/// ele é exatamente esse par antigo (ou já é este grupo). Não cria registro nem avisa a sessão.
pub(super) async fn accept(groups: &Arc<GroupService>, gid: &str, body: PushBody, from: String) -> Result<Value, Refusal> {
    let me = groups.server_id().to_owned();
    let (mine, theirs): (Vec<&Member>, Vec<&Member>) = body.members.iter().partition(|m| m.server == me);
    let ([m], [o]) = (mine.as_slice(), theirs.as_slice()) else { return Err(differs(&from)) };
    let (name, owner_side, provider) = (m.name.clone(), o.server.clone(), o.provider.clone());
    let expected = format!("{}::{}", o.server, o.name);
    // Dona e gid recalculados aqui: a regra é a mesma nas duas pontas.
    if body.dissolved || owner_side != body.owner || from != expected || body.owner >= me || group_id(&from, &format!("{me}::{name}")) != gid {
        return Err(differs(&name));
    }
    let (dir, gid_owned, reply_name) = (pair_dir(groups), gid.to_owned(), name.clone());
    let done = groups.locked(async move {
        tokio::task::spawn_blocking(move || -> Result<(u64, bool), Refusal> {
            let store = |error: StoreError| {
                tracing::error!(code = "groups_store_failed", %error, "groups: a conversão do par antigo não foi lida ou gravada");
                Refusal(StatusCode::SERVICE_UNAVAILABLE, detail_body("erro_grupo_indisponivel", "os grupos estão indisponíveis agora", json!({"detalhe": "groups_store_failed"})))
            };
            if let Some(changed) = dir.identity_check(&me).map_err(store)? {
                return Err(Refusal(StatusCode::CONFLICT, detail_body("erro_grupo_identificador_trocado",
                    &format!("o CP_SERVER_ID desta máquina mudou de '{}' para '{}' com grupo entre máquinas vivo", changed.saved, changed.current),
                    json!({"salvo": changed.saved, "atual": changed.current}))));
            }
            let Some(s) = dir.sidecar(&name).map_err(store)? else { return Err(differs(&name)) };
            if let Some(f) = s.fed.as_ref().filter(|f| f.owner == body.owner && s.gid == gid_owned) { return Ok((f.version, false)); }
            if s.fed.is_some() || s.orq || s.peers != [from.clone()] { return Err(differs(&name)); }
            let mut harness = s.harness.clone();
            if !provider.is_empty() { harness.entry(from).or_insert(provider); }
            let converted = Sidecar { task: Some(body.task), gid: gid_owned, harness, fed: Some(Fed { owner: body.owner, local: false, version: body.version }), ..s };
            dir.write_sidecar(&name, &converted).map_err(store)?;
            remember(&dir, &me);
            Ok((body.version, true))
        }).await
    }).await;
    let (version, changed) = done.map_err(|error| {
        tracing::error!(code = "groups_store_failed", %error, "groups: a conversão do par antigo não terminou");
        Refusal(StatusCode::SERVICE_UNAVAILABLE, detail_body("erro_grupo_indisponivel", "os grupos estão indisponíveis agora", json!({"detalhe": "groups_store_failed"})))
    })??;
    if changed { groups.changed(); }
    Ok(json!({"protocol": PROTOCOL, "version": version, "members": [reply_name]}))
}
