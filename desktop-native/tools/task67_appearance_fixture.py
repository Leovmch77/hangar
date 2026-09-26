"""Fixture isolada da aparência; porta aleatória e configuração só na pasta indicada."""

import argparse
import json
import secrets
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse


MARKDOWN = '''Inline `let size = 13;` keeps a fixed-width font.

```rust
fn greeting(name: &str) -> String {
    format!("Hello, {name}!")
}
let width = 780;
```

| Setting | Value | Scope |
| --- | --- | --- |
| `code_size` | `12.5 px` | Code and diffs |
| Conversation width | `780 px` | Messages and composer |
'''
EVENTS = [{"kind": "assistant_msg", "id": "font-example", "text": MARKDOWN}]
SESSION = {"name": "font-proof", "cwd": "/synthetic/fonts", "jsonl": "synthetic.jsonl",
           "provider": "claude", "headless": True, "tracked": True, "state": "idle",
           "git_dirty": 1, "git_added": 1, "git_removed": 1}
DIFF = "@@ -1 +1 @@\n-let width = 780;\n+let width = 1170;"


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def respond(self, value, status=200, text=False):
        body = (value if text else json.dumps(value)).encode()
        self.send_response(status)
        self.send_header("Content-Type", "text/plain" if text else "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def authorized(self):
        if self.headers.get("Authorization") == f"Bearer {self.server.token}":
            return True
        self.respond({"detail": "fixture token rejected"}, 401)
        return False

    def do_GET(self):
        if not self.authorized():
            return
        path = urlparse(self.path).path
        if path.endswith("/events"):
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.end_headers()
            event, value = ("sessions", [SESSION]) if path == "/api/sessions/events" else ("state", {"state": "idle"})
            try:
                self.wfile.write(f"event: {event}\ndata: {json.dumps(value)}\n\n".encode())
                while True:
                    self.wfile.write(b"event: ping\ndata: {}\n\n")
                    self.wfile.flush()
                    time.sleep(1)
            except (BrokenPipeError, ConnectionResetError):
                return
        elif path.endswith("/history"):
            self.respond(EVENTS)
        elif path.endswith("/bastao"):
            self.respond(MARKDOWN, text=True)
        else:
            routes = {
                "/api/sessions": [SESSION],
                "/api/sessions/font-proof/git/files": {"files": [{"path": "sample.rs", "code": "M", "added": 1, "removed": 1}]},
                "/api/fs/roots": [{"name": "Synthetic", "path": "/synthetic"}],
                "/api/fs/scan": {"entries": [{"name": "fonts", "path": "/synthetic/fonts", "is_git": True}]},
                "/api/providers": {"claude": {"disponivel": True}},
                "/api/claude-configs": [{"path": "/synthetic/.claude", "label": "Synthetic", "active": True}],
                "/api/model-options": {"models": [{"id": "synthetic", "name": "Synthetic"}]},
                "/api/engines": {"motores": {}},
                "/api/config": {"campos": {}},
                "/api/cotas": [],
                "/api/archive-por-cwd": [{"project": "synthetic", "session_id": "archive-fonts", "preview": "Code sample", "provider": "claude", "live": False}],
            }
            self.respond(routes[path]) if path in routes else self.respond({"detail": "not found"}, 404)

    def do_POST(self):
        if not self.authorized():
            return
        if urlparse(self.path).path == "/api/sessions/font-proof/git/diff":
            self.respond({"diff": DIFF, "truncated": False})
        else:
            self.respond({"detail": "fixture is read-only"}, 405)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--config-dir", type=Path, required=True)
    args = parser.parse_args()
    config = args.config_dir.resolve() / "hangar-native"
    config.mkdir(parents=True, exist_ok=True, mode=0o700)
    connection = config / "connection.json"
    if connection.exists():
        parser.error("use a new isolated config directory")
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    server.token = secrets.token_hex(24)
    address = f"http://127.0.0.1:{server.server_port}"
    with connection.open("x") as output:
        connection.chmod(0o600)
        json.dump({"address": address, "token": server.token}, output)
    (config / "appearance.json").write_text(json.dumps({"language": "en", "theme": "dark"}))
    print(address, flush=True)
    try:
        server.serve_forever()
    finally:
        server.server_close()
