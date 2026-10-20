"""Configuração por contexto, associação ao grupo e concorrência sem herdar outro time."""
import json
from types import SimpleNamespace

import pytest

from app import orq_context as oc, orq_md, orq_papeis as roles, pair
from app.adapters.orq import runs


@pytest.fixture(autouse=True)
def isolated(tmp_path, monkeypatch):
    monkeypatch.setattr(pair, "_pair_dir", lambda: tmp_path)
    monkeypatch.setattr(pair, "_arquivo_dir", lambda: tmp_path / "archive")
    monkeypatch.setattr(oc, "identity", lambda name: "identity:" + name)
    monkeypatch.setattr(oc, "active_gid", lambda name: None)
    monkeypatch.setattr(runs, "group_phase", lambda gid: None)


def _orq_sidecar(name, gid="real"):
    """Membro do grupo `orq` como o Rust o grava."""
    path = pair._pair_dir() / f"{name}.json"
    path.write_text(json.dumps({"peers": [], "task": "mobile", "gid": gid, "harness": {}, "orq": True}))
    return path


def save(name):
    context = oc.resolve(name)
    text = roles.escrever_papel("", roles.Papel("executor", "mobile-t*", "codex", "chosen", "", "",
                                                "2", headless=True, abertura_extra="--sem-jev"))
    return context, oc.write(context, text, 0.0)


def test_two_contexts_ignore_default_and_old_contract():
    roles.regras_path("padrao").write_text("default", encoding="utf-8")
    roles.regras_path("old").write_text(roles.escrever_papel(
        "", roles.Papel("executor", "a", "claude", "old", "opus", "high")), encoding="utf-8")
    a, _ = save("a")
    b = oc.resolve("b")
    assert a.gid != b.gid and not b.grouped
    assert orq_md.ler_arquivo(b.path) == ("", 0.0)
    assert roles.ler(a.path.read_text())[0].conta == "chosen"
    assert oc.resolve("a").path == a.path


def test_recreated_name_does_not_inherit_draft(monkeypatch):
    old, _ = save("same")
    monkeypatch.setattr(oc, "identity", lambda name: "another-life")
    new = oc.resolve("same")
    assert new.gid != old.gid
    assert orq_md.ler_arquivo(new.path) == ("", 0.0)


def test_promotion_preserves_record_and_redirects_source():
    context, mtime = save("planner")
    before = context.path.read_text()
    _orq_sidecar("arbiter")
    oc.promote("planner", "real", mtime)
    grouped = oc.resolve("planner")
    assert grouped.grouped and grouped.gid == "real" and grouped.session_prefix == "planner"
    assert grouped.path.read_text() == before
    assert roles.ler(context.path.read_text()) == []
    assert oc.resolve("planner").path == oc.resolve("arbiter").path == grouped.path
    # Origem e árbitro editam a mesma tabela, com o mtime do registro original.
    text = roles.escrever_papel(before, roles.Papel("revisor", "mobile-review*", "claude", "selected", "", ""))
    oc.write(grouped, text, mtime)
    assert [p.conta for p in roles.ler(oc.resolve("planner").path.read_text())] == ["chosen", "selected"]


def test_promotion_requires_fresh_mtime():
    context, mtime = save("planner")
    _orq_sidecar("arbiter")
    with pytest.raises(orq_md.Conflito):
        oc.promote("planner", "real", 0.0)
    assert context.path.is_file() and not roles.regras_path("real").exists()


def test_competing_contract_is_not_overwritten():
    context, mtime = save("planner")
    target = roles.regras_path("real")
    target.write_text("another contract", encoding="utf-8")
    _orq_sidecar("arbiter")
    with pytest.raises(ValueError, match="outro contrato"):
        oc.promote("planner", "real", mtime)
    assert target.read_text() == "another contract" and context.path.is_file()


def test_write_started_before_promotion_conflicts():
    context, mtime = save("planner")
    text = context.path.read_text()
    _orq_sidecar("arbiter")
    oc.promote("planner", "real", mtime)
    with pytest.raises(orq_md.Conflito):
        oc.write(context, text, mtime)


def test_archived_group_is_not_treated_as_current():
    context, mtime = save("planner")
    link = _orq_sidecar("arbiter")
    oc.promote("planner", "real", mtime)
    link.unlink()
    pair._arquivo_dir().mkdir()
    roles.regras_path("real").rename(pair._arquivo_dir() / "regras-real-20261019-120000.md")
    fresh = oc.resolve("planner")
    assert fresh.gid == context.gid and not fresh.grouped
    assert roles.ler(fresh.path.read_text()) == []
    _, current_mtime = orq_md.ler_arquivo(fresh.path)
    oc.write(fresh, roles.escrever_papel(fresh.path.read_text(), roles.Papel(
        "executor", "new-t*", "claude", "new-choice", "", "")), current_mtime)
    assert oc.resolve("planner").path == fresh.path
    assert roles.ler(fresh.path.read_text())[0].conta == "new-choice"


