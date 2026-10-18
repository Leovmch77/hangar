use super::{feed_bytes, int, load, nesting, run_with_stack, serialize};
use crate::routes::AppState;
use axum::{
    body::Body,
    extract::{ConnectInfo, Request, State},
    http::{Method, StatusCode},
    response::Response,
};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use std::path::Path;
use std::{net::SocketAddr, sync::Arc, time::Duration};
pub fn matches(method: &Method, path: &str) -> bool {
    *method == Method::GET && exec_id(path).is_some()
}
fn exec_id(path: &str) -> Option<String> {
    let raw = path.strip_prefix("/api/orq/")?.strip_suffix("/conductor")?;
    let id = percent_encoding::percent_decode_str(raw)
        .decode_utf8()
        .ok()?
        .into_owned();
    (!id.is_empty() && !id.contains('/')).then_some(id)
}
fn valid_id(id: &str) -> bool {
    !id.is_empty() && !matches!(id, "." | "..") && !id.contains(['/', '\\', ':', '\0'])
}
pub async fn public(
    State(st): State<Arc<AppState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    req: Request,
) -> Response {
    let (forward, owner) = crate::routes::gate(&st, peer, &req);
    if !owner || req.method() != Method::GET {
        return crate::routes::pass(&st, req, &forward).await;
    }
    let headers = req.headers().clone();
    let mut response = serve(&st, req).await;
    crate::routes::cors(&headers, response.headers_mut());
    response
}
fn failure(status: StatusCode, code: &str, message: &str) -> Response {
    crate::session_write::json_response(
        status,
        crate::session_write::detail_body(code, message, json!({})),
    )
}
fn missing() -> Response {
    failure(
        StatusCode::NOT_FOUND,
        "erro_nao_encontrado",
        "execução não encontrada",
    )
}
fn valid_watchdog(value: &Value, marker: &str) -> bool {
    let Some(fields) = value.as_object() else {
        return false;
    };
    [
        "alive",
        "last_cycle",
        "since",
        "restarts",
        "unit",
        "unit_state",
        "arbiter",
        "watching",
        "source",
    ]
    .iter()
    .all(|key| fields.contains_key(*key))
        && value["alive"].is_boolean()
        && matches!(
            value["source"].as_str(),
            Some("heartbeat" | "systemd" | "none" | "unavailable")
        )
        && value["watching"]
            .as_array()
            .is_some_and(|values| values.iter().all(Value::is_string))
        && ["last_cycle", "since"]
            .iter()
            .all(|key| value[*key].is_null() || value[*key].is_string())
        && (value["restarts"].is_null() || !int(&value["restarts"], marker).is_null())
}
fn facts(raw: Vec<u8>) -> Result<(String, Vec<u8>), &'static str> {
    let text = String::from_utf8(raw).map_err(|_| "orq_conductor_facts_invalid")?;
    run_with_stack(nesting(&text), move || {
        let baseline = load(&text, "")
            .ok_or("orq_conductor_facts_invalid")?
            .to_string();
        let mut marker = super::MARK.to_owned();
        while baseline.contains(&marker) {
            marker.push('#')
        }
        let value = load(&text, &marker).ok_or("orq_conductor_facts_invalid")?;
        let path = value["path"]
            .as_str()
            .filter(|path| Path::new(path).is_absolute())
            .ok_or("orq_conductor_facts_invalid")?
            .to_owned();
        if !valid_watchdog(&value["watchdog"], &marker) {
            return Err("orq_conductor_facts_invalid");
        }
        Ok((path, serialize(&value["watchdog"], &marker)?))
    })
}
pub async fn serve(st: &Arc<AppState>, req: Request) -> Response {
    let Some(id) = exec_id(req.uri().path()).filter(|id| valid_id(id)) else {
        return missing();
    };
    let url = format!(
        "http://{}/internal/orq/{}/conductor-facts",
        st.cfg.upstream,
        crate::groups::exit::segment(&id)
    );
    let request = axum::http::Request::get(url)
        .header("x-hangar-internal", &st.cfg.internal_secret)
        .body(Body::empty())
        .unwrap();
    let work = async {
        let response = st
            .http
            .request(request)
            .await
            .map_err(|_| "orq_conductor_facts_unreachable")?;
        if response.status() == StatusCode::NOT_FOUND {
            return Ok(None);
        }
        if response.status() != StatusCode::OK {
            return Err("orq_conductor_facts_status");
        }
        let raw = response
            .into_body()
            .collect()
            .await
            .map_err(|_| "orq_conductor_facts_body")?
            .to_bytes();
        let facts = tokio::task::spawn_blocking(move || facts(raw.to_vec()))
            .await
            .map_err(|_| "orq_conductor_facts_invalid")??;
        Ok(Some(facts))
    };
    let (path, watchdog) = match tokio::time::timeout(Duration::from_secs(5), work).await {
        Ok(Ok(Some(facts))) => facts,
        Ok(Ok(None)) => return missing(),
        outcome => {
            let code = match outcome {
                Ok(Err(code)) => code,
                _ => "orq_conductor_facts_timeout",
            };
            st.diag.report(
                "rust.orq_conductor_failed",
                &id,
                code,
                "fatos do condutor indisponíveis",
            );
            return failure(
                StatusCode::SERVICE_UNAVAILABLE,
                code,
                "Não foi possível consultar o condutor.",
            );
        }
    };
    match tokio::task::spawn_blocking(move || feed_bytes(Path::new(&path), watchdog)).await {
        Ok(Ok(bytes)) => axum::response::Response::builder()
            .status(StatusCode::OK)
            .header(axum::http::header::CONTENT_TYPE, "application/json")
            .body(Body::from(bytes))
            .unwrap(),
        outcome => {
            let code = match outcome {
                Ok(Err(code)) => code,
                _ => "orq_conductor_feed_failed",
            };
            st.diag.report(
                "rust.orq_conductor_failed",
                &id,
                code,
                "feed do condutor ilegível",
            );
            failure(
                StatusCode::INTERNAL_SERVER_ERROR,
                code,
                "Não foi possível ler o feed do condutor.",
            )
        }
    }
}
