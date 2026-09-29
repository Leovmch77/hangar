"""Índice FTS5 dos transcripts: escape da consulta, ingestão incremental e paridade do Arquivo."""
import json
import sqlite3
import threading
import time

import pytest

from app import archive, search, transcript_index as ti

SID = "11111111-1111-1111-1111-111111111111"
SID2 = "22222222-2222-2222-2222-222222222222"


@pytest.fixture
def base(tmp_path, monkeypatch):
    projects = tmp_path / "projects"
    projects.mkdir()
    monkeypatch.setattr(archive, "_contas", lambda config_dir=None: [(None, "", projects)])
    monkeypatch.setattr(archive, "_conversas_de_outros_providers", lambda: [])
    monkeypatch.setattr(search, "_contas", lambda: [(None, "", projects)])
    monkeypatch.setattr(ti, "_internal_prefixes", lambda: ("PROMPT INTERNO",))
    return projects


@pytest.fixture
def idx(tmp_path, monkeypatch):
    i = ti.Index(tmp_path / "idx.sqlite3")
    monkeypatch.setattr(ti, "_current", i)
    return i


def _linha(texto, uuid, cwd="/home/u/proj", role="user"):
    if role == "user":
        msg = {"role": "user", "content": texto}
    else:
        msg = {"role": "assistant", "content": [{"type": "text", "text": texto}]}
    return json.dumps({"type": role, "uuid": uuid, "cwd": cwd, "message": msg}) + "\n"


def _escrever(base, *linhas, sid=SID, proj="-home-u-proj", modo="w"):
    d = base / proj
    d.mkdir(exist_ok=True)
    f = d / f"{sid}.jsonl"
    with open(f, modo, encoding="utf-8") as fh:
        fh.write("".join(linhas))
    return f


def _achar(idx, q):
    idx.last_pass = float("inf")   # a busca não dispara passada: o teste controla quando indexar
    return search.search(q, {})


def test_fts_query_trata_texto_como_literal():
    assert ti.fts_query(["foo"]) == '"foo"'
    assert ti.fts_query(['a"bc', "and"]) == '"a""bc" AND "and"'
    assert ti.fts_query(["near(", "xyz"]) == '"near(" AND "xyz"'
    # Menos de 3 caracteres não forma trigrama: quem chama usa o rg.
    assert ti.fts_query(["tk", "40213"]) is None
    assert ti.fts_query([]) is None


def test_acha_substring_no_meio_da_palavra(base, idx):
    _escrever(base, _linha("deu Error no TKT-40213abc", "u1"))
    idx.update(providers=False)
    for q in ("rror", "40213", "t-402"):
        assert [h.event_id for h in _achar(idx, q)] == ["u1"], q


def test_termo_curto_cai_no_rg(base, idx, monkeypatch):
    chamado = []
    monkeypatch.setattr(search, "_search_rg", lambda t, live, limit: chamado.append(t) or [])
    idx.update(providers=False)
    _achar(idx, "tk 40213")
    assert chamado == [["tk", "40213"]]


def test_erro_de_sqlite_no_meio_nao_deixa_linhas_parciais(base, idx, monkeypatch):
    # Linhas já inseridas e o UPDATE do offset falha: nada pode sobrar para um commit posterior.
    _escrever(base, *[_linha(f"agulha {i}", f"u{i}") for i in range(3)])
    real = idx._conn

    class Quebra:
        def __getattr__(self, k):
            return getattr(real, k)

        def __enter__(self):
            return real.__enter__()

        def __exit__(self, *a):
            return real.__exit__(*a)

        def execute(self, sql, *a):
            if sql.startswith("UPDATE files SET size"):
                raise sqlite3.OperationalError("disco cheio")
            return real.execute(sql, *a)

    idx._conn = Quebra()
    idx.update(providers=False)
    idx._conn = real
    assert real.execute("SELECT count(*) FROM msg").fetchone()[0] == 0
    idx.update(providers=False)
    assert sorted(h.event_id for h in _achar(idx, "agulha")) == ["u0", "u1", "u2"]


def test_busca_nao_espera_passada_do_indice(base, idx, monkeypatch):
    idx.update(providers=False)
    idx.last_pass = 0.0
    solta = threading.Event()
    monkeypatch.setattr(idx, "_update", lambda providers: solta.wait(5))
    t0 = time.monotonic()
    search.search("agulha", {})
    assert time.monotonic() - t0 < 1
    solta.set()


