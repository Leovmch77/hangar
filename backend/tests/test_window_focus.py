import os
import subprocess
import time

import pytest

from app import procinfo, window_focus

pytestmark = pytest.mark.skipif(os.name == "nt", reason="ramo Hyprland; o do Windows e verificacao manual")


def test_without_hyprland_nothing_is_focused():
    assert window_focus.focus_tree(os.getpid(), {"PATH": os.environ["PATH"]}) is False


def test_focuses_the_window_of_a_grandchild(tmp_path):
    child = subprocess.Popen(["sh", "-c", "sleep 30 & echo $! > pid; wait"], cwd=tmp_path)
    log = tmp_path / "log"
    try:
        for _ in range(50):
            if (tmp_path / "pid").exists() and (tmp_path / "pid").read_text().strip():
                break
            time.sleep(0.05)
        grandchild = int((tmp_path / "pid").read_text())
        fake = tmp_path / "hyprctl"
        fake.write_text(
            "#!/bin/sh\n"
            f'if [ "$1" = clients ]; then echo \'[{{"pid": 1}}, {{"pid": {grandchild}}}]\'; '
            f'else echo "$@" > {log}; echo ok; fi\n')
        fake.chmod(0o755)
        procinfo._invalidar_children_map()
        env = {"PATH": f"{tmp_path}:{os.environ['PATH']}", "HYPRLAND_INSTANCE_SIGNATURE": "x"}
        assert window_focus.focus_tree(child.pid, env) is True
        assert log.read_text().strip() == f"dispatch focuswindow pid:{grandchild}"
    finally:
        child.kill()


def test_a_failure_in_the_windows_branch_falls_back_to_not_focused(monkeypatch):
    # No Linux nao ha ctypes.WinDLL: o AttributeError real do ramo Windows tem que virar False, nao 500.
    from types import SimpleNamespace
    monkeypatch.setattr(window_focus, "os", SimpleNamespace(name="nt"))
    assert window_focus.focus_tree(os.getpid(), {}) is False
