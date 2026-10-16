import { CONTEXT_REF_AFFIX, MARKDOWN_IGNORED, locateQuote, stripMarkdownMarks, type QuoteRef } from '@hangar/core';

// Seleção do navegador -> dados da citação, e o caminho de volta (achar o trecho na bolha de origem).
// A raiz de cada resposta citável é o `.prose` com `data-cite-source` (AssistantBubble fora da prévia).

export interface CapturedQuote {
  source: string;
  text: string;
  before: string;
  after: string;
}

/** A seleção inteira dentro de UMA resposta citável; `null` em qualquer outro caso. */
export function captureQuote(sel: Selection | null): CapturedQuote | null {
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
  const range = sel.getRangeAt(0);
  const last = sel.getRangeAt(sel.rangeCount - 1);
  const node = range.commonAncestorContainer;
  const el = node instanceof Element ? node : node.parentElement;
  const root = el?.closest<HTMLElement>('[data-cite-source]');
  if (!root || !root.contains(last.endContainer)) return null;
  const source = root.dataset.citeSource ?? '';
  const text = sel.toString();
  if (!source || !text.trim()) return null;
  const pre = document.createRange();
  pre.selectNodeContents(root);
  pre.setEnd(range.startContainer, range.startOffset);
  const post = document.createRange();
  post.selectNodeContents(root);
  post.setStart(last.endContainer, last.endOffset);
  // Só uma folga em volta do trecho: o corte exato em code points é do `buildQuoteRef`, e o dobro em
  // unidades UTF-16 sempre cobre os code points dele.
  return {
    source,
    text,
    before: pre.toString().slice(-2 * CONTEXT_REF_AFFIX),
    after: post.toString().slice(0, 2 * CONTEXT_REF_AFFIX),
  };
}

// Espaços e marcadores de Markdown fora da comparação: o DOM não tem os `**` que a citação feita no
// app nativo traz (ele cita a fonte), e a seleção do navegador quebra linha onde o DOM não tem `\n`.
/** Faixa do trecho dentro de `root`, ou `null` quando ele não está mais lá. */
export function findQuoteRange(root: HTMLElement, ref: QuoteRef): Range | null {
  const nodes: Text[] = [];
  const offsets: number[] = [];
  let hay = '';
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
    const t = n.data;
    for (let i = 0; i < t.length; i++) {
      if (MARKDOWN_IGNORED.test(t[i])) continue;
      hay += t[i];
      nodes.push(n);
      offsets.push(i);
    }
  }
  const needle = stripMarkdownMarks(ref.text);
  const at = locateQuote(hay, needle, stripMarkdownMarks(ref.before), stripMarkdownMarks(ref.after));
  if (at < 0 || !needle) return null;
  const end = at + needle.length - 1;
  const range = document.createRange();
  range.setStart(nodes[at], offsets[at]);
  range.setEnd(nodes[end], offsets[end] + 1);
  return range;
}

type HighlightsApi = { set(name: string, h: unknown): void; delete(name: string): void };
let clearTimer: ReturnType<typeof setTimeout> | undefined;

/** Realça a faixa do trecho (`findQuoteRange`) por uns segundos. Sem a API de realce do CSS, pisca a bolha. */
export function flashQuote(root: HTMLElement, range: Range): void {
  const highlights = (globalThis.CSS as unknown as { highlights?: HighlightsApi } | undefined)?.highlights;
  const Ctor = (globalThis as unknown as { Highlight?: new (...r: Range[]) => unknown }).Highlight;
  clearTimeout(clearTimer);
  if (highlights && Ctor) {
    highlights.set('cite-jump', new Ctor(range));
    clearTimer = setTimeout(() => highlights.delete('cite-jump'), 2500);
    return;
  }
  root.classList.remove('cite-flash');
  void root.offsetWidth;
  root.classList.add('cite-flash');
  clearTimer = setTimeout(() => root.classList.remove('cite-flash'), 2500);
}
