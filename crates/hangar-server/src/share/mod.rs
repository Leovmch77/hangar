//! Convites, chaves de convidado, porteiro da 8766 e par externo: o Rust é o único dono.
pub mod store;
pub mod pairs;
pub mod tunnel;
pub mod life;
pub mod caller;
pub mod gate;
pub mod owner_routes;
pub mod guest_routes;
pub mod pair_routes;
pub mod forward;
pub mod bridge;

use std::sync::Arc;

/// O que o porteiro, as rotas do dono, do convidado e do par compartilham.
pub struct ShareState {
    pub store: store::ShareStore,
    pub pairs: pairs::PairStore,
    pub lives: life::Lives,
    pub tailscale: Arc<dyn tunnel::DynTailscale>,
}

/// Estado de convites quando o Python indica o `shares.json`. O `external_pairs.json` mora no
/// `.hangar-pair` da conta padrão, como os grupos; sem as pastas da lista não há onde pôr.
pub fn from_env(shares_file: Option<std::path::PathBuf>, dirs: Option<&crate::list::discover_other::Dirs>,
                mux_program: std::ffi::OsString) -> Option<Arc<ShareState>> {
    let shares_file = shares_file?;
    let Some(dirs) = dirs else {
        tracing::error!("HANGAR_SHARES_FILE sem HANGAR_LIST_DIRS: convites ficam fora do Rust");
        return None;
    };
    let clock: store::Clock = Arc::new(|| std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs_f64()).unwrap_or_default());
    Some(Arc::new(ShareState {
        store: store::ShareStore::open(shares_file, clock),
        pairs: pairs::PairStore::open(dirs.claude.join(".hangar-pair").join("external_pairs.json")),
        lives: life::Lives::new(Arc::new(life::MuxProbe::new(mux_program, dirs.home.clone())), Arc::default()),
        tailscale: Arc::new(tunnel::Real),
    }))
}
