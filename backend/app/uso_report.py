"""Agregação do relatório de uso (skills, tools, Bash, MCP, agentes, contexto, imagens, plugins).

Quem lê é o `uso_claude` (dentro da passada do `costs_claude_transcript`); quem sabe preço é
o `pricing` via `costs._custo_da_linha`. Aqui só se soma e se corta por período e filtros.
"""
from __future__ import annotations

import logging
import os
import threading
import time
from collections import defaultdict
from collections.abc import Iterable, Iterator
from dataclasses import fields
from datetime import datetime, timedelta
from pathlib import Path

from app import costs, costs_cache, costs_sources, pricing
from app.costs_sources import LOCAL, PROJETO_DESCONHECIDO, UsageRow, rotulo_de_provedor
from app.models import Applied, UsoBucket, UsoReport
from app.uso_claude import UsoLinha, plugin_de, skill_do_caminho

_REPO = Path(__file__).resolve().parents[2]
_log = logging.getLogger("hangar.uso")

# Grupo de skill sem prefixo de plugin. `@` não existe em nome de plugin: a tela traduz.
ORIGEM_REPO = "@repo"
ORIGEM_PESSOAL = "@pessoal"
ORIGEM_AVULSA = "@avulsa"
ORIGEM_EMBUTIDA = "@embutida"


def _origem_da_pasta(pasta: Path, home: Path) -> str:
    real = Path(os.path.realpath(pasta))
    if real.is_relative_to(_REPO / "skills"):
        return ORIGEM_REPO
    plugin = plugin_de((skill_do_caminho(str(real / "SKILL.md")) or ("", True))[0])
    if plugin:
        return plugin
    if real.is_relative_to(Path(os.path.realpath(home / ".agents" / "skills"))):
        return ORIGEM_AVULSA
    return ORIGEM_PESSOAL


def _skill_roots(home: Path) -> tuple[list[Path], list[Path]]:
    """(rasas: uma skill por filha, fundas: SKILL.md em qualquer nível)."""
    return ([home / ".claude" / "skills", _REPO / "skills", home / ".agents" / "skills"],
            [home / ".claude" / "plugins" / "cache", home / ".codex" / "plugins" / "cache",
             home / ".claude" / "plugins" / "marketplaces"])


def origens_de_skill(home: Path | None = None) -> dict[str, str]:
    """nome da skill -> grupo. Mesma precedência de descoberta do Claude: pasta do usuário, repo,
    avulsas, depois o cache de plugins (onde o Codex acha `brainstorming` sem prefixo).
    Nome que não está em pasta nenhuma é embutido no CLI ou já foi removido."""
    home = home or Path.home()
    rasas, fundas = _skill_roots(home)
    achadas: dict[str, str] = {}
    for raiz in rasas + fundas:
        # Pasta ilegível perde só as skills dela; o relatório inteiro não cai por isso.
        try:
            if raiz in rasas:
                pastas = [s for s in sorted(raiz.iterdir()) if (s / "SKILL.md").is_file()] if raiz.is_dir() else []
            else:
                pastas = [md.parent for md in sorted(raiz.rglob("SKILL.md")) if "skills" in md.parts] if raiz.is_dir() else []
            for pasta in pastas:
                achadas.setdefault(pasta.name, _origem_da_pasta(pasta, home))
        except OSError as e:
            _log.warning("uso: origem das skills em %s não lida: %s", raiz, e)
    return achadas

# chars/4 é a régua de "tokens estimados": a tela SEMPRE rotula como estimativa.
_CHARS_POR_TOKEN = 4
_MARCA_SUBAGENTE = "/subagents/agent-"
# `bash`/`mcp` repetem a chamada de `tool`: nos totais cada chamada conta uma vez só.
_TIPOS_CONTADOS = ("tool", "skill", "agente", "contexto", "imagem")


# Texto de skill: medido contra o cache write real das respostas (regressão em 196 cargas,
# correlação 0,996). chars/4 subestimava 60%. Os demais contextos seguem chars/4 (não medidos).
_CHARS_POR_TOKEN_SKILL = 2.5


def _zero() -> dict:
    return {"sessions": set(), "subs": set(), "chamadas": 0, "pedidas": 0, "ctx_chars": 0, "tokens_est": 0,
            "input": 0, "output": 0, "cache_write": 0, "cache_read": 0, "cost": 0.0,
            "cost_input": 0.0, "cost_output": 0.0, "cost_cache_write": 0.0,
            "cost_cache_read": 0.0, "plugin": "",
            "ocupados": 0, "ocupados_eq": 0, "respostas": 0, "regua": _CHARS_POR_TOKEN}


