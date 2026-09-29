// @vitest-environment happy-dom
// Quadro e canvas usam o mesmo card: o do orquestrador sem LLM não tem campo de digitar (não há
// modelo para ler) e o botão leva à sessão do árbitro. Card comum mantém o campo.
import { describe, it, expect, vi } from 'vitest';
import { mount, unmount, tick } from 'svelte';
import BoardCard from './BoardCard.svelte';
import * as m from '../paraglide/messages';
import type { BoardRow } from '../screens/Board.svelte';

vi.mock('@hangar/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@hangar/core')>()),
  getHistoryTailCached: vi.fn(async () => ({ evs: [], at: 0 })),
  getHistoryTailForServer: vi.fn(async () => []),
  fetchCotacao: vi.fn(async () => null),
}));

function montar(over: Partial<BoardRow>) {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const onOpenArbiter = vi.fn();
  const comp = mount(BoardCard, {
    target: el,
    props: {
      session: { name: 'g1-orq', serverId: 'srv', state: 'idle', ...over } as BoardRow,
      server: { id: 'srv', label: 'S', baseUrl: 'http://x', token: 't' },
      color: '#fff',
      draft: '',
      onDraftChange: vi.fn(),
      pending: [],
      updatePending: vi.fn(),
      sendError: '',
      onSendError: vi.fn(),
      onOpen: vi.fn(),
      onOpenArbiter,
    },
  });
  return { el, comp, onOpenArbiter };
}

describe('BoardCard: orquestrador sem LLM', () => {
  it('sem campo de digitar; o botão abre o árbitro', async () => {
    const { el, comp, onOpenArbiter } = montar({ provider: 'orq', orq_arbiter: 'arb' });
    await tick();
    expect(el.querySelector('textarea')).toBeNull();
    const btn = el.querySelector<HTMLButtonElement>('.bc-arbiter');
    expect(btn?.textContent?.trim()).toBe(m.orq_talk_to_arbiter());
    btn!.click();
    expect(onOpenArbiter).toHaveBeenCalledWith('arb');
    unmount(comp);
  });

  it('sem glifo de provider: não roda agente', async () => {
    const { el, comp } = montar({ provider: 'orq', orq_arbiter: 'arb' });
    await tick();
    expect(el.querySelector('.prov-chip')).toBeNull();
    unmount(comp);
  });

  it('sem árbitro registrado o botão fica desligado', async () => {
    const { el, comp } = montar({ provider: 'orq', orq_arbiter: null });
    await tick();
    expect(el.querySelector<HTMLButtonElement>('.bc-arbiter')?.disabled).toBe(true);
    unmount(comp);
  });

  it('card comum mantém o campo e não tem o botão', async () => {
    const { el, comp } = montar({ name: 's1', provider: 'claude' });
    await tick();
    expect(el.querySelector('textarea')).not.toBeNull();
    expect(el.querySelector('.bc-arbiter')).toBeNull();
    unmount(comp);
  });
});
