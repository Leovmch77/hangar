"""Servidor sintético para conferir mods, geometria e perguntas no nativo isolado.

Não abre agentes nem lê configuração real. Controle por /control/question, next-question,
resolve, fail, empty, long, technical, normal, remove e reset. As ações ficam em /control/log.
Use MODS_PROOF_PORT para repetir a prova na mesma porta e o token sintético TOKEN no cliente.
"""

import base64
import copy
import json
import os
import struct
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

TOKEN = "mods-ui-fixture"
CHANGED = threading.Condition()
STATE = {"version": 0, "active": "pm", "question": False, "question_id": 1, "fail": False, "content": "normal", "removed": False}
LOG = []


def text(value, **props):
    return {"type": "Text", "props": props, "children": [value]}


def button(label, key, **props):
    return {"type": "Button", "props": {"label": label, "key": key, **props},
            "press": {"plugin": "proof", "key": key}}


def tree(children):
    return {"type": "Box", "props": {"flexDirection": "column", "gap": 1, "width": 100}, "children": children}


def surfaces():
    pm = tree([
        text("PM-10001 · Melhoria · Prioridade média", dimColor=True),
        text("Migrar o processamento para o serviço de tarefas", bold=True),
        text("Resolvido e Revisada", color="green"),
        text("Responsável: Pessoa de exemplo\nVersão: 1.2.3\nAtualizada: 15/10/2026"),
        text("Descrição", bold=True),
        text("Centralizar o processamento, as pendências e as notificações no serviço de tarefas. Acompanhar a execução pelo painel do projeto."),
        {"type": "Link", "props": {"href": "https://example.com/PM-10001", "label": "Abrir no Jira"}},
        {"type": "Box", "props": {"flexDirection": "row", "gap": 2}, "children": [
            button("Atualizar dados", "refresh", variant="primary"), button("Copiar chave", "copy", plain=True)]},
    ])
    mr = tree([text("Merge requests da PM", bold=True)] + [text(f"{name} · sem threads pendentes") for name in ("aplicacao", "automacao", "servicos")])
    jenkins = tree([text("Nenhum job do Jenkins neste projeto.", dimColor=True)])
    if STATE["content"] == "empty":
        jenkins = tree([])
    if STATE["content"] == "long":
        pm = tree([text(f"Etapa {n}: conferir o destino do merge e registrar o resultado com acentuação.") for n in range(1, 81)])
    if STATE["content"] == "technical":
        cells = base64.b64encode(b"".join(struct.pack("<III", ord(c), 0x01000000, 0x01000000) for c in "======--------------")).decode()
        pm = tree([text("Saída técnica", bold=True),
                   {"type": "Code", "props": {"source": "resultado = conferir(42)\nassert resultado == 42"}},
                   {"type": "Box", "children": [text("  "), {"type": "Raster", "props": {"columns": 20, "rows": 1, "cells": cells}}, text("  30%")]},
                   {"type": "Input", "props": {"key": "filter", "label": "Filtro", "placeholder": "Digite para filtrar"}, "press": {"plugin": "proof", "key": "filter"}}])
    panes = [{"id": key, "title": title, "columns": 100, "tree": body} for key, title, body in (
        ("mr", "MR", mr), ("pm", "PM-10001", pm), ("jenkins", "Jenkins", jenkins))]
    return {"source": "surface", "above": tree([text("PM-10001 · servicos · Configuração", dimColor=True)]),
            "panes": [] if STATE["removed"] else panes, "shown_id": None if STATE["removed"] else STATE["active"]}


def question():
    return {"interaction_id": f"mods-proof-question-{STATE['question_id']}", "tool_use_id": "proof-ask", "questions": [
        {"header": "Build", "question": "Como você quer tratar o build que falhou?", "multiSelect": False,
         "options": [{"label": "Investigar agora", "description": "Consultar o log e identificar a causa."},
                     {"label": "Continuar com a PM", "description": "Investigar o build depois."}]}]} if STATE["question"] else None


