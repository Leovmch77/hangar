#!/usr/bin/env python3
"""Fixture isolada de criação e primeiro envio; nunca encaminha ao backend."""
import argparse
import json
import logging
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

CASES = ("success", "input-failed", "create-failed", "delayed")
ROOT = "/fixture/projects"
SESSION = {"name": "fixture-chat", "cwd": f"{ROOT}/hangar", "jsonl": "/fixture/chat.jsonl",
           "provider": "claude", "headless": True, "tracked": True, "state": "idle"}
MODELS = {"kind": "claude", "engine": None, "reduced": False,
          "models": [{"id": key, "name": name, "desc": "", "active": key == "default"}
                     for key, name in (("default", "Default"), ("opus", "Opus"), ("sonnet", "Sonnet"))]}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def reply(self, body, status=200):
        payload = json.dumps(body, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        try:
            self.wfile.write(payload)
        except (BrokenPipeError, ConnectionResetError):
            logging.info("cliente encerrou o pedido")

    def error(self, code, message, status):
        self.reply({"detail": {"code": code, "params": {}, "msg": message}}, status)

    def do_GET(self):
        url = urlsplit(self.path)
        path, query = url.path, parse_qs(url.query)
        logging.info("GET %s", path)
        name = path.split("/")[3] if path.startswith("/api/sessions/") else ""
        session_path = f"/api/sessions/{name}"
        with self.server.lock:
            sessions = list(self.server.sessions.values())
            exists = name in self.server.sessions
        if path == "/api/sessions/events" or (exists and path == session_path + "/events"):
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            previous = None
            try:
                while True:
                    with self.server.lock:
                        data = list(self.server.sessions.values()) if path == "/api/sessions/events" else {
                            "session": name, "state": "idle", "headless": True, "claude_permission_mode": "acceptEdits"}
                    encoded = json.dumps(data)
                    event = "sessions" if path == "/api/sessions/events" else "state"
                    if encoded != previous:
                        self.wfile.write(f"event: {event}\ndata: {encoded}\n\n".encode())
                        previous = encoded
                    else:
                        self.wfile.write(b"event: ping\ndata: {}\n\n")
                    self.wfile.flush()
                    time.sleep(.5)
            except (BrokenPipeError, ConnectionResetError):
                return
        if path == "/api/fs/scan":
            root = query.get("root", [""])[0]
            folder = query.get("path", [root])[0]
            if root != ROOT or folder not in (ROOT, f"{ROOT}/hangar", f"{ROOT}/website"):
                return self.reply({"detail": "path not found"}, 404)
            entries = [{"name": name, "path": f"{ROOT}/{name}", "is_git": True,
                        "has_claude_md": True, "mtime": 1790438400.0}
                       for name in ("hangar", "website")] if folder == ROOT else []
            return self.reply({"entries": entries, "error": None})
        bodies = {
            "/api/sessions": sessions,
            "/api/sessions/creation-progress": {"step": "starting", "elapsed": 1},
            "/api/archive-por-cwd": [],
            "/api/fs/roots": [{"name": "projects", "path": ROOT}],
            "/api/claude-configs": [{"path": "/fixture/.claude", "label": "default", "active": True}],
            "/api/model-options": MODELS,
            "/api/providers": {p: {"disponivel": p == "claude", "motivo": None}
                               for p in ("claude", "codex", "pi", "kimi", "omp")},
            "/api/engines": {"motores": {}, "arquivo_corrompido": False, "arquivo_caminho": "/fixture/engines.json"},
            "/api/cotas": [],
            "/api/push/settings": {"muted": [], "quiet_hours": None},
            "/api/config": {"campos": {key: {"valor": value, "definido": True, "origem": "env"}
                                        for key, value in (("jev_api_key", ""), ("jev_padrao", False),
                                                           ("notify_finished", False), ("notify_dead", False), ("finish_min_seconds", 45))},
                            "somente_leitura": {"port": self.server.server_port, "lan_bind_ip": "127.0.0.1",
                                                "server_id": "task70", "public_url": "", "terminal_panel": False,
                                                "traducao_pensamento": False, "terminal_origem_ok": True, "versao": "fixture"},
                            "variaveis_env": []},
        }
        if exists:
            bodies.update({session_path + "/history": self.server.history.get(name, []),
                           session_path + "/subagents": [], session_path + "/commands": [],
                           session_path + "/model/options": {**MODELS, "effort": "high"}})
        self.reply(bodies[path]) if path in bodies else self.reply({"detail": "Not Found"}, 404)

    def do_POST(self):
        path = urlsplit(self.path).path
        case = self.server.control.read_text().strip()
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))))
        logging.info("POST %s caso=%s", path, case)
        if path == "/api/sessions":
            if case == "delayed":
                time.sleep(self.server.delay)
            if case == "create-failed":
                return self.error("erro_criacao_sessao", "falha ao criar sessao no tmux", 409)
            name = body["name"]
            session = {**SESSION, "name": name, "cwd": body["cwd"], "jsonl": f"/fixture/{name}.jsonl"}
            with self.server.lock:
                if name in self.server.sessions:
                    return self.error("erro_nome_em_uso", "ja existe uma sessao com esse nome", 409)
                self.server.sessions[name] = session
            return self.reply(session)
        if path.startswith("/api/sessions/") and path.endswith("/input"):
            name = path.split("/")[3]
            if case == "input-failed" or name not in self.server.sessions:
                return self.error("erro_sessao_recado_nao_enfileirado", "sessão não encontrada — recado NÃO enfileirado", 404)
            with self.server.lock:
                self.server.history.setdefault(name, []).append({"id": f"first-{name}", "kind": "user_msg",
                                                                "text": body["text"], "ts": 1790445600.0})
            return self.reply({"ok": True, "delivered": True})
        self.reply({"detail": "Method Not Allowed"}, 405)

    def do_PUT(self):
        self.reply({"detail": "Method Not Allowed"}, 405)

    do_PATCH = do_DELETE = do_PUT


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--case", choices=CASES, default="success")
    parser.add_argument("--delay", type=float, default=8)
    args = parser.parse_args()
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    args.output.mkdir(parents=True, exist_ok=True)
    port = server.server_port
    server.control = args.output / f"fixture-{port}.case"
    server.control.write_text(args.case + "\n")
    server.delay = max(0, args.delay)
    server.lock = threading.Lock()
    server.sessions = {SESSION["name"]: SESSION} if args.case == "delayed" else {}
    server.history = {}
    logging.basicConfig(filename=args.output / f"fixture-{port}.log", level=logging.INFO,
                        format="%(asctime)s %(message)s")
    print(f"http://127.0.0.1:{port} control={server.control}", flush=True)
    server.serve_forever()
