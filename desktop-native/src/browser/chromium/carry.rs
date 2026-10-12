//! Cookies que o perfil gravou com a chave do chaveiro, regravados com a chave fixa (`--password-store=basic`). O
//! Chromium com a chave fixa descarta na primeira abertura o que não consegue ler, então o banco antigo é copiado antes
//! de o processo subir e lido dessa cópia depois, fora da thread da interface.
use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    rc::Rc,
    sync::Mutex,
};

use gpui_kit::BackgroundExecutor;
use serde_json::{Value, json};

use super::pipe::Browser;
use crate::browser::chrome_import::disk::{self, DiskError};

/// Marca do perfil cujos cookies já foram regravados. A cópia só sai na abertura seguinte à marca, depois de regravar de
/// novo o que faltar: os cookies regravados ficam um tempo só na memória do Chromium, e um app que cai nessa janela os
/// perderia junto com a cópia.
const CARRIED: &str = ".cookies-basic";
const COPY: &str = "Cookies.keyring";

/// Chave de i18n do aviso ao painel quando a regravação falha; mostrado uma vez.
static NOTICE: Mutex<Option<&'static str>> = Mutex::new(None);

pub fn take_notice() -> Option<&'static str> { NOTICE.lock().ok()?.take() }

/// Antes do processo subir: a cópia a regravar, ou `None` se não há nada a fazer.
pub fn prepare(profile: &Path) -> Option<PathBuf> {
    let dir = profile.join("Default");
    let copy = dir.join(COPY);
    if copy.is_file() { return Some(copy); }
    if profile.join(CARRIED).exists() { return None; }
    let Some(file) = [dir.join("Network").join("Cookies"), dir.join("Cookies")].into_iter().find(|f| f.is_file()) else {
        mark(profile);
        return None;
    };
    // Copiada para o lado e renomeada: uma queda no meio não deixa cópia truncada passando por inteira.
    let tmp = dir.join(format!("{COPY}.tmp"));
    match std::fs::copy(&file, &tmp).and_then(|_| std::fs::rename(&tmp, &copy)) {
        Ok(()) => Some(copy),
        Err(e) => { eprintln!("[nav] cookies: copia do banco antigo falhou, os logins antigos se perdem: {e}"); None }
    }
}

/// Depois do aperto de mão: lê a cópia e regrava o que o perfil ainda não tem.
pub async fn run(browser: Rc<Browser>, profile: PathBuf, copy: PathBuf, background: BackgroundExecutor) {
    // `sqlite3` e chaveiro bloqueiam (o chaveiro trancado espera a pessoa): longe da interface.
    let copy_path = copy.clone();
    let read = background.spawn(async move { disk::read(&disk::chrome_file(copy)) }).await;
    let cookies = match read {
        Ok(cookies) => cookies,
        Err(DiskError::NoSqlite) => {
            // Instalar o sqlite3 resolve: a cópia fica e a próxima abertura tenta de novo, sem perguntar ao chaveiro.
            eprintln!("[nav] cookies: sem sqlite3, os logins antigos esperam na copia");
            return notice("browser_cookies_carry_no_sqlite");
        }
        Err(e) => {
            // Chaveiro que não entrega a chave não muda sozinho: perguntar a cada abertura só trava a pessoa.
            eprintln!("[nav] cookies: banco antigo ilegivel ({} {}), logins antigos perdidos", e.status_key(), e.detail());
            mark(&profile);
            let _ = std::fs::remove_file(&copy_path);
            return notice("browser_cookies_carry_lost");
        }
    };
    let again = profile.join(CARRIED).exists();
    let cookies_len = cookies.len();
    let locked = cookies.iter().filter(|c| c.get("__locked").is_some()).count();
    let present: HashSet<(String, String, String)> = match browser.call(None, "Storage.getCookies", json!({})).await {
        Ok(reply) => reply["cookies"].as_array().into_iter().flatten().filter_map(|c| Some((
            c["name"].as_str()?.to_owned(), c["domain"].as_str()?.to_owned(), c["path"].as_str()?.to_owned()))).collect(),
        Err(e) => { eprintln!("[nav] cookies: o perfil novo nao respondeu ({e}), tenta na proxima abertura"); return; }
    };
    // Cookie de sessão o Chromium descarta ao fechar e vencido não vale mais: os dois ficam de fora. Quem já logou de
    // novo no motor novo tem o cookie mais recente: o antigo não o sobrescreve.
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0.0, |d| d.as_secs_f64());
    let lasting: Vec<Value> = cookies.into_iter()
        .filter(|c| c.get("__locked").is_none() && c["expires"].as_f64().is_some_and(|e| e > now)).collect();
    let fleeting = cookies_len - locked - lasting.len();
    let missing: Vec<Value> = lasting.into_iter().filter(|c| key(c).is_none_or(|k| !present.contains(&k))).collect();
    let existing = cookies_len - locked - fleeting - missing.len();
    let (total, written) = (missing.len(), set(&browser, &missing).await);
    eprintln!("[nav] cookies do perfil antigo: {written} de {total} regravados, {existing} ja existiam, {fleeting} de sessao ou vencidos, {locked} sem chave");
    if total > 0 && written == 0 { return; }
    if again { let _ = std::fs::remove_file(&copy_path); } else { mark(&profile); }
}

