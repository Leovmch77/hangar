#!/usr/bin/env python3
"""Fixture SINTÉTICA da busca de conversas (Ctrl+K), de Custos e das Estatísticas de uso. Nenhuma sessão, conversa ou
conta daqui existe de verdade; nada sai deste processo.

- GET /api/sessions (+ SSE): duas sessões vivas, `busca-viva` e `outra-sessao`.
- GET /api/search?q=: um trecho da sessão viva e dois de uma conversa arquivada (`projeto-antigo`); "nada" não acha.
- GET /api/search/context: a mensagem do trecho e as vizinhas.
- POST /api/archive/<projeto>/<id>/resume: "retoma" a arquivada — a sessão `projeto-antigo` passa a existir na lista.
  Cada pedido fica no log (`--dir`/fixture-<porta>.log), que é a prova de que o app chamou a rota certa.
- GET /api/costs: relatório vazio do período pedido (estado vazio), depois de 3 s (estado carregando).
- GET /api/uso: 500 (estado de erro das Estatísticas).

App com XDG_CONFIG_HOME=--dir/config.
"""
import argparse
import json
import os
from pathlib import Path
import secrets
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlsplit

NOW = time.time()
LIVE = [
    {"name": "busca-viva", "cwd": "/fixture/hangar", "jsonl": "/fixture/viva.jsonl", "provider": "claude", "headless": True,
     "state": "idle", "tracked": True, "last_activity": NOW - 120},
    {"name": "outra-sessao", "cwd": "/fixture/outra", "jsonl": "/fixture/outra.jsonl", "provider": "codex", "headless": True,
     "state": "working", "tracked": True, "last_activity": NOW - 30},
]
RESUMED = {"name": "projeto-antigo", "cwd": "/fixture/projeto-antigo", "jsonl": "/fixture/antigo.jsonl", "provider": "claude",
           "headless": True, "state": "idle", "tracked": True, "last_activity": NOW}
HITS = [
    {"project": "-fixture-hangar", "session_id": "viva-1", "session_name": "busca-viva", "cwd": "/fixture/hangar",
     "line": "A paleta de busca abre com Ctrl+K e procura em todas as conversas.", "mtime": NOW - 120, "live": True,
     "role": "assistant", "event_id": "v2", "ts": NOW - 150},
    {"project": "-fixture-projeto-antigo", "session_id": "antigo-1", "session_name": None, "cwd": "/fixture/projeto-antigo",
     "line": "Vamos montar a paleta de busca do app nativo, igual à do web.", "mtime": NOW - 86400 * 3, "live": False,
     "role": "user", "event_id": "a1", "ts": NOW - 86400 * 3},
    {"project": "-fixture-projeto-antigo", "session_id": "antigo-1", "session_name": None, "cwd": "/fixture/projeto-antigo",
     "line": "A busca junta os trechos por conversa, a mais recente primeiro.", "mtime": NOW - 86400 * 3, "live": False,
     "role": "assistant", "event_id": "a2", "ts": NOW - 86400 * 3 + 60},
]
CONTEXT = [
    {"kind": "user_msg", "id": "a1", "text": "Vamos montar a paleta de busca do app nativo, igual à do web."},
    {"kind": "assistant_msg", "id": "a2", "text": "A busca junta os trechos por conversa, a mais recente primeiro."},
    {"kind": "user_msg", "id": "a3", "text": "E o Enter retoma a conversa arquivada."},
]
HISTORY = [
    {"kind": "user_msg", "id": "h1", "text": "Oi"},
    {"kind": "assistant_msg", "id": "h2", "text": "Sessão da fixture da busca."},
]


def empty_costs(period):
    zero = {"key": "totals", "sessions": 0, "input": 0, "output": 0, "cache_write": 0, "cache_read": 0, "cost": 0}
    return {"totals": zero, "by_day": [], "by_provider": [], "by_source": [], "by_project": [], "by_model": [], "by_kind": [],
            "rates": [], "sem_tarifa": [], "custo_sem_cache": 0, "equivalente_cobrado": 0, "anterior": None,
            "applied": {"period": period}, "usd_brl": 5.2, "combos": [], "sessoes": []}


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

    def sessions(self):
        return LIVE + ([RESUMED] if self.server.resumed else [])

    def do_POST(self):
        if not self.allowed(): return
        parts = [unquote(p) for p in urlsplit(self.path).path.strip("/").split("/")]
        if parts[:2] == ["api", "archive"] and parts[-1] == "resume":
            self.server.resumed = True
            return self.respond(RESUMED)
        self.respond({"detail": "fixture: escrita recusada"}, 405)

    def do_GET(self):
        parsed = urlsplit(self.path)
        route, query = parsed.path, {k: v[0] for k, v in parse_qs(parsed.query).items()}
        if not self.allowed(): return
        if route.endswith("/events"):
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.end_headers()
            name = route.split("/")[-2]
            try:
                while True:
                    if route == "/api/sessions/events":
                        body, event = self.sessions(), "sessions"
                    else:
                        body, event = {"state": "idle", "session": name}, "state"
                    self.wfile.write(f"event: {event}\ndata: {json.dumps(body)}\n\n".encode())
                    self.wfile.flush()
                    time.sleep(2)
            except (BrokenPipeError, ConnectionResetError):
                return
        if route == "/api/sessions": return self.respond(self.sessions())
        if route == "/api/config": return self.respond({"campos": {}, "somente_leitura": {}, "variaveis_env": []})
        if route == "/api/cotacao": return self.respond({"usd_brl": 5.2})
        if route.endswith("/history"): return self.respond(HISTORY)
        if route.endswith("/commands"): return self.respond([])
        if route == "/api/search":
            q = query.get("q", "").lower()
            return self.respond([] if "nada" in q else [h for h in HITS if all(w in h["line"].lower() for w in q.split())] or HITS)
        if route == "/api/search/context": return self.respond(CONTEXT)
        if route == "/api/costs":
            time.sleep(3)
            return self.respond(empty_costs(query.get("period", "all")))
        if route == "/api/uso": return self.respond({"detail": "fixture: falha proposital"}, 500)
        self.respond({"detail": "fixture: rota não configurada"}, 404)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dir", type=Path, required=True)
    args = parser.parse_args()
    args.dir = args.dir.resolve()
    os.umask(0o077)
    config = args.dir / "config" / "hangar-native"
    config.mkdir(parents=True, exist_ok=True)
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    server.token, server.resumed = secrets.token_hex(24), False
    server.log = args.dir / f"fixture-{server.server_port}.log"
    address = f"http://127.0.0.1:{server.server_port}"
    (config / "connection.json").write_text(json.dumps({"address": address, "token": server.token}))
    (config / "appearance.json").write_text(json.dumps({"theme": "dark", "language": "pt"}))
    print(json.dumps({"pid": os.getpid(), "address": address, "config": str(config.parent), "log": str(server.log)}), flush=True)
    server.serve_forever()
