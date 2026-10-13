//! Rotas de plano (`/plan`, `/plans`, `/plan-preview`, `/plan-pin`, `/plan-step`, `/plan-archive`)
//! e o catálogo de plugins e skills (`/api/claude/customizations`), com o contrato que o Python
//! respondia: mesmos campos, status e envelope `detail`. O dono entra pela porta pública; convidado
//! e Connect chegam pela ponte `forwarded`, já autenticados pelo Python.
use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use axum::body::to_bytes;
use axum::extract::{ConnectInfo, Request, State};
use axum::http::{Method, StatusCode};
use axum::response::{IntoResponse, Response};
use hangar_api::session::SessionRow;
use serde::Deserialize;
use serde_json::{Value, json};

use crate::list::plan::{PIN_NONE, Plan, plans_dir, safe_stem};
use crate::plans::files::{self, WriteError};
use crate::routes::{AppState, cors, gate, pass};
use crate::session_write::{busy_body, detail_body, json_response, session_name};

const BODY_LIMIT: usize = 64 * 1024;
const SESSION_TAILS: [&str; 6] = ["plan", "plans", "plan-preview", "plan-pin", "plan-step", "plan-archive"];
const CATALOG: &str = "/api/claude/customizations";
/// O que escapar num segmento de caminho: controle, espaço, `%` e o que a URI não aceita cru.
const SEGMENT: &percent_encoding::AsciiSet = &percent_encoding::CONTROLS.add(b' ').add(b'%').add(b'"').add(b'#')
    .add(b'<').add(b'>').add(b'?').add(b'`').add(b'{').add(b'}');

/// Caminho e método que estas rotas atendem; o resto da ponte segue sem dono aqui.
pub fn matches(method: &Method, path: &str) -> bool {
    if path == CATALOG {
        return method == Method::GET;
    }
    let Some(tail) = path.strip_prefix("/api/sessions/").and_then(|p| p.split_once('/')).map(|(_, t)| t) else { return false };
    match *method {
        Method::GET => matches!(tail, "plan" | "plans" | "plan-preview"),
        Method::POST => matches!(tail, "plan-pin" | "plan-step" | "plan-archive"),
        _ => false,
    }
}

/// As rotas na porta pública, cada uma com o repasse do que não é dela.
pub fn router() -> axum::Router<Arc<AppState>> {
    use crate::routes::pass_any;
    use axum::routing::{get, post};
    let mut router = axum::Router::new().route(CATALOG, get(public).fallback(pass_any));
    for tail in SESSION_TAILS {
        let path = format!("/api/sessions/{{name}}/{tail}");
        let method = if tail.starts_with("plan-") && tail != "plan-preview" { post(public) } else { get(public) };
        router = router.route(&path, method.fallback(pass_any));
    }
    router
}

pub async fn public(State(st): State<Arc<AppState>>, ConnectInfo(peer): ConnectInfo<SocketAddr>, req: Request) -> Response {
    let (forward, owner) = gate(&st, peer, &req);
    if !owner {
        return pass(&st, req, &forward).await;
    }
    let headers = req.headers().clone();
    let mut response = serve(&st, req).await;
    cors(&headers, response.headers_mut());
    response
}

/// Pedido que entrou pelas portas do Python (convidado, Connect), já autenticado e filtrado lá. O
/// caminho original vem em `x-hangar-path`.
pub async fn forwarded(State(st): State<Arc<AppState>>, ConnectInfo(peer): ConnectInfo<SocketAddr>, mut req: Request) -> Response {
    if !crate::workspace_routes::private_ok(&st, peer, req.headers()) {
        return StatusCode::NOT_FOUND.into_response();
    }
    // O Starlette manda o caminho já decodificado: cada segmento volta a ser escapado, senão um
    // nome de sessão com espaço não vira URI e um `%` seria decodificado duas vezes.
    let Some(path) = req.headers().get("x-hangar-path").and_then(|v| std::str::from_utf8(v.as_bytes()).ok())
        .map(|p| p.split('/').map(|seg| percent_encoding::utf8_percent_encode(seg, SEGMENT).to_string()).collect::<Vec<_>>().join("/"))
    else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    if !matches(req.method(), &path) {
        return json_response(StatusCode::NOT_FOUND, json!({"code": "forwarded_route_not_owned"}));
    }
    let target = match req.uri().query() {
        Some(query) => format!("{path}?{query}"),
        None => path,
    };
    let Ok(uri) = target.parse() else { return StatusCode::BAD_REQUEST.into_response() };
    *req.uri_mut() = uri;
    serve(&st, req).await
}

