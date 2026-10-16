//! Projeta os construtores YAML do SafeLoader em texto e truthiness, sem converter metadados.
use num_bigint::BigInt;
use serde_json::Value;
use serde_saphyr::granit_parser::{Event, Parser, ScalarStyle};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    sync::LazyLock,
};

enum Data {
    Scalar(String, bool),
    Sequence(Vec<usize>),
    Mapping(Vec<usize>),
}

struct Node {
    tag: Option<String>,
    data: Data,
}

struct Document {
    nodes: Vec<Node>,
    values: Vec<Option<Value>>,
    pending: VecDeque<usize>,
    mapping_work_left: usize,
}

pub(super) fn parse(yaml: &str) -> Option<Value> {
    let (mut doc, root) = document(yaml)?;
    if doc.tag(root) != "map" {
        return None;
    }
    doc.construct(root)?;
    while let Some(id) = doc.pending.pop_front() {
        doc.fill(id)?;
    }
    let mut fields = serde_json::Map::new();
    for (key, value) in doc.mapping(root)? {
        if let Value::String(key) = doc.construct(key)? {
            fields.insert(key, doc.construct(value)?);
        }
    }
    Some(Value::Object(fields))
}

fn document(yaml: &str) -> Option<(Document, usize)> {
    let mut parser = Parser::new_from_str(yaml);
    let mut nodes = Vec::<Node>::new();
    let mut stack = Vec::<usize>::new();
    let mut anchors = HashMap::new();
    let mut root = None;
    let mut documents = 0;
    while let Some(event) = parser.next_event() {
        let (event, _) = event.ok()?;
        let (data, anchor, tag, container) = match event {
            Event::DocumentStart(..) => {
                documents += 1;
                if documents > 1 {
                    return None;
                }
                continue;
            }
            Event::SequenceEnd | Event::MappingEnd => {
                stack.pop()?;
                continue;
            }
            Event::Alias(anchor) => {
                let id = *anchors.get(&anchor)?;
                attach(&mut nodes, &stack, &mut root, id)?;
                continue;
            }
            Event::Scalar(value, style, anchor, tag) => (
                Data::Scalar(value.into_owned(), style == ScalarStyle::Plain),
                anchor,
                tag,
                false,
            ),
            Event::SequenceStart(_, anchor, tag) => (Data::Sequence(vec![]), anchor, tag, true),
            Event::MappingStart(_, anchor, tag) => (Data::Mapping(vec![]), anchor, tag, true),
            _ => continue,
        };
        let tag = tag.map(|tag| format!("{}{}", tag.handle(), tag.suffix()));
        let id = nodes.len();
        nodes.push(Node { tag, data });
        if anchor != 0 {
            anchors.insert(anchor, id);
        }
        attach(&mut nodes, &stack, &mut root, id)?;
        if container {
            stack.push(id);
        }
    }
    let values = vec![None; nodes.len()];
    Some((
        Document {
            nodes,
            values,
            pending: VecDeque::new(),
            // Aliases podem repetir o mesmo mapa exponencialmente durante os merges.
            mapping_work_left: 1_000_000,
        },
        root?,
    ))
}

fn attach(nodes: &mut [Node], stack: &[usize], root: &mut Option<usize>, id: usize) -> Option<()> {
    if let Some(parent) = stack.last() {
        match &mut nodes[*parent].data {
            Data::Sequence(items) | Data::Mapping(items) => items.push(id),
            _ => return None,
        }
    } else if root.replace(id).is_some() {
        return None;
    }
    Some(())
}

impl Document {
    fn tag(&self, id: usize) -> &str {
        let node = &self.nodes[id];
        match node.tag.as_deref() {
            Some("!") => match node.data {
                Data::Scalar(..) => "str",
                Data::Sequence(_) => "seq",
                Data::Mapping(_) => "map",
            },
            Some(tag) => tag.strip_prefix("tag:yaml.org,2002:").unwrap_or("unknown"),
            None => match &node.data {
                Data::Scalar(value, true) => implicit_tag(value),
                Data::Scalar(_, false) => "str",
                Data::Sequence(_) => "seq",
                Data::Mapping(_) => "map",
            },
        }
    }

