//! Exportar e importar os atalhos sem credencial: o backend (`/api/shortcuts/export` e `/import`, `app/shortcut_transfer.py`)
//! troca cada senha por `⟦SEGREDO:<nome>⟧` na saída e, na entrada, preenche os valores que a pessoa digitou. Aqui fica
//! só o arquivo (diálogo de salvar/abrir do sistema) e o formulário dos marcadores, mascarado.
use super::*;
use super::shortcuts::ShortcutsReply;
use super::sidebar::menu_style;

/// Importação conferida pelo backend, esperando a pessoa confirmar.
pub(super) struct ImportDraft {
    data: Value,
    added: u64,
    replaced: u64,
    /// (id do atalho, rótulo, nome do marcador, campo mascarado)
    fields: Vec<(String, String, String, Entity<InputState>)>,
    pub(super) applying: bool,
}

/// Nome da primeira credencial em branco (`⟦SEGREDO:<nome>⟧`) no comando ou texto do atalho.
pub(super) fn missing_secret(text: &str) -> Option<String> {
    let start = text.find("⟦SEGREDO:")? + "⟦SEGREDO:".len();
    let end = text[start..].find('⟧')?;
    let name = &text[start..start + end];
    name.chars().all(|c| c.is_ascii_alphanumeric() || "_.-".contains(c)).then(|| name.to_owned()).filter(|n| !n.is_empty())
}

/// O arquivo gravado: só versão e lista, sem a contagem de removidos (ela é aviso, não dado).
fn export_file(value: &Value) -> (String, u64) {
    let body = json!({"version": value.get("version").cloned().unwrap_or(json!(1)),
        "shortcuts": value.get("shortcuts").cloned().unwrap_or(json!([]))});
    (serde_json::to_string_pretty(&body).unwrap_or_default() + "\n", value.get("removed").and_then(Value::as_u64).unwrap_or(0))
}

impl Hangar {
    fn transfer_note(&mut self, text: String, error: bool, cx: &mut Context<Self>) {
        self.shortcuts.transfer_note = Some((text, error));
        cx.notify();
    }

    /// Escolhe onde salvar primeiro; só então pede a lista (já sem credenciais) ao servidor.
    pub(super) fn export_shortcuts(&mut self, cx: &mut Context<Self>) {
        let Some(api) = self.api.clone() else { return };
        let prompt = cx.prompt_for_new_path(&downloads_folder(), Some("hangar-atalhos.json"));
        let (tx, connection, runtime) = (self.tx.clone(), self.connection, self.runtime.handle().clone());
        cx.spawn(async move |this, cx| {
            let path = match prompt.await {
                Ok(Ok(Some(path))) => path,
                Ok(Ok(None)) => return,
                _ => { let _ = this.update(cx, |this, cx| this.transfer_note(tr("save_dialog_failed"), true, cx)); return; }
            };
            runtime.spawn(async move {
                let result = match api.server_read(&["shortcuts", "export"], &[], 10).await {
                    Err(error) => Err(Hangar::failure(&error)),
                    Ok(value) => {
                        let (text, removed) = export_file(&value);
                        tokio::task::spawn_blocking(move || std::fs::write(&path, text).map(|()| (path, removed))).await
                            .map_err(|e| e.to_string()).and_then(|r| r.map_err(|e| format!("{}: {e}", tr("save_failed"))))
                    }
                };
                let _ = tx.send(Envelope { connection, selection: None, payload: Payload::Shortcuts(ShortcutsReply::Exported(result)) }).await;
            });
        }).detach();
    }

