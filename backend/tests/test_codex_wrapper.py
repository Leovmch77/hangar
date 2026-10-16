"""O wrapper do `codex` do shell (scripts/hangar-codex) com o BACKEND DESLIGADO.

O que estes testes protegem: antes, toda decisao do wrapper era uma pergunta a API local — com o
serviço parado ele nao abria nada, enquanto `claude`, `pi` e `kimi` abriam. Cada chamada deve criar uma nova sessao, mesmo quando ha outra no mesmo diretorio.

O modulo e carregado por caminho porque `scripts/hangar-codex` nao tem extensao `.py` (e um
executavel do PATH, nao um pacote).
"""
import importlib.machinery
import importlib.util
import io
import json
import os
import signal
from pathlib import Path

import pytest
from unittest.mock import patch

from app.adapters.codex import sessions as codex_sessions

_CAMINHO = Path(__file__).resolve().parents[2] / "scripts" / "hangar-codex"


def _wrapper():
    # Loader EXPLICITO: sem extensao `.py`, `spec_from_file_location` devolve None (nao acha um
    # loader pelo sufixo) e o erro sai como um AttributeError sem relacao com o que aconteceu.
    loader = importlib.machinery.SourceFileLoader("hangar_codex_wrapper", str(_CAMINHO))
    spec = importlib.util.spec_from_loader(loader.name, loader)
    mod = importlib.util.module_from_spec(spec)
    loader.exec_module(mod)
    return mod


@pytest.fixture
def w():
    return _wrapper()


@pytest.fixture(autouse=True)
def _sidecars_em_tmp(tmp_path):
    sdir = tmp_path / "codex-sessions"
    with patch.object(codex_sessions, "_dir", lambda: sdir):
        yield sdir


def _salva(nome, cwd, rollout, app_pid=None):
    codex_sessions.save(nome, f"tid-{nome}", str(rollout), cwd,
                        endpoint="ws://127.0.0.1:1", app_pid=app_pid)










def test_limpeza_sem_api_mata_o_app_server_e_apaga_o_sidecar(w, tmp_path):
    """Sem backend, era aqui que sobrava sidecar orfao mais um servidor escutando em loopback."""
    rollout = tmp_path / "a.jsonl"
    rollout.write_text("x")
    _salva("proj", "/tmp/proj", rollout, app_pid=4242)
    mortos = []

    with patch.object(w.os, "kill", lambda pid, sig: mortos.append((pid, sig))):
        w._limpar_local("proj", codex_sessions)

    assert mortos == [(4242, signal.SIGTERM)]
    assert codex_sessions.load("proj") is None


def test_limpeza_sobrevive_a_app_server_ja_morto(w, tmp_path):
    """O caso COMUM: o lancador chegou primeiro. Nao pode virar erro na saida do terminal."""
    rollout = tmp_path / "a.jsonl"
    rollout.write_text("x")
    _salva("proj", "/tmp/proj", rollout, app_pid=4242)

    def _morto(pid, sig):
        raise ProcessLookupError

    with patch.object(w.os, "kill", _morto):
        w._limpar_local("proj", codex_sessions)

    assert codex_sessions.load("proj") is None


def test_carregar_os_modulos_nao_puxa_o_pacote_dos_adapters(w, monkeypatch):
    """`from app.adapters.codex import sessions` executa `app/adapters/__init__.py`, que instancia
    os quatro adapters e puxa `app.config` -> pydantic. Este wrapper roda no `python3` do SISTEMA:
    numa maquina sem pydantic instalado ali, aquele import falharia e o wrapper voltaria a depender
    da API — que e justamente o que ele nao pode fazer. Aqui passaria por acidente (esta maquina tem
    pydantic no sistema), entao o que se afirma e o FATO que segura a garantia: o pacote nao e
    tocado."""
    import sys as _sys
    # Pelo monkeypatch, que devolve os pacotes no fim: reimportado sem eles, `app.adapters.codex`
    # nasce sem o atributo `adapter` e quebra quem roda depois neste processo.
    for nome in ("app.adapters", "app.adapters.codex"):
        monkeypatch.delitem(_sys.modules, nome, raising=False)

    sessions = w._do_backend()

    assert sessions is not None
    assert "app.adapters" not in _sys.modules
    assert callable(sessions.load)








def test_api_desembrulha_detail_do_fastapi(w, monkeypatch):
    body = json.dumps({"detail": {"code": "erro_nome_em_uso"}}).encode()
    response = w.urllib.error.HTTPError(
        "http://127.0.0.1/api/sessions", 409, "Conflict", {}, io.BytesIO(body))
    monkeypatch.setattr(w, "_env", lambda: {"CP_AUTH_TOKEN": "token"})
    monkeypatch.setattr(w.urllib.request, "urlopen",
                        lambda *_args, **_kwargs: (_ for _ in ()).throw(response))

    with pytest.raises(w.BackendHttpError) as exc:
        w._api("POST", "/api/sessions", {})

    assert exc.value.detail == {"code": "erro_nome_em_uso"}




