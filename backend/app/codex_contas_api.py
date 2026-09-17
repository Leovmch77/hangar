"""Rotas autenticadas para contas Codex e login nativo."""

from __future__ import annotations

import asyncio
import threading
import time
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, ConfigDict, Field

from app import codex_appserver, cotas
from app import codex_contas as accounts
from app.auth import require_auth
from app.mensagens import erro


codex_contas_router = APIRouter(prefix="/api/codex-contas")

_RESET_ATTEMPT_TTL_S = 86400
_reset_attempts: dict[tuple[str, str], float] = {}
_reset_attempts_lock = threading.Lock()


class CreateAccountBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str


class ConsumeResetBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    credit_id: str | None = Field(default=None, max_length=256)
    idempotency_key: UUID


class _ResetError(RuntimeError):
    def __init__(self, status: int, code: str, message: str, **params):
        super().__init__(message)
        self.status, self.code, self.message, self.params = status, code, message, params


def _tentativa_anterior(account_id: str, key: str) -> bool:
    agora = time.monotonic()
    with _reset_attempts_lock:
        for tentativa, ts in list(_reset_attempts.items()):
            if agora - ts > _RESET_ATTEMPT_TTL_S:
                _reset_attempts.pop(tentativa, None)
        return (account_id, key) in _reset_attempts


def _guardar_tentativa(account_id: str, key: str) -> None:
    with _reset_attempts_lock:
        _reset_attempts[(account_id, key)] = time.monotonic()


def _consume_reset(account: accounts.Account, body: ConsumeResetBody) -> dict:
    atual = codex_appserver.perguntar("account/rateLimits/read", codex_home=account.home)
    semanal = cotas.codex_weekly_used(atual)
    chave = str(body.idempotency_key)
    repeticao = _tentativa_anterior(account.id, chave)
    if semanal is None:
        raise _ResetError(409, "codex_reset_weekly_unavailable",
                          "não foi possível confirmar a cota semanal")
    if semanal < 100 and not repeticao:
        raise _ResetError(409, "codex_reset_weekly_not_exhausted",
                          "a cota semanal ainda não acabou", pct=round(semanal))
    redefinicoes = cotas.codex_reset_credits(atual)
    if not repeticao and (redefinicoes is None or redefinicoes.available_count < 1):
        return {"outcome": "noCredit"}
    if not repeticao:
        _guardar_tentativa(account.id, chave)
    params = {"idempotencyKey": chave}
    if body.credit_id:
        params["creditId"] = body.credit_id
    resposta = codex_appserver.perguntar(
        "account/rateLimitResetCredit/consume", codex_home=account.home, params=params)
    outcome = resposta.get("outcome")
    if outcome not in ("reset", "nothingToReset", "noCredit", "alreadyRedeemed"):
        raise _ResetError(502, "codex_reset_invalid_response",
                          "o Codex devolveu uma resposta inválida ao redefinir a cota")
    return {"outcome": outcome}


def _service(request: Request):
    try:
        return request.app.state.codex_contas_login
    except AttributeError:
        raise HTTPException(503, detail=erro("codex_account_service_unavailable",
                                             "serviço de contas Codex indisponível")) from None


def _account(account_id: str) -> accounts.Account:
    try:
        return accounts.resolve_account(account_id)
    except accounts.AccountError as exc:
        messages = {
            "codex_account_invalid_name": "nome de conta Codex inválido",
            "codex_account_not_found": "conta Codex não encontrada",
            "codex_account_invalid_marker": "conta Codex inválida",
        }
        raise HTTPException(exc.status, detail=erro(exc.code, messages.get(exc.code, "operação de conta Codex recusada"),
                                                     **exc.params)) from None


