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
