import { mount, unmount } from 'svelte';
import type { Server } from '@hangar/core';
import MermaidDiagram from '../components/MermaidDiagram.svelte';

// Troca cada bloco ```mermaid de uma resposta pronta pela imagem do servidor. Imperativo pelo mesmo
// motivo do tableChartMount: o bloco nasce dentro do {@html} do renderMarkdown. Independe do Shiki:
// lê só o `textContent`, que o realce preserva, e nunca troca o bloco de lugar.
export function enhanceMermaid(root: HTMLElement, server?: Server): () => void {
  const undo: (() => void)[] = [];
  for (const code of root.querySelectorAll<HTMLElement>('pre > code')) {
    if (!/(?:^|\s)language-mermaid(?:\s|$)/i.test(code.className)) continue;
    const block = code.closest<HTMLElement>('.code-block');
    if (!block || block.dataset.cpMermaid) continue;
    const source = (code.textContent ?? '').replace(/\n$/, '');
    if (!source.trim()) continue;
    block.dataset.cpMermaid = '1';
    const host = document.createElement('div');
    block.before(host);
    const comp = mount(MermaidDiagram, { target: host, props: { source, block, server } });
    undo.push(() => {
      void unmount(comp);
      host.remove();
      delete block.dataset.cpMermaid;
    });
  }
  return () => { for (const f of undo) f(); };
}
