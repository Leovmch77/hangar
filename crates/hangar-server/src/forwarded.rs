//! Pedido do dono, do convidado ou do Connect que entrou pelas portas do Python, já autenticado e
//! filtrado lá, para uma rota que o Rust atende. O caminho original vem em `x-hangar-path`.
use std::net::SocketAddr;
use std::sync::Arc;

use axum::extract::{ConnectInfo, Request, State};
use axum::http::{Method, StatusCode};
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
    let method = req.method();
    let owned = if method == Method::GET && path == crate::claude_customizations::CATALOG_PATH {
        Owned::Catalog
    } else if method == Method::POST && path == crate::mermaid::PATH {
        Owned::Mermaid
    } else if crate::plans::routes::matches(method, &path) {
        Owned::Plans
    } else {
        return crate::session_write::json_response(StatusCode::NOT_FOUND, json!({"code": "forwarded_route_not_owned"}));
    };
    let target = match req.uri().query() {
        Some(query) => format!("{path}?{query}"),
        None => path,
    };
    let Ok(uri) = target.parse() else { return StatusCode::BAD_REQUEST.into_response() };
    *req.uri_mut() = uri;
    req.headers_mut().remove("x-hangar-internal");
    req.headers_mut().remove("x-hangar-path");
    match owned {
        Owned::Catalog => crate::claude_customizations::public_catalog(&st, req).await,
        Owned::Mermaid => crate::mermaid::serve(&st, req).await,
        Owned::Plans => crate::plans::routes::serve(&st, req).await,
    }
}

/// As rotas do Rust que aceitam o repasse.
enum Owned { Catalog, Mermaid, Plans }
