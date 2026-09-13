"""Cano da sessão sem terminal: o processo sobrevive ao cliente e o snapshot diz o que está em
aberto. O `claude` é um script falso que fala stream-json: responde initialize, e a cada prompt
pede uma permissão e só fecha o turno quando ela é respondida."""
import json
import os
import socket
import subprocess
import sys
import time
import uuid
from pathlib import Path

import pytest

CANO = Path(__file__).resolve().parents[1] / "app" / "adapters" / "claude_headless" / "cano.py"

_CLAUDE_FALSO = r'''
import json, sys
def out(o):
    sys.stdout.write(json.dumps(o) + "\n"); sys.stdout.flush()
for linha in sys.stdin:
    ev = json.loads(linha)
    t = ev.get("type")
    if t == "control_request":
        sub = ev["request"]["subtype"]
        if sub == "initialize":
            out({"type": "system", "subtype": "init", "session_id": "sid-1", "model": "haiku", "permissionMode": "default"})
        out({"type": "control_response", "response": {"subtype": "success", "request_id": ev["request_id"], "response": {}}})
    elif t == "user":
        if ev["message"]["content"][0]["text"] == "sair":
            sys.stderr.write("tchau\n"); sys.stderr.flush(); sys.exit(3)
        out({"type": "control_request", "request_id": "perm-1",
             "request": {"subtype": "can_use_tool", "tool_name": "Bash", "input": {"command": "ls"}}})
    elif t == "control_response":
        out({"type": "assistant", "message": {"content": [{"type": "text", "text": "feito"}]}})
        out({"type": "result", "subtype": "success", "usage": {"input_tokens": 1}})
sys.stderr.write("tchau\n")
'''


