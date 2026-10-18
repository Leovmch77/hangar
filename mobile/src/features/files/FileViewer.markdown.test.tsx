// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Linking } from 'react-native';
import type { ComponentProps } from 'react';
import * as m from '../../paraglide/messages';
import { toast } from '../../ui/Toast';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock('../../chat/AssistantBubble', () => ({ mkMarkdownStyle: () => ({ paragraph: { color: '#123456' } }) }));
vi.mock('../../chat/tools/EditDiff', () => ({ EditDiff: () => createElement('aside', null, 'diff-fixture') }));
vi.mock('../attachments/DocumentViewer', () => ({ PdfReader: () => null }));
vi.mock('../../ui/Toast', () => ({ toast: { erro: vi.fn() } }));
// Só a fronteira nativa é substituída: o teste observa o documento entregue ao renderizador do chat.
vi.mock('react-native-enriched-markdown', () => ({
  EnrichedMarkdownText: ({ markdown, flavor, markdownStyle, onLinkPress, selectionMenuConfig }: {
    markdown: string; flavor: string; markdownStyle: { paragraph: { color: string } };
    onLinkPress?: (event: { url: string }) => void;
    selectionMenuConfig?: { copy: { label: string }; copyAsMarkdown: { label: string }; copyImageUrl: { label: string } };
  }) => createElement('article', {
    'data-flavor': flavor, style: { color: markdownStyle.paragraph.color },
    'data-copy': selectionMenuConfig?.copy.label,
    'data-copy-markdown': selectionMenuConfig?.copyAsMarkdown.label,
    'data-copy-image': selectionMenuConfig?.copyImageUrl.label,
    onClick: () => onLinkPress?.({ url: 'https://example.test/guide' }),
  }, markdown),
}));

import { FileViewer } from './FileViewer';

const markdown = '# Guide\n\n[link](https://example.test/guide)\n\n- item\n\n```ts\nconst x = 1;\n```\n\n| a | b |\n| --- | --- |\n| 1 | 2 |';
let container: HTMLDivElement;
let root: Root;
const onEditar = vi.fn();
const props = (path: string, text = markdown): ComponentProps<typeof FileViewer> => ({
  path, conteudo: { path, text, size: text.length, digest: 'digest', truncated: false },
  diff: null, loading: false, escopo: 'nao_commitado', onEscopo: vi.fn(), onEditar, name: 'file-fixture',
});
const render = (value: ComponentProps<typeof FileViewer>) => act(async () => root.render(createElement(FileViewer, value)));
const click = (label: string) => act(async () => [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === label)!.click());

beforeEach(() => { container = document.createElement('div'); root = createRoot(container); onEditar.mockClear(); });
afterEach(async () => { await act(async () => root.unmount()); vi.restoreAllMocks(); });

it.each(['guide.md', 'guide.markdown', 'GUIDE.MD'])('%s abre no Markdown do chat, alterna fonte e Editar permanece disponível', async path => {
  await render(props(path));
  expect(container.querySelector('article')?.textContent).toBe(markdown);
  expect(container.querySelector('article')?.getAttribute('data-flavor')).toBe('github');
  expect(container.querySelector('article')?.style.color).toBe('#123456');
  await click(m.native_file_source());
  expect(container.querySelector('article')).toBeNull();
  expect(container.textContent).toContain('# Guide');
  await click(m.arq_editar());
  expect(onEditar).toHaveBeenCalledOnce();
  await click(m.mobile_file_page());
  expect(container.querySelector('article')?.textContent).toBe(markdown);
});

it('link da página abre no sistema e falha aparece', async () => {
  const openURL = vi.spyOn(Linking, 'openURL').mockRejectedValue(new Error('link-failed'));
  vi.mocked(toast.erro).mockClear();
  await render(props('guide.md'));
  await act(async () => container.querySelector('article')!.click());
  expect(openURL).toHaveBeenCalledWith('https://example.test/guide');
  expect(toast.erro).toHaveBeenCalledWith('link-failed');
});

it('outro arquivo Markdown recomeça na página em vez de herdar Fonte', async () => {
  await render(props('guide.md'));
  await click(m.native_file_source());
  await render(props('other.markdown', '# Other'));
  expect(container.querySelector('article')?.textContent).toBe('# Other');
});

it('Markdown com diff abre na página e conserva o acesso às alterações', async () => {
  await render({ ...props('guide.md'), diff: {
    path: 'guide.md', diff: '+# Guide', original: '# Old', truncated: false,
    escopo_pedido: 'nao_commitado', escopo_usado: 'nao_commitado', base: null, motivo: null,
  } });
  expect(container.querySelector('article')?.textContent).toBe(markdown);
  await click(m.arq_ver_alteracoes());
  expect(container.querySelector('article')).toBeNull();
  expect(container.querySelector('aside')?.textContent).toBe('diff-fixture');
  await click(m.arq_ver_arquivo());
  expect(container.querySelector('article')?.textContent).toBe(markdown);
});

it('arquivo de código continua na fonte, sem seletor de Markdown', async () => {
  await render(props('guide.ts', 'export const x = 1;'));
  expect(container.querySelector('article')).toBeNull();
  expect(container.textContent).toContain('export const x = 1;');
  expect([...container.querySelectorAll('button')].some(button => button.textContent === m.mobile_file_page())).toBe(false);
});

it('documento vazio mostra o aviso do leitor', async () => {
  await render(props('empty.md', ''));
  expect(container.textContent).toContain(m.native_file_empty());
  expect(container.querySelector('article')).toBeNull();
});

it('menu de seleção usa as traduções do chat', async () => {
  await render(props('guide.md'));
  const article = container.querySelector('article');
  expect(article?.getAttribute('data-copy')).toBe(m.selection_copy());
  expect(article?.getAttribute('data-copy-markdown')).toBe(m.selection_copy_markdown());
  expect(article?.getAttribute('data-copy-image')).toBe(m.selection_copy_image_url());
});
