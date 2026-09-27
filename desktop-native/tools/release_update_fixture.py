"""Release FALSA do `native-latest` para provar o "Atualizar" sem GitHub: serve `native-latest.json` e o binário cru da
plataforma, no formato que o `.github/workflows/native.yml` publica. Aponte o app com HANGAR_NATIVE_UPDATE_URL=<url>.

Uso: release_update_fixture.py <binário a servir> <versão do manifesto> [--wrong-sha]
  --wrong-sha  o manifesto leva um sha256 que não é o do arquivo (o app tem que recusar sem trocar nada).
Porta 0 (RELEASE_FIXTURE_PORT muda); o endereço sai na primeira linha. Cada GET vai para o stderr.
"""
import hashlib
import http.server
import json
import os
import pathlib
import sys

binary = pathlib.Path(sys.argv[1]).read_bytes()
version = sys.argv[2]
sha = hashlib.sha256(binary).hexdigest()
if "--wrong-sha" in sys.argv:
    sha = hashlib.sha256(b"outro arquivo").hexdigest()
NAME = "Hangar-linux-x86_64"
FILES = {
    "/native-latest.json": json.dumps({"version": version, "commit": "fixture", "files": {NAME: sha}}).encode(),
    f"/{NAME}": binary,
}


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        body = FILES.get(self.path)
        self.send_response(200 if body is not None else 404)
        self.send_header("Content-Length", str(len(body or b"")))
        self.end_headers()
        self.wfile.write(body or b"")


server = http.server.ThreadingHTTPServer(("127.0.0.1", int(os.environ.get("RELEASE_FIXTURE_PORT", "0"))), Handler)
print(f"Fixture URL: http://127.0.0.1:{server.server_port}", flush=True)
try:
    server.serve_forever()
except KeyboardInterrupt:
    pass
