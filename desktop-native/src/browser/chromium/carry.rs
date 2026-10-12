//! Cookies que o perfil gravou com a chave do chaveiro, regravados com a chave fixa (`--password-store=basic`). O
//! Chromium com a chave fixa descarta na primeira abertura o que não consegue ler, então o banco antigo é copiado antes
//! de o processo subir e lido dessa cópia depois, fora da thread da interface.
use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    rc::Rc,
    sync::{Mutex, atomic::{AtomicBool, Ordering}},
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

/// Arquivos que o SQLite pode deixar ao lado do banco com mudanças ainda não juntadas.
const SIDES: [&str; 2] = ["-wal", "-journal"];
/// Tentativas da primeira passada que falharam por motivo passageiro (chaveiro trancado, cookie recusado). Passado
/// isto desiste, para não perguntar ao chaveiro a cada abertura para sempre.
const TRIES: u32 = 3;

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
    // Os arquivos do lado vão antes e o banco é copiado para o lado e renomeado: uma queda no meio não deixa cópia
    // truncada passando por inteira.
    let tmp = dir.join(format!("{COPY}.tmp"));
    let copied = SIDES.iter().try_for_each(|side| match std::fs::copy(side_of(&file, side), side_of(&copy, side)) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e),
        _ => Ok(()),
    }).and_then(|_| std::fs::copy(&file, &tmp)).and_then(|_| std::fs::rename(&tmp, &copy));
    match copied {
        Ok(()) => Some(copy),
        Err(e) => { eprintln!("[nav] cookies: copia do banco antigo falhou, os logins antigos se perdem: {e}"); None }
    }
}

/// Depois do aperto de mão: lê a cópia e regrava o que o perfil ainda não tem. A primeira passada grava a marca; a
/// seguinte (`again`) só repõe o que não chegou ao disco e apaga a cópia, sem aviso.
pub async fn run(browser: Rc<Browser>, profile: PathBuf, copy: PathBuf, background: BackgroundExecutor) {
    // Um Chromium que cai e sobe de novo durante a leitura chamaria outra passada sobre a mesma cópia.
    static RUNNING: AtomicBool = AtomicBool::new(false);
    if RUNNING.swap(true, Ordering::AcqRel) { return; }
    struct Done;
    impl Drop for Done { fn drop(&mut self) { RUNNING.store(false, Ordering::Release); } }
    let _done = Done;

    let again = profile.join(CARRIED).exists();
    // `sqlite3` e chaveiro bloqueiam (o chaveiro trancado espera a pessoa): longe da interface.
    let source = copy.clone();
    let read = background.spawn(async move { disk::read(&disk::chrome_file(source)) }).await;
    let cookies = match read {
        Ok(cookies) => cookies,
        // A primeira passada já gravou: o que falhar agora não tira login de ninguém.
        Err(e) if again => {
            eprintln!("[nav] cookies: segunda leitura do banco antigo falhou ({}), copia apagada", e.status_key());
            return remove_copy(&copy);
        }
        Err(DiskError::NoSqlite) => {
            // Instalar o sqlite3 resolve, e a falta dele não chega a perguntar ao chaveiro: tenta em toda abertura.
            eprintln!("[nav] cookies: sem sqlite3, os logins antigos esperam na copia");
            return notice("browser_cookies_carry_no_sqlite");
        }
        // Chaveiro trancado (o prazo de espera) ou sem a ferramenta: pode mudar na próxima abertura, até o limite.
        Err(e @ (DiskError::NoKey | DiskError::NoKeyTool)) => {
            eprintln!("[nav] cookies: banco antigo sem chave ({})", e.status_key());
            return retry_or_give_up(&profile, &copy, true);
        }
        Err(e) => {
            eprintln!("[nav] cookies: banco antigo ilegivel ({} {}), logins antigos perdidos", e.status_key(), e.detail());
            give_up(&profile, &copy, true);
            return;
        }
    };
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
    // Recusa e Chromium que morreu no meio dão o mesmo `written`: sem processo vivo nada é concluído.
    if !browser.alive() {
        eprintln!("[nav] cookies: o Chromium fechou durante a regravacao, tenta na proxima abertura");
        return;
    }
    eprintln!("[nav] cookies do perfil antigo: {written} de {total} regravados, {existing} ja existiam, {fleeting} de sessao ou vencidos, {locked} sem chave");
    if again { return remove_copy(&copy); }
    if total > 0 && written == 0 { return retry_or_give_up(&profile, &copy, false); }
    mark(&profile);
}

/// Conta a tentativa que falhou; no limite, desiste.
fn retry_or_give_up(profile: &Path, copy: &Path, lost: bool) {
    let tries = side_of(copy, ".tries");
    let n = std::fs::read_to_string(&tries).ok().and_then(|t| t.trim().parse::<u32>().ok()).unwrap_or(0) + 1;
    if n >= TRIES { return give_up(profile, copy, lost); }
    let _ = std::fs::write(&tries, n.to_string());
}

fn give_up(profile: &Path, copy: &Path, lost: bool) {
    eprintln!("[nav] cookies: desisti de trazer os logins antigos");
    mark(profile);
    remove_copy(copy);
    if lost { notice("browser_cookies_carry_lost"); }
}

fn side_of(file: &Path, suffix: &str) -> PathBuf { PathBuf::from(format!("{}{suffix}", file.display())) }

fn remove_copy(copy: &Path) {
    for side in SIDES.into_iter().chain([".tries"]) { let _ = std::fs::remove_file(side_of(copy, side)); }
    let _ = std::fs::remove_file(copy);
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
        std::fs::write(profile.join("Default/Network/Cookies-wal"), "wal").unwrap();
        let copy = prepare(&profile).unwrap();
        assert_eq!(std::fs::read(&copy).unwrap(), b"banco");
        assert_eq!(std::fs::read(side_of(&copy, "-wal")).unwrap(), b"wal");
        // Segunda abertura sem marca: a mesma cópia, sem recopiar o banco que o Chromium já reescreveu.
        std::fs::write(profile.join("Default/Network/Cookies"), "novo").unwrap();
        assert_eq!(std::fs::read(prepare(&profile).unwrap()).unwrap(), b"banco");
        // Falha passageira conta tentativas; no limite desiste, marca e apaga a cópia com os arquivos do lado.
        retry_or_give_up(&profile, &copy, false);
        retry_or_give_up(&profile, &copy, false);
        assert!(copy.exists() && !profile.join(CARRIED).exists());
        retry_or_give_up(&profile, &copy, false);
        assert!(!copy.exists() && !side_of(&copy, ".tries").exists() && !side_of(&copy, "-wal").exists());
        assert!(profile.join(CARRIED).exists());
        // Com a marca e sem cópia, nada mais a fazer.
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