    fn construct(&mut self, id: usize) -> Option<Value> {
        if let Some(value) = &self.values[id] {
            return Some(value.clone());
        }
        let tag = self.tag(id);
        let value = match &self.nodes[id].data {
            Data::Scalar(text, _) => match tag {
                "str" => Value::String(text.clone()),
                "null" => Value::Null,
                "bool" => Value::Bool(match text.to_lowercase().as_str() {
                    "yes" | "true" | "on" => true,
                    "no" | "false" | "off" => false,
                    _ => return None,
                }),
                "int" => Value::Bool(integer(text)? != BigInt::from(0)),
                "float" => Value::Bool(float(text)? != 0.0),
                "binary" => Value::Bool(binary(text)?),
                "timestamp" => {
                    timestamp(text)?;
                    Value::Bool(true)
                }
                _ => return None,
            },
            Data::Sequence(items) if matches!(tag, "seq" | "omap" | "pairs") => {
                self.pending.push_back(id);
                Value::Bool(!items.is_empty())
            }
            Data::Mapping(items) if matches!(tag, "map" | "set") => {
                self.pending.push_back(id);
                Value::Bool(!items.is_empty())
            }
            _ => return None,
        };
        self.values[id] = Some(value.clone());
        Some(value)
    }

    // A fila permite aliases recursivos de valores, como o construtor adiado do SafeLoader.
    fn fill(&mut self, id: usize) -> Option<()> {
        if matches!(self.nodes[id].data, Data::Mapping(_)) {
            let pairs = self.mapping(id)?;
            self.values[id] = Some(Value::Bool(!pairs.is_empty()));
            for (key, value) in pairs {
                if !matches!(self.nodes[key].data, Data::Scalar(..)) {
                    return None;
                }
                self.construct(key)?;
                self.construct(value)?;
            }
        } else if matches!(self.tag(id), "omap" | "pairs") {
            let Data::Sequence(items) = &self.nodes[id].data else {
                return None;
            };
            for child in items.clone() {
                let Data::Mapping(pair) = &self.nodes[child].data else {
                    return None;
                };
                if pair.len() != 2 {
                    return None;
                }
                let (key, value) = (pair[0], pair[1]);
                self.construct(key)?;
                self.construct(value)?;
            }
        } else {
            let Data::Sequence(items) = &self.nodes[id].data else {
                return None;
            };
            for child in items.clone() {
                self.construct(child)?;
            }
        }
        Some(())
    }

    fn mapping(&mut self, id: usize) -> Option<Vec<(usize, usize)>> {
        enum Action {
            Enter(usize),
            Leave(usize),
            Pair(usize, usize),
        }
        let mut actions = vec![Action::Enter(id)];
        let mut path = HashSet::new();
        let mut result = Vec::new();
        while let Some(action) = actions.pop() {
            self.mapping_work_left = self.mapping_work_left.checked_sub(1)?;
            match action {
                Action::Leave(id) => {
                    path.remove(&id);
                }
                Action::Pair(key, value) => result.push((key, value)),
                Action::Enter(id) => {
                    if !path.insert(id) {
                        return None;
                    }
                    let Data::Mapping(items) = &self.nodes[id].data else {
                        return None;
                    };
                    if items.len() % 2 != 0 {
                        return None;
                    }
                    let mut direct = Vec::new();
                    let mut merges = Vec::new();
                    for pair in items.clone().chunks_exact(2) {
                        let (key, value) = (pair[0], pair[1]);
                        match self.tag(key) {
                            "merge" => match &self.nodes[value].data {
                                Data::Mapping(_) => merges.push(value),
                                Data::Sequence(items) => merges.extend(items.iter().rev().copied()),
                                _ => return None,
                            },
                            "value" => {
                                self.nodes[key].tag = Some("tag:yaml.org,2002:str".into());
                                direct.push((key, value));
                            }
                            _ => direct.push((key, value)),
                        }
                    }
                    actions.push(Action::Leave(id));
                    actions.extend(direct.into_iter().rev().map(|(k, v)| Action::Pair(k, v)));
                    actions.extend(merges.into_iter().rev().map(Action::Enter));
                }
            }
        }
        Some(result)
    }
}

