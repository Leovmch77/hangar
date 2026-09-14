"""Codex sem terminal: app-server (falso, em stdio) atrás do cano real, sem pane."""
import asyncio
import json
import os
import sys
import time
from pathlib import Path
from unittest.mock import patch

import pytest

from app import tmux
from app.adapters.codex import adapter as codex_adapter
from app.adapters.codex import sem_terminal
from app.adapters.codex import sessions as codex_sessions
from app.adapters.codex.adapter import CodexAdapter

pytestmark = pytest.mark.skipif(os.name == "nt", reason="socket unix")

# `codex app-server --stdio` de mentira: initialize (uma vez), thread/start, turn/start que pede
# aprovação de comando, thread/read.
_CODEX_FALSO = r'''#!/usr/bin/env python3
import json, sys
def out(o):
    sys.stdout.write(json.dumps(o) + "\n"); sys.stdout.flush()
iniciado = False
for linha in sys.stdin:
    ev = json.loads(linha)
    m = ev.get("method")
    if m == "initialize":
        if iniciado:
            out({"jsonrpc": "2.0", "id": ev["id"], "error": {"code": -32600, "message": "Already initialized"}})
        else:
            iniciado = True
            out({"jsonrpc": "2.0", "id": ev["id"], "result": {"userAgent": "falso"}})
    elif m == "thread/start":
        out({"jsonrpc": "2.0", "id": ev["id"], "result": {"thread": {"id": "th-1", "path": ""}, "model": "gpt-falso"}})
    elif m == "thread/resume":
        out({"jsonrpc": "2.0", "id": ev["id"], "result": {"thread": {"id": ev["params"]["threadId"]}, "model": "gpt-falso"}})
    elif m == "thread/read":
        out({"jsonrpc": "2.0", "id": ev["id"], "result": {"thread": {"id": "th-1", "turns": []}}})
    elif m == "turn/start":
        out({"jsonrpc": "2.0", "id": ev["id"], "result": {"turn": {"id": "t-1"}}})
        out({"jsonrpc": "2.0", "method": "turn/started", "params": {"threadId": "th-1", "turn": {"id": "t-1"}}})
        out({"jsonrpc": "2.0", "id": 0, "method": "item/commandExecution/requestApproval",
             "params": {"threadId": "th-1", "turnId": "t-1", "itemId": "exec-1", "command": "touch x",
                        "cwd": "/tmp", "reason": "fora do sandbox"}})
    elif m is None and ev.get("id") == 0:
        with open("decisao.txt", "w") as f:
            f.write(json.dumps(ev))
        out({"jsonrpc": "2.0", "method": "serverRequest/resolved", "params": {"threadId": "th-1", "requestId": 0}})
        out({"jsonrpc": "2.0", "id": 9, "method": "mcpServer/elicitation/request",
             "params": {"threadId": "th-1", "serverName": "x", "message": "?"}})
    elif m is None and ev.get("id") == 9:
        with open("elicitacao.txt", "w") as f:
            f.write(json.dumps(ev))
        out({"jsonrpc": "2.0", "method": "turn/completed", "params": {"threadId": "th-1", "turn": {"id": "t-1", "status": "completed"}}})
    else:
        out({"jsonrpc": "2.0", "id": ev.get("id"), "result": {}})
'''


@pytest.fixture
def ambiente(tmp_path, monkeypatch):
    binario = tmp_path / "bin"
    binario.mkdir()
    fake = binario / "codex"
    fake.write_text(_CODEX_FALSO)
    fake.chmod(0o755)
    monkeypatch.setenv("PATH", f"{binario}{os.pathsep}{os.environ['PATH']}")
    pasta = tmp_path / "codex-sessions"
    fila = tmp_path / "fila"
    fila.mkdir()
    from app import pqueue
    with patch.object(codex_sessions, "_dir", lambda: pasta), \
         patch.object(pqueue, "_queue_dir", lambda: fila), \
         patch.object(tmux, "_scope_prefix", lambda: []):
        yield tmp_path


def _sidecar(nome: str, cwd: Path) -> dict:
    codex_sessions.save(nome, None, "", str(cwd), headless=True, key=sem_terminal.nova_chave(),
                        permission_mode="Ask for approval")
    return codex_sessions.load(nome)


