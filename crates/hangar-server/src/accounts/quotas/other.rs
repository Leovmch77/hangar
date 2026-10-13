//! Cota das fontes que não são Claude nem Codex: provedores do Kimi Code (`config.toml`), motores
//! do `engines.json` e o painel do OpenCode Go. Os leitores nunca dizem `expirada`: 401/403/404
//! aqui quase sempre é "esta URL não tem a rota", não chave vencida.
use super::reading;
use crate::accounts::environment::AccountEnvironment;
use reqwest::header::HeaderValue;
use serde_json::{Map, Value, json};
use std::path::{Path, PathBuf};

pub const COMMANDCODE_URL: &str = "https://api.commandcode.ai/alpha/billing/credits";
pub const OPENCODE_URL: &str = "https://opencode.ai/workspace/{}/go";
// Sem User-Agent de navegador o Cloudflare do CommandCode responde 403 (1010) e o painel do
// OpenCode recusa a página.
const COMMANDCODE_UA: &str = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const OPENCODE_UA: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Gecko/20100101 Firefox/148.0";

/// URLs fixas dos leitores; só os testes apontam para outro lugar.
#[derive(Clone, Debug)]
pub struct Endpoints {
    pub commandcode: String,
    pub opencode: String,
}

impl Default for Endpoints {
    fn default() -> Self {
        Self { commandcode: COMMANDCODE_URL.into(), opencode: OPENCODE_URL.into() }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum Reader {
    Kimi { key: String, base: String },
    CommandCode { key: String },
    OpenCode { workspace: String, cookie: String },
}

impl Reader {
    pub fn kind(&self) -> &'static str {
        match self {
            Reader::Kimi { .. } => "kimi",
            Reader::CommandCode { .. } => "commandcode",
            Reader::OpenCode { .. } => "opencode",
        }
    }

    pub fn args(&self) -> Vec<&str> {
        match self {
            Reader::Kimi { key, base } => vec![key, base],
            Reader::CommandCode { key } => vec![key],
            Reader::OpenCode { workspace, cookie } => vec![workspace, cookie],
        }
    }

    /// Endereço lido, sem credencial: muda quando a pessoa troca a `base_url`, e é o que zera a
    /// espera de uma fonte que recusava conexão.
    pub fn url(&self, endpoints: &Endpoints) -> String {
        match self {
            Reader::Kimi { base, .. } => format!("{}/usages", base.trim_end_matches('/')),
            Reader::CommandCode { .. } => endpoints.commandcode.clone(),
            Reader::OpenCode { workspace, .. } => endpoints.opencode.replacen(
                "{}",
                &percent_encoding::utf8_percent_encode(workspace, QUOTE).to_string(),
                1,
            ),
        }
    }
}

/// `urllib.parse.quote(safe="")`: só letras, dígitos e `_.-~` passam.
const QUOTE: &percent_encoding::AsciiSet = &percent_encoding::NON_ALPHANUMERIC
    .remove(b'_')
    .remove(b'.')
    .remove(b'-')
    .remove(b'~');

pub struct Source {
    pub id: String,
    /// Rótulo cru: `label` de motor editado à mão pode não ser texto, e assim mesmo sai na lista.
    pub label: Value,
    pub provider: &'static str,
    pub reader: Reader,
}

impl Source {
    pub fn row(&self) -> Value {
        json!({"id":self.id,"label":self.label,"provedor":self.provider,"ativa":false})
    }
}

fn shared(env: &AccountEnvironment) -> PathBuf {
    env.home.join(".claude")
}

/// O nome novo; o antigo `.claude-pocket-*` só quando o novo não existe (no Windows link de
/// arquivo exige privilégio, e o antigo pode ser o único).
fn read_path(new: PathBuf) -> PathBuf {
    if new.exists() {
        return new;
    }
    let old = new.with_file_name(
        new.file_name().and_then(|n| n.to_str()).unwrap_or("").replacen(".hangar-", ".claude-pocket-", 1),
    );
    if old.exists() { old } else { new }
}

fn env_value<'a>(env: &'a AccountEnvironment, name: &str) -> Option<&'a str> {
    env.base.get(name).map(String::as_str).filter(|v| !v.is_empty())
}

fn json_object(path: &Path) -> Map<String, Value> {
    std::fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default()
}

