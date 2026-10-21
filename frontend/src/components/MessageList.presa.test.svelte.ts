// @vitest-environment happy-dom
// Mensagem parada na fila com o processo sem terminal vivo e surdo: o servidor não reabre sozinho,
// então a bolha diz que não foi entregue e oferece o Reabrir enquanto o aviso estiver ativo.
import { expect, it, vi } from 'vitest';
import { mount, tick, unmount } from 'svelte';
import type { ChatEvent, StateEvent } from '@hangar/core';
import MessageList from './MessageList.svelte';
import * as m from '../paraglide/messages';

const presa = (delivered: boolean): ChatEvent =>
  ({ kind: 'user_msg', id: 'queued-a', text: 'oi', queued_delivered: delivered }) as ChatEvent;

function montar(problema: string | null, events: ChatEvent[], onReabrirPresa?: () => Promise<void>) {
  const target = document.createElement('div');
  document.body.appendChild(target);
  const props = $state({
    events, pending: [], sessionName: 's', dockH: 0,
    stateEvent: { session: 's', state: 'working', problema } as StateEvent,
    onSelectOption: () => {}, onCancel: () => {}, onReabrirPresa,
  });
  const comp = mount(MessageList, { target, props });
  const botao = () => [...target.querySelectorAll('button')].find(b => b.textContent?.trim() === m.reabrir_sessao_presa());
  return { target, props, botao, fim: () => unmount(comp) };
}

it('com o aviso ativo a bolha presa diz que não foi entregue e o Reabrir fica travado até o pedido voltar', async () => {
  let soltar!: () => void;
  const onReabrirPresa = vi.fn(() => new Promise<void>(r => { soltar = r; }));
  const { target, props, botao, fim } = montar('headless_delivery_stalled', [presa(false)], onReabrirPresa);
  try {
    await tick();
    expect(target.textContent).toContain(m.problema_headless_delivery_stalled());
    botao()!.click();
    await tick();
    expect(onReabrirPresa).toHaveBeenCalledOnce();
    expect(botao()!.disabled).toBe(true);
    botao()!.click();
    expect(onReabrirPresa).toHaveBeenCalledOnce();
    soltar();
    await new Promise(r => setTimeout(r, 0));
    expect(botao()!.disabled).toBe(false);
    props.stateEvent = { session: 's', state: 'working', problema: null } as StateEvent;
    await tick();
    expect(botao()).toBeUndefined();
    expect(target.textContent).not.toContain(m.problema_headless_delivery_stalled());
  } finally { fim(); }
});

it('sem o aviso, ou com a mensagem já entregue, não há nota nem Reabrir', async () => {
  for (const [problema, ev] of [[null, presa(false)], ['headless_delivery_stalled', presa(true)]] as const) {
    const { target, botao, fim } = montar(problema, [ev], async () => {});
    try {
      await tick();
      expect(botao()).toBeUndefined();
      expect(target.textContent).not.toContain(m.problema_headless_delivery_stalled());
    } finally { fim(); }
  }
});
