//! `GET /api/credenciais`: contas Claude, chaves do `engines.json`, contas Codex e as linhas que só
//! a cota conhece, numa lista só. Tudo em processo: nenhuma pergunta ao Python.
use super::{
    AccountKey, Provider,
    http::{Json, bridge},
    quotas::other,
};
use axum::{
    extract::Request,
    response::{IntoResponse, Response},
};
use serde_json::{Map, Value, json};
use std::{sync::Arc, time::Duration};

const CODEX_AUTH_DEADLINE: Duration = Duration::from_secs(3);
/// O cliente desiste em 8 s: cota de rede que passa disto sai do cache, e a leitura segue.
const QUOTA_DEADLINE: Duration = Duration::from_secs(6);

fn unavailable_auth() -> Value {
    json!({"method":"unknown","status":"unavailable","email":null,"plan":null})
}

/// `sk-kimi••••4f2a`: nunca a chave inteira. Conta caracteres, não bytes.
fn mask(key: &str) -> String {
    let chars: Vec<char> = key.chars().collect();
    if chars.len() <= 10 {
        return "•".repeat(chars.len());
    }
    let head: String = chars[..7].iter().collect();
    let tail: String = chars[chars.len() - 4..].iter().collect();
    format!("{head}••••{tail}")
}

fn float(value: &Value) -> Value {
    value.as_f64().map_or(Value::Null, |n| json!(n))
}

/// A linha leva 7 campos da cota, com os números como o pydantic os validava (`13` vira `13.0`).
fn summary(row: &Value) -> Value {
    let windows: Vec<Value> = row["janelas"].as_array().into_iter().flatten().map(|w| json!({
        "rotulo": w["rotulo"], "pct": float(&w["pct"]), "reset_ts": float(&w["reset_ts"]),
        "por_modelo": w["por_modelo"].as_bool().unwrap_or(false),
    })).collect();
    let credits = match &row["reset_credits"] {
        Value::Object(credits) => json!({
            "available_count": credits.get("available_count").cloned().unwrap_or(Value::Null),
            "credits": credits.get("credits").and_then(Value::as_array).map(|items| items.iter().map(|c| json!({
                "id": c["id"], "expires_at": c["expires_at"], "title": c["title"],
                "description": c["description"],
                "status": c.get("status").filter(|s| !s.is_null()).cloned().unwrap_or(json!("unknown")),
            })).collect::<Vec<_>>()),
        }),
        _ => Value::Null,
    };
    json!({"estado": row["estado"], "janelas": windows, "ts": float(&row["ts"]),
        "idade_s": float(&row["idade_s"]), "motivo": row["motivo"], "label": row["label"],
        "reset_credits": credits})
}

fn line(id: &str, kind: &str, auth: &str, natural: &Value, aliases: &Map<String, Value>, quota: &Map<String, Value>) -> Value {
    let alias = aliases.get(id).cloned().unwrap_or(Value::Null);
    let name = if alias.is_null() { natural.clone() } else { alias.clone() };
    json!({"id": id, "tipo": kind, "auth_method": auth, "codex_account": null, "codex_sync": null,
        "nome": name, "nome_natural": natural, "apelido": alias, "ativa": false, "path": null,
        "login": null, "base_url": null, "chave_mascarada": null, "usos": [],
        "cota": quota.get(id).map_or(Value::Null, summary), "aceita_cookie": false,
        "cookie_definido": false, "gerenciada": true})
}

/// O `config.toml` do Kimi tem o bloco que o app gravou para esse provedor?
fn managed_block(text: Option<&str>, name: &str) -> bool {
    let Some(text) = text else { return false };
    let start = format!("# >>> hangar: provedor {name} (app/agentes_sync) — gerado, não editar à mão");
    let end = format!("# <<< hangar: fim do provedor {name}");
    text.find(&start).is_some_and(|i| text[i..].contains(&end))
}