/// `str.strip()` do Python: também tira os separadores U+001C–U+001F, que o `trim` não tira.
pub fn py_strip(text: &str) -> &str {
    text.trim_matches(|c: char| c.is_whitespace() || ('\u{1c}'..='\u{1f}').contains(&c))
}

/// Apelidos da tela de contas: só texto não vazio, com as pontas aparadas; ilegível = nenhum.
pub fn aliases(env: &AccountEnvironment) -> Map<String, Value> {
    json_object(&read_path(shared(env).join(".hangar-apelidos.json")))
        .into_iter()
        .filter_map(|(id, value)| {
            let alias = py_strip(value.as_str()?);
            (!alias.is_empty()).then(|| (id, json!(alias)))
        })
        .collect()
}

/// Cookies colados na tela, só os completos (`workspace_id` e `auth_cookie` texto não vazio).
pub(crate) fn opencode_saved(env: &AccountEnvironment) -> Map<String, Value> {
    let filled = |value: &Value| value.as_str().is_some_and(|s| !s.is_empty());
    json_object(&read_path(shared(env).join(".hangar-opencode.json")))
        .into_iter()
        .filter(|(_, entry)| filled(&entry["workspace_id"]) && filled(&entry["auth_cookie"]))
        .collect()
}

fn opencode_config(env: &AccountEnvironment, id: &str) -> Option<(String, String)> {
    if let Some(entry) = opencode_saved(env).get(id) {
        let text = |field: &str| entry[field].as_str().unwrap_or_default().to_owned();
        return Some((text("workspace_id"), text("auth_cookie")));
    }
    // Reserva do ambiente (as variáveis do pi-quotas): o que a pessoa colou na tela vence.
    let workspace = py_strip(env.base.get("OPENCODE_GO_WORKSPACE_ID").map_or("", String::as_str));
    let cookie = py_strip(env.base.get("OPENCODE_GO_AUTH_COOKIE").map_or("", String::as_str));
    (!workspace.is_empty() && !cookie.is_empty()).then(|| (workspace.to_owned(), cookie.to_owned()))
}

pub(crate) fn kimi_config(env: &AccountEnvironment) -> PathBuf {
    env_value(env, "KIMI_CODE_HOME").map(PathBuf::from).unwrap_or_else(|| env.home.join(".kimi-code")).join("config.toml")
}

fn kimi_providers(env: &AccountEnvironment) -> Vec<(String, String, String)> {
    let Some(text) = std::fs::read(kimi_config(env)).ok().and_then(|b| String::from_utf8(b).ok()) else {
        return vec![];
    };
    // O `tomllib` recusa o arquivo com BOM.
    if text.starts_with('\u{feff}') {
        return vec![];
    }
    let Ok(table) = text.parse::<toml::Table>() else { return vec![] };
    let Some(providers) = table.get("providers").and_then(toml::Value::as_table) else { return vec![] };
    let filled = |value: Option<&toml::Value>| value.and_then(toml::Value::as_str).filter(|s| !s.is_empty()).map(str::to_owned);
    providers
        .iter()
        .filter_map(|(name, provider)| {
            let provider = provider.as_table()?;
            if provider.get("type").and_then(toml::Value::as_str) != Some("kimi") {
                return None;
            }
            // Provider por OAuth não tem chave aqui: adivinhar o armazenamento dele seria inventar.
            Some((name.clone(), filled(provider.get("api_key"))?, filled(provider.get("base_url"))?))
        })
        .collect()
}

/// `^[a-z0-9][a-z0-9_-]{0,31}$` do Python, cujo `$` também casa antes de uma quebra final.
pub(crate) fn engine_name_ok(name: &str) -> bool {
    static NAME: std::sync::LazyLock<regex::Regex> =
        std::sync::LazyLock::new(|| regex::Regex::new(r"\A[a-z0-9][a-z0-9_-]{0,31}\n?\z").unwrap());
    NAME.is_match(name)
}

