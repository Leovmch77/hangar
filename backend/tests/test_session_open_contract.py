"""Autoteste do harness de contrato da abertura de sessão (tests/fixtures/contract/session_open_contract.py).

O lado Python inteiro roda pelo comando do README (exporta o commit fixo, fora do clone raso do CI);
aqui ficam as regras que não dependem dele.
"""
import json
import sys
from pathlib import Path

import pytest

CONTRACT = Path(__file__).parent / "fixtures" / "contract"
sys.path.insert(0, str(CONTRACT))
import session_open_contract as c  # noqa: E402
from session_open_scenarios import SCENARIOS  # noqa: E402


def test_every_scenario_has_its_fixture_and_nothing_else():
    names = {s["name"] for s in SCENARIOS}
    assert len(names) == len(SCENARIOS)
    assert {p.stem for p in c.FIXTURES.glob("*.json")} == names


@pytest.mark.parametrize("sc", SCENARIOS, ids=lambda s: s["name"])
def test_fixture_was_generated_from_the_current_scenario(sc):
    # Cenário editado sem regenerar deixaria a fixture provando outra entrada.
    fixture = json.loads(c.fixture_path(sc["name"]).read_text(encoding="utf-8"))
    assert fixture["scenario"] == sc
    assert fixture["_meta"]["source_commit"] == c.SOURCE_COMMIT


def test_normalize_maps_volatile_values_by_first_appearance():
    root = "/tmp/hso/abc123"
    key = "0123456789abcdef" * 2
    raw = {
        "_paths": {"root": root, "repo": "/src/x", "python": "/venv/bin/python"},
        "steps": [{"body": {"jsonl": f"{root}/home/p/-tmp-hso-abc123-work/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.jsonl",
                            "sock": f"unix:{root}/home/cano-{key[:16]}-9f3a.sock"}}],
        "subprocesses": [{"argv": ["/venv/bin/python", "/src/x/backend/app/cano.py", f"TOKEN={key}.{'f' * 64}"]}],
        "files": {f"{root}/home/.hangar/s.json": {"created": {"json": {"key": key, "ts": 1760000000.5, "pid": 4242,
                                                                      "made": "2026-10-15T18:50:16.293Z"}}}},
        "diary": [{"evento": "x", "ts": "t", "ms": 12, "operacao": "deadbeefdeadbeef", "pid_backend": 1}],
    }
    out = c.normalize(raw, {"name": "t"})
    assert out["steps"][0]["body"] == {"jsonl": "<ROOT>/home/p/<ROOT_SANITIZED>-work/<uuid:1>.jsonl",
                                       "sock": "unix:<ROOT>/home/cano-<hex:1>[:16]-<rand4>.sock"}
    assert out["subprocesses"][0]["argv"] == ["<PYTHON>", "<REPO>/backend/app/cano.py", "TOKEN=<hex:1>.<sha256>"]
    record = out["records"]["<ROOT>/home/.hangar/s.json"]["created"]["json"]
    assert record == {"key": "<hex:1>", "ts": "<time>", "pid": "<pid:1>", "made": "<iso>"}
    assert out["diary"] == [{"evento": "x", "ms": "<ms>", "operacao": "<op:1>"}]


def test_normalize_keeps_ids_written_in_the_scenario():
    sid = "11111111-1111-4111-8111-111111111111"
    out = c.normalize({"steps": [{"body": {"a": sid, "b": "22222222-2222-4222-8222-222222222222"}}]},
                      {"name": "t", "state": {"sid": sid}})
    assert out["steps"][0]["body"] == {"a": sid, "b": "<uuid:1>"}


def test_compare_names_every_difference_with_its_path():
    diffs = c.compare({"a": [1, {"b": "x"}], "c": 1}, {"a": [1, {"b": "y"}], "d": 2})
    assert diffs == ["$.a[1].b: esperado 'x', veio 'y'", "$.c: faltou", "$.d: sobrou 2"]


def test_rust_side_fails_loudly_naming_the_route():
    sc = next(s for s in SCENARIOS if s["name"] == "reopen_mode_terminal_to_headless")
    with pytest.raises(c.RustSideNotImplemented, match=r"Rust side not implemented for POST /api/sessions/s1/modo-execucao"):
        c.run_rust_side(sc)


def test_rust_differences_undo_each_fix_and_report_a_missing_one():
    command = ("exec env -u CLAUDE_CONFIG_DIR -u CLAUDE_CODE_SUBAGENT_MODEL -u CP_ENGINE -u CP_ENGINE_ACCOUNT "
               "claude --session-id x")
    raw = {"subprocesses": [{"prog": "tmux", "argv": ["new-session", "-s", "s1", "-e", "CP_PROVIDER=claude",
                                                      "-e", "CP_SESSION_KEY=k", "-e", "XDG_RUNTIME_DIR=/run/user/1",
                                                      command], "rc": 0}],
           "tmux_sessions": {"s1": {"env": {"CP_SESSION_KEY": "k", "XDG_RUNTIME_DIR": "/run/user/1"}, "command": command}},
           "files": {"/r/home/.hangar/session-specs/k.json": {"created": {}}},
           "diary": [{"evento": "sessao.criar_recusada", "nivel": "erro", "codigo": "terminal_nao_criado", "etapa": "criar_terminal",
                      "detalhe": "boom"}, {"evento": "sessao.criar.fim", "erro_tipo": "erro_criacao_sessao"}]}
    expected = {"diary": [{"evento": "api.servidor"}, {"evento": "sessao.criar.fim", "erro_tipo": "ValueError"}],
                "probes": [{"prog": "claude"}, {"prog": "bwrap", "argv": ["a"]}, {"prog": "bwrap", "argv": ["a"]}]}
    scenario = {"steps": [{"json": {"name": "s1"}}]}
    exp, out, missing = c.apply_rust_differences(expected, raw, scenario)
    assert missing == []
    assert out["subprocesses"][0]["argv"] == ["new-session", "-s", "s1", "-e", "CP_PROVIDER=claude",
                                              "exec env -u CLAUDE_CONFIG_DIR claude --session-id x"]
    assert out["tmux_sessions"]["s1"] == {"env": {}, "command": "exec env -u CLAUDE_CONFIG_DIR claude --session-id x"}
    assert out["files"] == {} and out["diary"][0] == {"evento": "sessao.criar_recusada", "nivel": "erro",
                                                      "detalhe": "terminal_nao_criado"}
    assert exp == {"diary": [{"evento": "sessao.criar.fim"}], "probes": [{"prog": "bwrap", "argv": ["a"]}]}
    # Sem o `env -u` do S-63 a regra acusa o conserto que faltou.
    raw["subprocesses"][0]["argv"][-1] = "exec env -u CLAUDE_CONFIG_DIR claude"
    assert any("S-63" in m for m in c.apply_rust_differences(expected, raw, scenario)[2])