/// Login da linha Codex. Indisponível diz a causa: `cli-ausente`, `prazo` (3 s) ou `leitura-falhou`;
/// preparo em curso não é falha e fica sem motivo. Status fora do conhecido não vira "desconectado".
fn codex_login(auth: &Value, preparing: bool) -> Value {
    let (state, logged, reason) = match auth["status"].as_str() {
        Some("connected") => ("ok", json!(true), Value::Null),
        Some("disconnected" | "none") => ("ok", json!(false), Value::Null),
        Some("unavailable") => {
            let reason = match auth["reason"].as_str() {
                Some("cli_missing") => json!("cli-ausente"),
                Some("deadline") => json!("prazo"),
                _ if preparing => Value::Null,
                _ => json!("leitura-falhou"),
            };
            ("indisponivel", Value::Null, reason)
        }
        _ => ("indisponivel", Value::Null, json!("formato-desconhecido")),
    };
    json!({"estado": state, "loggedIn": logged, "email": auth["email"], "plano": auth["plan"],
        "motivo": reason, "refreshExpiresAt": null})
}

async fn codex_snapshot(state: &crate::routes::AppState, account: &super::catalog::Account, force: bool, bridge: Option<&super::bridge::AccountsBridge>) -> (Value, Value) {
    let service = &state.accounts;
    // Sem a ponte o preparo é desconhecido: `null`, nunca um `idle` inventado.
    let sync = match bridge {
        Some(bridge) => service.preparation_status(account, bridge).await,
        None => json!({"status": null}),
    };
    if sync["status"] == "running" {
        return (unavailable_auth(), sync);
    }
    let read = async {
        if force {
            if let Ok(key) = AccountKey::new(Provider::Codex, &account.home) {
                service.codex_auth.invalidate(&key);
            }
            service.read_codex_auth(account).await
        } else {
            service.read_codex_auth_fast(account).await
        }
    };
    // A leitura segue em segundo plano e guarda o resultado; a lista não espera por ela.
    let auth = match tokio::time::timeout(CODEX_AUTH_DEADLINE, read).await {
        Ok(auth) => auth,
        Err(_) => {
            tracing::warn!(code = "codex_auth_deadline", account = %account.id, "leitura de autenticação Codex excedeu o prazo");
            let mut auth = unavailable_auth();
            auth["reason"] = json!("deadline");
            auth
        }
    };
    (auth, sync)
}

