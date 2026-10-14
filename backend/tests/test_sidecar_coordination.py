"""Sidecars do Claude e do Codex gravados por dois processos (Python e `hangar-server`).

O Rust grava o sidecar do Claude (`patch_meta`, cano, `/clear`) e o do Codex sob a trava
`<nome>.lock` e troca o arquivo por tmp+replace. O Python tem de segurar a mesma trava no
ler-alterar-gravar e, no Windows, esperar a troca terminar em vez de ler "sem sidecar".
"""
import fcntl
import pathlib
import threading

import pytest

from app import atomico
from app.adapters.claude_headless import sessions as claude_sessions
from app.adapters.codex import sessions as codex_sessions


@pytest.fixture
def claude_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(claude_sessions, "_dir", lambda: tmp_path / "claude-headless")
    return tmp_path / "claude-headless"


@pytest.fixture
def codex_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(codex_sessions, "_dir", lambda: tmp_path / "codex-sessions")
    return tmp_path / "codex-sessions"


def _replace_in_progress(monkeypatch, failures: int):
    """Abrir para leitura levanta o `PermissionError` do Windows nas primeiras vezes, como um leitor
    que cai no meio do `replace` de outro processo."""
    real = pathlib.Path.open
    calls = {"n": 0}

    def fake(path, mode="r", *args, **kwargs):
        if "r" in mode and path.suffix == ".json":
            calls["n"] += 1
            if calls["n"] <= failures:
                raise PermissionError(32, "O arquivo já está sendo usado por outro processo")
        return real(path, mode, *args, **kwargs)

    monkeypatch.setattr(pathlib.Path, "open", fake)
    monkeypatch.setattr(atomico.time, "sleep", lambda _s: None)
    return calls


def test_read_waits_out_a_windows_replace(monkeypatch, tmp_path):
    monkeypatch.setattr(atomico, "_E_WINDOWS", True)
    target = tmp_path / "a.json"
    target.write_bytes(b"{}")
    calls = _replace_in_progress(monkeypatch, 3)
    assert atomico.read(target) == b"{}"
    assert calls["n"] == 4


def test_read_gives_up_and_raises(monkeypatch, tmp_path):
    monkeypatch.setattr(atomico, "_E_WINDOWS", True)
    target = tmp_path / "a.json"
    target.write_bytes(b"{}")
    _replace_in_progress(monkeypatch, 10**12)
    with pytest.raises(PermissionError):
        atomico.read(target)


def test_read_never_retries_on_posix(monkeypatch, tmp_path):
    monkeypatch.setattr(atomico, "_E_WINDOWS", False)
    target = tmp_path / "a.json"
    target.write_bytes(b"{}")
    calls = _replace_in_progress(monkeypatch, 1)
    with pytest.raises(PermissionError):
        atomico.read(target)
    assert calls["n"] == 1


def test_read_does_not_wait_for_a_missing_file(monkeypatch, tmp_path):
    monkeypatch.setattr(atomico, "_E_WINDOWS", True)
    with pytest.raises(FileNotFoundError):
        atomico.read(tmp_path / "ausente.json")


@pytest.mark.parametrize("module", [claude_sessions, codex_sessions])
def test_load_during_a_windows_replace_is_not_a_missing_sidecar(module, claude_dir, codex_dir, monkeypatch):
    directory = module._dir()
    directory.mkdir(parents=True)
    (directory / "s.json").write_text('{"name": "s", "key": "k"}', encoding="utf-8")
    monkeypatch.setattr(atomico, "_E_WINDOWS", True)
    _replace_in_progress(monkeypatch, 2)
    assert module.load("s") == {"name": "s", "key": "k"}


def _hold(lock_path):
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    handle = lock_path.open("a+b")
    fcntl.flock(handle, fcntl.LOCK_EX)
    return handle


def test_claude_update_waits_for_the_other_writer(claude_dir):
    claude_sessions.save("s", "/tmp", "sid")
    handle = _hold(claude_dir / "s.lock")
    done = threading.Event()
    worker = threading.Thread(target=lambda: (claude_sessions.update("s", model="m"), done.set()))
    worker.start()
    try:
        assert not done.wait(0.3), "o update gravou sem a trava do outro escritor"
    finally:
        handle.close()
    assert done.wait(5)
    worker.join()
    assert claude_sessions.load("s")["model"] == "m"


def test_claude_update_keeps_what_the_other_writer_saved_under_the_lock(claude_dir):
    """O update relê o arquivo depois de pegar a trava: o campo gravado pelo outro lado fica."""
    claude_sessions.save("s", "/tmp", "sid")
    handle = _hold(claude_dir / "s.lock")
    worker = threading.Thread(target=lambda: claude_sessions.update("s", model="m"))
    worker.start()
    try:
        # O outro processo grava enquanto segura a trava.
        path = claude_dir / "s.json"
        import json
        meta = json.loads(path.read_text(encoding="utf-8"))
        path.write_text(json.dumps({**meta, "effort": "high"}), encoding="utf-8")
    finally:
        handle.close()
    worker.join(5)
    meta = claude_sessions.load("s")
    assert (meta["model"], meta["effort"]) == ("m", "high")


def test_claude_rename_takes_both_locks(claude_dir):
    claude_sessions.save("a", "/tmp", "sid")
    handle = _hold(claude_dir / "b.lock")
    done = threading.Event()
    worker = threading.Thread(target=lambda: (claude_sessions.rename("a", "b"), done.set()))
    worker.start()
    try:
        assert not done.wait(0.3), "o rename gravou o destino sem a trava dele"
    finally:
        handle.close()
    assert done.wait(5)
    worker.join()
    assert claude_sessions.load("b")["name"] == "b"
