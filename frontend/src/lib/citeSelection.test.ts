// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import type { QuoteRef } from '@hangar/core';
import { captureQuote, findQuoteRange } from './citeSelection';

function prosa(html: string, source = 'ev-1'): HTMLElement {
  const el = document.createElement('div');
  el.className = 'prose';
  el.dataset.citeSource = source;
  el.innerHTML = html;
  document.body.appendChild(el);
  return el;
}

const ref = (text: string, before = '', after = ''): QuoteRef => ({ kind: 'quote', source: 'ev-1', before, after, text, comment: '' });

describe('findQuoteRange', () => {
  it('acha o trecho atravessando elementos e ignorando os marcadores do Markdown', () => {
    const el = prosa('<p>o cache é guardado por <strong>sessão</strong> e expira.</p>');
    const r = findQuoteRange(el, ref('guardado por **sessão**'));
    expect(r?.toString()).toBe('guardado por sessão');
  });

  it('desempata pela vizinhança', () => {
    const el = prosa('<p>valor 10 no início</p><p>depois o valor 10 de novo</p>');
    const r = findQuoteRange(el, ref('valor 10', 'depois o ', ' de novo'));
    expect(r?.startContainer.parentElement?.textContent).toBe('depois o valor 10 de novo');
  });

  it('trecho que não existe mais devolve null', () => {
    const el = prosa('<p>outra coisa</p>');
    expect(findQuoteRange(el, ref('sumiu'))).toBeNull();
  });
});

describe('captureQuote', () => {
  it('pega texto, origem e vizinhança de uma seleção dentro de uma resposta', () => {
    const el = prosa('<p>antes TRECHO depois</p>', 'abc:1');
    const texto = el.querySelector('p')!.firstChild as Text;
    const sel = document.getSelection()!;
    const range = document.createRange();
    range.setStart(texto, 6);
    range.setEnd(texto, 12);
    sel.removeAllRanges();
    sel.addRange(range);
    expect(captureQuote(sel)).toEqual({ source: 'abc:1', text: 'TRECHO', before: 'antes ', after: ' depois' });
  });

  it('seleção fora de resposta citável não vale', () => {
    const p = document.createElement('p');
    p.textContent = 'campo qualquer';
    document.body.appendChild(p);
    const sel = document.getSelection()!;
    const range = document.createRange();
    range.selectNodeContents(p);
    sel.removeAllRanges();
    sel.addRange(range);
    expect(captureQuote(sel)).toBeNull();
  });
});
