"""Fixture da menção: porta aleatória, dados sintéticos e nenhum acesso ao backend real."""
import argparse
import json
import logging
import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

TOKEN = "fixture-task55-only"
SESSIONS = [{"name": name, "cwd": "/fixture/" + name, "jsonl": "/fixture/" + name + ".jsonl",
             "provider": "claude", "headless": True, "tracked": True, "state": "idle"}
            for name in ("task55", "task55-no-git")]
HISTORY = [{"id": "mention-intro", "kind": "assistant_msg", "ts": 1790457600,
            "text": "Use @src para escolher um arquivo. @missing não encontra; @slow demora. A outra sessão está fora de git."}]
PATHS = ["src/main.rs", "src/app.rs", "src/ação.rs", "src/a b.rs", "slow/old.rs", "slow/new.rs"]
STOP = threading.Event()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def reply(self, body, status=200):
        data = json.dumps(body, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        try:
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def authorized(self):
        if self.headers.get("Authorization") == "Bearer " + TOKEN:
            return True
        self.reply({"detail": "Unauthorized"}, 401)
        return False

    def stream(self, name):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        frames = [("sessions", SESSIONS)] if not name else [
            ("state", {"session": name, "state": "idle"}), *[("message", event) for event in HISTORY]]
        try:
            while not STOP.is_set():
                for event, data in frames:
                    self.wfile.write(f"event: {event}\ndata: {json.dumps(data)}\n\n".encode())
                self.wfile.flush()
                STOP.wait(2)
                frames = [("ping", {})]
        except (BrokenPipeError, ConnectionResetError):
            pass

    def do_GET(self):
        if not self.authorized():
            return
        url = urlsplit(self.path)
        path, query = url.path, parse_qs(url.query)
        name = path.split("/")[3] if path.startswith("/api/sessions/") else ""
        logging.info("GET %s q=%s", path, query.get("q", [""])[0])
        if path == "/api/sessions/events":
            return self.stream("")
        if path.endswith("/events"):
            return self.stream(name)
        if path.endswith("/files/search"):
            q = query.get("q", [""])[0]
            if not q or name == "task55-no-git":
                code = "erro_arq_busca_vazia" if not q else "erro_arq_nao_e_repo_git"
                message = "Nao deu pra completar a busca."
                return self.reply({"detail": {"code": code, "params": {"msg": message}, "msg": message}}, 400 if not q else 409)
            if q == "slow":
                STOP.wait(3)
            hits = [p for p in PATHS if q.lower() in p.lower()]
            logging.info("RESULT q=%s hits=%s", q, hits)
            return self.reply({"hits": [{"path": p, "line": None, "text": None} for p in hits], "truncated": False, "mode": "names"})
        if path.endswith("/history"):
            return self.reply(HISTORY)
        if path.endswith("/commands"):
            return self.reply([{"name": "compact", "description": "Compactar conversa", "argument_hint": "instruções"},
                               {"name": "clear", "description": "Limpar conversa", "destructive": True}])
        bodies = {"/api/sessions": SESSIONS, "/api/config": {}, "/api/push/settings": {},
                  "/api/cotacao": {"usd_brl": None}}
        if path in bodies:
            return self.reply(bodies[path])
        return self.reply({"detail": "Not Found"}, 404)

    def do_POST(self):
        if not self.authorized():
            return
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))))
        logging.info("POST %s %s", urlsplit(self.path).path, json.dumps(body, ensure_ascii=False))
        if urlsplit(self.path).path.endswith("/input"):
            return self.reply({"ok": True, "delivered": True})
        return self.reply({"detail": "Not Found"}, 404)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", required=True, type=Path)
    root = parser.parse_args().directory.resolve()
    root.mkdir(parents=True, exist_ok=True)
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    port = server.server_port
    logging.basicConfig(filename=root / f"fixture-{port}.log", level=logging.INFO, format="%(asctime)s %(message)s")
    config = root / "config" / "hangar-native"
    config.mkdir(parents=True, exist_ok=True)
    connection = config / "connection.json"
    connection.write_text(json.dumps({"address": f"http://127.0.0.1:{port}", "token": TOKEN}))
    connection.chmod(0o600)
    (root / "port").write_text(str(port))
    (root / "pid").write_text(str(os.getpid()))
    print(f"port={port}", flush=True)
    try:
        server.serve_forever()
    finally:
        STOP.set()
        server.server_close()