# As linhas chegam como tupla na ordem dos campos de `UsoLinha` (a do índice + `conta`): o
# relatório passa por todas elas, e montar um objeto por linha custava tanto quanto somar.
FIELDS = tuple(f.name for f in fields(UsoLinha))
(DIA, CWD, MODEL, TIPO, NOME, PLUGIN, DETALHE, ORIGEM, CHAMADAS, CTX_CHARS, TOKENS_EST, INPUT,
 OUTPUT, CACHE_WRITE, CACHE_READ, CACHE_WRITE_1H, FAST, OCUPADOS, RESPOSTAS, OCUPADOS_EQ, FONTE,
 SUBAGENTE, SESSION_ID, CONTA) = map(FIELDS.index, (
    "dia", "cwd", "model", "tipo", "nome", "plugin", "detalhe", "origem", "chamadas", "ctx_chars",
    "tokens_est", "input", "output", "cache_write", "cache_read", "cache_write_1h", "fast",
    "ocupados", "respostas", "ocupados_eq", "fonte", "subagente", "session_id", "conta"))
_TOKEN_FIELDS = (("input", INPUT), ("output", OUTPUT), ("cache_write", CACHE_WRITE),
             ("cache_read", CACHE_READ))
_AGENT_COST_FIELDS = ("cost_input", "cost_output", "cost_cache_write", "cost_cache_read")


def _as_tuples(uso: Iterable) -> Iterator[tuple]:
    """Aceita `UsoLinha` (testes, chamadores antigos) ou a tupla já pronta do índice."""
    for l in uso:
        yield l if isinstance(l, tuple) else tuple(getattr(l, c) for c in FIELDS)


def _sessao(b: dict, t: tuple) -> None:
    (b["subs"] if t[SUBAGENTE] else b["sessions"]).add(t[SESSION_ID])


def _custos_reais(t: tuple) -> dict[str, float]:
    if not (t[INPUT] or t[OUTPUT] or t[CACHE_WRITE] or t[CACHE_READ]):
        return {}
    c = costs._custo_da_linha(UsageRow(
        ts=datetime.fromisoformat(t[DIA]).replace(tzinfo=LOCAL), source=t[FONTE],
        provider="openai" if t[FONTE] == "codex" else "anthropic", model=t[MODEL], project=t[CWD],
        session_id=t[SESSION_ID],
        input=t[INPUT], output=t[OUTPUT], cache_write=t[CACHE_WRITE], cache_read=t[CACHE_READ],
        cache_write_1h=t[CACHE_WRITE_1H], fast=bool(t[FAST])))
    return c or {}


def _custo_dos_agentes(tokens: list[UsageRow]) -> dict[str, dict]:
    """agentId -> tokens e custo do transcript filho (`…/subagents/agent-<id>`)."""
    out: dict[str, dict] = defaultdict(lambda: {"input": 0, "output": 0, "cache_write": 0,
                                                "cache_read": 0, "cost": 0.0,
                                                "cost_input": 0.0, "cost_output": 0.0,
                                                "cost_cache_write": 0.0, "cost_cache_read": 0.0})
    for r in tokens:
        if _MARCA_SUBAGENTE not in r.session_id:
            continue
        agent_id = r.session_id.rsplit("agent-", 1)[1]
        a = out[agent_id]
        a["input"] += r.input
        a["output"] += r.output
        a["cache_write"] += r.cache_write
        a["cache_read"] += r.cache_read
        c = costs._custo_da_linha(r)
        if c:
            a["cost"] += sum(c.values())
            for k, v in c.items():
                a[f"cost_{k}"] += v
    return out


_NO_COST = (0.0, ())


def _row_cost(t: tuple, split: dict[str, float], cost: float,
             agentes: dict[str, dict]) -> tuple[float, tuple]:
    """(custo, ((campo cost_*, valor), …)) que a linha soma num conjunto; calculada uma vez
    por linha e reaproveitada em todos os conjuntos em que ela entra."""
    tipo = t[TIPO]
    if tipo == "skill":
        return cost, tuple((f"cost_{k}", v) for k, v in split.items())
    if tipo == "agente" and t[DETALHE]:
        a = agentes.get(t[DETALHE])
        return (a["cost"], tuple((k, a[k]) for k in _AGENT_COST_FIELDS)) if a else _NO_COST
    return _NO_COST


