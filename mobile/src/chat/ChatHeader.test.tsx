// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as m from '../paraglide/messages';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock('expo-router', () => ({ useLocalSearchParams: () => ({ server: 'casa' }) }));
vi.mock('../features/voice/LiveVoiceChatButton', () => ({ LiveVoiceChatButton: () => null }));
vi.mock('../stores/sessions', () => ({ useSessions: (pick: (s: { rows: never[] }) => unknown) => pick({ rows: [] }) }));
vi.mock('../stores/servers', () => ({ useServers: (pick: (s: { servers: never[] }) => unknown) => pick({ servers: [] }) }));

const { ChatHeader } = await import('./ChatHeader');

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const render = (onHome?: () => void) => act(() => root.render(createElement(ChatHeader, {
  name: 'mobile-menu', state: 'idle', onBack: vi.fn(), onMore: vi.fn(), onTitlePress: vi.fn(), onHome,
})));
const homeButton = () => host.querySelector(`[aria-label="${m.chat_ir_inicio()}"]`) as HTMLElement | null;

it('mostra a casa ao lado do voltar e leva ao Início', () => {
  const onHome = vi.fn();
  render(onHome);
  act(() => homeButton()!.click());
  expect(onHome).toHaveBeenCalledTimes(1);
});

it('sem destino de Início, não ocupa espaço no cabeçalho', () => {
  render();
  expect(homeButton()).toBeNull();
});
