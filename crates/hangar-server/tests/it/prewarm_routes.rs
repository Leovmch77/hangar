//! `PUT /api/sessions/prewarm` e `DELETE /api/sessions/prewarm/{id}`: só o dono, no Rust; o Connect pela ponte.
use serde_json::{Value, json};

use crate::fake::*;

const REFUSED: &str = r#"{"cwd":"/nao/existe","provider":"claude","headless":true}"#;

async fn body(response: reqwest::Response) -> Value { serde_json::from_str(&response.text().await.unwrap()).unwrap() }

fn with_client(body: &str) -> String {
    let mut value: Value = serde_json::from_str(body).unwrap();
    value["client_id"] = json!("tela-1");
    value.to_string()
}

/// Quem não é o dono segue ao Python, como no Mermaid: ele dá 403 ao convidado e 401 a quem não tem credencial.
#[tokio::test]
async fn not_the_owner_goes_to_python() {
    let (python, upstream) = spawn_fake().await;
    let srv = spawn_server(config(upstream, "127.0.0.1")).await;
    for token in [None, Some("convidado")] {
        let put = client().put(format!("http://{srv}/api/sessions/prewarm")).header("content-type", "application/json").body(with_client(REFUSED));
        let put = match token { Some(t) => put.bearer_auth(t), None => put };
        assert_eq!(put.send().await.unwrap().text().await.unwrap(), "from-python", "token {token:?}");
        let delete = client().delete(format!("http://{srv}/api/sessions/prewarm/abc"));
        let delete = match token { Some(t) => delete.bearer_auth(t), None => delete };
        assert_eq!(delete.send().await.unwrap().text().await.unwrap(), "from-python", "token {token:?}");
    }
    assert_eq!(python.hits_to("/api/sessions/prewarm"), 2);
    assert_eq!(python.hits_to("/api/sessions/prewarm/abc"), 2);
}

/// A recusa é a da abertura: mesmo status e mesmo corpo do `POST /api/sessions` para o mesmo pedido.
#[tokio::test]
async fn a_refused_reserve_answers_like_the_open() {
    let (python, upstream) = spawn_fake().await;
    let srv = spawn_server(config(upstream, "127.0.0.1")).await;
    let send = |method: reqwest::Method, path: &'static str, body: String| client().request(method, format!("http://{srv}{path}"))
        .bearer_auth(OWNER).header("content-type", "application/json").body(body).send();
    let open = send(reqwest::Method::POST, "/api/sessions", REFUSED.into()).await.unwrap();
    let reserve = send(reqwest::Method::PUT, "/api/sessions/prewarm", with_client(REFUSED)).await.unwrap();
    assert_eq!(reserve.status(), open.status());
    assert_eq!(reserve.status(), 400);
    let (open, reserve) = (body(open).await, body(reserve).await);
    assert_eq!(reserve["detail"]["code"], "erro_cwd_inexistente");
    assert_eq!(reserve, open);

    // Corpo torto é 422 `erro_corpo_invalido`: sem client_id, com nome, com prompt, campo desconhecido.
    for raw in [REFUSED.to_owned(), with_client(r#"{"cwd":"/x","name":"s1"}"#), with_client(r#"{"cwd":"/x","initial_prompt":"oi"}"#),
                with_client(r#"{"cwd":"/x","bogus":1}"#), "nem json".to_owned()] {
        let resp = send(reqwest::Method::PUT, "/api/sessions/prewarm", raw.clone()).await.unwrap();
        assert_eq!(resp.status(), 422, "{raw}");
        assert_eq!(body(resp).await["detail"]["code"], "erro_corpo_invalido", "{raw}");
    }
    // Fora do escopo da reserva: o código próprio dela.
    let terminal = send(reqwest::Method::PUT, "/api/sessions/prewarm", with_client(r#"{"cwd":"/x","headless":false}"#)).await.unwrap();
    assert_eq!(terminal.status(), 422);
    assert_eq!(body(terminal).await["detail"]["code"], "erro_prewarm_nao_suportado");

    let gone = client().delete(format!("http://{srv}/api/sessions/prewarm/nao-existe")).bearer_auth(OWNER).send().await.unwrap();
    assert_eq!(gone.status(), 204, "inexistente também é 204");
    assert_eq!(python.hits_to("/api/sessions/prewarm"), 0);
}

/// O dono do Connect chega ao Python, que o autentica e repassa pela ponte privada.
#[tokio::test]
async fn connect_owner_comes_through_the_private_bridge() {
    let (_python, upstream) = spawn_fake().await;
    let state = std::sync::Arc::new(hangar_server::routes::AppState::new(config(upstream, "127.0.0.1")));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let private = listener.local_addr().unwrap();
    let app = hangar_server::routes::terminal_router(state).into_make_service_with_connect_info::<std::net::SocketAddr>();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let bridged = |method: reqwest::Method, path: &'static str| client().request(method, format!("http://{private}/__hangar_server/forwarded"))
        .header("x-hangar-path", path).header("content-type", "application/json");

    let refused = bridged(reqwest::Method::PUT, "/api/sessions/prewarm").header("x-hangar-internal", SECRET)
        .body(with_client(REFUSED)).send().await.unwrap();
    assert_eq!(refused.status(), 400);
    assert_eq!(body(refused).await["detail"]["code"], "erro_cwd_inexistente");
    let gone = bridged(reqwest::Method::DELETE, "/api/sessions/prewarm/nao-existe").header("x-hangar-internal", SECRET).send().await.unwrap();
    assert_eq!(gone.status(), 204);
    assert_eq!(bridged(reqwest::Method::DELETE, "/api/sessions/prewarm/x").send().await.unwrap().status(), 404, "sem o segredo a ponte não existe");
}
