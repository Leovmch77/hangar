//! Cookies lidos direto do perfil em disco (Linux): Chrome, Chromium e Brave pelo arquivo `Cookies` decifrado com a
//! chave do chaveiro, Firefox pelo `cookies.sqlite`, que não tem cifra. Não abre diálogo nenhum no navegador da pessoa
//! e funciona com ele fechado; a depuração remota fica de reserva para quando não há perfil legível.
use std::path::{Path, PathBuf};
use std::process::Command;

use serde_json::{Value, json};

use super::passwords::{decode_hex, decrypt_bytes, fresh_keys, private_dir};

/// Um perfil de navegador com cookies em disco.
#[derive(Clone)]
pub struct Source {
    /// "Chrome — Pessoal": o que a pessoa lê para escolher.
    pub label: String,
    file: PathBuf,
    firefox: bool,
}

pub enum DiskError {
    /// Sem o programa `sqlite3`, que lê o banco.
    NoSqlite,
    /// Os valores estão cifrados e nenhuma chave do chaveiro os abre (chaveiro trancado, outra carteira).
    NoKey,
    /// Os valores estão cifrados e não há `secret-tool` (nem `kwallet-query` no KDE) para pedir a chave.
    NoKeyTool,
    Unreadable(String),
}

impl DiskError {
    /// Chave de i18n (`native_<key>`) do status mostrado ao usuário.
    pub fn status_key(&self) -> &'static str {
        match self {
            Self::NoSqlite => "browser_cookies_no_sqlite",
            Self::NoKey => "browser_cookies_keyring",
            Self::NoKeyTool => "browser_cookies_no_secret_tool",
            Self::Unreadable(_) => "browser_cookies_disk_error",
        }
    }

    pub fn detail(&self) -> &str {
        match self {
            Self::Unreadable(e) => e,
            _ => "",
        }
    }
}

/// O banco `Cookies` de um perfil do Chrome, sem nome para mostrar.
pub fn chrome_file(file: PathBuf) -> Source { Source { label: String::new(), file, firefox: false } }

/// Perfis com cookies, na ordem dos navegadores de `browsers()` e com o perfil "Default" primeiro.
pub fn sources() -> Vec<Source> {
    let mut out = Vec::new();
    for browser in super::browsers() {
        let names: Value = std::fs::read(browser.root.join("Local State")).ok()
            .and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
        let Ok(dirs) = std::fs::read_dir(&browser.root) else { continue };
        let mut found: Vec<(String, PathBuf)> = dirs.flatten().filter_map(|entry| {
            let dir = entry.file_name().to_string_lossy().into_owned();
            if dir != "Default" && !dir.starts_with("Profile ") { return None; }
            let file = [entry.path().join("Cookies"), entry.path().join("Network").join("Cookies")]
                .into_iter().find(|f| f.is_file())?;
            Some((dir, file))
        }).collect();
        found.sort_by_key(|(dir, _)| (dir != "Default", dir.clone()));
        for (dir, file) in found {
            let name = names["profile"]["info_cache"][&dir]["name"].as_str().unwrap_or(&dir);
            out.push(Source { label: format!("{} — {name}", browser.name), file, firefox: false });
        }
    }
    let home = super::dirs_home();
    for (name, root) in [
        ("Firefox", home.join(".mozilla/firefox")),
        ("Firefox", home.join(".var/app/org.mozilla.firefox/.mozilla/firefox")),
        ("LibreWolf", home.join(".librewolf")),
        ("LibreWolf", home.join(".var/app/io.gitlab.librewolf-community/.librewolf")),
        ("Waterfox", home.join(".waterfox")),
        ("Waterfox", home.join(".var/app/net.waterfox.waterfox/.waterfox")),
    ] {
        let Ok(dirs) = std::fs::read_dir(&root) else { continue };
        let mut found: Vec<(String, PathBuf)> = dirs.flatten()
            .map(|e| (e.file_name().to_string_lossy().into_owned(), e.path().join("cookies.sqlite")))
            .filter(|(_, file)| file.is_file()).collect();
        found.sort();
        for (dir, file) in found {
            // `xxxxxxxx.default-release` → `default-release`.
            let profile = dir.split_once('.').map_or(dir.as_str(), |(_, p)| p);
            out.push(Source { label: format!("{name} — {profile}"), file, firefox: true });
        }
    }
    out
}