fn implicit_tag(text: &str) -> &'static str {
    static BOOLEAN: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(
            r"^(?:yes|Yes|YES|no|No|NO|true|True|TRUE|false|False|FALSE|on|On|ON|off|Off|OFF)$",
        )
        .unwrap()
    });
    static INTEGER: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(
        r"^(?:[-+]?0b[0-1_]+|[-+]?0[0-7_]+|[-+]?(?:0|[1-9][0-9_]*)|[-+]?0x[0-9a-fA-F_]+|[-+]?[1-9][0-9_]*(?::[0-5]?[0-9])+)$").unwrap()
    });
    static FLOAT: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(
        r"^(?:[-+]?(?:[0-9][0-9_]*)\.[0-9_]*(?:[eE][-+][0-9]+)?|\.[0-9][0-9_]*(?:[eE][-+][0-9]+)?|[-+]?[0-9][0-9_]*(?::[0-5]?[0-9])+\.[0-9_]*|[-+]?\.(?:inf|Inf|INF)|\.(?:nan|NaN|NAN))$").unwrap()
    });
    static DATE: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(
        r"(?x)^(?:[0-9]{4}-[0-9]{2}-[0-9]{2}|[0-9]{4}-[0-9]{1,2}-[0-9]{1,2}(?:[Tt]|[\ \t]+)[0-9]{1,2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]*)?(?:[\ \t]*(?:Z|[-+][0-9]{1,2}(?::[0-9]{2})?))?)$").unwrap()
    });
    match text {
        "" | "~" | "null" | "Null" | "NULL" => "null",
        "<<" => "merge",
        "=" => "value",
        _ if BOOLEAN.is_match(text) => "bool",
        _ if INTEGER.is_match(text) => "int",
        _ if FLOAT.is_match(text) => "float",
        _ if DATE.is_match(text) => "timestamp",
        _ => "str",
    }
}

fn digits(text: &str) -> String {
    static DECIMAL: LazyLock<regex::Regex> =
        LazyLock::new(|| regex::Regex::new(r"^\p{Nd}$").unwrap());
    text.chars()
        .map(|ch| {
            if ch.is_ascii() || !DECIMAL.is_match(ch.encode_utf8(&mut [0; 4])) {
                return ch;
            }
            let mut start = u32::from(ch);
            while let Some(previous) = start.checked_sub(1).and_then(char::from_u32) {
                if !DECIMAL.is_match(previous.encode_utf8(&mut [0; 4])) {
                    break;
                }
                start -= 1;
            }
            char::from_digit((u32::from(ch) - start) % 10, 10).unwrap()
        })
        .collect()
}

fn parse_integer(text: &str, base: u32) -> Option<BigInt> {
    let text = digits(text.trim());
    let mut unsigned = text.strip_prefix(['+', '-']).unwrap_or(&text);
    let prefix = match base {
        2 => "0b",
        8 => "0o",
        16 => "0x",
        _ => "",
    };
    if !prefix.is_empty()
        && unsigned
            .get(..2)
            .is_some_and(|p| p.eq_ignore_ascii_case(prefix))
    {
        unsigned = &unsigned[2..];
    }
    if unsigned.is_empty() || !unsigned.chars().all(|c| c.is_digit(base)) {
        return None;
    }
    if base == 10 && unsigned.len() > 4300 {
        return None;
    }
    let number = BigInt::parse_bytes(unsigned.as_bytes(), base)?;
    Some(if text.starts_with('-') {
        -number
    } else {
        number
    })
}

