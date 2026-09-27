"""Servidor de prova do painel de terminal, com tmux e WebSocket descartáveis."""
import argparse
import base64
import contextlib
import fcntl
import hashlib
import hmac
import json
import os
from pathlib import Path
import pty
import select
import signal
import struct
import subprocess
import termios
from urllib.parse import parse_qs, unquote, urlsplit


HERE = Path(__file__).resolve().parent
SOURCE = (HERE / "task14_sidebar_fixture.py").read_text(encoding="utf-8")
NS = {"__name__": "task66_base", "__file__": str(HERE / "task14_sidebar_fixture.py")}
exec(compile(SOURCE[:SOURCE.index("\nserver = BASE[")], "task14_sidebar_fixture.py", "exec"), NS)
BASE = NS["BASE"]
NAME = "task66-terminal"
OTHER = "task66-other"
SHELL = f"term-{NAME}"
MISSING = {"enabled": False}
SOCKET_OFF = {"enabled": False}
COUNTS = {"attach": 0, "shell": 0, "shell_posts": 0, "inputs_attach": 0, "inputs_shell": 0, "resizes": 0,
          "missing_probes": 0, "offline_handshakes": 0, "control_reads": 0, "rotations": 0,
          "tabs": 0, "shift_tabs": 0, "interrupts": 0, "long_lines": 0}


def tmux(*args, check=True):
    return subprocess.run(["tmux", "-L", SOCKET, *args], check=check, capture_output=True, text=True)


def ws_frame(opcode, data):
    length = len(data)
    head = bytes([0x80 | opcode, length]) if length < 126 else (
        bytes([0x80 | opcode, 126]) + struct.pack("!H", length) if length < 65536
        else bytes([0x80 | opcode, 127]) + struct.pack("!Q", length))
    return head + data


def read_frames(buffer):
    while len(buffer) >= 2:
        opcode, size = buffer[0] & 15, buffer[1] & 127
        masked = bool(buffer[1] & 128)
        offset = 2
        if size == 126:
            if len(buffer) < 4:
                return
            size, offset = struct.unpack("!H", buffer[2:4])[0], 4
        elif size == 127:
            if len(buffer) < 10:
                return
            size, offset = struct.unpack("!Q", buffer[2:10])[0], 10
        if size > 1024 * 1024 or not masked:
            raise ValueError("quadro WebSocket inválido")
        if len(buffer) < offset + 4 + size:
            return
        mask = buffer[offset:offset + 4]
        data = bytes(byte ^ mask[i % 4] for i, byte in enumerate(buffer[offset + 4:offset + 4 + size]))
        del buffer[:offset + 4 + size]
        yield opcode, data