/// Todos os cookies do perfil como `CookieParam` do `Storage.setCookies`. Bloqueante.
pub fn read(source: &Source) -> Result<Vec<Value>, DiskError> {
    let query = if source.firefox {
        "select hex(host), hex(name), hex(value), hex(path), expiry, isSecure, isHttpOnly, sameSite, '' \
         from moz_cookies where originAttributes = ''".to_owned()
    } else {
        // Cookie particionado (de iframe de outro site) fica de fora; banco antigo nem tem a coluna.
        let partitioned = dump(&source.file, "select count(*) from pragma_table_info('cookies') where name = 'top_frame_site_key'")?
            .first().and_then(|r| r.first()).is_some_and(|n| n != "0");
        format!("select hex(host_key), hex(name), hex(value), hex(path), case when has_expires and is_persistent then expires_utc else 0 end, \
         is_secure, is_httponly, samesite, hex(encrypted_value) from cookies{}", if partitioned { " where top_frame_site_key = ''" } else { "" })
    };
    let rows = dump(&source.file, &query)?;
    if source.firefox {
        return Ok(rows.iter().filter_map(|r| firefox_row(r)).collect());
    }
    let version: Option<u32> = dump(&source.file, "select value from meta where key = 'version'")?
        .first().and_then(|r| r.first()).and_then(|v| v.parse().ok());
    if version.is_none() { eprintln!("[nav] cookies: versao do banco ilegivel em {}", source.file.display()); }
    // Sem valor cifrado nenhum, o chaveiro nem é consultado (pode estar pedindo senha).
    let encrypted = rows.iter().any(|r| r.get(8).is_some_and(|c| !c.is_empty()));
    let keys = if encrypted { fresh_keys() } else { super::passwords::Keys { list: Vec::new(), no_tool: false } };
    chrome_rows(&rows, version, &keys.list).map_err(|e| match e {
        DiskError::NoKey if keys.no_tool => DiskError::NoKeyTool,
        e => e,
    })
}

/// Linhas do Chrome -> cookies. Erro só quando há valor cifrado e nenhum abre: cookie com chave errada não pode virar
/// "0 cookies" calado.
fn chrome_rows(rows: &[Vec<String>], version: Option<u32>, keys: &[Vec<u8>]) -> Result<Vec<Value>, DiskError> {
    let mut out = Vec::new();
    let (mut locked, mut opened) = (0, 0);
    for row in rows {
        let [host, name, value, path, expires, secure, http_only, same_site, cipher] = row.as_slice() else { continue };
        let host = text(host);
        // Microssegundos desde 1601; 0 = cookie de sessão.
        let expires = expires.parse::<i64>().ok().filter(|e| *e > 0).map(|e| (e / 1_000_000 - 11_644_473_600) as f64);
        let same_site = match same_site.as_str() { "0" => Some("None"), "1" => Some("Lax"), "2" => Some("Strict"), _ => None };
        let value = match decode_hex(cipher) {
            Some(cipher) if !cipher.is_empty() => keys.iter().find_map(|key| chrome_value(&cipher, key, &host, version)),
            _ => Some(text(value)),
        };
        let Some(value) = value else {
            // Fica na lista sem valor e marcado: o filtro por site ainda o enxerga, e quem grava o tira e conta.
            locked += 1;
            let mut marker = param(&host, &text(name), "", &text(path), secure == "1", http_only == "1", same_site, expires);
            marker["__locked"] = json!(true);
            out.push(marker);
            continue;
        };
        opened += 1;
        out.push(param(&host, &text(name), &value, &text(path), secure == "1", http_only == "1", same_site, expires));
    }
    if locked > 0 && opened == 0 {
        return Err(DiskError::NoKey);
    }
    Ok(out)
}

