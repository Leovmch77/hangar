"""Estados sintéticos do LLM do Controle do Windows; usa porta 0 e config isolada.

GET /control/t48: reset=1, enabled=0|1, preset=cliproxy|custom,
cliproxy=missing|stopped|ready|no-key, models=ok|empty|error|slow,
jev=missing|settings|saved.
"""
import json
import pathlib
import threading
import time
from urllib.parse import parse_qs, urlparse

HERE = pathlib.Path(__file__).resolve().parent
SOURCE = (HERE / "task46_windows_targets_fixture.py").read_text(encoding="utf-8")
T46 = {"__name__": "task46_base", "__file__": str(HERE / "task46_windows_targets_fixture.py")}
exec(compile(SOURCE[:SOURCE.index("\nif __name__ ==")], "task46_windows_targets_fixture.py", "exec"), T46)
BASE_SNAPSHOT = T46["snapshot"]
ERROR = T46["ERROR"]
LOCK = threading.Lock()
PRESET_URL = T46["T44"]["PRESET_URL"]
CUSTOM_URL = "https://fixture.example/v1/chat/completions"


def initial():
    return {"preset": "cliproxy", "cliproxy": "ready", "models": "ok",
            "llm_url": PRESET_URL, "llm_model": "modelo-sintetico", "llm_effort": "medium",
            "llm_key": "", "jev_key": "", "jev_settings_key": ""}


STATE = initial()


def snapshot(skipped=None):
    body = BASE_SNAPSHOT(skipped)
    jev = STATE["jev_key"] or STATE["jev_settings_key"]
    body.update(llm_url=STATE["llm_url"], llm_model=STATE["llm_model"], llm_effort=STATE["llm_effort"],
                llm_key_set=bool(STATE["llm_key"]), llm_key_tail=STATE["llm_key"][-4:],
                jev_key_set=bool(jev), jev_key_tail=jev[-4:],
                jev_key_from_settings=not STATE["jev_key"] and bool(STATE["jev_settings_key"]))
    body["cliproxy"].update(installed=STATE["cliproxy"] != "missing",
                            running=STATE["cliproxy"] in ("ready", "no-key"),
                            has_keys=STATE["cliproxy"] != "no-key",
                            key_is_cliproxy=STATE["cliproxy"] != "no-key" and STATE["llm_key"] == "fixture-proxy-key")
    return body


T46["snapshot"] = snapshot
T46["T44"]["snapshot"] = snapshot


class Handler(T46["Handler"]):
    def do_GET(self):
        url = urlparse(self.path)
        if url.path != "/control/t48":
            return super().do_GET()
        query = parse_qs(url.query)
        allowed = {"reset": {"1"}, "enabled": {"0", "1"}, "preset": {"cliproxy", "custom"},
                   "cliproxy": {"missing", "stopped", "ready", "no-key"},
                   "models": {"ok", "empty", "error", "slow"},
                   "jev": {"missing", "settings", "saved"}}
        if any(key not in allowed or len(values) != 1 or values[0] not in allowed[key] for key, values in query.items()):
            return self.send_json({"detail": "controle inválido"}, 400)
        with LOCK:
            if "reset" in query:
                STATE.clear()
                STATE.update(initial())
                T46["T44"]["STATE"].clear()
                T46["T44"]["STATE"].update(T46["T44"]["initial"]())
                T46["TARGETS"].clear()
                T46["CONTROL"].update(test="ok", setup="ok", create="ok")
            if "enabled" in query:
                T46["T44"]["STATE"]["enabled"] = query["enabled"][0] == "1"
            for key in ("preset", "cliproxy", "models"):
                if key in query:
                    STATE[key] = query[key][0]
            if "jev" in query:
                STATE["jev_key"] = "fixture-jev-key" if query["jev"][0] == "saved" else ""
                STATE["jev_settings_key"] = "fixture-settings-key" if query["jev"][0] == "settings" else ""
            if "preset" in query:
                STATE["llm_url"] = PRESET_URL if STATE["preset"] == "cliproxy" else CUSTOM_URL
            body = snapshot()
        return self.send_json(body)

    def do_POST(self):
        if urlparse(self.path).path != "/api/computer-control/models":
            return super().do_POST()
        if not self.authorized():
            return
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
        if not str(body.get("llm_url") or "").startswith(("http://", "https://")):
            return self.send_json(ERROR("erro_computer_control_url", "a URL do LLM precisa começar com http:// ou https://"), 400)
        with LOCK:
            result = STATE["models"]
            saved_key = STATE["llm_key"]
            cliproxy = STATE["cliproxy"]
        print("POST /api/computer-control/models synthetic", flush=True)
        if body["llm_url"] == PRESET_URL:
            authorized = bool(body.get("use_cliproxy_key")) and cliproxy != "no-key"
        else:
            supplied = body.get("llm_key") or (saved_key if body.get("use_saved_key") else "")
            authorized = body["llm_url"] == CUSTOM_URL and supplied == "fixture-custom-key"
        if not authorized:
            return self.send_json(ERROR("erro_computer_control_models", "o endpoint respondeu 401 ao listar modelos", error="HTTP 401"), 502)
        if result == "slow":
            time.sleep(3)
        if result == "error":
            return self.send_json(ERROR("erro_computer_control_models", "o endpoint respondeu 503 ao listar modelos", error="HTTP 503"), 502)
        names = ["modelo-sintetico", "outro-modelo"] if body["llm_url"] == PRESET_URL else ["modelo-custom", "outro-modelo"]
        return self.send_json({"models": [] if result == "empty" else names})

    def do_PUT(self):
        if urlparse(self.path).path != "/api/computer-control":
            return super().do_PUT()
        if not self.authorized():
            return
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
        print("PUT /api/computer-control synthetic", flush=True)
        with LOCK:
            base = T46["T44"]["STATE"]
            if body.get("enabled"):
                if base["save"] == "error":
                    agent = body["agent_config"]
                    return self.send_json(ERROR("erro_computer_control_agent", f"o arquivo {agent} não existe", file=agent), 400)
                if not str(body.get("llm_url") or "").startswith(("http://", "https://")):
                    return self.send_json(ERROR("erro_computer_control_url", "a URL do LLM precisa começar com http:// ou https://"), 400)
                effort = str(body.get("llm_effort") or "")
                if effort not in ("", "low", "medium", "high"):
                    return self.send_json(ERROR("erro_computer_control_effort", f"esforço inválido: {effort}", effort=effort), 400)
                if body.get("use_cliproxy_key") and STATE["cliproxy"] == "no-key":
                    return self.send_json(ERROR("erro_computer_control_cliproxy_key",
                                                "o ~/.cli-proxy-api/config.yaml não tem nenhuma api-key"), 400)
                base.update(enabled=True, project_dir=body["project_dir"], agent_config=body["agent_config"])
                STATE.update(llm_url=body["llm_url"], llm_model=body["llm_model"], llm_effort=effort)
                if body.get("use_cliproxy_key"):
                    STATE["llm_key"] = "fixture-proxy-key"
                elif body.get("llm_key"):
                    STATE["llm_key"] = body["llm_key"]
                if body.get("jev_key"):
                    STATE["jev_key"] = body["jev_key"]
            else:
                base["enabled"] = False
            reply = snapshot()
        self.send_json(reply)


if __name__ == "__main__":
    T46["T44"]["T43"]["Handler"] = Handler
    T46["T44"]["T43"]["main"]()
