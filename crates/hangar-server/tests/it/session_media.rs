use super::fake::{Fake, OWNER, client, spawn_fake};
use axum::http::StatusCode;
use hangar_server::{
    auth::TrustedHosts,
    config::Config,
    locate::{BoxFuture, InfoFailed, Locate},
    routes::{AppState, router},
    runtime::gateway::RuntimeRegistry,
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
    runtime: Arc<RuntimeRegistry>,
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
        let runtime = Arc::new(RuntimeRegistry::new("127.0.0.1:9".parse().unwrap(), "s".into(), "i".into()));
        assert!(state.state.runtime.set(runtime.clone()).is_ok());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let task = tokio::spawn(async move {
            axum::serve(listener, router(Arc::new(state)).into_make_service_with_connect_info::<SocketAddr>())
                .await
                .unwrap();
        });
        Self { dir, sessions, python, runtime, address, task }
    }
    async fn post(&self, path: &str, body: &str) -> (StatusCode, Value) {
        let response = client().post(format!("http://{}{path}", self.address)).bearer_auth(OWNER)
            .header("content-type", "application/json").body(body.to_owned()).send().await.unwrap();
        let status = response.status();
        (status, serde_json::from_str(&response.text().await.unwrap()).unwrap_or(Value::Null))
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

// --- bash-output ---

#[tokio::test]
async fn bash_output_waits_for_no_body_while_the_session_is_held() {
    let scene = Scene::new().await;
    scene.runtime.ingress().hold("s", std::time::Duration::from_millis(10)).await.unwrap();
    let (status, body) = scene.post("/api/sessions/s/bash-output", "não é json").await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(body["detail"]["code"], "session_transfer_busy");
}

#[tokio::test]
async fn bash_output_body_is_strict() {
    let scene = Scene::new().await;
    let long = json!({"command": "x".repeat(200_001)}).to_string();
    for body in ["{}", r#"{"command": 3}"#, r#"{"command": "ls", "mais": 1}"#, "[]", long.as_str()] {
        let (status, reply) = scene.post("/api/sessions/s/bash-output", body).await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{}", &body[..body.len().min(40)]);
        assert!(reply["detail"].is_array(), "{reply}");
    }
    let exact = json!({"command": "é".repeat(200_000)}).to_string();
    assert_eq!(scene.post("/api/sessions/s/bash-output", &exact).await.0, StatusCode::OK);
}

#[tokio::test]
async fn bash_output_of_unknown_session_is_null() {
    let scene = Scene::new().await;
    let (status, body) = scene.post("/api/sessions/nenhuma/bash-output", r#"{"command": "sleep 30"}"#).await;
    assert_eq!((status, body), (StatusCode::OK, json!({"text": null})));
    assert_eq!(scene.python.hits_to("/api/sessions/nenhuma/bash-output"), 0);
}

#[test]
fn bash_output_tail_is_16000_bytes_decoded_with_replacement() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("x.output");
    let mut bytes = "é".as_bytes().to_vec();
    bytes.extend(std::iter::repeat_n(b'a', 15_999));
    std::fs::write(&path, &bytes).unwrap();
    let text = hangar_server::session_media::read_tail(&path, 16_000).unwrap();
    assert!(text.starts_with('\u{fffd}'), "{:?}", &text[..4]);
    assert_eq!(text.chars().filter(|&c| c == 'a').count(), 15_999);
    assert_eq!(hangar_server::session_media::read_tail(&dir.path().join("sumiu"), 16_000), None);
}

#[test]
fn task_output_paths_follow_the_claude_layout() {
    use hangar_server::session_media::is_task_output;
    assert!(is_task_output(Path::new("/tmp/claude-1000/-proj/abc/tasks/b1.output")));
    #[cfg(windows)]
    assert!(is_task_output(Path::new(r"C:\Users\x\AppData\Local\Temp\claude\proj\tasks\b1.output")));
    assert!(!is_task_output(Path::new("/tmp/claude-1000/proj/outros/b1.output")));
    assert!(!is_task_output(Path::new("/tmp/x/proj/tasks/b1.output")));
    assert!(!is_task_output(Path::new("/tmp/claude-1000/proj/tasks/b1.log")));
}

#[test]
fn stdout_files_of_a_child_include_its_redirected_file() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("out.txt");
    let file = std::fs::File::create(&path).unwrap();
    let mut command = if cfg!(windows) {
        let mut c = std::process::Command::new("ping");
        c.args(["-n", "30", "127.0.0.1"]);
        c
    } else {
        let mut c = std::process::Command::new("sleep");
        c.arg("30");
        c
    };
    let mut child = command.stdout(file).spawn().unwrap();
    let files = hangar_server::session_media::stdout_files(child.id() as i64);
    let _ = child.kill();
    let _ = child.wait();
    let wanted = std::fs::canonicalize(&path).unwrap();
    assert!(files.iter().any(|f| std::fs::canonicalize(f).ok().as_ref() == Some(&wanted)), "{files:?}");
}

