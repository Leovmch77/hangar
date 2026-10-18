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

Antes de todos, `X-Hangar-Voice`: a assistente de voz do hangar-server, que não é sessão. Vale só
com a assinatura que o Rust faz a cada chamada com o segredo interno (`<nonce>.<hmac>`); presente e
inválido é erro, sem cair nos outros.
"""

from __future__ import annotations

import hashlib
import hmac
import logging
from typing import Mapping, Optional

from app import tmux
from app.adapters.claude_headless import sessions as headless_sessions
from app.adapters.codex import sessions as codex_sessions

_log = logging.getLogger(__name__)

CAB_CHAVE = "x-hangar-key"
CAB_PANE = "x-hangar-pane"
CAB_NOME = "x-hangar-session"
VOICE_HEADER = "x-hangar-voice"
# Nome e origem de quem chama quando é a voz; nenhuma sessão é a voz.
VOICE = "voz"

DICA = ("nenhum cabeçalho de identidade resolveu uma sessão viva — mande X-Hangar-Key "
        "(CP_SESSION_KEY), X-Hangar-Pane (TMUX_PANE) ou X-Hangar-Session (CP_SESSION_NAME)")


class SessaoDesconhecida(LookupError):
    pass


def _por_chave(chave: str) -> Optional[str]:
    for meta in headless_sessions.list_all() + codex_sessions.list_all():
        if meta.get("key") == chave and meta.get("name"):
            return meta["name"]
    return None


def _registro_existe(chave: str) -> bool:
    """`~/.hangar/session-specs/<chave>.json`, que o Rust grava ao abrir (chave de 32 hex)."""
    if len(chave) != 32 or any(c not in "0123456789abcdef" for c in chave):
        return False
    from pathlib import Path
    return (Path.home() / ".hangar" / "session-specs" / f"{chave}.json").is_file()


def _por_pane(pane: str) -> Optional[str]:
    donos = {nome for nome, panes in tmux.list_panes_all().items()
             if any(p.get("pane_id") == pane for p in panes)}
    return donos.pop() if len(donos) == 1 else None


def _por_nome(nome: str) -> Optional[str]:
    if tmux.has_session(nome) or headless_sessions.exists(nome) or codex_sessions.exists(nome):
        return nome
    return None


def voice_signature_valid(value: str) -> bool:
    """`<nonce>.<hmac>` com HMAC-SHA256(segredo interno, "hangar-voice:" + nonce), a conta de
    `voice::machines::voice_signature` no Rust. Sem segredo (hangar-server fora), nada vale."""
    from app import internal_api
    secret = internal_api._secret
    nonce, _, signature = value.partition(".")
    # O valor do cabeçalho nunca vai ao log: só o motivo.
    if not secret:
        _log.warning("voice signature refused: no internal secret")
        return False
    if not nonce or not signature:
        _log.warning("voice signature refused: bad format")
        return False
    expected = hmac.new(secret.encode(), f"hangar-voice:{nonce}".encode("utf-8", "surrogatepass"), hashlib.sha256).hexdigest()
    # Bytes: `compare_digest` de str levanta TypeError com caractere fora do ASCII.
    if not hmac.compare_digest(expected.encode(), signature.encode("utf-8", "surrogatepass")):
        _log.warning("voice signature refused: mismatch")
        return False
    return True


def resolver(cabecalhos: Mapping[str, str]) -> tuple[str, str]:
    """Devolve `(nome, origem)`; origem é `voz`, `chave`, `pane` ou `nome`. Levanta SessaoDesconhecida."""
    h = {k.lower(): v.strip() for k, v in cabecalhos.items() if v and v.strip()}
    if h.get(VOICE_HEADER):
        if voice_signature_valid(h[VOICE_HEADER]):
            return VOICE, VOICE
        raise SessaoDesconhecida("assinatura da voz inválida (o hangar-server reiniciou ou não é a voz)")
    if h.get(CAB_CHAVE):
        nome = _por_chave(h[CAB_CHAVE])
        if nome:
            return nome, "chave"
        if not _registro_existe(h[CAB_CHAVE]):
            raise SessaoDesconhecida("chave de sessão sem terminal não corresponde a nenhum sidecar")
        # Sessão com terminal aberta pelo Rust: a chave mora no registro dela, sem sidecar; quem
        # diz o nome atual é o pane (o rename não muda o pane id).
    if h.get(CAB_PANE):
        nome = _por_pane(h[CAB_PANE])
        if nome:
            return nome, "pane"
    if h.get(CAB_NOME):
        nome = _por_nome(h[CAB_NOME])
        if nome:
            return nome, "nome"
    raise SessaoDesconhecida(DICA)
