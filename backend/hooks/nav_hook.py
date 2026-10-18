#!/usr/bin/env python3
# UserPromptSubmit: diz ao Claude se esta sessão tem (ou pode ter) navegador embutido. Skill só
# dispara quando o pedido casa com a descrição, e "testa o login" não cita preview — sem este
# aviso a sessão vai de agent-browser sem saber que há um navegador dela na tela do usuário.
# Electron no ar = pid do ~/.hangar/nav/_srv.json vivo (o arquivo sobrevive a crash, só o pid
# decide, mesmo teste do CLI). Sem Electron, sem saída. Falha sem travar o prompt, com uma linha no log do Hangar.
import json
import os
import re
import subprocess
import sys
import time
import unicodedata


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
    # Com o Jev na sessão, várias ações numa tela desconhecida vão numa chamada só.
    jev = (" Várias ações numa tela que você não conhece: `browser_goal` (= `hangar-preview objetivo`)."
           if os.environ.get("HANGAR_JEV") == "on" else "")
    if url:
        return (f"[hangar] Esta sessão tem o navegador embutido do Hangar aberto em {url}. Pra ver, "
                "ler, clicar, testar ou tirar print dessa página, use as tools `browser`/`browser_batch` "
                f"do MCP hangar (sem elas: `hangar-preview` no shell; skill hangar-preview), não "
                f"agent-browser nem ver-front.{jev}")
    return ("[hangar] Pra ver, testar ou tirar print de uma página, use o navegador embutido do Hangar: "
            "tools `browser_open`/`browser`/`browser_batch` do MCP hangar (sem elas: `hangar-preview "
            f"open <url>` no shell; skill hangar-preview). Não use agent-browser nem ver-front.{jev}")


# A regex decide se a mensagem tem cara de tarefa de tela; o Jev só barra falso positivo. Palavra que aparece
# em qualquer conversa de código (testa, ui, url, login, interface) fica de fora: sozinha, ela
# mandava a dica em "roda os testes" e "a interface do adapter".
_TELA = re.compile(
    r"\b(pagina|paginas|tela|telas|navegador|browser|prints?|screenshot|captura de tela|clica|clicar|"
    r"clique|botao|botoes|layout|css|front|frontend|localhost|site|formulario|modal|preview|"
    r"teste visual)\b|\btestar? (o |a )?(login|cadastro|fluxo)\b|https?://")
# Notificação de subagente chega como prompt, mas ninguém a escreveu pedindo tela.
_NAO_E_PEDIDO = ("<task-notification", "[SYSTEM NOTIFICATION")
JEV_URL = "https://api.typesafe.ai/v1/systemone"
JEV_TIMEOUT_S = 2.0
JEV_LIMIAR = 0.5
# Depois de uma falha o Jev descansa: chave errada ou endereço fora fariam cada prompt pagar o teto de espera.
JEV_PAUSA_S = 300
LOG_MAX = 256 * 1024


def _registrar(motivo: str) -> None:
    """Falha aberta (vale a regex), mas não calada: uma linha no log do Hangar. Se nem logar der, engole."""
    try:
        root = (os.path.join(os.environ.get("LOCALAPPDATA") or os.path.expanduser("~/AppData/Local"), "hangar")
                if os.name == "nt" else os.path.expanduser("~/.hangar"))
        base = os.path.join(root, "logs", "privado")
        os.makedirs(base, exist_ok=True, mode=0o700)
        arquivo = os.path.join(base, "nav_hook-falhas.log")
        # Falha repetida a cada prompt não pode encher o disco: passou do teto, recomeça.
        if os.path.exists(arquivo) and os.path.getsize(arquivo) > LOG_MAX:
            os.replace(arquivo, arquivo + ".1")
        fd = os.open(arquivo, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
        with os.fdopen(fd, "a", encoding="utf-8") as fh:
            fh.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')} {motivo[:300]}\n")
    except Exception:
        pass


def _pausa_jev() -> str:
    return os.path.join(_nav_dir(), "_jev_pausa")


def _sem_acento(s: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFD", s.lower()) if unicodedata.category(c) != "Mn")


def _jev_precisa(prompt: str) -> bool | None:
    """True/False pelo Jev; None quando não há chave ou ele não responde — aí vale o que a regex achou."""
    key = os.environ.get("TYPESAFE_API_KEY")
    if not key:
        return None
    try:
        if time.time() - os.path.getmtime(_pausa_jev()) < JEV_PAUSA_S:
            return None
    except OSError:
        pass
    import urllib.request   # ~60 ms de import: só paga quem vai chamar o Jev
    pergunta = {"precisa": {"type": "noul", "instructions": (
        "Will handling this message require opening, looking at, clicking or testing a web page or "
        "an app screen in a browser?")}}
    # Endereço e modelo chegam resolvidos pelo backend (`runtime_config.jev_destino_env`).
    endpoint, modelo = os.environ.get("JEV_ENDPOINT") or "", os.environ.get("JEV_MODEL") or ""
    req = urllib.request.Request(
        endpoint or JEV_URL,
        data=json.dumps({"model": modelo or "jev-latest",
                         "state": prompt[-4000:], "questions": pergunta}).encode(),
        headers={"authorization": f"Bearer {key}", "content-type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=JEV_TIMEOUT_S) as r:
            return float(json.load(r)["answers"]["precisa"]["noul"]) >= JEV_LIMIAR
    except Exception as e:
        _registrar(f"jev falhou ({type(e).__name__}: {e}); regex por {JEV_PAUSA_S}s")
        try:
            os.makedirs(_nav_dir(), exist_ok=True)
            with open(_pausa_jev(), "w"):
                pass
        except OSError as e2:
            _registrar(f"pausa do jev nao gravada ({e2}); cada prompt vai tentar de novo")
        return None


def precisa_de_navegador(prompt: str) -> bool:
    if not prompt.strip() or any(m in prompt.lstrip()[:400] for m in _NAO_E_PEDIDO):
        return False
    # O Jev custa ~0,5 s de rede: só confirma o que a regex achou, e resposta curta ("A", "sim") nem isso.
    if not _TELA.search(_sem_acento(prompt)):
        return False
    pelo_jev = _jev_precisa(prompt) if len(prompt.split()) >= 4 else None
    return pelo_jev is not False


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
    prompt = _prompt()
    if any(m in prompt.lstrip()[:400] for m in _NAO_E_PEDIDO):
        return
    nome = _nome_da_sessao()
    url = _url_do_navegador(nav_dir, nome) if nome else None
    # Navegador aberto: sempre diz qual página. Fechado: a dica só vai quando a mensagem é de tela;
    # em toda mensagem ela custava contexto a quem nunca abre página (o árbitro de uma orquestração).
    if url is None and not precisa_de_navegador(prompt):
        return
    print(json.dumps({"hookSpecificOutput": {"hookEventName": "UserPromptSubmit",
                                             "additionalContext": texto(url)}}))


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        _registrar(f"main falhou ({type(e).__name__}: {e})")
    sys.exit(0)