@pytest.mark.parametrize("q", ['"', 'AND', 'OR NOT', 'foo*', 'NEAR(a b)', 'col:x', '^a', '(', "'"])
def test_sintaxe_do_fts_nao_quebra_a_busca(base, idx, q):
    _escrever(base, _linha("texto qualquer", "u1"))
    idx.update(providers=False)
    _achar(idx, q)   # não levanta


def test_acha_por_prefixo_e_sem_acento(base, idx):
    _escrever(base, _linha("Configuração do SQLite3 na sessão", "u1"))
    idx.update(providers=False)
    for q in ("sqlite", "configuracao", "SESSAO", "sessão sqlite"):
        hits = _achar(idx, q)
        assert [h.event_id for h in hits] == ["u1"], q
    assert _achar(idx, "sqlite inexistente") == []
    h = _achar(idx, "sqlite")[0]
    assert (h.project, h.session_id, h.cwd, h.role) == ("-home-u-proj", SID, "/home/u/proj", "user")


def test_append_incremental_so_linha_completa(base, idx):
    f = _escrever(base, _linha("primeira agulha", "u1"))
    idx.update(providers=False)
    parcial = _linha("segunda agulha", "a1", role="assistant")
    with open(f, "a", encoding="utf-8") as fh:
        fh.write(parcial[:-10])
    idx.update(providers=False)
    assert [h.event_id for h in _achar(idx, "agulha")] == ["u1"]
    with open(f, "a", encoding="utf-8") as fh:
        fh.write(parcial[-10:])
    idx.update(providers=False)
    assert sorted(h.event_id for h in _achar(idx, "agulha")) == ["a1", "u1"]


def test_arquivo_truncado_ou_trocado_e_relido(base, idx):
    f = _escrever(base, _linha("velho texto", "u1"), _linha("mais velho", "u2"))
    idx.update(providers=False)
    f.write_text(_linha("novo", "u3"), encoding="utf-8")
    idx.update(providers=False)
    assert _achar(idx, "velho") == []
    assert [h.event_id for h in _achar(idx, "novo")] == ["u3"]
    f.unlink()
    idx.update(providers=False)
    assert _achar(idx, "novo") == []


def test_conversa_interna_do_hangar_fica_fora(base, idx):
    _escrever(base, _linha("PROMPT INTERNO resuma agulha", "u1"))
    _escrever(base, _linha("agulha de verdade", "u2"), sid=SID2)
    idx.update(providers=False)
    assert [h.event_id for h in _achar(idx, "agulha")] == ["u2"]


def test_tres_por_arquivo(base, idx):
    _escrever(base, *[_linha(f"agulha {i}", f"u{i}") for i in range(5)])
    idx.update(providers=False)
    assert [h.event_id for h in _achar(idx, "agulha")] == ["u0", "u1", "u2"]


def test_sem_indice_pronto_usa_rg(base, tmp_path, monkeypatch):
    i = ti.Index(tmp_path / "idx.sqlite3")
    monkeypatch.setattr(ti, "_current", i)
    chamado = []
    monkeypatch.setattr(search, "_search_rg", lambda t, live, limit: chamado.append(t) or [])
    assert not i.ready
    search.search("agulha", {})
    assert chamado == [["agulha"]]


def test_listagem_do_arquivo_igual_com_e_sem_indice(base, tmp_path, monkeypatch):
    _escrever(base, _linha("oi", "u1", cwd="/home/u/proj"))
    _escrever(base, _linha("outra", "u2", cwd="/home/u/proj"), sid=SID2)
    _escrever(base, _linha("x", "u3", cwd="/srv/b"), proj="-srv-b")
    monkeypatch.setattr(ti, "_current", None)
    sem = archive.list_folders()
    conversas_sem = archive.list_conversations("-home-u-proj", set())
    i = ti.Index(tmp_path / "idx.sqlite3")
    i.update(providers=False)
    monkeypatch.setattr(ti, "_current", i)
    assert archive.list_folders() == sem
    assert archive.list_conversations("-home-u-proj", set()) == conversas_sem
    assert set(i.heads()) == {str(base / "-home-u-proj" / f"{SID}.jsonl"),
                              str(base / "-home-u-proj" / f"{SID2}.jsonl"),
                              str(base / "-srv-b" / f"{SID}.jsonl")}


def test_versao_do_esquema_diferente_reconstroi(tmp_path, base):
    p = tmp_path / "idx.sqlite3"
    i = ti.Index(p)
    _escrever(base, _linha("agulha", "u1"))
    i.update(providers=False)
    i._conn.execute("PRAGMA user_version=999")
    i._conn.commit()
    j = ti.Index(p)
    assert not j.ready
    assert j._conn.execute("SELECT count(*) FROM files").fetchone()[0] == 0