pub(crate) fn engines(env: &AccountEnvironment) -> Result<Map<String, Value>, &'static str> {
    let path = env_value(env, "CP_ENGINES_FILE").map(PathBuf::from).unwrap_or_else(|| shared(env).join("engines.json"));
    let bytes = match std::fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Map::new()),
        Err(_) => {
            tracing::warn!(code = "engines_unreadable", "engines.json não pôde ser lido; nenhum motor nesta leitura");
            return Ok(Map::new());
        }
    };
    // ponytail: bytes fora do UTF-8 derrubavam a enumeração inteira no Python; reproduzido até o conserto do D1.
    let text = std::str::from_utf8(&bytes).map_err(|_| "engines_not_utf8")?;
    match parse_json(text.as_bytes()) {
        Some(Value::Object(map)) => Ok(map),
        _ => {
            tracing::warn!(code = "engines_invalid", "engines.json não é um objeto JSON; nenhum motor nesta leitura");
            Ok(Map::new())
        }
    }
}

pub(crate) fn falsy(value: &Value) -> bool {
    match value {
        Value::Null => true,
        Value::Bool(b) => !b,
        Value::Number(n) => n.as_f64() == Some(0.0),
        Value::String(s) => s.is_empty(),
        Value::Array(a) => a.is_empty(),
        Value::Object(o) => o.is_empty(),
    }
}

fn kimi_usages_base(base: &str) -> String {
    // O motor usa `/coding` (formato Anthropic); o `/usages` só existe sob `/v1`.
    if base.contains("api.kimi.com") && !base.trim_end_matches('/').ends_with("/v1") {
        format!("{}/v1", base.trim_end_matches('/'))
    } else {
        base.to_owned()
    }
}

/// Provedores do Kimi Code primeiro, depois os motores, cada grupo na ordem do arquivo. Sem
/// deduplicação: a mesma chave nos dois lugares são duas fontes.
pub fn sources(env: &AccountEnvironment) -> Result<Vec<Source>, &'static str> {
    let mut out = vec![];
    for (name, key, base) in kimi_providers(env) {
        let reader = if base.contains("commandcode.ai") { Reader::CommandCode { key } } else { Reader::Kimi { key, base } };
        out.push(Source { id: format!("kimi:{name}"), label: json!(name), provider: reader.kind(), reader });
    }
    for (name, data) in engines(env)? {
        if !engine_name_ok(&name) {
            continue;
        }
        // ponytail: motor que não é objeto derrubava a enumeração inteira no Python; reproduzido até o conserto do D1.
        let data = data.as_object().ok_or("engine_not_object")?;
        let filled = |field: &str| data.get(field).and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_owned);
        let (Some(key), Some(base)) = (filled("api_key"), filled("base_url")) else { continue };
        let id = format!("chave:{name}");
        let label = data.get("label").filter(|label| !falsy(label)).cloned().unwrap_or_else(|| json!(name));
        let opencode = if base.contains("opencode.ai") { opencode_config(env, &id) } else { None };
        let (provider, reader) = if let Some((workspace, cookie)) = opencode {
            ("opencode", Reader::OpenCode { workspace, cookie })
        } else if base.contains("commandcode.ai") {
            ("commandcode", Reader::CommandCode { key })
        } else {
            ("kimi", Reader::Kimi { key, base: kimi_usages_base(&base) })
        };
        out.push(Source { id, label, provider, reader });
    }
    Ok(out)
}

// ------------------------------------------------------------------------------- semântica Python

/// `float(texto)` do Python: pontas aparadas, `_` só entre dígitos, `inf`/`nan` sem caixa.
pub fn py_float(text: &str) -> Option<f64> {
    let text = py_strip(text);
    let chars: Vec<char> = text.chars().collect();
    for (i, c) in chars.iter().enumerate() {
        if *c == '_'
            && !(i > 0 && chars[i - 1].is_ascii_digit() && chars.get(i + 1).is_some_and(char::is_ascii_digit))
        {
            return None;
        }
    }
    let clean: String = chars.into_iter().filter(|c| *c != '_').collect();
    let unsigned = clean.strip_prefix(['+', '-']).unwrap_or(&clean).to_ascii_lowercase();
    if !matches!(unsigned.as_str(), "inf" | "infinity" | "nan")
        && !unsigned.chars().all(|c| c.is_ascii_digit() || matches!(c, '.' | 'e' | '+' | '-'))
    {
        return None;
    }
    clean.parse::<f64>().ok()
}

fn num(value: &Value) -> Option<f64> {
    match value {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => py_float(s),
        _ => None,
    }
}

