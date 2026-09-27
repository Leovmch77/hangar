#!/usr/bin/env python3
"""Prova da árvore de arquivos: uma sessão com cwd = --repo, servida pelos `filetree`/`filesearch` do backend.

--bind 127.0.0.1 faz o app ler o disco (servidor nesta máquina); o IP de rede da máquina conta como servidor de
fora e força as rotas. App com XDG_CONFIG_HOME=--dir/config. Nenhuma escrita é aceita.
"""
import argparse
import json
import os
from pathlib import Path
import secrets
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "backend"))
from app import filesearch, filetree  # noqa: E402

HISTORY = [
    {"kind": "user_msg", "id": "u1", "text": "Monta a árvore de arquivos no painel direito"},
    {"kind": "assistant_msg", "id": "a1", "text": "## Árvore pronta\n\nA árvore lê o disco quando o servidor é esta máquina e usa as rotas quando não é."},
    {"kind": "user_msg", "id": "u2", "text": "E a busca?"},
    {"kind": "assistant_msg", "id": "a2", "text": "A busca filtra pelo caminho, sem diferença de maiúsculas, e ignora o que o .gitignore esconde."},
    {"kind": "user_msg", "id": "u3", "text": "Mostra o status do git em cada arquivo"},
    {"kind": "assistant_msg", "id": "a3", "text": "Cada nome ganha a cor e a letra do estado: novo, mudado, apagado ou em conflito."},
]


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def respond(self, body, status=200):
        with self.server.log.open("a") as out:
            out.write(json.dumps({"time": time.time(), "method": self.command, "path": self.path, "status": status}) + "\n")
        raw = json.dumps(body, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        try:
            self.wfile.write(raw)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def allowed(self):
        if self.headers.get("Authorization") == f"Bearer {self.server.token}":
            return True
        self.respond({"detail": "Not authenticated"}, 401)
        return False

    def failure(self, error):
        self.respond({"detail": {"code": error.code, "params": {"msg": error.msg}, "msg": error.msg}}, error.status)

    def do_POST(self):
        if not self.allowed(): return
        self.respond({"detail": "fixture: escrita recusada"}, 405)

    def do_GET(self):
        parsed = urlsplit(self.path)
        route, query = parsed.path, {k: v[0] for k, v in parse_qs(parsed.query).items()}
        if not self.allowed(): return
        sessions = [{"name": "arvore-prova", "cwd": self.server.repo, "jsonl": "/fixture/arvore.jsonl", "provider": "claude",
                     "headless": True, "state": "idle", "tracked": True, "branch": "main"}]
        if route.endswith("/events"):
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.end_headers()
            event, body = ("sessions", sessions) if route == "/api/sessions/events" else ("state", {"state": "idle", "session": route.split("/")[-2]})
            try:
                while True:
                    self.wfile.write(f"event: {event}\ndata: {json.dumps(body)}\n\n".encode())
                    self.wfile.flush()
                    event, body = "ping", {}
                    time.sleep(2)
            except (BrokenPipeError, ConnectionResetError):
                return
        if route == "/api/sessions": return self.respond(sessions)
        if route == "/api/config": return self.respond({"campos": {}, "somente_leitura": {}, "variaveis_env": []})
        if route.endswith("/history"): return self.respond(HISTORY)
        if route.endswith("/commands"): return self.respond([])
        try:
            if route.endswith("/files/list"):
                return self.respond(filetree.list_dir(self.server.repo, query.get("path"), query.get("so_modificados", "true") == "true"))
            if route.endswith("/files/read"): return self.respond(filetree.read_file(self.server.repo, query.get("path", "")))
            if route.endswith("/files/search"): return self.respond(filesearch.search(self.server.repo, query.get("q", ""), query.get("mode", "names")))
        except (filetree.FileError, filesearch.SearchError) as error:
            return self.failure(error)
        self.respond({"detail": "fixture: rota não configurada"}, 404)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dir", type=Path, required=True)
    parser.add_argument("--repo", type=Path, required=True)
    parser.add_argument("--bind", default="127.0.0.1")
    args = parser.parse_args()
    args.dir = args.dir.resolve()
    os.umask(0o077)
    config = args.dir / "config" / "hangar-native"
    config.mkdir(parents=True, exist_ok=True)
    server = ThreadingHTTPServer((args.bind, 0), Handler)
    server.token, server.repo = secrets.token_hex(24), str(args.repo.resolve())
    server.log = args.dir / f"fixture-{server.server_port}.log"
    address = f"http://{args.bind}:{server.server_port}"
    (config / "connection.json").write_text(json.dumps({"address": address, "token": server.token}))
    (config / "appearance.json").write_text(json.dumps({"theme": "dark", "language": "pt"}))
    print(json.dumps({"pid": os.getpid(), "address": address, "config": str(config.parent)}), flush=True)
    server.serve_forever()
