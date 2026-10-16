//! A abertura no servidor: o `POST /api/sessions` do dono, a ponte privada por onde o Python repassa
//! o que entra por ele (convidado, Connect, MCP, bastão) e o `OpenHost` com os serviços do Rust e as
//! lojas que ainda moram no Python (fila, `then`, diário, provedor lembrado).
use std::collections::BTreeMap;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use axum::body::{Body, to_bytes};
use axum::extract::{ConnectInfo, Request, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use futures_util::future::BoxFuture;
use http_body_util::BodyExt;
use serde_json::{Value, json};

use super::claude::PluginBridge;
use super::open::{Born, OpenHost, ProgramOutput};
use super::terminal::{Mux, ProcessMux, TerminalEnv};
use super::{AgentProvider, OpenCaller, OpenError, SessionOpenRequest, Surface};
use crate::accounts::environment::AccountEnvironment;
use crate::routes::AppState;

/// Marca do pedido que o Rust olhou e devolveu ao Python: lá ele não volta à ponte.
pub const DECLINED: &str = "x-hangar-open";

pub struct ServerHost {
    st: Arc<AppState>,
    env: AccountEnvironment,
    terminal: TerminalEnv,
    mux: ProcessMux,
}

/// O ambiente do servidor para a abertura: o do processo e as opções `CP_*` do `backend/.env`, que o
/// pydantic do Python lê sem exportar (`env_file=".env"`, na pasta de trabalho que o Rust herda dele).
/// Como lá, a variável do processo vence a do arquivo.
pub fn server_env(mut process: BTreeMap<String, String>, dotenv: &Path) -> BTreeMap<String, String> {
    let file = std::fs::read_to_string(dotenv).map(|text| super::local::dotenv(&text)).unwrap_or_default();
    for (key, value) in file.into_iter().filter(|(key, _)| key.starts_with("CP_")) {
        process.entry(key).or_insert(value);
    }
    process
}

/// `runtime_config.aplicar({"last_session_provider": …})`: o mesmo arquivo e a mesma troca atômica do
/// Python (temporário na pasta, troca, 0600), que relê pela data do arquivo. Igual não regrava;
/// ilegível não é sobrescrito.
pub fn remember_provider(claude_base: &Path, provider: &str) -> std::io::Result<()> {
    use std::io::{Error, ErrorKind};
    let path = claude_base.join("runtime-config.json");
    let mut config = match std::fs::read(&path) {
        Ok(raw) => serde_json::from_slice::<Value>(&raw).ok().filter(Value::is_object)
            .ok_or_else(|| Error::new(ErrorKind::InvalidData, "runtime-config.json ilegível"))?,
        Err(error) if error.kind() == ErrorKind::NotFound => json!({}),
        Err(error) => return Err(error),
    };
    if config["last_session_provider"] == provider { return Ok(()); }
    config["last_session_provider"] = json!(provider);
    std::fs::create_dir_all(claude_base)?;
    crate::runtime::queue::atomic_write(&path, &serde_json::to_vec_pretty(&config)?)
}

/// O convidado com login (`guests.json`, que é do Python).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LoginGuest { pub id: String, pub name: String, pub root: PathBuf }

/// `guest_users.lookup_token`, só lendo: o hash do token contra o `token_hash` de cada um. Ausente,
/// ilegível ou com um convidado torto é "nenhum convidado", como no `_load` de lá.
pub fn login_guest(claude_base: &Path, token: &[u8]) -> Option<LoginGuest> {
    use subtle::ConstantTimeEq;
    let raw: Value = serde_json::from_slice(&std::fs::read(claude_base.join("guests.json")).ok()?).ok()?;
    let hash: String = ring::digest::digest(&ring::digest::SHA256, token).as_ref().iter().map(|b| format!("{b:02x}")).collect();
    let text = |guest: &Value, key: &str| guest[key].as_str().map(str::to_owned);
    let guests: Option<Vec<(String, LoginGuest)>> = raw["guests"].as_array()?.iter().map(|g| Some((text(g, "token_hash")?,
        LoginGuest { id: text(g, "id")?, name: text(g, "name")?, root: text(g, "root")?.into() }))).collect();
    guests?.into_iter().find(|(stored, _)| bool::from(stored.as_bytes().ct_eq(hash.as_bytes()))).map(|(_, guest)| guest)
}

/// A fila que a sessão morta deixou no nome (a projeção `.hangar-queue/<nome>.jsonl`, que o Rust lê
/// no histórico): a nova não a herda.
pub fn forget_queue(claude_base: &Path, name: &str) -> std::io::Result<()> {
    let projection = crate::locate::queue_path(claude_base, name);
    for path in [projection.with_extension("jsonl.tmp"), projection] {
        match std::fs::remove_file(path) {
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => return Err(error),
            _ => {}
        }
    }
    Ok(())
}

impl ServerHost {
    pub fn new(st: Arc<AppState>) -> Self {
        let env = AccountEnvironment::from_map(server_env(std::env::vars().collect(), Path::new(".env")));
        let terminal = TerminalEnv::local(&env.home, &env.base);
        Self { st, env, terminal, mux: ProcessMux::default() }
    }

    /// `POST` JSON a uma rota interna do Python; `Err` com o motivo, sem o corpo.
    async fn internal(&self, path: &str, body: Value) -> Result<Value, String> {
        let request = axum::http::Request::post(format!("http://{}{path}", self.st.cfg.upstream))
            .header("x-hangar-internal", &self.st.cfg.internal_secret).header("content-type", "application/json")
            .body(Body::from(body.to_string())).map_err(|e| e.to_string())?;
        let response = tokio::time::timeout(Duration::from_secs(30), self.st.http.request(request)).await
            .map_err(|_| "prazo".to_owned())?.map_err(|e| format!("conexão: {e}"))?;
        let status = response.status();
        let bytes = http_body_util::Limited::new(response.into_body(), 1 << 20).collect().await
            .map_err(|_| "corpo".to_owned())?.to_bytes();
        if !status.is_success() { return Err(format!("status {}", status.as_u16())); }
        serde_json::from_slice(&bytes).map_err(|_| "json".to_owned())
    }

    /// O dono da sessão que o convidado com login abriu vai ao `guests.json`, que é do Python, num
    /// sentido. Falhou: a sessão sai com a worktree que ela criou, como no `_kill_unclaimed`.
    async fn claim(&self, mut opened: super::open::Opened, guest: &LoginGuest) -> Result<super::open::Opened, OpenError> {
        let name = opened.body["name"].as_str().unwrap_or_default().to_owned();
        let Err(cause) = self.internal("/internal/guests/claim", json!({"session": name, "guest": guest.id})).await else {
            opened.body["owner"] = json!(guest.name);
            return Ok(opened);
        };
        tracing::warn!(cause, "o dono da sessão do convidado não foi registrado; a sessão sai");
        self.mux.run(vec![self.terminal.program.clone(), "kill-session".into(), "-t".into(), format!("={name}")]).await;
        if let Err(error) = super::record::remove(&self.env.home, &opened.key) {
            tracing::warn!(kind = ?error.kind(), "registro da sessão do convidado ficou para trás");
        }
        self.st.list.forget(&name);
        self.st.list.invalidate();
        if let Some(undo) = opened.undo { undo.undo().await?; }
        Err(OpenError::new(500, "erro_criacao_sessao", format!("o dono da sessão não foi registrado: {cause}")))
    }
}

/// Programa da abertura, pelo PATH do servidor e sem os segredos dele no ambiente.
pub async fn run_program(env: &BTreeMap<String, String>, argv: Vec<String>, timeout: Duration) -> ProgramOutput {
    let failed = |stderr: String| ProgramOutput { code: None, stdout: String::new(), stderr };
    let Some((program, args)) = argv.split_first() else { return failed("comando vazio".into()) };
    let path: Vec<(String, String)> = env.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
    let Some(exe) = crate::runtime::process::resolve_program(program, &path) else { return failed(format!("{program} não está no PATH")) };
    let mut command = tokio::process::Command::new(exe);
    command.args(args).env_clear().stdin(std::process::Stdio::null()).kill_on_drop(true)
        .envs(env.iter().filter(|(k, _)| !matches!(k.as_str(), "CP_AUTH_TOKEN" | "HANGAR_INTERNAL_SECRET" | "HANGAR_RUNTIME_INSTANCE")));
    match tokio::time::timeout(timeout, command.output()).await {
        Ok(Ok(out)) => ProgramOutput { code: out.status.code(), stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&out.stderr).into_owned() },
        Ok(Err(e)) => failed(e.to_string()),
        Err(_) => failed(format!("{program} não respondeu no prazo")),
    }
}

