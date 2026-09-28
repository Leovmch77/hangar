import json
import subprocess

import pytest

from app import share_tunnel, tunnel


class FakeTailscale:
    def __init__(self, *, funnel_cap=True, operator="jefferson", on=False):
        self.funnel_cap = funnel_cap
        self.operator = operator
        self.on = on
        self.calls: list[tuple[str, ...]] = []

    def __call__(self, *args):
        self.calls.append(args)
        out, rc = "", 0
        if args[:2] == ("status", "--json"):
            cap = {"funnel": None, "https": None} if self.funnel_cap else {"https": None}
            out = json.dumps({"Self": {"DNSName": "nb.tail1.ts.net.", "CapMap": cap}})
        elif args[:2] == ("debug", "prefs"):
            out = json.dumps({"OperatorUser": self.operator} if self.operator else {})
        elif args[:3] == ("funnel", "status", "--json"):
            out = json.dumps({"AllowFunnel": {"nb.tail1.ts.net:8443": True}} if self.on else {})
        elif args[0] == "funnel" and args[-1] == "off":
            if not self.on:
                out, rc = "error: handler does not exist", 1
            self.on = False
        elif args[0] == "funnel":
            self.on = True
        return subprocess.CompletedProcess(["tailscale", *args], rc, stdout=out, stderr="")


@pytest.fixture
def fake(monkeypatch):
    f = FakeTailscale()
    monkeypatch.setattr(share_tunnel, "_run", f)
    monkeypatch.setattr(share_tunnel.getpass, "getuser", lambda: "jefferson")
    return f


def test_host_tira_ponto_final(fake):
    assert share_tunnel.host() == "nb.tail1.ts.net"


def test_ensure_on_liga_so_a_8443_apontando_pra_porta_do_convidado(fake):
    assert share_tunnel.ensure_on() == "https://nb.tail1.ts.net:8443"
    ligar = [c for c in fake.calls if c[0] == "funnel" and c[-1] != "off" and "status" not in c]
    assert ligar == [("funnel", "--bg", "--yes", "--https=8443", "http://127.0.0.1:8766")]


def test_ensure_on_sem_operador_e_sem_funnel_diz_o_que_falta(fake):
    fake.funnel_cap = False
    fake.operator = None
    with pytest.raises(share_tunnel.TunnelError) as e:
        share_tunnel.ensure_on()
    assert e.value.missing == ["operator", "funnel"]
    assert "tailscale set --operator=" in e.value.fix
    assert not any(c[0] == "funnel" and "status" not in c for c in fake.calls)


def test_ensure_off_e_idempotente(fake):
    share_tunnel.ensure_off()
    fake.on = True
    share_tunnel.ensure_off()
    assert fake.on is False


def test_sync_so_age_na_diferenca(fake):
    share_tunnel.sync(False)
    assert not any(c[-1] == "off" for c in fake.calls)
    share_tunnel.sync(True)
    assert fake.on is True
    n = len(fake.calls)
    share_tunnel.sync(True)
    assert not any(c[0] == "funnel" and "status" not in c for c in fake.calls[n:])
    share_tunnel.sync(False)
    assert fake.on is False


def test_sync_sem_tailscale_e_nada_ativo_fica_calado(monkeypatch):
    def sem(*a):
        raise tunnel.TunnelError(500, "tailscale nao encontrado")
    monkeypatch.setattr(share_tunnel, "_run", sem)
    share_tunnel.sync(False)
    with pytest.raises(share_tunnel.TunnelError):
        share_tunnel.sync(True)
