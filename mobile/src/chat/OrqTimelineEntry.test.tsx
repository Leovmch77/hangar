// @vitest-environment happy-dom
import { act, createElement, type ComponentProps, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Linking } from 'react-native';
import { toast } from '../ui/Toast';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { configureApi, configureLocale, type ChatEvent, type OrqDecidedBy, type OrqEntry, type OrqJev, type OrqLine } from '@hangar/core';
import { useServers } from '../stores/servers';
import { overwriteGetLocale } from '../paraglide/runtime';
import { OrqTimelineEntry } from './OrqTimelineEntry';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
overwriteGetLocale(() => 'pt');
configureLocale({ getLocale: () => 'pt' });
vi.mock('react-native-enriched-markdown', () => ({
  EnrichedMarkdownText: ({ markdown, onLinkPress }: { markdown: string; onLinkPress?: (event: { url: string }) => void }) =>
    createElement('div', { 'data-markdown': markdown, onClick: () => onLinkPress?.({ url: markdown.match(/\]\(([^)]+)\)/)?.[1] ?? '' }) }, markdown),
}));
vi.mock('../ui/Toast', () => ({ toast: { erro: vi.fn() } }));
vi.mock('./AssistantBubble', () => ({ mkMarkdownStyle: () => ({}) }));
vi.mock('../ui/Icon', () => ({ Icon: () => null }));
vi.mock('expo-secure-store', () => ({ setItemAsync: vi.fn().mockResolvedValue(undefined), getItemAsync: vi.fn().mockResolvedValue(null) }));
vi.mock('../ui/Sheet', () => ({ Sheet: ({ children }: { children: ReactNode }) => createElement('section', { role: 'dialog' }, children) }));
vi.mock('react-native', async (original) => {
  const actual = await original<typeof import('react-native')>();
  return { ...actual,
    Pressable: ({ accessibilityState, hitSlop: _hitSlop, ...props }: { accessibilityState?: { expanded?: boolean }; hitSlop?: unknown }) =>
      createElement(actual.Pressable, { ...props, 'aria-expanded': accessibilityState?.expanded }),
    ScrollView: ({ contentContainerStyle: _contentContainerStyle, ...props }: { contentContainerStyle?: unknown }) =>
      createElement(actual.ScrollView, props),
  };
});

