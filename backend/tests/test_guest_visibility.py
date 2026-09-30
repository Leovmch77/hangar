import asyncio
import json

import pytest

from app import guest_users, push, sse


@pytest.fixture
def ana(tmp_path, monkeypatch):
    monkeypatch.setattr(guest_users, "_path_override", tmp_path / "guests.json")
    monkeypatch.setattr(guest_users, "session_life", lambda n: {"a": "t:1", "dono": "t:2"}.get(n))
    guest_users._reset()
    (tmp_path / "p").mkdir()
    g, _ = guest_users.create("ana", str(tmp_path / "p"), False, False)
    guest_users.claim("a", g.id)
    yield g
    guest_users._reset()


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