def _bucket(key: str, v: dict) -> UsoBucket:
    return UsoBucket(key=key, plugin=v["plugin"], sessions=len(v["sessions"]), subagentes=len(v["subs"]),
                     chamadas=v["chamadas"], pedidas=v["pedidas"], ctx_chars=v["ctx_chars"],
                     ctx_tokens_est=int(v["ctx_chars"] / v["regua"]) + v["tokens_est"],
                     input=v["input"], output=v["output"], cache_write=v["cache_write"],
                     cache_read=v["cache_read"], cost=v["cost"],
                     cost_input=v["cost_input"], cost_output=v["cost_output"],
                     cost_cache_write=v["cost_cache_write"], cost_cache_read=v["cost_cache_read"],
                     ocupados_tokens_est=int(v["ocupados"] / _CHARS_POR_TOKEN_SKILL),
                     ocupados_eq_tokens_est=int(v["ocupados_eq"] / _CHARS_POR_TOKEN_SKILL),
                     respostas=v["respostas"])


def _ordenar(agg: dict[str, dict]) -> list[UsoBucket]:
    return sorted((_bucket(k, v) for k, v in agg.items()),
                  key=lambda b: (-b.ocupados_eq_tokens_est, -b.ocupados_tokens_est, -b.cost, -b.ctx_chars, -b.chamadas, b.key))


def _conta_no_total(tipo: str, nome: str) -> bool:
    """`bash`/`mcp` repetem a chamada de `tool`; `tool:Skill` e `tool:Agent` repetem a linha
    de `skill`/`agente`. Cada chamada entra uma vez."""
    if tipo == "tool":
        return nome not in ("Skill", "Agent")
    return tipo in _TIPOS_CONTADOS


def _somar_em(bs: Iterable[dict], t: tuple, share: tuple[float, tuple],
              agentes: dict[str, dict], do_item: bool = False) -> None:
    """Soma a linha em cada conjunto de `bs` (a linha é decifrada uma vez só). Tokens reais do
    conjunto vêm das linhas de ÁREA, que somadas dão todo o uso do Claude sem repetição;
    `do_item` (série de uma skill/agente) soma os tokens do próprio item."""
    sessions_key = "subs" if t[SUBAGENTE] else "sessions"
    sid, tipo = t[SESSION_ID], t[TIPO]
    if tipo == "area":
        for b in bs:
            b[sessions_key].add(sid)
            if not do_item:
                b["input"] += t[INPUT]
                b["output"] += t[OUTPUT]
                b["cache_write"] += t[CACHE_WRITE]
                b["cache_read"] += t[CACHE_READ]
        return
    counted = _conta_no_total(tipo, t[NOME])
    # Contexto injetado (instruções, lembretes, hooks) é ocorrência, não chamada.
    calls = t[CHAMADAS] if counted and tipo != "contexto" else 0
    chars, est = (t[CTX_CHARS], t[TOKENS_EST]) if counted else (0, 0)
    cost, cost_fields = share
    for b in bs:
        b[sessions_key].add(sid)
        b["chamadas"] += calls
        b["ctx_chars"] += chars
        b["tokens_est"] += est
        b["cost"] += cost
        for k, v in cost_fields:
            b[k] += v
        if do_item:
            b["ocupados"] += t[OCUPADOS]
            b["ocupados_eq"] += t[OCUPADOS_EQ]
            b["respostas"] += t[RESPOSTAS]
            if tipo == "agente" and t[DETALHE]:
                a = agentes.get(t[DETALHE])
                for k, _i in _TOKEN_FIELDS if a else ():
                    b[k] += a[k]
            elif tipo == "skill":
                for k, i in _TOKEN_FIELDS:
                    b[k] += t[i]


def _dimension(agg: dict[str, dict], rotulo=None) -> list[UsoBucket]:
    out = []
    for k, v in agg.items():
        b = _bucket(k, v)
        if rotulo:
            b.label = rotulo(k)
        out.append(b)
    return sorted(out, key=lambda b: (-_tokens(b), -b.chamadas, b.key))


def _tokens(b: UsoBucket) -> int:
    return b.input + b.output + b.cache_write + b.cache_read


def _por_dia(agg: dict[str, dict]) -> list[UsoBucket]:
    return sorted((_bucket(k, v) for k, v in agg.items()), key=lambda b: b.key)