class Handler(NS["Handler"]):
    def do_GET(self):
        parsed = urlsplit(self.path)
        path = parsed.path
        if path == "/control/t66":
            COUNTS["control_reads"] += 1
            query = parse_qs(parsed.query)
            if "missing" in query:
                MISSING["enabled"] = query["missing"][0] == "1"
            if "offline" in query:
                SOCKET_OFF["enabled"] = query["offline"][0] == "1"
            if query.get("rotate") == ["1"]:
                COUNTS["rotations"] += 1
                BASE["SESSIONS"][NAME]["info"]["jsonl"] = str(STAGE / f"task66-{COUNTS['rotations']}.jsonl")
                BASE["bump"]()
            if query.get("long") == ["1"]:
                tmux("send-keys", "-t", f"={NAME}:", "printf '%0120d\\n' 0", "Enter")
                COUNTS["long_lines"] += 1
            def echoed(name, marker):
                pane = tmux("capture-pane", "-pt", f"={name}:", "-S", "-30", check=False)
                return int(pane.returncode == 0 and pane.stdout.count(marker) >= 2)
            pane = tmux("capture-pane", "-pt", f"={NAME}:", check=False)
            long_row = next((index for index, line in enumerate(pane.stdout.splitlines()) if line.count("0") >= 110), -1)
            self.send_json({"missing": MISSING["enabled"], "offline": SOCKET_OFF["enabled"],
                "echo_attach": echoed(NAME, "t66eco"), "echo_shell": echoed(SHELL, "t66shell"),
                "echo_tab": echoed(NAME, "t66tab"), "long_row": long_row, **COUNTS})
            return
        if path == "/api/sessions" and MISSING["enabled"]:
            if self.authorized():
                COUNTS["missing_probes"] += 1
                self.send_json([])
            return
        if path == "/api/config":
            if self.authorized():
                self.send_json({"campos": {"notify_finished": {"valor": False},
                    "finish_min_seconds": {"valor": 60}, "jev_padrao": {"valor": False}}})
            return
        parts = [unquote(part) for part in path.strip("/").split("/")]
        if len(parts) == 4 and parts[:2] == ["api", "sessions"] and parts[3] == "term":
            return self.terminal(parts[2], parse_qs(parsed.query))
        return super().do_GET()

    def do_POST(self):
        parts = [unquote(part) for part in urlsplit(self.path).path.strip("/").split("/")]
        if len(parts) == 4 and parts[:2] == ["api", "sessions"] and parts[3] == "shell":
            if not self.authorized():
                return
            COUNTS["shell_posts"] += 1
            if parts[2] != NAME:
                return self.send_json(BASE["fail"]("erro_sessao_inexistente", "sessao nao existe"), 404)
            if tmux("has-session", "-t", f"={SHELL}:", check=False).returncode != 0:
                tmux("new-session", "-d", "-s", SHELL, "-c", str(STAGE), "/bin/sh")
                tmux("send-keys", "-t", f"={SHELL}:", "printf 'SHELL READY\\n'", "Enter")
            return self.send_json({"ok": True, "shell": SHELL})
        return super().do_POST()

    def terminal(self, name, query):
        def reject():
            self.send_response(403)
            self.send_header("Content-Length", "0")
            self.end_headers()
        token = query.get("token", [""])[0]
        if not hmac.compare_digest(token, BASE["TOKEN"]) or name not in (NAME, SHELL):
            return reject()
        if name == SHELL and tmux("has-session", "-t", f"={SHELL}:", check=False).returncode != 0:
            return reject()
        key = self.headers.get("Sec-WebSocket-Key", "")
        if self.headers.get("Upgrade", "").lower() != "websocket" or not key:
            return self.send_json({"detail": "WebSocket required"}, 400)
        accept = base64.b64encode(hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest()).decode()
        self.send_response(101)
        self.send_header("Upgrade", "websocket")
        self.send_header("Connection", "Upgrade")
        self.send_header("Sec-WebSocket-Accept", accept)
        self.end_headers()
        self.close_connection = True
        if SOCKET_OFF["enabled"]:
            COUNTS["offline_handshakes"] += 1
            self.connection.sendall(ws_frame(8, struct.pack("!H", 1000)))
            return
        COUNTS["attach" if name == NAME else "shell"] += 1
        master, slave = pty.openpty()
        proc = subprocess.Popen(["tmux", "-L", SOCKET, "attach-session", "-t", f"={name}:"],
                                stdin=slave, stdout=slave, stderr=slave, start_new_session=True,
                                env={**os.environ, "TERM": "xterm-256color"})
        os.close(slave)
        try:
            fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 80, 0, 0))
            buffer = bytearray()
            seeded = False
            while proc.poll() is None:
                readable, _, _ = select.select([self.connection, master], [], [], 0.2)
                if master in readable:
                    try:
                        data = os.read(master, 65536)
                    except OSError:
                        break
                    if not data:
                        break
                    self.connection.sendall(ws_frame(2, data))
                if self.connection in readable:
                    data = self.connection.recv(65536)
                    if not data:
                        break
                    buffer.extend(data)
                    for opcode, payload in read_frames(buffer):
                        if opcode == 8:
                            return
                        if opcode == 9:
                            self.connection.sendall(ws_frame(10, payload))
                        elif opcode == 2:
                            COUNTS["inputs_attach" if name == NAME else "inputs_shell"] += 1
                            if name == NAME:
                                COUNTS["tabs"] += payload.count(b"\t")
                                COUNTS["shift_tabs"] += payload.count(b"\x1b[Z")
                                COUNTS["interrupts"] += payload.count(b"\x03")
                            os.write(master, payload)
                        elif opcode == 1:
                            size = json.loads(payload)
                            if size.get("t") == "resize":
                                COUNTS["resizes"] += 1
                                rows = max(5, min(200, int(size["rows"])))
                                cols = max(20, min(500, int(size["cols"])))
                                fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
                                if not seeded:
                                    marker = "TASK66 READY" if name == NAME else "SHELL READY"
                                    tmux("send-keys", "-t", f"={name}:", f"printf '{marker}\\n'", "Enter")
                                    seeded = True
        except (OSError, ValueError, KeyError, json.JSONDecodeError) as error:
            print("terminal bridge ended:", type(error).__name__, flush=True)
        finally:
            proc.terminate()
            with contextlib.suppress(subprocess.TimeoutExpired):
                proc.wait(timeout=2)
            os.close(master)


