"""Pi, omp e Kimi guardam o parse em DISCO, por arquivo: restart do backend não relê nada que
não mudou. Antes eram só memória e invalidavam a árvore inteira quando um arquivo mudava."""
import json
from pathlib import Path

import pytest

from app import costs_cache as cc, costs_sources as cs, pricing


@pytest.fixture(autouse=True)
def _limpo(tmp_path, monkeypatch):
    monkeypatch.setattr(cc, "_CACHE_DIR", tmp_path / "cache")
    monkeypatch.setattr(pricing, "_CACHE_DIR", tmp_path / "pricing")
    cs.invalidar_cache()
    yield
    cs.invalidar_cache()


def _escrever(p: Path, linhas: list[dict]) -> None:
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text("\n".join(json.dumps(x) for x in linhas) + "\n", encoding="utf-8")


def _sessao_pi(p: Path, tokens: int) -> None:
    _escrever(p, [
        {"type": "session", "timestamp": "2026-08-01T10:00:00Z", "cwd": "/r"},
        {"type": "model_change", "provider": "anthropic", "modelId": "claude-opus-5"},
        {"type": "message", "message": {"usage": {"input": tokens, "output": 1,
                                                  "cacheRead": 0, "cacheWrite": 0}}},
    ])


def _wire_kimi(p: Path, tokens: int) -> None:
    _escrever(p, [{"type": "usage.record", "model": "kimi-coding/k3", "time": 1754042400000,
                   "usage": {"inputOther": tokens, "output": 1, "inputCacheRead": 0,
                             "inputCacheCreation": 0}}])


def test_pi_sobrevive_ao_restart_e_rele_so_o_arquivo_que_mudou(tmp_path, monkeypatch):
    raiz = tmp_path / "pi"
    a, b = raiz / "a.jsonl", raiz / "sub" / "b.jsonl"
    _sessao_pi(a, 10)
    _sessao_pi(b, 20)
    chamadas: list[Path] = []
    original = cs._linhas_arquivo_pi

    def contado(arq, raiz_, source):
        chamadas.append(arq)
        return original(arq, raiz_, source)

    monkeypatch.setattr(cs, "_linhas_arquivo_pi", contado)
    assert sum(r.input for r in cs.linhas_pi(raiz)) == 30
    assert sorted(chamadas) == [a, b]
    cs.invalidar_cache()  # processo novo: memória zerada, disco intacto
    chamadas.clear()
    assert sum(r.input for r in cs.linhas_pi(raiz)) == 30
    assert chamadas == []
    _sessao_pi(b, 200)
    assert sum(r.input for r in cs.linhas_pi(raiz)) == 210
    assert chamadas == [b]
    b.unlink()
    assert sum(r.input for r in cs.linhas_pi(raiz)) == 10


def test_kimi_projeto_vem_do_indice_mesmo_com_linha_cacheada(tmp_path, monkeypatch):
    home = tmp_path / ".kimi-code"
    wire = home / "sessions" / "wd" / "session_x" / "agents" / "main" / "wire.jsonl"
    _wire_kimi(wire, 5)
    monkeypatch.setattr(cs.kimi_sessions, "kimi_home", lambda: home)
    assert cs.linhas_kimi()[0].project == cs.PROJETO_DESCONHECIDO
    # O índice conhece a sessão só depois: a linha já estava em cache e ainda assim muda.
    _escrever(home / "session_index.jsonl", [{"sessionId": "session_x", "workDir": "/proj"}])
    cs.invalidar_cache()
    linhas = cs.linhas_kimi()
    assert linhas[0].project == "/proj"
    assert linhas[0].input == 5
