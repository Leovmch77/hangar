use super::{guards, model::*, prompts};
use serde_json::{Value, json};

pub async fn organize(
    state: &crate::routes::AppState,
    request: OrganizationRequest,
    config: &OrganizationConfig,
) -> OrganizationResult {
    organize_started(state, request, config, tokio::time::Instant::now()).await
}

pub async fn organize_started(
    state: &crate::routes::AppState,
    request: OrganizationRequest,
    config: &OrganizationConfig,
    started: tokio::time::Instant,
) -> OrganizationResult {
    let saved = match config.ditado_estilo.as_str() {
        "limpar" => DictationStyle::Clean,
        "briefing" => DictationStyle::Briefing,
        _ => DictationStyle::Prose,
    };
    let deadline = started
        + request
            .style
            .unwrap_or(saved)
            .effective(request.raw.trim())
            .timeout();
    organize_before_deadline(state, request, config, deadline).await
}

async fn organize_before_deadline(
    state: &crate::routes::AppState,
    request: OrganizationRequest,
    config: &OrganizationConfig,
    deadline: tokio::time::Instant,
) -> OrganizationResult {
    let mode = request
        .mode
        .unwrap_or_else(|| OrganizationMode::saved(&config.dictation_organization_mode));
    let mut original = OrganizationResult::original(request.raw.clone(), mode);
    if mode == OrganizationMode::None {
        return original;
    }
    let raw = original.raw.trim();
    if raw.is_empty() || raw.starts_with('/') || raw.split_whitespace().count() < 5 {
        return original;
    }
    let saved = match config.ditado_estilo.as_str() {
        "limpar" => DictationStyle::Clean,
        "briefing" => DictationStyle::Briefing,
        _ => DictationStyle::Prose,
    };
    let style = request.style.unwrap_or(saved).effective(raw);
    if request
        .include_recent_messages
        .unwrap_or(config.dictation_include_recent_messages)
        && request.session.is_some()
    {
        if !request.harness_allowed {
            return original.failed(
                "dictation_context_unavailable",
                "O contexto da conversa não está autorizado; a transcrição foi preservada.",
            );
        }
        match tokio::time::timeout_at(deadline, super::references::read(state,&request)).await {
            Ok(Ok(references))=>original.recent_messages=Some(references),
            Ok(Err(code))=>return original.failed(code,"Não foi possível ler a referência de grafia da conversa; a transcrição foi preservada."),
            Err(_)=>return original.failed("dictation_organization_timeout", super::harness::detail("dictation_organization_timeout")),
        }
    }
    let raw = original.raw.trim();
    if mode == OrganizationMode::Harness {
        if !request.harness_allowed {
            return original.failed("dictation_harness_unauthorized","A organização pela conta do harness é exclusiva do dono; foi mantida a transcrição original.");
        }
        return super::harness::organize(state, &request, config, style, original, deadline).await;
    }
    let briefing =
        style == DictationStyle::Briefing && !config.llm_briefing_base_url.trim().is_empty();
    let (url, key, model) = if briefing {
        (
            &config.llm_briefing_base_url,
            &config.llm_briefing_api_key,
            &config.llm_briefing_model,
        )
    } else {
        (&config.llm_base_url, &config.llm_api_key, &config.llm_model)
    };
    if key.trim().is_empty() {
        return original.failed("dictation_api_key_missing", "Configure a chave da API de organização em Configurações → Voz; foi mantida a transcrição original.");
    }
    let endpoint = if url.trim().is_empty() {
        "https://api.groq.com/openai/v1"
    } else {
        url.trim()
    };
    let model = if model.trim().is_empty() {
        "openai/gpt-oss-120b"
    } else {
        model.trim()
    };
    let mut body = json!({"model":model,"messages":[{"role":"system","content":prompts::with_references(style,original.recent_messages.as_deref())},{"role":"user","content":raw}],"temperature":0});
    if !config.llm_reasoning_effort.is_empty() {
        body["reasoning_effort"] = json!(config.llm_reasoning_effort);
    }
    if openrouter_by_throughput(endpoint, model) {
        body["provider"] = json!({"sort": "throughput"});
    }
    let client = match reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
    {
        Ok(client) => client,
        Err(_) => {
            return original.failed(
                "dictation_organization_failed",
                "Não foi possível iniciar a organização; foi mantida a transcrição original.",
            );
        }
    };
    let Ok(_slot) = state.dictation_slots.clone().try_acquire_owned() else {
        return original.failed("dictation_busy", super::harness::detail("dictation_busy"));
    };
    // Só a causa e o status vão ao diário: nunca a chave nem a transcrição.
    let failed = |original: OrganizationResult, code: &str, status: Option<u16>| {
        tracing::warn!(code, status, "API externa de organização do ditado falhou");
        let detail = match code {
            "dictation_api_auth_rejected" => {
                "A API de organização recusou a chave configurada; foi mantida a transcrição original."
            }
            "dictation_api_rate_limited" => {
                "A API de organização atingiu o limite de uso; foi mantida a transcrição original."
            }
            "dictation_api_unavailable" => {
                "A API de organização respondeu com erro; foi mantida a transcrição original."
            }
            "dictation_api_unreachable" => {
                "Não foi possível conectar à API de organização; foi mantida a transcrição original."
            }
            _ => {
                "A API de organização não devolveu texto válido; foi mantida a transcrição original."
            }
        };
        original.failed(code, detail)
    };
    let response = client
        .post(format!(
            "{}/chat/completions",
            endpoint.trim_end_matches('/')
        ))
        .bearer_auth(key)
        .header("content-type", "application/json")
        .header("user-agent", "hangar/1.0")
        .body(body.to_string())
        .timeout(deadline.saturating_duration_since(tokio::time::Instant::now()))
        .send()
        .await;
    let response = match response {
        Ok(response) => response,
        Err(error) if error.is_timeout() => {
            return original.failed(
                "dictation_organization_timeout",
                "A organização excedeu o prazo; foi mantida a transcrição original.",
            );
        }
        Err(_) => return failed(original, "dictation_api_unreachable", None),
    };
    let status = response.status().as_u16();
    match status {
        200..=299 => {}
        401 | 403 => return failed(original, "dictation_api_auth_rejected", Some(status)),
        429 => return failed(original, "dictation_api_rate_limited", Some(status)),
        _ => return failed(original, "dictation_api_unavailable", Some(status)),
    }
    let output = match tokio::time::timeout_at(deadline, response.bytes()).await {
        Ok(Ok(bytes)) if bytes.len() <= 1024 * 1024 => serde_json::from_slice::<Value>(&bytes)
            .ok()
            .and_then(|value| {
                value
                    .pointer("/choices/0/message/content")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            }),
        Ok(Err(_)) => return failed(original, "dictation_api_unreachable", Some(status)),
        Ok(Ok(_)) => None,
        Err(_) => {
            return original.failed(
                "dictation_organization_timeout",
                super::harness::detail("dictation_organization_timeout"),
            );
        }
    };
    let Some(output) = output else {
        return failed(original, "dictation_api_invalid_response", Some(status));
    };
    let output = guards::normalized(&output);
    if let Err(detail) = guards::validate(raw, &output, style) {
        return original.failed("dictation_output_rejected", detail);
    }
    let applied = if output == original.raw {
        "cru"
    } else {
        style.id()
    };
    OrganizationResult {
        text: output,
        estilo_aplicado: applied.into(),
        ..original
    }
}

/// Sem ordem, o OpenRouter escolhe o provedor pelo preço e cai em quem leva 10x mais. Sufixo no modelo
/// (`:nitro`, `:floor`) é escolha da pessoa e vence.
fn openrouter_by_throughput(endpoint: &str, model: &str) -> bool {
    reqwest::Url::parse(endpoint).ok().is_some_and(|url| url.host_str() == Some("openrouter.ai")) && !model.contains(':')
}

#[cfg(test)]
mod tests {
    #[test]
    fn openrouter_without_suffix_asks_for_throughput() {
        assert!(super::openrouter_by_throughput("https://openrouter.ai/api/v1", "openai/gpt-oss-120b"));
        assert!(!super::openrouter_by_throughput("https://openrouter.ai/api/v1", "openai/gpt-oss-120b:floor"));
        assert!(!super::openrouter_by_throughput("https://api.groq.com/openai/v1", "openai/gpt-oss-120b"));
    }
}