def test_unknown_group_phase_does_not_clear_record(monkeypatch):
    context, mtime = save("planner")
    link = _orq_sidecar("arbiter")
    oc.promote("planner", "real", mtime)
    link.unlink()
    monkeypatch.setattr(runs, "group_phase", lambda gid: "unknown")
    with pytest.raises(oc.PromotionConflict, match="confirmar o encerramento"):
        oc.resolve("planner")
    assert "hangar-orq-group" in context.path.read_text()


def test_promotion_conflict_preserves_external_source_and_rolls_back_group(monkeypatch):
    context, _ = save("planner")
    before = context.path.read_text()
    original_write = orq_md.gravar

    def external_write(path, text, mtime_lido=None):
        if path == context.path and "hangar-orq-group" in text:
            path.write_text("external editor", encoding="utf-8")
            raise orq_md.Conflito(str(path))
        return original_write(path, text, mtime_lido)

    monkeypatch.setattr(orq_md, "gravar", external_write)
    with pytest.raises(oc.PromotionConflict, match="origem não restaurada"):
        oc.promote("planner", "fresh")
    assert context.path.read_text() == "external editor"
    destinations = [p for p in context.path.parent.glob("regras-*.md") if p != context.path]
    assert len(destinations) == 1 and destinations[0].read_text() == before


def test_promotion_failure_restores_source_exclusively(monkeypatch):
    context, _ = save("planner")
    before = context.path.read_text()
    original_write = orq_md.gravar

    def failed_write(path, text, mtime_lido=None):
        if path == context.path and "hangar-orq-group" in text:
            raise OSError("unable to write pointer")
        return original_write(path, text, mtime_lido)

    monkeypatch.setattr(orq_md, "gravar", failed_write)
    with pytest.raises(oc.PromotionConflict, match="origem restaurada"):
        oc.promote("planner", "fresh")
    assert context.path.read_text() == before


def test_associate_facts_carry_what_the_rust_needs(monkeypatch):
    context, _ = save("planner")
    context.path.write_text("<!-- hangar-orq-group: old -->\n", encoding="utf-8")
    (pair._arquivo_dir()).mkdir()
    (pair._arquivo_dir() / "regras-old-20261019-120000.md").write_text("x", encoding="utf-8")
    monkeypatch.setattr(runs, "group_phase", lambda gid: "live" if gid == "real" else None)
    assert oc.associate_facts("planner", "real") == {"active_gid": None, "draft_gid": context.gid, "groups": {
        "real": {"phase": "live", "archived": False}, "old": {"phase": None, "archived": True}}}
    # Com grupo no sidecar o rascunho não importa: nem a identidade é lida.
    _orq_sidecar("planner")
    monkeypatch.setattr(oc, "identity", lambda name: pytest.fail("identidade lida"))
    assert oc.associate_facts("planner", "real") == {"active_gid": None, "draft_gid": None,
                                                     "groups": {"real": {"phase": "live", "archived": False}}}


def test_actual_pair_link_preserved_without_legacy_identity(monkeypatch):
    _orq_sidecar("legacy")
    monkeypatch.setattr(oc, "identity", lambda name: (_ for _ in ()).throw(oc.IdentityUnavailable("unknown")))
    context = oc.resolve("legacy")
    assert context.gid == "real" and context.grouped


def test_new_orq_group_promotes_founder_record():
    # O que o Rust faz quando o grupo `orq` nasce: grava o sidecar e pede `/internal/orq/promote`.
    context, _ = save("planner")
    _orq_sidecar("planner", "fresh")
    oc.promote("planner", "fresh")
    grouped = oc.resolve("planner")
    assert grouped.grouped and grouped.gid == "fresh"
    assert roles.ler(grouped.path.read_text())[0].conta == "chosen"
    assert roles.ler(context.path.read_text()) == []


def test_sidecar_identity_survives_clear_and_changes_when_recreated(monkeypatch):
    monkeypatch.undo()
    meta = {"key": "first", "session_id": "before"}
    monkeypatch.setattr(oc.orq_identity, "_load_sidecar", lambda directory, name: meta)
    first = oc.identity("same")
    meta["session_id"] = "after"
    assert oc.identity("same") == first
    meta["key"] = "second"
    assert oc.identity("same") != first


def test_tmux_identity_survives_name_change_and_rejects_recycled_server(monkeypatch):
    monkeypatch.undo()
    monkeypatch.setattr(oc.orq_identity, "_load_sidecar", lambda directory, name: {})
    monkeypatch.setattr(oc.orq_identity.subprocess, "run", lambda *args, **kwargs: SimpleNamespace(returncode=0, stdout="42\t$1\t100\n"))
    monkeypatch.setattr(oc.orq_identity, "_process_start", lambda pid: 1.0)
    assert oc.identity("before") == oc.identity("renamed")
    before = oc.identity("same")
    monkeypatch.setattr(oc.orq_identity, "_process_start", lambda pid: 2.0)
    assert oc.identity("same") != before
