#!/usr/bin/env python3
# UserPromptSubmit: diz ao Claude se esta sessão tem (ou pode ter) navegador embutido. Skill só
# dispara quando o pedido casa com a descrição, e "testa o login" não cita preview — sem este
# aviso a sessão vai de agent-browser sem saber que há um navegador dela na tela do usuário.
# Electron no ar = pid do ~/.hangar/nav/_srv.json vivo (o arquivo sobrevive a crash, só o pid
# decide, mesmo teste do CLI). Sem Electron, sem saída. Falha em silêncio.
import json
import os
import re
import subprocess
import sys
import unicodedata
import urllib.request


def _nav_dir() -> str:
    return os.path.join(os.path.expanduser("~"), ".hangar", "nav")


def _pid_vivo(pid: object) -> bool:
    if not isinstance(pid, int) or pid <= 0:
        return False
    # No Windows `os.kill(pid, 0)` NÃO é sondagem: é TerminateProcess com código 0 — o hook
    # mataria o app a cada prompt. Lá a pergunta é feita ao kernel32.
    if os.name == "nt":
        import ctypes
        k32 = ctypes.windll.kernel32
        h = k32.OpenProcess(0x1000, False, pid)   # PROCESS_QUERY_LIMITED_INFORMATION
        if not h:
            return False
        try:
            codigo = ctypes.c_ulong()
            return bool(k32.GetExitCodeProcess(h, ctypes.byref(codigo))) and codigo.value == 259  # STILL_ACTIVE
        finally:
            k32.CloseHandle(h)
    try:
        os.kill(pid, 0)
        return True
    except PermissionError:
        return True
    except OSError:
        return False


def _nome_headless() -> str | None:
    # Sessão SEM terminal: a chave do sidecar (env do processo) não muda no rename nem no /clear.
    chave = os.environ.get("CP_SESSION_KEY")
    if not chave:
        return None
    pasta = os.path.join(os.path.expanduser("~"), ".hangar", "claude-headless")
    try:
        arquivos = os.listdir(pasta)
    except OSError:
        return None
    for arq in arquivos:
        if not arq.endswith(".json"):
            continue
        try:
            with open(os.path.join(pasta, arq), encoding="utf-8") as f:
                meta = json.load(f)
        except (OSError, ValueError):
            continue   # sidecar alheio em escrita ou corrompido não pode esconder o certo
        if isinstance(meta, dict) and meta.get("key") == chave and meta.get("name"):
            return meta["name"]
    return None


def _nome_da_sessao() -> str | None:
    nome = _nome_headless()
    if nome:
        return nome
    pane = os.environ.get("TMUX_PANE")
    if not pane:
        return None
    try:
        saida = subprocess.run(["tmux", "list-panes", "-a", "-F", "#{pane_id}\t#{session_name}"],
                               capture_output=True, text=True, timeout=1).stdout
    except Exception:
        return None
    achados = [l.split("\t", 1)[1] for l in saida.splitlines()
               if "\t" in l and l.split("\t", 1)[0] == pane]
    return achados[0] if len(achados) == 1 else None


def _url_do_navegador(nav_dir: str, nome: str) -> str | None:
    for arq in os.listdir(nav_dir):
        if not arq.endswith(".json") or arq.startswith(("_", ".")):
            continue
        try:
            with open(os.path.join(nav_dir, arq), encoding="utf-8") as fh:
                d = json.load(fh)
        except Exception:
            continue
        chave = d.get("chave") if isinstance(d, dict) else None
        if chave == nome or (isinstance(chave, str) and chave.endswith(f"::{nome}")):
            return str(d.get("url") or "")
    return None


def texto(url: str | None) -> str:
    if url:
        return (f"[hangar] Esta sessão tem o navegador embutido do Hangar aberto em {url}. Pra ver, "
                "ler, clicar, testar ou tirar print dessa página, use as tools `browser`/`browser_batch` "
                "do MCP hangar (sem elas: `hangar-preview` no shell), não agent-browser nem ver-front.")
    return ("[hangar] Pra ver, testar ou tirar print de uma página, use o navegador embutido do Hangar: "
            "tools `browser_open`/`browser`/`browser_batch` do MCP hangar (sem elas: `hangar-preview "
            "open <url>` no shell, skill hangar-preview). Não use agent-browser nem ver-front. Abrir "
            "muda a janela do usuário: avise-o.")


# Sem Jev, é a regex que decide se a mensagem tem cara de tarefa de tela.
_TELA = re.compile(
    r"\b(pagina|paginas|tela|telas|navegador|browser|print|prints|screenshot|captura|clica|clicar|"
    r"clique|botao|botoes|layout|css|front|frontend|ui|interface|localhost|url|site|login|"
    r"formulario|modal|preview|testa|testar|teste visual)\b|https?://")
JEV_URL = "https://api.typesafe.ai/v1/systemone"
JEV_TIMEOUT_S = 2.0
JEV_LIMIAR = 0.5


def _sem_acento(s: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFD", s.lower()) if unicodedata.category(c) != "Mn")


def _jev_precisa(prompt: str) -> bool | None:
    """True/False pelo Jev; None quando não há chave ou ele não responde — aí vale a regex."""
    key = os.environ.get("TYPESAFE_API_KEY")
    if not key:
        return None
    pergunta = {"precisa": {"type": "noul", "instructions": (
        "Will handling this message require opening, looking at, clicking or testing a web page or "
        "an app screen in a browser?")}}
    req = urllib.request.Request(
        os.environ.get("JEV_ENDPOINT") or JEV_URL,
        data=json.dumps({"model": os.environ.get("JEV_MODEL") or "jev-latest",
                         "state": prompt[-4000:], "questions": pergunta}).encode(),
        headers={"authorization": f"Bearer {key}", "content-type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=JEV_TIMEOUT_S) as r:
            return float(json.load(r)["answers"]["precisa"]["noul"]) >= JEV_LIMIAR
    except Exception:
        return None


def precisa_de_navegador(prompt: str) -> bool:
    if not prompt.strip():
        return False
    pelo_jev = _jev_precisa(prompt)
    return pelo_jev if pelo_jev is not None else bool(_TELA.search(_sem_acento(prompt)))


def _prompt() -> str:
    try:
        d = json.load(sys.stdin)
    except Exception:
        return ""
    p = d.get("prompt") if isinstance(d, dict) else None
    return p if isinstance(p, str) else ""


def main() -> None:
    nav_dir = _nav_dir()
    try:
        with open(os.path.join(nav_dir, "_srv.json"), encoding="utf-8") as fh:
            srv = json.load(fh)
    except Exception:
        return   # sem arquivo = sem Electron, o caso normal de quem usa só o celular
    if not isinstance(srv, dict) or not _pid_vivo(srv.get("pid")):
        return
    nome = _nome_da_sessao()
    url = _url_do_navegador(nav_dir, nome) if nome else None
    # Navegador aberto: sempre diz qual página. Fechado: a dica só vai quando a mensagem é de tela;
    # em toda mensagem ela custava contexto a quem nunca abre página (o árbitro de uma orquestração).
    if url is None and not precisa_de_navegador(_prompt()):
        return
    print(json.dumps({"hookSpecificOutput": {"hookEventName": "UserPromptSubmit",
                                             "additionalContext": texto(url)}}))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass
    sys.exit(0)
