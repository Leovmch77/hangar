#!/usr/bin/env python3
# ponytail: hook minimo — le o JSON do PreToolUse no stdin e grava o payload do AskUserQuestion
# num sidecar por session_id; no PostToolUse/PostToolUseFailure apaga o da mesma chamada. SEM stdout (o bug conhecido do PreToolUse + AskUserQuestion mora
# em conflito de stdout/stdin -> nada de imprimir). Falha em silencio (nunca trava o prompt).
import json
import os
import sys
try:
    # bytes + utf-8 explicito: em modo texto o Windows decodifica com o locale (cp1252) e o
    # acento da pergunta/das opcoes chega corrompido na folha. Ver preview_hook.py.
    raw = sys.stdin.buffer.read().decode("utf-8", "replace")
    o = json.loads(raw)
    if o.get("tool_name") != "AskUserQuestion":
        sys.exit(0)
    base = os.environ.get("CLAUDE_CONFIG_DIR") or os.path.expanduser("~/.claude")
    d = os.path.join(base, ".hangar-askq")
    os.makedirs(d, exist_ok=True)
    sid = o.get("session_id") or "unknown"
    path = os.path.join(d, sid + ".json")
    if o.get("hook_event_name") in ("PostToolUse", "PostToolUseFailure"):
        # Respondida ou recusada no terminal: some só a mesma pergunta, nunca uma mais nova.
        # Sem id é de versão antiga do Claude Code, e anterior a esta chamada.
        with open(path, encoding="utf-8") as fh:
            if json.load(fh).get("tool_use_id") in (o.get("tool_use_id"), None):
                os.remove(path)
        sys.exit(0)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        fh.write(raw)
    os.replace(tmp, path)
except Exception:
    pass
sys.exit(0)
