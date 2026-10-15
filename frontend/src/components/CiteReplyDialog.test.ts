// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import type { QuoteRef } from '@hangar/core';
import CiteReplyDialog from './CiteReplyDialog.svelte';
import { citeDialog } from '../lib/citeDialog.svelte';
import { contextRefsDraft } from '../lib/contextRefsDraft.svelte';
import * as m from '../paraglide/messages';

const KEY = 'srv::sess';
const ref: QuoteRef = { kind: 'quote', source: 'ev-1', before: '', after: '', text: 'pergunta **3**', comment: '' };

function mountDialog(onFinish = vi.fn()) {
  const target = document.createElement('div');
  document.body.appendChild(target);
  const comp = mount(CiteReplyDialog, { target, props: { onFinish } });
  return { comp, onFinish };
}

const buttonNamed = (label: string) =>
  [...document.body.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === label)!;

function typeComment(value: string) {
  const field = document.body.querySelector<HTMLTextAreaElement>('.cr-campo')!;
  field.value = value;
  field.dispatchEvent(new Event('input', { bubbles: true }));
  flushSync();
}

afterEach(() => {
  citeDialog.close();
  for (let i = contextRefsDraft.get(KEY).length - 1; i >= 0; i--) contextRefsDraft.remove(KEY, i);
});

describe('CiteReplyDialog', () => {
  it('mostra o trecho e "Comentar e continuar" põe na bandeja com o comentário, sem finalizar', async () => {
    const { comp, onFinish } = mountDialog();
    citeDialog.open(KEY, ref);
    flushSync();
    await tick();
    expect(document.body.textContent).toContain(m.cite_reply_title());
    expect(document.body.querySelector('.cr-trecho strong')?.textContent).toBe('3');
    typeComment('  minha resposta  ');
    buttonNamed(m.cite_comment_continue()).click();
    flushSync();
    expect(contextRefsDraft.get(KEY)).toEqual([{ ...ref, comment: 'minha resposta', draftId: expect.any(String) }]);
    expect(citeDialog.request).toBeNull();
    expect(onFinish).not.toHaveBeenCalled();
    unmount(comp);
  });

  it('Finalizar adiciona e avisa; Cancelar fecha sem adicionar', async () => {
    const { comp, onFinish } = mountDialog();
    citeDialog.open(KEY, ref);
    flushSync();
    await tick();
    buttonNamed(m.cite_finish()).click();
    flushSync();
    expect(contextRefsDraft.get(KEY)).toHaveLength(1);
    expect(onFinish).toHaveBeenCalledOnce();
    citeDialog.open(KEY, ref);
    flushSync();
    await tick();
    buttonNamed(m.comum_cancelar()).click();
    flushSync();
    expect(contextRefsDraft.get(KEY)).toHaveLength(1);
    expect(citeDialog.request).toBeNull();
    unmount(comp);
  });

  it('Ctrl+Enter finaliza; Shift+Enter não adiciona', async () => {
    const { comp, onFinish } = mountDialog();
    citeDialog.open(KEY, ref);
    flushSync();
    await tick();
    const field = document.body.querySelector<HTMLTextAreaElement>('.cr-campo')!;
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }));
    flushSync();
    expect(contextRefsDraft.get(KEY)).toHaveLength(0);
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
    flushSync();
    expect(contextRefsDraft.get(KEY)).toHaveLength(1);
    expect(onFinish).toHaveBeenCalledOnce();
    unmount(comp);
  });
});
