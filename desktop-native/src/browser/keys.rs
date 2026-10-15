//! Tecla e modificadores da GPUI no formato do `Input.dispatchKeyEvent` do CDP, para as páginas pintadas pelo app.
use gpui_kit::*;
use serde_json::{Value, json};

/// Tecla da GPUI → `Input.dispatchKeyEvent`. Texto digitado vence, para "ç"/"ã" de tecla morta; tecla morta ainda
/// compondo (sem texto) não vai à página.
pub fn modifier_bits(m: &Modifiers) -> u8 {
    [(m.alt, 1), (m.control, 2), (m.platform, 4), (m.shift, 8)].iter().filter(|(on, _)| *on).fold(0, |a, (_, b)| a | b)
}

/// `code` e `keyCode` da pontuação como no teclado americano, que é o que o Chromium reporta sem saber a tecla
/// física: atalho de página que lê `e.code`/`e.keyCode` ("/" para buscar, "-" para diminuir) volta a funcionar.
fn punctuation(c: char) -> Option<(&'static str, u32)> {
    Some(match c {
        ';' | ':' => ("Semicolon", 186), '=' | '+' => ("Equal", 187), ',' | '<' => ("Comma", 188), '-' | '_' => ("Minus", 189),
        '.' | '>' => ("Period", 190), '/' | '?' => ("Slash", 191), '`' | '~' => ("Backquote", 192), '[' | '{' => ("BracketLeft", 219),
        '\\' | '|' => ("Backslash", 220), ']' | '}' => ("BracketRight", 221), '\'' | '"' => ("Quote", 222),
        '!' => ("Digit1", 49), '@' => ("Digit2", 50), '#' => ("Digit3", 51), '$' => ("Digit4", 52), '%' => ("Digit5", 53),
        '^' => ("Digit6", 54), '&' => ("Digit7", 55), '*' => ("Digit8", 56), '(' => ("Digit9", 57), ')' => ("Digit0", 48),
        _ => return None,
    })
}

pub fn key_event(down: bool, keystroke: &Keystroke) -> Option<Value> {
    let m = &keystroke.modifiers;
    let modifiers = modifier_bits(m);
    let typed = keystroke.key_char.as_deref().filter(|_| !m.control && !m.alt).and_then(single_char).filter(|c| !c.is_control());
    let named = match keystroke.key.as_str() {
        "enter" => Some("Enter"), "backspace" => Some("Backspace"), "delete" => Some("Delete"), "escape" => Some("Escape"),
        "tab" => Some("Tab"), "left" => Some("ArrowLeft"), "up" => Some("ArrowUp"), "right" => Some("ArrowRight"),
        "down" => Some("ArrowDown"), "home" => Some("Home"), "end" => Some("End"), "pageup" => Some("PageUp"),
        "pagedown" => Some("PageDown"), "space" => Some("Space"), _ => None,
    };
    // Espaço digitado vai como texto; a tabela só o usa sem texto.
    let mut event = if let Some(name) = named.filter(|n| *n != "Space" || typed.is_none()) {
        crate::browser::preview_fmt::key_event(name)
    } else if let Some(c) = typed {
        let text = c.to_string();
        let upper = c.to_ascii_uppercase();
        let (code, vk) = match c {
            _ if upper.is_ascii_alphabetic() => (format!("Key{upper}"), upper as u32),
            _ if c.is_ascii_digit() => (format!("Digit{c}"), c as u32),
            ' ' => ("Space".into(), 32),
            _ => punctuation(c).map_or((String::new(), 0), |(code, vk)| (code.into(), vk)),
        };
        json!({"key": text, "code": code, "text": text, "unmodifiedText": text, "windowsVirtualKeyCode": vk})
    } else if m.control || m.alt {
        // Ctrl/Alt + letra: atalho da página (Ctrl+A, Ctrl+Z), sem texto.
        let c = single_char(&keystroke.key)?;
        let upper = c.to_ascii_uppercase();
        // O próprio caractere como código virtual erra a pontuação: "." é 46, o Delete, e Ctrl+. apagava a palavra.
        let (code, vk) = if upper.is_ascii_alphabetic() || upper.is_ascii_digit() {
            (if upper.is_ascii_alphabetic() { format!("Key{upper}") } else { format!("Digit{upper}") }, upper as u32)
        } else {
            punctuation(c).map_or((String::new(), 0), |(code, vk)| (code.into(), vk))
        };
        json!({"key": c.to_string(), "code": code, "windowsVirtualKeyCode": vk})
    } else {
        return None;
    };
    event["type"] = (if down { "keyDown" } else { "keyUp" }).into();
    event["modifiers"] = modifiers.into();
    if !down || m.control || m.alt {
        let object = event.as_object_mut()?;
        object.remove("text");
        object.remove("unmodifiedText");
    }
    Some(event)
}

fn single_char(text: &str) -> Option<char> {
    let mut chars = text.chars();
    let c = chars.next()?;
    chars.next().is_none().then_some(c)
}

#[cfg(test)]
mod tests {
    // Sem `super::*`: o glob da gpui_kit traz um `test` próprio que sombreia o `#[test]` da std.
    use super::{Keystroke, Modifiers, key_event};
    use serde_json::json;

    fn stroke(key: &str, key_char: Option<&str>, control: bool, shift: bool) -> Keystroke {
        Keystroke { modifiers: Modifiers { control, shift, ..Default::default() }, key: key.into(), key_char: key_char.map(Into::into) }
    }

    #[test]
    fn maps_named_keys_text_and_shortcuts() {
        let enter = key_event(true, &stroke("enter", Some("\n"), false, false)).unwrap();
        assert_eq!((enter["key"].as_str(), enter["windowsVirtualKeyCode"].as_u64(), enter["text"].as_str()), (Some("Enter"), Some(13), Some("\r")));
        let up = key_event(false, &stroke("enter", Some("\n"), false, false)).unwrap();
        assert_eq!((up["type"].as_str(), up.get("text")), (Some("keyUp"), None));
        let shift_tab = key_event(true, &stroke("tab", None, false, true)).unwrap();
        assert_eq!((shift_tab["key"].as_str(), shift_tab["modifiers"].as_u64()), (Some("Tab"), Some(8)));
        let cedilla = key_event(true, &stroke("c", Some("ç"), false, false)).unwrap();
        assert_eq!((cedilla["key"].as_str(), cedilla["text"].as_str()), (Some("ç"), Some("ç")));
        let capital = key_event(true, &stroke("a", Some("A"), false, true)).unwrap();
        assert_eq!((capital["text"].as_str(), capital["windowsVirtualKeyCode"].as_u64()), (Some("A"), Some(65)));
        let space = key_event(true, &stroke("space", Some(" "), false, false)).unwrap();
        assert_eq!(space["text"], json!(" "));
        let select_all = key_event(true, &stroke("a", Some("a"), true, false)).unwrap();
        assert_eq!((select_all["code"].as_str(), select_all["modifiers"].as_u64(), select_all.get("text")), (Some("KeyA"), Some(2), None));
        assert_eq!(key_event(true, &stroke("f13", None, false, false)), None);
        // Tecla morta compondo (ABNT2 "~"): nada vai à página até o "ã" chegar.
        assert_eq!(key_event(true, &stroke("'", None, false, false)), None);
    }
}
