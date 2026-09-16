"""Uso de tools, skills, agentes e contexto injetado, lido do transcript do Claude Code.

Roda na MESMA passada que a leitura de tokens (`costs_claude_transcript.ler_transcript`): o
transcript é o arquivo mais pesado da máquina, e lê-lo duas vezes dobraria a varredura fria.
Este módulo só acumula a partir das linhas já decodificadas; quem itera o arquivo é o outro.

O que é medido de verdade e o que é estimado:
- chamadas (tool, skill, agente) e ocorrências (contexto): contagem exata.
- tokens de skill: `usage` real das respostas entre a chamada e a próxima skill ou a troca de
  `promptId` — o texto expandido da skill é uma mensagem `user` com `isMeta` e o MESMO promptId,
  por isso a fronteira é o promptId e não "próxima mensagem do usuário".
- `ctx_chars` (resultado de tool, texto injetado por hook/skill/instruções): caracteres do que
  entrou no contexto; vira "tokens estimados" na tela, nunca dólar. O transcript não carrega
  contagem de tokens por bloco, e tokenizador de outro provedor erraria mais do que chars/4.
- attachment: `rendered` é o que a CLI mostrou ao modelo (≥ 2.1.26x); sem ele, `content`/`text`.
  `stdout` de hook sem `content` NÃO entra no contexto e não é medido.
"""
from __future__ import annotations

import json
from dataclasses import asdict, dataclass, replace

# Um tool_use `Bash` vira `bash:<comando>`; estes prefixos não são o comando.
_PREFIXOS_BASH = {"sudo", "env", "time", "timeout", "rtk", "command", "exec", "nohup", "nice"}
_ROTULO_HOOK_CHARS = 60


@dataclass(frozen=True)
class UsoLinha:
    dia: str            # YYYY-MM-DD no fuso local
    cwd: str
    model: str
    tipo: str           # tool | bash | mcp | skill | agente | contexto
    nome: str
    plugin: str = ""    # prefixo de skill/hook (ecc, superpowers…) quando há
    detalhe: str = ""   # mcp: tool completo; agente: agentId (liga ao transcript filho)
    chamadas: int = 0
    ctx_chars: int = 0
    input: int = 0
    output: int = 0
    cache_write: int = 0
    cache_read: int = 0
    cache_write_1h: int = 0
    fast: bool = False
    session_id: str = ""
    conta: str = ""     # identidade da conta (anthropic:<uuid>), aplicada depois do cache

    def para_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def de_dict(cls, d: dict) -> "UsoLinha | None":
        try:
            return cls(**d)
        except TypeError:
            return None


def _int(v) -> int:
    try:
        return int(v or 0)
    except (TypeError, ValueError):
        return 0


def _texto(c) -> int:
    """Tamanho em chars de um conteúdo que pode ser string, lista de blocos ou nada."""
    if isinstance(c, str):
        return len(c)
    if isinstance(c, list):
        n = 0
        for b in c:
            if isinstance(b, dict):
                n += _texto(b["text"] if isinstance(b.get("text"), str) else b.get("content"))
            elif isinstance(b, str):
                n += len(b)
        return n
    return 0


_PALAVRAS_SHELL = {"do", "then", "else", "done", "fi", "in", "cd"}


def comando_bash(cmd: str) -> str:
    """Primeira palavra útil de um comando: pula `cd x &&`, variáveis (`X=$(cmd …` vale o
    `cmd`), `(`, flags soltas e sudo/env/rtk."""
    for trecho in _segmentos(cmd):
        for tok in trecho.split():
            t = tok.lstrip("(")
            if "=" in t and not t.startswith("="):
                valor = t.split("=", 1)[1]
                if not valor.startswith("$("):
                    continue
                t = valor[2:]
            # `timeout 300 npx …`: o prefixo e o número dele não são o comando.
            if not t or t.startswith("-") or t[0].isdigit() or t in _PREFIXOS_BASH:
                continue
            if t in _PALAVRAS_SHELL:
                break
            return t.rsplit("/", 1)[-1]
    return "?"


def _segmentos(cmd: str) -> list[str]:
    out, atual = [], []
    i = 0
    while i < len(cmd):
        dois = cmd[i:i + 2]
        if dois in ("&&", "||") or cmd[i] in ";|\n":
            out.append("".join(atual))
            atual = []
            i += 2 if dois in ("&&", "||") else 1
            continue
        atual.append(cmd[i])
        i += 1
    out.append("".join(atual))
    return [s for s in out if s.strip()]


