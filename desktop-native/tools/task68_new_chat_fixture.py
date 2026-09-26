#!/usr/bin/env python3
"""Fixture isolada da tela Nova conversa; nunca encaminha pedidos ao backend."""
import argparse
import json
import logging
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path, PurePosixPath
from urllib.parse import parse_qs, urlsplit


CASES = ("normal", "no-roots", "loading-accounts", "loading-models", "error-accounts", "error-models", "composer")
ROOT = "/fixture/projects"
SESSION = {"name": "fixture-chat", "cwd": f"{ROOT}/hangar", "jsonl": "/fixture/chat.jsonl",
           "provider": "claude", "headless": True, "tracked": True, "state": "idle"}
STATE = {"session": SESSION["name"], "state": "idle", "headless": True, "claude_permission_mode": "acceptEdits"}
ACCOUNTS = [{"path": "/fixture/.claude", "label": "default", "active": True},
            {"path": "/fixture/.claude-work", "label": "work", "active": False}]
MODELS = {"kind": "claude", "engine": None, "reduced": False,
          "models": [{"id": key, "name": name, "desc": "", "active": key == "default"}
                     for key, name in (("default", "Default"), ("opus", "Opus"),
                                       ("sonnet", "Sonnet"), ("haiku", "Haiku"))]}
BUSY = {"detail": {"code": "erro_muitas_tentativas", "params": {}, "msg": "muitas tentativas — aguarde"}}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def reply(self, body, status=200):
        payload = json.dumps(body, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        if status == 429:
            self.send_header("Retry-After", "30")
        self.end_headers()
        try:
            self.wfile.write(payload)
        except (BrokenPipeError, ConnectionResetError):
            logging.info("cliente encerrou o pedido")

    def do_GET(self):
        url = urlsplit(self.path)
        path, query = url.path, parse_qs(url.query)
        case = self.server.control.read_text().strip()
        logging.info("GET %s caso=%s", path, case)
        if case not in CASES:
            return self.reply({"detail": "invalid fixture case"}, 400)
        sessions = [SESSION] if case == "composer" else []
        session_path = f"/api/sessions/{SESSION['name']}"
        if path == "/api/sessions/events" or (case == "composer" and path == session_path + "/events"):
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            try:
                event, data = ("sessions", sessions) if path == "/api/sessions/events" else ("state", STATE)
                self.wfile.write(f"event: {event}\ndata: {json.dumps(data)}\n\n".encode())
                self.wfile.flush()
                while True:
                    time.sleep(8)
                    self.wfile.write(b"event: ping\ndata: {}\n\n")
                    self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                return
        target = {"/api/claude-configs": "accounts", "/api/model-options": "models"}.get(path)
        if target and case == f"loading-{target}":
            time.sleep(self.server.delay)
        if target and case == f"error-{target}":
            return self.reply(BUSY, 429)
        if path == "/api/fs/scan":
            root = query.get("root", [""])[0]
            folder = query.get("path", [root])[0]
            if root != ROOT or case == "no-roots":
                return self.reply({"detail": "root not allowed"}, 403)
            if not PurePosixPath(folder).is_relative_to(ROOT) or ".." in PurePosixPath(folder).parts:
                return self.reply({"detail": "path escapes its root"}, 400)
            if folder not in (ROOT, f"{ROOT}/hangar", f"{ROOT}/website"):
                return self.reply({"detail": "path not found"}, 404)
            entries = [{"name": name, "path": f"{ROOT}/{name}", "is_git": True,
                        "has_claude_md": name == "hangar", "mtime": 1790438400.0}
                       for name in ("hangar", "website")] if folder == ROOT else []
            return self.reply({"entries": entries, "error": None})
        bodies = {
            "/api/sessions": sessions,
            "/api/archive-por-cwd": [],
            "/api/fs/roots": [] if case == "no-roots" else [{"name": "projects", "path": ROOT}],
            "/api/claude-configs": ACCOUNTS,
            "/api/model-options": MODELS,
            "/api/providers": {p: {"disponivel": p == "claude", "motivo": None if p == "claude" else "nao_encontrado"}
                               for p in ("claude", "codex", "pi", "kimi", "omp")},
            "/api/engines": {"motores": {}, "arquivo_corrompido": False, "arquivo_caminho": "/fixture/engines.json"},
            "/api/cotas": [],
            "/api/push/settings": {"muted": [], "quiet_hours": None},
            "/api/config": {"campos": {key: {"valor": value, "definido": bool(value) if key.endswith("_key") else True, "origem": "env"}
                                        for key, value in (("jev_api_key", ""), ("jev_padrao", False),
                                                           ("notify_finished", False), ("notify_dead", False), ("finish_min_seconds", 45))},
                            "somente_leitura": {"port": self.server.server_port, "lan_bind_ip": "127.0.0.1",
                                                "server_id": "task68", "public_url": "", "terminal_panel": False,
                                                "traducao_pensamento": False, "terminal_origem_ok": True, "versao": "fixture"},
                            "variaveis_env": []},
        }
        if case == "composer":
            bodies.update({session_path + "/history": [], session_path + "/subagents": [],
                           session_path + "/model/options": {"kind": "claude", "engine": None, "effort": "high", "models": MODELS["models"]},
                           session_path + "/commands": [{"name": "compact", "display": "/compact", "source": "builtin",
                                                         "description": "Resume e compacta o contexto", "argumentHint": None, "destructive": True}]})
        self.reply(bodies[path]) if path in bodies else self.reply({"detail": "Not Found"}, 404)

    def do_POST(self):
        logging.warning("mutação recusada: %s %s", self.command, urlsplit(self.path).path)
        self.reply({"detail": "Method Not Allowed"}, 405)

    do_PUT = do_PATCH = do_DELETE = do_POST


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--case", choices=CASES, default="normal")
    parser.add_argument("--delay", type=float, default=10)
    args = parser.parse_args()
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    directory = args.output
    directory.mkdir(parents=True, exist_ok=True)
    port = server.server_port
    server.control = directory / f"fixture-{port}.case"
    server.control.write_text(args.case + "\n")
    server.delay = max(0, args.delay)
    logging.basicConfig(filename=directory / f"fixture-{port}.log", level=logging.INFO,
                        format="%(asctime)s %(message)s")
    print(f"http://127.0.0.1:{port} control={server.control}", flush=True)
    server.serve_forever()