async fn serve(st: &Arc<AppState>, req: Request) -> Response {
    let path = req.uri().path().to_owned();
    let query: HashMap<String, String> =
        form_urlencoded::parse(req.uri().query().unwrap_or("").as_bytes()).into_owned().collect();
    if path == CATALOG {
        return customizations(st, &query).await;
    }
    let (Some(name), Some(tail)) = (session_name(&path), path.rsplit('/').next().map(str::to_owned)) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let post = req.method() == Method::POST;
    let response = if post {
        let Ok(bytes) = to_bytes(req.into_body(), BODY_LIMIT).await else { return unprocessable("body", "corpo do pedido grande demais") };
        write(st, &name, &tail, &bytes).await
    } else {
        match tail.as_str() {
            "plan" => detail(st, &name).await,
            "plans" => catalog(st, &name).await,
            _ => preview(st, &name, &query).await,
        }
    };
    // Sem o Python nessas rotas, a falha só chega ao diário exportável por aqui.
    st.diag.report_response("rust.plans_failed", &name, &response, "a operação de plano falhou");
    response
}

fn refused(status: StatusCode, code: &'static str, msg: &str, params: Value) -> Response {
    crate::diag::coded(json_response(status, detail_body(code, msg, params)), code)
}

/// O 422 do FastAPI, no formato que os clientes já leem.
fn unprocessable(at: &str, msg: &str) -> Response {
    json_response(StatusCode::UNPROCESSABLE_ENTITY, json!({"detail": [{"type": "value_error", "loc": [at], "msg": msg, "input": null}]}))
}

fn now() -> (f64, f64) {
    let wall = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0.0, |d| d.as_secs_f64());
    // A base do relógio da lista: o prazo da descoberta compara números da mesma origem.
    (wall, crate::list::classify::process_start().elapsed().as_secs_f64())
}

/// A sessão pelo retrato da lista, e por uma rodada nova quando o nome ainda não está nele.
async fn session(st: &AppState, name: &str) -> Result<SessionRow, Response> {
    let unavailable = |e: crate::list::bridge::ListError| refused(StatusCode::SERVICE_UNAVAILABLE, e.code, e.detail, json!({}));
    let find = |rows: &[SessionRow]| rows.iter().find(|r| r.name == name).cloned();
    let produced = st.list.snapshot().await.map_err(unavailable)?;
    if let Some(row) = find(&produced.rows) {
        return Ok(row);
    }
    let produced = st.list.refresh().await.map_err(unavailable)?;
    match find(&produced.rows) {
        Some(row) => Ok(row),
        // Sem os fatos do Python as linhas de transferência e `orq` faltam: ausência não prova nada.
        None if produced.facts.unknown => Err(refused(StatusCode::SERVICE_UNAVAILABLE, "list_facts_unknown",
            "a lista de sessões está incompleta agora; tente de novo", json!({}))),
        None => Err(missing_session()),
    }
}

fn missing_session() -> Response {
    refused(StatusCode::NOT_FOUND, "erro_sessao_inexistente", "sessão não encontrada", json!({}))
}

async fn session_cwd(st: &AppState, name: &str) -> Result<PathBuf, Response> {
    let row = session(st, name).await?;
    row.cwd.filter(|c| !c.is_empty()).map(PathBuf::from).ok_or_else(missing_session)
}

/// Disco fora do executor assíncrono; pânico vira 500 com código, nunca a conexão caída.
async fn blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> Result<T, Response> {
    tokio::task::spawn_blocking(f).await
        .map_err(|_| refused(StatusCode::INTERNAL_SERVER_ERROR, "erro_plano_interno", "a operação de plano foi interrompida", json!({})))
}

