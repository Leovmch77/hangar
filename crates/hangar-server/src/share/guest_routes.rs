//! Rotas do convidado que não pedem sessão (`share_guest_api.py`): a página do link, o resgate do
//! código e o `attach` de `external_pair_api.py`.
use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;

use axum::{Extension, Router, body::Bytes, extract::{Path, State}, http::{StatusCode, header}, response::{IntoResponse, Response}, routing::{get, post}};
use serde_json::{Value, json};

use super::ShareState;
use super::caller::Caller;
use super::store::{Kind, PeekError};
use super::tunnel::{self, DynTailscale, FUNNEL_PORT, GUEST_PORT, Output, Tailscale};

/// Endereço LOCAL da conexão na 8766: o Funnel entrega por loopback, a rede da casa pelo IP dela.
/// Quem aceita a conexão põe nas extensões do pedido.
#[derive(Clone, Copy, Debug)]
pub struct LocalAddr(pub SocketAddr);

struct GuestRoutes {
    share: Arc<ShareState>,
    owner: String,
}

type St = State<Arc<GuestRoutes>>;

// Mesmo contorno do `owner_routes`: pelo `Arc<dyn …>` o handler não prova `Send`.
struct Ts<'a>(&'a Arc<dyn DynTailscale>);

impl Tailscale for Ts<'_> {
    async fn run(&self, args: &[&str]) -> Result<Output, String> { (**self.0).run_boxed(args).await }
    fn needs_operator(&self) -> bool { (**self.0).needs_operator_dyn() }
    fn user(&self) -> String { (**self.0).user_dyn() }
}

/// Nome do dono na página e no resgate: `HANGAR_SERVER_ID` (o `CP_SERVER_ID`), senão o da máquina.
pub fn owner_name() -> String {
    std::env::var("HANGAR_SERVER_ID").ok().filter(|v| !v.is_empty())
        .or_else(sysinfo::System::host_name).unwrap_or_default()
}

