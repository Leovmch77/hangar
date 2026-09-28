"""Identidade de UMA vida da sessão: muda quando a sessão morre e renasce com o mesmo nome.

Sessão sem terminal e Codex têm chave no sidecar que sobrevive a rename e /clear; sessão tmux
só tem o horário de nascimento.
"""
from __future__ import annotations

from app import tmux
from app.adapters.claude_headless import sessions as headless_sessions
from app.adapters.codex import sessions as codex_sessions


def session_life(name: str) -> str | None:
    for meta in (headless_sessions.load(name), codex_sessions.load(name)):
        if meta and meta.get("key"):
            return f"k:{meta['key']}"
    created = tmux.session_created(name)
    return f"t:{created:.0f}" if created else None
