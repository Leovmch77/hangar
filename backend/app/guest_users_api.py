"""Rotas do dono para cadastrar convidados neste servidor, e o /api/me que a tela usa."""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app import guest_users, sse
from app.auth import require_auth
from app.mensagens import erro

router = APIRouter(dependencies=[Depends(require_auth)])

_ERROS = {
    "pasta_inexistente": (400, "erro_pasta_inexistente", "a pasta não existe"),
    "convidado_inexistente": (404, "erro_convidado_inexistente", "convidado não existe"),
    "arquivo_ilegivel": (500, "erro_convidados_ilegivel",
                         "o arquivo de convidados está ilegível; corrija-o antes de mudar convidados"),
}


def _owner_only() -> None:
    # O porteiro já barra; isto é a segunda trava caso a rota entre na lista dele por engano.
    if guest_users.current.get() is not None:
        raise HTTPException(403, detail=erro("erro_so_dono", "só o dono do servidor"))


def _falha(e: guest_users.GuestError) -> HTTPException:
    status, code, msg = _ERROS[e.reason]
    return HTTPException(status, detail=erro(code, msg))


class GuestSettings(BaseModel):
    root: str = Field(min_length=1, max_length=4096)
    sees_owner: bool = False
    owner_sees: bool = True


class NewGuest(GuestSettings):
    name: str = Field(min_length=1, max_length=100)


@router.post("/api/guests", dependencies=[Depends(_owner_only)])
def create_guest(body: NewGuest) -> dict:
    try:
        g, token = guest_users.create(body.name, body.root, body.sees_owner, body.owner_sees)
    except guest_users.GuestError as e:
        raise _falha(e) from None
    return {"id": g.id, "token": token}


def _republish_lists() -> None:
    # A lista SSE só refiltra quando a versão muda; zerar a assinatura força a próxima publicação.
    sse._list_refresher.sig = None


@router.post("/api/guests/{gid}", dependencies=[Depends(_owner_only)])
def update_guest(gid: str, body: GuestSettings) -> dict:
    try:
        g = guest_users.update(gid, body.root, body.sees_owner, body.owner_sees)
    except guest_users.GuestError as e:
        raise _falha(e) from None
    _republish_lists()
    return {"id": g.id}


@router.post("/api/guests/{gid}/delete", dependencies=[Depends(_owner_only)])
def delete_guest(gid: str) -> dict:
    try:
        guest_users.delete(gid)
    except guest_users.GuestError as e:
        raise _falha(e) from None
    _republish_lists()
    return {"ok": True}


@router.get("/api/me")
def me() -> dict:
    g = guest_users.current.get()
    return {"role": "guest", "name": g.name} if g else {"role": "owner", "name": None}
