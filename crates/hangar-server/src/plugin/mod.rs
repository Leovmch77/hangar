//! Memória e rotas da ponte do plugin do Claude.
pub mod routes;
pub mod sources;
mod store;

pub use store::{Ask, PermissionGate, PluginQuestion, Poll, Pull, Receipt, Store};
pub use crate::terminal_input::{PluginMode, PluginReply, PluginRequest, ServiceError};
