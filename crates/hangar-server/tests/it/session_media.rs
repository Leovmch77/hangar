use super::fake::{Fake, OWNER, client, spawn_fake};
use axum::http::StatusCode;
use hangar_server::{
    auth::TrustedHosts,
    config::Config,
    locate::{BoxFuture, InfoFailed, Locate},
    routes::{AppState, router},
    transcript::InternalInfo,
};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    net::SocketAddr,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

#[derive(Default)]
struct Sessions(Mutex<HashMap<String, InternalInfo>>);
impl Locate for Sessions {
    fn info<'a>(&'a self, name: &'a str) -> BoxFuture<'a, Result<Option<InternalInfo>, InfoFailed>> {
        Box::pin(async move { Ok(self.0.lock().unwrap().get(name).cloned()) })
    }
}

struct Scene {
    dir: tempfile::TempDir,
    sessions: Arc<Sessions>,
    python: Arc<Fake>,
    address: SocketAddr,
    task: tokio::task::JoinHandle<()>,
}
impl Drop for Scene {
    fn drop(&mut self) {
        self.task.abort();
    }
}
impl Scene {
    async fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let (python, upstream) = spawn_fake().await;
        let cfg = Config {
            listen: "127.0.0.1:0".parse().unwrap(),
            upstream,
            auth_token: OWNER.into(),
            internal_secret: "isolated".into(),
            log_path: None,
            trusted: TrustedHosts::parse("127.0.0.1"),
        };
        let sessions = Arc::new(Sessions::default());
        let mut state = AppState::new(cfg);
        state.side.locate = sessions.clone();
        state.hangar_dir = dir.path().join(".hangar");
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let task = tokio::spawn(async move {
            axum::serve(listener, router(Arc::new(state)).into_make_service_with_connect_info::<SocketAddr>())
                .await
                .unwrap();
        });
        Self { dir, sessions, python, address, task }
    }
    fn progress_file(&self, id: &str) -> PathBuf {
        let dir = self.dir.path().join(".hangar/tool-progress");
        std::fs::create_dir_all(&dir).unwrap();
        dir.join(format!("{id}.jsonl"))
    }
    /// Sessão Claude com o transcript dado.
    fn claude(&self, name: &str, lines: &[Value]) -> PathBuf {
        let path = self.dir.path().join(format!("{name}.jsonl"));
        std::fs::write(&path, lines.iter().map(|l| format!("{l}\n")).collect::<String>()).unwrap();
        self.sessions.0.lock().unwrap().insert(name.into(), info(&path, "claude"));
        path
    }
    async fn get_raw(&self, path: &str) -> reqwest::Response {
        client().get(format!("http://{}{path}", self.address)).bearer_auth(OWNER).send().await.unwrap()
    }
    async fn get(&self, path: &str) -> (StatusCode, Value) {
        let response = self.get_raw(path).await;
        let status = response.status();
        (status, serde_json::from_str(&response.text().await.unwrap()).unwrap_or(Value::Null))
    }
}

fn info(path: &Path, provider: &str) -> InternalInfo {
    serde_json::from_value(json!({"provider": provider, "jsonl": path, "session_key": path.file_stem().unwrap().to_str().unwrap(), "lifecycle_id": "life", "history": {}})).unwrap()
}

// --- tool-progress ---

#[tokio::test]
async fn tool_progress_reads_steps_of_unknown_session_too() {
    let scene = Scene::new().await;
    std::fs::write(
        scene.progress_file("toolu_abc"),
        "{\"t\": 1.5, \"message\": \"abrindo\"}\nnão é json\n[1]\n{\"t\": null, \"message\": 3}\n{\"message\": \"sem t\"}\n",
    )
    .unwrap();
    let (status, body) = scene.get("/api/sessions/qualquer/tool-progress/toolu_abc").await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body, json!([{"t": 1.5, "message": "abrindo"}, {"t": null, "message": "sem t"}]));
}

#[tokio::test]
async fn tool_progress_without_file_is_empty() {
    let scene = Scene::new().await;
    let (status, body) = scene.get("/api/sessions/s/tool-progress/toolu_nada").await;
    assert_eq!((status, body), (StatusCode::OK, json!([])));
}

#[tokio::test]
async fn tool_progress_keeps_last_200_lines_before_dropping_invalid_and_cuts_message_at_500_chars() {
    let scene = Scene::new().await;
    let long = "é".repeat(600);
    let mut text = String::new();
    for i in 0..250 {
        text.push_str(&format!("{{\"t\": {i}, \"message\": \"m{i}\"}}\n"));
    }
    text.push_str("lixo\n");
    text.push_str(&format!("{{\"t\": 999, \"message\": \"{long}\"}}\n"));
    std::fs::write(scene.progress_file("toolu_long"), text).unwrap();
    let (status, body) = scene.get("/api/sessions/s/tool-progress/toolu_long").await;
    assert_eq!(status, StatusCode::OK);
    let items = body.as_array().unwrap();
    // 200 últimas linhas = 198 válidas (52..249) + lixo + a longa.
    assert_eq!(items.len(), 199);
    assert_eq!(items[0], json!({"t": 52, "message": "m52"}));
    assert_eq!(items[198]["message"].as_str().unwrap().chars().count(), 500);
}

#[tokio::test]
async fn tool_progress_rejects_ids_out_of_shape_including_trailing_newline() {
    let scene = Scene::new().await;
    std::fs::write(scene.progress_file("toolu_x\n"), "{\"t\":1,\"message\":\"vazou\"}\n").unwrap_or(());
    for id in ["abc", "toolu_", "toolu_a.b", "toolu_x%0A", &format!("toolu_{}", "a".repeat(81))] {
        let (status, body) = scene.get(&format!("/api/sessions/s/tool-progress/{id}")).await;
        assert_eq!((status, body), (StatusCode::BAD_REQUEST, json!({"detail": "invalid tool_use_id"})), "{id}");
    }
}

