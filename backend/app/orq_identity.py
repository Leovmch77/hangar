"""Identidade compartilhada com o orq CLI, sem carregar configuração ou adapters."""
from __future__ import annotations

import json
import os
import re
import subprocess
from pathlib import Path


class IdentityUnavailable(ValueError):
    pass


def _load_sidecar(directory: str, name: str) -> dict:
    try:
        data = json.loads((Path.home() / ".hangar" / directory / f"{name}.json").read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def _process_start(pid: int) -> float | None:
    if Path("/proc").is_dir():
        try:
            raw = (Path("/proc") / str(pid) / "stat").read_text()
            ticks = float(raw[raw.rindex(")") + 1:].split()[19])
            for line in Path("/proc/stat").read_text().splitlines():
                if line.startswith("btime "):
                    return float(line.split()[1]) + ticks / os.sysconf("SC_CLK_TCK")
        except (OSError, ValueError, IndexError):
            return None
    elif os.name == "nt":
        import ctypes
        from ctypes import wintypes

        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.OpenProcess.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
        kernel.OpenProcess.restype = wintypes.HANDLE
        kernel.GetProcessTimes.argtypes = (wintypes.HANDLE, *([ctypes.POINTER(wintypes.FILETIME)] * 4))
        kernel.GetProcessTimes.restype = wintypes.BOOL
        kernel.CloseHandle.argtypes = (wintypes.HANDLE,)
        kernel.CloseHandle.restype = wintypes.BOOL
        handle = kernel.OpenProcess(0x1000, False, pid)
        if not handle:
            return None
        times = [wintypes.FILETIME() for _ in range(4)]
        try:
            if kernel.GetProcessTimes(handle, *(ctypes.byref(t) for t in times)):
                ticks = (times[0].dwHighDateTime << 32) | times[0].dwLowDateTime
                return (ticks - 116444736000000000) / 10000000
        finally:
            kernel.CloseHandle(handle)
    return None


def identity(name: str, *, mux_bin: str = "tmux") -> str:
    """Chave do cano ou vida do multiplexador; o nome só localiza a sessão atual."""
    if not re.fullmatch(r"[A-Za-z0-9_-]+", name):
        raise IdentityUnavailable("nome de sessão inválido")
    meta_by_provider = {provider: _load_sidecar(directory, name)
                        for provider, directory in (("claude", "claude-headless"), ("codex", "codex-sessions"))}
    for provider, meta in meta_by_provider.items():
        if isinstance(meta.get("key"), str) and meta["key"]:
            return f"{provider}:{meta['key']}"
    try:
        cp = subprocess.run([mux_bin, "display-message", "-p", "-t", f"={name}",
                             "#{pid}\t#{session_id}\t#{session_created}"],
                            capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=5)
        fields = cp.stdout.strip().split("\t") if cp.returncode == 0 and "\ufffd" not in cp.stdout else []
        if len(fields) == 3 and fields[0].isdigit() and re.fullmatch(r"\$\d+", fields[1]) and fields[2].isdigit():
            started = _process_start(int(fields[0]))
            if started is not None:
                return f"tmux:{fields[0]}:{started}:{fields[1]}:{fields[2]}"
    except (OSError, subprocess.TimeoutExpired):
        pass
    # Legado sem pane: a thread é a única identidade durável disponível.
    meta = meta_by_provider["codex"]
    if isinstance(meta.get("thread_id"), str) and meta["thread_id"]:
        return f"codex-thread:{meta.get('codex_home', '')}:{meta['thread_id']}"
    raise IdentityUnavailable("não foi possível identificar o contexto atual da sessão")
