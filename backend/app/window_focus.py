"""Traz pra frente a janela que um terminal No Hangar abriu. Hyprland no Linux, API de janelas no
Windows; outro ambiente nao foca, e quem clicou abre o terminal."""
import json
import os
import subprocess

from app import procinfo


def focus_tree(root: int, env: dict[str, str]) -> bool:
    tree = set(procinfo._descendant_pids(root, procinfo._varrer_children_map()))
    return _focus_windows(tree) if os.name == "nt" else _focus_hyprland(tree, env)


def _focus_hyprland(tree: set[int], env: dict[str, str]) -> bool:
    if not env.get("HYPRLAND_INSTANCE_SIGNATURE"):
        return False
    try:
        cp = subprocess.run(["hyprctl", "clients", "-j"], capture_output=True, text=True, env=env, timeout=3)
        clients = json.loads(cp.stdout or "[]")
    except (OSError, subprocess.SubprocessError, ValueError):
        return False
    pid = next((c.get("pid") for c in clients if isinstance(c, dict) and c.get("pid") in tree), None)
    if pid is None:
        return False
    try:
        cp = subprocess.run(["hyprctl", "dispatch", "focuswindow", f"pid:{pid}"],
                            capture_output=True, text=True, env=env, timeout=3)
    except (OSError, subprocess.SubprocessError):
        return False
    return cp.returncode == 0 and cp.stdout.strip() == "ok"


def _focus_windows(tree: set[int]) -> bool:
    import ctypes
    from ctypes import wintypes
    user32 = ctypes.WinDLL("user32", use_last_error=True)
    enum_proc = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    user32.EnumWindows.argtypes = [enum_proc, wintypes.LPARAM]
    user32.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
    user32.GetWindowThreadProcessId.restype = wintypes.DWORD
    user32.IsWindowVisible.argtypes = [wintypes.HWND]
    user32.GetWindowTextLengthW.argtypes = [wintypes.HWND]
    user32.ShowWindow.argtypes = [wintypes.HWND, ctypes.c_int]
    user32.SetForegroundWindow.argtypes = [wintypes.HWND]
    user32.SetForegroundWindow.restype = wintypes.BOOL
    found: list[int] = []

    @enum_proc
    def each(hwnd, _):
        pid = wintypes.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        if pid.value in tree and user32.IsWindowVisible(hwnd) and user32.GetWindowTextLengthW(hwnd):
            found.append(hwnd)
            return False
        return True

    user32.EnumWindows(each, 0)
    if not found:
        return False
    hwnd = found[0]
    user32.ShowWindow(hwnd, 9)          # SW_RESTORE: janela minimizada volta
    # O Windows so deixa trazer pra frente quem recebeu a ultima entrada. ALT segurado DURANTE o
    # pedido libera; apertado e solto antes, ele abriria o menu do app que esta na frente.
    user32.keybd_event(0x12, 0, 0, 0)
    ok = bool(user32.SetForegroundWindow(hwnd))
    user32.keybd_event(0x12, 0, 2, 0)
    return ok