def test_sobe_no_cano_abre_thread_e_religa_com_aprovacao_pendente(ambiente):
    async def corpo():
        ad = CodexAdapter()
        meta = _sidecar("cx-sem-terminal", ambiente)
        client = await ad.ensure_running("cx-sem-terminal")
        assert client is not None
        meta = codex_sessions.load("cx-sem-terminal")
        assert meta["thread_id"] == "th-1" and meta["cano"]["pid"]
        assert ad._sessions["cx-sem-terminal"]["headless"] is True
        assert "cx-sem-terminal" not in ad._tmux_watchers
        # Turno que pede aprovação: o pedido fica em server_requests.
        assert await ad.send_prompt("cx-sem-terminal", "toca x") == "sent"
        for _ in range(50):
            if 0 in client.server_requests:
                break
            await asyncio.sleep(0.05)
        assert client.server_requests[0]["method"] == "item/commandExecution/requestApproval"
        # "Backend caiu": só a conexão morre; o cano e o app-server ficam.
        pid_cano = meta["cano"]["pid"]
        await client.close()
        ad._sessions.pop("cx-sem-terminal", None)
        await asyncio.sleep(0.2)
        assert Path(f"/proc/{pid_cano}").exists()
        client2 = await ad.ensure_running("cx-sem-terminal")
        assert client2 is not None and client2 is not client
        assert client2.server_requests[0]["params"]["itemId"] == "exec-1"   # veio do snapshot
        assert codex_sessions.load("cx-sem-terminal")["cano"]["pid"] == pid_cano   # mesmo cano
        # O pedido é o cartão do app; responder pelo /select fecha o turno.
        sess = ad._sessions["cx-sem-terminal"]
        ev = ad._question_state("cx-sem-terminal", sess)
        assert ev.state == "awaiting_input" and ev.headless is True
        assert ev.question.startswith("Rodar `touch x` em /tmp?") and ev.options == ["Permitir", "Negar", "Sempre permitir"]
        assert ad.aprovacao_pendente("cx-sem-terminal")[0] == ev.question
        assert await ad.select("cx-sem-terminal", 1) is True
        for _ in range(100):
            if (ambiente / "elicitacao.txt").exists() and not sess.get("in_progress"):
                break
            await asyncio.sleep(0.05)
        assert not sess.get("in_progress")
        assert json.loads((ambiente / "decisao.txt").read_text())["result"] == {"decision": "accept"}
        # O pedido que a sessão sem terminal não atende foi recusado com -32601 e virou nota no chat.
        recusa = json.loads((ambiente / "elicitacao.txt").read_text())
        assert recusa["error"]["code"] == -32601
        from app.pqueue import PromptQueue
        notas = [e for e in PromptQueue("cx-sem-terminal").load() if e.get("papel") == "assistant"]
        assert notas and "mcpServer/elicitation/request" in notas[-1]["text"]
        assert await ad.select("cx-sem-terminal", 1) is False    # nada mais pendente
        ad.close_sync("cx-sem-terminal")
        for _ in range(50):
            if not Path(f"/proc/{pid_cano}").exists():
                break
            await asyncio.sleep(0.05)
        assert not Path(f"/proc/{pid_cano}").exists()
    asyncio.run(corpo())


def test_binario_ausente_para_no_teto_de_subidas(ambiente, monkeypatch):
    monkeypatch.setenv("PATH", str(ambiente / "vazio"))

    async def corpo():
        ad = CodexAdapter()
        _sidecar("cx-sem-codex", ambiente)
        for _ in range(CodexAdapter.TETO_SUBIDAS):
            with pytest.raises(RuntimeError):
                await ad.ensure_running("cx-sem-codex")
        assert await ad.ensure_running("cx-sem-codex") is None   # desistiu, sem levantar de novo
    asyncio.run(corpo())


def test_politica_por_modo():
    assert sem_terminal.politica("Ask for approval") == ("on-request", "read-only")
    assert sem_terminal.politica("Full Access") == ("never", "danger-full-access")
    assert sem_terminal.politica(None) == ("on-request", "workspace-write")
    assert sem_terminal.politica("qualquer coisa") == sem_terminal.politica(sem_terminal.MODO_PADRAO)
    assert '-c' in sem_terminal.argv({"permission_mode": "Full Access"})
    assert 'approval_policy="never"' in sem_terminal.argv({"permission_mode": "Full Access"})