const roots: Root[] = [];
afterEach(() => {
  act(() => { for (const root of roots.splice(0)) root.unmount(); });
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const entry = (patch: Partial<OrqEntry> = {}, event: Partial<ChatEvent> = {}): ChatEvent => ({
  id: 'orq-1', kind: 'notice', text: 'raw-notice',
  orq: { kind: 'advance', task: 3, line: null, origin: 'orchestrator', sender: null,
    mark: null, alarm: false, rejected_round: null, body: '', question: null,
    parecer: null, error: null, decided_by: null, ...patch }, ...event,
});
function show(event: ChatEvent, props: Partial<ComponentProps<typeof OrqTimelineEntry>> = {}) {
  const container = document.createElement('div');
  const root = createRoot(container);
  roots.push(root);
  const render = (next: ChatEvent) => act(() => root.render(createElement(OrqTimelineEntry, { event: next, ...props })));
  render(event);
  return { container, render };
}

const decided = (patch: Partial<OrqDecidedBy> = {}): OrqDecidedBy => ({
  source: 'jev', rule: null, jev: null, regex: null, regex_agreed: null, ...patch,
});
const jev = (patch: Partial<OrqJev> = {}): OrqJev => ({
  mode: 'on', choice: null, p: null, probs: {}, veto: {}, held: [], would_drop: null, error: null, ...patch,
});

describe('parecer citado', () => {
  it.each(['woke', 'advance'] as const)('toque de %s abre leitor Markdown no servidor da conversa e fecha', async (kind) => {
    const server = { id: 'a', label: 'machine-a', baseUrl: 'http://a:8765', token: 'token-a' };
    useServers.setState({ ready: true, servers: [server], activeId: 'a' });
    configureApi({ getBaseUrl: () => 'http://wrong:8765', getToken: () => 'wrong', onUnauthorized: vi.fn(), origin: null, createEventSource: vi.fn() });
    let resolve!: (response: Response) => void;
    const fetcher = vi.fn((_url: RequestInfo | URL, _init?: RequestInit) => new Promise<Response>((done) => { resolve = done; }));
    vi.stubGlobal('fetch', fetcher);
    const path = '/outside/review.md';
    const { container } = show(entry({ kind, parecer: path }), { serverId: 'a', sessionName: 'orq-fixture' });
    const button = [...container.querySelectorAll('button')].find((node) => node.textContent?.includes('Abrir parecer'));
    expect(button).toBeDefined();
    expect(button?.textContent).toContain('review.md');
    expect(fetcher).not.toHaveBeenCalled();
    act(() => button!.click());
    expect(container.querySelector('[role="dialog"]')?.textContent).toContain('Carregando');
    expect(fetcher.mock.calls[0][0]).toBe('http://a:8765/api/sessions/orq-fixture/file/text?path=%2Foutside%2Freview.md');
    await act(async () => resolve(new Response(JSON.stringify({ path, text: '# review-body', size: 13, digest: 'digest', truncated: false }))));
    expect(container.querySelector('[role="dialog"] [data-markdown]')?.getAttribute('data-markdown')).toBe('# review-body');
    const close = container.querySelector<HTMLButtonElement>('[aria-label="Fechar o arquivo"]');
    expect(close).not.toBeNull();
    act(() => close!.click());
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it.each([{}, { serverId: 'a' }, { sessionName: 'orq-fixture' }])('sem identidade completa não oferece abertura: %j', (identity) => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    const { container } = show(entry({ kind: 'woke', parecer: '/outside/review.md' }), identity);
    expect(container.textContent).toContain('review.md');
    expect(container.querySelector('button')).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('dia e hora locais', () => {
  it.each([
    [16, 'advance', 'hoje · 14:35'],
    [15, 'woke', 'ontem · 14:35'],
    [12, 'dropped', '12/10 · 14:35'],
  ] as const)('mostra separador do dia %s e hora de %s', (day, kind, label) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 9, 16, 18));
    const ts = new Date(2026, 9, day, 14, 35).getTime() / 1000;
    const { container } = show(entry({ kind }, { ts }), { dayTs: ts });
    expect(container.textContent).toContain(label);
    expect([...container.querySelectorAll('span')].some((node) => node.textContent === '14:35')).toBe(true);
  });

  it('sem dayTs conserva só a hora; sem timestamp não inventa data', () => {
    const ts = new Date(2026, 9, 16, 9, 7).getTime() / 1000;
    const { container, render } = show(entry({}, { ts }));
    expect(container.textContent).toContain('09:07');
    expect(container.textContent).not.toContain('hoje');
    render(entry());
    expect(container.textContent).toBe('T3raw-notice');
  });
});

describe('selos de decisão', () => {
  it.each<[OrqEntry['kind'], OrqDecidedBy, string]>([
    ['woke', decided({ source: 'rule', rule: 'mark' }), 'regra · [decisao] sempre acorda'],
    ['woke', decided({ source: 'rule', rule: 'orchestrator' }), 'regra · o orquestrador acorda'],
    ['woke', decided({ source: 'alarm' }), 'alarme · não passa pelo Jev'],
    ['woke', decided({ source: 'regex' }), 'regex · acordou'],
    ['dropped', decided({ source: 'regex', regex: { verdict: 'drop', category: 'auto-status' } }), 'regex · não acordou · auto-status'],
    ['would_drop', decided({ source: 'regex' }), 'regex · teria descartado'],
    ['woke', decided({ jev: jev({ choice: 'act', p: 0, probs: { act: 0.96 } }) }), 'Jev · acordou · 96%'],
    ['woke', decided({ jev: jev({ choice: 'act', p: 0 }) }), 'Jev · acordou'],
    ['dropped', decided({ jev: jev({ choice: 'nothing', p: 0.98 }) }), 'Jev · não acordou · 98%'],
    ['would_drop', decided({ jev: jev({ choice: 'nothing', p: null }) }), 'Jev · teria descartado'],
  ])('mostra quem decidiu %s: %j', (kind, decided_by, badge) => {
    const { container } = show(entry({ kind, decided_by }));
    expect(container.textContent).toContain(badge);
    if (!badge.includes('%')) expect(container.textContent).not.toContain('%');
    expect(container.textContent).not.toMatch(/·\s*$/);
  });

  it('descartado abre explicação sem atenuar selo e permite recolher', () => {
    const { container } = show(entry({ kind: 'dropped', body: '**discarded-body**', decided_by: decided({
      jev: jev({ choice: 'nothing', p: 0.4, probs: { nothing: 0.99 },
        veto: { context: 0.2, user: null, problem: 0, deviation: 0.45 }, error: 'judge-timeout' }), regex_agreed: false,
    }) }));
    expect(container.textContent).toContain('escolha nada a fazer 99%');
    expect(container.textContent).toContain('vetos: contexto 0,20 · usuário – · problema 0,00 · desvio 0,45');
    expect(container.textContent).toContain('regex discordou');
    expect(container.textContent).toContain('Jev falhou (judge-timeout); a regex decidiu');
    const badge = [...container.querySelectorAll('button')].find((button) => button.textContent?.startsWith('Jev · não acordou'))!;
    expect(badge.closest('[style*="opacity"]')).toBeNull();
    expect(container.querySelector('[data-markdown="**discarded-body**"]')?.closest('[style*="opacity"]')).not.toBeNull();
    expect(badge.getAttribute('aria-expanded')).toBe('true');
    act(() => badge.click());
    expect(container.textContent).not.toContain('escolha nada a fazer');
    expect(badge.getAttribute('aria-expanded')).toBe('false');
    act(() => badge.click());
    expect(container.textContent).toContain('escolha nada a fazer 99%');
  });

  it('explica escolha desconhecida sem inventar probabilidade e abre só no toque', () => {
    const { container } = show(entry({ kind: 'woke', decided_by: decided({
      jev: jev({ choice: 'future-choice', p: 0 }), regex_agreed: true,
    }) }));
    expect(container.textContent).not.toContain('escolha');
    const badge = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Jev · acordou')!;
    expect(badge).toBeDefined();
    act(() => badge.click());
    expect(container.textContent).toContain('escolha future-choice');
    expect(container.textContent).toContain('regex concordou');
    expect(container.textContent).not.toContain('%');
  });
});

describe('cartões do árbitro', () => {
  it.each(['body', 'question'] as const)('links da timeline em %s abrem só esquemas seguros e mostram falha', async (field) => {
    const openURL = vi.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
    vi.mocked(toast.erro).mockClear();
    const { container, render } = show(entry({ kind: 'woke' }));
    const pressLink = async (url: string) => {
      render(entry({ kind: 'woke', [field]: `[review](${url})` }));
      await act(async () => container.querySelector<HTMLElement>('[data-markdown]')!.click());
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

  it('descarte atenua só o corpo, sem atenuar ação de expansão', () => {
    const { container } = show(entry({ kind: 'dropped', body: 'discarded-content '.repeat(30) }));
    expect(container.querySelector('[data-markdown]')?.closest('[style*="opacity"]')).not.toBeNull();
    const more = [...container.querySelectorAll('button')].find((button) => button.textContent === 'ver tudo')!;
    expect(more).toBeDefined();
    expect(more.closest('[style*="opacity"]')).toBeNull();
  });

  it('expande Markdown seguro sem esconder pergunta ou erro', () => {
    const body = `${'word '.repeat(52)}\`open-code beyond the preview\` **end-of-body**`;
    const { container } = show(entry({ kind: 'failed', body, question: '**which-branch?**', error: 'merge-failed' }));
    const markdown = () => [...container.querySelectorAll('[data-markdown]')].map((node) => node.getAttribute('data-markdown'));
    expect(markdown()[0]).toBe(`${'word '.repeat(52).trimEnd()}…`);
    expect(markdown()).toContain('**which-branch?**');
    expect(container.textContent).toContain('Motivo: merge-failed');
    const more = () => [...container.querySelectorAll('button')].find((button) => button.textContent === 'ver tudo' || button.textContent === 'ver menos')!;
    expect(more().textContent).toBe('ver tudo');
    act(() => more().click());
    expect(markdown()[0]).toBe(body);
    expect(more().textContent).toBe('ver menos');
    act(() => more().click());
    expect(markdown()[0]).toBe(`${'word '.repeat(52).trimEnd()}…`);
    expect(markdown()).toContain('**which-branch?**');
    expect(container.textContent).toContain('Motivo: merge-failed');
  });

  it.each(['woke', 'would_drop', 'dropped', 'failed'] as const)('corpo vazio conhecido de %s não repete pergunta como texto cru', (kind) => {
    const question = 'preciso da tela do celular, posso usar?';
    const raw = `acordou o árbitro: T5: ${question}`;
    const { container } = show(entry({ kind, task: 5, body: '', question }, { text: raw }));
    expect([...container.querySelectorAll('[data-markdown]')].map(node => node.getAttribute('data-markdown'))).toEqual([question]);
    expect(container.textContent).not.toContain(raw);
  });

  it('não apaga aviso de tipo novo com corpo vazio', () => {
    const { container } = show(entry({ kind: 'future' as OrqEntry['kind'], body: '' }, { text: 'future-content' }));
    expect(container.textContent).toContain('future-content');
  });

  it.each([
    ['woke', 'notify', 'Árbitro acordado'],
    ['would_drop', 'notify', 'Árbitro acordado'],
    ['dropped', 'notify', 'rev-3 → árbitro'],
    ['failed', 'notify', 'Recado não entregue'],
    ['failed', 'orchestrator', 'Falha do orquestrador'],
  ] as const)('identifica %s da origem %s com remetente e marcas', (kind, origin, label) => {
    const { container } = show(entry({ kind, origin, sender: 'rev-3', mark: 'decisao', alarm: true, rejected_round: 2 }));
    expect(container.textContent).toContain(label);
    expect(container.textContent).toContain('rev-3 → árbitro');
    expect(container.textContent).toContain('T3');
    expect(container.textContent).toContain('decisão');
    expect(container.textContent).toContain('vigia');
    expect(container.textContent).toContain('R2 reprovada');
  });
});

describe('linhas curtas', () => {
  it.each(['advance', 'notice'] as const)('pergunta e erro de %s continuam visíveis', (kind) => {
    const { container } = show(entry({ kind, line: { code: 'red_retry' }, question: '**question-body**', error: 'retry-failed' }));
    expect(container.querySelector('[data-markdown="**question-body**"]')).not.toBeNull();
    expect(container.textContent).toContain('Pergunta:');
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('Motivo: retry-failed');
  });
  it.each([
    ['advance', 3, null, 'T3: aviso-novo', 'T3aviso-novo'],
    ['notice', null, null, 'T3: aviso-novo', 'T3: aviso-novo'],
    ['notice', 3, { code: 'future', extra: 'preserve' }, 'T3: aviso-futuro', 'T3aviso-futuro'],
  ] as const)('preserva fallback desconhecido %s/%s sem repetir task', (kind, task, line, text, expected) => {
    const event = entry({ kind, task, line: line as unknown as OrqLine }, { text });
    const { container } = show(event);
    expect(container.textContent).toBe(expected);
    expect(event.orq?.line).toEqual(line);
    expect(event.text).toBe(text);
  });
  it.each<[OrqLine, string]>([
    [{ code: 'opened', sessions: [{ name: 'exec-3', provider: 'claude', model: 'sonnet' }, { name: 'rev-3', provider: 'codex', model: 'gpt-6' }] },
      'começou · executor exec-3 (claude · sonnet) · revisor rev-3 (codex · gpt-6)'],
    [{ code: 'opened', sessions: [{ name: 'exec-3', provider: 'claude', model: 'haiku' }] }, 'começou · executor exec-3 (claude · haiku)'],
    [{ code: 'integrated', merge: true }, 'fechada → merge → integração verde'],
    [{ code: 'integrated', merge: false }, 'fechada → integração verde'],
    [{ code: 'delivered', round: 2, commit: 'abc123' }, 'entregou a rodada 2 · abc123'],
    [{ code: 'delivered', round: 1, commit: null }, 'entregou a rodada 1'],
    [{ code: 'red_back', executor: 'exec-3' }, 'integração vermelha → devolvida ao executor exec-3'],
    [{ code: 'red_retry' }, 'integração vermelha, rodando de novo uma vez'],
  ])('traduz o código %j sem depender do texto cru', (line, phrase) => {
    const { container } = show(entry({ line }));
    expect(container.textContent).toBe(`T3${phrase}`);
    expect(container.querySelector('[data-markdown]')).toBeNull();
  });
});