fn integer(text: &str) -> Option<BigInt> {
    let text = text.replace('_', "");
    let value = text.strip_prefix(['+', '-']).unwrap_or(&text);
    let number = if value == "0" {
        BigInt::from(0)
    } else if let Some(value) = value.strip_prefix("0b") {
        parse_integer(value, 2)?
    } else if let Some(value) = value.strip_prefix("0x") {
        parse_integer(value, 16)?
    } else if value.starts_with('0') {
        parse_integer(value, 8)?
    } else if value.contains(':') {
        let mut number = BigInt::from(0);
        for part in value.split(':') {
            number = number * 60 + parse_integer(part, 10)?;
        }
        number
    } else {
        parse_integer(value, 10)?
    };
    Some(if text.starts_with('-') {
        -number
    } else {
        number
    })
}

fn float(text: &str) -> Option<f64> {
    let text = text.replace('_', "").to_lowercase();
    let value = text.strip_prefix(['+', '-']).unwrap_or(&text);
    let number = match value {
        ".inf" => f64::INFINITY,
        ".nan" => f64::NAN,
        "" => return None,
        value if value.contains(':') => {
            let mut number = 0.0;
            let mut base = BigInt::from(1);
            for part in value.split(':').rev() {
                let multiplier = base.to_string().parse::<f64>().ok()?;
                if !multiplier.is_finite() {
                    return None;
                }
                number += digits(part.trim()).parse::<f64>().ok()? * multiplier;
                base *= 60;
            }
            number
        }
        _ => digits(value.trim()).parse().ok()?,
    };
    Some(if text.starts_with('-') {
        -number
    } else {
        number
    })
}

fn binary(text: &str) -> Option<bool> {
    if !text.is_ascii() {
        return None;
    }
    let mut data = 0;
    let mut padding = 0;
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'/') {
            data += 1;
            padding = 0;
        } else if byte == b'=' {
            padding += 1;
        }
    }
    match data % 4 {
        0 => Some(data != 0),
        2 if padding >= 2 => Some(true),
        3 if padding >= 1 => Some(true),
        _ => None,
    }
}

fn timestamp(text: &str) -> Option<()> {
    static TIMESTAMP: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(
        r"(?x)^(?P<year>[0-9]{4})-(?P<month>[0-9]{1,2})-(?P<day>[0-9]{1,2})(?:(?:[Tt]|[\ \t]+)(?P<hour>[0-9]{1,2}):(?P<minute>[0-9]{2}):(?P<second>[0-9]{2})(?:\.[0-9]*)?(?:[\ \t]*(?:Z|(?P<sign>[-+])(?P<zone>[0-9]{1,2})(?::(?P<offset>[0-9]{2}))?))?)?$").unwrap()
    });
    let captures = TIMESTAMP.captures(text)?;
    let get = |key| captures.name(key)?.as_str().parse::<u32>().ok();
    let year = get("year")?;
    if year == 0 {
        return None;
    }
    chrono::NaiveDate::from_ymd_opt(year as i32, get("month")?, get("day")?)?;
    if captures.name("hour").is_some() {
        chrono::NaiveTime::from_hms_opt(get("hour")?, get("minute")?, get("second")?)?;
    }
    if get("zone").unwrap_or(0) * 60 + get("offset").unwrap_or(0) >= 24 * 60 {
        return None;
    }
    Some(())
}

#[cfg(test)]
mod tests {
    use super::parse;

    #[test]
    fn yaml_merge_expansion_is_bounded_and_preserves_normal_precedence() {
        let merged = |levels| {
            let mut yaml = String::from("base: &a0 {description: herdada}\n");
            for level in 1..=levels {
                let previous = level - 1;
                yaml.push_str(&format!(
                    "map{level}: &a{level} {{<<: [*a{previous}, *a{previous}]}}\n"
                ));
            }
            yaml.push_str(&format!("<<: *a{levels}\ndescription: própria\n"));
            yaml
        };
        assert_eq!(parse(&merged(4)).unwrap()["description"], "própria");
        assert!(parse(&merged(24)).is_none());
    }
}
