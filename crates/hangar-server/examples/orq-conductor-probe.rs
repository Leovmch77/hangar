//! Servidor isolado para medir a rota sem adotar sessões nem instalar hooks.
use hangar_server::{config::Config, routes::AppState};
#[tokio::main]
async fn main() -> std::io::Result<()> {
    let cfg = Config::from_env().expect("configuração de prova");
    let listener = tokio::net::TcpListener::bind(cfg.listen).await?;
    let state = std::sync::Arc::new(AppState::new(cfg));
    axum::serve(
        listener,
        hangar_server::routes::router(state)
            .into_make_service_with_connect_info::<std::net::SocketAddr>(),
    )
    .await
}
