//! Convidado repassado ao Python: cabeçalho assinado, limpeza do pedido e vigia do WebSocket.
use std::collections::HashMap;

use axum::body::Body;
use axum::extract::Request;
use axum::http::{HeaderValue, header};
use base64::Engine;
use hangar_server::share::caller::GuestGrant;
use hangar_server::share::forward::{pipe_watched, prepare_guest_request, sign};
use hangar_server::share::store::Kind;
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const SECRET: &str = "segredo-de-teste";

fn grant(sessions: &[(&str, Kind)]) -> GuestGrant {
    GuestGrant {
        token: "T".into(),
        token_hash: "h".into(),
        sessions: sessions.iter().map(|(n, k)| (n.to_string(), *k)).collect::<HashMap<_, _>>(),
        pair_roots: vec![],
        invite: sessions.iter().any(|(_, k)| *k == Kind::Share),
    }
}

fn header_str(v: &HeaderValue) -> String {
    v.to_str().unwrap().to_owned()
}

#[test]
fn header_is_payload_dot_hmac_over_method_path_payload() {
    let v = header_str(&sign(SECRET, "GET", "/api/sessions/a/history", &grant(&[("a", Kind::Share), ("b", Kind::Pair)]), 1000));
    let (payload, mac) = v.split_once('.').unwrap();
    let decoded = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(payload).unwrap();
    let body: Value = serde_json::from_slice(&decoded).unwrap();
    assert_eq!(body, json!({"s": {"a": "share", "b": "pair"}, "exp": 1030}));
    let key = ring::hmac::Key::new(ring::hmac::HMAC_SHA256, SECRET.as_bytes());
    let expected: String = ring::hmac::sign(&key, format!("GET\n/api/sessions/a/history\n{payload}").as_bytes())
        .as_ref().iter().map(|b| format!("{b:02x}")).collect();
    assert_eq!(mac, expected);
    // Mesmo vetor do `backend/tests/test_guest_header.py`: o Python confere exatamente isto.
    assert_eq!(v, "eyJzIjp7ImEiOiJzaGFyZSIsImIiOiJwYWlyIn0sImV4cCI6MTAzMH0.\
        96ab57f26c382e25a8c37a7f0956a26b80f43f723322cd992795c0968675a265");
}

#[test]
fn signature_changes_with_method_path_sessions_and_expiry() {
    let g = grant(&[("a", Kind::Share)]);
    let base = header_str(&sign(SECRET, "GET", "/api/sessions/a", &g, 1000));
    assert_ne!(base, header_str(&sign(SECRET, "POST", "/api/sessions/a", &g, 1000)));
    assert_ne!(base, header_str(&sign(SECRET, "GET", "/api/sessions/b", &g, 1000)));
    assert_ne!(base, header_str(&sign(SECRET, "GET", "/api/sessions/a", &grant(&[("a", Kind::Pair)]), 1000)));
    assert_ne!(base, header_str(&sign(SECRET, "GET", "/api/sessions/a", &g, 1001)));
    assert_ne!(base, header_str(&sign("outro", "GET", "/api/sessions/a", &g, 1000)));
    assert_eq!(base, header_str(&sign(SECRET, "GET", "/api/sessions/a", &g, 1000)));
}

fn request(uri: &str) -> Request {
    Request::builder().method("GET").uri(uri)
        .header(header::AUTHORIZATION, "Bearer T")
        .header("x-hangar-guest", "forjado")
        .body(Body::empty()).unwrap()
}

#[test]
fn prepare_removes_token_and_authorization_keeping_other_params_raw() {
    let g = grant(&[("a b", Kind::Share)]);
    let mut req = request("/api/sessions/a%20b/nav-remoto?foo=a%20b&token=T&bar=%2F+x&token=U");
    prepare_guest_request(&mut req, SECRET, &g, 1000);
    assert_eq!(req.uri().path(), "/api/sessions/a%20b/nav-remoto");
    assert_eq!(req.uri().query(), Some("foo=a%20b&bar=%2F+x"));
    assert!(req.headers().get(header::AUTHORIZATION).is_none());
    // Assinado sobre o caminho cru, sem a query.
    let expected = sign(SECRET, "GET", "/api/sessions/a%20b/nav-remoto", &g, 1000);
    assert_eq!(req.headers().get("x-hangar-guest"), Some(&expected));
}

#[test]
fn prepare_drops_query_left_empty_and_query_is_not_signed() {
    let g = grant(&[("a", Kind::Share)]);
    let mut only_token = request("/api/sessions/a/events?token=T");
    prepare_guest_request(&mut only_token, SECRET, &g, 1000);
    assert_eq!(only_token.uri().to_string(), "/api/sessions/a/events");
    let mut other = request("/api/sessions/a/events?x=1");
    prepare_guest_request(&mut other, SECRET, &g, 1000);
    assert_eq!(other.uri().to_string(), "/api/sessions/a/events?x=1");
    assert_eq!(only_token.headers().get("x-hangar-guest"), other.headers().get("x-hangar-guest"));
}

#[tokio::test]
async fn piped_websocket_closes_4410_when_access_ends() {
    let (client_far, client_near) = tokio::io::duplex(1024);
    let (upstream_near, mut upstream_far) = tokio::io::duplex(1024);
    let (end_tx, end_rx) = tokio::sync::oneshot::channel::<()>();
    let pipe = tokio::spawn(pipe_watched(client_near, upstream_near, async move { let _ = end_rx.await; }));
    let mut client = client_far;
    // Antes do fim, os bytes passam como vieram.
    upstream_far.write_all(b"quadro").await.unwrap();
    let mut buf = [0u8; 6];
    client.read_exact(&mut buf).await.unwrap();
    assert_eq!(&buf, b"quadro");
    end_tx.send(()).unwrap();
    pipe.await.unwrap();
    let mut rest = Vec::new();
    client.read_to_end(&mut rest).await.unwrap();
    // Quadro de fechamento do servidor, sem máscara: 0x88, tamanho 2, código 4410.
    assert_eq!(rest, [0x88, 0x02, 0x11, 0x3A]);
}

#[tokio::test]
async fn piped_websocket_ends_quietly_when_upstream_closes() {
    let (client_far, client_near) = tokio::io::duplex(1024);
    let (upstream_near, upstream_far) = tokio::io::duplex(1024);
    let pipe = tokio::spawn(pipe_watched(client_near, upstream_near, std::future::pending::<()>()));
    drop(upstream_far);
    let mut rest = Vec::new();
    let mut client = client_far;
    client.read_to_end(&mut rest).await.unwrap();
    assert!(rest.is_empty());
    drop(client);
    pipe.await.unwrap();
}
