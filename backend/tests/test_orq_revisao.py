"""orq: revisão como subagente — `Revisão:` no plano, review-package e a trava do veredito."""
import json
import subprocess

from test_orq_plano import PROJETO, congelar, escrever, iniciar, repo, run  # noqa: F401


def test_plan_check_exige_revisao_valida(tmp_path):
    p = escrever(tmp_path, projeto=PROJETO.replace("Revisão: subagente\n", ""))
    r = run("plan-check", str(p), "--repo", str(tmp_path), check=False)
    assert "## Projeto: missing line 'Revisão:'" in r.stdout
    p = escrever(tmp_path, projeto=PROJETO.replace("Revisão: subagente", "Revisão: talvez"))
    r = run("plan-check", str(p), "--repo", str(tmp_path), check=False)
    assert "## Projeto: Revisão must be subagente | sessão" in r.stdout


def test_subagente_nao_e_sessao_para_a_vez_nem_para_o_vigia(tmp_path, repo):
    r, g = repo
    d, e, _ = iniciar(tmp_path, r)
    run("event", "task_inicio", "--task", "1", "--titulo", "t", "--executor", "ex",
        "--par", "subagente", env=e)
    h = congelar(r, g)
    run("check", "--task", "1", "--commit", h, env=e)
    run("event", "entrega", "--task", "1", "--rodada", "1", "--commit", h, env=e)
    assert run("ball", env=e).stdout.split() == ["ex"]
    assert "subagente" not in run("team", env=e).stdout.split()


def test_review_package_junta_tudo_e_diz_como_responder(tmp_path, repo):
    r, g = repo
    d, e, _ = iniciar(tmp_path, r)
    run("event", "task_inicio", "--task", "1", "--titulo", "t", "--executor", "ex",
        "--par", "subagente", env=e)
    c = json.loads((d / "orq.json").read_text())["contract"]
    open(c, "w").write("comum\n## Task 1\nsó da T1\n")
    h = congelar(r, g)
    run("check", "--task", "1", "--commit", h, env=e)
    run("event", "entrega", "--task", "1", "--rodada", "1", "--commit", h, env=e)
    rel = tmp_path / "rel.md"; rel.write_text("fiz X\n")
    path = run("review-package", "--task", "1", "--rodada", "1", "--report", str(rel), env=e).stdout.strip()
    txt = open(path).read()
    for trecho in ("comum", "só da T1", "fiz X", f"Object: {h}", "+2", "event veredito --task 1 --rodada 1",
                   "checks/task1-"):
        assert trecho in txt, trecho


def test_veredito_de_subagente_recusado_se_a_arvore_mudou(tmp_path, repo):
    r, g = repo
    d, e, _ = iniciar(tmp_path, r)
    run("event", "task_inicio", "--task", "1", "--titulo", "t", "--executor", "ex",
        "--par", "subagente", env=e)
    h = congelar(r, g)
    run("check", "--task", "1", "--commit", h, env=e)
    run("event", "entrega", "--task", "1", "--rodada", "1", "--commit", h, env=e)
    (r / "a.txt").write_text("mexido durante a revisão\n")
    res = run("event", "veredito", "--task", "1", "--rodada", "1", "--resultado", "aprova",
              "--sessao", "revisor-orq", env=e, check=False)
    assert res.returncode == 2 and "worktree changed during the review" in res.stderr
    (r / "a.txt").write_text("2\n")
    run("event", "veredito", "--task", "1", "--rodada", "1", "--resultado", "aprova",
        "--sessao", "revisor-orq", env=e)
