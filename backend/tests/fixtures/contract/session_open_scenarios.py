"""Cenários do contrato de abertura de sessão (entrada); a saída esperada sai de executar o Python.

`<ROOT>` é a raiz temporária do cenário (HOME = <ROOT>/home). Um cenário: estado inicial
(`state`), bordas falsas (`fakes`) e passos (`steps`: pedido HTTP ou chamada direta).
"""
import copy
from pathlib import Path

_PANES = Path(__file__).resolve().parents[1]
AWAITING_SCREEN = (_PANES / "pane_awaiting_input.txt").read_text(encoding="utf-8")
_IDLE = (_PANES / "pane_idle.txt").read_text(encoding="utf-8")
ACCEPT_EDITS_SCREEN = _IDLE.replace("bypass permissions on", "accept edits on")
NO_FOOTER_SCREEN = "\n".join(_IDLE.splitlines()[:-1]) + "\n"

H = "<ROOT>/home"
W = "<ROOT>/work"
PROJ = f"{W}/proj"
SID_A = "11111111-1111-4111-8111-111111111111"
SID_B = "22222222-2222-4222-8222-222222222222"
THREAD = "33333333-3333-4333-8333-333333333333"

BASE_STATE = {
    "files": {
        f"{H}/.claude/.credentials.json": {"claudeAiOauth": {"accessToken": "fake"}},
        f"{H}/.claude.json": {"numStartups": 3},
        f"{H}/.claude-b/.credentials.json": {"claudeAiOauth": {"accessToken": "fake-b"}},
        f"{H}/.claude-b/.claude.json": {"numStartups": 1},
        f"{PROJ}/README.md": "projeto\n",
    },
    "dirs": [f"{H}/.claude/projects", f"{H}/.claude-b/projects"],
}


def _merge(base: dict, extra: dict | None) -> dict:
    out = copy.deepcopy(base)
    for k, v in (extra or {}).items():
        if isinstance(v, dict):
            out.setdefault(k, {}).update(v)
        elif isinstance(v, list):
            out.setdefault(k, []).extend(v)
        else:
            out[k] = v
    return out


def scenario(name: str, group: str, steps: list, state: dict | None = None, fakes: dict | None = None,
             about: str = "") -> dict:
    return {"name": name, "group": group, "about": about, "state": _merge(BASE_STATE, state),
            "fakes": fakes or {}, "steps": steps}


def post_create(body: dict) -> dict:
    return {"method": "POST", "path": "/api/sessions", "json": body}


def create(name: str, body: dict, about: str = "", **kw) -> dict:
    return scenario(name, "a-create", [post_create({"cwd": PROJ, **body})], about=about, **kw)


B = f"{H}/.claude-b"
C = f"{H}/.claude-conta2"
REPO_DIR = f"{H}/pessoal/repo"


def transcript(cfg: str, cwd_sanitized: str, sid: str, mode: str) -> dict:
    return {f"{cfg}/projects/{cwd_sanitized}/{sid}.jsonl":
            '{"type":"user","permissionMode":"%s","message":{"role":"user","content":"oi"}}\n' % mode}


def headless_sidecar(name: str, **meta) -> dict:
    base = {"name": name, "provider": "claude", "headless": True, "key": "a" * 32, "cwd": PROJ,
            "session_id": SID_A, "config_dir": None, "engine": None, "model": None, "effort": None,
            "context_window": None, "permission_mode": "bypassPermissions", "previous_non_plan": None,
            "subagent_model": None, "jev": False}
    return {f"{H}/.hangar/claude-headless/{name}.json": {**base, **meta}}


def codex_sidecar(name: str, **meta) -> dict:
    base = {"name": name, "provider": "codex", "thread_id": THREAD, "rollout_path": "", "cwd": PROJ,
            "model": None, "effort": None, "codex_home": f"{H}/.codex", "codex_account": None,
            "headless": True, "key": "b" * 32, "permission_mode": "Full Access", "jev": False}
    return {f"{H}/.hangar/codex-sessions/{name}.json": {**base, **meta}}


