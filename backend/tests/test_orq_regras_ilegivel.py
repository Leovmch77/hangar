"""Contratos soltos não participam da resolução do trabalho, mesmo quando ilegíveis."""
import pytest

from app import orq_papeis as op, pair
from app.adapters.orq import runs


@pytest.fixture(autouse=True)
def _pair_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(pair.settings, "projects_dir", tmp_path / "projects")
    monkeypatch.setattr(runs, "root", lambda: tmp_path / "no-runs")


def test_regras_com_bytes_invalidos_e_pulado():
    op.regras_path("ruim").write_bytes(b"\xff\xfe| papel | sess\xe3o |\n")
    op.regras_path("bom").write_text(
        "## Quem é quem\n\n| papel | sessão | provider | conta | modelo | esforço |\n"
        "|---|---|---|---|---|---|\n| árbitro | s1 | claude | padrao | opus | high |\n", encoding="utf-8")
    assert op.gid_por_sessao("s1") is None
