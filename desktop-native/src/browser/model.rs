//! Estado da página e regras de endereço, sem nada nativo. Portado do Zeron (MIT).
use std::net::IpAddr;

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct PageState {
    pub url: Option<String>,
    pub title: String,
    pub loading: bool,
    pub can_back: bool,
    pub can_forward: bool,
    pub error: Option<String>,
}

pub fn loopback(url: &url::Url) -> bool {
    match url.host() {
        Some(url::Host::Domain(host)) => host == "localhost" || host.ends_with(".localhost"),
        Some(url::Host::Ipv4(ip)) => IpAddr::V4(ip).is_loopback(),
        Some(url::Host::Ipv6(ip)) => IpAddr::V6(ip).is_loopback(),
        None => false,
    }
}

/// O erro é o sufixo da chave de tradução (`crate::i18n::tr`), para o teste não depender do idioma.
pub fn normalize_address(input: &str) -> Result<String, &'static str> {
    let text = input.trim();
    if text.is_empty() {
        return Err("browser_address_empty");
    }
    if text.chars().any(|c| c.is_control()) {
        return Err("browser_address_invalid_chars");
    }
    // `host:porta` parece esquema para o parser de URL; só aceita a ambiguidade com porta numérica.
    let authority = text.split(['/', '?', '#']).next().unwrap_or(text);
    let host_port = authority
        .rsplit_once(':')
        .is_some_and(|(_, port)| !port.is_empty() && port.chars().all(|c| c.is_ascii_digit()));
    let explicit = text.contains("://") || (text.contains(':') && !host_port && !text.starts_with('['));
    let mut parsed = url::Url::parse(&if explicit { text.to_owned() } else { format!("https://{text}") })
        .map_err(|_| "browser_address_invalid")?;
    if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
        return Err("browser_address_scheme");
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("browser_address_credentials");
    }
    if !explicit && loopback(&parsed) {
        let _ = parsed.set_scheme("http");
    }
    Ok(parsed.into())
}

pub fn allowed_navigation(address: &str) -> bool {
    url::Url::parse(address).is_ok_and(|u| {
        matches!(u.scheme(), "http" | "https") && u.host_str().is_some() && u.username().is_empty() && u.password().is_none()
    })
}

/// Filtro do handler de navegação do motor. No WKWebView ele também vê os iframes, e o handler só recebe a URL:
/// `about:`/`blob:`/`data:` passam para não quebrar frames; o navegador já barra `data:` no nível de cima.
pub fn allowed_request(address: &str) -> bool {
    allowed_navigation(address) || ["about:", "blob:", "data:"].iter().any(|p| address.starts_with(p))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn normalizes_web_addresses_and_loopback_ports() {
        for (input, expected) in [
            ("localhost:3000", "http://localhost:3000/"),
            ("127.0.0.1:5173/a?x=1", "http://127.0.0.1:5173/a?x=1"),
            ("[::1]:8080", "http://[::1]:8080/"),
            ("[::1]", "http://[::1]/"),
            (" app.localhost:3000 ", "http://app.localhost:3000/"),
            ("example.com/path", "https://example.com/path"),
            ("https://localhost:3000", "https://localhost:3000/"),
            ("http://example.com", "http://example.com/"),
        ] {
            assert_eq!(normalize_address(input), Ok(expected.into()), "{input}");
        }
    }
    #[test]
    fn rejects_non_web_schemes_credentials_and_bad_input() {
        for (input, key) in [
            ("", "browser_address_empty"),
            ("javascript:alert(1)", "browser_address_scheme"),
            ("file:///tmp/a", "browser_address_scheme"),
            ("data:text/html,hi", "browser_address_scheme"),
            ("zeron://open/chat/a", "browser_address_scheme"),
            ("https://user:pass@example.com", "browser_address_credentials"),
            ("https://", "browser_address_invalid"),
            ("two words", "browser_address_invalid"),
            ("https://example.com/\nsecret", "browser_address_invalid_chars"),
        ] {
            assert_eq!(normalize_address(input), Err(key), "{input}");
        }
        assert!(!allowed_navigation("javascript:alert(1)"));
        assert!(!allowed_navigation("https://user@example.com/"));
    }
    #[test]
    fn request_filter_blocks_script_and_file_but_keeps_frames() {
        for ok in ["https://example.com/", "about:blank", "about:srcdoc", "blob:https://a.com/x"] {
            assert!(allowed_request(ok), "{ok}");
        }
        for bad in ["javascript:alert(1)", "file:///etc/passwd", "hangar://x", "https://u:p@a.com/"] {
            assert!(!allowed_request(bad), "{bad}");
        }
    }
    #[test]
    fn every_error_key_has_both_translations() {
        let pt: serde_json::Value = serde_json::from_str(include_str!("../../../messages/pt.json")).unwrap();
        let en: serde_json::Value = serde_json::from_str(include_str!("../../../messages/en.json")).unwrap();
        for key in ["empty", "invalid_chars", "invalid", "scheme", "credentials"] {
            let key = format!("native_browser_address_{key}");
            assert!(pt[&key].is_string() && en[&key].is_string(), "{key}");
        }
        // O motor do Linux troca `{url}` no aviso de navegação bloqueada.
        for messages in [&pt, &en] {
            assert!(messages["native_browser_blocked"].as_str().is_some_and(|s| s.contains("{url}")));
        }
    }
}
