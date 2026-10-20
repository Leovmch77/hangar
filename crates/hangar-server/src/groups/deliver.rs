//! Texto do protocolo de grupo, montado em processo por `text.rs`. A entrega em si é
//! `session_write::input::deliver_text`, fora do lock.
use serde_json::{Value, json};

pub use super::text::{ContractLine, Kind, OutsideRef, TextArgs};

/// `Err` = envelope `{code, params, msg}` de aviso que não sai: `group` sem outro membro não tem o
/// exemplo do comando.
pub fn protocol_text(kind: Kind, args: &TextArgs) -> Result<String, Value> {
    if kind == Kind::Group && args.others.is_empty() {
        let code = "groups_pair_text_no_others";
        return Err(json!({"code": "erro_envio_falhou", "params": {"erro": code}, "msg": format!("não deu pra enviar: {code}")}));
    }
    Ok(super::text::render(kind, args))
}