def terminal_session(name: str, command: str, env: dict | None = None, **extra) -> dict:
    return {"tmux_sessions": [{"name": name, "cwd": PROJ, "command": command,
                               "env": {"CP_SESSION_NAME": name, "CP_PROVIDER": "claude", **(env or {})}, **extra}]}


ENGINE = {f"{H}/.claude/engines.json": {"kimi": {"base_url": "https://api.example.invalid/anthropic",
                                                  "api_key": "sk-fake", "model": "k3-256k"}}}
HANGAR_ACCOUNT = {"files": {f"{C}/.hangar-conta": "", f"{C}/.claude.json": {"numStartups": 1}},
                  "dirs": [f"{C}/projects"]}
QUOTA_FULL = {"quotas": [
    {"id": f"claude:{H}/.claude", "label": "default", "provedor": "claude", "ativa": True, "estado": "lida",
     "janelas": [{"rotulo": "5h", "pct": 97.0}, {"rotulo": "7d", "pct": 40.0}]},
    {"id": f"claude:{B}", "label": "b", "provedor": "claude", "ativa": False, "estado": "lida",
     "janelas": [{"rotulo": "5h", "pct": 10.0}, {"rotulo": "7d", "pct": 20.0}]},
]}
BWRAP_OK = {"programs": [{"prog": "bwrap", "args": [], "stdout": "", "rc": 0}]}
CREATOR_HEADLESS = {"files": {**headless_sidecar("mae", config_dir=B, permission_mode="acceptEdits")}}
CREATOR_TERMINAL = {"files": transcript(B, "<ROOT_SANITIZED>-work-proj", SID_B, "acceptEdits"),
                    **terminal_session("mae", f"exec claude --session-id {SID_B} --permission-mode acceptEdits",
                                       {"CLAUDE_CONFIG_DIR": B})}
CREATOR_CODEX = {"files": codex_sidecar("mae-codex", permission_mode="Approve for me")}

T = {"provider": "claude", "headless": False}

