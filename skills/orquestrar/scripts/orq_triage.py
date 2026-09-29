"""orq_triage — the regex that lets an unmarked message skip the arbiter when no Jev is configured.

Drops only a short status line with no veto; anything else wakes. The patterns were measured on
labeled arbiter messages: changing one means running backend/tests/test_orq_triage.py against the
labeled set again. Stdlib only.
"""
from __future__ import annotations

import re

# Status lines that need no arbiter, by category.
STATUS = {
 "janela": r"\bjanela( de prova)?( d[ao] [\w-]+)?( \(rodada \d+\))?:? (\w+ )?(abert|fechad|encerrad|reabert)|\bjanela fechada|abrindo (agora )?a (janela|tela)|abri a tela|tela aberta",
 "acordou": r"^\W*(\[[^\]]+\]\s*)?(acordei|acordado|wake-up ok|assumi)",
 "entrega": r"\b(entregue|entrega r\w+ rodada|rodada \d+ entregue|report(e)? (r\d+ )?pronto|reporte:)|\|\s*round:\s*\d|^task:\s*\w+\s*\|\s*hash",
 "veredito": r"\b(aprova|reprova)\b",
 "ack": r"\back\b|\brecebid[oa]\b|\blid[oa]\b",
}
VETO = [
 r"\w\?(\s|$)|\?\s*$",                                   # a question
 r"\bpe[çc]o\b|\bposso\b|\bpode\?|preciso de|\bpeço\b",
 r"\b(aguardo|espero|aguardando)\b(?![^.\n]{0,30}\b(veredito|parecer|revisor(?! que)|a revis))",  # waiting, unless only for the verdict
 r"\bconfirma\?|\bconfirma\s*$",
 r"decis[ãa]o (tua|sua|do usu|de custo)|(tua|sua) decis|voc[êe] decide|\bdecide\b|\b[a-c]\s*/\s*[a-c]\b|op[çc][õo]es\s+[a-c]|proposta|recomendo|sem obje[çc][ãa]o",
 r"^\W*(\[[^\]]+\]\s*)?(\S+\s+)?(parei|parado|pare)\b|\bPAREI\b|\bPARADO\b|\bPARE\b|\bparada de\b",
 r"bloqueado (em|por|:)|estou bloquead|\bblocked\b|travad|n[ãa]o consig|n[ãa]o sei\b",
 r"\bcrash|\b40[13]\b|recusad[oa] pelo|diverg[êe]ncia|premissa|anomal|desvio|fora do combinado|n[ãa]o fui eu",
 r"sucessor|substitu|passagem|handover|n[ãa]o est[áa] viv|n[ãa]o aparece|n[ãa]o cabe|\+\d+\s*a[çc]",
 r"\bdisco\b|\bM livres\b|abaixo dos \d+M",
 r"usu[áa]rio",
 r"\[decis|\bA\)\s[^\n]*\bB\)",
 r"(?<!\b0 )\bNOTED\b|para ti\b|\b[ée] teu\b|\b[ée] tua\b",
 r"\bcontexto\b|\bctx\s*\d{2}\s*%|\b\d{3}k\s*/\s*\d{3}k\b",
 r"\bachei\b|\bcorrigi\b|n[ãa]o (foi |foram )?(compilad|rodad|rodou|rodaram|despachad|executad|executei|provad)|offline|fica com o lote",
 r"decid(ed|ido|i) (alone|sozinho)|merge commit|conflit|conflict|hook rejected|rejeit|recus",
 r"aposent|[úu]ltima entrega|\bretiro\b|replanej|contrato exige|\badiad|te aviso|limite de prova|(tua|sua) pergunta",
 r"^\W*defeito\b|defeito (achado|anterior)|pr[ée]-existente|fora do escopo|diff --git",
 r"fase 4|revis[ãa]o (final|da branch)|revisao-final|aprovada no conjunto",
 r"reprova[^.\n]{0,60}\b(recebida|lida)\b|\b(recebida|lida)[^.\n]{0,20}reprova",
 r"\(\s*(5\d|[6-9]\d)(\.\d)?\s*%\s*\)|\b(5\d\d|[6-9]\d\d)k\s*/\s*1M",
 r"nomea|nomeia|nomear|\blibera(r|ç)|kick-?off|despacho|reincid|noted \d+ [ée] (teu|seu|decis)|pend[êe]ncia pra (voc|ti)",
 r"^\W*(\[[^\]]+\]\s*)?task:\s*\w+\s*(\([^)]*\))?\s*\|\s*hash\b[^\n]*\|\s*rounds|\bcommit (da r\w+ )?feito\b|\br\w+ commitada\b|commit[^.\n]{0,40}sem push",
]
VETO_RX = re.compile("|".join(VETO), re.I | re.M)
STATUS_RX = {k: re.compile(v, re.I | re.M) for k, v in STATUS.items()}

MAX_LEN = 600  # a long report carries its deviation in the middle; it arrives as an event anyway


def decide(text: str) -> tuple[str, str | None]:
    """("drop", category) or ("wake", None)."""
    if len(text) > MAX_LEN:
        return "wake", None
    if VETO_RX.search(text):
        return "wake", None
    for k, rx in STATUS_RX.items():
        if rx.search(text):
            return "drop", k
    return "wake", None
