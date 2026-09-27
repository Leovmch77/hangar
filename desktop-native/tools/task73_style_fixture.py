"""Fixture isolada do estilo: sessão e credencial inteiramente sintéticas."""
import argparse, json, os, secrets, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

SESSION = {"name": "style-proof — sessão sintética com nome comprido para conferir a barra lateral compacta",
           "cwd": "/synthetic/style", "jsonl": "synthetic.jsonl", "provider": "claude",
           "headless": True, "tracked": True, "state": "idle"}
HISTORY = [
    {"kind": "user_msg", "id": "u1", "text": "Mostre a comparação do estilo nesta conversa sintética."},
    {"kind": "assistant_msg", "id": "a1", "text": "# Comparação de estilo\n\nTexto com **destaque**, `código` e uma linha longa para comparar a largura da coluna e o espaço entre linhas.\n\n- Texto ajustável\n- Barra lateral compacta\n\n```python\nprint('estilo ajustável')\n```"},
    {"kind": "tool_use", "id": "t1", "tool_use_id": "read1", "tool_name": "Read", "tool_input": {"file_path": "/synthetic/style/example.py"}},
    {"kind": "tool_result", "id": "r1", "tool_use_id": "read1", "result": "print('estilo ajustável')", "is_error": False},
    {"kind": "assistant_msg", "id": "a2", "text": "Comparação pronta. Cada controle continua disponível depois de aplicar o estilo."},
]
ROUTES = {"/api/sessions": [SESSION], "/api/config": {"campos": {}}, "/api/cotas": [],
          "/api/archive-por-cwd": [], "/api/engines": {"motores": {}}, "/api/fs/roots": [],
          "/api/providers": {"claude": {"disponivel": True}}, "/api/claude-configs": [],
          "/api/model-options": {"models": []}}

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
    appearance = {"language": "pt", "theme": args.theme, "background": "plain", "font": "mono",
                  "text_size": 120, "line_height": 120, "column": 120, "code_font": "system",
                  "code_size": 30, "tool_look": "classic", "navigation": "sidebar", "sidebar_compact": False}
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
