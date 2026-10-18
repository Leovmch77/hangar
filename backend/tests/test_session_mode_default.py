"""O modo omitido herda; escolha explícita nunca altera a preferência."""
import pytest


@pytest.mark.parametrize("flags, expected", [((), None), (("--headless",), True), (("--terminal",), False)])
def test_cli_preserves_omission_and_explicit_mode(tmp_path, flags, expected):
    import json
    import shutil
    import subprocess
    import threading
    from http.server import BaseHTTPRequestHandler, HTTPServer
    from pathlib import Path

    requests = []
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b'{"claude": {"disponivel": true, "default": true}}')
        def do_POST(self):
            requests.append((self.path, json.loads(self.rfile.read(int(self.headers["Content-Length"])))))
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b'{}')
        def log_message(self, *args):
            pass

    server = HTTPServer(("127.0.0.1", 0), Handler)
    worker = threading.Thread(target=server.serve_forever, daemon=True)
    worker.start()
    scripts = tmp_path / "scripts"
    scripts.mkdir()
    (tmp_path / "backend").mkdir()
    (tmp_path / "backend" / ".env").write_text(f"CP_AUTH_TOKEN=test\nCP_PORT={server.server_port}\n")
    script = scripts / "hangar-send"
    shutil.copy(Path(__file__).parents[2] / "scripts" / "hangar-send", script)
    try:
        result = subprocess.run(["bash", str(script), "--new", "test-mode", "/tmp", *flags], capture_output=True, text=True, timeout=10)
        assert result.returncode == 0, result.stderr
        assert len(requests) == 1 and requests[0][0] == "/api/sessions"
        body = requests[0][1]
        if expected is None:
            assert "headless" not in body
        else:
            assert body["headless"] is expected
        for conflict in (("--headless", "--terminal"), ("--terminal", "--headless")):
            result = subprocess.run(["bash", str(script), "--new", "test-mode", "/tmp", *conflict], capture_output=True, text=True, timeout=10)
            assert result.returncode == 2
        assert len(requests) == 1
    finally:
        server.shutdown()
        server.server_close()
        worker.join()

