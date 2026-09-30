import asyncio
import json

import pytest

from app import guest_users, push, sse


@pytest.fixture
def ana_tok(tmp_path, monkeypatch):
    monkeypatch.setattr(guest_users, "_path_override", tmp_path / "guests.json")
    monkeypatch.setattr(guest_users, "session_life", lambda n: {"a": "t:1", "dono": "t:2"}.get(n))
    guest_users._reset()
    (tmp_path / "p").mkdir()
    g, tok = guest_users.create("ana", str(tmp_path / "p"), False, False)
    guest_users.claim("a", g.id)
    yield g, tok
    guest_users._reset()


@pytest.fixture
def ana(ana_tok):
    return ana_tok[0]


class _FakeRefresher:
    def __init__(self, data):
        self.version, self.errored, self.data, self.shortcuts_data = 1, False, data, None
        self._cond = asyncio.Condition()

    def acquire(self):
        return self._cond

    def release(self):
        pass


def _one_list(monkeypatch, viewer, payload):
    async def run():
        monkeypatch.setattr(sse, "_list_refresher", _FakeRefresher(json.dumps(payload)))
        gen = sse.list_events(ping_secs=60, viewer=viewer)
        ev = await asyncio.wait_for(gen.__anext__(), 2)
        await gen.aclose()
        return json.loads(ev["data"])
    return asyncio.run(run())


def test_owner_list_hides_guest_that_opted_out(ana, monkeypatch):
    names = [x["name"] for x in _one_list(monkeypatch, None, [{"name": "a"}, {"name": "dono"}])]
    assert names == ["dono"]


def test_guest_list_shows_only_own(ana, monkeypatch):
    names = [x["name"] for x in _one_list(monkeypatch, ana, [{"name": "a"}, {"name": "dono"}])]
    assert names == ["a"]


def test_push_suppressed_for_hidden_guest_session(ana, monkeypatch):
    monkeypatch.setattr(push, "is_muted", lambda n: False)
    monkeypatch.setattr(push, "_in_quiet_hours", lambda: False)
    assert push._suppressed("a")
    assert not push._suppressed("dono")


def test_list_sig_changes_when_only_owner_changes():
    from app.models import SessionInfo
    a = SessionInfo(name="a", cwd="/p")
    b = SessionInfo(name="a", cwd="/p", owner="ana")
    assert sse._list_sig([a]) != sse._list_sig([b])


@pytest.fixture
def rest(monkeypatch):
    from fastapi.testclient import TestClient
    from app import api
    from app.models import SessionInfo

    monkeypatch.setattr(api.settings, "auth_token", "owner-token")
    snap = [SessionInfo(name="a", cwd="/p"), SessionInfo(name="dono", cwd="/p")]

    async def as_is(infos=None):
        return infos
    monkeypatch.setattr(api.registry, "list_with_state", as_is)

    def make(cached: bool):
        monkeypatch.setattr(api, "_guardar_snap", lambda: snap)
        monkeypatch.setattr(sse, "recent_list", lambda _age: list(snap) if cached else None)
        return TestClient(api.app)
    return make


def _names(client, tok):
    r = client.get("/api/sessions", headers={"Authorization": f"Bearer {tok}"})
    assert r.status_code == 200, r.text
    return [x["name"] for x in r.json()]


@pytest.mark.parametrize("cached", [False, True])
def test_rest_list_guest_sees_only_own(ana_tok, rest, cached):
    assert _names(rest(cached), ana_tok[1]) == ["a"]


@pytest.mark.parametrize("cached", [False, True])
def test_rest_list_owner_misses_guest_that_opted_out(ana_tok, rest, cached):
    assert _names(rest(cached), "owner-token") == ["dono"]


@pytest.mark.parametrize("cached", [False, True])
def test_rest_list_owner_without_claims_skips_filter(tmp_path, monkeypatch, rest, cached):
    monkeypatch.setattr(guest_users, "_path_override", tmp_path / "guests.json")
    guest_users._reset()

    def boom(*_a, **_k):
        raise AssertionError("filter_visible no caminho do dono sem convidados")
    monkeypatch.setattr(guest_users, "filter_visible", boom)
    assert _names(rest(cached), "owner-token") == ["a", "dono"]
    guest_users._reset()
