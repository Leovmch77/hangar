"""Rotas que o convidado alcança sem token: a página do link e o resgate do código."""
import html
import socket

from fastapi import APIRouter, HTTPException
from fastapi.responses import HTMLResponse
from pydantic import BaseModel

from app import share_store, share_tunnel
from app.config import settings
from app.mensagens import erro

router = APIRouter()

_REASONS = {
    "used": ("erro_convite_usado", "este convite já foi usado"),
    "expired": ("erro_convite_vencido", "este convite venceu"),
    "revoked": ("erro_convite_revogado", "este convite foi cancelado por quem compartilhou"),
    "unknown": ("erro_convite_inexistente", "convite não encontrado"),
}

# ponytail: página em pt-BR fixa, fora do Paraglide; é a única tela servida pela porta do convite.
_PAGE = """<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>Convite do Hangar</title>
<style>body{{font-family:system-ui,sans-serif;max-width:28rem;margin:3rem auto;padding:0 1rem;
color:#1b1b1f;background:#fafafa}}@media(prefers-color-scheme:dark){{body{{color:#eee;background:#161618}}}}
a,button{{display:block;width:100%;margin:.6rem 0;padding:.8rem;border-radius:.6rem;font-size:1rem;
text-align:center;border:1px solid #888;background:transparent;color:inherit;text-decoration:none}}
.p{{background:#3b6ef5;color:#fff;border-color:#3b6ef5}}</style></head><body>{corpo}</body></html>"""


def _owner() -> str:
    return settings.server_id or socket.gethostname()


class RedeemBody(BaseModel):
    code: str
    device: str = ""


@router.get("/convite/{code}", response_class=HTMLResponse)
def invite_page(code: str):
    # GET nunca gasta o código: o WhatsApp abre o link sozinho pra montar a prévia.
    try:
        share = share_store.peek(code)
    except share_store.ShareError as e:
        corpo = f"<h1>Convite indisponível</h1><p>{html.escape(_REASONS[e.reason][1])}.</p>"
    else:
        host = share_tunnel.host()
        app_link = f"hangar://convite/{host}:{share_tunnel.FUNNEL_PORT}/{code}"
        corpo = (
            f"<h1>{html.escape(_owner())} compartilhou uma sessão</h1>"
            f"<p>Sessão <b>{html.escape(share.session)}</b>. Abra no teu Hangar para ela "
            "aparecer na tua lista.</p>"
            f'<a class="p" href="{html.escape(app_link)}">Abrir no app Hangar</a>'
            '<button onclick="navigator.clipboard.writeText(location.href);'
            "this.textContent='Convite copiado'\">Copiar convite</button>"
            "<p>No Hangar web ou no celular: Configurações → Máquinas → Colar convite.</p>")
    return HTMLResponse(_PAGE.format(corpo=corpo),
                        headers={"Cache-Control": "no-store", "Referrer-Policy": "no-referrer"})


@router.post("/api/guest/redeem")
def redeem(body: RedeemBody):
    # O endereço sai ANTES do resgate: túnel fora do ar não pode queimar um código já gasto.
    try:
        address = f"https://{share_tunnel.host()}:{share_tunnel.FUNNEL_PORT}"
    except share_tunnel.TunnelError:
        raise HTTPException(503, detail=erro("erro_sessao_indisponivel",
                                             "a sessão compartilhada está indisponível por instantes"))
    try:
        share, token = share_store.redeem(body.code, body.device)
    except share_store.ShareError as e:
        code, msg = _REASONS[e.reason]
        raise HTTPException(404 if e.reason == "unknown" else 410,
                            detail=erro(code, msg, reason=e.reason))
    return {"token": token, "session": share.session, "owner": _owner(), "address": address}
