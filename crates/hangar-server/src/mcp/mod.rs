//! Servidor MCP `hangar` em `/mcp/`: as operações do `hangar-send`/`hangar-preview` como tools.
//! Cada tool chama a mesma rota pública que o CLI chama, por dentro do processo; rota que ainda é do
//! Python segue a ele num sentido, pelo repasse do próprio roteador.
pub mod identity;
mod nav;
mod tools;

use std::net::SocketAddr;
use std::sync::{Arc, LazyLock};

use axum::Router;
use axum::extract::{ConnectInfo, Request, State};
use axum::http::StatusCode;
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use rmcp::model::{CallToolRequestParams, CallToolResponse, ListToolsResult, PaginatedRequestParams, ServerCapabilities,
    ServerConfig, Tool};
use rmcp::service::RequestContext;
use rmcp::transport::streamable_http_server::session::local::LocalSessionManager;
use rmcp::transport::{StreamableHttpServerConfig, StreamableHttpService};
use rmcp::{ErrorData, RoleServer, ServerHandler};
use subtle::ConstantTimeEq;

use crate::routes::AppState;

const INSTRUCTIONS: &str = "Hangar: sessões vizinhas e o navegador embutido desta sessão. \
Mostrar algo que você montou ao usuário (desenho, mock de tela, comparação, gráfico, tabela, diagrama): \
html_render, sem esperar pedido; imagem por caminho só para print real de tela. \
Ver ou testar uma página: browser_open e depois browser (um verbo) ou browser_batch (vários já conhecidos); \
tela desconhecida com várias ações: browser_goal, quando a sessão tem o Jev. \
Falar com outra sessão: sessions, send, group, pair; abrir ou fechar: new_session, close_session.";

static CATALOG: LazyLock<Vec<Tool>> = LazyLock::new(|| {
    serde_json::from_str(include_str!("catalog.json")).expect("catalog.json é o catálogo do MCP")
});

/// Nomes antigos (português) que sessões abertas antes do rename ainda chamam: chamáveis, fora do
/// catálogo. Ponte, não API: sai quando não houver sessão viva de antes.
const OLD_NAMES: [(&str, &str); 10] = [("quem_sou", "who_am_i"), ("sessoes", "sessions"), ("enviar", "send"),
    ("grupo", "group"), ("parear", "pair"), ("desparear", "unpair"), ("nova_sessao", "new_session"),
    ("nav_abrir", "browser_open"), ("nav", "browser"), ("nav_lote", "browser_batch")];

#[derive(Clone)]
struct Handler { tools: Arc<tools::Tools> }

impl ServerHandler for Handler {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build()).with_instructions(INSTRUCTIONS)
    }

    async fn list_tools(&self, _: Option<PaginatedRequestParams>, _: RequestContext<RoleServer>) -> Result<ListToolsResult, ErrorData> {
        Ok(ListToolsResult::with_all_items(CATALOG.clone()))
    }

    async fn call_tool(&self, request: CallToolRequestParams, context: RequestContext<RoleServer>) -> Result<CallToolResponse, ErrorData> {
        let headers = context.extensions.get::<axum::http::request::Parts>().map(|p| p.headers.clone()).unwrap_or_default();
        let name = OLD_NAMES.iter().find(|(old, _)| *old == request.name).map_or(&*request.name, |(_, new)| new);
        let args = request.arguments.unwrap_or_default();
        Ok(CallToolResponse::Complete(self.tools.call(name, args, &headers).await))
    }
}

/// `/mcp` e `/mcp/` sobre `api`, o roteador público inteiro: é por ele que as tools chamam as rotas.
pub fn router(st: Arc<AppState>, api: Router) -> Router {
    let tools = Arc::new(tools::Tools::new(st.clone(), api));
    // Só esta máquina fala com o /mcp: Host e Origin de fora são recusados (DNS rebinding).
    let config = StreamableHttpServerConfig::default()
        .with_allowed_origins(["http://127.0.0.1:*", "http://localhost:*", "http://[::1]:*"]);
    let service = StreamableHttpService::new(move || Ok(Handler { tools: tools.clone() }),
        Arc::new(LocalSessionManager::default()), config);
    Router::new().route_service("/mcp", service.clone()).route_service("/mcp/", service)
        .layer(axum::middleware::from_fn_with_state(st, gate))
}

/// O bearer do dono, conferido antes do servidor MCP, e só de quem está nesta máquina (o celular e os
/// peers usam a API normal).
async fn gate(State(st): State<Arc<AppState>>, ConnectInfo(peer): ConnectInfo<SocketAddr>, req: Request, next: Next) -> Response {
    let (client_ip, _) = st.cfg.trusted.resolve(peer.ip(), req.headers());
    if !client_ip.parse::<std::net::IpAddr>().is_ok_and(|ip| ip.is_loopback()) {
        return (StatusCode::FORBIDDEN, [("content-type", "application/json")], r#"{"detail":"so na maquina do backend"}"#).into_response();
    }
    let token = req.headers().get("authorization").and_then(|v| v.as_bytes().strip_prefix(b"Bearer ")).unwrap_or_default();
    let owner = st.cfg.auth_token.as_bytes();
    if token.is_empty() || owner.is_empty() || !bool::from(token.ct_eq(owner)) {
        return (StatusCode::UNAUTHORIZED, [("content-type", "application/json")], r#"{"detail":"unauthorized"}"#).into_response();
    }
    next.run(req).await
}
