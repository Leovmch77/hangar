"""Fixture isolada da aparência; porta aleatória e configuração só na pasta indicada."""

import argparse
import json
import secrets
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse


MARKDOWN = "# Fundo da conversa\n\nA imagem fica atrás deste texto. Confira também a barra lateral e o painel à direita."
EVENTS = [{"kind": "assistant_msg", "id": "background-example", "text": MARKDOWN}]
SESSION = {"name": "background-proof", "cwd": "/synthetic/background", "jsonl": "synthetic.jsonl",
           "provider": "claude", "headless": True, "tracked": True, "state": "idle"}


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
        if path == "/api/desktop/wallpaper":
            self.send_response(200)
            self.send_header("Content-Type", "image/png")
            self.send_header("Content-Length", str(len(self.server.png)))
            self.end_headers()
            self.wfile.write(self.server.png)
        elif path.endswith("/events"):
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
                "/api/fs/roots": [{"name": "Synthetic", "path": "/synthetic"}],
                "/api/fs/scan": {"entries": [{"name": "background", "path": "/synthetic/background", "is_git": True}]},
                "/api/providers": {"claude": {"disponivel": True}},
                "/api/claude-configs": [{"path": "/synthetic/.claude", "label": "Synthetic", "active": True}],
                "/api/model-options": {"models": [{"id": "synthetic", "name": "Synthetic"}]},
                "/api/engines": {"motores": {}},
                "/api/config": {"campos": {}},
                "/api/cotas": [],
                "/api/archive-por-cwd": [],
            }
            self.respond(routes[path]) if path in routes else self.respond({"detail": "not found"}, 404)

    def do_POST(self):
        if not self.authorized():
            return
        self.respond({"detail": "fixture is read-only"}, 405)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--config-dir", type=Path, required=True)
    parser.add_argument("--theme", choices=["dark", "light"], default="dark")
    parser.add_argument("--panels", choices=["attached", "floating"], default="attached")
    parser.add_argument("--scope", choices=["chat", "everywhere", "legacy"], default="everywhere")
    parser.add_argument("--background", choices=["plain", "image", "texture", "light", "desktop"], default="image")
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
    appearance = {"language": "pt", "theme": args.theme, "panels": args.panels,
                  "background": args.background, "transparency": 80, "solidity": 35}
    if args.scope != "legacy":
        appearance["background_scope"] = args.scope
    (config / "appearance.json").write_text(json.dumps(appearance))
    # PNG sintético com regiões contrastantes, sem imagem nem segredo do usuário.
    import struct
    import zlib
    def chunk(kind, data):
        return struct.pack("!I", len(data)) + kind + data + struct.pack("!I", zlib.crc32(kind + data))
    rows = b"".join(b"\0" + b"".join(bytes((40 + x // 2, 70 + y // 2, 180 if x < 160 else 70))
                                    for x in range(320)) for y in range(180))
    png = (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack("!2I5B", 320, 180, 8, 2, 0, 0, 0))
           + chunk(b"IDAT", zlib.compress(rows)) + chunk(b"IEND", b""))
    server.png = png
    name = "Paisagem sintética para conferir o nome comprido da imagem de fundo sem deslocar os botões.png"
    (args.config_dir / name).write_bytes(png)
    (args.config_dir / "invalida.png").write_text("not an image")
    if args.background == "image":
        (config / "background-image").write_bytes(png)
        (config / "background-name").write_text(name)
    log = args.config_dir / f"fixture-{server.server_port}.log"
    log.write_text(f"address={address}\n")
    print(address, flush=True)
    try:
        server.serve_forever()
    finally:
        server.server_close()
