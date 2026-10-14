"""Escritas da tela única de credenciais (contas do Claude e chaves de API na mesma tabela).

A lista (`GET /api/credenciais`) é do Rust (`crates/hangar-server/src/accounts/credentials.rs`).
Aqui ficam o apelido, o cookie do OpenCode, a sincronização nos outros agentes e a remoção do
provedor que o app gravou no Kimi.

Criar, apagar ou editar a conta ou a chave em si NÃO passa por aqui: `POST/DELETE
/api/claude-configs` pra conta do Claude, `PUT/DELETE /api/engines/{nome}` pra chave. Duplicar o
caminho de escrita pra "unificar" a tela criaria dois donos do mesmo dado. O APELIDO não é de
nenhum dos dois lados: é do app.
"""
import logging

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app import agentes_sync, apelidos, engines, opencode_cota
from app.auth import require_auth
from app import engine_probe
from app.mensagens import erro

_log = logging.getLogger("hangar.credenciais")

credenciais_router = APIRouter(prefix="/api/credenciais")


class ApelidoBody(BaseModel):
    """`apelido` vazio APAGA o apelido — é o botão "voltar ao nome original" sem uma rota só pra
    isso. O id vem no corpo e não no caminho porque ele carrega `/` (o path da conta)."""

    id: str = Field(min_length=1, max_length=512)
    apelido: str = Field(default="", max_length=40)


@credenciais_router.put("/apelido", dependencies=[Depends(require_auth)])
def definir_apelido(body: ApelidoBody) -> dict:
    """Renomeia a credencial NA TELA. Não toca na pasta nem no engines.json: renomear pasta de
    conta mexeria em caminho que um CLI vivo tem aberto, e renomear motor quebraria o
    `hangar-engine --exec <nome>` das sessões que já estão rodando nele."""
    mapa = apelidos.definir(body.id, body.apelido)
    return {"id": body.id, "apelido": mapa.get(body.id)}


class CookieBody(BaseModel):
    """Cookie de sessão do painel do OpenCode. Os dois vazios APAGAM a configuração.

    Não é chave de API: é a sessão do navegador na conta, e é por isso que ela não entra no
    engines.json junto da key — arquivo à parte, 0600, e o valor nunca volta pra tela.
    """

    id: str = Field(min_length=1, max_length=512)
    workspace_id: str = Field(default="", max_length=200)
    auth_cookie: str = Field(default="", max_length=4096)


@credenciais_router.put("/cookie", dependencies=[Depends(require_auth)])
def definir_cookie(body: CookieBody) -> dict:
    """Guarda (ou apaga) o cookie do painel do OpenCode desta credencial e devolve se ficou algum.

    Devolve só o booleano de propósito: confirmar gravação não precisa do valor, e ecoá-lo poria
    a sessão do navegador no corpo de uma resposta HTTP que a tela guarda em memória.
    """
    opencode_cota.definir_config(body.id, body.workspace_id, body.auth_cookie)
    # Invalida a leitura em cache: sem isto o cookie novo só valeria no próximo ciclo de 5 min, e
    # a pessoa acabou de colar justamente pra ver o número aparecer. O cache é de quem lê a cota.
    # Extra, não a operação: com o cookie já gravado, recusar faria a pessoa colar de novo.
    from app import account_bridge
    try:
        account_bridge.request_quotas(invalidate=body.id)
    except HTTPException as error:
        _log.warning("cookie gravado, mas a cota em cache não foi invalidada: %s", error.detail)
    return {"id": body.id, "cookie_definido": body.id in opencode_cota.ler_configs()}


class SyncBody(BaseModel):
    """Grava uma credencial JÁ CADASTRADA na configuração dos outros agentes.

    Só o `id` viaja: a chave o servidor já tem (engines.json). Mandá-la de novo no corpo poria o
    segredo num request que a tela guarda em memória, sem necessidade nenhuma.
    """

    id: str = Field(min_length=1, max_length=512)
    alvos: list[str] = Field(default_factory=lambda: list(agentes_sync.ALVOS))


@credenciais_router.post("/sincronizar", dependencies=[Depends(require_auth)])
def sincronizar_nos_agentes(body: SyncBody) -> dict:
    """Escreve a credencial no Pi, no Kimi e no Codex (o Claude Code já é o engines.json).

    O nome que vai pros outros agentes é o ID do motor, não o rótulo bonito: eles têm alfabeto
    próprio pra nome de provedor, e o rótulo do usuário ("PMédico 01") seria recusado.
    """
    if not body.id.startswith("chave:"):
        raise HTTPException(400, detail=erro("erro_credencial_sem_chave",
                                             "só credencial de chave de API pode ser sincronizada"))
    nome = body.id[len("chave:"):]
    dados = engines.listar().get(nome)
    if not dados:
        raise HTTPException(404, detail=erro("erro_credencial_inexistente",
                                             f"credencial {nome} não existe", nome=nome))
    base_url, api_key = dados.get("base_url") or "", dados.get("api_key") or ""
    if not base_url or not api_key:
        raise HTTPException(409, detail=erro("erro_credencial_incompleta",
                                             "credencial sem endereço ou sem chave"))
    # Os modelos vêm do PROVEDOR, não do que está salvo: é a lista que o Pi e o Kimi precisam ter, e
    # perguntar agora é o que garante que ela reflete a chave de verdade. Falhar aqui não impede a
    # gravação — provedor sem /v1/models ainda vale como provedor cadastrado, só sem lista.
    try:
        modelos = engine_probe.listar_modelos(base_url, api_key)
    except Exception as e:                                   # noqa: BLE001 - opcional por natureza
        _log.debug("sincronizar: sem modelos para %s: %r", nome, e)
        modelos = []
    alvos = tuple(a for a in body.alvos if a in agentes_sync.ALVOS) or agentes_sync.ALVOS
    return {"id": body.id, "modelos": len(modelos),
            "resultado": agentes_sync.sincronizar(nome, base_url, api_key, modelos, alvos)}


@credenciais_router.delete("/kimi/{nome}", dependencies=[Depends(require_auth)])
def apagar_provedor_kimi(nome: str) -> dict:
    """Só o bloco que o app gravou no config do Kimi (provedor órfão de um motor já apagado).
    Provedor do usuário nunca é tocado: 404, não remoção."""
    ok, motivo = agentes_sync.remover_kimi(nome)
    if not ok:
        raise HTTPException(404 if motivo in ("nao-gerenciado", "nao-instalado") else 400,
                            detail=erro("erro_credencial_nao_gerenciada", "credencial nao gerenciada pelo app"))
    return {"ok": True}
