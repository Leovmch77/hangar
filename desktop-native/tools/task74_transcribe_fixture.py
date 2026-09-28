"""Ditado sintético: porta aleatória, token local e WAV sem áudio do usuário."""

import argparse
import io
import json
import secrets
import time
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse


NAMES = ("dictation-ok", "dictation-unconfigured", "dictation-error", "dictation-delayed")
SESSIONS = [{"name": name, "cwd": "/synthetic/dictation", "jsonl": f"{name}.jsonl",
             "provider": "claude", "headless": True, "tracked": True, "state": "idle"} for name in NAMES]


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def record(self, size=0):
        route = urlparse(self.path)
        with self.server.log.open("a") as output:
            output.write(json.dumps({"method": self.command, "path": route.path,
                                     "query": route.query, "bytes": size}) + "\n")

    def respond(self, value, status=200):
        body = json.dumps(value).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def error(self, code, message, status):
        self.respond({"detail": {"code": code, "params": {}, "msg": message}}, status)

    def authorized(self):
        if self.headers.get("Authorization") == f"Bearer {self.server.token}":
            return True
        self.error("unauthorized", "token da fixture recusado", 401)
        return False

    def do_GET(self):
        self.record()
        if not self.authorized():
            return
        path = urlparse(self.path).path
        parts = path.strip("/").split("/")
        session = len(parts) == 4 and parts[:2] == ["api", "sessions"] and parts[2] in NAMES
        if path == "/api/sessions/events" or (session and parts[3] == "events"):
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.end_headers()
            event, value = ("state", {"state": "idle"}) if session else ("sessions", SESSIONS)
            try:
                self.wfile.write(f"event: {event}\ndata: {json.dumps(value)}\n\n".encode())
                while True:
                    self.wfile.write(b"event: ping\ndata: {}\n\n")
                    self.wfile.flush()
                    time.sleep(1)
            except (BrokenPipeError, ConnectionResetError):
                return
        elif session and parts[3] == "history":
            self.respond([{"kind": "assistant_msg", "id": "dictation-proof", "text": "Digite um rascunho antes de ditar."}])
        else:
            routes = {"/api/sessions": SESSIONS, "/api/config": {"campos": {}}, "/api/cotas": [],
                      "/api/archive-por-cwd": [], "/api/providers": {"claude": {"disponivel": True}}}
            self.respond(routes[path]) if path in routes else self.error("not_found", "rota inexistente", 404)

    def do_POST(self):
        if not self.authorized():
            return
        route = urlparse(self.path)
        parts = route.path.strip("/").split("/")
        if len(parts) != 4 or parts[:2] != ["api", "sessions"] or parts[3] != "transcribe":
            return self.error("not_found", "rota inexistente", 404)
        if parts[2] not in NAMES:
            return self.error("erro_sessao_inexistente", "sessao nao encontrada", 404)
        length = self.headers.get("Content-Length", "0")
        if not length.isdigit():
            return self.error("invalid_audio", "tamanho do áudio inválido", 400)
        size = int(length)
        self.record(size)
        if size > 100 * 1024 * 1024:
            return self.error("erro_arquivo_grande", "arquivo maior que 100 MiB", 413)
        data = self.rfile.read(size)
        query = parse_qs(route.query, keep_blank_values=True)
        valid = query.get("limpar") == ["1"] and set(query) <= {"limpar", "estilo"}
        valid = valid and self.headers.get("Content-Type") == "audio/wav" and self.headers.get("X-Filename") == "ditado.wav"
        try:
            with wave.open(io.BytesIO(data), "rb") as audio:
                valid = valid and (audio.getnchannels(), audio.getsampwidth(), audio.getframerate()) == (1, 2, 16000)
                valid = valid and audio.getnframes() > 0 and len(audio.readframes(audio.getnframes())) == audio.getnframes() * 2
        except (wave.Error, EOFError):
            valid = False
        if not valid:
            return self.error("invalid_audio", "WAV ou contrato do ditado inválido", 400)
        if parts[2] == "dictation-unconfigured":
            return self.respond({"detail": "chave de transcricao nao configurada no backend"}, 503)
        if parts[2] == "dictation-error":
            return self.respond({"detail": "servico de transcricao 429: limite sintetico do provedor"}, 502)
        if parts[2] == "dictation-delayed":
            time.sleep(5)
        self.respond({"text": "Confira o ditado antes de enviar.", "raw": "confira o ditado antes de enviar",
                      "aviso": None, "estilo_aplicado": query.get("estilo", ["prosa"])[0],
                      "path": "/synthetic/dictation/ditado.wav"})


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--config-dir", type=Path, required=True)
    args = parser.parse_args()
    config = args.config_dir.resolve() / "hangar-native"
    config.mkdir(parents=True, exist_ok=False, mode=0o700)
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    server.token = secrets.token_hex(24)
    server.log = args.config_dir / f"fixture-{server.server_port}.log"
    address = f"http://127.0.0.1:{server.server_port}"
    with (config / "connection.json").open("x") as output:
        (config / "connection.json").chmod(0o600)
        json.dump({"address": address, "token": server.token}, output)
    with wave.open(str(args.config_dir / "sample.wav"), "wb") as audio:
        audio.setparams((1, 2, 16000, 0, "NONE", "not compressed"))
        audio.writeframes(b"\x00\x20\x00\xe0" * 8000)
    print(address, flush=True)
    try:
        server.serve_forever()
    finally:
        server.server_close()