pub async fn public(state: Arc<crate::routes::AppState>, request: Request) -> Response {
    let query: std::collections::HashMap<String, String> =
        form_urlencoded::parse(request.uri().query().unwrap_or("").as_bytes()).into_owned().collect();
    let force = match crate::query::bool_param(&query, "forcar") {
        Ok(force) => force,
        Err(response) => return *response,
    };
    // Parte com problema sai sozinha (linha indisponível, cota nula, motor fora) e vai ao diário;
    // a lista das outras credenciais nunca cai junto.
    let report = |code: &str, reason: &'static str| state.diag.report("rust.credentials_partial", "credenciais", code, reason);
    let service = state.accounts.clone();
    let codex = service.visible_codex_accounts().unwrap_or_else(|err| {
        report(err.code, "contas Codex ilegíveis; a lista segue sem elas");
        vec![]
    });
    let bridge = bridge(&state).map_err(|err| report(err.code, "ponte de contas ausente; sem preparo Codex nesta lista")).ok();
    // Arquivos das fontes lidos uma vez, fora do runtime; a cota usa a mesma leitura e leva os
    // problemas deles ao diário.
    let env = service.env.clone();
    let config = match tokio::task::spawn_blocking(move || other::load(&env)).await {
        Ok(config) => Arc::new(config),
        Err(error) => {
            tracing::error!(code = "credentials_config_failed", panic = error.is_panic(), "leitura das configs das fontes falhou");
            report("credentials_config_failed", "leitura das configs das fontes falhou; a lista segue sem chaves");
            Arc::new(other::Config::default())
        }
    };
    let snapshots = futures_util::future::join_all(codex.iter().map(|account| codex_snapshot(&state, account, force, bridge.as_ref())));
    let quotas = async {
        let (result, late) = service.quotas_within(bridge.clone(), force, QUOTA_DEADLINE, config.clone()).await;
        if late {
            report("quota_deadline", "cotas passaram do prazo; a lista sai com o cache e a leitura segue");
        }
        result.map_err(|err| report(err.code, "cotas indisponíveis; as linhas saem sem cota")).ok()
    };
    let claude = service.claude_states();
    let (snapshots, quotas, claude) = tokio::join!(snapshots, quotas, claude);
    let aliases = &config.aliases;
    let quotas = quotas.unwrap_or_else(|| json!([]));
    // Id repetido na cota: vale o último valor, na posição do primeiro.
    let mut quota = Map::new();
    for row in quotas.as_array().into_iter().flatten() {
        if let Some(id) = row["id"].as_str() {
            quota.insert(id.to_owned(), row.clone());
        }
    }
    let claude = claude.unwrap_or_else(|err| {
        report(err.code, "contas Claude ilegíveis; a lista segue sem elas");
        json!([])
    });
    let mut out = vec![];
    for row in claude.as_array().into_iter().flatten() {
        let path = row["path"].as_str().unwrap_or_default();
        let id = format!("claude:{path}");
        let mut item = line(&id, "claude", "oauth", &row["label"], aliases, &quota);
        item["ativa"] = json!(row["active"] == true);
        item["path"] = json!(path);
        let login = &row["login"];
        item["login"] = json!({"estado": login["estado"], "loggedIn": login["loggedIn"], "email": login["email"],
            "plano": login["plano"], "motivo": login["motivo"], "refreshExpiresAt": float(&login["refreshExpiresAt"])});
        out.push(item);
    }
    // Motor torto sai da lista; o código dele já foi ao diário pela cota (`config.problems`).
    let cookies = &config.opencode;
    for (name, data) in config.engines.iter().filter(|(name, _)| other::engine_name_ok(name)) {
        let Some(data) = data.as_object() else { continue };
        let id = format!("chave:{name}");
        let natural = match data.get("label") {
            Some(label @ Value::String(_)) if !other::falsy(label) => label.clone(),
            Some(label) if !other::falsy(label) => continue,
            _ => json!(name),
        };
        let base = match data.get("base_url") {
            None | Some(Value::Null) => Value::Null,
            Some(base @ Value::String(_)) => base.clone(),
            Some(_) => continue,
        };
        let accepts = base.as_str().is_some_and(|b| b.contains("opencode.ai"));
        let mut item = line(&id, "chave", "api_key", &natural, aliases, &quota);
        item["base_url"] = base;
        item["chave_mascarada"] = data.get("api_key").and_then(Value::as_str).filter(|k| !k.is_empty()).map_or(Value::Null, |k| json!(mask(k)));
        item["usos"] = json!(["claude_code"]);
        item["aceita_cookie"] = json!(accepts);
        item["cookie_definido"] = json!(accepts && cookies.contains_key(&id));
        out.push(item);
    }
    for (account, (auth, sync)) in codex.iter().zip(snapshots) {
        let id = format!("codex:{}", super::catalog::resolved(&account.home).to_string_lossy());
        let mut method = auth["method"].as_str().unwrap_or("unknown");
        if !matches!(method, "oauth" | "api_key" | "none" | "unknown") {
            report("codex_auth_method_unknown", "método de autenticação Codex desconhecido; sai unknown");
            method = "unknown";
        }
        let sync_running = sync["status"] == "running";
        let mut sync = if account.is_default { Value::Null } else { sync["status"].clone() };
        if !(sync.is_null() || matches!(sync.as_str(), Some("idle" | "running" | "ready" | "partial" | "error"))) {
            report("codex_sync_unknown", "estado de preparo Codex desconhecido; sai null");
            sync = Value::Null;
        }
        let mut item = line(&id, "codex", method, &json!(account.id), aliases, &quota);
        item["codex_account"] = json!(account.id);
        item["codex_sync"] = sync;
        item["ativa"] = json!(account.is_default);
        item["path"] = json!(account.home.to_string_lossy());
        item["usos"] = json!(["codex_cli"]);
        item["login"] = codex_login(&auth, sync_running);
        // Com o preparo em curso não há leitura (o snapshot nem pergunta): nada a esconder ali.
        match item["login"]["motivo"].as_str() {
            Some("formato-desconhecido") => report("codex_auth_status_unknown", "status de autenticação Codex desconhecido; sai indisponível"),
            Some("leitura-falhou") => report("codex_auth_read_failed", "leitura de autenticação Codex falhou; sai indisponível"),
            Some("prazo") => report("codex_auth_deadline", "leitura de autenticação Codex passou do prazo; segue em segundo plano"),
            _ => {}
        }
        out.push(item);
    }
    // Cota sem cadastro continua visível, mas não comprova autenticação do Codex.
    let kimi = config.kimi_text.as_deref();
    for (id, row) in &quota {
        let codex = id.starts_with("codex:");
        if !(codex || id.starts_with("kimi:")) || out.iter().any(|item| item["id"] == id.as_str()) {
            continue;
        }
        let suffix = id.split_once(':').map_or("", |(_, tail)| tail);
        let natural = if other::falsy(&row["label"]) { json!(suffix) } else { row["label"].clone() };
        let (kind, auth, usage) = if codex { ("codex", "unknown", "codex_cli") } else { ("chave", "api_key", "kimi_cli") };
        let mut item = line(id, kind, auth, &natural, aliases, &quota);
        item["usos"] = json!([usage]);
        item["gerenciada"] = json!(codex || managed_block(kimi, suffix));
        out.push(item);
    }
    Json(json!(out)).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mask_counts_characters_and_never_returns_the_key() {
        assert_eq!(mask("1234567890"), "••••••••••");
        assert_eq!(mask("12345678901"), "1234567••••8901");
        assert_eq!(mask("çççççççççççç"), "ççççççç••••çççç");
    }

    #[test]
    fn managed_block_needs_both_marks_in_order() {
        let start = "# >>> hangar: provedor x (app/agentes_sync) — gerado, não editar à mão";
        let end = "# <<< hangar: fim do provedor x";
        assert!(managed_block(Some(&format!("{start}\n{end}")), "x"));
        assert!(!managed_block(Some(&format!("{end}\n{start}")), "x"));
        assert!(!managed_block(None, "x"));
        assert!(managed_block(Some(&format!("{start}\n{end}yz")), "x"));
    }

    #[test]
    fn codex_login_names_the_cause_and_never_guesses_disconnected() {
        let reason = |auth: Value, preparing| codex_login(&auth, preparing)["motivo"].clone();
        let mut deadline = unavailable_auth();
        deadline["reason"] = json!("deadline");
        assert_eq!(reason(deadline, false), json!("prazo"));
        assert_eq!(reason(unavailable_auth(), false), json!("leitura-falhou"));
        assert_eq!(reason(unavailable_auth(), true), Value::Null);
        assert_eq!(reason(json!({"status":"unavailable","reason":"cli_missing"}), false), json!("cli-ausente"));
        let odd = codex_login(&json!({"status":"expired"}), false);
        assert_eq!((&odd["estado"], &odd["loggedIn"]), (&json!("indisponivel"), &Value::Null));
        let off = codex_login(&json!({"status":"disconnected"}), false);
        assert_eq!((&off["estado"], &off["loggedIn"], &off["motivo"]), (&json!("ok"), &json!(false), &Value::Null));
    }
}
