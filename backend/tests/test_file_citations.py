import json
from types import SimpleNamespace
from urllib.parse import quote

import pytest
from fastapi.testclient import TestClient

from app import api
from app.config import settings
from app.transcript import citation_cwds


@pytest.mark.parametrize('filename,media', [
    ('Relatório final.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'),
    ('Relatório final.pdf', 'application/pdf'),
])
def test_document_download_keeps_bytes_name_and_citation_auth(tmp_path, monkeypatch, filename, media):
    target = tmp_path / filename
    content = b'original-document-bytes\x00\xff'
    target.write_bytes(content)
    transcript = tmp_path / 'session.jsonl'
    transcript.write_text(json.dumps({'cwd': str(tmp_path), 'message': {'content': str(target)}},
                                    ensure_ascii=False) + '\n', encoding='utf-8')
    monkeypatch.setattr(api, '_cached_info_sync', lambda name: SimpleNamespace(
        name=name, cwd=str(tmp_path), jsonl=str(transcript),
    ))
    monkeypatch.setattr(settings, 'auth_token', 'document-test-token')
    client = TestClient(api.app)
    headers = {'Authorization': 'Bearer document-test-token'}
    inline = client.get('/api/sessions/s/file', headers=headers, params={'path': str(target)})
    assert inline.status_code == 200, inline.text
    downloaded = client.get('/api/sessions/s/file', headers={**headers, 'If-None-Match': inline.headers['etag']},
                            params={'path': str(target), 'download': 'true'})
    assert downloaded.status_code == 200
    assert downloaded.content == content
    assert downloaded.headers['content-type'] == media
    assert downloaded.headers['content-disposition'] == f"attachment; filename*=utf-8''{quote(filename)}"
    assert 'content-disposition' not in inline.headers
    assert client.get('/api/sessions/s/file', params={'path': str(target), 'download': 'true'}).status_code == 401
    uncited = tmp_path / 'not-cited.docx'
    uncited.write_bytes(content)
    assert client.get('/api/sessions/s/file', headers=headers,
                      params={'path': str(uncited), 'download': 'true'}).status_code == 403


def test_citation_uses_cwd_from_the_line_that_mentions_it(tmp_path):
    transcript = tmp_path / "session.jsonl"
    transcript.write_text(
        json.dumps({"cwd": "/project", "message": {"content": "src/a.ts"}}) + "\n"
        + json.dumps({"cwd": "/other", "message": {"content": "outro arquivo"}}) + "\n"
        + json.dumps({"snapshot": {"src/a.ts": {}}}) + "\n",
        encoding="utf-8",
    )
    assert citation_cwds(transcript, ["src/a.ts", "ausente.ts"]) == {"src/a.ts": ["/project"]}


def test_longer_citation_does_not_cite_its_prefix(tmp_path):
    # `config.json.bak` citado sozinho não cita `config.json`: o mais longo vence na mesma posição.
    transcript = tmp_path / "session.jsonl"
    transcript.write_text(json.dumps({"cwd": "/repo", "message": {"content": "/home/x/config.json.bak"}}) + "\n",
                          encoding="utf-8")
    got = citation_cwds(transcript, ["/home/x/config.json", "/home/x/config.json.bak"])
    assert got == {"/home/x/config.json.bak": ["/repo"]}


def test_relative_citation_uses_transcript_cwd_and_opens_in_file_endpoint(tmp_path, monkeypatch):
    born = tmp_path / "born"
    current = tmp_path / "project"
    born.mkdir()
    (current / "frontend").mkdir(parents=True)
    target = current / "frontend" / "vitest.config.ts"
    target.write_text("export default { test: { maxWorkers: 2 } }", encoding="utf-8")
    transcript = tmp_path / "session.jsonl"
    transcript.write_text(json.dumps({
        "cwd": str(current),
        "message": {"content": "frontend/vitest.config.ts"},
    }) + "\n", encoding="utf-8")
    monkeypatch.setattr(api, "_cached_info_sync", lambda name: SimpleNamespace(
        name=name, cwd=str(born), jsonl=str(transcript),
    ))
    settings.auth_token = "secret"
    client = TestClient(api.app)
    headers = {"Authorization": "Bearer secret"}

    resolved = client.post("/api/sessions/s/files/resolver", headers=headers,
                           json={"caminhos": ["frontend/vitest.config.ts"]})
    assert resolved.status_code == 200
    assert resolved.json()["ok"]["frontend/vitest.config.ts"] == {
        "relativo": None, "real": str(target),
    }
    opened = client.get("/api/sessions/s/file", headers=headers,
                        params={"path": "frontend/vitest.config.ts"})
    assert opened.status_code == 200
    assert "maxWorkers: 2" in opened.text
