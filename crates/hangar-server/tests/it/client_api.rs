//! `GET /api/client-api`: a versão da API que o app nativo confere; só o dono, atendida no Rust.
use crate::fake::*;

use serde_json::{Value, json};

#[tokio::test]
async fn owner_gets_the_client_api_and_others_get_401_without_python() {
    let (python, upstream) = spawn_fake().await;
    let public = spawn_state(hangar_server::routes::AppState::new(config(upstream, "127.0.0.1"))).await;
    let url = format!("http://{public}/api/client-api");

    let r = client().get(&url).bearer_auth(OWNER).send().await.unwrap();
    assert_eq!(r.status(), 200);
    let body: Value = serde_json::from_str(&r.text().await.unwrap()).unwrap();
    assert_eq!(body, json!({"api": hangar_api::CLIENT_API}));

    for token in [None, Some("convidado")] {
        let mut req = client().get(&url);
        if let Some(token) = token { req = req.bearer_auth(token); }
        assert_eq!(req.send().await.unwrap().status(), 401, "token {token:?}");
    }
    assert_eq!(python.hits_to("/api/client-api"), 0, "a rota nunca chama o Python");
}

/// O dono do Connect chega ao Python, que o autentica e repassa pela ponte privada.
#[tokio::test]
async fn connect_owner_comes_through_the_private_bridge() {
    let (_python, upstream) = spawn_fake().await;
    let state = hangar_server::routes::AppState::new(config(upstream, "127.0.0.1"));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let private = listener.local_addr().unwrap();
    let app = hangar_server::routes::terminal_router(std::sync::Arc::new(state)).into_make_service_with_connect_info::<std::net::SocketAddr>();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let bridged = || client().get(format!("http://{private}/__hangar_server/forwarded")).header("x-hangar-path", "/api/client-api");

    let r = bridged().header("x-hangar-internal", SECRET).send().await.unwrap();
    assert_eq!(r.status(), 200);
    let body: Value = serde_json::from_str(&r.text().await.unwrap()).unwrap();
    assert_eq!(body, json!({"api": hangar_api::CLIENT_API}));
    assert_eq!(bridged().send().await.unwrap().status(), 404, "sem o segredo a ponte não existe");
}
