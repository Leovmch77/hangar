//! Modos Claude, no ator que já serializa suas escritas; o relançamento só começa sem IngressPass.
use std::{net::SocketAddr,sync::Arc};
use axum::{extract::{ConnectInfo,Request,State},body::to_bytes,http::StatusCode,response::Response};
use serde::Deserialize;
use serde_json::{Value,json};
use crate::{routes::{AppState,gate,pass,cors},runtime::{gateway::EntryHandle,protocol::{OperationKind,RuntimeCommand,Disposition}}};
use super::{BODY_LIMIT,enter_then_find,json_response,detail_body,session_name};
const MODES:[&str;6]=["plan","auto","manual","acceptEdits","bypassPermissions","dontAsk"];
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ModeBody {mode:Option<String>,permission_mode:Option<String>}
fn mode_body(bytes:&[u8])->Result<String,(&'static str,StatusCode)> {
    let body:ModeBody=serde_json::from_slice(bytes).map_err(|_|("erro_permissao_invalida",StatusCode::UNPROCESSABLE_ENTITY))?;
    let mode=body.mode.or(body.permission_mode).filter(|s|!s.is_empty()).ok_or(("erro_permissao_invalida",StatusCode::UNPROCESSABLE_ENTITY))?;
    if !MODES.contains(&mode.as_str()) {return Err(("erro_permissao_invalida",StatusCode::CONFLICT));}
    Ok(mode)
}
fn result(reply:crate::runtime::protocol::RuntimeReply)->(StatusCode,Value) {
    if reply.disposition==Disposition::Accepted {return (StatusCode::OK,reply.payload);}
    let code=reply.payload["error_code"].as_str().or_else(||reply.payload["code"].as_str()).unwrap_or("erro_permissao_leitura");
    (StatusCode::CONFLICT,detail_body(code,"não consegui confirmar o modo de permissão; confira a sessão",reply.payload.clone()))
}
async fn serve(st:Arc<AppState>,peer:SocketAddr,req:Request,set:bool)->Response {
    let (forward,owner)=gate(&st,peer,&req);
    let Some(runtime)=st.state.runtime.get().cloned().filter(|_|owner) else {return pass(&st,req,&forward).await;};
    let Some(name)=session_name(req.uri().path()) else {return pass(&st,req,&forward).await;};
    let target=match enter_then_find(&runtime,&name,st.write_gate_wait).await {
        Ok(Some((held,target))) if target.provider=="claude"=>(held,target),
        Ok(_)=>return pass(&st,req,&forward).await,
        Err(_)=>return json_response(StatusCode::CONFLICT,super::busy_body()),
    };
    let (held,target)=target;
    let headers=req.headers().clone();
    let id=headers.get("x-hangar-operation-id").and_then(|v|v.to_str().ok()).filter(|id|!id.is_empty() && id.len()<=200 && id.bytes().all(|b|b.is_ascii_alphanumeric() || b"._:-".contains(&b))).map(str::to_owned).unwrap_or_else(||crate::mods::state::random_hex(16));
    let query=req.uri().query().unwrap_or("");
    let probe=form_urlencoded::parse(query.as_bytes()).find(|(key,_)|key=="sondar").is_some_and(|(_,value)|matches!(value.to_ascii_lowercase().as_str(),"1"|"true"|"on"|"yes"));
    let mode=if set {
        match to_bytes(req.into_body(),BODY_LIMIT).await {
            Ok(bytes)=>match mode_body(&bytes) {Ok(mode)=>Some(mode),Err((code,status))=>return json_response(status,detail_body(code,"modo de permissão inválido",json!({})))},
            Err(_)=>return super::too_large(&headers),
        }
    } else {None};
    // A tarefa carrega o passe só pelo comando; o freeze nunca espera o próprio pedido.
    let job=tokio::spawn(async move {
        let reply=match &target.handle {
            EntryHandle::Terminal {handle,..}=>handle.control(id.clone(),if set {"set_permission_mode"} else {"permission_modes"}.into(),if let Some(mode)=&mode {json!({"mode":mode})} else {json!({"probe":probe})}).await?,
            EntryHandle::Headless(handle) if set=> {
                let mut reply=handle.command(RuntimeCommand {operation_id:id.clone(),kind:OperationKind::SetPermissionMode,payload:json!({"mode":mode})}).await?;
                if reply.disposition==Disposition::Accepted && reply.payload["reopened"]!=true {
                    let view=handle.view().await?;
                    reply.payload=json!({"mode":view["permission_mode"],"current":view["permission_mode"],"previous_non_plan":view["previous_non_plan"]});
                }
                reply
            },
            EntryHandle::Headless(handle)=> {
                let view=handle.view().await?;
                return Ok((StatusCode::OK,json!({"current":view["permission_mode"],"modes":MODES,"sondavel":false,"previous_non_plan":view["previous_non_plan"]})));
            },
            _=>return Err(crate::runtime::protocol::RuntimeError::new("lifecycle_provider","sessão não é Claude")),
        };
        drop(held);
        let terminal_reopen=target.terminal && reply.payload["requires_reopen"]==true && reply.payload["cycle_closed"]==true;
        let headless_reopen=!target.terminal && reply.disposition==Disposition::Rejected && reply.payload["permission_boot_rejected"]==true;
        if set && mode.as_deref()==Some("bypassPermissions") && (terminal_reopen || headless_reopen) && reply.payload["uncertain"]!=true {
            return runtime.reopen_claude(name,target.key,target.generation,id).await.map(|value|(StatusCode::OK,value));
        }
        Ok(result(reply))
    });
    let (status,body)=match job.await {
        Ok(Ok(value))=>value,
        Ok(Err(error))=>(StatusCode::CONFLICT,detail_body(&error.code,&error.message,json!({}))),
        Err(_)=>(StatusCode::SERVICE_UNAVAILABLE,detail_body("lifecycle_panic","não consegui confirmar o modo de permissão",json!({}))),
    };
    let mut response=json_response(status,body);cors(&headers,response.headers_mut());response
}
pub async fn modes(State(st):State<Arc<AppState>>,ConnectInfo(peer):ConnectInfo<SocketAddr>,req:Request)->Response {serve(st,peer,req,false).await}
pub async fn set_mode(State(st):State<Arc<AppState>>,ConnectInfo(peer):ConnectInfo<SocketAddr>,req:Request)->Response {serve(st,peer,req,true).await}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn legacy_alias_and_rejection_status_are_preserved() {
        assert_eq!(mode_body(br#"{"permission_mode":"bypassPermissions"}"#).unwrap(),"bypassPermissions");
        assert_eq!(mode_body(br#"{"mode":"plan","permission_mode":"manual"}"#).unwrap(),"plan");
        assert_eq!(mode_body(b"{}").unwrap_err().1,StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(mode_body(br#"{"mode":"wrong"}"#).unwrap_err().1,StatusCode::CONFLICT);
    }
    #[test]
    fn uncertain_control_cannot_report_requested_bypass() {
        let reply=crate::runtime::protocol::RuntimeReply {operation_id:"id".into(),disposition:Disposition::Unknown,payload:json!({"current":null,"requested":"bypassPermissions","uncertain":true,"error_code":"permission_key_timeout"})};
        let (status,body)=result(reply);
        assert_eq!(status,StatusCode::CONFLICT);
        assert_eq!(body["detail"]["params"]["current"],Value::Null);
        assert_eq!(body["detail"]["code"],"permission_key_timeout");
    }
}
