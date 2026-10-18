// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, expect, it, vi } from 'vitest';
import { LastErrorSection } from './LastErrorSection';
import * as m from '../../paraglide/messages';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const state = vi.hoisted(() => ({ saved: undefined as string | undefined, copy: vi.fn(), share: vi.fn(), error: vi.fn(), ok: vi.fn() }));
vi.mock('../../stores/prefs', () => ({ prefs: { getString: () => state.saved } }));
vi.mock('expo-clipboard', () => ({ setStringAsync: state.copy }));
vi.mock('react-native', async original => ({ ...await original<typeof import('react-native')>(), Share: { share: state.share } }));
vi.mock('../../ui/Toast', () => ({ toast: { erro: state.error, ok: state.ok } }));
vi.mock('../../ui/Icon', () => ({ Icon: () => null }));
const report = { timestamp: '2026-10-18T10:26:00Z', name: 'TypeError', message: 'Cannot read property of undefined',
  route: '/s/[server]/[name]/activity', stack: 'SubagentLive@main.jsbundle:1:99', componentStack: 'Activity@main.jsbundle:1:80',
  metadata: { platform: 'ios', runtime: 'native-2', updateId: 'ota-one' } };
beforeEach(() => { state.saved = undefined; vi.clearAllMocks(); state.copy.mockResolvedValue(undefined); state.share.mockResolvedValue({ action: 'sharedAction' }); });

async function mount() {
  const node = document.createElement('div');
  const root = createRoot(node);
  await act(async () => root.render(createElement(LastErrorSection)));
  return { node, close: () => act(async () => root.unmount()) };
}

it('mostra ausência de erro sem oferecer exportação vazia', async () => {
  const page = await mount();
  try {
    expect(page.node.textContent).toContain(m.native_last_error_empty());
    expect(page.node.querySelector('button')).toBeNull();
  } finally { await page.close(); }
});

it('reabre relatório salvo, mostra mensagem/rota/pilha e copia ou compartilha o mesmo conteúdo', async () => {
  state.saved = JSON.stringify({ report, pending: true });
  const page = await mount();
  try {
    for (const text of [report.message, report.route, report.stack, 'ota-one']) expect(page.node.textContent).toContain(text);
    await act(async () => page.node.querySelector<HTMLButtonElement>(`button[aria-label="${m.native_last_error_copy()}"]`)!.click());
    const copied = state.copy.mock.calls[0][0];
    expect(JSON.parse(copied)).toEqual(report);
    await act(async () => page.node.querySelector<HTMLButtonElement>(`button[aria-label="${m.native_last_error_export()}"]`)!.click());
    expect(state.share).toHaveBeenCalledWith({ message: copied });
  } finally { await page.close(); }
});

it('mostra falha ao ler registro corrompido em vez de dizer que não houve erro', async () => {
  state.saved = '{invalid';
  const page = await mount();
  try {
    expect(page.node.textContent).toContain(m.native_last_error_read_failed());
    expect(page.node.textContent).not.toContain(m.native_last_error_empty());
  } finally { await page.close(); }
});

it('informa falha de cópia e exportação sem anunciar sucesso', async () => {
  state.saved = JSON.stringify({ report, pending: false });
  state.copy.mockRejectedValue(Error('clipboard-denied'));
  state.share.mockRejectedValue(Error('share-denied'));
  const page = await mount();
  try {
    for (const label of [m.native_last_error_copy(), m.native_last_error_export()]) {
      await act(async () => page.node.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!.click());
    }
    expect(state.error.mock.calls.map(call => call[0])).toEqual([m.native_last_error_copy_failed(), m.native_last_error_export_failed()]);
    expect(state.ok).not.toHaveBeenCalled();
  } finally { await page.close(); }
});
