// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it, vi } from 'vitest';
import * as m from '../../paraglide/messages';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// A lista real do RN Web usa VirtualizedList; o mock global monta todos os itens.
vi.mock('react-native', async importOriginal => ({
  ...await importOriginal<typeof import('react-native')>(),
  FlatList: (await vi.importActual<{ default: typeof import('react-native').FlatList }>('react-native-web/dist/exports/FlatList')).default,
}));
vi.mock('../../chat/AssistantBubble', () => ({ mkMarkdownStyle: () => ({}) }));
vi.mock('react-native-enriched-markdown', () => ({ EnrichedMarkdownText: () => null }));
vi.mock('../../chat/tools/EditDiff', () => ({ EditDiff: () => null }));
vi.mock('../attachments/DocumentViewer', () => ({ PdfReader: () => null }));
vi.mock('../../ui/Toast', () => ({ toast: { erro: vi.fn() } }));

import { FileViewer } from './FileViewer';

it.each(['harnesses.txt', 'harnesses.md'])('fonte de %s monta apenas a janela e desmonta ao fechar', async path => {
  const text = readFileSync(resolve('../docs/decisoes/harnesses.md'), 'utf8');
  const total = text.replace(/\n$/, '').split('\n').length;
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(FileViewer, {
      path, conteudo: { path, text, size: text.length, digest: 'd', truncated: false },
      diff: null, loading: false, escopo: 'nao_commitado', onEscopo: vi.fn(), onEditar: vi.fn(), name: 'large-file-fixture',
    })));
    if (path.endsWith('.md')) {
      await act(async () => [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === m.native_file_source())!.click());
    }
    // Número de linha isolado: cada linha tem um Text para o número e outro para o conteúdo.
    const mounted = [...container.querySelectorAll('span')].filter(node => /^\d+$/.test(node.textContent ?? '')).length;
    console.info(`Fonte: ${mounted} linhas montadas de ${total}; ${container.querySelectorAll('*').length} elementos no total`);
    expect(mounted).toBeGreaterThan(0);
    expect(mounted).toBeLessThan(100);
    expect(container.textContent).toContain('# Harnesses');
  } finally {
    await act(async () => root.unmount());
    expect(container.childElementCount).toBe(0);
    container.remove();
  }
});