fn active(st: &AppState, cwd: PathBuf) -> impl FnOnce() -> Option<Plan> + Send + 'static {
    let list = st.list.clone();
    move || {
        let (wall, mono) = now();
        list.with_plans(|t| t.active(&cwd, wall, mono))
    }
}

async fn detail(st: &Arc<AppState>, name: &str) -> Response {
    let cwd = match session_cwd(st, name).await { Ok(cwd) => cwd, Err(r) => return r };
    let plan = match blocking(active(st, cwd)).await { Ok(p) => p, Err(r) => return r };
    let Some(p) = plan else {
        return refused(StatusCode::NOT_FOUND, "erro_sem_plano_ativo", "sem plano ativo", json!({}));
    };
    let path = p.path.clone();
    // O markdown vai junto: o `/file` só serve caminho citado no transcript, e um plano achado pela
    // varredura nunca aparece lá.
    let markdown = match tokio::fs::read(&path).await {
        Ok(raw) => String::from_utf8_lossy(&raw).into_owned(),
        Err(e) => {
            // O plano vem do cache; o arquivo pode ter sumido entre as duas leituras.
            tracing::warn!(code = "plan_markdown_unreadable", kind = ?e.kind(), "markdown do plano ilegível");
            String::new()
        }
    };
    let tasks: Vec<Value> = p.tasks.iter().map(|t| json!({"title": t.title, "done": t.done, "total": t.total,
        "steps": t.steps.iter().map(|s| json!({"title": s.title, "done": s.done, "manual": s.manual, "idx": s.idx})).collect::<Vec<_>>()})).collect();
    let stem = path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    json_response(StatusCode::OK, json!({
        "name": p.name, "path": path.to_string_lossy(), "stem": stem,
        "task": p.task_idx, "task_total": p.task_total,
        "done": p.done, "total": p.total, "complete": p.complete,
        "tasks": tasks, "markdown": markdown,
    }))
}

fn no_plans_dir() -> Response {
    refused(StatusCode::NOT_FOUND, "erro_sem_pasta_planos", "repositório sem pasta de planos", json!({}))
}

