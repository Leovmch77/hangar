//! Sidecar do Claude sem terminal (`~/.hangar/claude-headless/<nome>.json`) gravado pelo Rust: o
//! `session.patch_meta` e o `session.clear_cano` que o `runtime_policy.py` atendia. O Python continua
//! gravando o mesmo arquivo (abertura, troca de conta, renomear), e os dois seguram a trava
//! `<nome>.lock` (`codex_sidecar::locked`, a do `sessions._locked`) no ler-alterar-gravar.
//! Bloqueante: chamar fora do runtime (`spawn_blocking`).
use super::codex_sidecar::{Meta,load,locked,path,write};
use super::protocol::RuntimeError;
use serde_json::{Value,json};
use std::io;
use std::path::Path;

/// Campos que o `session.patch_meta` do Claude grava (o `_PATCH["claude"]` do Python).
const CATALOG:&[&str] = &["session_id","cwd","model","effort","permission_mode","previous_non_plan","context_window","problema","cano"];

fn io_error(error:io::Error) -> RuntimeError { RuntimeError::new("claude_sidecar_io",&format!("sidecar do Claude inacessível: {:?}",error.kind())) }

fn owner() -> RuntimeError { RuntimeError::new("session_patch_owner","sidecar de outra vida") }

/// O `run("session.patch_meta")` do Python para o Claude. Campo fora do catálogo é erro; valor diferente
/// da vista salva volta `stale` (a conversa da vista é `conversation`); sidecar ausente ou de outra chave
/// é erro. Conversa nova leva junto as escolhas de plugins e skills (`remember`); falha nelas grava o
/// `problema` e volta `customizations_persisted: false`, com o patch já gravado.
pub fn patch(dir:&Path,name:&str,key:&str,payload:&Value,view:&Value) -> Result<Value,RuntimeError> {
    let fields = payload.as_object().ok_or_else(||RuntimeError::new("session_patch_field","patch do sidecar não é objeto"))?;
    if fields.keys().any(|field|!CATALOG.contains(&field.as_str())) {
        return Err(RuntimeError::new("session_patch_field","campo fora do catálogo do sidecar"));
    }
    let stale = fields.iter().any(|(field,value)| {
        let source = if field == "session_id" { "conversation" } else { field.as_str() };
        view.get(source).is_some_and(|saved|saved != value)
    });
    if stale { return Ok(json!({"updated":false,"stale":true})); }
    let updated = locked(dir,name,|file| {
        let Some(mut current) = load(file).filter(|meta|meta.get("key").and_then(Value::as_str) == Some(key)) else { return Ok(None) };
        for (field,value) in fields { current.insert(field.clone(),value.clone()); }
        write(file,&current)?;
        Ok(Some(current))
    }).map_err(io_error)?.ok_or_else(owner)?;
    let Some(session_id) = fields.get("session_id").and_then(Value::as_str).filter(|sid|!sid.is_empty()) else { return Ok(json!({"updated":true})) };
    let settings = updated.get("claude_settings").cloned().unwrap_or(Value::Null);
    let Err((code,detail)) = crate::claude_customizations::remember(session_id,&settings) else { return Ok(json!({"updated":true})) };
    tracing::warn!(session=%name,code,"escolhas da conversa não passaram à conversa nova");
    locked(dir,name,|file| {
        if let Some(mut current) = load(file).filter(|meta|meta.get("key").and_then(Value::as_str) == Some(key)) {
            current.insert("problema".into(),json!([code,detail]));
            write(file,&current)?;
        }
        Ok(())
    }).map_err(io_error)?;
    Ok(json!({"updated":true,"customizations_persisted":false,"warning":detail}))
}

/// O `session.clear_cano` do Python para o Claude: tira o `cano` só se ele ainda é o processo `pid`
/// desta chave; arquivo apagado fica apagado.
pub fn clear_cano(dir:&Path,name:&str,key:&str,payload:&Value) -> Result<Value,RuntimeError> {
    super::codex_sidecar::clear_cano_with(dir,name,key,payload,io_error)
}

/// O sidecar lido como o `sessions.load` do Python, para os testes e quem só confere.
pub fn read(dir:&Path,name:&str) -> Option<Meta> { load(&path(dir,name)) }

#[cfg(test)]
mod tests {
    use super::*;

    fn sidecar(dir:&Path,fields:Value) {
        std::fs::create_dir_all(dir).unwrap();
        let mut meta = json!({"name":"cl","provider":"claude","headless":true,"key":"k1","cwd":"/w","session_id":"s1",
            "model":"opus","effort":"high","context_window":200000,"cano":{"pid":7,"escuta":"unix:/s"}});
        for (field,value) in fields.as_object().unwrap() { meta[field] = value.clone(); }
        std::fs::write(path(dir,"cl"),meta.to_string()).unwrap();
    }

    fn meta(dir:&Path) -> Value { Value::Object(read(dir,"cl").unwrap()) }

    #[test]
    fn field_outside_the_catalog_is_refused_without_touching_the_file() {
        let dir = tempfile::tempdir().unwrap();
        sidecar(dir.path(),json!({}));
        let before = meta(dir.path());
        for bad in [json!({"key":"k2"}),json!({"model":"m","tui_pid":1}),json!(["model"])] {
            assert_eq!(patch(dir.path(),"cl","k1",&bad,&json!({})).unwrap_err().code,"session_patch_field","{bad}");
        }
        assert_eq!(meta(dir.path()),before);
    }