def _somar_area(b: dict, t: tuple, cost: float) -> None:
    (b["subs"] if t[SUBAGENTE] else b["sessions"]).add(t[SESSION_ID])
    b["chamadas"] += t[CHAMADAS]
    for k, i in _TOKEN_FIELDS:
        b[k] += t[i]
    b["cost"] += cost


Filtro = str | list[str] | None


def _lista(v: Filtro) -> list[str]:
    """Um filtro aceita um valor ou vários; vazio = todos."""
    if not v:
        return []
    return [v] if isinstance(v, str) else [x for x in v if x]


_AGENT_SUMS = ("input", "output", "cache_write", "cache_read", "cost", *_AGENT_COST_FIELDS)


def montar(uso: Iterable, tokens: list[UsageRow], period: str = "all",
           now: datetime | None = None, conta: Filtro = None,
           projeto: Filtro = None, modelo: Filtro = None,
           plugin: Filtro = None, foco: str | None = None,
           origens: dict[str, str] | None = None) -> UsoReport:
    """`uso`: lista de `UsoLinha`/tuplas, ou iterador de tuplas na ordem de `FIELDS`
    (`costs_cache.iter_usage_rows`), percorrido UMA vez. Cada conjunto recebe as linhas na mesma
    ordem de sempre: a soma em ponto flutuante não muda."""
    contas, projetos, modelos, plugins_f = _lista(conta), _lista(projeto), _lista(modelo), _lista(plugin)
    now = now or datetime.now(LOCAL)
    dias = costs.PERIODOS.get(period)
    corte = None
    if dias:
        corte = (now - timedelta(days=dias - 1)).date()
        tokens = [r for r in tokens if r.ts.date() >= corte]
        corte = corte.isoformat()
    agents_all = agentes = _custo_dos_agentes(tokens)
    # O custo do agente vem do transcript filho, que tem conta e projeto próprios: o filtro
    # vale pra ele também (o filho de outra conta não entra na soma desta).
    if contas or projetos:
        agentes = _custo_dos_agentes([
            r for r in tokens
            if (not contas or r.account_id in contas)
            and (not projetos or (r.project or PROJETO_DESCONHECIDO) in projetos)])

    # Seletores (conta/projeto/modelo) vêm do PERÍODO inteiro, antes dos filtros de dimensão,
    # senão a opção escolhida sumiria do próprio seletor.
    por_conta: dict[str, dict] = defaultdict(_zero)
    por_projeto: dict[str, dict] = defaultdict(_zero)
    por_modelo: dict[str, dict] = defaultdict(_zero)
    por_tipo: dict[str, dict[str, dict]] = defaultdict(lambda: defaultdict(_zero))
    plugins: dict[str, dict] = defaultdict(_zero)
    por_dia: dict[str, dict] = defaultdict(_zero)
    por_area_dia: dict[str, dict] = defaultdict(_zero)
    total = _zero()
    serie: list[tuple] = []
    for t in _as_tuples(uso) if isinstance(uso, list) else uso:
        dia = t[DIA]
        if corte is not None and not (dia and dia >= corte):
            continue
        tipo, nome, row_plugin = t[TIPO], t[NOME], t[PLUGIN]
        if not row_plugin:
            if tipo == "skill" and origens is not None:
                row_plugin = origens.get(nome, ORIGEM_EMBUTIDA)
            elif tipo == "agente":
                row_plugin = plugin_de(nome)
        split = _custos_reais(t) if tipo in ("skill", "area") else {}
        cost = sum(split.values())
        share = _row_cost(t, split, cost, agents_all)
        row_project = t[CWD] or PROJETO_DESCONHECIDO
        row_model = pricing.canonizar(t[MODEL]) or "?"
        buckets = [por_conta[t[CONTA]], por_projeto[row_project], por_modelo[row_model]]
        if ((contas and t[CONTA] not in contas) or (projetos and row_project not in projetos)
                or (modelos and row_model not in modelos) or (plugins_f and row_plugin not in plugins_f)):
            _somar_em(buckets, t, share, agents_all)
            continue
        # Total e série somam com o custo de agente já filtrado; igual ao dos seletores quando
        # não há filtro de conta/projeto, e aí vão todos numa chamada só.
        if agentes is agents_all:
            buckets.append(total)
            if not foco and dia:
                buckets.append(por_dia[dia])
        else:
            _somar_em(buckets, t, share, agents_all)
            share = _row_cost(t, split, cost, agentes)
            buckets = [total, por_dia[dia]] if not foco and dia else [total]
        _somar_em(buckets, t, share, agentes)

        b = por_tipo[tipo][nome]
        b["plugin"] = b["plugin"] or row_plugin
        _sessao(b, t)
        b["chamadas"] += t[CHAMADAS]
        b["ctx_chars"] += t[CTX_CHARS]
        b["tokens_est"] += t[TOKENS_EST]
        if t[ORIGEM] in ("voce", "pedido"):
            b["pedidas"] += t[CHAMADAS]
        if tipo == "skill":
            b["regua"] = _CHARS_POR_TOKEN_SKILL
            b["ocupados"] += t[OCUPADOS]
            b["ocupados_eq"] += t[OCUPADOS_EQ]
            b["respostas"] += t[RESPOSTAS]
        if tipo in ("skill", "area"):
            for k, i in _TOKEN_FIELDS:
                b[k] += t[i]
            b["cost"] += cost
            if tipo == "skill":
                for k, v in split.items():
                    b[f"cost_{k}"] += v
        elif tipo == "agente" and t[DETALHE]:
            a = agentes.get(t[DETALHE])
            if a:
                for k in _AGENT_SUMS:
                    b[k] += a[k]
        if row_plugin and tipo in ("skill", "contexto", "agente"):
            p = plugins[row_plugin]
            p["plugin"] = row_plugin
            _sessao(p, t)
            p["chamadas"] += t[CHAMADAS]
            p["ctx_chars"] += t[CTX_CHARS]
            p["ocupados"] += t[OCUPADOS]
            p["ocupados_eq"] += t[OCUPADOS_EQ]
            p["respostas"] += t[RESPOSTAS]
            if tipo == "skill":
                for k, i in _TOKEN_FIELDS:
                    p[k] += t[i]
                p["cost"] += cost
                for k, v in split.items():
                    p[f"cost_{k}"] += v
            elif tipo == "agente" and t[DETALHE]:
                a = agentes.get(t[DETALHE])
                if a:
                    for k in _AGENT_SUMS:
                        p[k] += a[k]
        if tipo == "area" and dia:
            _somar_area(por_area_dia[f"{dia}|{nome}"], t, cost)
        # Série diária com `foco`: só do item de nome igual (qualquer tipo) — é o clique numa
        # linha da tabela. Sem `foco`, ela já entrou junto com o total.
        if foco and nome == foco:
            serie.append((t, cost, share))

    if foco and por_tipo["area"].get(foco):
        for t, cost, _s in serie:
            if t[TIPO] == "area" and t[DIA]:
                _somar_area(por_dia[t[DIA]], t, cost)
    else:
        for t, _c, share in serie:
            if t[DIA]:
                _somar_em((por_dia[t[DIA]],), t, share, agentes, do_item=True)
    by_day = _por_dia(por_dia)
    by_area_dia = _por_dia(por_area_dia)
    for b in by_area_dia:
        b.label = b.key.split("|", 1)[1]

    return UsoReport(
        totals=_bucket("totals", total),
        by_skill=_ordenar(por_tipo["skill"]),
        by_tool=_ordenar(por_tipo["tool"]),
        by_bash=_ordenar(por_tipo["bash"]),
        by_mcp=_ordenar(por_tipo["mcp"]),
        by_agente=_ordenar(por_tipo["agente"]),
        by_contexto=_ordenar(por_tipo["contexto"]),
        by_imagem=_ordenar(por_tipo["imagem"]),
        by_plugin=_ordenar(plugins),
        by_conta=_dimension(por_conta, rotulo_de_provedor),
        by_projeto=_dimension(por_projeto),
        by_modelo=_dimension(por_modelo),
        by_area=_ordenar(por_tipo["area"]),
        by_area_dia=by_area_dia,
        by_day=by_day,
        applied=Applied(period=period),
        conta=contas, projeto=projetos, modelo=modelos, plugin=plugins_f, foco=foco or None,
        usd_brl=costs.usd_brl(),
    )


