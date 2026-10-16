// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { mount, tick, unmount } from 'svelte';
import HtmlPageDialog from './HtmlPageDialog.svelte';
import * as m from '../paraglide/messages';

const DOC = '<html><head><script id="hangar-host"></script></head><body>p</body></html>';

async function open(onClose = vi.fn(), loadSource = vi.fn(async () => '<p>oi</p>\n<b>x</b>')) {
  const target = document.createElement('div');
  document.body.appendChild(target);
  const comp = mount(HtmlPageDialog, { target, props: { title: 'Gráfico', doc: DOC, ownTheme: false, scheme: 'dark', onClose, loadSource } });
  await tick();
  const btn = (label: string) => document.body.querySelector(`button[aria-label="${label}"]`) as HTMLButtonElement;
  return { comp, target, btn, onClose };
}

describe('HtmlPageDialog', () => {
  it('zoom em degraus, porcentagem volta a 100% e os limites desligam os botões', async () => {
    const { comp, target, btn } = await open();
    const reset = btn(m.page_zoom_reset());
    expect(reset.textContent?.trim()).toBe('100%');
    btn(m.page_zoom_in()).click(); await tick();
    expect(reset.textContent?.trim()).toBe('125%');
    reset.click(); await tick();
    expect(reset.textContent?.trim()).toBe('100%');
    btn(m.page_zoom_out()).click(); await tick();
    btn(m.page_zoom_out()).click(); await tick();
    expect(reset.textContent?.trim()).toBe('50%');
    expect(btn(m.page_zoom_out()).disabled).toBe(true);
    unmount(comp); target.remove();
  });

  it('Ctrl+= amplia pelo teclado', async () => {
    const { comp, target, btn } = await open();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '=', ctrlKey: true }));
    await tick();
    expect(btn(m.page_zoom_reset()).textContent?.trim()).toBe('125%');
    unmount(comp); target.remove();
  });

  it('mesmo isolamento do cartão, com a ponte de zoom só na cópia', async () => {
    const { comp, target } = await open();
    const frame = document.body.querySelector('iframe') as HTMLIFrameElement;
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
    // O Svelte pode pôr o srcdoc como propriedade em vez de atributo.
    expect(frame.getAttribute('srcdoc') ?? frame.srcdoc).toContain('hangar-zoom');
    unmount(comp); target.remove();
  });

  it('a cópia nasce no tema de agora, não no da carga do cartão', async () => {
    const target = document.createElement('div');
    document.body.appendChild(target);
    const old = '<html><head><style id="hangar-theme" data-base="">:root{color-scheme:dark}</style>'
      + '<script id="hangar-host"></script></head><body>p</body></html>';
    const comp = mount(HtmlPageDialog, { target, props: { title: 'T', doc: old, ownTheme: false, scheme: 'light', onClose: vi.fn(),
      loadSource: vi.fn(async () => '') } });
    await tick();
    const frame = document.body.querySelector('iframe') as HTMLIFrameElement;
    const src = frame.getAttribute('srcdoc') ?? frame.srcdoc;
    expect(src).toContain('color-scheme:light');
    expect(src).not.toContain('color-scheme:dark');
    unmount(comp); target.remove();
  });

  it('Fonte mostra o código que o servidor devolve, sem desmontar a página, e oferece copiar e salvar', async () => {
    const loadSource = vi.fn(async () => '<p>oi</p>\n<b>x</b>');
    const { comp, target, btn } = await open(vi.fn(), loadSource);
    const toggle = [...document.body.querySelectorAll('button')].find((b) => b.textContent?.trim() === m.page_view_source())!;
    expect(btn(m.page_copy_source())).toBeNull();
    toggle.click();
    await vi.waitFor(() => expect(document.body.querySelector('.code pre')?.textContent).toContain('<b>x</b>'));
    expect(loadSource).toHaveBeenCalledTimes(1);
    expect(document.body.querySelector('iframe')).not.toBeNull();
    expect(btn(m.page_copy_source())).not.toBeNull();
    expect(btn(m.page_save_file())).not.toBeNull();
    expect(toggle.textContent?.trim()).toBe(m.page_view_page());
    toggle.click(); await tick();
    expect(document.body.querySelector('.code pre')).toBeNull();
    unmount(comp); target.remove();
  });

  it('fonte que não veio mostra o erro e deixa tentar de novo', async () => {
    const loadSource = vi.fn().mockRejectedValueOnce(new Error('HTTP 404')).mockResolvedValueOnce('<p>de novo</p>');
    const { comp, target } = await open(vi.fn(), loadSource);
    [...document.body.querySelectorAll('button')].find((b) => b.textContent?.trim() === m.page_view_source())!.click();
    await vi.waitFor(() => expect(document.body.querySelector('[role="alert"]')?.textContent).toContain(m.page_source_error()));
    [...document.body.querySelectorAll('button')].find((b) => b.textContent?.trim() === m.page_retry())!.click();
    await vi.waitFor(() => expect(document.body.querySelector('.code pre')?.textContent).toContain('de novo'));
    unmount(comp); target.remove();
  });

  it('fechar pelo X', async () => {
    const { comp, target, btn, onClose } = await open();
    btn(m.page_close()).click();
    expect(onClose).toHaveBeenCalled();
    unmount(comp); target.remove();
  });
});
