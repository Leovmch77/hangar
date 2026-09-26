"""Estados sintéticos da barra de conversas; porta 0, sem agentes reais."""

import argparse
import contextlib
import json
import os
import pathlib
import runpy
import time
from urllib.parse import parse_qs, unquote, urlparse


HERE = pathlib.Path(__file__).resolve().parent
T69 = runpy.run_path(str(HERE / "task69_sidebar_fixture.py"))
BASE = T69["BASE"]


class Handler(T69["Handler"]):
    def do_GET(self):
        url = urlparse(self.path)
        if url.path == "/control/t71":
            query = parse_qs(url.query)
            with BASE["LOCK"]:
                if "queue" in query:
                    events = BASE["SESSIONS"]["t71-queue"]["events"]
                    if query["queue"][0] == "delivered" and not events[0]["queued_delivered"]:
                        events[0]["queued_delivered"] = True
                        events.append(BASE["msg"]("user_msg", "live-t71-delivered", events[0]["text"]))
                if "send" in query:
                    self.server.send_mode = query["send"][0]
                BASE["bump"]()
            self.send_json({"ok": True})
            return
        super().do_GET()

    def do_POST(self):
        parts = [unquote(p) for p in urlparse(self.path).path.strip("/").split("/")]
        if len(parts) == 4 and parts[:2] == ["api", "sessions"] and parts[3] == "input":
            if not self.authorized():
                return
            self.body()
            if self.server.send_mode == "drop":
                self.drop()
            else:
                self.send_json({"detail": "Envio recusado pela fixture T71"}, 409)
            return
        super().do_POST()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=pathlib.Path, required=True)
    parser.add_argument("--theme", choices=("dark", "light"), default="dark")
    parser.add_argument("--compact", action="store_true")
    parser.add_argument("--navigation", choices=("conversations", "sidebar", "tabs"), default="conversations")
    args = parser.parse_args()
    BASE["SESSIONS"].clear()
    T69["T14"]["DIRTY"].clear()
    rows = [("t71-working", "working", {}),
            ("t71-working-long-name-check-status-alignment", "working", {"branch": "feature/sidebar-states"}),
            ("t71-input", "awaiting_input", {"pending_questions": 2}),
            ("t71-ready", "idle", {}),
            ("t71-problem", "idle", {"problema": "Configuração sintética inválida"}),
            ("t71-limited", "idle", {"limited": True}),
            ("t71-queue", "working", {}), ("t71-ended", "dead", {})]
    for index, (name, status, extra) in enumerate(rows):
        session = BASE["info"](name, "codex", headless=True, state=status, **extra)
        session.update(cwd="/synthetic/task71", last_activity=time.time() - 60 - index)
        events = [BASE["msg"]("assistant_msg", f"reply-{index}", "Conversa sintética da T71.")]
        if name == "t71-queue":
            events = [{**BASE["msg"]("user_msg", "queued-t71", "Pedido na fila sintética"),
                       "queued_delivered": False, "queued_confirmed": False}]
        BASE["SESSIONS"][name] = {"info": session, "state": BASE["state"](status, **extra),
                                  "events": events, "stats": None, "modes": []}
    BASE["bump"]()
    server = BASE["ThreadingHTTPServer"](("127.0.0.1", 0), Handler)
    server.scenario, server.send_mode = "full", "rejected"
    stage = args.output.resolve() / f"fixture-{server.server_port}"
    config = stage / "config" / "hangar-native"
    config.mkdir(parents=True, mode=0o700)
    with open(config / "connection.json", "x", opener=lambda path, flags: os.open(path, flags, 0o600)) as output:
        json.dump({"address": f"http://127.0.0.1:{server.server_port}", "token": BASE["TOKEN"]}, output)
    (config / "appearance.json").write_text(json.dumps({"theme": args.theme, "language": "pt",
        "navigation": args.navigation, "sidebar_compact": args.compact}))
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
