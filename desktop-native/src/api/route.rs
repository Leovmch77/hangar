//! Rota até cada servidor, como o `rota.ts` do web: o endereço da rede local quando ele responde como a MESMA máquina,
//! senão o salvo. O salvo continua sendo a identidade (`Api::identity`); só o caminho da rede muda.
use std::collections::HashMap;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;
use serde_json::Value;
use url::Url;
use super::Api;

// Rede local responde em poucos ms; fora dela o IP não existe ou é outra máquina.
const LAN_TIMEOUT: Duration = Duration::from_millis(800);
const SAVED_TIMEOUT: Duration = Duration::from_secs(4);

/// O endereço da rede local que o servidor informou e o nome com que ele se apresentou. `url` vazio: sem acesso local.
#[derive(Clone, Debug, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Lan { pub url: String, pub id: String }

#[derive(Default)]
struct Known { invite: bool, lan: Option<Lan>, route: Option<Url>, deciding: Arc<tokio::sync::Mutex<()>> }

static TABLE: LazyLock<Mutex<HashMap<String, Known>>> = LazyLock::new(Default::default);
type Learned = Box<dyn Fn(String, Lan) + Send + Sync>;
static LEARNED: Mutex<Option<Learned>> = Mutex::new(None);

fn with<R>(f: impl FnOnce(&mut HashMap<String, Known>) -> R) -> R {
    f(&mut TABLE.lock().unwrap_or_else(|e| e.into_inner()))
}

/// Mesma normalização do `Api::new`, para a chave casar com `Api::identity`.
fn key(address: &str) -> Option<String> {
    let mut url = Url::parse(address.trim()).ok()?;
    if !url.path().ends_with('/') { url.set_path(&format!("{}/", url.path())); }
    Some(url.into())
}

/// O que a entrada guardada sabe. A rede local aprendida nesta execução vale mais que a do arquivo.
pub fn seed(address: &str, invite: bool, lan: Option<&Lan>) {
    let Some(key) = key(address) else { return };
    with(|t| {
        let known = t.entry(key).or_default();
        known.invite = invite;
        if known.lan.is_none() { known.lan = lan.cloned(); }
    });
}

/// Quem guarda a entrada ouve aqui cada rede local nova (identidade, rede).
pub fn on_learned(f: impl Fn(String, Lan) + Send + Sync + 'static) {
    *LEARNED.lock().unwrap_or_else(|e| e.into_inner()) = Some(Box::new(f));
}

/// Conexão caiu: a rede pode ter mudado, a próxima conexão decide de novo.
pub fn forget(api: &Api) {
    with(|t| if let Some(known) = t.get_mut(api.base.as_str()) { known.route = None; });
}

impl Api {
    /// Base dos pedidos: a rota decidida ou, sem decisão, o endereço salvo.
    pub(super) fn route(&self) -> Url {
        with(|t| t.get(self.base.as_str()).and_then(|known| known.route.clone())).unwrap_or_else(|| self.base.clone())
    }
}

fn set_route(key: &str, route: Url) { with(|t| t.entry(key.to_owned()).or_default().route = Some(route)); }

/// Decide a rota antes de conectar. Nunca falha: sem resposta, fica o endereço salvo.
pub async fn ensure(api: &Api) {
    let key = api.identity();
    let Some((skip, gate)) = with(|t| {
        let known = t.entry(key.clone()).or_default();
        known.route.is_none().then(|| (known.invite || api.is_loopback(), known.deciding.clone()))
    }) else { return };
    // Convite e esta própria máquina: o endereço salvo já é o caminho.
    if skip { return set_route(&key, api.base.clone()); }
    // Lista e conversas da mesma máquina reconectam juntas: uma decide, as outras aproveitam.
    let _turn = gate.lock().await;
    let Some(saved) = with(|t| t.get(&key).filter(|k| k.route.is_none()).map(|k| k.lan.clone())) else { return };
    // Primeira vez: pergunta pelo salvo antes de conectar, pra já nascer na rota local.
    let lan = match &saved { Some(lan) => Some(lan.clone()), None => learn(api).await };
    if let Some(lan) = &lan && let Some(route) = lan_url(lan) && same_machine(api, &route, &lan.id).await {
        return set_route(&key, route);
    }
    set_route(&key, api.base.clone());
    // O IP local pode ter mudado (DHCP) ou o bind ter sido aberto depois: atualiza para a próxima.
    if saved.is_some() {
        let api = api.clone();
        tokio::spawn(async move { learn(&api).await; });
    }
}

fn lan_url(lan: &Lan) -> Option<Url> {
    if lan.url.is_empty() || lan.id.is_empty() { return None; }
    key(&lan.url).and_then(|url| Url::parse(&url).ok()).filter(|url| matches!(url.scheme(), "http" | "https") && url.host_str().is_some())
}

async fn ask(api: &Api, mut url: Url, timeout: Duration) -> Option<Value> {
    url.path_segments_mut().ok()?.pop_if_empty().extend(["api", "peers", "identificador"]);
    let r = api.client.get(url).timeout(timeout).send().await.ok()?;
    if !r.status().is_success() { return None; }
    r.json().await.ok()
}

// Mesmo IP em outra rede pode ser outra máquina: o token só vai pro endereço local depois de ele
// provar que conhece o token (HMAC do desafio) e dizer o mesmo nome. Por isso o cliente sem token.
async fn same_machine(api: &Api, route: &Url, id: &str) -> bool {
    let mut raw = [0u8; 16];
    if ring::rand::SecureRandom::fill(&ring::rand::SystemRandom::new(), &mut raw).is_err() { return false; }
    let challenge: String = raw.iter().map(|b| format!("{b:02x}")).collect();
    let mut url = route.clone();
    let Ok(mut segments) = url.path_segments_mut() else { return false };
    segments.pop_if_empty().extend(["api", "peers", "prova"]);
    drop(segments);
    url.query_pairs_mut().append_pair("desafio", &challenge);
    let Ok(r) = api.plain.get(url).timeout(LAN_TIMEOUT).send().await else { return false };
    let Ok(v) = r.error_for_status().map(|r| r.json::<Value>()) else { return false };
    let Ok(v) = v.await else { return false };
    let key = ring::hmac::Key::new(ring::hmac::HMAC_SHA256, api.token.as_bytes());
    let expected: String = ring::hmac::sign(&key, format!("{challenge}|{id}").as_bytes())
        .as_ref().iter().map(|b| format!("{b:02x}")).collect();
    v.get("identificador").and_then(Value::as_str) == Some(id) && v.get("prova").and_then(Value::as_str) == Some(expected.as_str())
}

async fn learn(api: &Api) -> Option<Lan> {
    let answer = ask(api, api.base.clone(), SAVED_TIMEOUT).await?;
    let id = answer.get("identificador").and_then(Value::as_str).filter(|id| !id.is_empty())?.to_owned();
    // Backend antigo não manda `lan_url`: fica como sem acesso local.
    let url = answer.get("lan_url").and_then(Value::as_str).unwrap_or_default().trim_end_matches('/').to_owned();
    let lan = Lan { url, id };
    let key = api.identity();
    let changed = with(|t| {
        let known = t.entry(key.clone()).or_default();
        let changed = known.lan.as_ref() != Some(&lan);
        known.lan = Some(lan.clone());
        changed
    });
    if changed && let Some(notify) = LEARNED.lock().unwrap_or_else(|e| e.into_inner()).as_ref() { notify(key, lan.clone()); }
    Some(lan)
}