/// `max(0.0, min(100.0, x))` do Python: NaN vira 100, como lá.
fn clamp_pct(x: f64) -> f64 {
    let low = if x < 100.0 { x } else { 100.0 };
    if low > 0.0 { low } else { 0.0 }
}

/// JSON como o `json.loads`: aceita `NaN`/`Infinity` fora de texto. Eles viram texto, que o
/// `float()` dos leitores lê igual ao número.
fn parse_json(bytes: &[u8]) -> Option<Value> {
    if let Ok(value) = serde_json::from_slice(bytes) {
        return Some(value);
    }
    let text = std::str::from_utf8(bytes).ok()?;
    let mut out = String::with_capacity(text.len() + 16);
    let (mut in_string, mut escaped) = (false, false);
    let mut rest = text;
    while let Some(c) = rest.chars().next() {
        if in_string {
            out.push(c);
            if escaped {
                escaped = false;
            } else if c == '\\' {
                escaped = true;
            } else if c == '"' {
                in_string = false;
            }
            rest = &rest[c.len_utf8()..];
            continue;
        }
        if let Some(token) = ["-Infinity", "Infinity", "NaN"].into_iter().find(|t| rest.starts_with(t)) {
            out.push('"');
            out.push_str(token);
            out.push('"');
            rest = &rest[token.len()..];
            continue;
        }
        in_string = c == '"';
        out.push(c);
        rest = &rest[c.len_utf8()..];
    }
    serde_json::from_str(&out).ok()
}

/// `datetime.fromisoformat` (com `Z` trocado) até epoch; data sem fuso é hora local.
pub fn py_iso(value: &Value) -> Option<f64> {
    let text = value.as_str().filter(|s| !s.is_empty())?.replace('Z', "+00:00");
    let chars: Vec<char> = text.chars().collect();
    let digits = |from: usize, len: usize| -> Option<u32> {
        let part: String = chars.get(from..from + len)?.iter().collect();
        part.chars().all(|c| c.is_ascii_digit()).then(|| part.parse().ok())?
    };
    let (year, month, day, date_len) = if chars.get(4) == Some(&'-') {
        if chars.get(7) != Some(&'-') {
            return None;
        }
        (digits(0, 4)?, digits(5, 2)?, digits(8, 2)?, 10)
    } else {
        (digits(0, 4)?, digits(4, 2)?, digits(6, 2)?, 8)
    };
    let date = chrono::NaiveDate::from_ymd_opt(year as i32, month, day)?;
    let mut micros_of_day: i64 = 0;
    let mut offset: Option<i64> = None;
    if chars.len() > date_len {
        let time: Vec<char> = chars[date_len + 1..].to_vec();
        let tz = time.iter().position(|c| *c == '+' || *c == '-');
        let clock: String = time[..tz.unwrap_or(time.len())].iter().collect();
        let clock = clock.trim_end();
        let (h, m, s, us) = hh_mm_ss_ff(clock)?;
        if h > 23 {
            return None;
        }
        micros_of_day = ((h * 3600 + m * 60 + s) as i64) * 1_000_000 + us as i64;
        if let Some(at) = tz {
            let zone: String = time[at + 1..].iter().collect();
            if matches!(zone.chars().count(), 0 | 1 | 3) {
                return None;
            }
            let (zh, zm, zs, zus) = hh_mm_ss_ff(&zone)?;
            let total = ((zh * 3600 + zm * 60 + zs) as i64) * 1_000_000 + zus as i64;
            if total >= 86_400_000_000 {
                return None;
            }
            offset = Some(if time[at] == '-' { -total } else { total });
        }
    }
    let midnight = date.and_hms_opt(0, 0, 0)?;
    let micros = match offset {
        Some(offset) => midnight.and_utc().timestamp_micros() + micros_of_day - offset,
        None => {
            use chrono::TimeZone;
            let local = midnight + chrono::Duration::microseconds(micros_of_day);
            chrono::Local.from_local_datetime(&local).earliest()?.timestamp_micros()
        }
    };
    Some(micros as f64 / 1_000_000.0)
}