    /// Abre o arquivo e pede ao backend a conferência (contagem e marcadores); nada é gravado ainda.
    pub(super) fn import_shortcuts(&mut self, cx: &mut Context<Self>) {
        let Some(api) = self.api.clone() else { return };
        let prompt = cx.prompt_for_paths(PathPromptOptions { files: true, directories: false, multiple: false, prompt: None });
        let (tx, connection, runtime) = (self.tx.clone(), self.connection, self.runtime.handle().clone());
        cx.spawn(async move |this, cx| {
            let path = match prompt.await {
                Ok(Ok(Some(mut paths))) if !paths.is_empty() => paths.remove(0),
                Ok(Ok(_)) => return,
                _ => { let _ = this.update(cx, |this, cx| this.transfer_note(tr("picker_failed"), true, cx)); return; }
            };
            runtime.spawn(async move {
                let parsed = tokio::task::spawn_blocking(move || std::fs::read_to_string(&path)).await
                    .map_err(|e| e.to_string()).and_then(|r| r.map_err(|e| e.to_string()))
                    .and_then(|text| serde_json::from_str::<Value>(&text).map_err(|e| e.to_string()));
                let reply = match parsed {
                    Err(error) => ShortcutsReply::Previewed(Value::Null, Err(error)),
                    Ok(data) => {
                        let result = api.server_send(reqwest::Method::POST, &["shortcuts", "import"], Some(json!({"data": data.clone()})), 10).await;
                        ShortcutsReply::Previewed(data, result.map_err(|e| Hangar::fetch_failure(&e)))
                    }
                };
                let _ = tx.send(Envelope { connection, selection: None, payload: Payload::Shortcuts(reply) }).await;
            });
        }).detach();
    }

    fn apply_import(&mut self, cx: &mut Context<Self>) {
        // Uma gravação da lista em voo e a importação não se cruzam: a segunda apagaria a primeira.
        if self.shortcuts.busy() { return; }
        let (Some(api), Some(draft)) = (self.api.clone(), self.shortcuts.import.as_mut()) else { return };
        if draft.applying { return; }
        draft.applying = true;
        let mut secrets = serde_json::Map::new();
        for (id, _, name, input) in &draft.fields {
            let value = input.read(cx).value().to_string();
            let entry = secrets.entry(id.clone()).or_insert_with(|| json!({}));
            entry[name.as_str()] = json!(value);
        }
        let body = json!({"data": draft.data.clone(), "apply": true, "secrets": secrets});
        let done = self.shortcuts_send_later();
        self.runtime.spawn(async move {
            let result = api.server_send(reqwest::Method::POST, &["shortcuts", "import"], Some(body), 10).await;
            done(ShortcutsReply::Imported(result.map_err(|e| Hangar::fetch_failure(&e)))).await
        });
        cx.notify();
    }