SCENARIOS = [
    # Claude com terminal
    create("create_claude_terminal_default", {"name": "s1", **T},
           "Claude com terminal na conta padrão, sem escolhas"),
    create("create_claude_terminal_account_b", {"name": "s1", **T, "config_dir": B},
           "conta explícita (pasta ~/.claude-b com login e projects/)"),
    create("create_claude_terminal_hangar_account", {"name": "s1", **T, "config_dir": C},
           "conta criada pelo Hangar (marcador): reconcilia antes de criar", state=HANGAR_ACCOUNT),
    create("create_claude_terminal_choices", {"name": "s1", **T, "model": "opus", "effort": "high",
                                              "permission_mode": "acceptEdits", "subagent_model": "sonnet"},
           "modelo, esforço, modo de permissão e modelo dos subagentes"),
    create("create_claude_terminal_plan_mode", {"name": "s1", **T, "permission_mode": "plan"}),
    create("create_claude_terminal_account_default_mode",
           {"name": "s1", **T}, "settings.json da conta com defaultMode=default vira manual",
           state={"files": {f"{H}/.claude/settings.json": {"permissions": {"defaultMode": "default"}}}}),
    create("create_claude_terminal_jev_true", {"name": "s1", **T, "jev": True},
           state={"files": {f"{H}/.claude/runtime-config.json": {"jev_api_key": "tsk-fake", "jev_model": "m1"}}}),
    create("create_claude_terminal_jev_default_on", {"name": "s1", **T},
           "jev omitido herda jev_padrao=true do servidor",
           state={"files": {f"{H}/.claude/runtime-config.json": {"jev_padrao": True, "jev_api_key": "tsk-fake"}}}),
    create("create_claude_terminal_jev_false_overrides_default", {"name": "s1", **T, "jev": False},
           state={"files": {f"{H}/.claude/runtime-config.json": {"jev_padrao": True, "jev_api_key": "tsk-fake"}}}),
    create("create_claude_terminal_engine", {"name": "s1", **T, "engine": "kimi", "model": "k3-256k"},
           "motor: prefixo hangar-engine; a janela do catálogo não responde (rede recusada)",
           state={"files": ENGINE}),
    create("create_claude_terminal_read_only", {"name": "s1", **T, "read_only": True},
           "read_only: prefixo bwrap no comando", fakes=BWRAP_OK),
    create("create_claude_terminal_initial_prompt_ignored", {"name": "s1", **T, "initial_prompt": "olá"},
           "initial_prompt em Claude com terminal some calado (suspeita CRI bug 1)"),
    create("create_claude_terminal_name_sanitized", {"name": "São Paulo/ação", **T}),
    create("create_claude_terminal_tmux_fails", {"name": "s1", **T},
           "tmux new-session recusa: 409 erro_criacao_sessao",
           fakes={"tmux_new_session": {"rc": 1, "stderr": "server exited unexpectedly\n"}}),
    create("create_claude_customizations", {"name": "s1", **T, "claude_customizations": {
        "plugins": {"github-actions@local": False}, "skills": {"revisar": True}, "blocked_skills": []}},
           "seleção de plugins/skills: a ponte do Rust devolve as settings",
           fakes={"rust_bridge": {"claude_customizations.prepare": {"result": {"settings": {
               "enabledPlugins": {"github-actions@local": False}, "skillOverrides": {"revisar": "on"}}}}}}),
    # Claude sem terminal
    create("create_claude_headless_default", {"name": "s1", "provider": "claude", "headless": True},
           "sidecar gravado e o pedido de acordar o processo"),
    scenario("create_claude_headless_then_launch", "a-create",
             [post_create({"cwd": PROJ, "name": "s1", "provider": "claude", "headless": True,
                           "model": "opus", "effort": "xhigh", "permission_mode": "plan",
                           "subagent_model": "haiku", "jev": True, "config_dir": B}),
              {"call": "launch_headless", "name": "s1"}],
             about="plano de lançamento do processo sem terminal (argv/ambiente do cano), sem subir nada",
             state={"files": {f"{H}/.claude/runtime-config.json": {"jev_api_key": "tsk-fake"}}}),
    scenario("create_claude_headless_engine_then_launch", "a-create",
             [post_create({"cwd": PROJ, "name": "s1", "provider": "claude", "headless": True,
                           "engine": "kimi", "model": "k3-256k"}),
              {"call": "launch_headless", "name": "s1"}],
             about="sem terminal com motor: sidecar e prefixo hangar-engine no lançamento",
             state={"files": ENGINE}),
    scenario("create_claude_headless_customizations_then_launch", "a-create",
             [post_create({"cwd": PROJ, "name": "s1", "provider": "claude", "headless": True,
                           "claude_customizations": {"plugins": {"github-actions@local": False}}}),
              {"call": "launch_headless", "name": "s1"}],
             about="settings da sessão no sidecar e --settings no lançamento",
             fakes={"rust_bridge": {"claude_customizations.prepare": {"result": {"settings": {
                 "enabledPlugins": {"github-actions@local": False}}}}}}),
    create("create_codex_account_unknown", {"name": "cx", "provider": "codex", "codex_account": "nao-existe"}),
    create("create_claude_headless_omitted_uses_server_default", {"name": "s1", "provider": "claude"},
           "headless omitido: headless_default do servidor (padrão)"),
    create("create_claude_headless_default_off", {"name": "s1", "provider": "claude"},
           "headless omitido com headless_default=false vira terminal",
           state={"files": {f"{H}/.claude/runtime-config.json": {"headless_default": False}}}),
    create("create_claude_headless_initial_prompt_refused", {"name": "s1", "provider": "claude", "headless": True,
                                                            "initial_prompt": "olá"}),
    create("create_claude_headless_read_only_refused", {"name": "s1", "provider": "claude", "headless": True,
                                                       "read_only": True}, fakes=BWRAP_OK),
    # Herança da criadora
    create("create_inherit_from_headless_creator", {"name": "filha", "provider": "claude", "creator": "mae"},
           "herda conta, sem terminal e modo de permissão da criadora sem terminal", state=CREATOR_HEADLESS),
    create("create_inherit_from_terminal_creator", {"name": "filha", "provider": "claude", "creator": "mae"},
           "herda conta do ambiente do pane, terminal e modo do transcript", state=CREATOR_TERMINAL),
    create("create_inherit_explicit_wins", {"name": "filha", "provider": "claude", "creator": "mae",
                                            "config_dir": f"{H}/.claude", "headless": True,
                                            "permission_mode": "manual"}, state=CREATOR_TERMINAL),
    create("create_inherit_from_codex_creator", {"name": "filha", "provider": "claude", "creator": "mae-codex"},
           "criadora Codex: modo mapeado, conta padrão", state=CREATOR_CODEX),
    create("create_inherit_creator_missing", {"name": "filha", "provider": "claude", "creator": "nao-existe",
                                              "headless": False}),
    create("create_inherit_creator_account_unreadable", {"name": "filha", "provider": "claude", "creator": "mae"},
           "pane da criadora sem ambiente legível: 409 erro_conta_criadora",
           state=terminal_session("mae", f"exec claude --session-id {SID_B}", environ_unreadable=True)),
    create("create_inherit_flag_not_supported", {"name": "filha", "provider": "claude", "creator": "mae",
                                                 "inherit": False},
           "D-001 `inherit` ainda não existe no Python: 422", state=CREATOR_HEADLESS),
    # Cota
    create("create_quota_switch", {"name": "s1", **T},
           "conta padrão a 97%: nasce na de mais folga, account_source=quota", fakes=QUOTA_FULL),
    create("create_quota_explicit_account_kept", {"name": "s1", **T, "config_dir": f"{H}/.claude"},
           "conta explícita não troca", fakes=QUOTA_FULL),
    create("create_quota_inherited_switch", {"name": "filha", "provider": "claude", "creator": "mae",
                                             "headless": False},
           "conta herdada também troca", state={"files": headless_sidecar("mae", config_dir=None)},
           fakes=QUOTA_FULL),
    # Recusas
    create("create_refuse_unknown_field", {"name": "s1", "bogus": 1}),
    create("create_refuse_empty_name", {"name": ""}),
    create("create_refuse_bool_as_string", {"name": "s1", "headless": "true"}),
    create("create_refuse_service_tier_invalid", {"name": "s1", "service_tier": "fast"}),
    create("create_refuse_service_tier_claude", {"name": "s1", **T, "service_tier": "priority"}),
    create("create_refuse_provider_invalid", {"name": "s1", "provider": "gemini"}),
    create("create_refuse_cwd_missing", {"name": "s1", **T, "cwd": f"{W}/nao-existe"}),
    create("create_refuse_config_dir_unknown", {"name": "s1", **T, "config_dir": f"{H}/.claude-x"}),
    create("create_refuse_engine_unknown", {"name": "s1", **T, "engine": "nada"}),
    create("create_refuse_engine_on_codex", {"name": "s1", "provider": "codex", "engine": "kimi"},
           state={"files": ENGINE}),
    create("create_refuse_model_injection", {"name": "s1", **T, "model": "k3; touch /tmp/x"}),
    create("create_refuse_effort_unknown", {"name": "s1", **T, "effort": "turbo"}),
    create("create_refuse_permission_unknown", {"name": "s1", **T, "permission_mode": "yolo"}),
    create("create_refuse_permission_on_pi", {"name": "s1", "provider": "pi", "permission_mode": "manual"}),
    create("create_refuse_profile_on_claude", {"name": "s1", **T, "omp_profile": "work"}),
    create("create_refuse_subagent_with_engine", {"name": "s1", **T, "engine": "kimi", "subagent_model": "sonnet"},
           state={"files": ENGINE}),
    create("create_refuse_codex_account_on_claude", {"name": "s1", **T, "codex_account": "x"}),
    create("create_refuse_customizations_on_pi", {"name": "s1", "provider": "pi",
                                                  "claude_customizations": {"plugins": {}}}),
    create("create_refuse_name_in_use_tmux", {"name": "dup", **T},
           state=terminal_session("dup", f"exec claude --session-id {SID_B}")),
    create("create_refuse_name_in_use_headless", {"name": "dup", **T}, state={"files": headless_sidecar("dup")}),
    create("create_refuse_name_in_use_codex", {"name": "dup", **T}, state={"files": codex_sidecar("dup")}),
    create("create_refuse_name_all_non_ascii", {"name": "会话", **T}),
    create("create_refuse_new_branch_without_branch", {"name": "s1", **T, "new_branch": True}),
    # Worktree
    create("create_worktree_new_branch", {"name": "s1", **T, "cwd": REPO_DIR, "branch": "feat/x",
                                          "new_branch": True},
           "worktree nova ao lado do repo, branch nova com hangar-base, ignorados copiados",
           state={"git_repos": [{"path": REPO_DIR, "files": {"a.txt": "a\n"}, "gitignore": ".env\n",
                                 "ignored": {".env": "SEGREDO=1\n"}}]}),
    create("create_worktree_existing_branch", {"name": "s1", **T, "cwd": REPO_DIR, "branch": "dev"},
           state={"git_repos": [{"path": REPO_DIR, "files": {"a.txt": "a\n"}, "branches": ["dev"]}]}),
    create("create_worktree_current_branch", {"name": "s1", **T, "cwd": REPO_DIR, "branch": "main"},
           "branch igual à atual: sem worktree", state={"git_repos": [{"path": REPO_DIR, "files": {"a.txt": "a\n"}}]}),
    create("create_worktree_outside_roots", {"name": "s1", **T, "branch": "feat/x", "new_branch": True},
           "cwd fora das raízes permitidas: 403"),
    create("create_worktree_rollback_on_tmux_failure", {"name": "s1", **T, "cwd": REPO_DIR, "branch": "feat/y",
                                                        "new_branch": True},
           "criação falha depois da worktree: worktree e branch desfeitas",
           state={"git_repos": [{"path": REPO_DIR, "files": {"a.txt": "a\n"}}]},
           fakes={"tmux_new_session": {"rc": 1, "stderr": "boom\n"}}),
    # Codex
    create("create_codex_terminal_default", {"name": "cx", "provider": "codex", "headless": False}),
    create("create_codex_terminal_initial_prompt", {"name": "cx", "provider": "codex", "headless": False,
                                                    "initial_prompt": "começa por aqui"}),
    create("create_codex_headless_default", {"name": "cx", "provider": "codex", "headless": True,
                                             "permission_mode": "Ask for approval"}),
    create("create_codex_headless_bad_permission", {"name": "cx", "provider": "codex", "headless": True,
                                                    "permission_mode": "Tudo"}),
    create("create_codex_terminal_permission_refused", {"name": "cx", "provider": "codex", "headless": False,
                                                        "permission_mode": "manual"}),
    create("create_codex_model_catalog_unavailable", {"name": "cx", "provider": "codex", "headless": False,
                                                      "model": "gpt-5.5", "effort": "high"},
           "catálogo do Codex não responde: segue sem conferir"),
    create("create_codex_priority_catalog_unavailable", {"name": "cx", "provider": "codex", "headless": False,
                                                         "service_tier": "priority"},
           "Fast sem catálogo: 502"),
    # Pi, omp, Kimi
    create("create_pi_terminal", {"name": "p1", "provider": "pi", "model": "anthropic/claude-sonnet-4", "effort": "low"}),
    create("create_omp_terminal", {"name": "o1", "provider": "omp"}),
    create("create_omp_terminal_profile", {"name": "o1", "provider": "omp", "omp_profile": "work"}),
    create("create_omp_terminal_profile_invalid", {"name": "o1", "provider": "omp", "omp_profile": "../x"}),
    create("create_kimi_terminal", {"name": "k1", "provider": "kimi", "model": "kimi-k3"}),
    create("create_kimi_effort_refused", {"name": "k1", "provider": "kimi", "effort": "high"}),
    create("create_pi_headless_refused", {"name": "p1", "provider": "pi", "headless": True}),
    # Provedor omitido e lembrado
    create("create_provider_omitted", {"name": "s1", "headless": False},
           "provider omitido: catálogo pelo PATH do shell de login + logins"),
    create("create_provider_implied_by_omp_profile", {"name": "o1", "omp_profile": "work"}),
    create("create_remember_provider", {"name": "p1", "provider": "pi", "remember_provider": True}),
    create("create_codex_catalog_ok", {"name": "cx", "provider": "codex", "headless": False,
                                       "model": "gpt-5.5", "effort": "high", "service_tier": "priority"},
           "catálogo do Codex (ponte do Rust) aceita a escolha",
           fakes={"rust_bridge": {"dictation.catalog_models": {"result": {"models": [{"model": "gpt-5.5"}]}},
                                  "dictation.validate_model": {"result": {}}}}),
    create("create_codex_catalog_refuses_choice", {"name": "cx", "provider": "codex", "headless": False,
                                                   "model": "gpt-5.5", "effort": "ultra"},
           "catálogo recusa o nível: 422 erro_codex_escolha_invalida",
           fakes={"rust_bridge": {"dictation.catalog_models": {"result": {"models": [{"model": "gpt-5.5"}]}},
                                  "dictation.validate_model": {"error": {"status": 400, "code": "dictation_invalid",
                                                                         "detail": "effort: ultra não existe"}}}}),
]

