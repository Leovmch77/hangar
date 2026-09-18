"""Catálogo de modelos da conta Claude sem sessão viva (`app/claude_models.py`).

Sem subir `claude` de verdade: o `Popen` é falso e devolve as linhas do stream-json. O que a suíte
trava é o que quebraria calado — casar a resposta pelo `request_id` certo (o `initialize` responde
antes e tem outro), e NÃO deixar catálogo vazio passar por catálogo (quem chama cacheia por 30
dias, e a conta ficaria presa numa lista vazia).
"""
import io
import json

import pytest

from app import claude_models


class _ProcFalso:
    def __init__(self, linhas):
        self.stdin = io.StringIO()
        self.stdout = iter(linhas)
        self.stderr = io.StringIO("stderr do claude")
        self.morto = False

    def kill(self):
        self.morto = True

    def wait(self):
        return 0


def _resposta(request_id, models):
    return json.dumps({"type": "control_response",
                       "response": {"subtype": "success", "request_id": request_id,
                                    "response": {"models": models}}}) + "\n"


@pytest.fixture(autouse=True)
def _binario_falso(monkeypatch):
    monkeypatch.setattr(claude_models, "_binario", lambda: "/falso/claude")


def _com(linhas, monkeypatch):
    proc = _ProcFalso(linhas)
    monkeypatch.setattr(claude_models.subprocess, "Popen", lambda *a, **k: proc)
    return proc


def test_le_a_resposta_do_list_models_ignorando_ruido(monkeypatch):
    proc = _com([
        "isto nao e json\n",
        json.dumps({"type": "system", "subtype": "init"}) + "\n",
        # O `initialize` responde ANTES e traz outro payload: casar por tipo em vez de por
        # request_id devolveria os `commands` dele como se fossem modelos.
        _resposta("hangar_cat_1", []),
        _resposta("hangar_cat_2", [{"value": "fable", "displayName": "Fable",
                                    "description": "Fable 5.1"}]),
    ], monkeypatch)
    assert claude_models.listar() == [{"value": "fable", "displayName": "Fable",
                                       "description": "Fable 5.1"}]
    assert proc.morto  # o processo efêmero morre mesmo no caminho feliz


def test_catalogo_vazio_estoura_em_vez_de_virar_lista(monkeypatch):
    _com([_resposta("hangar_cat_2", [])], monkeypatch)
    with pytest.raises(claude_models.ClaudeIndisponivel):
        claude_models.listar()


def test_recusa_do_claude_vira_indisponivel(monkeypatch):
    _com([json.dumps({"type": "control_response",
                      "response": {"subtype": "error", "request_id": "hangar_cat_2",
                                   "error": "nao autenticado"}}) + "\n"], monkeypatch)
    with pytest.raises(claude_models.ClaudeIndisponivel, match="nao autenticado"):
        claude_models.listar()


def test_sem_resposta_conta_o_stderr(monkeypatch):
    _com([json.dumps({"type": "system", "subtype": "init"}) + "\n"], monkeypatch)
    with pytest.raises(claude_models.ClaudeIndisponivel, match="stderr do claude"):
        claude_models.listar()


def test_para_tela_marca_o_default_quando_nao_ha_escolha():
    crus = [{"value": "default", "displayName": "Default", "description": "d",
             "resolvedModel": "claude-opus-5[1m]"},
            {"value": "haiku", "displayName": "Haiku"}]
    assert claude_models.para_tela(crus) == [
        {"id": "default", "name": "Default", "desc": "d", "active": True},
        {"id": "haiku", "name": "Haiku", "desc": "", "active": False}]
    # A escolha gravada pode ser o id resolvido, não o alias — é o que o headless grava.
    assert [m["active"] for m in claude_models.para_tela(crus, "claude-opus-5[1m]")] == [True, False]