// ponytail: página em pt-BR fixa, fora do Paraglide; é a única tela servida pela porta do convite.
const PAGE_HEAD: &str = r#"<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>Convite do Hangar</title>
<style>body{font-family:system-ui,sans-serif;max-width:28rem;margin:3rem auto;padding:0 1rem;
color:#1b1b1f;background:#fafafa}@media(prefers-color-scheme:dark){body{color:#eee;background:#161618}}
a,button{display:block;width:100%;margin:.6rem 0;padding:.8rem;border-radius:.6rem;font-size:1rem;
text-align:center;border:1px solid #888;background:transparent;color:inherit;text-decoration:none}
.p{background:#3b6ef5;color:#fff;border-color:#3b6ef5}</style></head><body>"#;

fn page(body: &str) -> String { format!("{PAGE_HEAD}{body}</body></html>") }

/// `html.escape` do Python (com aspas).
fn escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;").replace('\'', "&#x27;")
}

/// `quote(s, safe='')`: só letras, dígitos e `_.-~` passam.
const QUOTE: &percent_encoding::AsciiSet = &percent_encoding::NON_ALPHANUMERIC.remove(b'_').remove(b'.').remove(b'-').remove(b'~');

fn reason(e: &PeekError) -> (&'static str, &'static str, &'static str) {
    match e {
        PeekError::Used => ("used", "erro_convite_usado", "este convite já foi usado"),
        PeekError::Expired => ("expired", "erro_convite_vencido", "este convite venceu"),
        PeekError::Revoked => ("revoked", "erro_convite_revogado", "este convite foi cancelado por quem compartilhou"),
        PeekError::Unknown | PeekError::Io(_) => ("unknown", "erro_convite_inexistente", "convite não encontrado"),
    }
}

fn json_response(status: StatusCode, v: Value) -> Response {
    (status, [(header::CONTENT_TYPE, "application/json")], v.to_string()).into_response()
}

fn refused(status: StatusCode, code: &str, msg: &str, params: Value) -> Response {
    json_response(status, json!({"detail": {"code": code, "params": params, "msg": msg}}))
}

/// IP da rede por onde o convidado chegou; `None` quando veio pelo Funnel (que fala com loopback).
fn lan_ip(local: Option<Extension<LocalAddr>>) -> Option<IpAddr> {
    let ip = local?.0.0.ip().to_canonical();
    (!ip.is_loopback() && !ip.is_unspecified()).then_some(ip)
}

/// `host:porta` com IPv6 entre colchetes.
fn lan_host(ip: IpAddr) -> String { SocketAddr::new(ip, GUEST_PORT).to_string() }

async fn funnel_host(share: &ShareState) -> Result<String, String> {
    Ok(format!("{}:{FUNNEL_PORT}", tunnel::host(&Ts(&share.tailscale)).await?))
}

fn html(status: StatusCode, body: String, referrer: bool) -> Response {
    let mut resp = (status, [(header::CONTENT_TYPE, "text/html; charset=utf-8"), (header::CACHE_CONTROL, "no-store")], body).into_response();
    if referrer {
        resp.headers_mut().insert(header::REFERRER_POLICY, header::HeaderValue::from_static("no-referrer"));
    }
    resp
}

async fn invite_page(State(st): St, Path(code): Path<String>, local: Option<Extension<LocalAddr>>) -> Response {
    // GET nunca gasta o código: o WhatsApp abre o link sozinho pra montar a prévia.
    let body = match st.share.store.peek(&code, Kind::Share) {
        Err(e) => format!("<h1>Convite indisponível</h1><p>{}.</p>", escape(reason(&e).2)),
        Ok(share) => {
            let host = match lan_ip(local) {
                Some(ip) => lan_host(ip),
                None => match funnel_host(&st.share).await {
                    Ok(h) => h,
                    Err(_) => return html(StatusCode::SERVICE_UNAVAILABLE, page(
                        "<h1>Convite indisponível</h1><p>O convite está indisponível por instantes. Tente de novo.</p>"), false),
                },
            };
            let app_link = format!("hangar://convite/{host}/{}", percent_encoding::utf8_percent_encode(&code, QUOTE));
            format!(
                "<h1>{} compartilhou uma sessão</h1><p>Sessão <b>{}</b>. Abra no teu Hangar para ela aparecer na tua lista.</p>\
                 <a class=\"p\" href=\"{}\">Abrir no app Hangar</a>\
                 <button onclick=\"navigator.clipboard.writeText(location.href);this.textContent='Convite copiado'\">Copiar convite</button>\
                 <p>No Hangar web ou no celular: Configurações → Máquinas → Colar convite.</p>",
                escape(&st.owner), escape(&share.session), escape(&app_link))
        }
    };
    html(StatusCode::OK, page(&body), true)
}

/// Campos texto do corpo como o Pydantic: obrigatório ausente ou não-texto é 422.
fn str_fields(body: &Bytes, fields: &[(&str, bool)]) -> Result<Vec<String>, Response> {
    let invalid = |issues: Vec<Value>| json_response(StatusCode::UNPROCESSABLE_ENTITY, json!({"detail": issues}));
    let v: Value = serde_json::from_slice(body).map_err(|_| invalid(vec![json!({
        "type": "json_invalid", "loc": ["body", 0], "msg": "JSON decode error", "input": {}, "ctx": {"error": "Expecting value"}})]))?;
    if !v.is_object() {
        return Err(invalid(vec![json!({"type": "model_attributes_type", "loc": ["body"],
            "msg": "Input should be a valid dictionary or object to extract fields from", "input": v})]));
    }
    let mut out = Vec::new();
    let mut issues = Vec::new();
    for (name, required) in fields {
        match v.get(*name) {
            None if *required => issues.push(json!({"type": "missing", "loc": ["body", name], "msg": "Field required", "input": v})),
            None => out.push(String::new()),
            Some(Value::String(s)) => out.push(s.clone()),
            Some(other) => issues.push(json!({"type": "string_type", "loc": ["body", name], "msg": "Input should be a valid string", "input": other})),
        }
    }
    if issues.is_empty() { Ok(out) } else { Err(invalid(issues)) }
}

async fn redeem(State(st): St, local: Option<Extension<LocalAddr>>, body: Bytes) -> Response {
    let [code, device, token] = match str_fields(&body, &[("code", true), ("device", false), ("token", false)]) {
        Ok(v) => <[String; 3]>::try_from(v).expect("três campos"),
        Err(r) => return r,
    };
    // O endereço sai ANTES do resgate: túnel fora do ar não pode queimar um código já gasto.
    let address = match lan_ip(local) {
        Some(ip) => format!("http://{}", lan_host(ip)),
        None => match funnel_host(&st.share).await {
            Ok(h) => format!("https://{h}"),
            Err(_) => return refused(StatusCode::SERVICE_UNAVAILABLE, "erro_sessao_indisponivel",
                "a sessão compartilhada está indisponível por instantes", json!({})),
        },
    };
    match st.share.store.redeem(&code, &device, Some(&token), Kind::Share) {
        Ok((share, token)) => json_response(StatusCode::OK,
            json!({"token": token, "session": share.session, "owner": st.owner, "address": address})),
        // O Python não tratava falha de disco: virava o 500 cru do servidor.
        Err(PeekError::Io(e)) => {
            tracing::warn!(%e, "[share] gravar resgate falhou");
            (StatusCode::INTERNAL_SERVER_ERROR, "Internal Server Error").into_response()
        }
        Err(e) => {
            let (why, err, msg) = reason(&e);
            let status = if e == PeekError::Unknown { StatusCode::NOT_FOUND } else { StatusCode::GONE };
            refused(status, err, msg, json!({"reason": why}))
        }
    }
}

async fn attach(State(st): St, caller: Option<Extension<Caller>>, body: Bytes) -> Response {
    let Some(Extension(Caller::Guest(grant))) = caller else {
        return refused(StatusCode::FORBIDDEN, "erro_fora_do_convite", "só convidado", json!({}));
    };
    let [other] = match str_fields(&body, &[("token", true)]) {
        Ok(v) => <[String; 1]>::try_from(v).expect("um campo"),
        Err(r) => return r,
    };
    let store = &st.share.store;
    if store.lookup_token(&other).is_none_or(|g| g.sessions().is_empty()) {
        return refused(StatusCode::CONFLICT, "erro_par_attach_invalido", "token a ligar inválido ou sem sessão viva", json!({}));
    }
    match store.attach(&grant.token, &other) {
        Ok(n) => json_response(StatusCode::OK, json!({"attached": n})),
        Err(e) => {
            tracing::warn!(%e, "[share] gravar attach falhou");
            (StatusCode::INTERNAL_SERVER_ERROR, "Internal Server Error").into_response()
        }
    }
}

/// Rotas do convidado na 8766; o porteiro (`gate::guard`) fica na frente e deixa a página e o
/// resgate passarem sem token.
pub fn guest_router(share: Arc<ShareState>, owner: String) -> Router {
    Router::new()
        .route("/convite/{code}", get(invite_page))
        .route("/api/guest/redeem", post(redeem))
        .route("/api/guest/attach", post(attach))
        .with_state(Arc::new(GuestRoutes { share, owner }))
}