# ── Reabrir Claude (grupo b) ────────────────────────────────────────────────────────────────

CANO_PID = 9_000_101
CLAUDE_PID = 9_000_102
SANITIZED_PROJ = "<ROOT_SANITIZED>-work-proj"
TRANSCRIPT_A = {f"{H}/.claude/projects/{SANITIZED_PROJ}/{SID_A}.jsonl":
                '{"type":"user","cwd":"%s","sessionId":"%s","permissionMode":"acceptEdits",'
                '"message":{"role":"user","content":"oi"}}\n'
                '{"type":"assistant","cwd":"%s","sessionId":"%s","message":{"role":"assistant",'
                '"content":[{"type":"text","text":"ola"}]}}\n' % (PROJ, SID_A, PROJ, SID_A)}
TERMINAL_A = {"files": TRANSCRIPT_A,
              **terminal_session("s1", f"exec env -u CLAUDE_CONFIG_DIR claude --session-id {SID_A} "
                                       "--permission-mode acceptEdits", screen=ACCEPT_EDITS_SCREEN)}
TERMINAL_A_NO_FOOTER = {"files": TRANSCRIPT_A,
                        **terminal_session("s1", f"exec env -u CLAUDE_CONFIG_DIR claude --session-id {SID_A} "
                                                 "--permission-mode acceptEdits", screen=NO_FOOTER_SCREEN)}