/// Agente de mentira: um `sh` que roda o Bash do Claude Code (`… && eval '<cmd>' && pwd`) com a
/// saída num arquivo; o grupo inteiro morre no fim.
#[cfg(unix)]
struct Agent(std::process::Child);
#[cfg(unix)]
impl Agent {
    fn spawn(mark: &str, out: &Path) -> Self {
        use std::os::unix::process::CommandExt;
        let script = format!("sh -c \"true && eval 'printenv MARK; sleep 30' && pwd\" > '{}'; true", out.display());
        Self(std::process::Command::new("sh").arg("-c").arg(script).env("MARK", mark).process_group(0).spawn().unwrap())
    }
    fn pid(&self) -> i64 { self.0.id() as i64 }
}
#[cfg(unix)]
impl Drop for Agent {
    fn drop(&mut self) {
        let _ = std::process::Command::new("kill").args(["-TERM", "--", &format!("-{}", self.0.id())]).status();
        let _ = self.0.wait();
    }
}

#[cfg(unix)]
fn native(cfg: &Path, sid: &str, pid: i64) {
    std::fs::create_dir_all(cfg.join("sessions")).unwrap();
    std::fs::write(cfg.join(format!("sessions/{pid}.json")), json!({"sessionId": sid, "pid": pid, "status": "busy", "updatedAt": 1000}).to_string()).unwrap();
}

#[cfg(unix)]
fn written(path: &Path) {
    let until = std::time::Instant::now() + std::time::Duration::from_secs(10);
    while std::fs::metadata(path).map(|m| m.len()).unwrap_or(0) == 0 {
        assert!(std::time::Instant::now() < until, "o agente não escreveu em {}", path.display());
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
}

#[cfg(unix)]
#[test]
fn bash_output_reads_only_the_command_under_the_session_agent() {
    use hangar_server::{list::procs::SystemProcs, session_media::bash_output};
    let dir = tempfile::tempdir().unwrap();
    let cfg = dir.path().join("conta");
    let tasks = dir.path().join("claude-1000/proj/sess/tasks");
    let loose = dir.path().join("claude-1000/proj/sess/outros");
    std::fs::create_dir_all(&tasks).unwrap();
    std::fs::create_dir_all(&loose).unwrap();
    let (a, b, c) = (Agent::spawn("a", &tasks.join("a.output")), Agent::spawn("b", &tasks.join("b.output")), Agent::spawn("c", &loose.join("c.output")));
    native(&cfg, "sa", a.pid());
    native(&cfg, "sb", b.pid());
    native(&cfg, "sc", c.pid());
    for f in [tasks.join("a.output"), tasks.join("b.output"), loose.join("c.output")] {
        written(&f);
    }
    let procs = SystemProcs::default();
    let dirs = [cfg];
    let command = "  printenv MARK; sleep 30 ";
    assert_eq!(bash_output(&dirs, "sa", command, &procs).as_deref(), Some("a\n"));
    assert_eq!(bash_output(&dirs, "sb", command, &procs).as_deref(), Some("b\n"));
    assert_eq!(bash_output(&dirs, "sc", command, &procs), None, "saída fora de tasks/ não conta");
    assert_eq!(bash_output(&dirs, "sd", command, &procs), None, "sessão sem agente não lê a de outra");
    assert_eq!(bash_output(&dirs, "sa", "outro comando", &procs), None);
    assert_eq!(bash_output(&dirs, "sa", "   ", &procs), None);
}