/// A partir da versão 24 do banco o texto vem depois do SHA-256 do host: conferir o prefixo também prova que a chave
/// é a certa, sem depender de o valor parecer texto. Versão ilegível aceita as duas formas.
fn chrome_value(cipher: &[u8], key: &[u8], host: &str, version: Option<u32>) -> Option<String> {
    let plain = decrypt_bytes(cipher, key)?;
    let digest = ring::digest::digest(&ring::digest::SHA256, host.as_bytes());
    let plain = match version {
        Some(v) if v >= 24 => plain.strip_prefix(digest.as_ref())?.to_vec(),
        Some(_) => plain,
        None => plain.strip_prefix(digest.as_ref()).map(<[u8]>::to_vec).unwrap_or(plain),
    };
    let text = String::from_utf8(plain).ok()?;
    text.chars().all(|c| !c.is_control()).then_some(text)
}

fn firefox_row(row: &[String]) -> Option<Value> {
    let [host, name, value, path, expiry, secure, http_only, same_site, _] = row else { return None };
    // Segundos nas versões antigas, milissegundos nas novas.
    let expires = expiry.parse::<f64>().ok().filter(|e| *e > 0.0).map(|e| if e > 1e11 { e / 1000.0 } else { e });
    let same_site = match same_site.as_str() { "1" => Some("Lax"), "2" => Some("Strict"), "0" => Some("None"), _ => None };
    Some(param(&text(host), &text(name), &text(value), &text(path), secure == "1", http_only == "1", same_site, expires))
}

/// Cookie só do host (sem o ponto inicial) vai por `url`: com `domain` ele viraria cookie do domínio, e os `__Host-`
/// seriam recusados.
#[allow(clippy::too_many_arguments)]
fn param(host: &str, name: &str, value: &str, path: &str, secure: bool, http_only: bool, same_site: Option<&str>,
    expires: Option<f64>) -> Value {
    let path = if path.is_empty() { "/" } else { path };
    let mut o = json!({"name": name, "value": value, "path": path, "secure": secure, "httpOnly": http_only});
    if host.starts_with('.') {
        o["domain"] = json!(host);
    } else {
        o["url"] = json!(format!("{}://{host}{path}", if secure { "https" } else { "http" }));
    }
    // `SameSite=None` sem `Secure` o Chromium recusa; sem o atributo ele aplica o padrão.
    if let Some(s) = same_site.filter(|s| *s != "None" || secure) {
        o["sameSite"] = json!(s);
    }
    if let Some(e) = expires.filter(|e| *e > 0.0) {
        o["expires"] = json!(e);
    }
    o
}

fn text(hex: &str) -> String { decode_hex(hex).map(|b| String::from_utf8_lossy(&b).into_owned()).unwrap_or_default() }