def sessions():
    return [{"name": name, "cwd": "/synthetic/mods", "jsonl": f"/synthetic/{name}.jsonl", "provider": "claude",
             "tracked": True, "headless": True, "state": "awaiting_input" if STATE["question"] else "idle"}
            for name in ("mods-proof", "mods-other")]


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *_):
        pass

    def send_json(self, body, status=200):
        raw = json.dumps(body, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def frame(self, event, body):
        self.wfile.write(f"event: {event}\ndata: {json.dumps(body, ensure_ascii=False)}\n\n".encode())
        self.wfile.flush()

    def stream(self, listing):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        seen = -1
        try:
            while True:
                with CHANGED:
                    CHANGED.wait_for(lambda: STATE["version"] != seen, timeout=1)
                    if STATE["version"] != seen:
                        seen = STATE["version"]
                        frames = [("sessions", sessions())] if listing else [
                            ("state", {"state": "awaiting_input" if STATE["question"] else "idle"}),
                            ("plugin_ui", surfaces()), ("ask_question", question())]
                        frames = copy.deepcopy(frames)
                    else:
                        frames = [("ping", {})]
                for event, body in frames:
                    self.frame(event, body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def do_GET(self):
        path = urlparse(self.path).path
        if path.startswith("/control/"):
            action = path.rsplit("/", 1)[-1]
            with CHANGED:
                if action in ("question", "resolve"):
                    STATE["question"] = action == "question"
                elif action == "next-question":
                    STATE["question"] = True
                    STATE["question_id"] += 1
                elif action == "fail":
                    STATE["fail"] = True
                elif action in ("empty", "long", "normal", "technical"):
                    STATE["content"] = action
                elif action == "remove":
                    STATE["removed"] = True
                elif action == "reset":
                    STATE.update(active="pm", question=False, fail=False, content="normal", removed=False)
                STATE["version"] += 1
                CHANGED.notify_all()
                self.send_json(LOG if action == "log" else STATE)
            return
        if self.headers.get("Authorization") != f"Bearer {TOKEN}":
            self.send_json({"detail": "unauthorized"}, 401)
        elif path == "/api/config":
            self.send_json({"campos": {"dictation_organization_mode": {"valor": "none"},
                                      "notify_finished": {"valor": False}, "finish_min_seconds": {"valor": 0},
                                      "shortcuts": {"valor": "[]"}}})
        elif path == "/api/push/settings":
            self.send_json({"muted": [], "quiet_hours": None})
        elif path.endswith("/project-shortcuts"):
            self.send_json({"name": "Projeto de exemplo", "key": "proof", "items": []})
        elif path == "/api/sessions":
            self.send_json(sessions())
        elif path.endswith("/events"):
            self.stream(path == "/api/sessions/events")
        elif path.endswith("/history"):
            self.send_json([{"kind": "assistant_msg", "id": "proof-intro", "text": "A PM foi resolvida e revisada. O build precisa de atenção."}])
        else:
            self.send_json({"detail": "not found"}, 404)

    def do_POST(self):
        path = urlparse(self.path).path
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))) or b"{}")
        if self.headers.get("Authorization") != f"Bearer {TOKEN}":
            self.send_json({"detail": "unauthorized"}, 401)
            return
        with CHANGED:
            LOG.append({"path": path, "body": body})
            if path.endswith("/answer"):
                if STATE["fail"]:
                    STATE["fail"] = False
                    self.send_json({"detail": {"code": "erro_interacao_indisponivel", "msg": "Falha simulada ao enviar a resposta."}}, 503)
                    return
                current = question()
                if current is None or body.get("interaction_id") != current["interaction_id"]:
                    self.send_json({"detail": {"code": "erro_interacao_desatualizada"}}, 409)
                    return
                STATE["question"] = False
            elif path.endswith("/plugin/show"):
                STATE["active"] = body["site"]
            elif not path.endswith(("/plugin/press", "/plugin/input")):
                self.send_json({"detail": "Ação inesperada na prova."}, 400)
                return
            STATE["version"] += 1
            CHANGED.notify_all()
        self.send_json({"ok": True})


if __name__ == "__main__":
    server = ThreadingHTTPServer(("127.0.0.1", int(os.environ.get("MODS_PROOF_PORT", "0"))), Handler)
    print(json.dumps({"url": f"http://127.0.0.1:{server.server_port}"}), flush=True)
    try:
        server.serve_forever()
    finally:
        server.server_close()