HEADLESS_A = {
    "files": {**TRANSCRIPT_A, **headless_sidecar("s1", permission_mode="acceptEdits", model="opus", cano={
        "pid": CANO_PID, "escuta": f"unix:{H}/.hangar/claude-headless/cano-{'a' * 16}-0000.sock",
        "token": "t" * 32, "ts": 1760000000, "versao": 2})},
    "processes": [
        {"pid": CANO_PID, "argv": ["python3", "cano.py", "--", "claude", "-p", "--session-id", SID_A],
         "env": {"HANGAR_CANO_KEY": "a" * 32}, "label": "cano"},
        {"pid": CLAUDE_PID, "ppid": CANO_PID, "argv": ["claude", "-p", "--session-id", SID_A],
         "env": {"HANGAR_CANO_KEY": "a" * 32}, "label": "claude-headless"},
    ],
}


def session_route(name: str, group: str, session: str, route: str, body: dict | None, state: dict,
                  about: str = "", method: str = "POST", **kw) -> dict:
    step = {"method": method, "path": f"/api/sessions/{session}/{route}"}
    if body is not None:
        step["json"] = body
    return scenario(name, group, [step], state=state, about=about, **kw)


QUOTA_B_FULL = {"quotas": [
    {"id": f"claude:{B}", "label": "b", "provedor": "claude", "ativa": False, "estado": "lida",
     "janelas": [{"rotulo": "5h", "pct": 99.5}]}]}

