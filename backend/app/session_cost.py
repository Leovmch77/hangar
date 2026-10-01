"""API-equivalent cost for one Codex session, using the costs report's usage rules."""
from __future__ import annotations

from dataclasses import replace
from pathlib import Path

from app import costs, pricing
from app.costs_sources import UsageRow, custos_do_rollout


def estimate_session_cost(rollout_path: str) -> dict:
    path = Path(rollout_path).resolve(strict=True)
    rows = _usage(path)
    total = 0.0
    missing_models: set[str] = set()
    for row in rows:
        parts = costs._custo_da_linha(row)
        if parts is None:
            missing_models.add(pricing.canonizar(row.model))
        else:
            total += sum(parts.values())
    return {
        "cost_usd": total if rows and not missing_models else None,
        "missing_models": sorted(missing_models),
        "has_usage": bool(rows),
    }


def _usage(path: Path) -> tuple[UsageRow, ...]:
    # O índice lê só o que o rollout ganhou desde a última consulta; aqui só se reagrupa o que
    # ele separou por dia.
    grouped: dict[tuple[str, bool], UsageRow] = {}
    for row in custos_do_rollout(path) or ():
        if not any((row.input, row.output, row.cache_write, row.cache_read)):
            continue
        key = row.model, row.codex_long_context
        before = grouped.get(key)
        grouped[key] = row if before is None else replace(
            before, input=before.input + row.input, output=before.output + row.output,
            cache_write=before.cache_write + row.cache_write,
            cache_read=before.cache_read + row.cache_read,
        )
    return tuple(grouped.values())
