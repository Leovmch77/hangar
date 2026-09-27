"""orq: o plano de orquestração (`## Projeto` + `## Tasks`), plan-check, init --plan, check e lote."""
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

ORQ = Path(__file__).resolve().parents[2] / "skills" / "orquestrar" / "scripts" / "orq.py"

PROJETO = """## Projeto
Checagens: `true`
Integração: —
Prova: lote(2)
Paralelo: até 2
Correção pelo revisor: até 20 linhas
"""

TASKS = """## Tasks
| # | What it is | Where in their plan | Files | Verification | Wave | Roteiro |
|---|---|---|---|---|---|---|
| 1 | a | §1 | `a.txt` | `true` | 1 | — |
| 2 | b | §2 | `b.txt` | `true` | 1 | `roteiro-2.md` |
"""


def run(*args, env=None, check=True):
    r = subprocess.run([sys.executable, str(ORQ), *args], capture_output=True, text=True,
                       env=env or {**os.environ, "ORQ_JEV": "off"})
    if check:
        assert r.returncode == 0, r.stdout + r.stderr
    return r


def escrever(tmp_path, projeto=PROJETO, tasks=TASKS):
    (tmp_path / "roteiro-2.md").write_text("abrir e conferir\n")
    p = tmp_path / "orq-plano.md"
    p.write_text(f"# Orchestration plan — x\nUser's plan: /x\n\n{projeto}\n{tasks}")
    return p


def test_plan_check_limpo_carimba_e_o_sha_bate(tmp_path):
    p = escrever(tmp_path)
    out = run("plan-check", str(p), "--repo", str(tmp_path), "--stamp").stdout
    assert "plan-check ok" in out
    txt = p.read_text()
    linha = next(l for l in txt.splitlines() if l.startswith("Preparado: "))
    assert "paralelo 2" in linha and "prova lote(2)" in linha and "plan-check limpo" in linha
    # Segundo carimbo troca a linha, nunca duplica.
    run("plan-check", str(p), "--repo", str(tmp_path), "--stamp")
    assert sum(1 for l in p.read_text().splitlines() if l.startswith("Preparado: ")) == 1


def test_plan_check_lista_cada_falta(tmp_path):
    tasks = TASKS.replace("| 2 | b | §2 | `b.txt` | `true` | 1 | `roteiro-2.md` |",
                          "| 2 | b | §2 | `sem/pasta/b.txt` |  | x | `nao-existe.md` |")
    p = escrever(tmp_path, projeto=PROJETO.replace("Paralelo: até 2\n", ""), tasks=tasks)
    r = run("plan-check", str(p), "--repo", str(tmp_path), check=False)
    assert r.returncode == 1
    out = r.stdout
    assert "## Projeto: missing line 'Paralelo:'" in out
    assert "T2: neither the file nor its directory exists: sem/pasta/b.txt" in out
    assert "T2: no Verification" in out
    assert "T2: Wave is not a number: x" in out
    assert "T2: roteiro not found: nao-existe.md" in out
    assert "Preparado:" not in p.read_text()


def test_plan_check_roda_as_checagens_e_conta_a_onda(tmp_path):
    p = escrever(tmp_path, projeto=PROJETO.replace("`true`", "`false`").replace("até 2", "sequencial"))
    r = run("plan-check", str(p), "--repo", str(tmp_path), check=False)
    assert "check failed: `false` (rc=1)" in r.stdout
    assert "wave 1 has 2 Tasks, Paralelo allows 1" in r.stdout


def test_init_exige_plano_carimbado_e_sem_mudanca(tmp_path):
    d = tmp_path / "orq"; d.mkdir()
    p = escrever(tmp_path)
    c = tmp_path / "regras.md"; c.write_text("")
    base = ["--dir", str(d), "init", "--arbiter", "arb", "--repo", str(tmp_path),
            "--contract", str(c), "--plan", str(p)]
    r = run(*base, check=False)
    assert r.returncode == 2 and "plan not prepared" in r.stderr
    run("plan-check", str(p), "--repo", str(tmp_path), "--stamp")
    p.write_text(p.read_text() + "\nmudou depois\n")
    r = run(*base, check=False)
    assert r.returncode == 2 and "plan changed after preparation" in r.stderr
    run("plan-check", str(p), "--repo", str(tmp_path), "--stamp")
    run(*base)
    assert json.loads((d / "orq.json").read_text())["plan"] == str(p.resolve())