    #[test]
    fn a_field_that_differs_from_the_saved_view_is_stale() {
        let dir = tempfile::tempdir().unwrap();
        sidecar(dir.path(),json!({}));
        let before = meta(dir.path());
        assert_eq!(patch(dir.path(),"cl","k1",&json!({"model":"sonnet"}),&json!({"model":"haiku"})).unwrap(),json!({"updated":false,"stale":true}));
        // A conversa da vista se chama `conversation`.
        assert_eq!(patch(dir.path(),"cl","k1",&json!({"session_id":"s2"}),&json!({"conversation":"s3"})).unwrap()["stale"],true);
        assert_eq!(meta(dir.path()),before);
        // Igual à vista, ou ausente dela, grava.
        assert_eq!(patch(dir.path(),"cl","k1",&json!({"model":"sonnet","effort":"low"}),&json!({"model":"sonnet"})).unwrap(),json!({"updated":true}));
        let after = meta(dir.path());
        assert_eq!((after["model"].as_str(),after["effort"].as_str()),(Some("sonnet"),Some("low")));
        assert_eq!((after["session_id"].as_str(),after["context_window"].as_u64()),(Some("s1"),Some(200000)),"o resto fica");
    }

    #[test]
    fn a_missing_sidecar_or_another_life_is_an_error() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(patch(dir.path(),"cl","k1",&json!({"model":"m"}),&json!({})).unwrap_err().code,"session_patch_owner");
        assert!(!path(dir.path(),"cl").exists(),"ausente fica ausente");
        sidecar(dir.path(),json!({"key":"k2"}));
        assert_eq!(patch(dir.path(),"cl","k1",&json!({"model":"m"}),&json!({})).unwrap_err().code,"session_patch_owner");
        assert_eq!(meta(dir.path())["model"],"opus");
    }

    #[test]
    fn the_cano_of_a_new_process_is_recorded() {
        let dir = tempfile::tempdir().unwrap();
        sidecar(dir.path(),json!({"cano":null}));
        assert_eq!(patch(dir.path(),"cl","k1",&json!({"cano":{"pid":9,"escuta":"unix:/t"}}),&json!({})).unwrap()["updated"],true);
        assert_eq!(meta(dir.path())["cano"]["pid"],9);
    }

    #[test]
    fn customizations_that_do_not_follow_the_new_conversation_leave_a_problem() {
        let dir = tempfile::tempdir().unwrap();
        // Escolhas que o catálogo de customizações recusa: o `remember` falha antes de gravar.
        sidecar(dir.path(),json!({"claude_settings":{"enabledPlugins":"não é objeto"}}));
        let result = patch(dir.path(),"cl","k1",&json!({"session_id":"s2"}),&json!({"conversation":"s2"})).unwrap();
        assert_eq!((result["updated"].as_bool(),result["customizations_persisted"].as_bool()),(Some(true),Some(false)));
        assert!(result["warning"].as_str().is_some_and(|text|!text.is_empty()));
        let after = meta(dir.path());
        assert_eq!(after["session_id"],"s2","a conversa nova fica gravada");
        assert_eq!(after["problema"][0],"claude_customizations_invalid");
        // Sem escolhas não há o que levar.
        sidecar(dir.path(),json!({}));
        assert_eq!(patch(dir.path(),"cl","k1",&json!({"session_id":"s3"}),&json!({})).unwrap(),json!({"updated":true}));
    }

    #[test]
    fn the_patch_waits_for_another_writer_holding_the_lock() {
        let dir = tempfile::tempdir().unwrap();
        sidecar(dir.path(),json!({}));
        let lock = std::fs::OpenOptions::new().read(true).append(true).create(true).open(dir.path().join("cl.lock")).unwrap();
        lock.lock().unwrap();
        let (dir_path,started) = (dir.path().to_owned(),std::time::Instant::now());
        let writer = std::thread::spawn(move||patch(&dir_path,"cl","k1",&json!({"model":"m"}),&json!({})).map(|_|started.elapsed()));
        std::thread::sleep(std::time::Duration::from_millis(300));
        // O outro escritor grava enquanto segura a trava; o patch relê depois e mantém o campo dele.
        let mut other = meta(dir.path());
        other["effort"] = json!("max");
        std::fs::write(path(dir.path(),"cl"),other.to_string()).unwrap();
        drop(lock);
        let waited = writer.join().unwrap().unwrap();
        assert!(waited >= std::time::Duration::from_millis(300),"gravou sem a trava");
        let after = meta(dir.path());
        assert_eq!((after["model"].as_str(),after["effort"].as_str()),(Some("m"),Some("max")));
    }

    #[test]
    fn clear_cano_only_drops_the_same_process() {
        let dir = tempfile::tempdir().unwrap();
        sidecar(dir.path(),json!({}));
        assert_eq!(clear_cano(dir.path(),"cl","k1",&json!({"pid":"7"})).unwrap_err().code,"session_clear_cano_pid");
        assert_eq!(clear_cano(dir.path(),"cl","k1",&json!({"pid":8})).unwrap()["cleared"],false);
        assert_eq!(clear_cano(dir.path(),"cl","k2",&json!({"pid":7})).unwrap()["cleared"],false);
        assert_eq!(clear_cano(dir.path(),"cl","k1",&json!({"pid":7})).unwrap()["cleared"],true);
        let after = meta(dir.path());
        assert!(after["cano"].is_null() && after["model"] == "opus");
    }
}
