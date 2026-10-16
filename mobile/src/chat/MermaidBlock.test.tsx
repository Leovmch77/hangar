// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../paraglide/messages', () => Object.fromEntries(
  'mermaid_drawing mermaid_retry mermaid_open mermaid_alt mermaid_file'.split(' ').map((k) => [k, () => k]),
));
const renderMermaid = vi.fn();
vi.mock('@hangar/core', async (orig) => ({
  ...(await orig<typeof import('@hangar/core')>()),
  renderMermaid: (...a: unknown[]) => renderMermaid(...a),
}));
vi.mock('../features/attachments/Lightbox', () => ({ Lightbox: () => null }));
vi.mock('../stores/servers', () => ({ useServers: (sel: (s: { servers: never[] }) => unknown) => sel({ servers: [] }) }));
vi.mock('react-native-enriched-markdown', () => ({
  EnrichedMarkdownText: ({ markdown }: { markdown: string }) => createElement('pre', null, markdown),
}));

const { MermaidBlock } = await import('./MermaidBlock');
const core = await import('@hangar/core');

function render(source: string) {
  const container = document.createElement('div');
  const root = createRoot(container);
  act(() => root.render(createElement(MermaidBlock, { source, md: {} as never })));
  return { container, root };
}

describe('MermaidBlock (app)', () => {
  it('fonte vazia não vira bloco', () => {
    const { container, root } = render('  \n ');
    expect(container.textContent).toBe('');
    act(() => root.unmount());
  });

  it('fonte longa demais avisa com texto próprio, mostra o código e não pede ao servidor', () => {
    const source = 'x'.repeat(50001);
    const { container, root } = render(source);
    expect(container.textContent).toContain(core.mermaidFailureText({ kind: 'too_long', code: '', message: '' })!);
    expect(container.querySelector('pre')?.textContent).toContain(source);
    expect(container.querySelector('button')).toBeNull();
    expect(renderMermaid).not.toHaveBeenCalled();
    act(() => root.unmount());
  });
});
