"""pair_hook.py: SessionStart devolve o protocolo do grupo como additionalContext."""
import json, os, subprocess, sys
from pathlib import Path

import pytest

pytestmark = pytest.mark.skipif(os.name != "posix", reason="o tmux de mentira é um script sh")

HOOK = str(Path(__file__).resolve().parent.parent / "hooks" / "pair_hook.py")


def _run(pair_dir: Path, env_extra: dict) -> str:
    # CP_SESSION_KEY: suíte rodada de dentro de uma sessão sem terminal a herdaria, e o hook
    # a honra antes do TMUX_PANE do tmux falso.
    env = {k: v for k, v in os.environ.items() if k not in ("TMUX_PANE", "CP_SESSION_NAME", "CP_SESSION_KEY")}
    env.update(env_extra)
    return subprocess.run([sys.executable, HOOK, str(pair_dir)],
                          input=json.dumps({"hook_event_name": "SessionStart", "source": "clear"}).encode(),
                          env=env, capture_output=True, timeout=10).stdout.decode()


def _fake_tmux(tmp_path: Path, panes: str, has_session_rc: int = 0) -> Path:
    # Um `tmux` de mentira no PATH: list-panes imprime a tabela dada; has-session sai com o rc dado.
    d = tmp_path / "bin"; d.mkdir()
    sh = d / "tmux"
    sh.write_text("#!/bin/sh\n"
                  f"if [ \"$1\" = list-panes ]; then printf '%s' '{panes}'; exit 0; fi\n"
                  f"if [ \"$1\" = has-session ]; then exit {has_session_rc}; fi\nexit 1\n")
    sh.chmod(0o755)
    return d


def test_sem_grupo_nao_imprime_nada(tmp_path):
    bin_ = _fake_tmux(tmp_path, "%3\tapi\n")
    out = _run(tmp_path, {"TMUX_PANE": "%3", "PATH": f"{bin_}:{os.environ['PATH']}"})
    assert out == ""


def test_com_grupo_devolve_additional_context(tmp_path):
    (tmp_path / "api.json").write_text(json.dumps({"peers": ["front"], "task": "PM-9", "gid": "g1"}))
    bin_ = _fake_tmux(tmp_path, "%3\tapi\n%4\tfront\n")
    out = _run(tmp_path, {"TMUX_PANE": "%3", "PATH": f"{bin_}:{os.environ['PATH']}"})
    d = json.loads(out)
    ctx = d["hookSpecificOutput"]["additionalContext"]
    assert d["hookSpecificOutput"]["hookEventName"] == "SessionStart"
    assert ctx.startswith("[painel: grupo de trabalho] Você, 'api', está num grupo de trabalho na tarefa: PM-9.")
    assert str(tmp_path / "grupo-g1.md") in ctx


def test_grupo_orq_reinjeta_versao_curta(tmp_path):
    (tmp_path / "api.json").write_text(json.dumps({"peers": ["front"], "task": "PM-9", "gid": "g1", "orq": True}))
    bin_ = _fake_tmux(tmp_path, "%3\tapi\n%4\tfront\n")
    out = _run(tmp_path, {"TMUX_PANE": "%3", "PATH": f"{bin_}:{os.environ['PATH']}"})
    ctx = json.loads(out)["hookSpecificOutput"]["additionalContext"]
    assert ctx.startswith("[painel: grupo de trabalho] Você está no grupo da orquestração na tarefa: PM-9.")
    assert "grupo-g1.md" not in ctx and "BRANCH" not in ctx


def test_gid_vazio_nao_cita_contrato(tmp_path):
    (tmp_path / "api.json").write_text(json.dumps({"peers": ["front"], "task": "", "gid": ""}))
    bin_ = _fake_tmux(tmp_path, "%3\tapi\n")
    out = _run(tmp_path, {"TMUX_PANE": "%3", "PATH": f"{bin_}:{os.environ['PATH']}"})
    assert "Contrato/decisões" not in json.loads(out)["hookSpecificOutput"]["additionalContext"]


