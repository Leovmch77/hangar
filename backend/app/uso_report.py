"""Agregação do relatório de uso (skills, tools, Bash, MCP, agentes, contexto, imagens, plugins).

Quem lê é o `uso_claude` (dentro da passada do `costs_claude_transcript`); quem sabe preço é
o `pricing` via `costs._custo_da_linha`. Aqui só se soma e se corta por período e filtros.
"""
from __future__ import annotations

from collections import defaultdict
from datetime import datetime, timedelta

from app import costs, pricing
from app.costs_sources import (LOCAL, PROJETO_DESCONHECIDO, UsageRow, coletar_uso,
                               rotulo_de_provedor)
from app.models import Applied, UsoBucket, UsoReport
from app.uso_claude import UsoLinha

# chars/4 é a régua de "tokens estimados": a tela SEMPRE rotula como estimativa.
_CHARS_POR_TOKEN = 4
_MARCA_SUBAGENTE = "/subagents/agent-"
# `bash`/`mcp` repetem a chamada de `tool`: nos totais cada chamada conta uma vez só.
_TIPOS_CONTADOS = ("tool", "skill", "agente", "contexto", "imagem")


# Texto de skill: medido contra o cache write real das respostas (regressão em 196 cargas,
# correlação 0,996). chars/4 subestimava 60%. Os demais contextos seguem chars/4 (não medidos).
_CHARS_POR_TOKEN_SKILL = 2.5


def _zero() -> dict:
    return {"sessions": set(), "chamadas": 0, "pedidas": 0, "ctx_chars": 0, "tokens_est": 0,
            "input": 0, "output": 0, "cache_write": 0, "cache_read": 0, "cost": 0.0, "plugin": "",
            "ocupados": 0, "respostas": 0, "regua": _CHARS_POR_TOKEN}


def _custo_real(l: UsoLinha) -> float:
    if not (l.input or l.output or l.cache_write or l.cache_read):
        return 0.0
    c = costs._custo_da_linha(UsageRow(
        ts=datetime.fromisoformat(l.dia).replace(tzinfo=LOCAL), source="claude",
        provider="anthropic", model=l.model, project=l.cwd, session_id=l.session_id,
        input=l.input, output=l.output, cache_write=l.cache_write, cache_read=l.cache_read,
        cache_write_1h=l.cache_write_1h, fast=l.fast))
    return sum(c.values()) if c else 0.0


def _custo_dos_agentes(tokens: list[UsageRow]) -> dict[str, dict]:
    """agentId -> tokens e custo do transcript filho (`…/subagents/agent-<id>`)."""
    out: dict[str, dict] = defaultdict(lambda: {"input": 0, "output": 0, "cache_write": 0,
                                                "cache_read": 0, "cost": 0.0})
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
    return out


def _custo_linha(l: UsoLinha, agentes: dict[str, dict]) -> float:
    if l.tipo == "skill":
        return _custo_real(l)
    if l.tipo == "agente" and l.detalhe:
        a = agentes.get(l.detalhe)
        return a["cost"] if a else 0.0
    return 0.0


def _bucket(key: str, v: dict) -> UsoBucket:
    return UsoBucket(key=key, plugin=v["plugin"], sessions=len(v["sessions"]),
                     chamadas=v["chamadas"], pedidas=v["pedidas"], ctx_chars=v["ctx_chars"],
                     ctx_tokens_est=int(v["ctx_chars"] / v["regua"]) + v["tokens_est"],
                     input=v["input"], output=v["output"], cache_write=v["cache_write"],
                     cache_read=v["cache_read"], cost=v["cost"],
                     ocupados_tokens_est=int(v["ocupados"] / _CHARS_POR_TOKEN_SKILL),
                     respostas=v["respostas"])


def _ordenar(agg: dict[str, dict]) -> list[UsoBucket]:
    return sorted((_bucket(k, v) for k, v in agg.items()),
                  key=lambda b: (-b.ocupados_tokens_est, -b.cost, -b.ctx_chars, -b.chamadas, b.key))


def _conta_no_total(l: UsoLinha) -> bool:
    """`bash`/`mcp` repetem a chamada de `tool`; `tool:Skill` e `tool:Agent` repetem a linha
    de `skill`/`agente`. Cada chamada entra uma vez."""
    if l.tipo == "tool":
        return l.nome not in ("Skill", "Agent")
    return l.tipo in _TIPOS_CONTADOS


