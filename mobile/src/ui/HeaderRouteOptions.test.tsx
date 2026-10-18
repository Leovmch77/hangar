// @vitest-environment happy-dom
import { act, createElement, useLayoutEffect, type ComponentType, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const boundary = vi.hoisted(() => ({
  params: { server: 'machine', name: 'conversation' }, canGoBack: false, title: 'fixture-title',
  publish: vi.fn(), replace: vi.fn(), back: vi.fn(),
}));
vi.mock('expo-router', () => {
  const router = { replace: boundary.replace, back: boundary.back, canGoBack: () => boundary.canGoBack };
  return {
    useRouter: () => router,
    useLocalSearchParams: () => ({ ...boundary.params }),
    Stack: { Screen: ({ options }: { options: Options }) => {
      useLayoutEffect(() => { boundary.publish(options); }, [options]);
      return null;
    } },
  };
});
vi.mock('react-native-unistyles', async original => {
  const actual = await original<typeof import('react-native-unistyles')>();
  return { ...actual, useUnistyles: () => {
    const value = actual.useUnistyles();
    return { ...value, theme: new Proxy(value.theme, {}) };
  } };
});
vi.mock('expo-router/react-navigation', () => ({ useHeaderHeight: () => 64 }));
vi.mock('../stores/servers', () => ({ useServers: (selector: (value: unknown) => unknown) => selector({
  ready: true, servers: [{ id: boundary.params.server, label: 'fixture-machine', baseUrl: 'https://machine.test', token: 'fixture-token' }],
}) }));
vi.mock('../paraglide/messages', () => ({
  comum_voltar: () => 'fixture-back',
  accounts_switch_title: () => boundary.title,
  sessao_git: () => boundary.title,
  compartilhar_titulo: ({ nome }: { nome: string }) => `${boundary.title}:${nome}`,
  orqcfg_aba_papeis: () => boundary.title,
}));
vi.mock('../chat/SessionAccount', () => ({ SessionAccount: () => null }));
vi.mock('../features/git/GitPanel', () => ({ GitPanel: () => null }));
vi.mock('../features/share/SharePanel', () => ({ SharePanel: () => null }));
vi.mock('../features/orchestration/OrchestrationTeam', () => ({ OrchestrationTeam: () => null }));
vi.mock('./Glass', () => ({ Glass: () => null }));
vi.mock('./Icon', () => ({ Icon: () => null }));
vi.mock('./Screen', () => ({ Screen: ({ children }: { children: ReactNode }) => children }));
vi.mock('react-native-keyboard-controller', () => ({ KeyboardAvoidingView: ({ children }: { children: ReactNode }) => children }));

import GitRoute from '../../app/s/[server]/[name]/git';
import ShareRoute from '../../app/s/[server]/[name]/share';
import OrchestrationTeamRoute from '../../app/s/[server]/[name]/orchestration-team';

type Options = { title: string; headerLeft?: () => ReactNode };
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.clearAllMocks();
  boundary.params = { server: 'machine', name: 'conversation' };
  boundary.canGoBack = false;
  boundary.title = 'fixture-title';
  container = document.createElement('div');
  root = createRoot(container);
});
afterEach(() => act(() => root.unmount()));
const render = (Route: ComponentType) => act(async () => root.render(createElement(Route)));
const options = () => boundary.publish.mock.calls.at(-1)![0] as Options;

it.each([
  ['git', GitRoute], ['share', ShareRoute], ['team', OrchestrationTeamRoute],
] as const)('%s conserva as opções entre renders e atualiza o título', async (_name, Route) => {
  await render(Route);
  const initial = options();
  await render(Route);
  expect(boundary.publish).toHaveBeenCalledTimes(1);
  expect(options()).toBe(initial);
  boundary.title = 'changed-title';
  await render(Route);
  expect(boundary.publish).toHaveBeenCalledTimes(2);
  expect(options().title).toContain('changed-title');
});

it.each([
  ['git', GitRoute], ['share', ShareRoute],
] as const)('%s atualiza o voltar com o histórico e a conversa atual', async (name, Route) => {
  await render(Route);
  expect(options().headerLeft).toBeTypeOf('function');
  boundary.canGoBack = true;
  await render(Route);
  expect(options().headerLeft).toBeUndefined();
  boundary.canGoBack = false;
  boundary.params = { server: 'next machine', name: 'next/conversation' };
  await render(Route);
  const Header = options().headerLeft!;
  await act(async () => root.render(createElement(Header)));
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="fixture-back"]')!.click());
  expect(boundary.replace).toHaveBeenLastCalledWith(name === 'share' ? '/' : '/s/next%20machine/next%2Fconversation');
});
