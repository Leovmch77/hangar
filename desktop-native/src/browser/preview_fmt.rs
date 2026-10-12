//! Lógica pura do hangar-preview no app nativo. A árvore do `snapshot` sai mais enxuta que a do Electron
//! (`shell/preview_fmt.cjs`), mas cada linha acionável mantém `- papel "nome" [ref=@eN]` no começo: o Jev lê assim.
use std::collections::HashMap;

use serde_json::{Value, json};

/// Papéis que só estruturam o desenho: não viram linha.
const MUTE: [&str; 5] = ["none", "generic", "presentation", "InlineTextBox", "LineBreak"];
/// Estrutura de tabela que só tem sentido com nome; sem ele, os filhos sobem um nível.
const STRUCTURE: [&str; 5] = ["row", "cell", "gridcell", "rowgroup", "paragraph"];
/// Só o que o agente pode acionar ganha ref, para o número não virar ruído.
const ACTIONABLE: [&str; 15] = ["button", "link", "textbox", "searchbox", "checkbox", "radio", "combobox", "listbox",
    "option", "menuitem", "tab", "switch", "slider", "spinbutton", "treeitem"];
pub const LAYOUT_MAX: u32 = 8192;
/// Árvore maior que isto é cortada com aviso: uma página longa não pode encher o contexto do agente.
pub const SNAPSHOT_MAX: usize = 24_000;

pub struct Compact {
    pub lines: Vec<String>,
    pub refs: HashMap<String, i64>,
}

/// O que a linha não mostra mas o agente precisa saber antes de agir.
fn states(node: &Value, role: &str, name: &str) -> String {
    let mut out = String::new();
    let mut flags: HashMap<&str, &Value> = HashMap::new();
    for p in node["properties"].as_array().into_iter().flatten() {
        if let Some(n) = p["name"].as_str() { flags.insert(n, &p["value"]["value"]); }
    }
    let on = |k: &str| flags.get(k).is_some_and(|v| **v == Value::Bool(true));
    match flags.get("checked").and_then(|v| v.as_str().map(str::to_owned).or_else(|| v.as_bool().map(|b| b.to_string()))).as_deref() {
        Some("true") => out += " [checked]",
        Some("mixed") => out += " [mixed]",
        Some(_) if matches!(role, "checkbox" | "radio" | "switch" | "menuitemcheckbox" | "menuitemradio") => out += " [unchecked]",
        _ => {}
    }
    if on("pressed") { out += " [pressed]"; }
    if on("selected") { out += " [selected]"; }
    if let Some(v) = flags.get("expanded").and_then(|v| v.as_bool()) { out += if v { " [expanded]" } else { " [collapsed]" }; }
    if on("disabled") { out += " [disabled]"; }
    if on("focused") { out += " [focused]"; }
    if on("required") { out += " [required]"; }
    if flags.get("invalid").and_then(|v| v.as_str()).is_some_and(|v| v != "false") { out += " [invalid]"; }
    match &node["value"]["value"] {
        Value::String(value) if !value.is_empty() && value != name => {
            let short: String = value.chars().take(80).collect();
            out += &format!(" value=\"{short}{}\"", if short.len() < value.len() { "…" } else { "" });
        }
        Value::Number(n) => out += &format!(" value={n}"),
        _ => {}
    }
    out
}

/// `refs_only`: só as linhas acionáveis, sem a estrutura em volta.
pub fn compact_ax(nodes: &[Value], refs_only: bool) -> Compact {
    let by_id: HashMap<&str, &Value> = nodes.iter().filter_map(|n| Some((n["nodeId"].as_str()?, n))).collect();
    let mut out = Compact { lines: Vec::new(), refs: HashMap::new() };
    let mut seq = 0;
    // Pilha em vez de recursão: DOM muito fundo não estoura a pilha da thread da interface. Cada entrada leva o nome
    // da linha acima, para o texto que só repete o nome dela não virar outra linha.
    let mut stack: Vec<(&str, usize, &str)> = nodes.first().and_then(|n| n["nodeId"].as_str()).map(|id| vec![(id, 0, "")]).unwrap_or_default();
    while let Some((id, level, parent)) = stack.pop() {
        let Some(node) = by_id.get(id) else { continue };
        let role = node["role"]["value"].as_str().unwrap_or("");
        let name = node["name"]["value"].as_str().unwrap_or("");
        let trimmed = name.trim();
        let shown = !node["ignored"].as_bool().unwrap_or(false) && !role.is_empty() && !MUTE.contains(&role)
            // Tabela de layout é desenho; o nome dela repete o texto dos filhos.
            && !role.starts_with("Layout")
            && !(trimmed.is_empty() && STRUCTURE.contains(&role))
            // Texto que já está no nome de quem o contém (botão cujo nome junta os textos dele), ou só pontuação
            // (" | "), não diz nada novo.
            && !(role == "StaticText" && (parent.contains(trimmed) || !trimmed.chars().any(char::is_alphanumeric)));
        let (mut child_level, mut child_parent) = (level, parent);
        if shown {
            let actionable = ACTIONABLE.contains(&role) && node["backendDOMNodeId"].as_i64().is_some();
            let mut line = format!("{}- {role}", if refs_only { String::new() } else { "  ".repeat(level) });
            if !name.is_empty() { line += &format!(" \"{name}\""); }
            if actionable && let Some(backend) = node["backendDOMNodeId"].as_i64() {
                seq += 1;
                let r = format!("@e{seq}");
                line += &format!(" [ref={r}]");
                out.refs.insert(r, backend);
            }
            line += &states(node, role, name);
            if actionable || !refs_only { out.lines.push(line); }
            child_level = level + 1;
            child_parent = name;
        }
        for child in node["childIds"].as_array().into_iter().flatten().rev() {
            if let Some(child) = child.as_str() { stack.push((child, child_level, child_parent)); }
        }
    }
    out
}