def report(period: str = "all", now: datetime | None = None, fresco: bool = False,
           **filtros) -> UsoReport:
    """Levanta `costs_sources.Aquecendo` enquanto a primeira coleta da subida não terminou.
    `filtros`: conta, projeto, modelo, plugin, foco (ver `montar`)."""
    now = now or datetime.now(LOCAL)
    dias = costs.PERIODOS.get(period)
    desde = (now - timedelta(days=dias - 1)).strftime("%Y-%m-%d") if dias else None
    costs_sources.preparar(fresco)
    # Um retrato só: a thread de refresh troca o global entre montar e chavear.
    origens_em, origens = _origens_recentes()
    chave = ("uso", period, now.date(), pricing.geracao(), costs.chave_rotulos(), origens_em,
             *((k, tuple(v) if isinstance(v, list) else v) for k, v in sorted(filtros.items())))
    pronto = costs_cache.relatorio(
        chave, lambda: montar(*costs_sources._ler_uso(desde), period=period, now=now,
                              origens=origens, **filtros))
    return pronto.model_copy(update={"usd_brl": costs.usd_brl()})


_ORIGINS_MIN_S = 30
# Profundidade do `skills/` de plugin: cache/<mkt>/<plugin>/<versão>/skills.
_DEEP_ROOT_DEPTH = 4
# (quando o mapa mudou, mapa); o instante entra na chave do relatório pronto.
_origens_cache: tuple[float, dict[str, str]] = (float("-inf"), {})
# (pastas vigiadas, mtimes delas) da última varredura.
_origins_watch: tuple[list[str], tuple] = ([], ())
_origins_checked_at = float("-inf")


