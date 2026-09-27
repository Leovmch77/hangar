"""Mãos livres: fala e silêncio sintéticos, porta aleatória e token local."""

import argparse
import io
import json
import math
import struct
import secrets
import time
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse


NAMES = ("handsfree-demo", "handsfree-warning")
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
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def error(self, code, message, status):
        self.respond({"detail": {"code": code, "params": {}, "msg": message}}, status)

    def plain_error(self, message, status):
        self.respond({"detail": message}, status)

    def authorized(self):
        if self.headers.get("Authorization") == f"Bearer {self.server.token}":
            return True
        self.error("erro_nao_autorizado", "unauthorized", 401)
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
            routes = {"/api/sessions": SESSIONS, "/api/config": {"campos": {
                "groq_api_key": {"definido": True, "valor": "chave sintética", "origem": "app"},
                "notify_finished": {"valor": False, "definido": True, "origem": "env"},
                "finish_min_seconds": {"valor": 30, "definido": True, "origem": "env"}}}, "/api/cotas": [],
                      "/api/push/settings": {"muted": [], "quiet_hours": None},
                      "/api/archive-por-cwd": [], "/api/providers": {"claude": {"disponivel": True}}}
            self.respond(routes[path]) if path in routes else self.plain_error("Not Found", 404)

    def do_POST(self):
        if not self.authorized():
            return
        route = urlparse(self.path)
        parts = route.path.strip("/").split("/")
        if len(parts) != 4 or parts[:2] != ["api", "sessions"] or parts[3] not in ("transcribe", "input"):
            return self.plain_error("Not Found", 404)
        if parts[2] not in NAMES:
            if parts[3] == "input":
                return self.error("erro_sessao_recado_nao_enfileirado", "sessão não encontrada — recado NÃO enfileirado", 404)
            return self.error("erro_sessao_inexistente", "sessao nao encontrada", 404)
        length = self.headers.get("Content-Length", "0")
        if not length.isdigit():
            return self.plain_error("arquivo vazio", 400)
        size = int(length)
        if size > 100 * 1024 * 1024:
            return self.error("erro_arquivo_grande", "arquivo maior que 100 MiB", 413)
        data = self.rfile.read(size)
        self.record(size)
        if parts[3] == "input":
            return self.respond({"ok": True, "delivered": True, "steered": False, "native": False})
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
            return self.plain_error("servico de transcricao 400: WAV ou contrato do ditado inválido", 502)
        text = "Confira o ditado antes de enviar."
        warning = "A limpeza falhou; o texto original foi preservado." if parts[2] == "handsfree-warning" else None
        self.respond({"text": text, "raw": text,
                      "aviso": warning, "estilo_aplicado": "cru",
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
    tone = b"".join(struct.pack("<h", int(16000 * math.sin(i * math.tau * 440 / 16000))) for i in range(16000))
    for name, frames in (("sample.wav", tone * 2 + b"\0\0" * 16000 * 4), ("sample-3min.wav", tone * 180)):
        with wave.open(str(args.config_dir / name), "wb") as audio:
            audio.setparams((1, 2, 16000, 0, "NONE", "not compressed"))
            audio.writeframes(frames)
    print(address, flush=True)
    try:
        server.serve_forever()
    finally:
        server.server_close()
