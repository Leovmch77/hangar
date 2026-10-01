import pytest

from app.terminal_prompt import logical_line, parse_prompt


@pytest.mark.parametrize("line,expected", [
    ("Pasta do PSS na VM [C:\\Sistemas\\PServer\\PSS]: ",
     {"text": "Pasta do PSS na VM", "default": "C:\\Sistemas\\PServer\\PSS"}),
    ("Destino SSH da VM (usuario@host ou alias do ~/.ssh/config) [Administrator@delphi-02]:",
     {"text": "Destino SSH da VM (usuario@host ou alias do ~/.ssh/config)", "default": "Administrator@delphi-02"}),
    ("Porta [3000]: ", {"text": "Porta", "default": "3000"}),
    ("Senha: ", {"text": "Senha", "default": ""}),
    ("Continuar? ", {"text": "Continuar?", "default": ""}),
])
def test_prompt_lines(line, expected):
    assert parse_prompt(line) == expected


@pytest.mark.parametrize("line", [
    "", "   ", ":",
    "[12:00:01] ATIVO: VM 127.0.0.1:3000 -> esta máquina 127.0.0.1:3000. Ctrl+C para parar.",
    "[12:00:01] Não consegui ler a porta do PMW na VM (SSH ou appsettings). Tentando de novo em 15s.",
    "~/projeto-web $ ", "usuario@maquina:~$ ", "PS C:\\Users\\Administrator> ",
])
def test_not_a_prompt(line):
    assert parse_prompt(line) is None


def test_logical_line_joins_hard_wrapped_rows():
    full = "x" * 80
    assert logical_line(["antes", full, "-02]:"], 2, 80) == full + "-02]:"
    assert logical_line([full, full, "fim:"], 2, 80) == full + full + "fim:"


def test_logical_line_puts_back_the_space_the_capture_trimmed():
    # Quebra logo depois de um espaco: o capture-pane tira o espaco e a linha fica com width - 1.
    assert logical_line(["a" * 79, "Porta [3]:"], 1, 80) == "a" * 79 + " Porta [3]:"


def test_logical_line_stops_at_a_short_row_and_at_the_top():
    assert logical_line(["curta", "Porta:"], 1, 80) == "Porta:"
    assert logical_line(["x" * 80, "Porta:"], 1, 80) == "x" * 80 + "Porta:"
    assert logical_line(["Porta:"], 0, 80) == "Porta:"
    assert logical_line([], 3, 80) == ""