SCENARIOS += [
    session_route("reopen_mode_terminal_to_headless", "b-reopen-claude", "s1", "modo-execucao", {"terminal": False},
                  TERMINAL_A, "terminal vira sem terminal: pane fecha, sidecar gravado, processo pedido ao runtime"),
    session_route("reopen_mode_terminal_to_headless_footer_unreadable", "b-reopen-claude", "s1", "modo-execucao",
                  {"terminal": False}, TERMINAL_A_NO_FOOTER,
                  "rodapé sem modo legível: o sidecar nasce sem permission_mode (suspeita S-01)"),
    session_route("reopen_reload_terminal_footer_unreadable", "b-reopen-claude", "s1", "recarregar", None,
                  TERMINAL_A_NO_FOOTER, "recarregar com rodapé ilegível: o pane volta sem --permission-mode"),
    session_route("reopen_mode_headless_to_terminal", "b-reopen-claude", "s1", "modo-execucao", {"terminal": True},
                  HEADLESS_A, "sem terminal vira terminal: cano encerrado e pane com --resume"),
    session_route("reopen_mode_same_mode_noop", "b-reopen-claude", "s1", "modo-execucao", {"terminal": True},
                  TERMINAL_A),
    session_route("reopen_mode_busy_terminal", "b-reopen-claude", "s1", "modo-execucao", {"terminal": False},
                  {"files": TRANSCRIPT_A, **terminal_session(
                      "s1", f"exec env -u CLAUDE_CONFIG_DIR claude --session-id {SID_A}", screen=AWAITING_SCREEN)},
                  "pergunta aberta na tela: 409, nada muda"),
    session_route("reopen_mode_unknown_session", "b-reopen-claude", "nada", "modo-execucao", {"terminal": False}, {}),
    session_route("reopen_mode_pi_refused", "b-reopen-claude", "p1", "modo-execucao", {"terminal": False},
                  {"tmux_sessions": [{"name": "p1", "cwd": PROJ, "command": f"exec pi --session-id {SID_A}",
                                      "env": {"CP_PROVIDER": "pi"}}]}),
    session_route("reopen_reload_terminal", "b-reopen-claude", "s1", "recarregar", None, TERMINAL_A,
                  "recarregar com terminal: fecha e reabre o pane na mesma conversa"),
    session_route("reopen_reload_headless", "b-reopen-claude", "s1", "recarregar", None, HEADLESS_A,
                  "recarregar sem terminal: pedido ao runtime"),
    session_route("reopen_reload_pi_refused", "b-reopen-claude", "p1", "recarregar", None,
                  {"tmux_sessions": [{"name": "p1", "cwd": PROJ, "command": f"exec pi --session-id {SID_A}",
                                      "env": {"CP_PROVIDER": "pi"}}]}),
    session_route("reopen_account_terminal_to_b", "b-reopen-claude", "s1", "conta", {"config_dir": B}, TERMINAL_A,
                  "troca de conta com terminal: transcript vai para a conta b e o pane reabre nela"),
    session_route("reopen_account_headless_to_b", "b-reopen-claude", "s1", "conta", {"config_dir": B}, HEADLESS_A),
    session_route("reopen_account_same_noop", "b-reopen-claude", "s1", "conta", {"config_dir": f"{H}/.claude"},
                  TERMINAL_A),
    session_route("reopen_account_full_refused", "b-reopen-claude", "s1", "conta", {"config_dir": B}, TERMINAL_A,
                  "conta de destino a 99,5%: 409 erro_conta_cheia", fakes=QUOTA_B_FULL),
    session_route("reopen_account_unknown_dir", "b-reopen-claude", "s1", "conta", {"config_dir": f"{H}/.claude-x"},
                  TERMINAL_A),
    session_route("reopen_bypass_terminal", "b-reopen-claude", "s1", "permission-mode", {"mode": "bypassPermissions"},
                  TERMINAL_A, "terminal sem a flag de bypass: reabre o pane em bypass"),
    session_route("reopen_bypass_headless", "b-reopen-claude", "s1", "permission-mode", {"mode": "bypassPermissions"},
                  HEADLESS_A, "sem terminal que não responde: reabre em bypass"),
    session_route("reopen_permission_invalid", "b-reopen-claude", "s1", "permission-mode", {"mode": "yolo"}, TERMINAL_A),
]

