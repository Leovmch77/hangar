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


def _zero() -> dict:
    return {"sessions": set(), "chamadas": 0, "pedidas": 0, "ctx_chars": 0, "tokens_est": 0,
            "input": 0, "output": 0, "cache_write": 0, "cache_read": 0, "cost": 0.0, "plugin": ""}


def _custo_skill(l: UsoLinha) -> float:
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
        return _custo_skill(l)
    if l.tipo == "agente" and l.detalhe:
        a = agentes.get(l.detalhe)
        return a["cost"] if a else 0.0
    return 0.0


def _bucket(key: str, v: dict) -> UsoBucket:
    return UsoBucket(key=key, plugin=v["plugin"], sessions=len(v["sessions"]),
                     chamadas=v["chamadas"], pedidas=v["pedidas"], ctx_chars=v["ctx_chars"],
                     ctx_tokens_est=v["ctx_chars"] // _CHARS_POR_TOKEN + v["tokens_est"],
                     input=v["input"], output=v["output"], cache_write=v["cache_write"],
                     cache_read=v["cache_read"], cost=v["cost"])


def _ordenar(agg: dict[str, dict]) -> list[UsoBucket]:
    return sorted((_bucket(k, v) for k, v in agg.items()),
                  key=lambda b: (-b.cost, -b.ctx_chars, -b.chamadas, b.key))


def _conta_no_total(l: UsoLinha) -> bool:
    """`bash`/`mcp` repetem a chamada de `tool`; `tool:Skill` e `tool:Agent` repetem a linha
    de `skill`/`agente`. Cada chamada entra uma vez."""
    if l.tipo == "tool":
        return l.nome not in ("Skill", "Agent")
    return l.tipo in _TIPOS_CONTADOS


def _somar_em(b: dict, l: UsoLinha, agentes: dict[str, dict]) -> None:
    b["sessions"].add(l.session_id)
    if _conta_no_total(l):
        b["chamadas"] += l.chamadas
        b["ctx_chars"] += l.ctx_chars
        b["tokens_est"] += l.tokens_est
    b["cost"] += _custo_linha(l, agentes)


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
    return sorted(out, key=lambda b: (-b.cost, -b.chamadas, b.key))


def _por_dia(uso: list[UsoLinha], agentes: dict[str, dict]) -> list[UsoBucket]:
    agg: dict[str, dict] = defaultdict(_zero)
    for l in uso:
        if l.dia:
            _somar_em(agg[l.dia], l, agentes)
    return sorted((_bucket(k, v) for k, v in agg.items()), key=lambda b: b.key)


def montar(uso: list[UsoLinha], tokens: list[UsageRow], period: str = "all",
           now: datetime | None = None, conta: str | None = None,
           projeto: str | None = None, modelo: str | None = None,
           plugin: str | None = None, foco: str | None = None) -> UsoReport:
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
    if conta:
        uso = [l for l in uso if l.conta == conta]
    if projeto:
        uso = [l for l in uso if (l.cwd or PROJETO_DESCONHECIDO) == projeto]
    if modelo:
        uso = [l for l in uso if (pricing.canonizar(l.model) or "?") == modelo]
    if plugin:
        uso = [l for l in uso if l.plugin == plugin]
    # O custo do agente vem do transcript filho, que tem conta e projeto próprios: o filtro
    # vale pra ele também (o filho de outra conta não entra na soma desta).
    if conta or projeto:
        tokens = [r for r in tokens
                  if (not conta or r.account_id == conta)
                  and (not projeto or (r.project or PROJETO_DESCONHECIDO) == projeto)]
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
            b["input"] += l.input
            b["output"] += l.output
            b["cache_write"] += l.cache_write
            b["cache_read"] += l.cache_read
            b["cost"] += _custo_skill(l)
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
            if l.tipo == "skill":
                p["input"] += l.input
                p["output"] += l.output
                p["cache_write"] += l.cache_write
                p["cache_read"] += l.cache_read
                p["cost"] += _custo_skill(l)
        _somar_em(total, l, agentes)

    # Série diária: sob todos os filtros e, com `foco`, só do item de nome igual (qualquer
    # tipo) — é o clique numa linha da tabela.
    serie = [l for l in uso if l.nome == foco] if foco else uso

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
        by_day=_por_dia(serie, agentes),
        applied=Applied(period=period),
        conta=conta or None, projeto=projeto or None, modelo=modelo or None,
        plugin=plugin or None, foco=foco or None,
        usd_brl=costs.usd_brl(),
    )


def report(period: str = "all", now: datetime | None = None, fresco: bool = False,
           **filtros) -> UsoReport:
    """Levanta `costs_sources.Aquecendo` enquanto a primeira coleta da subida não terminou.
    `filtros`: conta, projeto, modelo, plugin, foco (ver `montar`)."""
    uso, tokens = coletar_uso(fresco=fresco)
    return montar(uso, tokens, period=period, now=now, **filtros)
