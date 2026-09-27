"""Fixture da tipografia do terminal: porta aleatória e dados sintéticos."""
import argparse, base64, hashlib, json, os, secrets, struct, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

SESSION = {"name": "terminal-font-proof", "cwd": "/synthetic/terminal", "jsonl": "synthetic.jsonl",
           "provider": "claude", "headless": False, "tracked": True, "state": "idle"}
HISTORY = [
    {"kind": "user_msg", "id": "u1", "text": "Compare a fonte do terminal sem alterar a conversa."},
    {"kind": "assistant_msg", "id": "a1", "text": "# Conversa preservada\n\nEsta linha mantém fonte, tamanho e entrelinha quando a tipografia do terminal muda.\n\n```python\nprint('codigo da conversa preservado')\n```"},
]
ROUTES = {"/api/sessions": [SESSION], "/api/config": {"campos": {}}, "/api/cotas": [],
          "/api/archive-por-cwd": [], "/api/engines": {"motores": {}}, "/api/fs/roots": [],
          "/api/providers": {"claude": {"disponivel": True}}, "/api/claude-configs": [],
          "/api/model-options": {"models": []}}

class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
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
        if self.headers.get("Upgrade", "").lower() == "websocket" and parse_qs(urlparse(self.path).query).get("token") == [self.server.token]: return True
        self.respond({"detail": "fixture token rejected"}, 401)
        return False
    def terminal(self):
        key = self.headers.get("Sec-WebSocket-Key", "")
        accept = base64.b64encode(hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest()).decode()
        self.send_response(101)
        self.send_header("Upgrade", "websocket")
        self.send_header("Connection", "Upgrade")
        self.send_header("Sec-WebSocket-Accept", accept)
        self.end_headers()
        self.server.metrics["connections"] += 1
        def send(opcode, data):
            length = bytes([len(data)]) if len(data) < 126 else bytes([126]) + struct.pack("!H", len(data))
            self.wfile.write(bytes([128 | opcode]) + length + data)
            self.wfile.flush()
        try:
            send(2, Path(__file__).with_name("task62_term_bytes.ansi").read_bytes())
            while header := self.rfile.read(2):
                if len(header) != 2: return
                opcode, length = header[0] & 15, header[1] & 127
                if length == 126: length = struct.unpack("!H", self.rfile.read(2))[0]
                if length == 127: length = struct.unpack("!Q", self.rfile.read(8))[0]
                if not header[1] & 128 or length > 65536: return
                mask = self.rfile.read(4)
                if len(mask) != 4: return
                raw = self.rfile.read(length)
                if len(raw) != length: return
                data = bytes(value ^ mask[i % 4] for i, value in enumerate(raw))
                if opcode == 8: send(8, data[:125]); return
                if opcode == 9: send(10, data); continue
                if opcode == 1:
                    message = json.loads(data)
                    if message.get("t") == "resize":
                        entry = {"cols": message["cols"], "rows": message["rows"]}
                        self.server.metrics["resizes"].append(entry)
                        with self.server.route_log.open("a") as output: output.write(json.dumps(entry) + "\n")
        except (BrokenPipeError, ConnectionResetError, ValueError, struct.error): pass
    def do_GET(self):
        if not self.authorized(): return
        path = urlparse(self.path).path
        with self.server.route_log.open("a") as output: output.write(path + "\n")
        if path == "/proof/ready":
            self.respond({"ready": True, **self.server.metrics})
            return
        if path.endswith("/term") and self.headers.get("Upgrade", "").lower() == "websocket":
            self.terminal()
            return
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
        elif path.endswith("/history"): self.respond(HISTORY)
        else: self.respond(ROUTES[path]) if path in ROUTES else self.respond({"detail": "not found"}, 404)
    def do_POST(self):
        if self.authorized(): self.respond({"detail": "fixture is read-only"}, 405)

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--config-dir", type=Path, required=True)
    parser.add_argument("--theme", choices=["dark", "light"], default="dark")
    args = parser.parse_args()
    try: args.config_dir.mkdir(parents=True, mode=0o700)
    except FileExistsError: parser.error("use a new isolated config directory")
    config = args.config_dir / "hangar-native"
    config.mkdir(mode=0o700)
    appearance = {"language": "pt", "theme": args.theme, "background": "plain", "font": "system",
                  "text_size": 100, "line_height": 100, "column": 100, "code_font": "jet_brains_mono",
                  "code_size": 25, "navigation": "sidebar", "sidebar_compact": False}
    (config / "appearance.json").write_text(json.dumps(appearance))
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    server.token = secrets.token_hex(24)
    server.metrics = {"connections": 0, "resizes": []}
    server.route_log = args.config_dir / f"fixture-{server.server_port}.log"
    address = f"http://127.0.0.1:{server.server_port}"
    with (config / "connection.json").open("x") as output:
        os.fchmod(output.fileno(), 0o600)
        json.dump({"address": address, "token": server.token}, output)
    (args.config_dir / f"fixture-{server.server_port}.log").write_text(f"{address}\npid={os.getpid()}\n")
    print(f"{address}\npid={os.getpid()}", flush=True)
    try: server.serve_forever()
    finally: server.server_close()