impl OpenHost for ServerHost {
    fn home(&self) -> &Path { &self.env.home }
    fn env(&self) -> &BTreeMap<String, String> { &self.env.base }
    fn terminal(&self) -> &TerminalEnv { &self.terminal }
    fn mux(&self) -> &dyn Mux { &self.mux }
    fn bridge(&self) -> Option<PluginBridge> { Some(PluginBridge { port: self.st.cfg.listen.port(), secret: self.st.cfg.auth_token.clone() }) }
    fn server_projects(&self) -> PathBuf { self.env.claude_base.join("projects") }

    fn run(&self, argv: Vec<String>, timeout: Duration) -> BoxFuture<'_, ProgramOutput> {
        Box::pin(run_program(&self.env.base, argv, timeout))
    }

    fn customizations(&self, args: Value) -> BoxFuture<'_, Result<Value, OpenError>> {
        Box::pin(async move {
            crate::claude_customizations::prepare_for_open(&self.st, args).await
                .map_err(|(status, code, detail)| OpenError::new(status, code, detail))
        })
    }

    fn leave_old_group<'a>(&'a self, name: &'a str) -> BoxFuture<'a, Result<(), OpenError>> {
        Box::pin(async move {
            let Some(groups) = &self.st.groups else { return Ok(()) };
            match crate::groups::exit::leave_and_notify(&self.st, groups, name).await {
                Ok((_, warnings)) if !warnings.is_empty() =>
                    tracing::warn!(count = warnings.len(), "criação: a saída do grupo antigo deixou avisos"),
                Ok(_) => {}
                Err(_) if groups.has_sidecar(name) => return Err(OpenError::new(409, "erro_grupo_limpeza_falhou",
                    format!("o grupo da sessão antiga '{name}' não foi desfeito; tente de novo"))),
                Err(_) => tracing::warn!("criação: grupos falharam sem grupo a desfazer"),
            }
            Ok(())
        })
    }

    fn release_name<'a>(&'a self, name: &'a str) -> BoxFuture<'a, Result<(), OpenError>> {
        Box::pin(async move {
            self.st.list.forget(name);
            let (base, owned) = (self.env.claude_base.clone(), name.to_owned());
            if let Err(error) = tokio::task::spawn_blocking(move || forget_queue(&base, &owned)).await
                .unwrap_or_else(|e| Err(std::io::Error::other(e.to_string()))) {
                return Err(OpenError::new(503, "erro_lista_indisponivel", format!("a fila da sessão antiga não foi apagada: {error}"))
                    .with_params(json!({"detalhe": "fila_antiga"})));
            }
            // ponytail: o registro em espera do coordenador e o `then` ainda moram no Python (Task 5,
            // passo 3, e a migração do `then`); só eles vão por esta chamada.
            let path = format!("/internal/sessions/{}/release", crate::groups::exit::segment(name));
            self.internal(&path, json!({})).await.map(|_| ()).map_err(|cause| {
                tracing::warn!(cause, "registro em espera e `then` do nome reusado não limpos");
                OpenError::new(503, "erro_lista_indisponivel", "o estado do nome reusado não foi limpo; tente de novo")
                    .with_params(json!({"detalhe": "python_release"}))
            })
        })
    }

    fn born<'a>(&'a self, born: &'a Born) -> BoxFuture<'a, Vec<String>> {
        Box::pin(async move {
            if let Some(share) = &self.st.share {
                crate::share::pair_routes::session_died(self.st.clone(), share.clone(), Arc::new(crate::share::pair_routes::Direct), &born.name).await;
            }
            self.st.list.seed(&born.name, &born.jsonl);
            self.st.list.invalidate();
            if !born.remember_provider { return Vec::new(); }
            let base = self.env.claude_base.clone();
            match tokio::task::spawn_blocking(move || remember_provider(&base, "claude")).await {
                Ok(Ok(())) => Vec::new(),
                Ok(Err(error)) => vec![format!("A sessão foi criada, mas não consegui lembrar o provedor: {error}")],
                Err(error) => vec![format!("A sessão foi criada, mas não consegui lembrar o provedor: {error}")],
            }
        })
    }

    fn diary(&self, events: Vec<Value>) {
        let Some(dir) = crate::diag::diary_dir() else {
            tracing::warn!("diário da criação sem pasta de logs; não gravado");
            return;
        };
        tokio::task::spawn_blocking(move || {
            if let Err(error) = crate::diag::write_diary(&dir, &events, chrono::Local::now()) {
                tracing::warn!(kind = ?error.kind(), "diário da criação não gravado");
            }
        });
    }

    fn new_session_id(&self) -> String { super::open::uuid4(&crate::mods::state::random_hex(16)) }
    fn new_bridge_key(&self) -> String { crate::mods::state::random_hex(16) }
}

