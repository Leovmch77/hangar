// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import * as m from '../paraglide/messages';

const renderMermaid = vi.fn();
vi.mock('@hangar/core', async (orig) => ({ ...(await orig<typeof import('@hangar/core')>()), renderMermaid: (...a: unknown[]) => renderMermaid(...a) }));
const abrirVisor = vi.fn();
vi.mock('../lib/visor', () => ({ abrirVisor: (...a: unknown[]) => abrirVisor(...a) }));

const { default: MermaidDiagram } = await import('./MermaidDiagram.svelte');

URL.createObjectURL = vi.fn(() => 'blob:diagrama');
URL.revokeObjectURL = vi.fn();
// Sem canvas no happy-dom: a cópia com fundo sólido falha e o visor recebe a imagem original.
HTMLImageElement.prototype.decode = () => Promise.reject(new Error('sem canvas'));

function mountDiagram() {
  const target = document.createElement('div');
  const block = document.createElement('div');
  block.className = 'code-block';
  document.body.append(target, block);
  const comp = mount(MermaidDiagram, { target, props: { source: 'graph TD; A-->B', block } });
  return { target, block, comp };
}

const settle = async () => { for (let i = 0; i < 4; i++) { await tick(); await Promise.resolve(); } flushSync(); };

beforeEach(() => {
  renderMermaid.mockReset();
  abrirVisor.mockReset();
});

describe('MermaidDiagram', () => {
  it('carregando, depois a imagem; o código sai da vista e o toque abre o visor', async () => {
    let resolve!: (v: unknown) => void;
    renderMermaid.mockReturnValue(new Promise((r) => (resolve = r)));
    const { target, block, comp } = mountDiagram();
    flushSync();
    expect(target.textContent).toContain(m.mermaid_drawing());
    expect(renderMermaid).toHaveBeenCalledWith('graph TD; A-->B', 'dark', undefined, false);
    resolve({ kind: 'image', png: new Uint8Array([1]), width: 300, height: 120 });
    await settle();
    const img = target.querySelector('img')!;
    expect(img.getAttribute('width')).toBe('300');
    expect(block.classList.contains('mermaid-src-hidden')).toBe(true);
    expect(block.getAttribute('aria-hidden')).toBe('true');
    target.querySelector<HTMLButtonElement>('.mermaid-open')!.click();
    await settle();
    expect(abrirVisor).toHaveBeenCalledWith([expect.objectContaining({ url: 'blob:diagrama', tipo: 'image' })], 0);
    unmount(comp);
    expect(block.classList.contains('mermaid-src-hidden')).toBe(false);
    expect(block.hasAttribute('aria-hidden')).toBe(false);
  });

  it('erro do parser mostra a mensagem, mantém o código e não oferece tentar de novo', async () => {
    renderMermaid.mockResolvedValue({ kind: 'invalid', code: 'mermaid_invalido', message: 'Parse error' });
    const { target, block, comp } = mountDiagram();
    await settle();
    expect(target.textContent).toContain(m.mermaid_error({ message: 'Parse error' }));
    expect(target.querySelector('.mermaid-retry')).toBeNull();
    expect(block.classList.contains('mermaid-src-hidden')).toBe(false);
    unmount(comp);
  });

  it('indisponível oferece tentar de novo, que pede sem o cache', async () => {
    renderMermaid.mockResolvedValueOnce({ kind: 'unavailable', code: 'mermaid_indisponivel', message: 'sem Chromium' });
    const { target, comp } = mountDiagram();
    await settle();
    expect(target.textContent).toContain(m.mermaid_error({ message: 'sem Chromium' }));
    renderMermaid.mockResolvedValueOnce({ kind: 'image', png: new Uint8Array([1]), width: 10, height: 10 });
    target.querySelector<HTMLButtonElement>('.mermaid-retry')!.click();
    await settle();
    expect(renderMermaid).toHaveBeenLastCalledWith('graph TD; A-->B', 'dark', undefined, true);
    expect(target.querySelector('img')).not.toBeNull();
    unmount(comp);
  });

  it('recusa definitiva tem frase própria, sem código cru e sem tentar de novo', async () => {
    renderMermaid.mockResolvedValue({ kind: 'rejected', code: 'http_401', message: '' });
    const { target, comp } = mountDiagram();
    await settle();
    expect(target.textContent).toContain(m.mermaid_unauthorized());
    expect(target.textContent).not.toContain('http_401');
    expect(target.querySelector('.mermaid-retry')).toBeNull();
    unmount(comp);
  });

  it('fonte longa demais avisa sem tentar de novo', async () => {
    renderMermaid.mockResolvedValue({ kind: 'too_long', code: 'fonte_longa', message: '' });
    const { target, comp } = mountDiagram();
    await settle();
    expect(target.textContent).toContain(m.mermaid_too_long());
    expect(target.querySelector('.mermaid-retry')).toBeNull();
    unmount(comp);
  });

  it('rota que não existe para quem pede (404, convidado) deixa só o código', async () => {
    renderMermaid.mockResolvedValue({ kind: 'not_offered', code: 'http_404', message: '' });
    const { target, block, comp } = mountDiagram();
    await settle();
    expect(target.querySelector('.mermaid')).toBeNull();
    expect(block.classList.contains('mermaid-src-hidden')).toBe(false);
    unmount(comp);
  });
});