# ── Codex pelo adapter Python (grupo c) ─────────────────────────────────────────────────────

CODEX_TERMINAL = {"files": codex_sidecar("cx", headless=False, codex_account="default"),
                  "tmux_sessions": [{"name": "cx", "cwd": PROJ, "env": {"CP_PROVIDER": "codex", "CP_SESSION_NAME": "cx"},
                                     "command": f"exec env -u CLAUDE_CONFIG_DIR hangar-codex-tui --cwd {PROJ} "
                                                f"--codex-home {H}/.codex --codex-account default"}]}
CODEX_HEADLESS = {"files": codex_sidecar("cx", codex_account="default")}

SCENARIOS += [
    session_route("codex_mode_terminal_to_headless", "c-codex", "cx", "modo-execucao", {"terminal": False},
                  CODEX_TERMINAL),
    session_route("codex_mode_headless_to_terminal", "c-codex", "cx", "modo-execucao", {"terminal": True},
                  CODEX_HEADLESS),
    session_route("codex_mode_same_noop", "c-codex", "cx", "modo-execucao", {"terminal": False}, CODEX_HEADLESS),
    session_route("codex_restart_headless", "c-codex", "cx", "recarregar", None, CODEX_HEADLESS),
    session_route("codex_restart_terminal", "c-codex", "cx", "recarregar", None, CODEX_TERMINAL),
]