/// Pedido que a decisão do Rust nem olha: provedor ou modo explícitos que não são do Rust ainda.
fn explicitly_other(request: &SessionOpenRequest) -> bool {
    request.provider.as_deref().is_some_and(|p| p != "claude") || request.headless == Some(true)
}

pub enum Decision { Opened(super::open::Opened), Refused(OpenError), NotOurs }

/// `decide` numa tarefa própria: cliente que desconecta no meio não interrompe a criação (a worktree
/// criada sem o pane ficaria para trás) nem o registro do convidado (`claim`), como o
/// `complete_on_cancel` do Python.
async fn decide_detached(st: &Arc<AppState>, request: SessionOpenRequest, caller: OpenCaller, claim: Option<LoginGuest>) -> Decision {
    let st = st.clone();
    tokio::spawn(async move {
        match (decide(&st, request, caller).await, claim) {
            (Decision::Opened(opened), Some(guest)) => match ServerHost::new(st.clone()).claim(opened, &guest).await {
                Ok(opened) => Decision::Opened(opened),
                Err(error) => Decision::Refused(error),
            },
            (decision, _) => decision,
        }
    }).await.unwrap_or_else(|_| Decision::Refused(OpenError::new(500, "erro_criacao_sessao", "a abertura não terminou")))
}

