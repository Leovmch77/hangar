"""Barra de conversas sintética: dois projetos, estados e lista longa; porta 0."""

import argparse
import contextlib
import json
import os
import pathlib
import time
from urllib.parse import urlparse


HERE = pathlib.Path(__file__).resolve().parent
SOURCE = (HERE / "task14_sidebar_fixture.py").read_text(encoding="utf-8")
T14 = {"__name__": "task69_base", "__file__": str(HERE / "task14_sidebar_fixture.py")}
exec(compile(SOURCE[:SOURCE.index("\nserver = BASE[")], "task14_sidebar_fixture.py", "exec"), T14)
BASE = T14["BASE"]


class Handler(T14["Handler"]):
    def do_GET(self):
        if urlparse(self.path).path in ("/api/sessions", "/api/sessions/events"):
            if self.server.scenario == "error":
                self.send_json({"detail": "Falha sintética da lista"}, 503)
                return
            if self.server.scenario == "loading":
                time.sleep(8)
        super().do_GET()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=pathlib.Path, required=True)
    parser.add_argument("--scenario", choices=("full", "empty", "error", "loading"), default="full")
    args = parser.parse_args()
    BASE["SESSIONS"].clear()
    T14["DIRTY"].clear()
    if args.scenario != "empty":
        for index in range(28):
            name = f"conversa-{index:02}"
            if index == 3:
                name += "-revisar-reconexao-e-preservar-a-conversa-com-nome-longo"
            status = ("idle", "working", "awaiting_input", "idle")[index % 4]
            session = BASE["info"](name, "codex" if index % 2 else "claude", headless=True, state=status)
            session.update(cwd=f"/synthetic/{'hangar' if index < 14 else 'notas'}", last_activity=time.time() - 60,
                           pending_questions=2 if status == "awaiting_input" else 0,
                           limited=index == 5, tracked=index != 6, branch="feature/sidebar" if index == 4 else None)
            BASE["SESSIONS"][name] = {"info": session, "state": BASE["state"](status),
                "events": [BASE["msg"]("assistant_msg", f"reply-{index}", f"Conversa sintética {index:02}. Nenhum agente real está rodando.")],
                "stats": None, "modes": []}
    BASE["bump"]()
    server = BASE["ThreadingHTTPServer"](("127.0.0.1", 0), Handler)
    server.scenario = args.scenario
    stage = args.output.resolve() / f"fixture-{server.server_port}"
    config = stage / "config" / "hangar-native"
    config.mkdir(parents=True, mode=0o700)
    with open(config / "connection.json", "x", opener=lambda path, flags: os.open(path, flags, 0o600)) as output:
        json.dump({"address": f"http://127.0.0.1:{server.server_port}", "token": BASE["TOKEN"]}, output)
    (config / "appearance.json").write_text(json.dumps({"theme": "dark", "language": "pt",
        "navigation": "conversations", "sidebar_compact": False}))
    (stage / "fixture.pid").write_text(str(os.getpid()))
    print(json.dumps({"url": f"http://127.0.0.1:{server.server_port}", "pid": os.getpid(), "stage": str(stage)}), flush=True)
    with (stage / f"fixture-{server.server_port}.log").open("a", buffering=1) as log:
        with contextlib.redirect_stdout(log), contextlib.redirect_stderr(log):
            try:
                server.serve_forever()
            finally:
                server.server_close()


if __name__ == "__main__":
    main()
