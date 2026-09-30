"""Tabela de papéis do contrato do grupo (`regras-<gid>.md`, seção `## Quem é quem`).

O árbitro é dono do resto do arquivo; o app troca só a linha do papel (orq_md). `sessão` aceita
`*` no fim (`trab-t*`: uma sessão por Task) — casa a viva mais recente.
"""
from __future__ import annotations

import itertools
import logging
import shlex
from dataclasses import dataclass
from pathlib import Path

from . import orq_md, pair

_log = logging.getLogger(__name__)

# Dois formatos da tabela, e a leitura aceita os dois. O de 6 colunas é o original (uma linha por
# papel); o de 7 acrescenta `vez`, que é o que deixa um papel ocupar VÁRIAS linhas — o rodízio de
# contas. A coluna só aparece no arquivo quando algum papel de fato reveza: contrato sem rodízio
# continua byte a byte como estava, o que importa porque estes arquivos são de trabalhos em curso.
CABECALHO = ("papel", "sessão", "provider", "conta", "modelo", "esforço")
CABECALHO_VEZ = ("papel", "vez", "sessão", "provider", "conta", "modelo", "esforço")
# `abertura` segue a mesma regra da `vez`: a coluna só entra no arquivo quando algum papel usa uma
# opção de abertura, e vai por último. A célula é o trecho de flags do `hangar-send --new`.
ABERTURA = "abertura"
# `janela`: teto de contexto do papel, em % da janela da própria sessão. O vigia avisa o árbitro
# nele; quem decide a troca é o árbitro.
# Mesma regra das outras opcionais; fica antes de `abertura`. Vazio = 50%.
JANELA = "janela"
_CABECALHOS = tuple(sorted(
    ((CABECALHO_VEZ if vez else CABECALHO) + ((JANELA,) if jan else ()) + ((ABERTURA,) if ab else ())
     for vez, jan, ab in itertools.product((True, False), repeat=3)),
    key=len, reverse=True))
SECAO = "Quem é quem"
ARBITRO = "arbitro"
# `vez` só assume "1", "2", "3"…: a Task N cabe à conta de índice (N-1) % total, então a ordem é a
# própria ordem das linhas e não há estado a guardar. Não existe valor para "rodar em paralelo" —
# Tasks em paralelo são outra coisa (uma worktree por Task, cada uma com seu executor e seu
# revisor) e se declaram no PLANO, não aqui: skills/.../references/paralelo-worktree.md.


@dataclass(frozen=True)
class Papel:
    papel: str
    sessao: str
    provider: str
    conta: str
    modelo: str
    esforco: str
    vez: str = ""
    headless: bool | None = None
    permissao: str = ""
    motor: str = ""
    jev: bool = False
    subagente: str = ""
    perfil: str = ""        # perfil do omp (`--profile`)
    # Trecho da célula que o painel não edita (ex.: `--read-only` escrito pelo árbitro): volta
    # intacto no fim da célula, senão salvar pelo painel apagaria a proteção sem ninguém ver.
    abertura_extra: str = ""
    janela: str = ""        # "60" = teto de contexto em 60% da janela; "" = 50%

    def e_arbitro(self) -> bool:
        return orq_md.normalizar(self.papel) == ARBITRO


GID_PADRAO = "padrao"   # Identificador legado, nunca fonte de um trabalho novo.


def regras_path(gid: str) -> Path:
    return pair._pair_dir() / f"regras-{gid}.md"


def cabecalho_atual(texto: str) -> tuple[str, ...] | None:
    """Formato da tabela no arquivo. A comparação do cabeçalho é exata, então o mais largo é
    tentado primeiro: senão um arquivo com `vez` leria vazio, que na tela é 'grupo sem papel'."""
    return next((cab for cab in _CABECALHOS if orq_md.ler_tabela(texto, cab)), None)


def tem_coluna_vez(texto: str) -> bool:
    cab = cabecalho_atual(texto)
    return bool(cab and "vez" in cab)


def chave_da_linha(cab: tuple[str, ...], papel: str, vez: str) -> str | tuple[str, str]:
    # Chave composta (papel, vez): sem ela, gravar a 2ª conta de um papel sobrescreveria a 1ª.
    return (papel, vez or "-") if "vez" in cab else papel


def abertura_texto(p: Papel) -> str:
    """As flags do `hangar-send --new` que o árbitro põe no comando, na ordem fixa."""
    partes = [] if p.headless is None else ["--headless" if p.headless else "--terminal"]
    for flag, valor in (("--permissao", p.permissao), ("--engine", p.motor), ("--subagente", p.subagente),
                        ("--profile", p.perfil)):
        if valor:
            partes += [flag, valor]
    if p.jev:
        partes.append("--jev")
    # O árbitro cola a célula num comando de shell: valor com espaço ("Full Access") precisa de aspas.
    texto = shlex.join(partes)
    return f"{texto} {p.abertura_extra}".strip() if p.abertura_extra else texto


