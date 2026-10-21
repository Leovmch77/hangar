"""Leitura do arquivo de grupo (`pair.PairLink.get`, `contract_path_for`): formato legado 1:1, gid
derivado e contrato por gid. Quem grava é o Rust (`crates/hangar-server/tests/it/groups_*.rs`)."""
import json

import pytest

from app import pair
from app.pair import PairLink


@pytest.fixture(autouse=True)
def _tmp_pair_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(pair.settings, "projects_dir", tmp_path / "projects")
    return tmp_path


def _sidecar(name, peers, gid):
    (pair._pair_dir() / f"{name}.json").write_text(
        json.dumps({"peers": peers, "task": "", "gid": gid, "harness": {}}), encoding="utf-8")


def test_legacy_single_peer_format_is_read():
    # Sidecar antigo (1:1) gravado antes do modelo de grupo -> lido como grupo de 2.
    p = pair._pair_dir() / "velho.json"
    p.write_text(json.dumps({"peer": "outro", "task": "t"}), encoding="utf-8")
    link = PairLink("velho").get()
    assert link["peers"] == ["outro"] and link["task"] == "t"


def test_sidecar_legado_sem_gid_ganha_um_derivado_e_igual_dos_dois_lados():
    # Sidecar de antes do gid existir voltava com gid vazio; `clusterByPair` (front) só agrupa por
    # gid, então a sessão aparecia solta — o desktop disfarçava com um chip próprio lendo `peers` e
    # o celular não mostrava vínculo nenhum. O derivado sai do CONJUNTO de membros, então os dois
    # sidecars caem no mesmo valor sem combinarem nada.
    for nome, peer in (("velho", "antigo"), ("antigo", "velho")):
        (pair._pair_dir() / f"{nome}.json").write_text(
            json.dumps({"peers": [peer], "task": "t"}), encoding="utf-8")
    gid_a, gid_b = PairLink("velho").get()["gid"], PairLink("antigo").get()["gid"]
    assert gid_a and gid_a == gid_b
    # E não é gravado: escrever durante uma leitura que roda a cada poll da lista é caro e arriscado.
    assert "gid" not in json.loads((pair._pair_dir() / "velho.json").read_text(encoding="utf-8"))


def test_gid_derivado_nao_atropela_o_gravado():
    # Grupo normal tem gid de verdade; o derivado só cobre a ausência.
    _sidecar("a", ["b"], "ab12cd34")
    assert PairLink("a").get()["gid"] == "ab12cd34"


def test_contract_path_stable_and_none_without_group():
    assert pair.contract_path_for("solta") is None
    _sidecar("a", ["b", "c"], "g1")
    _sidecar("c", ["a", "b"], "g1")
    assert pair.contract_path_for("a") == pair.contract_path_for("c") == pair._pair_dir() / "grupo-g1.md"
