import json
import os
import time
from pathlib import Path

from app import archive


def _conv(base: Path, project: str, sid: str, texto: str, mtime: float) -> None:
    d = base / project
    d.mkdir(parents=True, exist_ok=True)
    f = d / f"{sid}.jsonl"
    f.write_text(json.dumps({"type": "user", "uuid": "u1", "cwd": f"/tmp/{project}",
                             "timestamp": "2026-01-01T00:00:00Z",
                             "message": {"role": "user", "content": texto}}) + "\n",
                 encoding="utf-8")
    os.utime(f, (mtime, mtime))


def _isolar(monkeypatch, base: Path) -> None:
    monkeypatch.setattr(archive, "_contas", lambda config_dir=None: [(None, "", base)])
    monkeypatch.setattr(archive, "_conversas_de_outros_providers", lambda: [])
    monkeypatch.setattr(archive, "_heads", lambda: {})


def test_list_recent_ordena_e_corta(tmp_path, monkeypatch):
    base = tmp_path / "projects"
    agora = time.time()
    _conv(base, "-tmp-a", "11111111-1111-1111-1111-111111111111", "velha", agora - 300)
    _conv(base, "-tmp-b", "22222222-2222-2222-2222-222222222222", "nova", agora - 10)
    _conv(base, "-tmp-b", "33333333-3333-3333-3333-333333333333", "meio", agora - 100)
    _isolar(monkeypatch, base)

    out = archive.list_recent(set(), cap=2)

    assert [e.preview for e in out] == ["nova", "meio"]


def test_list_recent_marca_viva(tmp_path, monkeypatch):
    base = tmp_path / "projects"
    _conv(base, "-tmp-a", "11111111-1111-1111-1111-111111111111", "oi", time.time())
    _isolar(monkeypatch, base)
    viva = os.path.realpath(base / "-tmp-a" / "11111111-1111-1111-1111-111111111111.jsonl")

    out = archive.list_recent({viva})

    assert out[0].live is True


def test_list_recent_cap_1_le_so_a_pasta_mais_nova(tmp_path, monkeypatch):
    base = tmp_path / "projects"
    agora = time.time()
    _conv(base, "-tmp-a", "11111111-1111-1111-1111-111111111111", "a", agora - 300)
    _conv(base, "-tmp-b", "22222222-2222-2222-2222-222222222222", "b", agora - 10)
    _conv(base, "-tmp-c", "33333333-3333-3333-3333-333333333333", "c", agora - 100)
    _isolar(monkeypatch, base)
    chamadas = []
    original = archive.list_conversations

    def espia(project, live, cap=100, **kw):
        chamadas.append((project, cap))
        return original(project, live, cap=cap, **kw)

    monkeypatch.setattr(archive, "list_conversations", espia)

    out = archive.list_recent(set(), cap=1)

    assert chamadas == [("-tmp-b", 1)]
    assert [e.preview for e in out] == ["b"]


def test_list_recent_ordena_entre_pastas(tmp_path, monkeypatch):
    base = tmp_path / "projects"
    agora = time.time()
    _conv(base, "-tmp-a", "11111111-1111-1111-1111-111111111111", "a1", agora - 10)
    _conv(base, "-tmp-b", "22222222-2222-2222-2222-222222222222", "b1", agora - 20)
    _conv(base, "-tmp-a", "33333333-3333-3333-3333-333333333333", "a2", agora - 30)
    _conv(base, "-tmp-b", "44444444-4444-4444-4444-444444444444", "b2", agora - 40)
    _isolar(monkeypatch, base)

    out = archive.list_recent(set(), cap=3)

    assert [e.preview for e in out] == ["a1", "b1", "a2"]