/// Copia o banco (o navegador o mantém travado) com o diário e o WAL, onde ficam as mudanças recentes, e roda o
/// `sqlite3` na cópia. Colunas em hex: nenhum separador colide com o conteúdo.
fn dump(db: &Path, query: &str) -> Result<Vec<Vec<String>>, DiskError> {
    let dir = private_dir().map_err(|e| DiskError::Unreadable(format!("pasta temporária: {e}")))?;
    let copy = dir.join("cookies.db");
    let result = (|| {
        std::fs::copy(db, &copy).map_err(|e| DiskError::Unreadable(format!("{}: {e}", db.display())))?;
        for suffix in ["-wal", "-journal", "-shm"] {
            let side = PathBuf::from(format!("{}{suffix}", db.display()));
            // Sem o WAL as mudanças recentes (o login de agora) ficariam de fora caladas; sumir entre olhar e copiar é normal.
            match std::fs::copy(&side, format!("{}{suffix}", copy.display())) {
                Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(DiskError::Unreadable(format!("{}: {e}", side.display()))),
                _ => {}
            }
        }
        let out = Command::new("sqlite3").args(["-readonly", "-separator", "|"]).arg(&copy).arg(query).output()
            .map_err(|e| if e.kind() == std::io::ErrorKind::NotFound { DiskError::NoSqlite } else {
                DiskError::Unreadable(format!("sqlite3: {e}"))
            })?;
        if !out.status.success() {
            let err = String::from_utf8_lossy(&out.stderr);
            return Err(DiskError::Unreadable(format!("sqlite3: {}", err.trim())));
        }
        Ok(String::from_utf8_lossy(&out.stdout).lines().map(|l| l.split('|').map(str::to_owned).collect()).collect())
    })();
    // A cópia tem os cookies (os do Firefox em texto puro): falha ao apagar fica no diário.
    if let Err(e) = std::fs::remove_dir_all(&dir) { eprintln!("[nav] cookies: copia do banco ficou em {}: {e}", dir.display()); }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex(s: &str) -> String { s.bytes().map(|b| format!("{b:02X}")).collect() }

    #[test]
    fn host_only_cookie_goes_by_url_and_domain_cookie_by_domain() {
        let host_only = param("app.x.com", "__Host-a", "1", "/", true, true, Some("Lax"), None);
        assert_eq!(host_only["url"], "https://app.x.com/");
        assert!(host_only.get("domain").is_none());
        let domain = param(".x.com", "b", "2", "", false, false, Some("None"), Some(1.9e9));
        assert_eq!(domain["domain"], ".x.com");
        assert_eq!(domain["path"], "/");
        assert!(domain.get("sameSite").is_none(), "SameSite=None sem Secure seria recusado");
        assert_eq!(domain["expires"], 1.9e9);
    }

    #[test]
    fn chrome_v24_value_needs_the_host_digest_prefix() {
        use cbc::cipher::{BlockEncryptMut, KeyIvInit, block_padding::Pkcs7};
        type Enc = cbc::Encryptor<aes::Aes128>;
        let mut key = [0u8; 16];
        ring::pbkdf2::derive(ring::pbkdf2::PBKDF2_HMAC_SHA1, std::num::NonZeroU32::new(1).unwrap(), b"saltysalt", b"k", &mut key);
        let mut plain = ring::digest::digest(&ring::digest::SHA256, b".x.com").as_ref().to_vec();
        plain.extend_from_slice(b"segredo");
        let mut buf = vec![0u8; plain.len() + 16];
        buf[..plain.len()].copy_from_slice(&plain);
        let mut cipher = b"v11".to_vec();
        cipher.extend_from_slice(Enc::new((&key).into(), (&[0x20u8; 16]).into()).encrypt_padded_mut::<Pkcs7>(&mut buf, plain.len()).unwrap());
        assert_eq!(chrome_value(&cipher, b"k", ".x.com", Some(24)).as_deref(), Some("segredo"));
        assert!(chrome_value(&cipher, b"k", ".y.com", Some(24)).is_none(), "prefixo de outro host");
        assert!(chrome_value(&cipher, b"errada", ".x.com", Some(24)).is_none());
        // Versão do banco ilegível: o prefixo do host ainda é reconhecido, em vez de tudo virar "chaveiro".
        assert_eq!(chrome_value(&cipher, b"k", ".x.com", None).as_deref(), Some("segredo"));

        let hexed: String = cipher.iter().map(|b| format!("{b:02X}")).collect();
        let row = |c: &str| vec![hex(".x.com"), hex("sid"), String::new(), hex("/"), "13400000000000000".into(), "1".into(), "1".into(), "1".into(), c.to_owned()];
        let ok = chrome_rows(&[row(&hexed)], Some(24), &[b"k".to_vec()]).ok().unwrap();
        assert_eq!(ok[0]["value"], "segredo");
        assert_eq!(ok[0]["sameSite"], "Lax");
        assert!(matches!(chrome_rows(&[row(&hexed)], Some(24), &[b"errada".to_vec()]), Err(DiskError::NoKey)));
    }

    #[test]
    fn firefox_expiry_in_milliseconds_becomes_seconds() {
        let row = vec![hex(".x.com"), hex("a"), hex("b"), hex("/"), "1900000000000".into(), "1".into(), "0".into(), "2".into(), String::new()];
        let c = firefox_row(&row).unwrap();
        assert_eq!(c["expires"], 1.9e9);
        assert_eq!(c["sameSite"], "Strict");
    }
}
