"""Sonda de CLIs instalados — quais binários de agente existem no PATH do shell de login.

Binário por provider é constante; o PATH é o do shell de login do usuário (quem executa o
CLI é o pane via ``$SHELL -c``, tmux.py:391), obtido via ``$SHELL -l -c 'printenv PATH'``
(com ``printenv``, nunca ``echo $PATH`` — fish separa por espaço).

Enumera TODOS os candidatos no PATH na mão (shutil.which só devolve o primeiro): arquivo
executável = instalado; existe sem permissão = tenta o próximo e, se nenhum servir,
``sem_permissao``. Não roda ``--version``: qualquer código de saída já contava como instalado, e
os cinco em série custavam segundos. Resultado cacheado por 60s (time.monotonic).
"""

from __future__ import annotations

import logging
import os
import subprocess
import threading
import time

_log = logging.getLogger("hangar")

_BIN = {"claude": "claude", "codex": "codex", "pi": "pi", "omp": "omp", "kimi": "kimi"}

# Seam para testes — monkeypatch para forjar o PATH do login (mesma técnica de procinfo.py).
# Quando não-None, _obter_path() devolve este valor (se for callable, chama).
_path_login = None  # type: ignore[assignment]

# Cache do PATH do login (uma vez por processo)
_path_cache: str | None = None

# Cache do resultado (60s)
_cache: dict[str, dict] | None = None
_cache_ts: float = 0
_TTL = 60


def _obter_path() -> str:
    global _path_cache
    # seam de teste tem precedência
    if _path_login is not None:  # type: ignore[truthy-function]
        try:
            if callable(_path_login):  # type: ignore[arg-type]
                val = _path_login()  # type: ignore[operator]
                return str(val) if val is not None else ""
            return str(_path_login)
        except Exception:
            return ""
    if _path_cache is not None:
        return _path_cache
    # Windows não tem /bin/sh nem SHELL; usa PATH direto
    if os.name == "nt":
        val = os.environ.get("PATH", "")
        _path_cache = val
        return val
    shell = os.environ.get("SHELL", "/bin/sh")
    try:
        r = subprocess.run(
            [shell, "-l", "-c", "printenv PATH"],
            capture_output=True,
            text=True,
            # Sem `encoding`, o `text=True` decodifica pelo locale — cp1252 no Windows. O PATH
            # carrega o nome do perfil do usuario, que e onde acento aparece com mais frequencia.
            encoding="utf-8",
            errors="replace",
            timeout=5,
        )
        if r.returncode == 0:
            val = r.stdout.strip()
            if val:
                _path_cache = val
                return val
    except Exception:
        # Shell de login quebrado (rc com erro) some daqui e vira "provider indisponível" sem
        # pista nenhuma pra quem for depurar.
        _log.debug("cli_probe: PATH do shell de login falhou; usando o do processo", exc_info=True)
    val = os.environ.get("PATH", "")
    _path_cache = val
    return val


# Serializa a sondagem: cada chamada roda em `to_thread`, e duas com o cache vencido ao mesmo
# tempo disparavam a varredura inteira (todos os binários × PATH, subprocess com timeout de 2s) em
# paralelo. Com o lock, a segunda espera e sai pelo cache que a primeira acabou de encher.
_sonda_lock = threading.Lock()


def sondar_providers() -> dict[str, dict]:
    global _cache, _cache_ts
    now = time.monotonic()
    if _cache is not None and (now - _cache_ts) < _TTL:
        return _cache
    with _sonda_lock:
        now = time.monotonic()
        if _cache is not None and (now - _cache_ts) < _TTL:
            return _cache
        return _sondar_sem_cache()


def _sondar_sem_cache() -> dict[str, dict]:
    global _cache, _cache_ts

    path_str = _obter_path()
    dirs = path_str.split(os.pathsep) if path_str else []

    result: dict[str, dict] = {}
    for provider, bin_name in _BIN.items():
        disponivel = False
        motivo: str | None = "nao_encontrado"
        viu_sem_permissao = False

        for d in dirs:
            if not d:
                continue
            # candidatos: no Windows tenta cada PATHEXT
            if os.name == "nt":
                pathext = os.environ.get("PATHEXT", "")
                exts = [e.strip() for e in pathext.split(";") if e.strip()] if pathext else []
                candidatos = [os.path.join(d, bin_name + ext) for ext in exts]
                candidatos.append(os.path.join(d, bin_name))
            else:
                candidatos = [os.path.join(d, bin_name)]
            for caminho in candidatos:
                if not os.path.isfile(caminho):
                    continue
                # No Windows o X_OK e sempre verdadeiro; o nome sem extensao (script sh do npm)
                # nao roda la, como antes o WinError 193 do `--version` provava.
                sem_ext = os.name == "nt" and caminho == os.path.join(d, bin_name)
                if sem_ext or not os.access(caminho, os.X_OK):
                    viu_sem_permissao = True
                    continue
                disponivel = True
                break
            if disponivel:
                break

        if not disponivel:
            motivo = "sem_permissao" if viu_sem_permissao else "nao_encontrado"
        else:
            motivo = None
        result[provider] = {"disponivel": disponivel, "motivo": motivo}

    _cache = result
    _cache_ts = time.monotonic()
    return result