# ── Retomar, Arquivo e bastão (grupo d) ─────────────────────────────────────────────────────

BARE = {"files": TRANSCRIPT_A, **terminal_session("bare", "exec env -u CLAUDE_CONFIG_DIR claude")}
ARCHIVE = {"files": TRANSCRIPT_A}

SCENARIOS += [
    session_route("resume_bare_with_session_id", "d-resume", "bare", "resume", {"session_id": SID_A}, BARE,
                  "sessão sem id relançada com --resume"),
    session_route("resume_bare_single_candidate", "d-resume", "bare", "resume", {}, BARE),
    session_route("resume_unknown_session", "d-resume", "nada", "resume", {"session_id": SID_A}, {}),
    session_route("resume_invalid_session_id", "d-resume", "bare", "resume", {"session_id": "nao-e-uuid"}, BARE),
    scenario("archive_resume_claude", "d-resume",
             [{"method": "POST", "path": f"/api/archive/{SANITIZED_PROJ}/{SID_A}/resume", "json": {}}],
             state=ARCHIVE, about="retomar do Arquivo: sessão nova com claude --resume no cwd original"),
    scenario("archive_resume_named_with_model", "d-resume",
             [{"method": "POST", "path": f"/api/archive/{SANITIZED_PROJ}/{SID_A}/resume",
               "json": {"name": "volta", "model": "opus"}}], state=ARCHIVE),
    scenario("archive_resume_name_collision", "d-resume",
             [{"method": "POST", "path": f"/api/archive/{SANITIZED_PROJ}/{SID_A}/resume", "json": {}}],
             state={**ARCHIVE, **terminal_session("proj", f"exec claude --session-id {SID_B}")},
             about="nome derivado do cwd já em uso: sufixo -2"),
    scenario("archive_resume_conversation_open", "d-resume",
             [{"method": "POST", "path": f"/api/archive/{SANITIZED_PROJ}/{SID_A}/resume", "json": {}}],
             state={**ARCHIVE, **terminal_session("aberta", f"exec claude --session-id {SID_A}")},
             about="a conversa já roda noutra sessão: 409 erro_conversa_viva"),
    scenario("archive_resume_invalid_config_dir", "d-resume",
             [{"method": "POST", "path": f"/api/archive/{SANITIZED_PROJ}/{SID_A}/resume",
               "json": {"config_dir": f"{H}/.claude-x"}}], state=ARCHIVE),
    scenario("archive_resume_codex_bad_id", "d-resume",
             [{"method": "POST", "path": "/api/archive/x/rollout-sem-id/resume", "json": {"provider": "codex"}}],
             state=ARCHIVE),
    scenario("archive_resume_missing_transcript", "d-resume",
             [{"method": "POST", "path": f"/api/archive/{SANITIZED_PROJ}/{SID_B}/resume", "json": {}}],
             state=ARCHIVE),
    session_route("bastao_claude_terminal", "d-resume", "s1", "bastao", {"name": "s2", "headless": False}, TERMINAL_A,
                  "passa o bastão: dossiê, sessão nova e kick-off na fila"),
    session_route("bastao_unknown_session", "d-resume", "nada", "bastao", {"name": "s2"}, {}),
]
