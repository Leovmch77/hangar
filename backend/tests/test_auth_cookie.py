import pytest
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

from app import auth
from app.config import settings


@pytest.fixture(autouse=True)
def _limpo():
    settings.auth_token = "secret"
    auth.reset_backoff()
    yield
    auth.reset_backoff()


def _app():
    a = FastAPI()

    @a.get("/ler", dependencies=[Depends(auth.require_auth)])
    def ler():
        return {"ok": True}

    @a.post("/agir", dependencies=[Depends(auth.require_auth)])
    def agir():
        return {"ok": True}

    return a


def _cli(base):
    return TestClient(_app(), base_url=base, client=("10.0.0.9", 1))


def test_cookie_le_mas_nao_age():
    c = _cli("http://testserver")
    c.cookies.set("cp_token", "secret")
    assert c.get("/ler").status_code == 200
    assert c.post("/agir").status_code == 401


def test_cabecalho_age():
    c = _cli("http://testserver")
    assert c.post("/agir", headers={"Authorization": "Bearer secret"}).status_code == 200


def test_https_so_aceita_host_prefix():
    c = _cli("https://testserver")
    c.cookies.set("cp_token", "secret")
    assert c.get("/ler").status_code == 401
    c.cookies.clear()
    c.cookies.set("__Host-cp_token", "secret")
    assert c.get("/ler").status_code == 200


def test_cookie_token():
    assert auth.cookie_token({"cp_token": "a", "__Host-cp_token": "b"}, https=True) == "b"
    assert auth.cookie_token({"__Host-cp_token": "b"}, https=False) == "b"
    assert auth.cookie_token({"cp_token": "a"}, https=False) == "a"
    assert auth.cookie_token({"cp_token": "a"}, https=True) is None
