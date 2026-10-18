"""Golden do seletor do `/model` dirigido pelo Python (`TerminalInput.set_model_effort`), sem tmux real.

Cada caso dá ao driver as capturas do pane em sequência (a última se repete) e grava as teclas que ele
mandou e o que respondeu. O Rust repete as mesmas capturas no ator do terminal e compara.

Uso, de backend/: uv run python tests/fixtures/contract/gen_model_picker.py
"""
import json
import subprocess
import sys
from pathlib import Path
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parents[2]))
from app import model_picker as mp  # noqa: E402
from app import terminal_input  # noqa: E402
from app.terminal_input import TerminalInput  # noqa: E402

FIX = HERE.parent
OPUS = (FIX / "pane_model_picker_opus.txt").read_text(encoding="utf-8")
HAIKU = (FIX / "pane_model_picker_haiku.txt").read_text(encoding="utf-8")
FABLE = (FIX / "pane_model_picker_fable.txt").read_text(encoding="utf-8")
IDLE = "assistant: pronto\n❯ \n"
NOT_OPEN = "❯ \nsem picker aqui\n"
RESULT = "❯ \n  ⎿  Set model to Opus 4.8 for this session only with max effort\n"
# Picker do Claude Code 5 com as duas linhas `opus` (test_model_picker.PANE_DUAS_OPUS).
DUAS_OPUS = """\
   Select model
   Switch between Claude models.

     1. Default (recommended)  Sonnet 5 · Efficient for routine tasks
     2. Sonnet                 Sonnet 5 · Efficient for routine tasks
     3. Fable                  Fable 5 · Most capable
   ❯ 4. Opus                   Opus 5 · Best for everyday, complex tasks
     5. Haiku                  Haiku 4.5 · Fastest for quick answers
     6. Opus (1M context) ✔    Opus 5 with 1M context · Best for everyday, complex tasks

   ◉ High effort ←/→ to adjust

   Enter to set as default · s to use this session only · Esc to cancel
"""
# test_model_picker.EFFORT_CONFIRM_PANE
CONFIRM = (
    "   Change effort level?\n"
    "   Your next response will be slower and use more tokens\n"
    "\n"
    "   This conversation is cached for the current effort level. Switching to max means the\n"
    "   full history gets re-read on your next message.\n"
    "\n"
    "   ❯ 1. Yes, switch to max\n"
    "     2. No, go back\n"
)


def effort(word, base=OPUS):
    return base.replace("◉ xHigh effort", f"◉ {word} effort")


def run(name, panes, model=None, effort_=None, scope="session"):
    queue = list(panes)

    def capture(_name):
        return queue.pop(0) if len(queue) > 1 else queue[0]

    with patch.object(terminal_input.tmux, "capture_pane", side_effect=capture), \
         patch.object(terminal_input, "send_keys") as sent, \
         patch.object(terminal_input.tmux, "has_session", return_value=True), \
         patch.object(terminal_input.time, "sleep"):
        try:
            out = {"ok": TerminalInput().set_model_effort("cc", model=model, effort=effort_, scope=scope)}
        except mp.PickerError as e:
            out = {"error": {"status": e.status, "detail": e.detail}}
    return {"name": name, "request": {"model": model, "effort": effort_, "scope": scope}, "panes": panes,
            "keys": [c.args[1] for c in sent.call_args_list], "expect": out}


def main():
    cases = [
        run("session_navigates_and_presses_s", [IDLE, OPUS, effort("xHigh"),
            "❯ \n  ⎿  Set model to Sonnet 4.6 for this session only with xhigh effort\n"], model="sonnet"),
        run("default_presses_enter", [IDLE, OPUS, OPUS,
            "❯ \n  ⎿  Set model to Opus 4.8 and saved as your default for new sessions\n"], model="opus", scope="default"),
        run("effort_with_right", [IDLE, OPUS, effort("Max"), RESULT], effort_="max"),
        run("effort_cycle_unavailable", [IDLE, effort("High"), effort("Max"), effort("Low"), effort("Medium"), effort("High"), RESULT],
            effort_="ultracode"),
        run("effort_rereads_once", [IDLE, OPUS, OPUS.replace("◉ xHigh effort ←/→ to adjust", ""), effort("Max"), RESULT], effort_="max"),
        run("effort_not_supported", [IDLE, HAIKU, "❯ \n  ⎿  Set model to Haiku 4.5 for this session only\n"], effort_="high"),
        run("model_and_effort", [IDLE, OPUS, OPUS, effort("Max"), RESULT], model="opus", effort_="max"),
        run("pending_confirm", [IDLE, OPUS, effort("Max"), CONFIRM], effort_="max"),
        run("never_opens", [IDLE, NOT_OPEN], model="sonnet"),
        run("half_redraw_then_open", [IDLE, "❯ \n", OPUS, OPUS, RESULT], model="opus"),
        run("partial_then_drawn", [IDLE, OPUS.replace("   Enter to set as default · s to use this session only · Esc to cancel", ""),
            OPUS, OPUS, RESULT], model="opus"),
        run("absent_model", [IDLE, OPUS], model="gpt"),
        run("variant_1m", [IDLE, DUAS_OPUS, DUAS_OPUS, "❯ \n  ⎿  Set model to Opus 5 (1M context) for this session only\n"], model="opus[1m]"),
        run("still_open_after_confirm", [IDLE, OPUS, effort("Max"), OPUS], effort_="max"),
        run("session_got_default", [IDLE, OPUS, OPUS, "❯ \n  ⎿  Set model to Sonnet 4.6 and saved as your default for new sessions\n"],
            model="sonnet"),
        run("overlay_refuses", ["algo\n   ↑/↓ to navigate · Enter to select\n"], model="sonnet"),
        run("spinner_live_refuses", ["✻ Crunched for 24s\n❯ \n", "✻ Crunched for 26s\n❯ \n"], model="sonnet"),
        run("spinner_frozen_goes", ["✻ Crunched for 24s\n❯ \n", "✻ Crunched for 24s\n❯ \n", FABLE, FABLE,
            "❯ \n  ⎿  Set model to Opus 5 for this session only with high effort\n"], model="opus"),
        run("blank_model_presses_s", [IDLE, OPUS, RESULT], model="  "),
        run("model_normalized", [IDLE, OPUS, OPUS, RESULT], model=" OPUS "),
    ]
    commit = subprocess.run(["git", "rev-parse", "HEAD"], capture_output=True, text=True, cwd=HERE).stdout.strip()
    data = {"origin": {"commit": commit, "command": "uv run python tests/fixtures/contract/gen_model_picker.py"}, "cases": cases}
    (HERE / "golden" / "model_picker.json").write_text(json.dumps(data, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
