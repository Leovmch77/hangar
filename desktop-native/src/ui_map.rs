//! Só para provas: com HANGAR_NATIVE_UI_MAP=<arquivo>, grava a cada quadro que mudar a lista de
//! elementos com id (caminho, bounds lógicos da janela, visível). Sem a variável nada é instalado.
//! O mapa não leva texto da tela: só ids, que já são rótulos da interface.

use gpui_kit::{ElementId, ElementRecord, Window};
use serde_json::{json, Value};
use std::path::PathBuf;

pub fn install(window: &mut Window) {
    let Some(path) = std::env::var_os("HANGAR_NATIVE_UI_MAP").map(PathBuf::from) else { return };
    let tmp = { let mut name = path.clone().into_os_string(); name.push(".tmp"); PathBuf::from(name) };
    let (mut last, mut seq) = (Value::Null, 0u64);
    window.set_element_map_sink(move |records| {
        let elements = snapshot(records);
        if elements == last { return; }
        seq += 1;
        let text = json!({ "seq": seq, "elements": &elements }).to_string();
        // Quem lê nunca vê o arquivo pela metade: grava ao lado e troca pelo rename.
        // ponytail: grava no próprio quadro, bloqueando; só vale para prova, nunca ligado no uso.
        match std::fs::write(&tmp, text).and_then(|_| std::fs::rename(&tmp, &path)) {
            Ok(()) => last = elements,
            Err(error) => eprintln!("mapa de elementos não gravado em {}: {error}", path.display()),
        }
    });
}

fn snapshot(records: &[ElementRecord]) -> Value {
    // Ids de view mudam a cada execução e não identificam controle: ficam fora do caminho.
    let named = |id: &ElementId| (!matches!(id, ElementId::View(_))).then(|| id.to_string());
    Value::Array(records.iter().filter_map(|record| {
        let id = named(record.path.last()?)?;
        let b = record.bounds;
        Some(json!({
            "id": id,
            "path": record.path.iter().filter_map(named).collect::<Vec<_>>(),
            "x": f32::from(b.origin.x), "y": f32::from(b.origin.y),
            "w": f32::from(b.size.width), "h": f32::from(b.size.height),
            "visible": record.visible,
        }))
    }).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui_kit::{bounds, point, px, size, EntityId};

    #[test]
    fn snapshot_keeps_ids_bounds_and_visibility_without_view_ids() {
        let view = ElementId::View(EntityId::from(7u64));
        let record = |path: Vec<ElementId>, visible| ElementRecord {
            path: path.into(), bounds: bounds(point(px(10.), px(20.)), size(px(30.), px(40.))), visible,
        };
        let map = snapshot(&[
            record(vec![view.clone()], true),
            record(vec![view.clone(), "settings".into(), "font-1".into()], false),
        ]);
        assert_eq!(map, json!([{ "id": "font-1", "path": ["settings", "font-1"],
            "x": 10.0, "y": 20.0, "w": 30.0, "h": 40.0, "visible": false }]));
    }
}