def _watched_dirs(home: Path) -> list[str]:
    """Pastas cujo mtime muda quando uma skill entra ou sai: raiz rasa e filhas, e as fundas
    até o `skills/` dos plugins. Pasta nova abaixo disso muda o mtime de uma vigiada."""
    rasas, fundas = _skill_roots(home)
    out: list[str] = []
    for raiz in rasas:
        out.append(str(raiz))
        try:
            with os.scandir(raiz) as it:
                out.extend(e.path for e in it if e.is_dir())
        except OSError:
            pass
    for raiz in fundas:
        level = [str(raiz)]
        for depth in range(_DEEP_ROOT_DEPTH + 1):
            out.extend(level)
            if depth == _DEEP_ROOT_DEPTH:
                break
            below = []
            for p in level:
                try:
                    with os.scandir(p) as it:
                        below.extend(e.path for e in it if e.is_dir(follow_symlinks=False))
                except OSError:
                    pass
            level = below
    return out


def _mtimes(dirs: list[str]) -> tuple:
    out = []
    for p in dirs:
        try:
            out.append(os.stat(p).st_mtime_ns)
        except OSError:
            out.append(None)
    return tuple(out)


def _origens_recentes() -> tuple[float, dict[str, str]]:
    """A varredura desce no cache de plugins inteiro (segundos); filtro e detalhe pedem o
    relatório de novo. De `_ORIGINS_MIN_S` em `_ORIGINS_MIN_S`, uma thread confere os mtimes
    e só varre se algo mudou; só o primeiro pedido do processo espera."""
    global _origins_checked_at
    atual = _origens_cache
    if atual[0] == float("-inf"):
        _origins_checked_at = time.monotonic()
        _atualizar_origens(force=True)
        return _origens_cache
    if time.monotonic() - _origins_checked_at > _ORIGINS_MIN_S:
        _origins_checked_at = time.monotonic()
        threading.Thread(target=_atualizar_origens, name="uso-origens", daemon=True).start()
    return atual


_origins_lock = threading.Lock()


def _atualizar_origens(home: Path | None = None, force: bool = False) -> None:
    # Uma varredura por vez: uma lenta terminando depois da seguinte gravaria o mapa velho por cima.
    if not _origins_lock.acquire(blocking=force):
        return
    try:
        _atualizar_origens_sob_trava(home, force)
    finally:
        _origins_lock.release()


def _atualizar_origens_sob_trava(home: Path | None, force: bool) -> None:
    global _origens_cache, _origins_watch
    home = home or Path.home()
    try:
        dirs, seen = _origins_watch
        if not force and _mtimes(dirs) == seen:
            return
        # Mtimes lidos ANTES da varredura: mudança no meio dela é vista na próxima conferência.
        dirs = _watched_dirs(home)
        watch = (dirs, _mtimes(dirs))
        found = origens_de_skill(home)
        # Instante novo só com mapa diferente: senão o relatório pronto seria jogado fora.
        if found != _origens_cache[1] or _origens_cache[0] == float("-inf"):
            _origens_cache = (time.monotonic(), found)
        _origins_watch = watch
    except Exception:
        if force:
            raise
        _log.warning("uso: origem das skills não atualizada", exc_info=True)
