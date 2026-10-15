// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../paraglide/messages', () => ({ native_thinking: () => 'Raciocinio', pensamento_abrir: () => 'abrir' }));
vi.mock('../ui/Icon', () => ({ Icon: ({ name }: { name: string }) => createElement('i', { 'data-icon': name }) }));
vi.mock('./AssistantBubble', () => ({ mkMarkdownStyle: () => ({ paragraph: {} }) }));
vi.mock('react-native-enriched-markdown', () => ({
  EnrichedMarkdownText: ({ markdown }: { markdown: string }) => createElement('pre', null, markdown),
}));

import { ThinkingBlock } from './ThinkingBlock';

describe('ThinkingBlock', () => {
  it('o brain vem antes do rótulo, como no T3', async () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    await act(async () => root.render(createElement(ThinkingBlock, { ev: { id: 't', kind: 'thinking', text: '**Título** e o resto' } as never })));
    const linha = container.querySelector('button')!;
    const icone = linha.querySelector('i[data-icon="Brain"]');
    expect(icone).not.toBeNull();
    expect(linha.textContent!.startsWith('Raciocinio')).toBe(true);
    expect(linha.firstElementChild).toBe(icone);
    act(() => root.unmount());
  });
});
