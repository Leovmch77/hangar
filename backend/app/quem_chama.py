"""Quem é a sessão que está chamando o backend, a partir do que ela manda no cabeçalho.

O CLI (`hangar-send`/`hangar-preview`) resolve isso localmente com tmux; aqui é a mesma regra,
só que a sessão manda o que tem no ambiente e o backend faz o mapeamento inverso. Ordem:

- `X-Hangar-Key` (CP_SESSION_KEY / HANGAR_CANO_KEY): sessão sem terminal. Não muda no rename nem
  no /clear. Presente, os outros cabeçalhos são ignorados: o filho pode ter herdado TMUX_PANE do
  processo pai e anunciaria o pane de outra sessão.
- `X-Hangar-Pane` (TMUX_PANE): dono de verdade da sessão com terminal. Rename não reescreve o env
  do processo, então o nome carimbado envelhece; o pane id não. Id que aparece em mais de uma
  sessão (psmux numera por sessão) não resolve: nome errado é pior que nome ausente.
- `X-Hangar-Session` (CP_SESSION_NAME): carimbo do nascimento, só se a sessão ainda se chama
  assim.
"""

from __future__ import annotations

from typing import Mapping, Optional

from app import tmux
from app.adapters.claude_headless import sessions as headless_sessions
from app.adapters.codex import sessions as codex_sessions

CAB_CHAVE = "x-hangar-key"
CAB_PANE = "x-hangar-pane"
CAB_NOME = "x-hangar-session"

DICA = ("nenhum cabeçalho de identidade resolveu uma sessão viva — mande X-Hangar-Key "
        "(CP_SESSION_KEY), X-Hangar-Pane (TMUX_PANE) ou X-Hangar-Session (CP_SESSION_NAME)")


class SessaoDesconhecida(LookupError):
    pass


def _por_chave(chave: str) -> Optional[str]:
    for meta in headless_sessions.list_all() + codex_sessions.list_all():
        if meta.get("key") == chave and meta.get("name"):
            return meta["name"]
    return None


def _por_pane(pane: str) -> Optional[str]:
    donos = {nome for nome, panes in tmux.list_panes_all().items()
             if any(p.get("pane_id") == pane for p in panes)}
    return donos.pop() if len(donos) == 1 else None


def _por_nome(nome: str) -> Optional[str]:
    if tmux.has_session(nome) or headless_sessions.exists(nome) or codex_sessions.exists(nome):
        return nome
    return None


def resolver(cabecalhos: Mapping[str, str]) -> tuple[str, str]:
    """Devolve `(nome, origem)`; origem é `chave`, `pane` ou `nome`. Levanta SessaoDesconhecida."""
    h = {k.lower(): v.strip() for k, v in cabecalhos.items() if v and v.strip()}
    if h.get(CAB_CHAVE):
        nome = _por_chave(h[CAB_CHAVE])
        if nome:
            return nome, "chave"
        raise SessaoDesconhecida("chave de sessão sem terminal não corresponde a nenhum sidecar")
    if h.get(CAB_PANE):
        nome = _por_pane(h[CAB_PANE])
        if nome:
            return nome, "pane"
    if h.get(CAB_NOME):
        nome = _por_nome(h[CAB_NOME])
        if nome:
            return nome, "nome"
    raise SessaoDesconhecida(DICA)
