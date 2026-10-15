//! A abertura com o servidor fora do ar (`hangar-open open`, D-013): a mesma biblioteca do servidor,
//! sem o que só ele guarda (fila, grupos, lista, diário). A sessão nasce igual, com o spec gravado, e
//! o servidor a adota quando voltar, pela varredura de sempre.
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

use futures_util::future::BoxFuture;
use serde_json::Value;

use super::OpenError;
use super::claude::PluginBridge;
use super::open::{Born, OpenHost, ProgramOutput};
use super::terminal::{Mux, ProcessMux, TerminalEnv};

pub struct LocalHost { home: PathBuf, env: BTreeMap<String, String>, terminal: TerminalEnv, mux: ProcessMux, bridge: Option<PluginBridge> }

impl LocalHost {
    /// `env`: o ambiente que o servidor teria; `bridge`: a porta e o token do `.env` dele, para a
    /// ponte do plugin valer quando ele voltar (o token é derivado, não sorteado).
    pub fn new(env: BTreeMap<String, String>, bridge: Option<PluginBridge>) -> Self {
        let accounts = crate::accounts::environment::AccountEnvironment::from_map(env.clone());
        let terminal = TerminalEnv::local(&accounts.home, &env);
        Self { home: accounts.home, env, terminal, mux: ProcessMux::default(), bridge }
    }
}

impl OpenHost for LocalHost {
    fn home(&self) -> &Path { &self.home }
    fn env(&self) -> &BTreeMap<String, String> { &self.env }
    fn terminal(&self) -> &TerminalEnv { &self.terminal }
    fn mux(&self) -> &dyn Mux { &self.mux }
    fn bridge(&self) -> Option<PluginBridge> { self.bridge.clone() }
    fn server_projects(&self) -> PathBuf {
        crate::accounts::environment::AccountEnvironment::from_map(self.env.clone()).claude_base.join("projects")
    }
    fn run(&self, argv: Vec<String>, timeout: Duration) -> BoxFuture<'_, ProgramOutput> {
        Box::pin(super::server::run_program(&self.env, argv, timeout))
    }
    fn customizations(&self, _args: Value) -> BoxFuture<'_, Result<Value, OpenError>> {
        Box::pin(async { Err(OpenError::new(503, "claude_customizations_unavailable", "plugins e skills por sessão precisam do servidor no ar")) })
    }
    // ponytail: grupo, fila e `then` do nome reusado ficam para o servidor (a varredura de membro
    // morto e a adoção); sem ele não há onde limpá-los.
    fn leave_old_group<'a>(&'a self, _name: &'a str) -> BoxFuture<'a, Result<(), OpenError>> { Box::pin(async { Ok(()) }) }
    fn release_name<'a>(&'a self, _name: &'a str) -> BoxFuture<'a, Result<(), OpenError>> { Box::pin(async { Ok(()) }) }
    fn born<'a>(&'a self, _born: &'a Born) -> BoxFuture<'a, Vec<String>> { Box::pin(async { Vec::new() }) }
    fn diary(&self, _events: Vec<Value>) {}
    fn new_session_id(&self) -> String { super::open::uuid4(&crate::mods::state::random_hex(16)) }
    fn new_bridge_key(&self) -> String { crate::mods::state::random_hex(16) }
}
