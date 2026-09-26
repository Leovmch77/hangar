"""Estilos e versões com áudio sintético; a infraestrutura HTTP é a da T83."""

import argparse
import hashlib
import io
import json
import secrets
import time
import wave
from http.server import ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from task83_dictation_fixture import Handler as BaseHandler, NAMES


class Handler(BaseHandler):
    def do_GET(self):
        if urlparse(self.path).path == "/api/config":
            self.record()
            if self.authorized():
                if self.server.config_read_error:
                    return self.respond({"detail": "falha sintética ao ler configuração"}, 500)
                self.respond({"campos": {"ditado_estilo": {"valor": self.server.style}}, "somente_leitura": False})
            return
        super().do_GET()

    def do_POST(self):
        if not self.authorized():
            return
        route = urlparse(self.path)
        size = int(self.headers.get("Content-Length", "0"))
        if size > 100 * 1024 * 1024:
            return self.error("erro_arquivo_grande", "arquivo maior que 100 MiB", 413)
        data = self.rfile.read(size)
        self.record(size)
        if route.path == "/api/config":
            style = json.loads(data).get("ditado_estilo")
            with self.server.log.open("a") as output:
                output.write(json.dumps({"config_post": {"ditado_estilo": style}}) + "\n")
            if self.server.config_write_error or style not in ("limpar", "prosa", "briefing"):
                return self.respond({"detail": f"ditado_estilo: '{style}' nao existe. Use um de: limpar, prosa, briefing."}, 400)
            self.server.style = style
            return self.respond({"campos": {"ditado_estilo": {"valor": style}}, "somente_leitura": False})
        if route.path == "/api/ditado/relimpar":
            body = json.loads(data)
            if set(body) != {"texto", "estilo"} or not body["texto"]:
                return self.error("invalid_body", "corpo do ditado inválido", 400)
            style, raw = body["estilo"], body["texto"]
            name = raw.split(":", 1)[0]
            if style not in ("limpar", "prosa", "briefing") or name == "dictation-error":
                return self.error("erro_estilo_invalido", f"estilo '{style}' nao existe. Use um de: limpar, prosa, briefing.", 400)
            if name == "dictation-delayed":
                time.sleep(8)
            warning = "A limpeza falhou; o texto original foi preservado." if name == "dictation-warning" else None
            applied = "cru" if warning else "prosa" if name == "dictation-mention" and style == "briefing" else style
            text = raw if warning else f"{style}: Texto reorganizado para conferir a versão."
            if name == "dictation-empty":
                text = ""
            return self.respond({"text": text, "aviso": warning, "estilo_aplicado": applied})
        parts = route.path.strip("/").split("/")
        if len(parts) != 4 or parts[:2] != ["api", "sessions"] or parts[3] != "transcribe" or parts[2] not in NAMES:
            return self.error("not_found", "rota inexistente", 404)
        query = parse_qs(route.query)
        style = query.get("estilo", [None])[0]
        valid = query.get("limpar") == ["1"] and style in (None, "limpar", "prosa", "briefing")
        valid = valid and self.headers.get("Content-Type") == "audio/wav" and self.headers.get("X-Filename") == "ditado.wav"
        try:
            with wave.open(io.BytesIO(data), "rb") as audio:
                valid = valid and (audio.getnchannels(), audio.getsampwidth(), audio.getframerate()) == (1, 2, 16000)
                valid = valid and audio.getnframes() > 0
        except (wave.Error, EOFError):
            valid = False
        if not valid:
            return self.error("invalid_audio", "WAV ou estilo do ditado inválido", 400)
        with self.server.log.open("a") as output:
            output.write(json.dumps({"audio_sha256": hashlib.sha256(data).hexdigest(), "style": style}) + "\n")
        if parts[2] == "dictation-unconfigured":
            return self.respond({"detail": "chave de transcricao nao configurada no backend"}, 503)
        style = style or self.server.style
        raw = f"{parts[2]}: confira este texto ditado antes de enviar para a sessão."
        self.respond({"text": f"{style}: Confira o ditado antes de enviar.", "raw": raw,
                      "aviso": None, "estilo_aplicado": style, "path": "/synthetic/dictation/ditado.wav"})


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--config-dir", type=Path, required=True)
    parser.add_argument("--config-read-error", action="store_true")
    parser.add_argument("--config-write-error", action="store_true")
    args = parser.parse_args()
    config = args.config_dir.resolve() / "hangar-native"
    config.mkdir(parents=True, exist_ok=False, mode=0o700)
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    server.style = "briefing"
    server.config_read_error = args.config_read_error
    server.config_write_error = args.config_write_error
    server.token = secrets.token_hex(24)
    server.log = args.config_dir / f"fixture-{server.server_port}.log"
    address = f"http://127.0.0.1:{server.server_port}"
    with (config / "connection.json").open("x") as output:
        (config / "connection.json").chmod(0o600)
        json.dump({"address": address, "token": server.token}, output)
    with wave.open(str(args.config_dir / "sample.wav"), "wb") as audio:
        audio.setparams((1, 2, 16000, 0, "NONE", "not compressed"))
        audio.writeframes(b"\x00\x20\x00\xe0" * 16000)
    print(address, flush=True)
    try:
        server.serve_forever()
    finally:
        server.server_close()