/// `HH[:?MM[:?SS[{.,}f…]]]`: o separador `:` é do primeiro campo em diante ou de nenhum; fração
/// além de 6 dígitos é cortada.
fn hh_mm_ss_ff(text: &str) -> Option<(u32, u32, u32, u32)> {
    let chars: Vec<char> = text.chars().collect();
    let mut parts = [0u32; 3];
    let mut pos = 0;
    let mut separated = false;
    for (index, part) in parts.iter_mut().enumerate() {
        let field: String = chars.get(pos..pos + 2)?.iter().collect();
        if !field.chars().all(|c| c.is_ascii_digit()) {
            return None;
        }
        *part = field.parse().ok()?;
        pos += 2;
        let next = chars.get(pos);
        if index == 0 {
            separated = next == Some(&':');
        }
        if next.is_none() || index == 2 {
            break;
        }
        if separated {
            if next != Some(&':') {
                break;
            }
            pos += 1;
        } else if !next.is_some_and(char::is_ascii_digit) {
            break;
        }
    }
    let mut micros = 0;
    if pos < chars.len() {
        if !matches!(chars[pos], '.' | ',') {
            return None;
        }
        let fraction: String = chars[pos + 1..].iter().collect();
        if !fraction.chars().all(|c| c.is_ascii_digit()) {
            return None;
        }
        let kept: String = fraction.chars().take(6).collect();
        micros = format!("{kept:0<6}").parse().ok()?;
    }
    let [h, m, s] = parts;
    (m < 60 && s < 60).then_some((h, m, s, micros))
}

/// Rótulo pela duração em minutos; `inf`/`nan` levantavam no `int()` do Python (leitor quebrado).
fn window_label(minutes: &Value) -> Result<String, ()> {
    let Some(n) = num(minutes).filter(|n| !(*n <= 0.0)) else {
        return Ok("janela".into());
    };
    if n >= 1440.0 && n % 1440.0 == 0.0 {
        return Ok(format!("{:.0}d", (n / 1440.0).floor()));
    }
    if n >= 60.0 && n % 60.0 == 0.0 {
        return Ok(format!("{:.0}h", (n / 60.0).floor()));
    }
    if !n.is_finite() {
        return Err(());
    }
    Ok(format!("{:.0}min", n.trunc()))
}

fn window(label: &str, pct: f64, reset: Option<f64>) -> Value {
    json!({"rotulo":label,"pct":clamp_pct(pct),"reset_ts":reset,"por_modelo":false})
}

fn kimi_window(detail: &Value, label: &str) -> Option<Value> {
    let detail = detail.as_object()?;
    let (limit, remaining) = (num(detail.get("limit")?)?, num(detail.get("remaining")?)?);
    if limit <= 0.0 {
        return None;
    }
    Some(window(label, (limit - remaining) / limit * 100.0, detail.get("resetTime").and_then(py_iso)))
}

/// `limits[]` por duração, depois o `usage` do topo como `7d` (a janela do plano).
pub fn kimi(body: &Value) -> Result<Vec<Value>, ()> {
    let mut windows = vec![];
    for item in body["limits"].as_array().into_iter().flatten() {
        if !item.is_object() {
            continue;
        }
        let duration = item["window"].as_object().and_then(|w| w.get("duration")).cloned().unwrap_or(Value::Null);
        let label = window_label(&duration)?;
        windows.extend(kimi_window(&item["detail"], &label));
    }
    windows.extend(kimi_window(&body["usage"], "7d"));
    Ok(windows)
}

fn commandcode_window(value: &Value, label: &str) -> Option<Value> {
    let value = value.as_object()?;
    let (used, cap) = (num(value.get("used")?)?, num(value.get("cap")?)?);
    if cap <= 0.0 {
        return None;
    }
    // `resetAt` em epoch-milissegundos; 0 = janela sem reset marcado.
    let reset = value.get("resetAt").and_then(num).filter(|r| *r != 0.0).map(|r| r / 1000.0);
    Some(window(label, used / cap * 100.0, reset))
}

pub fn commandcode(body: &Value) -> Vec<Value> {
    let limits = body["windowLimits"].as_object().cloned().unwrap_or_default();
    [("fiveHour", "5h"), ("weekly", "7d")]
        .into_iter()
        .filter_map(|(key, label)| commandcode_window(limits.get(key)?, label))
        .collect()
}

