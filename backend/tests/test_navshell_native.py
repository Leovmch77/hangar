import json

from app import navsock


def test_sidecar_sem_target_id_so_casa_quando_nao_exige_alvo(monkeypatch, tmp_path):
    # Sidecar do app nativo: sem alvo CDP.
    (tmp_path / "nav-teste.json").write_text(json.dumps({
        "chave": "srv1::nav-teste", "url": "http://x/", "targetId": None,
        "ts": 1, "ativa": 1, "abas": [], "pid": 123,
    }), encoding="utf-8")
    monkeypatch.setattr(navsock, "_pasta_nav", lambda: tmp_path)

    assert navsock.alvo_da_sessao("nav-teste") is None
    sc = navsock.alvo_da_sessao("nav-teste", exige_alvo=False)
    assert sc and sc["chave"] == "srv1::nav-teste"