_FLAGS_COM_VALOR = {"--permissao": "permissao", "--engine": "motor", "--subagente": "subagente",
                    "--profile": "perfil"}


def _ler_abertura(celula: str) -> dict:
    campos: dict = {"headless": None, "permissao": "", "motor": "", "jev": False, "subagente": "",
                    "perfil": ""}
    try:
        toks = [] if celula.strip() in ("", "-") else shlex.split(celula)
    except ValueError:  # aspas sem par, de linha gravada antes das aspas existirem
        _log.warning("abertura com aspas sem par, lida por espaço: %r", celula)
        toks = celula.split()
    extra: list[str] = []
    i = 0
    while i < len(toks):
        t = toks[i]
        if t in ("--headless", "--jev"):
            campos[t[2:]] = True
        elif t == "--terminal":
            campos["headless"] = False
        elif t in _FLAGS_COM_VALOR and i + 1 < len(toks):
            campos[_FLAGS_COM_VALOR[t]] = toks[i + 1]
            i += 1
        else:
            extra.append(t)
        i += 1
    campos["abertura_extra"] = shlex.join(extra)
    return campos


def ler(texto: str) -> list[Papel]:
    cab = cabecalho_atual(texto)
    if cab is None:
        return []
    return [Papel(r["papel"], r["sessão"], r["provider"].lower(), r["conta"],
                  r["modelo"], r["esforço"], r.get("vez", ""), **_ler_abertura(r.get(ABERTURA, "")),
                  janela=r.get(JANELA, "").rstrip("%").strip())
            for r in orq_md.ler_tabela(texto, cab) if r.get("papel")]


def validar_janela(valor: str) -> str:
    if valor and not (valor.isdigit() and 10 <= int(valor) <= 95):
        raise ValueError("janela: porcentagem inteira entre 10 e 95")
    return valor


def _com_coluna(texto: str, cab: tuple[str, ...], nome: str, em: int) -> tuple[str, tuple[str, ...]]:
    """Acrescenta a coluna NO LUGAR, com `-` em quem já estava: nada além da tabela muda de
    posição, e as seções escritas à mão (`## Gates`, `## Réguas`) ficam onde estavam."""
    if nome in cab:
        return texto, cab
    return orq_md.inserir_coluna(texto, cab, nome, em), cab[:em] + (nome,) + cab[em:]


def promover(texto: str) -> str:
    """Acrescenta a coluna `vez`. Só roda quando um papel passa a revezar: contrato que nunca usou
    rodízio nunca é tocado."""
    cab = cabecalho_atual(texto)
    return _com_coluna(texto, cab, "vez", 1)[0] if cab else texto


def escrever_papel(texto: str, p: Papel) -> str:
    abertura = abertura_texto(p)
    for v in (p.papel, p.sessao, p.provider, p.conta, p.modelo, p.esforco, p.vez, abertura):
        orq_md.validar_celula(v)
    validar_janela(p.janela)
    # Contrato que não usa rodízio, janela nem abertura continua byte a byte no formato em que estava.
    cab = cabecalho_atual(texto) or CABECALHO
    if p.vez:
        texto, cab = _com_coluna(texto, cab, "vez", 1)
    if p.janela:
        texto, cab = _com_coluna(texto, cab, JANELA, cab.index(ABERTURA) if ABERTURA in cab else len(cab))
    if abertura:
        texto, cab = _com_coluna(texto, cab, ABERTURA, len(cab))
    valores = {"papel": p.papel, "vez": p.vez, "sessão": p.sessao, "provider": p.provider,
               "conta": p.conta, "modelo": p.modelo, "esforço": p.esforco,
               JANELA: f"{p.janela}%" if p.janela else "", ABERTURA: abertura}
    return orq_md.trocar_linha(texto, cab, chave_da_linha(cab, p.papel, p.vez),
                               {c: valores[c] for c in cab}, SECAO)


def gid_por_sessao(nome: str) -> str | None:
    """O vigia pode ainda não ter juntado uma sessão registrada na execução viva."""
    from app.orq_context import active_gid
    return active_gid(nome)


def casar_viva(papel: Papel, sessoes) -> str | None:
    """Nome da sessão viva deste papel: exato, ou o glob `x*` → a mais recente por last_activity."""
    alvo = papel.sessao.strip()
    if not alvo:
        return None
    if alvo.endswith("*"):
        pref = alvo[:-1]
        cands = [s for s in sessoes if s.name.startswith(pref)]
        if not cands:
            return None
        return max(cands, key=lambda s: s.last_activity or 0).name
    return next((s.name for s in sessoes if s.name == alvo), None)
