import pytest
from fastapi.testclient import TestClient

from app import costs_sources
from app.api import app
from app.config import settings
from app.costs import PERIODOS
from app.models import UsoReport


@pytest.fixture
def client():
    settings.auth_token = "secret"
    return TestClient(app)


@pytest.fixture
def h():
    return {"Authorization": "Bearer secret"}


def test_period_invalido_cai_em_all_e_o_eco_volta(client, h, monkeypatch):
    visto = {}

    def falso(period="all"):
        visto["p"] = period
        return UsoReport(applied={"period": period})

    monkeypatch.setattr("app.uso_report.report", falso)
    r = client.get("/api/uso?period=banana", headers=h)
    assert r.status_code == 200
    assert visto["p"] == "all"
    assert r.json()["applied"]["period"] == "all"


@pytest.mark.parametrize("period", list(PERIODOS))
def test_todo_periodo_e_aceito(client, h, monkeypatch, period):
    monkeypatch.setattr("app.uso_report.report",
                        lambda period="all": UsoReport(applied={"period": period}))
    assert client.get(f"/api/uso?period={period}", headers=h).json()["applied"]["period"] == period


def test_aquecendo_responde_202(client, h, monkeypatch):
    def falso(period="all"):
        raise costs_sources.Aquecendo(10, 20)

    monkeypatch.setattr("app.uso_report.report", falso)
    r = client.get("/api/uso", headers=h)
    assert r.status_code == 202
    assert r.json() == {"aquecendo": True, "lidos": 10, "total": 20}


def test_sem_token_e_401(client):
    assert client.get("/api/uso").status_code == 401