def _hangar_open_falso(tmp_path, monkeypatch, respostas):
    """`hangar-open` falso no PATH: grava cada pedido e responde, em ordem, `(código, saída)`."""
    import sys as _sys
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir(exist_ok=True)
    (tmp_path / "respostas.json").write_text(json.dumps(respostas))
    script = bin_dir / "hangar-open"
    script.write_text(f"""#!{_sys.executable}
import json, sys
from pathlib import Path
base = Path({str(tmp_path)!r})
pedidos = base / "pedidos.jsonl"
with pedidos.open("a") as fh:
    fh.write(json.dumps(sys.argv[1:]) + "\\n")
n = len(pedidos.read_text().splitlines()) - 1
codigo, saida = json.loads((base / "respostas.json").read_text())[n]
print(saida, file=sys.stdout if codigo == 0 else sys.stderr)
sys.exit(codigo)
""")
    script.chmod(0o755)
    monkeypatch.setenv("PATH", f"{bin_dir}{os.pathsep}{os.environ['PATH']}")
    return lambda: [json.loads(l) for l in (tmp_path / "pedidos.jsonl").read_text().splitlines()]


@pytest.mark.parametrize("pane", ["fora", "vivo"])
def test_abre_pelo_hangar_open_e_nunca_cria_direto_no_tmux(w, monkeypatch, tmp_path, pane):
    # S-26: com o backend fora o `hangar-open` abre igual (spec, chave, escopo, nome livre nas três
    # lojas); o wrapper não monta mais pane próprio.
    from types import SimpleNamespace
    pedidos = _hangar_open_falso(tmp_path, monkeypatch, [[0, json.dumps({"name": tmp_path.name})]])
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(w.sys, "argv", ["hangar-codex", "revise"])
    monkeypatch.setattr(w, "_api", lambda *a, **k: (_ for _ in ()).throw(w.BackendTransportError("fora")))
    monkeypatch.delenv("CODEX_HOME", raising=False)
    if pane == "fora":
        monkeypatch.delenv("TMUX", raising=False)
        monkeypatch.delenv("TMUX_PANE", raising=False)
    else:
        monkeypatch.setenv("TMUX", "socket")
        monkeypatch.setenv("TMUX_PANE", "%42")
    chamadas = []
    real_run = w.subprocess.run

    def run(argv, **kwargs):
        if argv[:1] != ["tmux"]:
            return real_run(argv, **kwargs)
        chamadas.append(argv)
        if argv[1] == "list-panes":
            return SimpleNamespace(returncode=0 if pane == "vivo" else 1)
        if argv[1] == "has-session":
            return SimpleNamespace(returncode=1)
        return SimpleNamespace(returncode=0, stderr="")

    monkeypatch.setattr(w.subprocess, "run", run)
    assert w.main() == 0
    assert not any(c[:2] == ["tmux", "new-session"] for c in chamadas), "pane próprio fora do lançador único"
    (comando, pedido), = pedidos()
    assert comando == "open"
    assert json.loads(pedido) == {"name": tmp_path.name, "cwd": str(tmp_path), "provider": "codex",
                                  "headless": False, "initial_prompt": "revise"}
    acao = "switch-client" if pane == "vivo" else "attach-session"
    assert ["tmux", acao, "-t", f"={tmp_path.name}"] in chamadas


def test_so_nome_ocupado_repete_no_proximo_nome(w, monkeypatch, tmp_path):
    ocupado = json.dumps({"detail": {"code": "erro_nome_em_uso", "msg": "ja existe uma sessao com esse nome", "params": {}}})
    pedidos = _hangar_open_falso(tmp_path, monkeypatch, [[1, ocupado], [0, json.dumps({"name": "proj-2"})]])
    assert w._create("/tmp/proj", None) == "proj-2"
    assert [json.loads(p[1])["name"] for p in pedidos()] == ["proj", "proj-2"]


@pytest.mark.parametrize("codigo,saida", [
    (1, json.dumps({"detail": {"code": "codex_account_preparing", "msg": "conta preparando", "params": {}}})),
    (4, "hangar-open: sem CP_AUTH_TOKEN no .env do servidor"),
])
def test_outra_recusa_nao_repete(w, monkeypatch, tmp_path, codigo, saida):
    pedidos = _hangar_open_falso(tmp_path, monkeypatch, [[codigo, saida]])
    with pytest.raises(RuntimeError):
        w._create("/tmp/proj", None)
    assert len(pedidos()) == 1