_CAMPOS_TOKENS = ("input", "output", "cache_write", "cache_read")


def _somar_em(b: dict, l: UsoLinha, agentes: dict[str, dict], do_item: bool = False) -> None:
    """Tokens reais do conjunto vêm das linhas de ÁREA, que somadas dão todo o uso do Claude
    sem repetição; `do_item` (série de uma skill/agente) soma os tokens do próprio item."""
    b["sessions"].add(l.session_id)
    if l.tipo == "area":
        if not do_item:
            for k in _CAMPOS_TOKENS:
                b[k] += getattr(l, k)
        return
    if _conta_no_total(l):
        b["chamadas"] += l.chamadas
        b["ctx_chars"] += l.ctx_chars
        b["tokens_est"] += l.tokens_est
    b["cost"] += _custo_linha(l, agentes)
    if do_item:
        b["ocupados"] += l.ocupados
        b["respostas"] += l.respostas
        fonte =(agentes.get(l.detalhe) if l.tipo == "agente" and l.detalhe
                 else {k: getattr(l, k) for k in _CAMPOS_TOKENS} if l.tipo == "skill" else None)
        for k in _CAMPOS_TOKENS if fonte else ():
            b[k] += fonte[k]


def _por_dimensao(uso: list[UsoLinha], agentes: dict[str, dict], chave,
                  rotulo=None) -> list[UsoBucket]:
    """Totais por conta/projeto/modelo: lista dos seletores. Vem do PERÍODO inteiro, antes dos
    filtros de dimensão, senão a opção escolhida sumiria do próprio seletor."""
    agg: dict[str, dict] = defaultdict(_zero)
    for l in uso:
        _somar_em(agg[chave(l)], l, agentes)
    out = []
    for k, v in agg.items():
        b = _bucket(k, v)
        if rotulo:
            b.label = rotulo(k)
        out.append(b)
    return sorted(out, key=lambda b: (-_tokens(b), -b.chamadas, b.key))


def _tokens(b: UsoBucket) -> int:
    return b.input + b.output + b.cache_write + b.cache_read


def _por_dia(uso: list[UsoLinha], agentes: dict[str, dict], do_item: bool = False) -> list[UsoBucket]:
    agg: dict[str, dict] = defaultdict(_zero)
    for l in uso:
        if l.dia:
            _somar_em(agg[l.dia], l, agentes, do_item)
    return sorted((_bucket(k, v) for k, v in agg.items()), key=lambda b: b.key)


def _somar_area(b: dict, l: UsoLinha) -> None:
    b["sessions"].add(l.session_id)
    b["chamadas"] += l.chamadas
    for k in ("input", "output", "cache_write", "cache_read"):
        b[k] += getattr(l, k)
    b["cost"] += _custo_real(l)


def _por_area_dia(uso: list[UsoLinha]) -> list[UsoBucket]:
    """key = `YYYY-MM-DD|área` (chave única pra mescla da malha), label = área."""
    agg: dict[str, dict] = defaultdict(_zero)
    for l in uso:
        if l.tipo == "area" and l.dia:
            _somar_area(agg[f"{l.dia}|{l.nome}"], l)
    out = sorted((_bucket(k, v) for k, v in agg.items()), key=lambda b: b.key)
    for b in out:
        b.label = b.key.split("|", 1)[1]
    return out


Filtro = str | list[str] | None


def _lista(v: Filtro) -> list[str]:
    """Um filtro aceita um valor ou vários; vazio = todos."""
    if not v:
        return []
    return [v] if isinstance(v, str) else [x for x in v if x]