/// As três janelas do plano Go no HTML do painel; a ordem dos dois campos muda entre renderizações.
pub fn opencode(html: &str, now: f64) -> Vec<Value> {
    static PATTERNS: std::sync::LazyLock<Vec<(&str, regex::Regex, regex::Regex)>> = std::sync::LazyLock::new(|| {
        const NUM: &str = r"(-?\d+(?:\.\d+)?)";
        [("5h", "rollingUsage"), ("7d", "weeklyUsage"), ("30d", "monthlyUsage")]
            .into_iter()
            .map(|(label, key)| {
                let pct_first = format!(r"{key}:\$R\[\d+\]=\{{[^}}]*usagePercent:{NUM}[^}}]*resetInSec:{NUM}[^}}]*\}}");
                let reset_first = format!(r"{key}:\$R\[\d+\]=\{{[^}}]*resetInSec:{NUM}[^}}]*usagePercent:{NUM}[^}}]*\}}");
                (label, regex::Regex::new(&pct_first).unwrap(), regex::Regex::new(&reset_first).unwrap())
            })
            .collect()
    });
    PATTERNS
        .iter()
        .filter_map(|(label, pct_first, reset_first)| {
            let (pct, wait) = if let Some(c) = pct_first.captures(html) {
                (c[1].parse::<f64>().ok()?, c[2].parse::<f64>().ok()?)
            } else {
                let c = reset_first.captures(html)?;
                (c[2].parse::<f64>().ok()?, c[1].parse::<f64>().ok()?)
            };
            Some(window(label, pct, Some(now + if wait > 0.0 { wait } else { 0.0 })))
        })
        .collect()
}

// ------------------------------------------------------------------------------------------- rede

/// Cliente das fontes: proxy do ambiente, sem seguir redirecionamento (a chave nunca vai a outro
/// endereço) e conexão com prazo curto, para recusa não ocupar o prazo inteiro.
pub fn client() -> Result<reqwest::Client, crate::accounts::catalog::AccountError> {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(10))
        .connect_timeout(std::time::Duration::from_secs(3))
        .build()
        .map_err(|_| crate::accounts::catalog::AccountError::io())
}

enum Fetch {
    Body(u16, Vec<u8>),
    Status(u16),
    NoResponse { unreachable: bool },
    BadHeader,
    BadUrl,
}

async fn get(client: &reqwest::Client, url: &str, headers: &[(&str, String)]) -> Fetch {
    // `urllib.request.Request` recusa endereço sem esquema antes da rede: era leitor quebrado.
    static SCHEME: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| regex::Regex::new(r"\A[^/:]+:").unwrap());
    if !SCHEME.is_match(url) {
        return Fetch::BadUrl;
    }
    let mut request = client.get(url);
    for (name, value) in headers {
        // O valor nunca vai a log nem a erro: é chave ou cookie.
        let Ok(value) = HeaderValue::from_str(value) else { return Fetch::BadHeader };
        request = request.header(*name, value);
    }
    match request.send().await {
        Ok(response) => {
            let status = response.status().as_u16();
            if !response.status().is_success() {
                return Fetch::Status(status);
            }
            match response.bytes().await {
                Ok(body) => Fetch::Body(status, body.to_vec()),
                Err(_) => Fetch::NoResponse { unreachable: false },
            }
        }
        Err(error) => Fetch::NoResponse { unreachable: error.is_connect() },
    }
}