async fn catalog(st: &Arc<AppState>, name: &str) -> Response {
    let cwd = match session_cwd(st, name).await { Ok(cwd) => cwd, Err(r) => return r };
    let list = st.list.clone();
    match blocking(move || list.with_plans(|t| t.catalog(&cwd))).await {
        Ok(Some(v)) => json_response(StatusCode::OK, v),
        Ok(None) => no_plans_dir(),
        Err(r) => r,
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PinBody { #[serde(default)] stem: Option<String> }

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct StepBody { stem: String, idx: i64, done: bool }

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ArchiveBody { stem: String }

enum WriteOp { Pin(PinBody), Step(StepBody), Archive(ArchiveBody) }

fn parse_write(tail: &str, bytes: &[u8]) -> Result<WriteOp, String> {
    let e = |e: serde_json::Error| e.to_string();
    match tail {
        "plan-pin" => serde_json::from_slice(bytes).map(WriteOp::Pin).map_err(e),
        "plan-step" => serde_json::from_slice(bytes).map(WriteOp::Step).map_err(e),
        _ => serde_json::from_slice(bytes).map(WriteOp::Archive).map_err(e),
    }
}

/// `_transfer_guard`: troca de conversa ou de conta em curso recusa com o código do Python. O passe
/// segura a porta até a escrita acabar; sem runtime, nenhum.
async fn enter(st: &AppState, name: &str) -> Result<Option<crate::runtime::ingress::IngressPass>, Response> {
    let Some(runtime) = st.state.runtime.get() else { return Ok(None) };
    runtime.ingress().enter(name, st.write_gate_wait).await.map(Some)
        .map_err(|_| crate::diag::coded(json_response(StatusCode::CONFLICT, busy_body()), "session_transfer_busy"))
}

async fn write(st: &Arc<AppState>, name: &str, tail: &str, bytes: &[u8]) -> Response {
    // A trava vem antes do corpo, como a dependência `_transfer_guard` antes da validação.
    let _pass = match enter(st, name).await { Ok(pass) => pass, Err(r) => return r };
    let op = match parse_write(tail, bytes) { Ok(op) => op, Err(msg) => return unprocessable("body", &msg) };
    let cwd = match session_cwd(st, name).await { Ok(cwd) => cwd, Err(r) => return r };
    let at = cwd.clone();
    let Some(root) = (match blocking(move || plans_dir(&at)).await { Ok(root) => root, Err(r) => return r }) else { return no_plans_dir() };
    match op {
        WriteOp::Pin(body) => pin(st, root, body.stem).await,
        WriteOp::Step(body) => step(st, root, cwd, body).await,
        WriteOp::Archive(body) => archive(st, root, body.stem).await,
    }
}

async fn pin(st: &AppState, root: PathBuf, stem: Option<String>) -> Response {
    // Só um plano que existe nesta pasta: senão o stem do cliente viraria nome de arquivo. A
    // guarda de separador vem antes do `is_file`, que já diria se existe `.md` fora da pasta.
    if let Some(stem) = stem.as_deref().filter(|s| *s != PIN_NONE) {
        let params = json!({"nome": stem});
        if !safe_stem(stem) {
            return refused(StatusCode::BAD_REQUEST, "erro_nome_plano_invalido", &format!("nome de plano inválido: {stem}"), params);
        }
        let candidate = root.join(format!("{stem}.md"));
        if !matches!(blocking(move || candidate.is_file()).await, Ok(true)) {
            return refused(StatusCode::NOT_FOUND, "erro_plano_nao_encontrado", &format!("plano não encontrado: {stem}"), params);
        }
    }
    let (written, at) = (stem.clone(), root.clone());
    match blocking(move || files::write_pin(&at, written.as_deref())).await {
        Ok(Ok(())) => {
            st.list.forget_plans(root);
            json_response(StatusCode::OK, json!({"pinned": stem}))
        }
        Ok(Err(WriteError(e))) => refused(StatusCode::INTERNAL_SERVER_ERROR, "erro_gravar_pin", &format!("não deu pra gravar o pin: {e}"), json!({"erro": e})),
        Err(r) => r,
    }
}

async fn step(st: &AppState, root: PathBuf, cwd: PathBuf, body: StepBody) -> Response {
    let marked = blocking(move || files::plan_path(&root, &body.stem).and_then(|path| files::mark_step(&path, body.idx, body.done))).await;
    match marked {
        Ok(Ok(())) => {}
        // 409: o arquivo mudou ou não serve, não é falha do servidor; a tela mostra o texto.
        Ok(Err(WriteError(e))) => return refused(StatusCode::CONFLICT, "erro_marcar_step", &format!("não deu pra marcar o passo: {e}"), json!({"erro": e})),
        Err(r) => return r,
    }
    match blocking(active(st, cwd)).await {
        Ok(p) => json_response(StatusCode::OK, json!({"done": p.as_ref().map(|p| p.done), "total": p.as_ref().map(|p| p.total),
            "complete": p.is_some_and(|p| p.complete)})),
        Err(r) => r,
    }
}

async fn archive(st: &AppState, root: PathBuf, stem: String) -> Response {
    let at = root.clone();
    match blocking(move || files::archive(&at, &stem)).await {
        Ok(Ok(moved)) => {
            st.list.forget_plans(root);
            json_response(StatusCode::OK, json!({"moved": moved}))
        }
        Ok(Err(WriteError(e))) => {
            // Mesmo parcial, o `.md` pode já ter saído: a descoberta não pode descrever o antes.
            st.list.forget_plans(root);
            refused(StatusCode::CONFLICT, "erro_arquivar_plano", &format!("não deu pra arquivar: {e}"), json!({"erro": e}))
        }
        Err(r) => r,
    }
}

/// O `bool` do FastAPI; outro valor é o 422 dele.
fn flag(value: Option<&String>, default: bool) -> Option<bool> {
    match value.map(|s| s.to_ascii_lowercase()).as_deref() {
        None => Some(default),
        Some("1" | "true" | "on" | "yes" | "t" | "y") => Some(true),
        Some("0" | "false" | "off" | "no" | "f" | "n") => Some(false),
        _ => None,
    }
}

async fn preview(st: &Arc<AppState>, name: &str, query: &HashMap<String, String>) -> Response {
    let Some(content) = flag(query.get("content"), true) else { return unprocessable("query", "content precisa ser booleano") };
    let row = match session(st, name).await { Ok(row) => row, Err(r) => return r };
    let Some(jsonl) = row.jsonl.clone().filter(|j| !j.is_empty()) else {
        return refused(StatusCode::NOT_FOUND, "erro_sessao_inexistente", "sessão ou transcript não encontrado", json!({}));
    };
    if row.provider != "claude" {
        return json_response(StatusCode::OK, Value::Null);
    }
    // Sem pasta, configuração e caminho relativo seriam lidos da pasta do próprio servidor.
    let Some(cwd) = row.cwd.filter(|c| !c.is_empty()).map(PathBuf::from) else { return missing_session() };
    let found = match blocking(move || super::claude::discover(Path::new(&jsonl), &cwd)).await { Ok(f) => f, Err(r) => return r };
    let Some(plan) = found else { return json_response(StatusCode::OK, Value::Null) };
    let mut reply = json!({"name": plan.name, "path": plan.path.to_string_lossy()});
    if let Some(anchor) = plan.anchor_id {
        reply["anchor_id"] = json!(anchor);
    }
    if !content {
        return json_response(StatusCode::OK, reply);
    }
    match tokio::fs::read(&plan.path).await.map(String::from_utf8) {
        Ok(Ok(markdown)) => {
            reply["markdown"] = json!(markdown);
            json_response(StatusCode::OK, reply)
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound =>
            refused(StatusCode::NOT_FOUND, "erro_plano_removido", "arquivo do plano não encontrado", json!({})),
        _ => refused(StatusCode::INTERNAL_SERVER_ERROR, "erro_plano_ilegivel", "não foi possível ler o plano", json!({})),
    }
}

async fn customizations(st: &Arc<AppState>, query: &HashMap<String, String>) -> Response {
    let Some(raw) = query.get("cwd").filter(|c| !c.is_empty()).cloned() else { return unprocessable("query", "cwd é obrigatório") };
    let chosen = query.get("config_dir").cloned();
    let accounts = st.accounts.clone();
    let checked = blocking(move || -> Result<(PathBuf, PathBuf), Response> {
        if let Some(dir) = &chosen {
            let known = accounts.claude_catalog().map_err(|e| refused(StatusCode::SERVICE_UNAVAILABLE, e.code, &e.message, json!({})))?;
            if !known.as_array().into_iter().flatten().any(|a| a["path"].as_str() == Some(dir.as_str())) {
                return Err(refused(StatusCode::BAD_REQUEST, "erro_config_dir_invalido", "config_dir inválido", json!({})));
            }
        }
        let path = hangar_workspace::real(Path::new(&raw));
        if !path.is_dir() {
            return Err(refused(StatusCode::BAD_REQUEST, "erro_cwd_inexistente", "a pasta não existe", json!({"cwd": raw})));
        }
        // A conta que a sessão nascida com este `config_dir` usaria: a escolhida, ou a padrão.
        Ok((path, chosen.map_or_else(|| accounts.env.claude_base.clone(), PathBuf::from)))
    }).await;
    let (cwd, config_dir) = match checked { Ok(Ok(v)) => v, Ok(Err(r)) | Err(r) => return r };
    match crate::claude_customizations::public_catalog(st, cwd, config_dir).await {
        Ok(v) => json_response(StatusCode::OK, v),
        Err((status, code, msg)) => refused(StatusCode::from_u16(status).unwrap_or(StatusCode::SERVICE_UNAVAILABLE), code, msg, json!({})),
    }
}