/// Resolve e, sendo Claude com terminal, abre. O resto (Codex, Pi, omp, Kimi, sem terminal) ainda é
/// do Python. Recusa da resolução é do Rust: as dele são as do Python mais os consertos.
pub async fn decide(st: &Arc<AppState>, request: SessionOpenRequest, caller: OpenCaller) -> Decision {
    if explicitly_other(&request) { return Decision::NotOurs; }
    let host = ServerHost::new(st.clone());
    let facts_env = host.env.clone();
    let runtime = tokio::runtime::Handle::current();
    let (request_for_facts, caller_for_facts) = (request.clone(), caller.clone());
    let resolved = tokio::task::spawn_blocking(move || {
        let facts = super::facts::LocalFacts::new(facts_env, runtime);
        super::resolve_open(&request_for_facts, &caller_for_facts, &facts)
    }).await.unwrap_or_else(|_| Err(OpenError::new(500, "erro_criacao_sessao", "a resolução da abertura não terminou")));
    let resolved = match resolved {
        Ok(resolved) => resolved,
        Err(error) => {
            if let Some(events) = super::open::refusal_diary(crate::mods::state::random_hex(8), &request.name, &error) { host.diary(events); }
            return Decision::Refused(error);
        }
    };
    if resolved.spec.provider != AgentProvider::Claude || resolved.spec.surface != Surface::Terminal { return Decision::NotOurs; }
    match super::open::open_claude_terminal(&host, resolved, &caller).await {
        Ok(opened) => Decision::Opened(opened),
        Err(error) => Decision::Refused(error),
    }
}