/// O Chromium recusa o lote inteiro por um cookie inválido: aí vai um por um e só os recusados ficam de fora.
async fn set(browser: &Browser, cookies: &[Value]) -> usize {
    if cookies.is_empty() { return 0; }
    if browser.call(None, "Storage.setCookies", json!({"cookies": cookies})).await.is_ok() { return cookies.len(); }
    let mut written = 0;
    for cookie in cookies {
        if browser.call(None, "Storage.setCookies", json!({"cookies": [cookie]})).await.is_ok() { written += 1; }
    }
    written
}

/// (nome, domínio como o `Storage.getCookies` devolve, caminho).
fn key(cookie: &Value) -> Option<(String, String, String)> {
    let domain = match cookie["domain"].as_str() {
        Some(d) => d.to_owned(),
        None => cookie["url"].as_str()?.split_once("://")?.1.split(['/', ':']).next()?.to_owned(),
    };
    Some((cookie["name"].as_str()?.to_owned(), domain, cookie["path"].as_str().unwrap_or("/").to_owned()))
}

fn mark(profile: &Path) {
    if let Err(e) = std::fs::create_dir_all(profile).and_then(|_| std::fs::write(profile.join(CARRIED), "")) {
        eprintln!("[nav] cookies: marca nao gravada, a conversao se repete: {e}");
    }
}

fn notice(key: &'static str) {
    if let Ok(mut n) = NOTICE.lock() { *n = Some(key); }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn copy_waits_one_launch_after_the_mark_and_an_empty_profile_is_marked() {
        let profile = std::env::temp_dir().join(format!("hangar-carry-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&profile);
        assert!(prepare(&profile).is_none());
        assert!(profile.join(CARRIED).exists());
        std::fs::remove_file(profile.join(CARRIED)).unwrap();
        std::fs::create_dir_all(profile.join("Default/Network")).unwrap();
        std::fs::write(profile.join("Default/Network/Cookies"), "banco").unwrap();
        let copy = prepare(&profile).unwrap();
        assert_eq!(std::fs::read(&copy).unwrap(), b"banco");
        // Segunda abertura sem marca: a mesma cópia, sem recopiar o banco que o Chromium já reescreveu.
        std::fs::write(profile.join("Default/Network/Cookies"), "novo").unwrap();
        assert_eq!(std::fs::read(prepare(&profile).unwrap()).unwrap(), b"banco");
        // Com a marca a cópia ainda volta uma vez (`run` a apaga depois de regravar o que faltar).
        mark(&profile);
        assert_eq!(prepare(&profile), Some(copy.clone()));
        std::fs::remove_file(&copy).unwrap();
        assert!(prepare(&profile).is_none());
        std::fs::remove_dir_all(&profile).unwrap();
    }

    #[test]
    fn key_matches_what_get_cookies_returns() {
        let host_only = json!({"name": "s", "url": "https://a.com:8443/x", "path": "/x"});
        assert_eq!(key(&host_only), Some(("s".into(), "a.com".into(), "/x".into())));
        let domain = json!({"name": "s", "domain": ".a.com", "path": "/"});
        assert_eq!(key(&domain), Some(("s".into(), ".a.com".into(), "/".into())));
    }
}