/// Uma leitura: (cota, recusou conexão). Sem resposta = `sem-resposta`; status de erro =
/// `http-<código>` (o 429 é o que faz o cache esperar).
pub async fn read(client: &reqwest::Client, reader: &Reader, endpoints: &Endpoints, now: f64) -> (Value, bool) {
    let url = reader.url(endpoints);
    let headers: Vec<(&str, String)> = match reader {
        Reader::Kimi { key, .. } => vec![("authorization", format!("Bearer {key}")), ("accept", "application/json".into())],
        Reader::CommandCode { key } => vec![
            ("authorization", format!("Bearer {key}")),
            ("accept", "application/json".into()),
            ("user-agent", COMMANDCODE_UA.into()),
        ],
        Reader::OpenCode { cookie, .. } => vec![
            ("user-agent", OPENCODE_UA.into()),
            ("accept", "text/html".into()),
            ("cookie", format!("auth={cookie}")),
        ],
    };
    let unavailable = |reason: &str| reading("indisponivel", vec![], Some(reason));
    let (status, body) = match get(client, &url, &headers).await {
        Fetch::Body(status, body) => (status, body),
        Fetch::Status(status) => return (unavailable(&format!("http-{status}")), false),
        Fetch::NoResponse { unreachable } => return (unavailable("sem-resposta"), unreachable),
        Fetch::BadHeader => return (unavailable("credencial-invalida"), false),
        Fetch::BadUrl => {
            tracing::error!(code = "quota_reader_failed", kind = reader.kind(), "leitor de cota quebrado: endereço sem esquema");
            return (unavailable("erro-leitor"), false);
        }
    };
    let windows = match reader {
        Reader::OpenCode { .. } => {
            if body.is_empty() {
                return (unavailable(&format!("http-{status}")), false);
            }
            let windows = opencode(&String::from_utf8_lossy(&body), now);
            if windows.is_empty() {
                // Página de login com 200 ou painel mudou: "não informa cota", nunca zero.
                return (unavailable("painel-sem-numeros"), false);
            }
            windows
        }
        _ => {
            let Some(value) = parse_json(&body) else { return (unavailable("sem-resposta"), false) };
            if !value.is_object() {
                return (unavailable(&format!("http-{status}")), false);
            }
            let windows = match reader {
                Reader::CommandCode { .. } => commandcode(&value),
                _ => match kimi(&value) {
                    Ok(windows) => windows,
                    Err(()) => {
                        tracing::error!(code = "quota_reader_failed", kind = "kimi", "leitor de cota quebrado: duração sem valor finito");
                        return (unavailable("erro-leitor"), false);
                    }
                },
            };
            if windows.is_empty() {
                return (unavailable("formato-desconhecido"), false);
            }
            windows
        }
    };
    (reading("lida", windows, None), false)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Entrada externa qualquer não derruba os leitores: bytes soltos, JSON mutado e HTML mutado.
    #[test]
    fn readers_never_panic_on_hostile_input() {
        let mut seed: u64 = 0x9e37_79b9_7f4a_7c15;
        let mut next = move || {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            seed
        };
        let samples = [
            r#"{"limits":[{"window":{"duration":300},"detail":{"limit":"100","remaining":"75","resetTime":"2026-08-18T17:59:46.782017Z"}}],"usage":{"limit":"1e2","remaining":"NaN"}}"#,
            r#"{"windowLimits":{"fiveHour":{"used":1,"cap":"14","resetAt":1787564008022},"weekly":{"used":"inf","cap":35}}}"#,
            "rollingUsage:$R[3]={usagePercent:12.5,resetInSec:3600};weeklyUsage:$R[4]={resetInSec:9,usagePercent:-1}",
        ];
        let alphabet = br#"{}[]":,.-+0123456789eEnaNIfity_ $R=resetTimeZT:limitusage"#;
        for _ in 0..20_000 {
            let base = samples[(next() % 3) as usize].as_bytes().to_vec();
            let mut bytes = base;
            for _ in 0..(next() % 8) {
                let at = (next() as usize) % (bytes.len() + 1);
                match next() % 3 {
                    0 if at < bytes.len() => {
                        bytes.remove(at);
                    }
                    1 => bytes.insert(at, alphabet[(next() as usize) % alphabet.len()]),
                    _ => bytes.insert(at, (next() % 256) as u8),
                }
            }
            if let Some(value) = parse_json(&bytes) {
                let _ = kimi(&value);
                let _ = commandcode(&value);
                for item in value["limits"].as_array().into_iter().flatten() {
                    let _ = py_iso(&item["detail"]["resetTime"]);
                }
            }
            let text = String::from_utf8_lossy(&bytes);
            let _ = opencode(&text, 0.0);
            let _ = py_float(&text);
            let _ = py_iso(&json!(text));
        }
    }

    #[test]
    fn python_float_rules() {
        assert_eq!(py_float(" 1e2 "), Some(100.0));
        assert_eq!(py_float("1_000"), Some(1000.0));
        assert_eq!(py_float("1__0"), None);
        assert_eq!(py_float("_1"), None);
        assert!(py_float("NaN").unwrap().is_nan());
        assert_eq!(py_float("-Infinity"), Some(f64::NEG_INFINITY));
        assert_eq!(py_float("0x10"), None);
        assert_eq!(py_float(""), None);
    }
}
