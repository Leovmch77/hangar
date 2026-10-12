//! Saída de um grupo e o aviso a quem está em outra máquina (`_avisar_saida`, api.py), sempre
//! depois de soltar o lock: o disco é do `GroupService::leave`, a rede é daqui.
use percent_encoding::{AsciiSet, NON_ALPHANUMERIC, utf8_percent_encode};
use serde_json::{Value, json};

use super::local::is_remote;
use super::service::{GroupError, GroupService};
use crate::routes::AppState;
use crate::share::pair_routes::{Direct, end_pair};

pub(crate) const NO_SERVER_ID: &str = "CP_SERVER_ID ausente no backend/.env — obrigatório pra pareamento cross-server (é o endereço de resposta srv::sessao)";

/// Segmento de caminho como o app mandaria: só os não reservados ficam crus.
const SEGMENT: &AsciiSet = &NON_ALPHANUMERIC.remove(b'_').remove(b'.').remove(b'-').remove(b'~');

pub(crate) fn segment(name: &str) -> String { utf8_percent_encode(name, SEGMENT).to_string() }

/// `{sessao, erro}` de cada aviso que não saiu.
fn failed(p: &str, code: &str, msg: String, params: Value) -> Value {
    json!({"sessao": p, "erro": {"code": code, "params": params, "msg": msg}})
}

/// `GroupService::leave` e o aviso a cada ex-companheiro de fora: (ex-companheiros, falhas).
pub async fn leave_and_notify(st: &AppState, groups: &GroupService, name: &str) -> Result<(Vec<String>, Vec<Value>), GroupError> {
    let ex = groups.leave(name).await?;
    let warnings = notify_exit(st, groups, name, &ex).await;
    Ok((ex, warnings))
}

/// Par externo: avisa o outro lado e apaga registro e convite aqui mesmo. Máquina própria: o
/// `/unpair-remote` dela. Locais não são avisados (recado para quem saiu volta "sessão não encontrada").
pub async fn notify_exit(st: &AppState, groups: &GroupService, name: &str, ex: &[String]) -> Vec<Value> {
    let mut errs = Vec::new();
    for p in ex.iter().filter(|p| is_remote(p)) {
        // `name` pode ser o stem saneado (sessão morta): o fim do par acha o registro pelos dois.
        if let Some(share) = &st.share {
            if let Some(found) = end_pair(st, share, &Direct, name, p).await {
                errs.extend(found);
                continue;
            }
        } else {
            // Sem as lojas de convite o par externo não tem quem o desfaça; nunca vira máquina própria.
            let (dir, owner, address) = (groups.pair_root().to_path_buf(), name.to_owned(), p.clone());
            let external = tokio::task::spawn_blocking(move || crate::list::links::external_local_session(&owner, &[address], &dir))
                .await.unwrap_or(None);
            if external.is_some() {
                errs.push(failed(p, "erro_peer_nao_avisado", "share_unavailable".into(), json!({"peer": p})));
                continue;
            }
        }
        if groups.server_id().is_empty() {
            errs.push(failed(p, "erro_pareamento_server_id_ausente", NO_SERVER_ID.into(), json!({})));
            continue;
        }
        let (srv, sess) = p.split_once("::").unwrap_or((p, ""));
        let body = json!({"peer": format!("{}::{name}", groups.server_id())});
        if let Err(e) = st.peers.call(srv, reqwest::Method::POST, &format!("/api/sessions/{}/unpair-remote", segment(sess)), Some(&body)).await {
            // O sidecar de lá fica órfão até alguém desparear lá.
            tracing::warn!(code = "groups_peer_not_notified", session = name, server = srv, "groups: máquina do ex-companheiro não avisada da saída");
            errs.push(failed(p, "erro_peer_nao_avisado", e.text(srv), json!({"peer": p})));
        }
    }
    errs
}
