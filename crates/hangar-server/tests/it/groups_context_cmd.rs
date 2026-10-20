//! `hangar-server pair-context` como processo contra o que o `pair_hook.py` devolvia
//! (`fixtures/contract/pair_hook`), mais as mudanças decididas: grupo com par de fora (I-3A) e linha
//! do contrato em grupo entre máquinas (I-4A). O tmux falso é um script de shell, por isso só Unix.
#![cfg(unix)]
use std::collections::BTreeMap;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

use serde_json::{Value, json};

fn fixtures() -> BTreeMap<String, Value> {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../backend/tests/fixtures/contract/pair_hook");
    std::fs::read_dir(&dir).unwrap().map(|e| e.unwrap().path()).filter(|p| p.extension().is_some_and(|x| x == "json"))
        .map(|p| (p.file_stem().unwrap().to_string_lossy().into_owned(), serde_json::from_str(&std::fs::read_to_string(&p).unwrap()).unwrap()))
        .collect()
}

struct Run { rc: Option<i32>, stdout: String, elapsed: Duration }

/// Mesmo arranjo do `gen_golden.py`: pasta de grupo, HOME com `claude-headless`, PATH só com o tmux falso.
/// `tmux` = Some((list-panes, código do has-session)) ou um script inteiro em `Err`.
fn run(files: &Value, headless: &Value, env: &Value, tmux: Option<Result<(&str, i64), &str>>) -> Run {
    let root = tempfile::Builder::new().prefix("grp-t3-").tempdir().unwrap();
    let (pair, home, bin) = (root.path().join("pair"), root.path().join("home"), root.path().join("bin"));
    for d in [&pair, &home.join(".hangar/claude-headless"), &bin] { std::fs::create_dir_all(d).unwrap(); }
    for (dir, set) in [(&pair, files), (&home.join(".hangar/claude-headless"), headless)] {
        for (name, text) in set.as_object().unwrap() { std::fs::write(dir.join(name), text.as_str().unwrap()).unwrap(); }
    }
    let script = match tmux {
        None => None,
        Some(Ok((panes, rc))) => Some(format!("#!/bin/sh\nif [ \"$1\" = list-panes ]; then printf '%s' '{}'; exit 0; fi\n\
            if [ \"$1\" = has-session ]; then exit {rc}; fi\nexit 1\n", panes.replace('\'', "'\\''"))),
        Some(Err(body)) => Some(body.to_owned()),
    };
    if let Some(script) = script {
        let sh = bin.join("tmux");
        std::fs::write(&sh, script).unwrap();
        std::fs::set_permissions(&sh, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_hangar-server"));
    cmd.arg("pair-context").arg(&pair).env_clear().env("HOME", &home).env("PATH", &bin).env("LANG", "C.UTF-8");
    for (k, v) in env.as_object().unwrap() { cmd.env(k, v.as_str().unwrap()); }
    let started = Instant::now();
    let out = cmd.output().unwrap();
    let stdout = String::from_utf8(out.stdout).unwrap().replace(pair.to_str().unwrap(), "<pair>");
    Run { rc: out.status.code(), stdout, elapsed: started.elapsed() }
}

fn run_fixture(fx: &Value) -> Run {
    let input = &fx["input"];
    let tmux = input["tmux"].as_object().map(|t| Ok((t["list_panes"].as_str().unwrap(), t["has_session_rc"].as_i64().unwrap())));
    run(&input["pair_dir"], &input["headless"], &input["env"], tmux)
}

/// `additionalContext` de uma saída do hook.
fn context(stdout: &str) -> String {
    let v: Value = serde_json::from_str(stdout).unwrap();
    v["hookSpecificOutput"]["additionalContext"].as_str().unwrap().to_owned()
}

/// Variantes que a I-3A muda: o texto de grupo vem antes do bloco externo.
const MIXED: [&str; 2] = ["external_registry_unreadable", "external_via_other_member"];

#[test]
fn pair_context_matches_the_python_hook() {
    let mut checked = 0;
    for (name, fx) in fixtures() {
        if MIXED.contains(&name.as_str()) { continue; }
        let got = run_fixture(&fx);
        assert_eq!(got.rc, Some(0), "{name}");
        assert_eq!(got.stdout, fx["output"]["stdout"].as_str().unwrap(), "{name}");
        checked += 1;
    }
    assert_eq!(checked, 30);
}

/// I-3A: membro local de grupo com par de fora recebe o texto de grupo (o mesmo de um grupo `a`+`b`
/// sem tarefa) seguido do bloco externo que o Python devolvia sozinho. Registro ilegível: só o stdout.
#[test]
fn mixed_group_reinjects_group_and_external_text() {
    let fx = fixtures();
    let group = context(fx["headless_key_unknown_falls_to_pane"]["output"]["stdout"].as_str().unwrap());
    for name in MIXED {
        let got = run_fixture(&fx[name]);
        assert_eq!(got.rc, Some(0), "{name}");
        let external = context(fx[name]["output"]["stdout"].as_str().unwrap());
        assert_eq!(context(&got.stdout), format!("{group}\n{external}"), "{name}");
    }
}

fn pair_record(local: &str, alias: &str, session: &str, owner: &str) -> Value {
    json!({"share_id": format!("sh-{alias}"), "local_session": local, "alias": alias, "peer_owner": owner, "peer_session": session,
           "peer_address": format!("https://{alias}.example.ts.net:8443"), "peer_token": "tok", "created_at": 1.0})
}

fn pane_a() -> Value { json!({"TMUX_PANE": "%3"}) }
const PANES: Option<Result<(&str, i64), &str>> = Some(Ok(("%3\ta\n%4\tb\n", 1)));

/// Um bloco externo por par de fora, cada um uma vez.
#[test]
fn two_outside_pairs_get_one_block_each() {
    let files = json!({
        "a.json": json!({"peers": ["b", "ana::rev", "bia::x"], "task": "", "gid": "ab12cd34", "harness": {}}).to_string(),
        "external_pairs.json": json!([pair_record("a", "ana", "rev", "Ana"), pair_record("b", "bia", "x", "Bia")]).to_string(),
    });
    let text = context(&run(&files, &json!({}), &pane_a(), PANES).stdout);
    assert!(text.starts_with("[painel: grupo de trabalho] Você, 'a', está num grupo de trabalho."), "{text}");
    for (peer, owner) in [("ana::rev", "Ana"), ("bia::x", "Bia")] {
        assert_eq!(text.matches(&format!("está pareada com '{peer}', uma sessão da máquina '{owner}'")).count(), 1, "{text}");
        assert_eq!(text.matches(&format!("[de fora: {peer}]")).count(), 1, "{text}");
    }
}

/// Só par de fora entre os peers: nenhum membro daqui para citar no texto de grupo, fica o aviso externo
/// (a forma do `external_direct`). Filha ligada também fica só com ele.
#[test]
fn pair_context_without_local_others_prints_only_the_outside_warning() {
    let fx = fixtures();
    let external = context(fx["external_direct"]["output"]["stdout"].as_str().unwrap());
    let files = json!({
        "a.json": json!({"peers": ["pai", "ana::rev"], "task": "", "gid": "ab12cd34", "harness": {}, "linked_by": "pai"}).to_string(),
        "external_pairs.json": json!([pair_record("a", "ana", "rev", "Ana")]).to_string(),
    });
    assert_eq!(context(&run(&files, &json!({}), &pane_a(), PANES).stdout), external);
}

/// I-4A: grupo entre máquinas cita o caminho na dona e a dona pela tool `contract` nas outras.
#[test]
fn fed_contract_line_follows_the_owner() {
    for (local, line) in [(true, "- Decisões que o grupo consulta vão em <pair>/grupo-fe12.md (criar se não existir, curto)."),
                          (false, "- Decisões que o grupo consulta ficam com a máquina `casa`: leia e grave pela tool `contract` do MCP ou `hangar-send --contrato`.")] {
        let files = json!({"a.json": json!({"peers": ["casa::b"], "task": "", "gid": "fe12", "harness": {},
            "fed": {"owner": "casa", "local": local, "version": 3}}).to_string()});
        let text = context(&run(&files, &json!({}), &pane_a(), PANES).stdout);
        assert_eq!(text.lines().filter(|l| l.starts_with("- Decisões")).collect::<Vec<_>>(), [line], "local={local}");
    }
}

/// Nenhuma porta, token ou servidor no ambiente: a reinjeção sai só do disco.
#[test]
fn pair_context_works_without_server() {
    let fx = &fixtures()["group"];
    let got = run_fixture(fx);
    assert_eq!((got.rc, got.stdout.as_str()), (Some(0), fx["output"]["stdout"].as_str().unwrap()));
}

/// Pasta inexistente, sidecar torto, sem argumento, sem tmux ou tmux travado: código 0 e nada no stdout,
/// e o tmux travado (list-panes e has-session) não segura a abertura além do prazo único de 3 s.
#[test]
fn pair_context_never_fails_the_open() {
    let ok = json!({"a.json": json!({"peers": ["b"]}).to_string()});
    let stamp = json!({"TMUX_PANE": "%3", "CP_SESSION_NAME": "a"});
    for (label, files, tmux) in [
        ("sidecar torto", json!({"a.json": "{torto"}), PANES),
        ("sem tmux", ok.clone(), None),
        ("tmux travado", ok.clone(), Some(Err("#!/bin/sh\nexec /bin/sleep 30\n"))),
    ] {
        let got = run(&files, &json!({}), &stamp, tmux);
        assert_eq!((got.rc, got.stdout.as_str()), (Some(0), ""), "{label}");
        assert!(got.elapsed < Duration::from_secs(5), "{label}: {:?}", got.elapsed);
    }
    let missing = Command::new(env!("CARGO_BIN_EXE_hangar-server")).arg("pair-context").arg(PathBuf::from("/nonexistent/grp-t3"))
        .env_clear().env("CP_SESSION_NAME", "a").output().unwrap();
    assert_eq!((missing.status.code(), missing.stdout.as_slice()), (Some(0), &b""[..]));
    let bare = Command::new(env!("CARGO_BIN_EXE_hangar-server")).arg("pair-context").env_clear().output().unwrap();
    assert_eq!((bare.status.code(), bare.stdout.as_slice()), (Some(0), &b""[..]));
}
