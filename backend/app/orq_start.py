"""O que falta para uma orquestração começar, e o recado que põe a sessão no passo certo.

O play nunca recusa por falta de plano ou de grupo: quem cria os dois é a própria sessão, conduzida
pela skill. A régua do plano é a do `orq.py` (`find_plan`), a mesma que o terminal usa.
"""
from __future__ import annotations

import importlib.util
import logging
from functools import cache
from pathlib import Path

_log = logging.getLogger(__name__)
_ORQ_PY = Path(__file__).resolve().parents[2] / "skills" / "orquestrar" / "scripts" / "orq.py"


@cache
def _orq():
    spec = importlib.util.spec_from_file_location("orq_skill", _ORQ_PY)
    assert spec and spec.loader, _ORQ_PY
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def readiness(cwd: str | None, in_group: bool, has_roles: bool) -> dict:
    """`phase` = por onde a sessão começa: planner (sem plano), prepare (plano sem carimbo ou
    editado depois dele), launch (carimbado, sem grupo) ou arbiter (tudo pronto). `problems` =
    o que não deu para ler: sem plano achado, ele pode estar ali, e o recado avisa."""
    if not cwd or not Path(cwd).is_dir():
        found = {"problems": [f"pasta da sessão desconhecida: {cwd or '—'}"]}
    else:
        try:
            found = _orq().find_plan(Path(cwd))
        except Exception as e:
            _log.exception("orq_start: a busca do plano falhou")
            found = {"problems": [f"busca do plano falhou: {e}"]}
    plan = {k: found[k] for k in ("path", "state")} if "path" in found else None
    state = plan["state"] if plan else None
    phase = ("planner" if not plan else "prepare" if state != "stamped"
             else "arbiter" if in_group else "launch")
    return {"phase": phase, "plan": plan, "group": in_group, "roles": has_roles,
            "problems": found.get("problems", []), "finished": found.get("finished")}


def _notes(r: dict) -> str:
    notes = []
    if r.get("problems"):
        notes.append("Não consegui ler tudo (" + "; ".join(r["problems"]) + "): confira se já existe "
                     "plano antes de escrever outro.")
    if r["phase"] == "planner" and r.get("finished"):
        notes.append(f"O plano `{r['finished']}` está com todos os Steps marcados (concluído); "
                     "confirme comigo se o trabalho é outro.")
    return (" " + " ".join(notes)) if notes else ""


def kickoff(r: dict, contract: str) -> str:
    head = "[painel: orquestração] "
    skill = "Invoque a skill `orquestrar`"
    plan = r["plan"]["path"] if r["plan"] else ""
    team = (f"Time: o contrato `{contract}` (a tabela `## Quem é quem`)." if r["roles"]
            else f"O contrato `{contract}` ainda não tem papéis: combine o time comigo.")
    if r["phase"] == "planner":
        return (f"{head}Comece uma orquestração nova. Você é a PLANEJADORA. {skill} e leia "
                "`references/planejamento.md`. Não há plano: conduza a fase 1 comigo. Pergunte o "
                "método; sem nenhum (`none`), escreva você o plano, no formato `### Task N:` com "
                f"`- [ ] **Step N: …**`. {team}{_notes(r)}")
    if r["phase"] == "prepare":
        why = {"changed": "foi editado depois do carimbo", "unstamped": "ainda não foi carimbado",
               "tasks": "ainda não tem o plano de orquestração"}[r["plan"]["state"]]
        return (f"{head}Você é a PLANEJADORA. {skill} e leia `references/planejamento.md` a partir "
                f"do passo \"4. The orchestration plan\". Plano achado: `{plan}`, que {why}; confirme comigo "
                "que é este antes de mexer (a pasta pode ter planos de outro trabalho). Monte ou atualize o "
                "`.orq.md`, rode o agente `preparar-plano` (as perguntas dele vêm para mim), carimbe, "
                f"lance o time e siga como árbitro. {team}{_notes(r)}")
    if r["phase"] == "launch":
        return (f"{head}Plano carimbado: `{plan}`. Você é a PLANEJADORA na fase 2. {skill} e leia "
                "o passo \"7. Launch\" de `references/planejamento.md` e \"Phase 2 — Launch\" de "
                f"`references/planejamento-equipe.md`: crie o grupo e o contrato e siga como árbitro. {team}{_notes(r)}")
    return (f"{head}Comece a orquestração deste grupo. Você é o ÁRBITRO. {skill} e leia "
            f"`references/arbitro.md`, só a página do seu papel. Contrato do grupo: `{contract}` "
            "(tabela `## Quem é quem` = quem roda cada papel; papel com coluna `vez` reveza entre "
            f"contas, e a Task N cabe à linha (N-1) % total). Plano: `{plan}`. Comece pelo portão: "
            "confira o que já passou, e só então despache a próxima Task." + _notes(r))