def main():
    global SOCKET, STAGE
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    server = BASE["ThreadingHTTPServer"](("127.0.0.1", 0), Handler)
    STAGE = args.output.resolve() / f"fixture-{server.server_port}"
    STAGE.mkdir(parents=True, mode=0o700)
    SOCKET = f"task66-{os.getpid()}-{server.server_port}"
    tmux("-f", "/dev/null", "new-session", "-d", "-s", NAME, "-c", str(STAGE), "/bin/sh")
    tmux("send-keys", "-t", f"={NAME}:", "printf 'TASK66 READY\\n'", "Enter")
    tmux_pid = int(tmux("display-message", "-p", "#{pid}").stdout.strip())
    BASE["SESSIONS"].clear()
    info = BASE["info"](NAME, "claude", state="idle", branch=None)
    info["cwd"] = str(STAGE)
    BASE["SESSIONS"][NAME] = {"info": info, "state": BASE["state"]("idle"),
        "events": [BASE["msg"]("assistant_msg", "task66-intro", "Terminal de prova da Task 66.")],
        "stats": None, "modes": []}
    other = BASE["info"](OTHER, "claude", state="idle", branch=None)
    other["cwd"] = str(STAGE)
    BASE["SESSIONS"][OTHER] = {"info": other, "state": BASE["state"]("idle"),
        "events": [BASE["msg"]("assistant_msg", "task66-other", "Outra sessão de prova.")],
        "stats": None, "modes": []}
    BASE["bump"]()
    for theme in ("dark", "light"):
        config = STAGE / theme / "hangar-native"
        config.mkdir(parents=True, mode=0o700)
        (config / "connection.json").write_text(json.dumps({"address": f"http://127.0.0.1:{server.server_port}", "token": BASE["TOKEN"]}))
        os.chmod(config / "connection.json", 0o600)
        (config / "appearance.json").write_text(json.dumps({"theme": theme, "language": "pt", "navigation": "sidebar"}))
    (STAGE / "terminal.ansi").write_bytes(b"\x1b[2J\x1b[HFixture T62 + T64 ready\r\n" +
        b"".join(f"Fixture line {number:02}\r\n".encode() for number in range(1, 41)))
    (STAGE / "fixture.pid").write_text(str(os.getpid()))
    (STAGE / "tmux.pid").write_text(str(tmux_pid))
    print(json.dumps({"url": f"http://127.0.0.1:{server.server_port}", "pid": os.getpid(),
                      "tmux_pid": tmux_pid, "stage": str(STAGE)}), flush=True)
    try:
        with (STAGE / f"fixture-{server.server_port}.log").open("a", buffering=1) as log:
            with contextlib.redirect_stdout(log), contextlib.redirect_stderr(log):
                try:
                    server.serve_forever()
                except KeyboardInterrupt:
                    pass
    finally:
        server.server_close()
        with contextlib.suppress(ProcessLookupError):
            os.kill(tmux_pid, signal.SIGTERM)


if __name__ == "__main__":
    main()