fn reply(error: &OpenError) -> Response {
    let status = StatusCode::from_u16(error.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    crate::session_write::json_response(status, error.body())
}

/// `POST /api/sessions`: o dono e o convidado com login abrem Claude com terminal no Rust (o do
/// convidado na pasta dele, com o dono registrado no Python depois); o resto segue ao Python com o
/// corpo intacto (corpo que não é pedido válido também: o 422 é o dele).
pub async fn create(State(st): State<Arc<AppState>>, ConnectInfo(peer): ConnectInfo<SocketAddr>, req: Request) -> Response {
    let (fwd, owner) = crate::routes::gate(&st, peer, &req);
    let (mut parts, body) = req.into_parts();
    // Só o Rust diz ao Python que já olhou.
    parts.headers.remove(DECLINED);
    let Ok(bytes) = to_bytes(body, crate::session_write::BODY_LIMIT).await else {
        return crate::session_write::too_large(&parts.headers);
    };
    let guest = if owner { None } else {
        crate::auth::presented_token(&parts.headers, parts.uri.query(), &parts.method, fwd.https)
            .and_then(|token| login_guest(&AccountEnvironment::capture().claude_base, &token))
    };
    let pass = |parts: axum::http::request::Parts, bytes: axum::body::Bytes| {
        let st = st.clone();
        async move { crate::routes::pass(&st, Request::from_parts(parts, Body::from(bytes)), &fwd).await }
    };
    if !owner && guest.is_none() { return pass(parts, bytes).await; }
    let Ok(request) = SessionOpenRequest::parse(&bytes) else { return pass(parts, bytes).await };
    let caller = guest.as_ref().map_or(OpenCaller::Owner, |g| OpenCaller::Guest { root: g.root.clone() });
    match decide_detached(&st, request, caller, guest).await {
        Decision::Opened(opened) => {
            let mut response = crate::session_write::json_response(StatusCode::OK, opened.body);
            crate::routes::cors(&parts.headers, response.headers_mut());
            response
        }
        Decision::Refused(error) => {
            let mut response = reply(&error);
            crate::routes::cors(&parts.headers, response.headers_mut());
            response
        }
        Decision::NotOurs => {
            parts.headers.insert(DECLINED, axum::http::HeaderValue::from_static("python"));
            pass(parts, bytes).await
        }
    }
}

/// `POST /api/sessions/{name}/bastao` do dono: o Python monta e grava o dossiê (é dele) e, com a
/// sucessora Claude com terminal, devolve o pedido de abertura em vez de abrir; o Rust abre com o
/// kick-off como primeira mensagem. Sucessora de outro provedor o Python cria como sempre.
pub async fn bastao(State(st): State<Arc<AppState>>, ConnectInfo(peer): ConnectInfo<SocketAddr>, req: Request) -> Response {
    let (fwd, owner) = crate::routes::gate(&st, peer, &req);
    let (mut parts, body) = req.into_parts();
    parts.headers.remove(DECLINED);
    let Ok(bytes) = to_bytes(body, crate::session_write::BODY_LIMIT).await else {
        return crate::session_write::too_large(&parts.headers);
    };
    let headers = parts.headers.clone();
    if owner { parts.headers.insert(DECLINED, axum::http::HeaderValue::from_static("rust")); }
    let response = crate::routes::pass(&st, Request::from_parts(parts, Body::from(bytes)), &fwd).await;
    if !owner || response.headers().get(DECLINED).is_none_or(|v| v != "rust") { return response; }
    let prepared: Value = match to_bytes(response.into_body(), crate::session_write::BODY_LIMIT).await {
        Ok(raw) => serde_json::from_slice(&raw).unwrap_or(Value::Null),
        Err(_) => Value::Null,
    };
    let mut response = match SessionOpenRequest::parse(prepared["open"].to_string().as_bytes()) {
        Err(_) => reply(&OpenError::new(502, "erro_criacao_sessao", "o preparo do bastão não devolveu um pedido de abertura")),
        Ok(request) => match decide_detached(&st, request, OpenCaller::Owner, None).await {
            Decision::Opened(opened) => crate::session_write::json_response(StatusCode::OK, json!({"name": opened.body["name"],
                "dossie": prepared["dossie"], "texto": prepared["texto"], "kickoff": prepared["kickoff"], "aviso": prepared["aviso"],
                "avisos": opened.body["avisos"]})),
            Decision::Refused(error) => reply(&error),
            Decision::NotOurs => reply(&OpenError::new(500, "erro_criacao_sessao", "a sucessora do bastão não é Claude com terminal")),
        },
    };
    crate::routes::cors(&headers, response.headers_mut());
    response
}

/// `/__hangar_server/sessions/open`: o que entra pelo Python (convidado com a pasta dele, Connect,
/// MCP, bastão) abre aqui pelo mesmo caminho. `{"request": …, "guest_root": …}`; o que não é do Rust
/// volta 421 e o Python segue. A worktree criada volta junto: o registro do convidado a desfaz se falhar.
pub async fn bridge(State(st): State<Arc<AppState>>, ConnectInfo(peer): ConnectInfo<SocketAddr>, req: Request) -> Response {
    if !crate::workspace_routes::private_ok(&st, peer, req.headers()) { return StatusCode::NOT_FOUND.into_response(); }
    let Ok(bytes) = to_bytes(req.into_body(), crate::session_write::BODY_LIMIT).await else { return StatusCode::PAYLOAD_TOO_LARGE.into_response() };
    let Ok(envelope) = serde_json::from_slice::<Value>(&bytes) else { return StatusCode::MISDIRECTED_REQUEST.into_response() };
    let Ok(request) = SessionOpenRequest::parse(envelope["request"].to_string().as_bytes()) else {
        return StatusCode::MISDIRECTED_REQUEST.into_response();
    };
    let caller = match envelope["guest_root"].as_str() {
        Some(root) => OpenCaller::Guest { root: PathBuf::from(root) },
        None => OpenCaller::Owner,
    };
    match decide_detached(&st, request, caller, None).await {
        Decision::Opened(opened) => crate::session_write::json_response(StatusCode::OK, json!({"info": opened.body, "undo": opened.undo})),
        Decision::Refused(error) => reply(&error),
        Decision::NotOurs => StatusCode::MISDIRECTED_REQUEST.into_response(),
    }
}
