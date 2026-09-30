"""Uso do Claude Code lido do TRANSCRIPT, não do resumo de plugin nenhum.

Três motivos, medidos em 01/08/2026 nesta máquina (números movem toda semana — são foto, não
constante; refazer a medição do Step 6 da Task 2 antes de confiar neles de novo):

1. O gasto de SUBAGENTE não está na conta. Numa sessão com 14 subagentes, o `costs.jsonl`
   registra 183.855.995 de cache lido — idêntico ao transcript do pai sozinho —, enquanto os
   subagentes somam outros 12.809.654 que o plugin nunca viu. No total, medido em 01/08/2026:
   4,80 Bi contra 26,15 Bi de conversa — 15,5% do volume, em 3.160 registros (446 de conversa +
   2.714 de subagente).
2. O app dependia de plugin de terceiro (`cost-tracker.js` do ECC) para função própria.
   Codex e Pi já leem o transcript original; o Claude era o único fora do padrão.
3. O plugin só cobre a partir de 27/06; os transcripts começam em 12/06.

REGRA DE ACUMULAÇÃO: aqui é SOMA por turno. O `costs.jsonl` era cumulativo (última linha
vence). Trocar a regra entre as fontes não quebra nada e devolve número plausível e errado.

ÍNDICE EM DISCO, e POR RAIZ (`costs_cache`): a leitura é retomável (`DobraClaude`), então um
transcript que cresceu só tem o fim lido. Cada raiz é um escopo próprio: a segunda conta
configurada não apaga a primeira.
"""
from __future__ import annotations

import json
import os
from dataclasses import dataclass, replace
from datetime import datetime, timedelta, timezone
from pathlib import Path

from app import costs_cache, pricing, uso_claude
from app.uso_claude import UsoLinha

# `LOCAL` é cópia proposital: `costs_sources` vai importar ESTE módulo, então importar de lá
# fecharia ciclo. Não "arrume" unificando — quebra o import.
LOCAL = timezone(timedelta(hours=-3))

# Suba isto ao mudar o que a dobra produz ou guarda, senão o índice velho é servido pra sempre.
CACHE_VERSAO = 12

# Marcador do subagente. O caminho é `<projeto>/<sessionId>/subagents/agent-*.jsonl`.
# Medido em 01/08/2026: 2.714 arquivos assim, contra 446 de conversa — cresce toda semana.
_DIR_SUBAGENTE = "subagents"


@dataclass(frozen=True, slots=True)
class UsoSessao:
    session_id: str       # id ÚNICO, derivado do CAMINHO relativo (ver `varrer`)
    ts: datetime          # Primeira resposta deste segmento diário.
    model: str
    cwd: str
    subagente: bool
    input: int
    output: int
    cache_write: int
    cache_read: int
    cache_write_1h: int = 0
    fast: bool = False     # `usage.speed == "fast"`: a Anthropic cobra o dobro nesse modo.
    # Cache escrito em respostas que PERDERAM o cache (expirou na pausa ou o contexto mudou):
    # o que foi regravado e poderia ter sido relido.
    regravado: int = 0
    regravado_1h: int = 0


def raiz_projetos(config_dir: Path | None = None) -> Path:
    """Onde o Claude Code guarda os transcripts: `<config>/projects/`, diretório GLOBAL — não
    dentro do repositório. Cada subpasta tem o caminho do projeto com barras viradas em traço.

    `config_dir` é o que importa na prática: o app suporta MAIS DE UM diretório de configuração
    e `coletar()` chama o leitor uma vez por diretório. Ignorar esse argumento leria a mesma
    raiz N vezes e contaria o gasto em dobro, dividido entre contas erradas.
    """
    if config_dir is not None:
        return Path(config_dir) / "projects"
    base = os.environ.get("CLAUDE_CONFIG_DIR")
    return (Path(base) if base else Path.home() / ".claude") / "projects"


def _int(v) -> int:
    try:
        return int(v or 0)
    except (TypeError, ValueError):
        return 0


@dataclass(frozen=True)
class Leitura:
    """As duas leituras de um transcript, feitas numa passada só: tokens (custo) e uso
    (tools/skills/contexto)."""
    usos: list[UsoSessao]
    uso: list[UsoLinha]


def _quando(ts) -> datetime | None:
    if not isinstance(ts, str):
        return None
    try:
        return datetime.fromisoformat(ts.replace("Z", "+00:00")).astimezone(LOCAL)
    except ValueError:
        return None