def montar(uso: list[UsoLinha], tokens: list[UsageRow], period: str = "all",
           now: datetime | None = None, conta: Filtro = None,
           projeto: Filtro = None, modelo: Filtro = None,
           plugin: Filtro = None, foco: str | None = None) -> UsoReport:
    contas, projetos, modelos, plugins_f = _lista(conta), _lista(projeto), _lista(modelo), _lista(plugin)
    now = now or datetime.now(LOCAL)
    dias = costs.PERIODOS.get(period)
    if dias:
        corte = (now - timedelta(days=dias - 1)).date()
        uso = [l for l in uso if l.dia and datetime.fromisoformat(l.dia).date() >= corte]
        tokens = [r for r in tokens if r.ts.date() >= corte]
    agentes = _custo_dos_agentes(tokens)
    por_conta = _por_dimensao(uso, agentes, lambda l: l.conta, rotulo_de_provedor)
    por_projeto = _por_dimensao(uso, agentes, lambda l: l.cwd or PROJETO_DESCONHECIDO)
    por_modelo = _por_dimensao(uso, agentes, lambda l: pricing.canonizar(l.model) or "?")
    if contas:
        uso = [l for l in uso if l.conta in contas]
    if projetos:
        uso = [l for l in uso if (l.cwd or PROJETO_DESCONHECIDO) in projetos]
    if modelos:
        uso = [l for l in uso if (pricing.canonizar(l.model) or "?") in modelos]
    if plugins_f:
        uso = [l for l in uso if l.plugin in plugins_f]
    # O custo do agente vem do transcript filho, que tem conta e projeto próprios: o filtro
    # vale pra ele também (o filho de outra conta não entra na soma desta).
    if contas or projetos:
        tokens = [r for r in tokens
                  if (not contas or r.account_id in contas)
                  and (not projetos or (r.project or PROJETO_DESCONHECIDO) in projetos)]
        agentes = _custo_dos_agentes(tokens)

    por_tipo: dict[str, dict[str, dict]] = defaultdict(lambda: defaultdict(_zero))
    plugins: dict[str, dict] = defaultdict(_zero)
    total = _zero()
    for l in uso:
        b = por_tipo[l.tipo][l.nome]
        b["plugin"] = b["plugin"] or l.plugin
        b["sessions"].add(l.session_id)
        b["chamadas"] += l.chamadas
        b["ctx_chars"] += l.ctx_chars
        b["tokens_est"] += l.tokens_est
        if l.origem in ("voce", "pedido"):
            b["pedidas"] += l.chamadas
        if l.tipo == "skill":
            b["regua"] = _CHARS_POR_TOKEN_SKILL
            b["ocupados"] += l.ocupados
            b["respostas"] += l.respostas
        if l.tipo in ("skill", "area"):
            b["input"] += l.input
            b["output"] += l.output
            b["cache_write"] += l.cache_write
            b["cache_read"] += l.cache_read
            b["cost"] += _custo_real(l)
        elif l.tipo == "agente" and l.detalhe:
            a = agentes.get(l.detalhe)
            if a:
                for k in ("input", "output", "cache_write", "cache_read", "cost"):
                    b[k] += a[k]
        if l.plugin and l.tipo in ("skill", "contexto"):
            p = plugins[l.plugin]
            p["plugin"] = l.plugin
            p["sessions"].add(l.session_id)
            p["chamadas"] += l.chamadas
            p["ctx_chars"] += l.ctx_chars
            p["ocupados"] += l.ocupados
            p["respostas"] += l.respostas
            if l.tipo == "skill":
                p["input"] += l.input
                p["output"] += l.output
                p["cache_write"] += l.cache_write
                p["cache_read"] += l.cache_read
                p["cost"] += _custo_real(l)
        _somar_em(total, l, agentes)

    # Série diária: sob todos os filtros e, com `foco`, só do item de nome igual (qualquer
    # tipo) — é o clique numa linha da tabela.
    serie = [l for l in uso if l.nome == foco] if foco else uso
    if foco and por_tipo["area"].get(foco):
        por_dia: dict[str, dict] = defaultdict(_zero)
        for l in serie:
            if l.tipo == "area" and l.dia:
                _somar_area(por_dia[l.dia], l)
        by_day = sorted((_bucket(k, v) for k, v in por_dia.items()), key=lambda b: b.key)
    else:
        by_day = _por_dia(serie, agentes, do_item=bool(foco))

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
        by_conta=por_conta,
        by_projeto=por_projeto,
        by_modelo=por_modelo,
        by_area=_ordenar(por_tipo["area"]),
        by_area_dia=_por_area_dia(uso),
        by_day=by_day,
        applied=Applied(period=period),
        conta=contas, projeto=projetos, modelo=modelos, plugin=plugins_f, foco=foco or None,
        usd_brl=costs.usd_brl(),
    )


def report(period: str = "all", now: datetime | None = None, fresco: bool = False,
           **filtros) -> UsoReport:
    """Levanta `costs_sources.Aquecendo` enquanto a primeira coleta da subida não terminou.
    `filtros`: conta, projeto, modelo, plugin, foco (ver `montar`)."""
    uso, tokens = coletar_uso(fresco=fresco)
    return montar(uso, tokens, period=period, now=now, **filtros)