def plugin_de(nome: str) -> str:
    return nome.split(":", 1)[0] if ":" in nome else ""


def plugin_de_hook(primeira_linha: str, conteudo: str) -> str:
    """Hook não diz de que plugin é; a primeira linha do que ele injeta costuma dizer:
    `[skill-suggester] …`, `PONYTAIL MODE ACTIVE`, e o SessionStart do superpowers."""
    p = primeira_linha.strip()
    if p.startswith("[") and "]" in p:
        return p[1:p.index("]")].strip()
    if " MODE ACTIVE" in p:
        return p.split(" ", 1)[0].lower()
    if "superpowers" in conteudo[:400].lower():
        return "superpowers"
    return ""


class Acumulador:
    """Recebe cada linha decodificada do transcript, na ordem do arquivo."""

    def __init__(self) -> None:
        self._linhas: dict[tuple, UsoLinha] = {}
        self._tools: dict[str, tuple[str, dict]] = {}      # tool_use id -> (nome, input)
        self._respostas_vistas: set = set()
        self._skill: tuple | None = None                    # chave da linha da skill em curso
        self._prompt_id = None
        self._dia = ""
        self._cwd = ""
        self._model = ""

    def _somar(self, tipo: str, nome: str, *, plugin: str = "", detalhe: str = "",
               chamadas: int = 0, ctx_chars: int = 0, usage: dict | None = None) -> tuple:
        chave = (self._dia, self._cwd, self._model, tipo, nome, plugin, detalhe)
        antes = self._linhas.get(chave) or UsoLinha(
            dia=self._dia, cwd=self._cwd, model=self._model, tipo=tipo, nome=nome,
            plugin=plugin, detalhe=detalhe)
        u = usage or {}
        criacao = u.get("cache_creation")
        cache_1h = _int(criacao.get("ephemeral_1h_input_tokens")) if isinstance(criacao, dict) else 0
        self._linhas[chave] = replace(
            antes, chamadas=antes.chamadas + chamadas, ctx_chars=antes.ctx_chars + ctx_chars,
            input=antes.input + _int(u.get("input_tokens")),
            output=antes.output + _int(u.get("output_tokens")),
            cache_write=antes.cache_write + _int(u.get("cache_creation_input_tokens")),
            cache_read=antes.cache_read + _int(u.get("cache_read_input_tokens")),
            cache_write_1h=antes.cache_write_1h + min(max(0, cache_1h),
                                                      max(0, _int(u.get("cache_creation_input_tokens")))),
            fast=antes.fast or u.get("speed") == "fast")
        return chave

    def linha(self, d: dict, dia: str) -> None:
        tipo = d.get("type")
        if dia:
            self._dia = dia
        if isinstance(d.get("cwd"), str):
            self._cwd = d["cwd"]
        if tipo == "assistant":
            self._assistant(d)
        elif tipo == "user":
            self._user(d)
        elif tipo == "attachment":
            self._attachment(d)

    def _assistant(self, d: dict) -> None:
        msg = d.get("message")
        if not isinstance(msg, dict):
            return
        if isinstance(msg.get("model"), str):
            self._model = msg["model"]
        usage = msg.get("usage") if isinstance(msg.get("usage"), dict) else None
        # Blocos da mesma resposta repetem o usage: só a primeira linha soma na skill.
        ident = (d.get("requestId"), msg.get("id")) if msg.get("id") else None
        if usage and self._skill is not None and ident not in self._respostas_vistas:
            self._somar(*self._skill[3:5], plugin=self._skill[5], usage=usage)
        if ident:
            self._respostas_vistas.add(ident)
        for b in msg.get("content") or []:
            if not isinstance(b, dict) or b.get("type") != "tool_use":
                continue
            nome = b.get("name")
            if not isinstance(nome, str):
                continue
            entrada = b.get("input") if isinstance(b.get("input"), dict) else {}
            if isinstance(b.get("id"), str):
                self._tools[b["id"]] = (nome, entrada)
            if nome == "Skill" and isinstance(entrada.get("skill"), str):
                skill = entrada["skill"]
                self._skill = self._somar("skill", skill, plugin=plugin_de(skill), chamadas=1)
            elif nome == "Agent":
                tipo_ag = entrada.get("subagent_type") or "general-purpose"
                self._somar("agente", str(tipo_ag), chamadas=1)
            elif nome == "Bash" and isinstance(entrada.get("command"), str):
                self._somar("bash", comando_bash(entrada["command"]), chamadas=1)
            elif nome.startswith("mcp__"):
                partes = nome.split("__", 2)
                servidor = partes[1] if len(partes) > 1 else nome
                self._somar("mcp", servidor, detalhe=nome, chamadas=1)
            self._somar("tool", nome, chamadas=1)

    def _user(self, d: dict) -> None:
        msg = d.get("message")
        conteudo = msg.get("content") if isinstance(msg, dict) else None
        prompt_id = d.get("promptId")
        if prompt_id and prompt_id != self._prompt_id:
            self._prompt_id = prompt_id
            self._skill = None
        if isinstance(conteudo, str):
            self._comando(conteudo)
            return
        if not isinstance(conteudo, list):
            return
        for b in conteudo:
            if not isinstance(b, dict):
                continue
            if b.get("type") == "tool_result":
                nome, entrada = self._tools.get(b.get("tool_use_id"), ("?", {}))
                chars = _texto(b.get("content"))
                self._somar("tool", nome, ctx_chars=chars)
                if nome == "Bash" and isinstance(entrada.get("command"), str):
                    self._somar("bash", comando_bash(entrada["command"]), ctx_chars=chars)
                elif nome.startswith("mcp__"):
                    partes = nome.split("__", 2)
                    self._somar("mcp", partes[1] if len(partes) > 1 else nome, detalhe=nome,
                                ctx_chars=chars)
                elif nome == "Skill" and self._skill is not None:
                    self._somar(*self._skill[3:5], plugin=self._skill[5], ctx_chars=chars)
                elif nome == "Agent":
                    r = d.get("toolUseResult")
                    agent_id = r.get("agentId") if isinstance(r, dict) else None
                    if isinstance(agent_id, str):
                        tipo_ag = entrada.get("subagent_type") or "general-purpose"
                        self._somar("agente", str(tipo_ag), detalhe=agent_id)
            elif b.get("type") == "text" and isinstance(b.get("text"), str):
                if "<command-name>" in b["text"]:
                    self._comando(b["text"])
                elif d.get("isMeta") and self._skill is not None:
                    # Texto expandido de uma skill chamada por barra: é o que entrou no contexto.
                    self._somar(*self._skill[3:5], plugin=self._skill[5], ctx_chars=len(b["text"]))

    def _comando(self, texto: str) -> None:
        ini = texto.find("<command-name>")
        if ini < 0:
            return
        fim = texto.find("</command-name>", ini)
        nome = texto[ini + len("<command-name>"):fim].strip() if fim > ini else ""
        if not nome:
            return
        nome = nome.lstrip("/")
        self._skill = self._somar("skill", nome, plugin=plugin_de(nome), chamadas=1)

    def _attachment(self, d: dict) -> None:
        a = d.get("attachment")
        if not isinstance(a, dict) or not isinstance(a.get("type"), str):
            return
        rendered = d.get("rendered")
        if rendered is not None:
            chars = _texto(rendered)
        else:
            chars = _texto(a.get("content")) or _texto(a.get("text"))
        tipo = a["type"]
        plugin = ""
        if tipo.startswith("hook"):
            evento = a.get("hookName") or a.get("hookEvent") or "?"
            conteudo = a.get("content")
            primeira = ""
            if isinstance(conteudo, str):
                primeira = conteudo.strip().split("\n", 1)[0][:_ROTULO_HOOK_CHARS]
            elif isinstance(conteudo, list):
                for b in conteudo:
                    texto = b if isinstance(b, str) else b.get("text") if isinstance(b, dict) else None
                    if isinstance(texto, str) and texto.strip():
                        primeira = texto.strip().split("\n", 1)[0][:_ROTULO_HOOK_CHARS]
                        break
            nome = f"{tipo}:{evento}" + (f" · {primeira}" if primeira else "")
            plugin = plugin_de_hook(primeira, conteudo if isinstance(conteudo, str) else "")
        else:
            nome = tipo
        self._somar("contexto", nome, plugin=plugin, chamadas=1, ctx_chars=chars)

    def resultado(self) -> list[UsoLinha]:
        return sorted(self._linhas.values(), key=lambda l: (l.dia, l.tipo, l.nome, l.detalhe))
