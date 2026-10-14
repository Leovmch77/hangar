//! Pedido do dono, do convidado ou do Connect que entrou pelas portas do Python, já autenticado e
//! filtrado lá, para uma rota que o Rust atende. O caminho original vem em `x-hangar-path`.
use std::net::SocketAddr;
use std::sync::Arc;

use axum::extract::{ConnectInfo, Request, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde_json::json;

use crate::routes::AppState;

pub async fn private(State(st): State<Arc<AppState>>, ConnectInfo(peer): ConnectInfo<SocketAddr>, mut req: Request) -> Response {
    if !crate::workspace_routes::private_ok(&st, peer, req.headers()) {
        return StatusCode::NOT_FOUND.into_response();
    }
    // O Starlette manda o caminho já decodificado: cada segmento volta a ser escapado, senão um
    // nome de sessão com espaço não vira URI e um `%` seria decodificado duas vezes.
    let Some(path) = req.headers().get("x-hangar-path").and_then(|v| std::str::from_utf8(v.as_bytes()).ok())
        .filter(|p| p.starts_with("/api/"))
        .map(|p| p.split('/').map(crate::groups::exit::segment).collect::<Vec<_>>().join("/"))
    else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    let catalog = req.method() == axum::http::Method::GET && path == crate::claude_customizations::CATALOG_PATH;
    if !catalog && !crate::plans::routes::matches(req.method(), &path) {
        return crate::session_write::json_response(StatusCode::NOT_FOUND, json!({"code": "forwarded_route_not_owned"}));
    }
    let target = match req.uri().query() {
        Some(query) => format!("{path}?{query}"),
        None => path,
    };
    let Ok(uri) = target.parse() else { return StatusCode::BAD_REQUEST.into_response() };
    *req.uri_mut() = uri;
    req.headers_mut().remove("x-hangar-internal");
    req.headers_mut().remove("x-hangar-path");
    if catalog { crate::claude_customizations::public_catalog(&st, req).await } else { crate::plans::routes::serve(&st, req).await }
}