@pytest.fixture
def cano(tmp_path):
    if os.name == "nt":
        pytest.skip("socket unix")
    falso = tmp_path / "claude_falso.py"
    falso.write_text(_CLAUDE_FALSO, encoding="utf-8")
    sock = tmp_path / "c.sock"
    log = tmp_path / "cano.log"
    p = subprocess.Popen([sys.executable, str(CANO), "--escuta", f"unix:{sock}", "--log", str(log),
                          "--cwd", str(tmp_path), "--", sys.executable, str(falso)],
                         stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(100):
        if sock.exists():
            break
        time.sleep(0.05)
    assert sock.exists(), log.read_text() if log.exists() else "sem log"
    yield sock, p, log
    if p.poll() is None:
        p.kill()
    p.wait()


class _Cliente:
    def __init__(self, sock: Path):
        self.s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.s.connect(str(sock))
        self.s.settimeout(5)
        self.arq = self.s.makefile("rb")

    def manda(self, obj) -> None:
        self.s.sendall((json.dumps(obj) + "\n").encode())

    def le(self) -> dict:
        return json.loads(self.arq.readline())

    def le_ate(self, tipo: str) -> dict:
        while True:
            ev = self.le()
            if ev.get("type") == tipo:
                return ev

    def fecha(self) -> None:
        self.arq.close()   # o makefile segura o socket: só o close dele entrega o EOF ao cano
        self.s.close()


def test_snapshot_reconstroi_turno_aberto_e_permissao_pendente(cano):
    sock, proc, log = cano
    a = _Cliente(sock)
    snap = a.le()
    assert snap["type"] == "cano_snapshot" and snap["init"] is None and not snap["aberto"]
    a.manda({"type": "control_request", "request_id": "r1", "request": {"subtype": "initialize"}})
    assert a.le_ate("system")["subtype"] == "init"
    a.le_ate("control_response")
    a.manda({"type": "user", "message": {"role": "user", "content": [{"type": "text", "text": "oi"}]}})
    pedido = a.le_ate("control_request")
    assert pedido["request_id"] == "perm-1"
    # O backend "cai" com a permissão pendente. O claude (falso) continua vivo no cano.
    a.fecha()
    time.sleep(0.2)
    assert proc.poll() is None
    b = _Cliente(sock)
    snap = b.le()
    assert json.loads(snap["init"])["subtype"] == "init"
    assert snap["aberto"] is True
    assert [json.loads(p)["request_id"] for p in snap["pendentes"]] == ["perm-1"]
    assert snap["saiu"] is None
    # O backend novo responde a permissão pendente e o turno fecha normalmente.
    b.manda({"type": "control_response", "response": {"subtype": "success", "request_id": "perm-1",
                                                       "response": {"behavior": "allow"}}})
    assert b.le_ate("result")["subtype"] == "success"
    b.fecha()
    c = _Cliente(sock)
    snap = c.le()
    assert snap["aberto"] is False and snap["pendentes"] == []
    assert json.loads(snap["ultimo_result"])["type"] == "result"
    c.fecha()


def test_saida_do_claude_chega_ao_cliente_ligado_com_stderr(cano):
    sock, proc, log = cano
    a = _Cliente(sock)
    a.le()
    a.manda({"type": "user", "message": {"role": "user", "content": [{"type": "text", "text": "sair"}]}})
    assert a.le_ate("cano_stderr")["linha"] == "tchau"
    saiu = a.le_ate("cano_saiu")
    assert saiu["rc"] == 3 and saiu["stderr_tail"] == ["tchau"]
    a.fecha()
    proc.wait(timeout=5)     # entregou o rc: sai sozinho, sem esperar o teto, e limpa o socket
    assert not sock.exists()


def test_saida_do_claude_sem_cliente_fica_no_snapshot(cano):
    sock, proc, log = cano
    a = _Cliente(sock)
    a.le()
    a.manda({"type": "user", "message": {"role": "user", "content": [{"type": "text", "text": "sair"}]}})
    a.fecha()                # o backend caiu antes de ver a saída
    time.sleep(0.5)
    assert proc.poll() is None   # o cano espera alguém buscar o rc
    b = _Cliente(sock)
    snap = b.le()
    assert snap["saiu"] == 3 and snap["stderr_tail"] == ["tchau"]
    assert b.le()["type"] == "cano_saiu"   # e ainda manda o evento pra quem chegou depois
    b.fecha()
    proc.wait(timeout=5)


def test_token_errado_e_recusado(tmp_path):
    if os.name == "nt":
        pytest.skip("socket unix")
    falso = tmp_path / "claude_falso.py"
    falso.write_text(_CLAUDE_FALSO, encoding="utf-8")
    porta = _porta_livre()
    token = uuid.uuid4().hex
    p = subprocess.Popen([sys.executable, str(CANO), "--escuta", f"tcp:127.0.0.1:{porta}", "--token", token,
                          "--cwd", str(tmp_path), "--", sys.executable, str(falso)],
                         stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        s = _conectar_tcp(porta)
        s.sendall(b"errado\n")
        assert s.makefile("rb").readline() == b""     # fechado sem snapshot
        s = _conectar_tcp(porta)
        s.sendall((token + "\n").encode())
        assert json.loads(s.makefile("rb").readline())["type"] == "cano_snapshot"
        s.close()
    finally:
        p.kill()
        p.wait()


def test_cliente_novo_substitui_o_ligado_em_tcp(tmp_path):
    # Roda também no Windows (TCP + token). Com o accept em série, o segundo cliente não recebia
    # snapshot enquanto o primeiro seguia ligado — e quem conecta sem snapshot mata o cano.
    falso = tmp_path / "claude_falso.py"
    falso.write_text(_CLAUDE_FALSO, encoding="utf-8")
    porta, token = _porta_livre(), uuid.uuid4().hex
    p = subprocess.Popen([sys.executable, str(CANO), "--escuta", f"tcp:127.0.0.1:{porta}", "--token", token,
                          "--cwd", str(tmp_path), "--", sys.executable, str(falso)],
                         stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        a = _conectar_tcp(porta)
        a.sendall((token + "\n").encode())
        arq_a = a.makefile("rb")
        assert json.loads(arq_a.readline())["type"] == "cano_snapshot"
        b = _conectar_tcp(porta)
        b.settimeout(3)
        b.sendall((token + "\n").encode())
        arq_b = b.makefile("rb")
        assert json.loads(arq_b.readline())["type"] == "cano_snapshot"
        try:
            assert arq_a.readline() == b""        # o antigo foi desligado
        except OSError:
            pass
        b.sendall((json.dumps({"type": "control_request", "request_id": "r1",
                               "request": {"subtype": "initialize"}}) + "\n").encode())
        assert json.loads(arq_b.readline())["type"] == "system"   # o novo fala com o claude
        assert p.poll() is None
    finally:
        p.kill()
        p.wait()


def test_suite_nunca_le_os_sidecars_reais():
    from app.adapters.claude_headless import sessions
    real = Path.home() / ".hangar" / "claude-headless"
    assert sessions._dir() != real and real not in sessions._dir().parents


def _porta_livre() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _conectar_tcp(porta: int) -> socket.socket:
    for _ in range(100):
        try:
            s = socket.create_connection(("127.0.0.1", porta), timeout=2)
            s.settimeout(5)
            return s
        except OSError:
            time.sleep(0.05)
    raise AssertionError("cano não escutou")