def test_pane_ambiguo_cai_no_carimbo(tmp_path):
    # psmux numera pane por sessão: %1 em duas sessões -> "não sei" -> CP_SESSION_NAME (se viva).
    (tmp_path / "b.json").write_text(json.dumps({"peers": ["c"], "task": "", "gid": "g2"}))
    bin_ = _fake_tmux(tmp_path, "%1\ta\n%1\tb\n")
    out = _run(tmp_path, {"TMUX_PANE": "%1", "CP_SESSION_NAME": "b", "PATH": f"{bin_}:{os.environ['PATH']}"})
    assert "Você, 'b', está num grupo" in json.loads(out)["hookSpecificOutput"]["additionalContext"]


def test_sidecar_torto_nao_trava(tmp_path):
    (tmp_path / "api.json").write_text("{nao é json")
    bin_ = _fake_tmux(tmp_path, "%3\tapi\n")
    out = _run(tmp_path, {"TMUX_PANE": "%3", "PATH": f"{bin_}:{os.environ['PATH']}"})
    assert out == ""


def test_grupo_orq_de_um_membro_reinjeta_versao_curta(tmp_path):
    # O árbitro do orquestrar-auto nasce sozinho no grupo; depois de um /clear ele segue nele.
    (tmp_path / "arb.json").write_text(json.dumps({"peers": [], "task": "PM-9", "gid": "g1", "orq": True}))
    bin_ = _fake_tmux(tmp_path, "%3\tarb\n")
    out = _run(tmp_path, {"TMUX_PANE": "%3", "PATH": f"{bin_}:{os.environ['PATH']}"})
    ctx = json.loads(out)["hookSpecificOutput"]["additionalContext"]
    assert ctx.startswith("[painel: grupo de trabalho] Você está no grupo da orquestração na tarefa: PM-9.")


def test_sidecar_sem_peers_fora_de_orq_nao_imprime_nada(tmp_path):
    (tmp_path / "api.json").write_text(json.dumps({"peers": [], "task": "PM-9", "gid": "g1"}))
    bin_ = _fake_tmux(tmp_path, "%3\tapi\n")
    assert _run(tmp_path, {"TMUX_PANE": "%3", "PATH": f"{bin_}:{os.environ['PATH']}"}) == ""


def test_par_externo_reinjeta_protocolo_externo(tmp_path):
    (tmp_path / "api.json").write_text(json.dumps({"peers": ["pc-ana::Y"], "gid": "g1"}))
    (tmp_path / "external_pairs.json").write_text(json.dumps([{
        "share_id": "s1", "local_session": "api", "alias": "pc-ana", "peer_owner": "pc-ana",
        "peer_session": "Y", "peer_address": "https://a.ts.net:8443", "peer_token": "t", "created_at": 1.0}]))
    bin_ = _fake_tmux(tmp_path, "%3\tapi\n")
    out = _run(tmp_path, {"TMUX_PANE": "%3", "PATH": f"{bin_}:{os.environ['PATH']}"})
    ctx = json.loads(out)["hookSpecificOutput"]["additionalContext"]
    assert "[de fora: pc-ana::Y]" in ctx and "OUTRA pessoa" in ctx


def test_par_externo_de_outra_sessao_local_nao_vira_protocolo_externo(tmp_path):
    (tmp_path / "api.json").write_text(json.dumps({"peers": ["pc-ana::Y"], "gid": "g1"}))
    (tmp_path / "external_pairs.json").write_text(json.dumps([{
        "share_id": "s1", "local_session": "outra", "alias": "pc-ana", "peer_owner": "pc-ana",
        "peer_session": "Y", "peer_address": "https://a.ts.net:8443", "peer_token": "t", "created_at": 1.0}]))
    bin_ = _fake_tmux(tmp_path, "%3\tapi\n")
    out = _run(tmp_path, {"TMUX_PANE": "%3", "PATH": f"{bin_}:{os.environ['PATH']}"})
    assert "[de fora:" not in out
