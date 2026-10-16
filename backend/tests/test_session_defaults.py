"""Regressões da escolha e da memória do provedor na abertura."""
import pytest

from app.session_defaults import choose_provider


@pytest.mark.parametrize("remembered,connected,disconnected,expected", [
    (None, {"codex"}, {"claude"}, "codex"),
    ("claude", {"codex"}, {"claude"}, "codex"),
    ("codex", {"claude", "codex"}, set(), "codex"),
    ("pi", {"claude", "codex"}, set(), "pi"),
    ("kimi", {"codex"}, {"claude"}, "codex"),
    ("codex", set(), {"claude", "codex"}, "codex"),
])
def test_provider_choice(remembered, connected, disconnected, expected):
    probes = {provider: {"disponivel": provider != "kimi"}
              for provider in ("claude", "codex", "pi", "kimi")}
    assert choose_provider(probes, remembered, connected, disconnected) == expected
