"""Servidor MCP do Hangar: as operações do `hangar-send` como tools, montadas no backend em /mcp.

Quem chama se identifica pelos cabeçalhos X-Hangar-* (app.quem_chama); o token é o mesmo bearer
do backend, conferido ANTES do sub-app porque `app.mount()` passa por fora do `Depends`.
Cada tool chama a mesma função de rota que o CLI chama por HTTP. A exceção é `html_render`: a
página aparece no lugar da chamada da tool, e o CLI não tem esse lugar.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import re
import os
import secrets
import shutil
import time
from pathlib import Path
from typing import Any, Literal

from fastapi import HTTPException
from mcp.server import MCPServer
from mcp.server.mcpserver import Context, Image
from mcp.server.mcpserver.exceptions import ToolError
from mcp_types import CallToolResult, TextContent
from mcp.server.transport_security import TransportSecuritySettings

from app import auth as auth_mod
from app import navshell, peers, quem_chama, share_bridge
from app.config import settings

_INSTRUCTIONS = (
    "Hangar: sessões vizinhas e o navegador embutido desta sessão. "
    "Mostrar algo que você montou ao usuário (desenho, mock de tela, comparação, gráfico, tabela, diagrama): "
    "html_render, sem esperar pedido; imagem por caminho só para print real de tela. "
    "Ver ou testar uma página: browser_open e depois browser (um verbo) ou browser_batch (vários já conhecidos); "
    "tela desconhecida com várias ações: browser_goal, quando a sessão tem o Jev. "
    "Falar com outra sessão: sessions, send, group, pair; abrir ou fechar: new_session, close_session.")

mcp = MCPServer("hangar", instructions=_INSTRUCTIONS)

# Nomes antigos das tools (português) → nome de hoje. Uma sessão já aberta carregou o catálogo na
# abertura e vai chamar pelo nome que conhece até ser reiniciada — e sessão de trabalho não fecha
# porque o servidor renomeou uma tool. Aqui o nome velho continua CHAMÁVEL sem aparecer no
# catálogo: quem abre agora vê só os nomes novos, e quem está no meio de uma tarefa não quebra.
#
# Some quando não houver mais sessão viva de antes do rename — é ponte, não API.
_NOMES_ANTIGOS = {
    "quem_sou": "who_am_i",
    "sessoes": "sessions",
    "enviar": "send",
    "grupo": "group",
    "parear": "pair",
    "desparear": "unpair",
    "nova_sessao": "new_session",
    "nav_abrir": "browser_open",
    "nav": "browser",
    "nav_lote": "browser_batch",
}

_chamar_tool = mcp.call_tool


async def _call_tool_com_nome_antigo(name, arguments, context=None, **kw):
    # Tradução ANTES do despacho: o handler do protocolo chama `self.call_tool(params.name, ...)`,
    # então é aqui que o nome velho vira o novo sem duplicar nada no catálogo.
    return await _chamar_tool(_NOMES_ANTIGOS.get(name, name), arguments, context, **kw)


mcp.call_tool = _call_tool_com_nome_antigo


def _cabecalhos(ctx: Context) -> dict[str, str]:
    req = getattr(ctx.request_context, "request", None)
    return dict(req.headers) if req is not None else {}


VOICE_CLOSE_REFUSED = ("recusado: a voz fecha sessão pela própria ferramenta close_session, que pede o sim "
                       "falado do usuário")
VOICE_NEEDS_SESSION = ("a assistente de voz não é uma sessão: passe `sessao` com o nome da sessão em nome de "
                       "quem agir (tool `sessions`)")
_SESSAO_DESC = (" `sessao`: só para a assistente de voz, que não é sessão: a sessão em nome de quem agir; "
                "quem é sessão age sempre como ela mesma.")


async def _caller(ctx: Context) -> tuple[str, bool]:
    """`(nome, é a voz)`; nada resolvido é erro, nunca um chamador padrão."""
    try:
        nome, origem = await asyncio.to_thread(quem_chama.resolver, _cabecalhos(ctx))
    except quem_chama.SessaoDesconhecida as e:
        raise ToolError(f"sessao_desconhecida: {e}") from e
    return nome, origem == quem_chama.VOICE


async def _eu(ctx: Context, sessao: str = "") -> str:
    """A sessão em nome de quem a tool age. A voz não tem grupo, navegador nem conversa: diz qual sessão."""
    nome, voice = await _caller(ctx)
    if not voice:
        return nome
    if not sessao.strip():
        raise ToolError(VOICE_NEEDS_SESSION)
    return sessao.strip()


def _detalhe(e: HTTPException) -> str:
    d = e.detail
    return d.get("msg", str(d)) if isinstance(d, dict) else str(d)


@mcp.tool(description="Quem é esta sessão no Hangar (nome e por qual cabeçalho foi resolvida). "
                      "Diagnóstico; equivale a `hangar-send` descobrindo a própria sessão.")
async def who_am_i(ctx: Context) -> dict[str, str]:
    try:
        nome, origem = await asyncio.to_thread(quem_chama.resolver, _cabecalhos(ctx))
    except quem_chama.SessaoDesconhecida as e:
        raise ToolError(f"sessao_desconhecida: {e}") from e
    if origem == quem_chama.VOICE:
        return {"name": nome, "origem": origem, "kind": "voice", "label": "assistente de voz do Hangar"}
    return {"name": nome, "origem": origem}


@mcp.tool(description="Lista as sessões vivas nesta máquina (nome, estado, cwd, provider). "
                      "`voce: true` marca esta sessão; mesmo `grupo` = mesmo grupo de trabalho. "
                      "Equivale a `hangar-send --list` sem os servidores remotos.")
async def sessions(ctx: Context) -> list[dict[str, Any]]:
    from app import api
    try:
        nome, voice = await _caller(ctx)
        eu = None if voice else nome
    except ToolError:
        eu = None
    infos = await api.list_sessions(ctx.request_context.request)
    return [{"name": s.name, "state": s.state, "cwd": s.cwd,
             "provider": s.provider, "headless": s.headless, "voce": s.name == eu,
             "grupo": s.pair_gid} for s in infos]


@mcp.tool(description="Manda um recado 1:1 pra outra sessão, como `hangar-send <sessao> <msg>`: "
                      "chega lá como `[de: <você>] texto`. `alvo` aceita `servidor::sessao` "
                      "pra outro servidor. O backend escolhe o transporte (socket nativo, plugin, "
                      "tmux ou fila) e diz se entregou. O texto vira prompt pago lá: só a informação "
                      "ou o pedido, sem saudação nem apresentação (o cabeçalho já diz quem manda).")
async def send(ctx: Context, alvo: str, texto: str, tmux: bool = False) -> dict[str, Any]:
    from app import api
    eu, voice = await _caller(ctx)
    # A voz não é sessão: recado dela para uma sessão chamada "voz" não volta para ela mesma.
    if not voice and (alvo == eu or (settings.server_id and alvo == f"{settings.server_id}::{eu}")):
        raise ToolError(f"recusado: '{alvo}' é esta sessão — o recado voltaria pra você. "
                        "Quem é quem: tool `sessions` (campo `voce`).")
    # Modelo que escreve "[de: eu] …" por conta própria não ganha o prefixo em dobro — com ou sem o
    # "<servidor>::" na frente, que é como o envio pra outro servidor qualifica o remetente.
    servidor = rf"(?:{re.escape(settings.server_id)}::)?" if settings.server_id else ""
    texto = re.sub(rf"^\s*\[de:\s*{servidor}{re.escape(eu)}\]\s*", "", texto)
    if peers.is_remote(alvo):
        # Par externo é do Rust; "não é par desta sessão" (ou Rust fora) segue como máquina própria.
        try:
            resp = await asyncio.to_thread(share_bridge.call, "send", sender=eu, target=alvo, text=texto)
        except share_bridge.ShareBridgeError as e:
            if e.code not in ("erro_par_inexistente", "share_bridge_off"):
                raise ToolError(f"'{alvo}': {e.detail or e.code}") from e
        else:
            return {"alvo": alvo, **resp}
        srv, sess = peers.split_addr(alvo)
        if not settings.server_id:
            raise ToolError("CP_SERVER_ID ausente no backend/.env — obrigatório pra envio cross-server")
        corpo = {"text": f"[de: {settings.server_id}::{eu}] {texto}", "steer": True}
        try:
            _, resp = await asyncio.to_thread(peers.call, srv, "POST", f"/api/sessions/{sess}/input", corpo)
        except peers.PeerError as e:
            raise ToolError(str(e)) from e
        return {"alvo": alvo, **(resp or {})}
    # `tmux` fica aceito por compatibilidade: o backend já escolhe o transporte (socket nativo,
    # plugin, tmux, fila) e nunca devolve o envio pro modelo fazer por outra ferramenta.
    try:
        resp = await api.input_prompt(alvo, api.InputBody(text=f"[de: {eu}] {texto}", steer=True))
    except HTTPException as e:
        raise ToolError(_detalhe(e)) from e
    return {"alvo": alvo, **resp}


@mcp.tool(description="Aviso pro grupo de pareamento desta sessão, como `hangar-send --group <msg>`: "
                      "chega como `[grupo: <você>]` nos demais. Marco, não conversa: NUNCA responda um "
                      "`[grupo: …]` com isto. O backend escolhe o transporte pra cada membro. Uma "
                      "frase direta, sem saudação: cada membro paga o texto como prompt." + _SESSAO_DESC)
async def group(ctx: Context, texto: str, tmux: bool = False, sessao: str = "") -> dict[str, Any]:
    from app import api
    eu = await _eu(ctx, sessao)
    try:
        return await api.group_message(eu, api.GroupMsgBody(text=texto, forcar_tmux=tmux))
    except HTTPException as e:
        raise ToolError(_detalhe(e)) from e


@mcp.tool(description="Pareia esta sessão com outra pra uma tarefa, como `hangar-send --pair <sessao> "
                      "<tarefa>`: registra no app e injeta o protocolo nos dois lados. `alvo` aceita "
                      "`servidor::sessao`. `tarefa` é o título do grupo na lista: chave + assunto "
                      "numa linha (ex: `ABC-1234 Tela de login`); o combinado vai por `send`. "
                      "Só quando o usuário pedir pareamento. `orq`: grupo de orquestração (skill "
                      "orquestrar), como `--pair --orq`; com `alvo` vazio o grupo tem só esta sessão."
                      + _SESSAO_DESC)
async def pair(ctx: Context, alvo: str = "", tarefa: str = "", substituir_tarefa: bool = False,
               orq: bool = False, sessao: str = "") -> dict[str, Any]:
    from app import api
    eu = await _eu(ctx, sessao)
    try:
        return await api.pair_session(eu, api.PairBody(peer=alvo, task=tarefa, replace_task=substituir_tarefa,
                                                       orq=orq))
    except HTTPException as e:
        raise ToolError(_detalhe(e)) from e


@mcp.tool(description="Desfaz o pareamento desta sessão (`hangar-send --unpair`)." + _SESSAO_DESC)
async def unpair(ctx: Context, sessao: str = "") -> dict[str, Any]:
    from app import api
    eu = await _eu(ctx, sessao)
    try:
        return await api.unpair_session(eu)
    except HTTPException as e:
        raise ToolError(_detalhe(e)) from e


@mcp.tool(description="Cria outra sessão nesta máquina, como `hangar-send --new <nome> <cwd>`. Nunca "
                      "`tmux new-session` cru. `provider`: claude|codex|pi|omp|kimi. O que for "
                      "omitido HERDA de quem chama: a conta (claude/pi/omp), o modo de permissão "
                      "(claude; `plan` herda o modo de base) e o sem terminal (`headless`, só "
                      "claude/codex). Parâmetro explícito vence: `headless: false` força terminal, "
                      "`conta` (caminho do config dir) força outra conta. Conta herdada com 95% ou "
                      "mais de uso nasce na conta de mais folga (como `--conta auto`); a resposta "
                      "devolve `config_dir` e `account_source` (`inherited` ou `quota`) — confira. "
                      "Pra conta que ainda precisa ser preparada, use o CLI "
                      "(`hangar-send --new --conta <nome>`). `jev`: a sessão nasce com a chave do "
                      "Jev no ambiente, e só aí o `hangar-preview objetivo` (o laço que navega e "
                      "preenche tela sozinho) funciona nela. Omitido, vale o padrão do servidor. "
                      "`service_tier`: `priority` liga o Fast, `default` desliga; só Codex ou "
                      "Claude com motor GPT no CLIProxyAPI local. Worktree: `branch` com "
                      "`new_branch: true` e `base` cria uma branch nova numa cópia separada de `cwd`; "
                      "`branch` sem `new_branch` usa uma branch que já existe. `codex_account`: id "
                      "da conta Codex cadastrada. `subagent_model`: modelo dos subagentes (claude "
                      "sem motor).")
async def new_session(ctx: Context, nome: str, cwd: str, provider: str | None = None, engine: str | None = None,
                      model: str | None = None, effort: str | None = None, permissao: str | None = None,
                      headless: bool | None = None, read_only: bool = False,
                      conta: str | None = None, jev: bool | None = None,
                      service_tier: Literal["default", "priority"] | None = None,
                      branch: str | None = None, new_branch: bool = False, base: str | None = None,
                      codex_account: str | None = None, subagent_model: str | None = None) -> dict[str, Any]:
    from app import api
    eu, voice = await _caller(ctx)
    if provider is None:
        provider = await api._default_session_provider(conta, engine)
    if headless and provider not in ("claude", "codex"):
        raise ToolError(f"headless só vale com provider claude ou codex (veio: {provider})")
    # Conta, modo e sem terminal omitidos herdam de `eu` dentro do create_session, que é o mesmo
    # caminho do `hangar-send --new`.
    try:
        info = await api.create_session(api.CreateBody(
            name=nome, cwd=cwd, provider=provider, engine=engine, model=model, effort=effort,
            permission_mode=permissao, headless=headless, read_only=read_only,
            config_dir=conta, jev=jev, service_tier=service_tier, branch=branch or None, new_branch=new_branch,
            # A voz não tem conta nem modo para herdar: o omitido fica com o padrão do servidor.
            base=base or None, codex_account=codex_account, subagent_model=subagent_model, creator=None if voice else eu))
    except HTTPException as e:
        raise ToolError(_detalhe(e)) from e
    return {"name": info.name, "cwd": info.cwd, "provider": info.provider, "headless": info.headless,
            # Volta na resposta pra que herdar errado nunca mais passe despercebido.
            "config_dir": info.config_dir, "account_source": info.account_source,
            **({"avisos": info.avisos} if info.avisos else {})}


@mcp.tool(description="Fecha OUTRA sessão desta máquina, com ou sem terminal, como `hangar-send "
                      "--close <sessao>`: ela sai do grupo sem aviso. Nunca a própria. Use para a "
                      "sessão que você abriu e que já terminou o trabalho.")
async def close_session(ctx: Context, alvo: str) -> dict[str, Any]:
    from app import api
    eu, voice = await _caller(ctx)
    if voice:
        raise ToolError(VOICE_CLOSE_REFUSED)
    if peers.is_remote(alvo):
        raise ToolError("close_session só fecha sessão desta máquina")
    if alvo == eu:
        raise ToolError(f"recusado: '{alvo}' é esta sessão — peça pra outra fechar")
    # O DELETE responde ok pra nome que não existe: nome errado não pode virar "fechada".
    if not await asyncio.to_thread(quem_chama._por_nome, alvo):
        raise ToolError(f"sessão '{alvo}' não existe (tool `sessions`)")
    try:
        # A rota DELETE recusa sessão no meio de uma troca de conta/agente; a chamada direta, não.
        await api._transfer_check(alvo)
        return await api.kill_session(alvo)
    except HTTPException as e:
        raise ToolError(_detalhe(e)) from e


VERBOS_NAV = ("snapshot", "click", "fill", "type", "press", "hover", "wait", "eval", "tema", "layout", "console",
              "network", "text", "url", "shot", "close", "goto", "back", "reload", "dialog", "login", "estado", "tab-list", "tab-new", "tab-switch", "tab-close")
# Duas chamadas do mesmo turno não podem intercalar `click` e `snapshot`: o CLI serializa por
# processo, aqui é uma trava por sessão.
_travas_nav: dict[str, asyncio.Lock] = {}


def _pasta_shots(sessao: str) -> Path:
    return Path.home() / ".hangar" / "nav" / "shots" / re.sub(r"\W+", "-", sessao)


# O `login` espera o usuário aprovar no painel (até 110 s no app).
_TETO_VERBO = {"login": 120.0}


async def _verbo_nav(sessao: str, verbo: str, args: list[str], aba: int | None) -> str:
    if verbo not in VERBOS_NAV:
        raise ToolError(f"verbo desconhecido: {verbo} (aceitos: {', '.join(VERBOS_NAV)})")
    if verbo == "eval" and not args:
        raise ToolError("eval precisa de um trecho JS")
    if verbo == "shot":
        # O shell grava onde mandarem; caminho nosso, estável, que o app do celular consegue servir.
        pasta = _pasta_shots(sessao)
        await asyncio.to_thread(pasta.mkdir, parents=True, exist_ok=True)
        args = [str(pasta / f"{int(time.time() * 1000)}.png")]
    try:
        extra = {"teto_s": _TETO_VERBO[verbo]} if verbo in _TETO_VERBO else {}
        texto = await asyncio.to_thread(navshell.verbo, sessao, verbo, args, aba, **extra)
    except navshell.ShellIndisponivel as e:
        raise ToolError(str(e)) from e
    if texto.startswith("erro:"):
        raise ToolError(texto)
    return texto


@mcp.tool(description="Abre (ou navega) o navegador embutido desta sessão no app desktop do Hangar "
                      "(= `hangar-preview open <url>`) e só volta com ele pronto: o verbo seguinte já funciona. "
                      "Devolve a URL carregada. O painel aparece para o usuário só quando ele abrir esta "
                      "sessão no app: diga que a página está aberta no navegador da sessão, nunca que "
                      "apareceu na tela dele. Página já aberta: prefira browser goto." + _SESSAO_DESC)
async def browser_open(ctx: Context, url: str, sessao: str = "") -> dict[str, Any]:
    from app import api
    eu = await _eu(ctx, sessao)
    desde = int(time.time() * 1000)
    antes = await asyncio.to_thread(navshell.url_antes, eu)
    try:
        await api.abrir_nav_sessao(eu, api.NavBody(url=url))
    except HTTPException as e:
        raise ToolError(_detalhe(e)) from e
    try:
        pronto = await asyncio.to_thread(navshell.esperar_pronto, eu, desde, antes, url)
    except navshell.ShellIndisponivel as e:
        raise ToolError(str(e)) from e
    return {"ok": True, "url": pronto}


_HTML_RENDER = (
    "Mostra uma página HTML pronta (gráfico, tabela, diagrama, mock de tela, comparação) DENTRO desta conversa, "
    "no lugar desta chamada e acima do seu texto final; chame antes de escrever a resposta. O leitor já vê a página: "
    "a resposta não a anuncia, não diz onde ela está e não repete o que ela mostra — diga só o que ela não diz. "
    "Confira antes de publicar com draft=true: devolve o print da página como imagem, `console` e `heights`; "
    "width (240-1600, padrão 728; ~390 para celular) e theme (dark|light, padrão dark) escolhem o print, para "
    "conferir a versão de celular e a clara. Com o app desktop aberto, passe a `url` do rascunho a browser_open exatamente como veio (caminho "
    "relativo; o servidor completa endereço e acesso) e use browser para passar o mouse e clicar. "
    "Página publicada não muda: corrigir é publicar de novo. "
    "INTERAÇÃO: mock de tela é funcional, não imagem. O que parece clicável funciona com JS embutido (abas trocam, "
    "menu e modal abrem e fecham, formulário valida e mostra o erro, lista filtra), com dados de exemplo no próprio "
    "documento e sem chamada de rede; os estados (vazio, carregando, erro, selecionado) se alcançam pela própria "
    "página. Antes de publicar um mock, clique nele no rascunho com browser. "
    "url (http/https, no lugar de html) abre um site de verdade dentro da conversa, com o login do navegador do "
    "app; só aparece vivo no app desktop; use para app rodando em localhost ou site que exige login. "
    "PÁGINA: um documento só, com <style> e <script> embutidos. Imagem local por caminho absoluto "
    "(src=\"/abs/a.png\", url(/abs/b.webp) ou string JS) é embutida sozinha; arquivo que não é imagem é recusado. "
    "URL http(s) (biblioteca de gráfico em CDN) carrega como está; file: não. "
    "LAYOUT: a moldura não tem borda e fica sobre o fundo da conversa, na largura da coluna (cerca de 728px no "
    "desktop, 360px no celular). Deixe html, body e o elemento mais externo SEM cor de fundo. Largura fluida, sem "
    "padding horizontal no elemento externo, sem cartão, borda ou título de banner em volta: a página é parte da "
    "resposta. Caixa que precisa de fundo próprio leva padding de 16px ou mais e cantos var(--radius). Gráfico com "
    "altura fixa em pixel. Nada de 100vh nem height:100% em html/body: a moldura cresce com a página. "
    "TEMA: use as variáveis --foreground, --muted-foreground, --surface, --border, --accent, --accent-foreground, "
    "--danger, --warning, --success, --info, --code-background, --code-foreground, --chart-1 a --chart-6, "
    "--radius, --font-sans, --font-mono; para componente, também --card, --popover, --muted, --secondary, "
    "--primary, --input, --ring, --destructive e as superfícies suaves --accent-surface, --destructive-surface e "
    "--warning-surface (cada uma com seu -foreground). --background é transparente. Elas seguem o tema claro/escuro "
    "do app; seu CSS pode sobrescrever. "
    "own_theme=true para mock de outro produto/site ou página que precisa das próprias cores: ela leva o próprio "
    "fundo e paleta, como foi desenhada, e não recebe o tema do app; sem ele, a página segue o tema do app. "
    "height (80-2000) só para limitar a moldura e deixar o resto rolar dentro dela.")


@mcp.tool(description=_HTML_RENDER + _SESSAO_DESC)
async def html_render(ctx: Context, title: str, html: str | None = None, url: str | None = None,
                      height: int | None = None, draft: bool = False, own_theme: bool = False,
                      width: int | None = None, theme: Literal["dark", "light"] | None = None,
                      sessao: str = "") -> dict[str, Any]:
    from app import pages_bridge
    if (html is None) == (url is None):
        raise ToolError("erro_pagina_html_ou_url: passe html ou url, nunca os dois")
    eu = await _eu(ctx, sessao)
    payload: dict[str, Any] = {"session": eu, "title": title, "draft": draft}
    if url is not None:
        payload["url"] = url
    else:
        payload["html"] = html
    # Só quando pedido: hangar-server antigo recusa campo desconhecido no corpo.
    if own_theme:
        payload["own_theme"] = True
    payload |= {k: v for k, v in (("height", height), ("width", width), ("theme", theme)) if v is not None}
    try:
        result = await asyncio.to_thread(pages_bridge.publish, payload)
    except pages_bridge.PagesBridgeError as e:
        raise ToolError(f"{e.code}: {e.detail}" if e.detail else e.code) from e
    # O print do rascunho volta na resposta, como o `shot` do navegador; o resultado estruturado fica igual.
    shot = (result.get("draft") or {}).get("shot")
    png = Path(shot) if isinstance(shot, str) else None
    if png and png.is_file():
        image = await asyncio.to_thread(Image(path=png).to_image_content)
        content = [TextContent(type="text", text=json.dumps(result, ensure_ascii=False)), image]
        return CallToolResult(content=content, structured_content=result)
    return result


_BROWSER = (
    "Um verbo do navegador desta sessão (= `hangar-preview <verbo>`); abra antes com browser_open. "
    "LER: snapshot (árvore de acessibilidade com estados; só acionáveis têm ref @eN; refs morrem a cada "
    "navegação ou re-render: refaça; args [\"--refs\"] traz só os acionáveis), text (texto visível, bem mais "
    "barato), url, console [--limpar] (log, erros de JS não tratados, diálogos e downloads recusados), "
    "network (liga na 1ª chamada: chame ANTES da ação; mostra método, status e falhas). "
    "AGIR: click/hover <ref>, fill <ref> <texto>, type <texto> (campo já focado), press <tecla>. "
    "NAVEGAR: goto <url>, back, reload (voltam com a página carregada). "
    "ESPERAR (nunca sleep): wait --idle | --text <t> (ignora maiúsculas) | --url <t> | @eN | <ms>, "
    "teto com --timeout <ms> até 40000. VER: shot (devolve a imagem e o caminho do PNG). "
    "DIÁLOGO: alert/confirm/prompt ficam abertos e a resposta do verbo avisa; responda com dialog accept [texto] "
    "ou dialog dismiss antes de outra ação. "
    "tema claro|escuro|sistema, layout mobile|desktop|<l> <a>, close (terminou, feche). "
    "login [site]: pede ao usuário, na tela dele, o login do Chrome para o site (espera até 110 s; "
    "uma chamada por necessidade, nunca em laço). Pausado pelo usuário, as ações voltam erro: espere ele retomar. "
    "`erro:` volta como erro da tool. Tela desconhecida com várias ações: browser_goal (sessão com o Jev). "
    "Só no Electron antigo: tab-list, tab-new <url>, tab-switch <id>, tab-close [id] e `aba`.")


@mcp.tool(description=_BROWSER + _SESSAO_DESC)
async def browser(ctx: Context, verbo: str, args: list[str | int] | None = None, aba: int | None = None,
                  sessao: str = "") -> str | list[str | Image]:
    eu = await _eu(ctx, sessao)
    async with _travas_nav.setdefault(eu, asyncio.Lock()):
        texto = await _verbo_nav(eu, verbo, [str(a) for a in args or []], aba)
    # O print volta na resposta: o agente vê sem outra ida ao disco.
    png = Path(texto.removeprefix("ok: shot ").strip()) if verbo == "shot" else None
    if png and png.is_file():
        return [texto, Image(path=png)]
    return texto


@mcp.tool(description="Vários verbos já conhecidos do navegador numa chamada, como `hangar-preview batch`: "
                      "para no primeiro que falhar e diz em qual (seguir depois de um click que falhou faria o "
                      "próximo fill digitar no lugar errado). Cada passo é {verbo, args?}, os mesmos verbos da "
                      "tool browser. Tela que você ainda não viu: browser_goal." + _SESSAO_DESC)
async def browser_batch(ctx: Context, passos: list[dict[str, Any]], sessao: str = "") -> dict[str, Any]:
    eu = await _eu(ctx, sessao)
    feitos: list[str] = []
    async with _travas_nav.setdefault(eu, asyncio.Lock()):
        for i, p in enumerate(passos):
            verbo = str(p.get("verbo") or "")
            try:
                feitos.append(await _verbo_nav(eu, verbo, [str(a) for a in p.get("args") or []], p.get("aba")))
            except ToolError as e:
                raise ToolError(f"parou no passo {i} ({verbo}): {e}\nfeitos antes: {json.dumps(feitos, ensure_ascii=False)}") from e
    return {"feitos": feitos}


_HANGAR_PREVIEW = Path(__file__).resolve().parents[2] / "scripts" / "hangar-preview"
JEV_OFF = ("o Jev não chegou ligado nesta chamada: ou a sessão nasceu sem ele (abra uma com "
           "`hangar-send --new <nome> <cwd> --jev`, ou marque o Jev em \"Mais opções\" ao criar), ou o MCP hangar desta "
           "conta foi registrado antes do cabeçalho X-Hangar-Jev (rode scripts/registrar-mcp.py e abra a sessão de novo). "
           "Sem ele, use browser e browser_batch.")
JEV_UNCONFIGURED = "o Jev não está configurado neste servidor: cadastre a chave em Configurações do servidor > Jev."


async def _jev_cli(ctx: Context, sessao: str, args: list[str], teto_s: float) -> tuple[int, str]:
    """Roda `hangar-preview objetivo|confere` em nome da sessão, com a chave do servidor. Só vale para sessão que
    nasceu com o Jev (o `headersHelper` repassa o HANGAR_JEV dela); a voz usa a do servidor."""
    from app import runtime_config
    _, voice = await _caller(ctx)
    if not voice:
        h = {k.lower(): v for k, v in _cabecalhos(ctx).items()}
        if h.get("x-hangar-jev") != "on":
            raise ToolError(JEV_OFF)
    alvo = await _eu(ctx, sessao)
    env = {k: v for k, v in os.environ.items() if k not in runtime_config.JEV_VARS}
    env.update(runtime_config.env_jev(True))
    if not env.get("TYPESAFE_API_KEY"):
        raise ToolError(JEV_UNCONFIGURED)
    node = shutil.which("node")
    if not node:
        raise ToolError("node não encontrado no PATH do backend: o objetivo roda pelo hangar-preview")
    # Mesma trava dos verbos: uma chamada `browser` no meio refaria o snapshot e trocaria as refs do Jev.
    async with _travas_nav.setdefault(alvo, asyncio.Lock()):
        proc = await asyncio.create_subprocess_exec(node, str(_HANGAR_PREVIEW), *args, "--sessao", alvo, env=env,
                                                    stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT)
        try:
            saida, _ = await asyncio.wait_for(proc.communicate(), teto_s)
        except TimeoutError:
            raise ToolError(f"o Jev não terminou em {teto_s:.0f}s; a página ficou onde parou (veja com browser snapshot)")
        finally:
            # Prazo estourado ou chamada cancelada: o Node não segue dirigindo o navegador sozinho.
            if proc.returncode is None:
                proc.kill()
                await proc.wait()
    return proc.returncode or 0, saida.decode("utf-8", "replace").replace("hangar-preview: ", "").strip()


@mcp.tool(description="O Jev dirige o navegador desta sessão sozinho até cumprir um objetivo (navegar até uma "
                      "tela, preencher um cadastro, escolher num combobox): uma chamada no lugar de vários "
                      "snapshot+click. Só em sessão aberta com o Jev. `dados`: valores para os campos, com as "
                      "chaves que quiser (o Jev casa cada um com o rótulo). Resposta: os passos, `parou:`, `url:`, "
                      "`texto:` e, se faltou valor, `falta-dado: <campo>` — chame de novo com ele em `dados`; a "
                      "página fica onde parou. Erro = não cumpriu. O objetivo que deu certo vira roteiro em "
                      "`.hangar/roteiros/` na raiz do git da sessão (ou em `pasta`) e a próxima chamada igual o "
                      "repete sem o Jev decidir cada passo; `refazer: true` ignora o roteiro." + _SESSAO_DESC)
async def browser_goal(ctx: Context, objetivo: str, dados: dict[str, Any] | None = None, passos: int = 15,
                       refazer: bool = False, pasta: str = "", sessao: str = "") -> str:
    args = ["objetivo", objetivo, "--passos", str(max(1, min(passos, 40)))]
    if dados:
        args += ["--dados", json.dumps(dados, ensure_ascii=False)]
    if refazer:
        args.append("--refazer")
    if pasta.strip():
        args += ["--pasta", pasta.strip()]
    # O script roda no cwd do backend: a pasta do roteiro (e `pasta` relativa) sai do git onde a
    # sessão trabalha.
    from app import api
    aviso = ""
    try:
        args += ["--cwd", await asyncio.to_thread(api._session_git_cwd, await _eu(ctx, sessao))]
    except HTTPException as e:
        aviso = f"\naviso: cwd da sessão desconhecido ({e.detail}); roteiro relativo ao backend ou no cache do usuário"
    codigo, saida = await _jev_cli(ctx, sessao, args, 300.0)
    if codigo != 0:
        raise ToolError(saida + aviso)
    return saida + aviso


@mcp.tool(description="O Jev diz se a tela do navegador desta sessão já mostra um estado (\"o diálogo fechou e a "
                      "lista mostra o item novo\"): use antes do shot ou para saber se uma ação deu certo, sem "
                      "ler a árvore. Só em sessão aberta com o Jev. Devolve `sim` e a confiança." + _SESSAO_DESC)
async def browser_check(ctx: Context, estado: str, sessao: str = "") -> dict[str, Any]:
    codigo, saida = await _jev_cli(ctx, sessao, ["confere", estado], 60.0)
    m = re.search(r"confere: ([0-9.]+)", saida)
    # Saída 1 também vem de app fechado ou navegador sumido: sem a linha do Jev não é "ainda não", é erro.
    if codigo not in (0, 1) or not m:
        raise ToolError(saida)
    return {"sim": codigo == 0, "confianca": float(m.group(1))}


# O gerenciador de sessões do SDK só roda UMA vez por instância: o sub-app nasce no lifespan.
_sub = None


async def _responder(send, status: int, corpo: bytes) -> None:
    await send({"type": "http.response.start", "status": status,
                "headers": [(b"content-type", b"application/json")]})
    await send({"type": "http.response.body", "body": corpo})


async def asgi(scope, receive, send):
    """Sub-app com o bearer conferido na porta: mount não passa pelo `require_auth` das rotas."""
    if scope["type"] != "http":
        return
    # Só sessões desta máquina falam com o MCP (mesma regra do `require_loopback`): o celular e
    # os peers usam a API normal.
    cliente = scope.get("client")
    if not cliente or cliente[0] not in auth_mod._LOOPBACK:
        await _responder(send, 403, b'{"detail":"so na maquina do backend"}')
        return
    auth = dict(scope["headers"]).get(b"authorization", b"")
    token = auth[7:] if auth.startswith(b"Bearer ") else b""
    if not token or not settings.auth_token or not secrets.compare_digest(token, settings.auth_token.encode()):
        await _responder(send, 401, b'{"detail":"unauthorized"}')
        return
    if _sub is None:
        await _responder(send, 503, b'{"detail":"mcp ainda nao subiu"}')
        return
    await _sub(scope, receive, send)


@contextlib.asynccontextmanager
async def lifespan():
    global _sub
    # Só sessões desta máquina falam com o /mcp; o Host de fora é recusado (DNS rebinding).
    seguranca = TransportSecuritySettings(
        enable_dns_rebinding_protection=True,
        allowed_hosts=["127.0.0.1", "127.0.0.1:*", "localhost", "localhost:*", "[::1]", "[::1]:*"],
        allowed_origins=["http://127.0.0.1:*", "http://localhost:*", "http://[::1]:*"])
    sub = mcp.streamable_http_app(streamable_http_path="/", transport_security=seguranca)
    async with sub.router.lifespan_context(sub):
        _sub = sub
        try:
            yield
        finally:
            _sub = None
