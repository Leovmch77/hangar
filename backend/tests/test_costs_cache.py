from pathlib import Path

import pytest

from app import costs_cache as cc

V = 1


@pytest.fixture(autouse=True)
def _limpo(tmp_path, monkeypatch):
    monkeypatch.setattr(cc, "_CACHE_DIR", tmp_path / "cache")
    cc.invalidar()
    yield
    cc.invalidar()


def _varrer(raiz: Path, chamadas: list[Path], de_dict=None):
    def ler(p: Path) -> list[int]:
        chamadas.append(p)
        return [len(p.read_text(encoding="utf-8"))]
    return cc.varrer_cacheado("t", raiz, sorted(raiz.glob("*.txt")), ler,
                              lambda n: {"n": n}, de_dict or (lambda d: d.get("n")), V)


def test_restart_simulado_le_do_disco_sem_chamar_o_leitor(tmp_path):
    a = tmp_path / "a.txt"
    a.write_text("abc", encoding="utf-8")
    chamadas: list[Path] = []
    assert _varrer(tmp_path, chamadas) == [(a, [3])]
    assert chamadas == [a]
    cc.invalidar()  # processo novo: memória zerada, disco intacto
    chamadas.clear()
    assert _varrer(tmp_path, chamadas) == [(a, [3])]
    assert chamadas == []


def test_rele_so_o_que_mudou_e_esquece_o_que_sumiu(tmp_path):
    a, b = tmp_path / "a.txt", tmp_path / "b.txt"
    a.write_text("a", encoding="utf-8")
    b.write_text("bb", encoding="utf-8")
    chamadas: list[Path] = []
    _varrer(tmp_path, chamadas)
    chamadas.clear()
    a.write_text("aaaa", encoding="utf-8")
    assert _varrer(tmp_path, chamadas) == [(a, [4]), (b, [2])]
    assert chamadas == [a]
    b.unlink()
    assert _varrer(tmp_path, chamadas) == [(a, [4])]
    assert "b.txt" not in cc.caminho_cache("t", tmp_path).read_text(encoding="utf-8")


def test_item_que_nao_desserializa_e_relido(tmp_path):
    a = tmp_path / "a.txt"
    a.write_text("abc", encoding="utf-8")
    chamadas: list[Path] = []
    _varrer(tmp_path, chamadas)
    chamadas.clear()
    assert _varrer(tmp_path, chamadas, de_dict=lambda d: None) == [(a, [3])]
    assert chamadas == [a]


def test_progresso_aparece_durante_e_some_depois(tmp_path):
    for i in range(3):
        (tmp_path / f"{i}.txt").write_text("x", encoding="utf-8")
    visto: list[tuple[int, int]] = []

    def ler(p: Path) -> list[int]:
        visto.append(cc.progresso_total())
        return [1]

    cc.varrer_cacheado("t", tmp_path, sorted(tmp_path.glob("*.txt")), ler,
                       lambda n: {"n": n}, lambda d: d.get("n"), V)
    assert visto == [(0, 3), (1, 3), (2, 3)]
    assert cc.progresso_total() == (0, 0)
