//! Quem chama e o que o convidado alcança: as listas do `share_gate.py`, copiadas.
use std::collections::HashMap;
use std::sync::Arc;

use axum::http::Method;

use super::store::{Guest, Kind};

#[derive(Clone, Debug)]
pub enum Caller {
    Owner,
    Guest(Arc<GuestGrant>),
}

/// Fotografia do token no momento do pedido: sessões vivas e o nível de cada uma.
#[derive(Clone, Debug)]
pub struct GuestGrant {
    pub token: String,
    pub token_hash: String,
    pub sessions: HashMap<String, Kind>,
    /// Sessões dos registros de par que são raiz (não cópia de `attach`).
    pub pair_roots: Vec<String>,
}

impl Caller {
    /// Quem pode usar a sessão nesse método: o dono sempre; o convidado só nas do convite, e o de
    /// par só lendo. O recorte fino por rota é do porteiro; este é o do handler.
    pub fn can(&self, name: &str, method: &Method) -> bool {
        match self {
            Caller::Owner => true,
            Caller::Guest(grant) => match grant.sessions.get(name) {
                Some(Kind::Share) => true,
                Some(Kind::Pair) => *method == Method::GET,
                None => false,
            },
        }
    }

    pub fn grant(&self) -> Option<&Arc<GuestGrant>> {
        match self { Caller::Guest(grant) => Some(grant), Caller::Owner => None }
    }
}

/// O `Caller` que o porteiro da 8766 pôs no pedido; na 8765 nunca há um (ver `routes::who`).
pub fn caller(req: &axum::extract::Request) -> Option<&Caller> {
    req.extensions().get::<Caller>()
}

impl GuestGrant {
    pub fn new(token: &str, guest: &Guest) -> Self {
        let sessions = guest.sessions().into_iter()
            .filter_map(|name| guest.kind_of(&name).map(|kind| (name, kind)))
            .collect();
        let pair_roots = guest.pair_shares().into_iter().map(|s| s.session.clone()).collect();
        Self { token: token.into(), token_hash: guest.token_hash.clone(), sessions, pair_roots }
    }
}

const LIST_ROUTES: &[(&str, &str)] = &[("GET", "/api/sessions"), ("GET", "/api/sessions/events")];
const GLOBAL_ROUTES: &[(&str, &str)] = &[
    ("GET", "/api/model-options"),
    ("GET", "/api/engines"),
    ("GET", "/api/harness/codex/opcoes"),
    ("POST", "/api/ditado/relimpar"),
    ("POST", "/api/pensamento/pt"),
    ("POST", "/api/tts"),
    ("POST", "/api/tts/narrar"),
];
const GLOBAL_PREFIXES: &[(&str, &str)] = &[("GET", "/api/tts/audio/")];
// Alcançam outra sessão do dono ou abrem janela na tela dele; `share` deixaria o convidado
// criar e revogar convites.
const BLOCKED: &[&str] = &["pair", "pair-remote", "unpair-remote", "group-message", "then", "orq", "bastao",
    "open-terminal", "open-editor", "nav", "share", "pair-invite", "pair-accept"];
// Leituras do chat do nativo: quem só vê a sessão pareada não alcança arquivo, terminal nem git.
const PAIR_READ: &[&str] = &["", "events", "history", "commands", "plan-preview", "subagents", "uploads",
    "transcript-image"];
const PAIR_ROUTES: &[(&str, &str)] = &[("POST", "/api/pair/message"), ("DELETE", "/api/pair")];
const ANY_GUEST_ROUTES: &[(&str, &str)] = &[("POST", "/api/guest/attach")];

fn has(list: &[(&str, &str)], method: &str, path: &str) -> bool {
    list.iter().any(|(m, p)| *m == method && *p == path)
}

/// Sessão que a rota nomeia (o terminal `term-X/term` conta como X); `None` fora de sessão.
pub fn path_session(path: &str) -> Option<String> {
    let parts: Vec<&str> = path.split('/').collect();
    if parts.len() < 4 || parts[1..3] != ["api", "sessions"] || parts[3] == "events" {
        return None;
    }
    let name = parts[3];
    // Sessão cujo nome começa com "term-" não vira outra: só o terminal `term-X/term`.
    if let Some(inner) = name.strip_prefix("term-")
        && parts[4..] == ["term"]
    {
        return Some(inner.into());
    }
    Some(name.into())
}

pub fn guest_allowed(method: &Method, path: &str, grant: &GuestGrant) -> bool {
    let method = method.as_str();
    if has(LIST_ROUTES, method, path) || has(ANY_GUEST_ROUTES, method, path) {
        return true;
    }
    if has(PAIR_ROUTES, method, path) {
        return !grant.pair_roots.is_empty();
    }
    if has(GLOBAL_ROUTES, method, path) || GLOBAL_PREFIXES.iter().any(|(m, p)| *m == method && path.starts_with(p)) {
        // Token só de par não alcança nem as globais de leitura.
        return grant.sessions.values().any(|k| *k == Kind::Share);
    }
    let parts: Vec<&str> = path.split('/').collect();
    if parts.len() < 4 || parts[1..3] != ["api", "sessions"] {
        return false;
    }
    let (name, rest) = (parts[3], &parts[4..]);
    let Some(kind) = path_session(path).and_then(|s| grant.sessions.get(&s).copied()) else {
        return false;
    };
    if kind == Kind::Pair {
        let head = rest.first().copied().unwrap_or("");
        // Anexo é um arquivo só; a listagem de uploads fica fechada.
        return method == "GET" && !name.starts_with("term-") && PAIR_READ.contains(&head)
            && (head != "uploads" || rest.len() == 2);
    }
    if name.starts_with("term-") {
        return rest == ["term"];
    }
    // Fechar mata a sessão do dono; o convidado só para de acompanhar do lado dele.
    match rest.first() {
        None => method != "DELETE",
        Some(head) => !BLOCKED.contains(head),
    }
}
