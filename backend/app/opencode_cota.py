"""Cookie do painel do OpenCode Go, que a leitura da cota (no Rust, `accounts/quotas/other.rs`) usa.

O OpenCode NÃO tem rota de cota. Verificado em 18/08/2026: `/v1/usage`, `/v1/usages`, `/v1/me`,
`/v1/balance` e `/v1/account` respondem 404 com a chave de API válida; a documentação do plano Go
manda acompanhar o uso "no console"; e existe um pedido ABERTO pra criar `GET /zen/v1/balance`
(anomalyco/opencode#10448) sem ninguém trabalhando nele.

O que dá pra fazer é o que o pacote `pi-quotas` (latentminds-ai) faz: baixar a PÁGINA do painel com
o cookie de sessão do navegador e pescar os números que o site deixa embutidos no HTML. As três
janelas do plano Go ($12/5h, $30/semana, $60/mês) saem daí, como percentual e segundos até o reset.

Duas fragilidades que são da abordagem, não do código, e por isso o resultado é sempre "não informa
cota" em vez de erro barulhento:
  1. Não é uma API. É o HTML de um site em SolidJS; o dia que renomearem uma variável interna, o
     número some.
  2. O cookie é sessão de navegador, expira, e é credencial mais poderosa que a chave de API —
     por isso o arquivo é 0600 e o valor nunca volta inteiro pra tela.
"""
import json
import os
import threading
from pathlib import Path

from app import atomico, contas, migracao_sidecars

_ARQUIVO = ".hangar-opencode.json"
_lock = threading.Lock()


def _caminho() -> Path:
    return contas.compartilhado() / _ARQUIVO


def ler_configs() -> dict[str, dict[str, str]]:
    """{id_da_credencial: {workspace_id, auth_cookie}}. Ilegível ou tipo errado = vazio."""
    try:
        bruto = json.loads(migracao_sidecars.caminho_de_leitura(_caminho()).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    if not isinstance(bruto, dict):
        return {}
    out = {}
    for k, v in bruto.items():
        if not isinstance(k, str) or not isinstance(v, dict):
            continue
        w, c = v.get("workspace_id"), v.get("auth_cookie")
        if isinstance(w, str) and w and isinstance(c, str) and c:
            out[k] = {"workspace_id": w, "auth_cookie": c}
    return out


def definir_config(id_credencial: str, workspace_id: str, auth_cookie: str) -> None:
    """Grava (ou apaga, com os dois vazios). Arquivo 0600: o cookie abre a conta inteira no site."""
    w, c = workspace_id.strip(), auth_cookie.strip()
    with _lock:
        atual = ler_configs()
        if w and c:
            atual[id_credencial] = {"workspace_id": w, "auth_cookie": c}
        else:
            atual.pop(id_credencial, None)
        alvo = _caminho()
        tmp = alvo.with_suffix(f".tmp{os.getpid()}")
        try:
            alvo.parent.mkdir(parents=True, exist_ok=True)
            # 0600 na CRIAÇÃO, não depois: entre o write e o chmod o arquivo com o cookie de
            # sessão ficaria legível por qualquer usuário local. O cookie abre a conta inteira no
            # site do provedor — é a credencial mais poderosa que este app guarda.
            fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                fh.write(json.dumps(atual, ensure_ascii=False, indent=1))
            os.chmod(tmp, 0o600)
            atomico.substituir(tmp, alvo)
        except OSError:
            tmp.unlink(missing_ok=True)
            raise
