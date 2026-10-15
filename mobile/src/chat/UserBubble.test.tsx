// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import * as m from '../paraglide/messages';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async (original) => ({
  ...await original<object>(),
  Pressable: ({ onLongPress, children }: { onLongPress?: () => void; children: ReactNode }) =>
    createElement('button', { onClick: onLongPress }, children),
}));
vi.mock('../stores/servers', () => ({ useServers: (select: (state: unknown) => unknown) => select({ servers: [
  { id: 'route', baseUrl: 'http://route.test', token: 'fixture' },
] }) }));
vi.mock('./ImageThumb', () => ({ ImageThumb: ({ items }: { items: { uri: string }[] }) =>
  createElement('span', { 'data-images': items.map((item) => item.uri).join(',') }) }));
vi.mock('./BubbleActions', () => ({ BubbleActions: ({ text }: { text: string }) =>
  createElement('output', null, text) }));

import { UserBubble } from './UserBubble';

async function render(text: string) {
  const container = document.createElement('div');
  const root = createRoot(container);
  await act(async () => root.render(createElement(UserBubble, { text, serverId: 'route', sessionName: 'sess' })));
  return { container, root };
}

describe('recados na bolha', () => {
  it.each([
    ['[de: agente] corpo', () => m.board_peer_de({ n: 'agente' })],
    ['[grupo: agente] corpo', () => m.board_peer_grupo({ n: 'agente' })],
    ['[de fora: maquina::agente] corpo', () => m.board_peer_fora({ n: 'maquina::agente' })],
    ['[painel: tarefa] corpo', () => m.board_peer_painel({ n: 'tarefa' })],
  ] as const)('separa remetente e corpo: %s', async (raw, label) => {
    const { container, root } = await render(raw);
    expect(container.textContent).toBe(`${label()}corpo`);
    act(() => container.querySelector('button')!.click());
    expect(container.querySelector('output')!.textContent).toBe('corpo');
    expect(raw).toContain('] corpo');
    act(() => root.unmount());
  });

  it('conserva mensagem normal e prefixo inválido', async () => {
    const raw = '[grupo fora: agente] corpo';
    const { container, root } = await render(raw);
    expect(container.textContent).toBe(raw);
    act(() => root.unmount());
  });

  it('limpa o remetente da legenda sem perder a imagem do servidor da rota', async () => {
    const { container, root } = await render('[de: agente] corpo — 📎 imagem: /up/a.png');
    expect(container.textContent).toBe(`${m.board_peer_de({ n: 'agente' })}corpo`);
    expect(container.querySelector('[data-images]')!.getAttribute('data-images')).toContain('http://route.test/');
    expect(container.querySelector('[data-images]')!.getAttribute('data-images')).toContain('a.png');
    act(() => root.unmount());
  });
});