def _account_error(exc: accounts.AccountError) -> HTTPException:
    messages = {
        "codex_account_exists": "conta Codex já existe",
        "codex_account_in_use": "conta Codex está em uso",
        "codex_account_login_in_progress": "já existe login em andamento para esta conta",
        "codex_account_creation_in_progress": "já existe criação em andamento para esta conta",
        "codex_account_preparing": "a preparação da conta Codex está em andamento",
        "codex_account_prepare_required": "prepare a conta Codex antes do login",
        "codex_account_auth_storage_invalid": "a conta Codex precisa usar armazenamento em arquivo",
        "codex_login_attempt_mismatch": "a tentativa de login já mudou",
        "codex_account_default_protected": "a conta padrão do Codex não pode ser apagada",
        "codex_account_invalid_marker": "conta Codex inválida",
        "codex_account_delete_failed": "não foi possível apagar a conta Codex",
    }
    return HTTPException(exc.status, detail=erro(exc.code, messages.get(exc.code, "operação de conta Codex recusada"),
                                                  **exc.params))


@codex_contas_router.get("", dependencies=[Depends(require_auth)])
async def list_codex_accounts(request: Request) -> list[dict]:
    return await _service(request).accounts_snapshot()


@codex_contas_router.post("", status_code=201, dependencies=[Depends(require_auth)])
async def create_codex_account(body: CreateAccountBody, request: Request) -> dict:
    try:
        return await _service(request).create_account(body.name)
    except accounts.AccountError as exc:
        raise _account_error(exc) from None


@codex_contas_router.delete("/{account_id}", dependencies=[Depends(require_auth)])
async def delete_codex_account(account_id: str, request: Request) -> dict:
    account = _account(account_id)
    try:
        await _service(request).delete_account(account)
    except accounts.AccountError as exc:
        raise _account_error(exc) from None
    # Corpo JSON, nao 204: o apiFetchForServer do core sempre faz res.json().
    return {"ok": True}


@codex_contas_router.post("/{account_id}/rate-limit-reset", dependencies=[Depends(require_auth)])
async def consume_rate_limit_reset(account_id: str, body: ConsumeResetBody) -> dict:
    account = _account(account_id)
    try:
        return await asyncio.to_thread(_consume_reset, account, body)
    except _ResetError as exc:
        raise HTTPException(exc.status, detail=erro(exc.code, exc.message, **exc.params)) from None
    except (codex_appserver.CodexIndisponivel, codex_appserver.CodexRecusado,
            codex_appserver.CodexRespostaInvalida) as exc:
        raise HTTPException(502, detail=erro("codex_reset_failed",
                                             "não foi possível redefinir a cota do Codex")) from exc


@codex_contas_router.post("/{account_id}/prepare", status_code=202,
                          dependencies=[Depends(require_auth)])
async def prepare_codex_account(account_id: str, request: Request,
                                forcar: bool = Query(False)) -> dict:
    account = _account(account_id)
    try:
        return await _service(request).prepare(account, forcar=forcar)
    except accounts.AccountError as exc:
        raise _account_error(exc) from None


@codex_contas_router.get("/{account_id}/prepare", dependencies=[Depends(require_auth)])
def codex_account_preparation(account_id: str, request: Request,
                              cwd: str | None = Query(None, max_length=4096)) -> dict:
    account = _account(account_id)
    result = _service(request).preparation_status(account)
    if cwd and result.get("status") in ("ready", "partial"):
        from app.adapters.codex import sessions
        sessions.pretrust_cwd(cwd, codex_home=account.home)
    return result


@codex_contas_router.post("/{account_id}/login", dependencies=[Depends(require_auth)])
async def start_codex_login(account_id: str, request: Request) -> dict:
    account = _account(account_id)
    try:
        return await _service(request).start_login(account)
    except accounts.AccountError as exc:
        raise _account_error(exc) from None


@codex_contas_router.get("/{account_id}/login", dependencies=[Depends(require_auth)])
def codex_login_status(account_id: str, request: Request) -> dict | None:
    account = _account(account_id)
    return _service(request).login_status(account)


@codex_contas_router.delete("/{account_id}/login", dependencies=[Depends(require_auth)])
async def cancel_codex_login(account_id: str, request: Request,
                             attempt_id: str = Query(min_length=1, max_length=128)) -> dict:
    account = _account(account_id)
    try:
        return await _service(request).cancel_login(account, attempt_id)
    except accounts.AccountError as exc:
        raise _account_error(exc) from None
