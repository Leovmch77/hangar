#!/usr/bin/env python3
"""Dois servidores isolados para provar a troca da nova conversa."""
import argparse
import json
import logging
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit


ERROR = {"detail": {"code": "erro_servidor_indisponivel", "params": {}, "msg": "Servidor indisponível"}}
SESSION = {"name": "fixture-chat", "cwd": "/fixture/first/project", "jsonl": "/fixture/chat.jsonl",
           "provider": "claude", "headless": True, "tracked": True, "state": "idle"}


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
            pass

    def do_GET(self):
        path = urlsplit(self.path).path
        server = self.server
        logging.getLogger(server.name).info("GET %s", path)
        mode = server.control.read_text().strip()
        if mode == "offline":
            return self.reply(ERROR, 503)
        if self.headers.get("Authorization") != f"Bearer fixture-{server.name}":
            return self.reply({"detail": {"code": "erro_nao_autorizado", "params": {}, "msg": "unauthorized"}}, 401)
        if mode == "slow" and server.name == "second" and path == "/api/sessions":
            time.sleep(8)
        session_path = f"/api/sessions/{SESSION['name']}"
        if path in ("/api/sessions/events", session_path + "/events"):
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.end_headers()
            try:
                event = "sessions" if path == "/api/sessions/events" else "state"
                data = [SESSION] if server.name == "first" else []
                if event == "state":
                    data = {"session": SESSION["name"], "state": "idle", "headless": True}
                self.wfile.write(f"event: {event}\ndata: {json.dumps(data)}\n\n".encode())
                self.wfile.flush()
                while True:
                    time.sleep(8)
                    self.wfile.write(b"event: ping\ndata: {}\n\n")
                    self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                return
        if path == f"/api/peers/{server.peer_name}/token":
            return self.reply({"token": f"fixture-{server.peer_name}"})
        root = f"/fixture/{server.name}"
        bodies = {
            "/api/sessions": [SESSION] if server.name == "first" else [],
            "/api/peers": [{"id": server.peer_name, "base_url": server.peer_url, "token": "••••", "enabled": True}],
            "/api/fs/roots": [{"name": server.name, "path": root}],
            "/api/fs/scan": {"entries": [], "error": None},
            "/api/claude-configs": [{"path": f"{root}/.claude", "label": server.name, "active": True}],
            "/api/model-options": {"kind": "claude", "engine": None, "reduced": False,
                                   "models": [{"id": "default", "name": "Default", "desc": "", "active": True}]},
            "/api/providers": {"claude": {"disponivel": True, "motivo": None}},
            "/api/config": {"campos": {}, "somente_leitura": {"server_id": server.name}, "variaveis_env": []},
            "/api/push/settings": {"muted": [], "quiet_hours": None},
            session_path + "/history": [],
            session_path + "/subagents": [],
            session_path + "/commands": [],
            session_path + "/model/options": {"kind": "claude", "engine": None, "effort": "high", "models": []},
        }
        return self.reply(bodies[path]) if path in bodies else self.reply({"detail": "Not Found"}, 404)

    def do_POST(self):
        logging.getLogger(self.server.name).warning("mutação recusada: %s", urlsplit(self.path).path)
        self.reply({"detail": "Method Not Allowed"}, 405)

    do_PUT = do_PATCH = do_DELETE = do_POST


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    servers = [ThreadingHTTPServer(("127.0.0.1", 0), Handler) for _ in range(2)]
    for server, name, peer in zip(servers, ("first", "second"), reversed(servers)):
        server.name = name
        server.peer_name = "second" if name == "first" else "first"
        server.peer_url = f"http://127.0.0.1:{peer.server_port}"
        server.control = args.output / f"fixture-{server.server_port}.case"
        server.control.write_text("online\n")
        logger = logging.getLogger(name)
        logger.setLevel(logging.INFO)
        handler = logging.FileHandler(args.output / f"fixture-{server.server_port}.log")
        handler.setFormatter(logging.Formatter("%(asctime)s %(message)s"))
        logger.addHandler(handler)
    print(json.dumps({server.name: {"url": f"http://127.0.0.1:{server.server_port}", "control": str(server.control)}
                      for server in servers}), flush=True)
    threading.Thread(target=servers[1].serve_forever, daemon=True).start()
    servers[0].serve_forever()
