"""Fixture isolada dos efeitos de fundo, sem dados do usuário."""
import argparse, colorsys, json, os, secrets, struct, time, zlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

SESSION = {"name": "effects-proof", "cwd": "/synthetic/effects", "jsonl": "synthetic.jsonl",
           "provider": "claude", "headless": True, "tracked": True, "state": "idle"}
MARKDOWN = "# Efeitos da imagem\n\nArco-íris, retângulo preto e círculo amarelo atrás da conversa."
ROUTES = {"/api/sessions": [SESSION], "/api/config": {"campos": {}}, "/api/cotas": [],
          "/api/archive-por-cwd": [], "/api/engines": {"motores": {}},
          "/api/providers": {"claude": {"disponivel": True}}, "/api/fs/roots": [],
          "/api/claude-configs": [], "/api/model-options": {"models": []}}

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_): pass
    def respond(self, value, status=200):
        body = json.dumps(value).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    def authorized(self):
        if self.headers.get("Authorization") == f"Bearer {self.server.token}": return True
        self.respond({"detail": "fixture token rejected"}, 401)
        return False
    def do_GET(self):
        if not self.authorized(): return
        path = urlparse(self.path).path
        if path.endswith("/events"):
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.end_headers()
            event, data = ("sessions", [SESSION]) if path == "/api/sessions/events" else ("state", {"state": "idle"})
            try:
                self.wfile.write(f"event: {event}\ndata: {json.dumps(data)}\n\n".encode())
                while True:
                    self.wfile.write(b"event: ping\ndata: {}\n\n")
                    self.wfile.flush()
                    time.sleep(1)
            except (BrokenPipeError, ConnectionResetError): pass
        elif path.endswith("/history"):
            self.respond([{"kind": "assistant_msg", "id": "effects-example", "text": MARKDOWN}])
        else: self.respond(ROUTES[path]) if path in ROUTES else self.respond({"detail": "not found"}, 404)
    def do_POST(self):
        if self.authorized(): self.respond({"detail": "fixture is read-only"}, 405)

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--config-dir", type=Path, required=True)
    parser.add_argument("--theme", choices=["dark", "light"], default="dark")
    parser.add_argument("--effect", choices=["none", "dither", "ascii", "halftone", "scanlines", "legacy", "unknown"], default="none")
    parser.add_argument("--background", choices=["image", "plain"], default="image")
    args = parser.parse_args()
    try: args.config_dir.mkdir(parents=True, mode=0o700)
    except FileExistsError: parser.error("use a new isolated config directory")
    config = args.config_dir / "hangar-native"
    config.mkdir(mode=0o700)
    def chunk(kind, data): return struct.pack("!I", len(data)) + kind + data + struct.pack("!I", zlib.crc32(kind + data))
    rainbow = [colorsys.hsv_to_rgb(x / 1920, 1, 1) for x in range(1920)]
    rows = b"".join(b"\0" + b"".join(bytes((0, 0, 0) if 300 <= x < 650 and 200 <= y < 600 else (255, 255, 0) if (x-1400)**2 + (y-400)**2 < 180**2 else tuple(int(c * 255 * (1-y/1080)) for c in rgb)) for x, rgb in enumerate(rainbow)) for y in range(1080))
    png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack("!2I5B", 1920, 1080, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(rows)) + chunk(b"IEND", b"")
    name = "Arco-íris sintético com retângulo preto e círculo amarelo para conferir o nome comprido da imagem de fundo.png"
    (args.config_dir / name).write_bytes(png)
    if args.background == "image":
        (config / "background-image").write_bytes(png)
        (config / "background-name").write_text(name)
    appearance = {"language": "pt", "theme": args.theme, "background": args.background, "transparency": 80, "solidity": 35}
    if args.effect != "legacy": appearance["background_effect"] = args.effect if args.effect != "unknown" else "unsupported-effect"
    (config / "appearance.json").write_text(json.dumps(appearance))
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    server.token = secrets.token_hex(24)
    address = f"http://127.0.0.1:{server.server_port}"
    with (config / "connection.json").open("x") as output:
        os.fchmod(output.fileno(), 0o600)
        json.dump({"address": address, "token": server.token}, output)
    (args.config_dir / f"fixture-{server.server_port}.log").write_text(f"{address}\npid={os.getpid()}\n")
    print(f"{address}\npid={os.getpid()}", flush=True)
    try: server.serve_forever()
    finally: server.server_close()
