"""Pergunta que um terminal de atalho esta esperando responder.

Pergunta = a linha do cursor termina em `:` ou `?` E o programa esta parado esperando o teclado.
So a linha nao basta (log que termina em `:` com o programa rodando). No Linux "esperando o teclado"
e o processo em primeiro plano dormindo na leitura do tty; no Windows nao ha como ver isso de fora,
entao vale tela e CPU parados entre duas leituras com pelo menos 1 s de distancia (um programa que
imprime `Porta: ` e dorme vira pergunta la — ver docs/decisoes/windows.md).
"""
import os
import re
import threading
import time

from app import procinfo, tmux

_TTY_WAITS = {"wait_woken", "n_tty_read"}
_DEFAULT_RE = re.compile(r"^(?P<q>.*?)\s*\[(?P<d>[^\]]*)\]$")
_SCREEN_LINES = 6
_MIN_GAP = 1.0
# Windows: amostra (instante, tela, CPU) por alvo. Varias rotas leem a lista em threads diferentes.
_LAST: dict[str, tuple[float, str, float]] = {}
_LAST_LOCK = threading.Lock()


def parse_prompt(line: str) -> dict | None:
    text = line.rstrip()
    if not text.endswith((":", "?")):
        return None
    body = text[:-1].rstrip() if text.endswith(":") else text
    match = _DEFAULT_RE.match(body)
    question, default = (match["q"].strip(), match["d"]) if match else (body.strip(), "")
    if not question:
        return None
    return {"text": question, "default": default}


def _stat(pid) -> list[str] | None:
    # Campos depois do `(comm)`: [estado, ppid, pgrp, sessao, tty_nr, tpgid, ...]. O comm pode ter
    # espaco e parentese, por isso o corte no ULTIMO `)`.
    try:
        with open(f"/proc/{pid}/stat") as f:
            return f.read().rpartition(")")[2].split()
    except OSError:
        return None


def _reading_tty(pane_pid: int) -> bool:
    head = _stat(pane_pid)
    if not head or len(head) < 6:
        return False
    foreground = head[5]
    for pid in procinfo._descendant_pids(pane_pid):
        st = _stat(pid)
        if not st or len(st) < 6 or st[2] != foreground or st[0] != "S":
            continue
        try:
            with open(f"/proc/{pid}/wchan") as f:
                if f.read().strip() in _TTY_WAITS:
                    return True
        except OSError:
            continue
    return False


def _cpu_ms(pane_pid: int) -> float:
    import psutil
    total = 0.0
    for pid in procinfo._descendant_pids(pane_pid):
        try:
            times = psutil.Process(pid).cpu_times()
        except psutil.Error:
            continue
        total += (times.user + times.system) * 1000
    return total


def _idle_windows(target: str, pane_pid: int, screen: str) -> bool:
    now, cpu = time.monotonic(), _cpu_ms(pane_pid)
    with _LAST_LOCK:
        before = _LAST.get(target)
        if before is None or now - before[0] >= _MIN_GAP or before[1] != screen:
            _LAST[target] = (now, screen, cpu)
    if before is None or before[1] != screen:
        return False
    return now - before[0] >= _MIN_GAP and abs(cpu - before[2]) < 1.0


def forget(alive_targets: set[str]) -> None:
    """Poda amostras de terminais que sumiram."""
    with _LAST_LOCK:
        for target in [t for t in _LAST if t not in alive_targets]:
            del _LAST[target]


def pending_question(target: str, pane_pid: int | None) -> dict | None:
    if not pane_pid:
        return None
    # Linux: o /proc e barato e descarta quase tudo antes dos dois forks do tmux.
    if os.name != "nt" and not _reading_tty(pane_pid):
        return None
    cp = tmux._run(["tmux", "display", "-p", "-t", f"={target}:", "#{cursor_y}"])
    y = cp.stdout.strip()
    if cp.returncode != 0 or not y.isdigit():
        return None
    raw = tmux._run(["tmux", "capture-pane", "-p", "-t", f"={target}:"]).stdout
    screen = raw.split("\n")
    line = screen[int(y)] if int(y) < len(screen) else ""
    question = parse_prompt(line)
    if question is None:
        with _LAST_LOCK:
            _LAST.pop(target, None)
        return None
    if os.name == "nt" and not _idle_windows(target, pane_pid, raw):
        return None
    tail = [l.rstrip() for l in screen[: int(y) + 1] if l.strip()][-_SCREEN_LINES:]
    return {**question, "screen": tail}


def answer(target: str, text: str) -> bool:
    """Digita `text` e Enter no terminal. Vazio = so Enter (aceita o valor padrao). O envio vai
    pelo `tmux.send_keys`, que ja trata o `-` inicial, o `;` do psmux e o Enter como CR cru."""
    with _LAST_LOCK:
        _LAST.pop(target, None)
    if text and not tmux.send_keys(target, text, literal=True):
        return False
    return tmux.send_keys(target, "Enter") is not False