class DobraClaude:
    """Uso por resposta, separado por dia/modelo; blocos da mesma resposta não somam novamente.
    Na mesma passada, o acumulador de uso vê toda linha de assistant/user/attachment. Retomável:
    o `costs_cache` guarda o objeto e continua do offset salvo."""

    def __init__(self, session_id: str = "", subagente: bool = False,
                 subagente_uso: bool = False) -> None:
        self.session_id = session_id
        self.subagente = subagente
        self.subagente_uso = subagente_uso
        self.numero = 0
        # Última versão de cada resposta, na ordem da primeira aparição: um bloco que chega
        # numa coleta posterior substitui o valor sem mudar a posição.
        self.respostas: dict[tuple, UsoSessao] = {}
        # Respostas depois das quais a próxima gravação grande é esperada, não perda de cache:
        # a primeira do arquivo e a primeira depois de compactar.
        self.depois_de_compactar: set[tuple] = set()
        self.compactou = False
        self.acumulador = uso_claude.Acumulador()

    def linha(self, bruta: bytes) -> None:
        numero = self.numero
        self.numero += 1
        # Pré-filtro barato: a maior parte das linhas (progresso, fila, títulos) não tem nem uso
        # nem tool nem attachment; sem isto o json.loads roda em tudo.
        if (b'"usage"' not in bruta and b'"user"' not in bruta and b'"attachment"' not in bruta
                and b'"compact_boundary"' not in bruta):
            return
        try:
            d = json.loads(bruta.decode("utf-8", "replace"))
        except json.JSONDecodeError:
            return
        if not isinstance(d, dict):
            return
        quando = _quando(d.get("timestamp"))
        msg = d.get("message")
        m = msg.get("model") if isinstance(msg, dict) else None
        if isinstance(m, str) and m.strip() in pricing.IGNORADOS:
            return
        self.acumulador.linha(d, quando.strftime("%Y-%m-%d") if quando else "")
        if d.get("subtype") == "compact_boundary":
            self.compactou = True
        if d.get("type") != "assistant":
            return
        u = msg.get("usage") if isinstance(msg, dict) else None
        if not isinstance(u, dict) or quando is None:
            return
        # Sem identidade não há prova de repetição: preserva as linhas antigas.
        key = (d.get("requestId"), msg["id"]) if msg.get("id") else (numero,)
        if self.compactou and key not in self.respostas:
            self.depois_de_compactar.add(key)
            self.compactou = False
        criacao = u.get("cache_creation")
        cache_1h = _int(criacao.get("ephemeral_1h_input_tokens")) if isinstance(criacao, dict) else 0
        self.respostas[key] = UsoSessao(
            session_id=self.session_id, ts=quando, model=m or "?", cwd=d.get("cwd") or "",
            subagente=self.subagente,
            input=_int(u.get("input_tokens")), output=_int(u.get("output_tokens")),
            cache_write=_int(u.get("cache_creation_input_tokens")),
            cache_read=_int(u.get("cache_read_input_tokens")),
            cache_write_1h=min(max(0, cache_1h), max(0, _int(u.get("cache_creation_input_tokens")))),
            fast=u.get("speed") == "fast")

    def usos(self) -> list[UsoSessao]:
        grupos: dict[tuple, UsoSessao] = {}
        contexto_antes = None
        for chave, uso in self.respostas.items():
            # Perdido = o contexto da resposta anterior que NÃO veio do cache e teve de ser
            # gravado de novo. Comparar com o cache lido da própria resposta confundia conteúdo
            # novo grande (arquivo lido, diff) com cache expirado.
            if contexto_antes is not None and chave not in self.depois_de_compactar and uso.cache_write:
                perdido = min(uso.cache_write, max(0, contexto_antes - uso.cache_read))
                # Expirar leva o prefixo quase inteiro; sobra pequena é lembrete que mudou no meio.
                if perdido * 2 >= contexto_antes:
                    uso = replace(uso, regravado=perdido,
                                  regravado_1h=uso.cache_write_1h * perdido // uso.cache_write)
            contexto_antes = uso.input + uso.cache_write + uso.cache_read
            # `fast` entra na chave porque é o que decide a TARIFA: somado com o padrão, o grupo
            # inteiro seria cobrado por uma das duas e a outra metade sairia errada.
            key = (uso.ts.date(), uso.model, uso.cwd, uso.fast)
            antes = grupos.get(key)
            grupos[key] = uso if antes is None else replace(
                antes, input=antes.input + uso.input, output=antes.output + uso.output,
                cache_write=antes.cache_write + uso.cache_write,
                cache_read=antes.cache_read + uso.cache_read,
                cache_write_1h=antes.cache_write_1h + uso.cache_write_1h,
                regravado=antes.regravado + uso.regravado,
                regravado_1h=antes.regravado_1h + uso.regravado_1h)
        return sorted(grupos.values(), key=lambda u: (u.ts, u.model, u.cwd))

    def _uso(self, linhas: list[UsoLinha]) -> list[UsoLinha]:
        if not self.session_id:
            return linhas
        return [replace(l, session_id=self.session_id, subagente=self.subagente_uso) for l in linhas]

    def fechar(self):
        entradas = self.acumulador.entradas_de_area()
        if self.session_id:
            entradas = ({"session_id": self.session_id, "subagente": self.subagente_uso}, entradas[1])
        custos = [_linha_custo(u) for u in self.usos()]
        return custos, self._uso(self.acumulador.linhas_sem_area()), entradas


def _linha_custo(u: UsoSessao):
    # Mesmo formato das outras fontes no índice; provedor e conta entram na leitura.
    from app.costs_sources import UsageRow
    return UsageRow(ts=u.ts, source="claude", provider="", model=u.model, project=u.cwd,
                    session_id=u.session_id, input=u.input, output=u.output,
                    cache_write=u.cache_write, cache_read=u.cache_read, subagente=u.subagente,
                    cache_write_1h=u.cache_write_1h, fast=u.fast, regravado=u.regravado,
                    regravado_1h=u.regravado_1h)


def _ler(path: Path, dobra: DobraClaude) -> DobraClaude:
    try:
        f = path.open("rb")
    except OSError:
        return dobra
    with f:
        for bruta in f:
            dobra.linha(bruta)
    return dobra


def ler_completo(path: Path) -> Leitura:
    """O arquivo inteiro, sem índice (teste e diagnóstico)."""
    dobra = _ler(path, DobraClaude(subagente=_DIR_SUBAGENTE in path.parts))
    return Leitura(dobra.usos(), dobra.acumulador.resultado())


def ler_transcript(path: Path) -> list[UsoSessao]:
    return ler_completo(path).usos


def invalidar_cache() -> None:
    costs_cache.invalidar()


def escopo(raiz: Path) -> str:
    return f"claude:{raiz}"


def _nova_dobra(raiz: Path):
    def nova(p: Path) -> DobraClaude:
        # Identidade pelo CAMINHO relativo: o `sessionId` do subagente é o do PAI
        # (medido: 168 de 446 ids repetidos entre arquivos).
        # Barra `/` em todo SO: quem liga subagente ao pai procura `/subagents/` no id.
        sid = p.relative_to(raiz).with_suffix("").as_posix()
        return DobraClaude(sid, subagente=_DIR_SUBAGENTE in p.parts,
                           subagente_uso=_DIR_SUBAGENTE in Path(sid).parts)
    return nova


def sincronizar(raiz: Path) -> None:
    """Atualiza o índice desta raiz de projetos. Nunca vai à rede."""
    if not raiz.is_dir():
        return
    costs_cache.sincronizar(escopo(raiz), costs_cache.listar(raiz, lambda n: n.endswith(".jsonl")),
                            _nova_dobra(raiz), f"claude:{CACHE_VERSAO}")


def custos_do_transcript(path: Path) -> list:
    """Linhas de custo de UM transcript pelo índice (só o que cresceu é lido). A raiz é a pasta
    `projects` acima dele, a mesma da varredura, para o arquivo não ser lido duas vezes."""
    from app.costs_sources import _usage_row
    raiz = next((p for p in path.parents if p.name == "projects"), path.parent.parent)
    file_id = costs_cache.sincronizar_arquivo(path, _nova_dobra(raiz), f"claude:{CACHE_VERSAO}", escopo(raiz))
    return [] if file_id is None else [_usage_row(t) for t in costs_cache.ler_custos(file_id=file_id)]


def _usos_do_indice(raiz: Path) -> list[UsoSessao]:
    return [UsoSessao(session_id=t[5], ts=datetime.fromisoformat(t[0]), model=t[3], cwd=t[4],
                      subagente=bool(t[10]), input=t[6], output=t[7], cache_write=t[8],
                      cache_read=t[9], cache_write_1h=t[13], fast=bool(t[14]), regravado=t[15],
                      regravado_1h=t[16])
            for t in costs_cache.ler_custos(escopo(raiz))]


def varrer(raiz: Path) -> list[UsoSessao]:
    """Uso de tokens de todas as sessões de UMA raiz de projetos. Nunca vai à rede."""
    if not raiz.is_dir():
        return []
    sincronizar(raiz)
    return _usos_do_indice(raiz)


def varrer_uso(raiz: Path) -> list[UsoLinha]:
    """Uso de tools/skills/contexto da mesma raiz — mesma passada, mesmo índice."""
    if not raiz.is_dir():
        return []
    sincronizar(raiz)
    return costs_cache.ler_usos(escopo(raiz), "")