/// Junta as linhas até `max` caracteres; o que passar vira um aviso com o caminho para ver o resto.
pub fn capped(lines: &[String], max: usize) -> String {
    let mut out = String::new();
    for (i, line) in lines.iter().enumerate() {
        if out.len() + line.len() + 1 > max {
            out += &format!("… cortado: mostrei {i} de {} linhas. Use `snapshot --refs` (só acionáveis), `text` ou `snapshot --max <caracteres>`.", lines.len());
            return out;
        }
        out += line;
        out.push('\n');
    }
    out.pop();
    out
}

/// Tecla nomeada precisa de `code` e do código virtual para o Chromium reconhecer; Enter precisa do caractere,
/// senão o formulário não envia.
pub fn key_event(key: &str) -> Value {
    let named = |code: &str, vk: u32, text: Option<&str>| {
        let mut e = json!({"key": key, "code": code, "windowsVirtualKeyCode": vk});
        if let Some(t) = text { e["text"] = t.into(); e["unmodifiedText"] = t.into(); }
        e
    };
    match key {
        "Enter" => named("Enter", 13, Some("\r")),
        "Tab" => named("Tab", 9, None),
        "Escape" => named("Escape", 27, None),
        "Backspace" => named("Backspace", 8, None),
        "Delete" => named("Delete", 46, None),
        "ArrowUp" => named("ArrowUp", 38, None),
        "ArrowDown" => named("ArrowDown", 40, None),
        "ArrowLeft" => named("ArrowLeft", 37, None),
        "ArrowRight" => named("ArrowRight", 39, None),
        "Home" => named("Home", 36, None),
        "End" => named("End", 35, None),
        "PageUp" => named("PageUp", 33, None),
        "PageDown" => named("PageDown", 34, None),
        "Space" => json!({"key": " ", "code": "Space", "windowsVirtualKeyCode": 32, "text": " ", "unmodifiedText": " "}),
        _ if key.chars().count() == 1 => {
            let vk = key.to_uppercase().chars().next().map_or(0, |c| c as u32);
            json!({"key": key, "text": key, "unmodifiedText": key, "windowsVirtualKeyCode": vk})
        }
        // ponytail: tecla fora da tabela vai só com `key`, como no Electron.
        _ => json!({"key": key}),
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Layout { Desktop, Mobile, Custom(u32, u32) }

impl Layout {
    pub fn label(&self) -> String {
        match self { Layout::Desktop => "desktop".into(), Layout::Mobile => "mobile".into(), Layout::Custom(w, h) => format!("{w}x{h}") }
    }
}

pub fn parse_layout(args: &[String]) -> Result<Layout, String> {
    let size = |v: &String| v.parse::<u32>().ok().filter(|n| (1..=LAYOUT_MAX).contains(n));
    match args {
        [m] if m == "mobile" => Ok(Layout::Mobile),
        [m] if m == "desktop" => Ok(Layout::Desktop),
        [w, h] if size(w).is_some() && size(h).is_some() => Ok(Layout::Custom(size(w).unwrap_or(1), size(h).unwrap_or(1))),
        _ => Err(format!("erro: layout precisa ser mobile, desktop ou dois inteiros entre 1 e {LAYOUT_MAX}: {} {}",
            args.first().map_or("", String::as_str), args.get(1).map_or("", String::as_str)).trim_end().to_owned()),
    }
}

pub fn sidecar_name(key: &str) -> String {
    let mut out = String::new();
    let mut gap = false;
    for c in key.replace("::", "--").chars() {
        if c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-') { out.push(c); gap = false; }
        else if !gap { out.push('-'); gap = true; }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn node(id: &str, role: &str, name: &str, backend: Option<i64>, children: &[&str]) -> Value {
        json!({"nodeId": id, "role": {"value": role}, "name": {"value": name}, "backendDOMNodeId": backend, "childIds": children})
    }

    #[test]
    fn compacts_like_the_electron_formatter() {
        let nodes = vec![
            node("1", "RootWebArea", "Login", None, &["2", "5"]),
            node("2", "generic", "", Some(10), &["3", "4"]),
            node("3", "textbox", "Email", Some(11), &[]),
            node("4", "button", "Entrar", Some(12), &[]),
            json!({"nodeId": "5", "ignored": true, "role": {"value": "link"}, "childIds": ["6"]}),
            node("6", "link", "Ajuda", Some(14), &[]),
        ];
        let out = compact_ax(&nodes, false);
        assert_eq!(out.lines, vec![
            "- RootWebArea \"Login\"",
            "  - textbox \"Email\" [ref=@e1]",
            "  - button \"Entrar\" [ref=@e2]",
            "  - link \"Ajuda\" [ref=@e3]",
        ]);
        assert_eq!(out.refs.get("@e2"), Some(&12));
        assert_eq!(out.refs.len(), 3);
    }

    #[test]
    fn lean_tree_drops_repeats_and_shows_state() {
        let mut check = node("4", "checkbox", "Lembrar", Some(20), &[]);
        check["properties"] = json!([{"name": "checked", "value": {"value": "false"}}, {"name": "disabled", "value": {"value": true}}]);
        let mut field = node("5", "textbox", "Email", Some(21), &[]);
        field["value"] = json!({"value": "a@b.c"});
        field["properties"] = json!([{"name": "focused", "value": {"value": true}}, {"name": "required", "value": {"value": true}}]);
        let nodes = vec![
            node("1", "RootWebArea", "Login", None, &["2"]),
            node("2", "LayoutTable", "", None, &["3"]),
            node("3", "button", "Entrar agora", Some(19), &["6", "7", "4", "5"]),
            check, field,
            node("6", "StaticText", "agora", None, &[]),
            node("7", "StaticText", " | ", None, &[]),
        ];
        assert_eq!(compact_ax(&nodes, false).lines, vec![
            "- RootWebArea \"Login\"",
            "  - button \"Entrar agora\" [ref=@e1]",
            "    - checkbox \"Lembrar\" [ref=@e2] [unchecked] [disabled]",
            "    - textbox \"Email\" [ref=@e3] [focused] [required] value=\"a@b.c\"",
        ]);
        assert_eq!(compact_ax(&nodes, true).lines[0], "- button \"Entrar agora\" [ref=@e1]");
        let lines: Vec<String> = (0..10).map(|i| format!("linha {i}")).collect();
        assert!(capped(&lines, 30).starts_with("linha 0\nlinha 1\nlinha 2\n… cortado: mostrei 3 de 10 linhas"));
    }

    #[test]
    fn empty_tree_gives_nothing() {
        let out = compact_ax(&[], false);
        assert!(out.lines.is_empty() && out.refs.is_empty());
    }

    #[test]
    fn keys_carry_code_and_text() {
        assert_eq!(key_event("Enter"), json!({"key": "Enter", "code": "Enter", "windowsVirtualKeyCode": 13, "text": "\r", "unmodifiedText": "\r"}));
        assert_eq!(key_event("Tab"), json!({"key": "Tab", "code": "Tab", "windowsVirtualKeyCode": 9}));
        assert_eq!(key_event("a"), json!({"key": "a", "text": "a", "unmodifiedText": "a", "windowsVirtualKeyCode": 65}));
        assert_eq!(key_event("F5"), json!({"key": "F5"}));
    }

    #[test]
    fn layout_accepts_modes_and_bounded_sizes() {
        let s = |v: &[&str]| v.iter().map(|x| x.to_string()).collect::<Vec<_>>();
        assert_eq!(parse_layout(&s(&["mobile"])), Ok(Layout::Mobile));
        assert_eq!(parse_layout(&s(&["desktop"])), Ok(Layout::Desktop));
        assert_eq!(parse_layout(&s(&["1280", "800"])), Ok(Layout::Custom(1280, 800)));
        assert_eq!(parse_layout(&s(&["0", "800"])), Err("erro: layout precisa ser mobile, desktop ou dois inteiros entre 1 e 8192: 0 800".into()));
        assert!(parse_layout(&s(&["9000", "800"])).is_err());
        assert!(parse_layout(&s(&["tablet"])).is_err());
        assert_eq!(Layout::Custom(390, 844).label(), "390x844");
    }

    #[test]
    fn sidecar_name_matches_the_shell() {
        assert_eq!(sidecar_name("http://127.0.0.1:8765::minha sessão"), "http-127.0.0.1-8765--minha-sess-o");
        assert_eq!(sidecar_name("srv::a_b-c.d"), "srv--a_b-c.d");
    }
}