    pub(super) fn receive_transfer(&mut self, reply: ShortcutsReply, window: &mut Window, cx: &mut Context<Self>) {
        match reply {
            ShortcutsReply::Exported(Ok((path, removed))) => {
                let name = path.display().to_string();
                let text = if removed > 0 { tr("shortcuts_exported_secrets").replace("{path}", &name).replace("{n}", &removed.to_string()) }
                    else { tr("shortcuts_exported").replace("{path}", &name) };
                self.transfer_note(text, false, cx);
            }
            ShortcutsReply::Exported(Err(error)) => self.transfer_note(error, true, cx),
            ShortcutsReply::Previewed(data, Ok(preview)) => {
                let mut fields = Vec::new();
                for p in preview.get("placeholders").and_then(Value::as_array).into_iter().flatten() {
                    let (Some(id), label) = (p.get("id").and_then(Value::as_str), p.get("label").and_then(Value::as_str).unwrap_or("")) else { continue };
                    for name in p.get("names").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str) {
                        let input = cx.new(|cx| InputState::new(window, cx).masked(true));
                        fields.push((id.to_owned(), label.to_owned(), name.to_owned(), input));
                    }
                }
                self.shortcuts.transfer_note = None;
                self.shortcuts.import = Some(ImportDraft { data,
                    added: preview.get("added").and_then(Value::as_u64).unwrap_or(0),
                    replaced: preview.get("replaced").and_then(Value::as_u64).unwrap_or(0), fields, applying: false });
                cx.notify();
            }
            ShortcutsReply::Previewed(_, Err(error)) => self.transfer_note(tr("shortcuts_import_invalid").replace("{error}", &error), true, cx),
            ShortcutsReply::Imported(Ok(_)) => {
                self.shortcuts.import = None;
                self.transfer_note(tr("shortcuts_imported"), false, cx);
                self.reload_shortcuts(cx);
            }
            ShortcutsReply::Imported(Err(error)) => {
                if let Some(draft) = self.shortcuts.import.as_mut() { draft.applying = false; }
                self.transfer_note(tr("shortcuts_import_invalid").replace("{error}", &error), true, cx);
            }
            _ => {}
        }
    }

    /// Menu "⋯" do cabeçalho de Ações: importar abre a página de Atalhos, onde a conferência aparece.
    pub(super) fn transfer_menu_button(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let weak = cx.weak_entity();
        Button::new("side-shortcut-transfer").ghost().xsmall().icon(IconName::Ellipsis)
            .tooltip(tr("shortcuts_transfer")).accessibility_label(tr("shortcuts_transfer"))
            .dropdown_menu_with_anchor(Anchor::TopRight, move |menu, _, _| {
                let (import, export) = (weak.clone(), weak.clone());
                menu_style(menu)
                    .item(PopupMenuItem::new(tr("shortcuts_import")).on_click(move |_, window, cx| {
                        let _ = import.update(cx, |this, cx| {
                            this.open_settings(super::settings::Page::Shortcuts, window, cx);
                            this.import_shortcuts(cx);
                        });
                    }))
                    .item(PopupMenuItem::new(tr("shortcuts_export")).on_click(move |_, _, cx| {
                        let _ = export.update(cx, |this, cx| this.export_shortcuts(cx));
                    }))
            })
    }

    /// Aviso do último exportar/importar (painel lateral e página de Atalhos).
    pub(super) fn transfer_note_element(&self) -> Option<Div> {
        let (text, error) = self.shortcuts.transfer_note.clone()?;
        Some(div().text_size(px(12.)).whitespace_normal().text_color(if error { theme::danger() } else { theme::muted() }).child(text))
    }

    /// Conferência da importação: contagem, um campo mascarado por credencial e confirmar/cancelar.
    pub(super) fn render_import_draft(&self, cx: &mut Context<Self>) -> Option<Div> {
        let draft = self.shortcuts.import.as_ref()?;
        let summary = tr("shortcuts_import_summary").replace("{added}", &draft.added.to_string()).replace("{replaced}", &draft.replaced.to_string());
        let mut body = div().mt(px(16.)).p_4().rounded(px(12.)).border_1().border_color(theme::border()).bg(theme::inset())
            .flex().flex_col().gap(px(10.))
            .child(div().font_weight(FontWeight::SEMIBOLD).child(tr("shortcuts_import_title")))
            .child(div().text_size(px(13.)).text_color(theme::muted()).whitespace_normal().child(summary));
        if !draft.fields.is_empty() {
            body = body.child(div().text_size(px(12.5)).text_color(theme::muted()).whitespace_normal().child(tr("shortcuts_import_secrets")));
            for (_, label, name, input) in &draft.fields {
                body = body.child(div().flex().flex_col().gap(px(4.))
                    .child(div().text_size(px(12.5)).child(format!("{label}: {name}")))
                    .child(Input::new(input).small().aria_label(format!("{label}: {name}"))));
            }
        }
        Some(body.child(div().flex().justify_end().gap(px(8.))
            .child(Button::new("shortcuts-import-cancel").outline().small().label(tr("cancel"))
                .on_click(cx.listener(|this, _, _, cx| { this.shortcuts.import = None; cx.notify(); })))
            .child(Button::new("shortcuts-import-apply").primary().small().label(tr("shortcuts_import")).loading(draft.applying)
                .disabled(self.shortcuts.busy()).on_click(cx.listener(|this, _, _, cx| this.apply_import(cx))))))
    }
}

#[cfg(test)]
mod tests {
    // Sem glob: o `test` da gpui colide com o atributo padrão.
    use super::{export_file, missing_secret};
    use serde_json::json;

    #[test]
    fn missing_secret_names_the_first_blank_credential() {
        assert_eq!(missing_secret("xfreerdp /p:⟦SEGREDO:senha⟧ /v:h").as_deref(), Some("senha"));
        assert_eq!(missing_secret("delphi-vm ide"), None);
        assert_eq!(missing_secret("⟦SEGREDO:⟧"), None);
    }

    #[test]
    fn export_file_keeps_version_and_list_but_not_the_count() {
        let (text, removed) = export_file(&json!({"version": 1, "shortcuts": [{"id": "a"}], "removed": 2}));
        assert_eq!(removed, 2);
        let written: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(written, json!({"version": 1, "shortcuts": [{"id": "a"}]}));
    }
}
