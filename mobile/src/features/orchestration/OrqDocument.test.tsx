// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Linking } from 'react-native';
import { toast } from '../../ui/Toast';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { configureApi, _limparEsfriamentoParaTestes, type Server } from '@hangar/core';
import { useServers } from '../../stores/servers';
import * as m from '../../paraglide/messages';
import { OrqDocument } from './OrqDocument';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock('expo-secure-store', () => ({ setItemAsync: vi.fn().mockResolvedValue(undefined), getItemAsync: vi.fn().mockResolvedValue(null) }));
vi.mock('../../ui/Sheet', () => ({ Sheet: ({ children }: { children: ReactNode }) => createElement('section', null, children) }));
vi.mock('../../chat/AssistantBubble', () => ({ mkMarkdownStyle: () => ({ paragraph: {} }) }));
vi.mock('react-native-enriched-markdown', () => ({
  EnrichedMarkdownText: ({ markdown, onLinkPress }: { markdown: string; onLinkPress?: (event: { url: string }) => void }) =>
    createElement('article', { onClick: () => onLinkPress?.({ url: markdown.match(/\]\(([^)]+)\)/)?.[1] ?? '' }) }, markdown),
}));
vi.mock('../../ui/Toast', () => ({ toast: { erro: vi.fn() } }));

const server: Server = { id: 'b', label: 'machine-b', baseUrl: 'http://b:8765', token: 'token-b' };
let container: HTMLDivElement;
let root: Root;
let fetcher: ReturnType<typeof vi.fn>;
const onClose = vi.fn();
const path = '/outside/review.md';
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
const reply = (text: string) => new Response(JSON.stringify({ path, text, size: text.length, truncated: false, digest: 'digest' }));
const render = (requestedPath = path, serverId = server.id) => act(async () => root.render(createElement(OrqDocument, { serverId, name: 'orq-fixture', path: requestedPath, onClose })));
const click = (label: string) => act(async () => [...container.querySelectorAll<HTMLButtonElement>('button')].find(b => b.getAttribute('aria-label') === label)!.click());
beforeEach(() => {
  onClose.mockClear(); _limparEsfriamentoParaTestes();
  container = document.createElement('div'); root = createRoot(container);
  useServers.setState({ ready: true, servers: [server, { ...server, id: 'a', baseUrl: 'http://a:8765' }], activeId: 'a' });
  configureApi({ getBaseUrl: () => 'http://a:8765', getToken: () => 'token-a', onUnauthorized: vi.fn(), origin: null, createEventSource: vi.fn() });
  fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
});
afterEach(async () => { await act(async () => root.unmount()); _limparEsfriamentoParaTestes(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('documento citado lê fora do repo no servidor explícito, mostra Markdown e fecha', async () => {
  const pending = deferred<Response>(); fetcher.mockReturnValue(pending.promise);
  await render();
  expect(container.textContent).toContain(m.comum_carregando());
  expect(fetcher.mock.calls[0][0]).toBe('http://b:8765/api/sessions/orq-fixture/file/text?path=%2Foutside%2Freview.md');
  await act(async () => pending.resolve(reply('# reviewed')));
  expect(container.querySelector('article')?.textContent).toBe('# reviewed');
  await click(m.arq_fechar()); expect(onClose).toHaveBeenCalledOnce();
});

it('links do documento abrem só esquemas seguros e mostram falha', async () => {
  const openURL = vi.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
  vi.mocked(toast.erro).mockClear();
  let attempt = 0;
  const pressLink = async (url: string) => {
    fetcher.mockResolvedValueOnce(reply(`[review](${url})`));
    await render(`/outside/review-${attempt++}.md`);
    await act(async () => container.querySelector('article')!.click());
  };
  for (const url of ['http://example.test/review', 'HTTPS://example.test/review', 'mailto:review@example.test']) {
    await pressLink(url);
    expect(openURL).toHaveBeenLastCalledWith(url);
  }
  openURL.mockClear();
  for (const url of ['app://session', 'javascript:void', 'file:///review.md']) await pressLink(url);
  expect(openURL).not.toHaveBeenCalled();
  expect(toast.erro).not.toHaveBeenCalled();
  openURL.mockRejectedValueOnce(new Error('open-link-failed'));
  await pressLink('https://example.test/review');
  expect(toast.erro).toHaveBeenCalledExactlyOnceWith('open-link-failed');
});

it('documento citado descarta resposta antiga, oferece retry e avisa servidor removido', async () => {
  const old = deferred<Response>(); fetcher.mockReturnValueOnce(old.promise).mockRejectedValueOnce(new Error('read-failed'));
  await render(); await render('/outside/new.md');
  await act(async () => old.resolve(reply('old-content')));
  expect(container.textContent).not.toContain('old-content');
  expect(container.textContent).toContain('read-failed');
  fetcher.mockResolvedValueOnce(reply('new-content'));
  await click(m.orq_panel_retry());
  expect(container.querySelector('article')?.textContent).toBe('new-content');
  await act(async () => useServers.setState({ servers: [] }));
  expect(container.textContent).toContain(m.chat_servidor_removido());
  expect(container.textContent).not.toContain('new-content');
  expect(fetcher).toHaveBeenCalledTimes(3);
});

it('documento citado não consulta API do dono num convite', async () => {
  useServers.setState({ servers: [{ ...server, invite: true }] });
  await render();
  expect(container.textContent).toContain(m.lista_acesso_recusado());
  expect(fetcher).not.toHaveBeenCalled();
});

it('documento vazio informa ausência de texto e retry consulta após falha de rede', async () => {
  fetcher.mockRejectedValueOnce(new Error('network-failed')).mockResolvedValueOnce(reply(''));
  await render();
  expect(container.textContent).toContain('network-failed');
  await click(m.orq_panel_retry());
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(container.textContent).toContain(m.native_file_empty());
  expect(container.querySelector('article')).toBeNull();
});
