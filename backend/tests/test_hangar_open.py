"""`scripts/hangar-open` acha o mesmo `hangar-server` que o Supervisor sobe (`rust_bins.find_bin`)."""
import importlib.machinery
import importlib.util
import os
import shutil
from pathlib import Path

import pytest

_REPO = Path(__file__).resolve().parents[2]
_SERVER = "hangar-server" + (".exe" if os.name == "nt" else "")


@pytest.fixture
def copia(tmp_path, monkeypatch):
    """Uma cópia do Hangar com o `hangar-open` e o `rust_bins.py`, e uma casa vazia."""
    raiz = tmp_path / "copia"
    (raiz / "scripts").mkdir(parents=True)
    (raiz / "backend" / "app").mkdir(parents=True)
    shutil.copy(_REPO / "scripts" / "hangar-open", raiz / "scripts" / "hangar-open")
    shutil.copy(_REPO / "backend" / "app" / "rust_bins.py", raiz / "backend" / "app" / "rust_bins.py")
    # `Path.home()` lê o HOME no POSIX e o USERPROFILE no Windows.
    monkeypatch.setenv("HOME", str(tmp_path / "casa"))
    monkeypatch.setenv("USERPROFILE", str(tmp_path / "casa"))
    monkeypatch.setenv("PATH", str(tmp_path / "vazio"))
    monkeypatch.delenv("CP_RUST_SERVER_BIN", raising=False)
    return raiz


def _modulo(raiz: Path):
    loader = importlib.machinery.SourceFileLoader("hangar_open_teste", str(raiz / "scripts" / "hangar-open"))
    spec = importlib.util.spec_from_loader(loader.name, loader)
    mod = importlib.util.module_from_spec(spec)
    loader.exec_module(mod)
    return mod


def _binario(caminho: Path, mtime: int) -> Path:
    caminho.parent.mkdir(parents=True, exist_ok=True)
    caminho.write_text("#!/bin/sh\n")
    caminho.chmod(0o755)
    os.utime(caminho, (mtime, mtime))
    return caminho


def test_build_so_na_copia_e_achado(copia):
    build = _binario(copia / "crates" / "target" / "release" / _SERVER, 1000)
    assert _modulo(copia).server_bin() == str(build)


def test_o_mais_novo_entre_a_copia_e_o_baixado_vence(copia, tmp_path):
    _binario(copia / "crates" / "target" / "release" / _SERVER, 1000)
    baixado = _binario(tmp_path / "casa" / ".hangar" / "bin" / _SERVER, 2000)
    assert _modulo(copia).server_bin() == str(baixado)
    build = _binario(copia / "crates" / "target" / "release" / _SERVER, 3000)
    assert _modulo(copia).server_bin() == str(build)


def test_variavel_explicita_vence_e_nao_cai_para_outro(copia, monkeypatch, tmp_path):
    _binario(copia / "crates" / "target" / "release" / _SERVER, 1000)
    escolhido = _binario(tmp_path / "meu" / _SERVER, 10)
    monkeypatch.setenv("CP_RUST_SERVER_BIN", str(escolhido))
    assert _modulo(copia).server_bin() == str(escolhido)
    monkeypatch.setenv("CP_RUST_SERVER_BIN", str(tmp_path / "nao-existe"))
    assert _modulo(copia).server_bin() is None
