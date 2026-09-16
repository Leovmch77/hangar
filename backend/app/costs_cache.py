"""Cache em disco, por ARQUIVO, do resultado do parse de qualquer fonte de uso.

Nasceu no leitor de transcript do Claude e foi generalizado porque Codex, Pi, omp e Kimi
guardavam o parse só em memória: todo restart do backend pagava a varredura inteira de novo,
e Pi/Kimi reliam a árvore toda quando um arquivo mudava. Um arquivo de cache por (nome, raiz),
com a assinatura (mtime_ns, tamanho) de cada arquivo lido e as linhas já serializadas.
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import threading
from collections.abc import Callable, Iterable
from pathlib import Path
from typing import TypeVar

from app import atomico

_log = logging.getLogger(__name__)

_CACHE_DIR = Path.home() / ".claude" / ".hangar-custos"
_lock = threading.RLock()
_Estado = dict[str, tuple[tuple[int, int], list[dict]]]
_mem: dict[str, _Estado] = {}
# nome -> (lidos, total) de cada varredura da coleta corrente; é o que o 202 "aquecendo" mostra.
# Quem começa uma coleta chama `zerar_progresso()`.
progresso: dict[str, tuple[int, int]] = {}


def zerar_progresso() -> None:
    progresso.clear()

T = TypeVar("T")


def invalidar() -> None:
    with _lock:
        _mem.clear()


def caminho_cache(nome: str, raiz: Path) -> Path:
    """Um arquivo por (nome, raiz). Cache único seria apagado pela segunda conta configurada."""
    h = hashlib.sha256(str(raiz.resolve()).encode()).hexdigest()[:16]
    return _CACHE_DIR / f"{nome}-{h}.json"


def _ler(nome: str, raiz: Path, versao: int) -> _Estado:
    chave = f"{nome}:{raiz}"
    if chave in _mem:
        return _mem[chave]
    try:
        bruto = json.loads(caminho_cache(nome, raiz).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError, UnicodeDecodeError):
        bruto = None
    # Exigir dict: JSON válido do tipo errado (null, lista) não levanta ValueError.
    if not isinstance(bruto, dict) or bruto.get("versao") != versao:
        _mem[chave] = {}
        return _mem[chave]
    itens = bruto.get("itens")
    out: _Estado = {}
    if isinstance(itens, dict):
        for k, v in itens.items():
            # try por ITEM: `{"sig": ["abc", 1]}` é JSON válido e levantaria ValueError aqui,
            # fora do try do json.loads.
            try:
                sig = v["sig"]
                out[k] = ((int(sig[0]), int(sig[1])), v.get("uso"))
            except (KeyError, TypeError, ValueError, IndexError):
                continue
    _mem[chave] = out
    return out


def _gravar(nome: str, raiz: Path, estado: _Estado, versao: int) -> None:
    _CACHE_DIR.mkdir(parents=True, exist_ok=True)
    payload = {"versao": versao,
               "itens": {k: {"sig": [s[0], s[1]], "uso": u} for k, (s, u) in estado.items()}}
    destino = caminho_cache(nome, raiz)
    # pid no tmp: dois processos gravando com nome fixo fariam o rename promover bytes
    # entrelaçados.
    tmp = destino.with_suffix(f".{os.getpid()}.tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    atomico.substituir(tmp, destino)


def varrer_cacheado(nome: str, raiz: Path, arquivos: Iterable[Path],
                    ler: Callable[[Path], list[T]],
                    para_dict: Callable[[T], dict],
                    de_dict: Callable[[dict], T | None],
                    versao: int) -> list[tuple[Path, list[T]]]:
    """Linhas de cada arquivo, lendo só os que mudaram desde a última vez. Nunca vai à rede.

    Devolve pares (arquivo, linhas) porque a identidade da sessão costuma vir do caminho
    relativo, e só quem chama sabe a raiz certa pra isso.
    """
    lista = list(arquivos)
    with _lock:
        cache = _ler(nome, raiz, versao)
        novo: _Estado = {}
        out: list[tuple[Path, list[T]]] = []
        mudou = False
        # Chave com a raiz: as contas Claude compartilham o nome "transcripts", e uma
        # sobrescrevendo a outra fazia a barra andar pra trás.
        chave_progresso = f"{nome}:{raiz}"
        progresso[chave_progresso] = (0, len(lista))
        try:
            for i, p in enumerate(lista):
                progresso[chave_progresso] = (i, len(lista))
                try:
                    st = p.stat()
                except OSError:
                    continue
                chave = str(p)
                sig = (st.st_mtime_ns, st.st_size)
                hit = cache.get(chave)
                linhas: list = []
                if hit is not None and hit[0] == sig:
                    linhas = [de_dict(item) for item in hit[1]] if isinstance(hit[1], list) else [None]
                    # Entrada gravada que não desserializa é MISS: mantê-la faria a sessão sumir
                    # da conta e nunca ser relida, porque o sig continua batendo.
                    if any(item is None for item in linhas):
                        hit = None
                if hit is None or hit[0] != sig:
                    mudou = True
                    linhas = ler(p)
                    novo[chave] = (sig, [para_dict(item) for item in linhas])
                else:
                    novo[chave] = hit
                out.append((p, linhas))
        finally:
            # Fica marcado como concluído (não some): a coleta varre várias fontes em sequência
            # e a barra da tela soma todas — zerar aqui faria ela andar pra trás.
            progresso[chave_progresso] = (len(lista), len(lista))
        if len(novo) != len(cache):
            mudou = True
        if mudou:
            # Cache é otimização: falha aqui vira log, nunca 500 no /api/costs.
            try:
                _gravar(nome, raiz, novo, versao)
            except OSError as e:
                _log.warning("cache %s não pôde ser gravado: %r", nome, e)
        _mem[f"{nome}:{raiz}"] = novo
    return out


def progresso_total() -> tuple[int, int]:
    """(lidos, total) somados de todas as varreduras em andamento."""
    lidos = total = 0
    for a, b in list(progresso.values()):
        lidos += a
        total += b
    return lidos, total
