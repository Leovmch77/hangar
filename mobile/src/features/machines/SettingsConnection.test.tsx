// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerBucket } from '@hangar/core';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async (original) => {
  const native = await original<typeof import('react-native')>();
  return {
    ...native,
    View: ({ accessibilityElementsHidden, importantForAccessibility, accessible, ...props }: React.ComponentProps<typeof native.View>) =>
      React.createElement(native.View, props),
    Pressable: ({ hitSlop, accessibilityHint, ...props }: React.ComponentProps<typeof native.Pressable>) =>
      React.createElement(native.Pressable, props),
    ScrollView: ({ stickyHeaderIndices, contentInsetAdjustmentBehavior, contentContainerStyle, keyboardShouldPersistTaps, ...props }: React.ComponentProps<typeof native.ScrollView>) =>
      React.createElement(native.ScrollView, props),
    TextInput: ({ value, onChangeText, accessibilityLabel, placeholder }: React.ComponentProps<typeof native.TextInput>) =>
      React.createElement('input', { value, placeholder, 'aria-label': accessibilityLabel, onChange: (event: React.ChangeEvent<HTMLInputElement>) => onChangeText?.(event.currentTarget.value) }),
  };
});
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('expo-router/react-navigation', () => ({ useHeaderHeight: () => 0 }));
vi.mock('@react-native-menu/menu', () => ({ MenuView: ({ children }: { children: React.ReactNode }) => children }));
vi.mock('expo-secure-store', () => ({ getItemAsync: vi.fn(), setItemAsync: vi.fn() }));
vi.mock('expo-blur', async () => ({ BlurTargetView: (await import('react-native')).View }));
vi.mock('expo-linear-gradient', async () => ({ LinearGradient: (await import('react-native')).View }));
vi.mock('expo-file-system', () => ({ Directory: class {}, File: class {}, Paths: { cache: '/tmp' } }));
vi.mock('sonner-native', () => ({ toast: { error: vi.fn(), success: vi.fn() }, Toaster: () => null }));
vi.mock('../../stores/aparencia', async () => {
  const { create } = await import('zustand');
  return { useAparencia: create(() => ({ fundo: 'flat', imagemUri: null, efeito: 'none', efeitoImagem: null, efeitoProcessando: false })) };
});

import ConfigIndex from '../../../app/config';
import { useServers } from '../../stores/servers';
import { useSessions } from '../../stores/sessions';

const active = { id: 'settings-active', label: 'fixture-active', baseUrl: 'https://active.test', token: 'token-active' };
const other = { id: 'settings-other', label: 'fixture-other', baseUrl: 'https://other.test', token: 'token-other' };
let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  useServers.setState({ servers: [active, other], activeId: active.id, ready: true });
  useSessions.setState({ byServer: [] });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe('conexão do servidor nas configurações', () => {
  it.each([
    { name: 'lista carregada, mesmo sem sessões', bucket: { loaded: true, error: null }, label: 'fixture-active, Connected', color: '#0a0' },
    { name: 'offline com lista antiga', bucket: { loaded: true, error: 'offline' }, label: 'fixture-active offline', color: '#f00' },
    { name: 'erro real com lista antiga', bucket: { loaded: true, error: 'HTTP 503' }, label: 'fixture-active, HTTP 503', color: '#f00' },
    { name: 'conexão ainda desconhecida', bucket: { loaded: false, error: null }, label: 'fixture-active', color: '#999' },
    { name: 'sem informação do servidor ativo', bucket: null, label: 'fixture-active', color: '#999' },
  ])('mostra $name no cabeçalho', async ({ bucket, label, color }) => {
    await act(async () => root.render(React.createElement(ConfigIndex)));
    await act(async () => {
      const byServer: ServerBucket[] = [{ server: other, sessions: [], loaded: true, error: 'offline' }];
      if (bucket) byServer.push({ server: active, sessions: [], ...bucket });
      useSessions.setState({ byServer });
    });

    const picker = [...container.querySelectorAll('button')].find((button) => button.textContent === active.label);
    expect.soft(picker?.getAttribute('aria-label')).toBe(label);
    const indicator = [...picker!.querySelectorAll('div')].find((element) => element.style.backgroundColor);
    expect(indicator?.style.backgroundColor).toBe(color);
  });
});