#[tokio::test]
async fn tool_progress_skips_lines_that_are_not_utf8() {
    let scene = Scene::new().await;
    let mut bytes = b"{\"t\": 1, \"message\": \"ok\"}\n".to_vec();
    bytes.extend_from_slice(b"{\"t\": 2, \"message\": \"\xff\xfe\"}\n");
    std::fs::write(scene.progress_file("toolu_bin"), bytes).unwrap();
    let (status, body) = scene.get("/api/sessions/s/tool-progress/toolu_bin").await;
    assert_eq!((status, body), (StatusCode::OK, json!([{"t": 1, "message": "ok"}])));
}

// --- transcript-image ---

const PNG: &str = "iVBORw0KGgo=";

fn image_line(uuid: &str, media: &str, data: &str) -> Value {
    json!({"type":"user","uuid":uuid,"timestamp":"2026-09-01T10:00:03.000Z","message":{"role":"user","content":[
        {"type":"text","text":"[Image #1] olha isto"},
        {"type":"image","source":{"type":"base64","media_type":media,"data":data}}]}})
}

#[tokio::test]
async fn transcript_image_serves_the_pasted_block_with_immutable_cache() {
    let scene = Scene::new().await;
    scene.claude("s", &[json!({"type":"user","uuid":"u-001","message":{"role":"user","content":"oi"}}), image_line("u-003", "image/png", PNG)]);
    let response = scene.get_raw("/api/sessions/s/transcript-image/u-003/0").await;
    assert_eq!(response.status(), StatusCode::OK);
    let h = response.headers().clone();
    assert_eq!(h["content-type"], "image/png");
    assert_eq!(h["cache-control"], "max-age=31536000, immutable");
    assert_eq!(h["x-content-type-options"], "nosniff");
    assert_eq!(response.bytes().await.unwrap().as_ref(), b"\x89PNG\r\n\x1a\n");
}

#[tokio::test]
async fn transcript_image_not_found_cases() {
    let scene = Scene::new().await;
    scene.claude("s", &[
        json!({"type":"user","uuid":"texto","message":{"role":"user","content":"só texto"}}),
        image_line("u-003", "image/png", PNG),
        json!({"type":"user","uuid":"url","message":{"role":"user","content":[{"type":"image","source":{"type":"url","url":"http://x"}}]}}),
        json!({"type":"user","uuid":"tool","message":{"role":"user","content":[{"type":"tool_result","content":[{"type":"image","source":{"type":"base64","media_type":"image/png","data":PNG}}]}]}}),
        image_line("pad", "image/png", "iVBORw0KGgo"),
    ]);
    for (uuid, idx) in [("u-003", "1"), ("u-003", "-1"), ("nenhum", "0"), ("texto", "0"), ("url", "0"), ("tool", "0"), ("pad", "0")] {
        let (status, body) = scene.get(&format!("/api/sessions/s/transcript-image/{uuid}/{idx}")).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{uuid}/{idx}");
        assert_eq!(body["detail"]["code"], "erro_imagem_nao_encontrada", "{uuid}/{idx}");
    }
    let (status, body) = scene.get("/api/sessions/outra/transcript-image/u-003/0").await;
    assert_eq!((status, body["detail"]["code"].clone()), (StatusCode::NOT_FOUND, json!("erro_sessao_inexistente")));
}

#[tokio::test]
async fn transcript_image_base64_is_lenient_like_python() {
    let scene = Scene::new().await;
    scene.claude("s", &[image_line("u", "image/png", "iVBO\nRw0K!Ggo=")]);
    let response = scene.get_raw("/api/sessions/s/transcript-image/u/0").await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.bytes().await.unwrap().as_ref(), b"\x89PNG\r\n\x1a\n");
}

#[tokio::test]
async fn transcript_image_never_serves_active_content_types() {
    let scene = Scene::new().await;
    scene.claude("s", &[image_line("html", "text/html", PNG), image_line("svg", "image/svg+xml", PNG), image_line("jpg", "image/jpeg", PNG),
        json!({"type":"user","uuid":"sem","message":{"role":"user","content":[{"type":"image","source":{"type":"base64","data":PNG}}]}})]);
    for (uuid, expected) in [("html", "application/octet-stream"), ("svg", "application/octet-stream"), ("jpg", "image/jpeg"), ("sem", "image/png")] {
        let response = scene.get_raw(&format!("/api/sessions/s/transcript-image/{uuid}/0")).await;
        assert_eq!(response.status(), StatusCode::OK, "{uuid}");
        assert_eq!(response.headers()["content-type"], expected, "{uuid}");
        assert_eq!(response.headers()["x-content-type-options"], "nosniff", "{uuid}");
    }
}

#[tokio::test]
async fn transcript_image_of_a_transfer_stays_with_python() {
    let scene = Scene::new().await;
    scene.claude("s", &[image_line("u", "image/png", PNG)]);
    let path = "/api/sessions/s/transcript-image/transfer:rec:claude:u/0";
    let _ = scene.get_raw(path).await;
    assert_eq!(scene.python.hits_to(path), 1);
    let _ = scene.get_raw("/api/sessions/s/transcript-image/u/0").await;
    assert_eq!(scene.python.hits_to("/api/sessions/s/transcript-image/u/0"), 0);
}
