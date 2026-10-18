// @vitest-environment happy-dom
// @vitest-environment-options {"settings":{"navigation":{"disableChildFrameNavigation":true}}}
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, tick, unmount } from 'svelte';
import { configureApi, parseFilePaths } from '@hangar/core';
import FileAttachment from './FileAttachment.svelte';
import { saveFile } from '../lib/saveFile';
import * as m from '../paraglide/messages';

vi.mock('../lib/saveFile', () => ({ saveFile: vi.fn(async () => 'saved') }));

let component: ReturnType<typeof mount> | undefined;
let target: HTMLDivElement;

beforeEach(() => {
  configureApi({ getBaseUrl: () => 'https://desktop.example.ts.net', getToken: () => 'test-token',
    onUnauthorized: () => {}, origin: 'https://pwa.example',
    createEventSource: () => { throw new Error('Unexpected stream'); } });
  target = document.createElement('div');
  document.body.append(target);
  vi.mocked(saveFile).mockClear();
});

afterEach(async () => {
  if (component) await unmount(component);
  component = undefined;
  target.remove();
});

describe('documentos citados', () => {
  it('DOCX oferece download autenticado no servidor da conversa, sem editor ou iframe', async () => {
    component = mount(FileAttachment, { target, props: {
      sessionName: 'sessão', refs: parseFilePaths('/tmp/Relatório final.docx'),
    } });
    await tick();
    const buttons = target.querySelectorAll<HTMLButtonElement>('button');
    expect(buttons).toHaveLength(1);
    expect(buttons[0].getAttribute('aria-label')).toBe(m.anexos_baixar({ nome: 'Relatório final.docx' }));
    expect(target.querySelector('iframe')).toBeNull();
    buttons[0].click();
    await tick();
    const [href, name] = vi.mocked(saveFile).mock.calls[0];
    const url = new URL(href);
    expect(url.origin).toBe('https://desktop.example.ts.net');
    expect(url.searchParams.get('download')).toBe('1');
    expect(url.searchParams.get('token')).toBe('test-token');
    expect(url.searchParams.get('path')).toBe('/tmp/Relatório final.docx');
    expect(name).toBe('Relatório final.docx');
  });

  it('cartão do documento mostra nome, extensão e o resultado do download', async () => {
    component = mount(FileAttachment, { target, props: { sessionName: 's', refs: parseFilePaths('/tmp/dados.zip') } });
    await tick();
    const card = target.querySelector('.file-card')!;
    expect(card.textContent).toContain('dados.zip');
    expect(card.textContent).toContain('ZIP');
    const btn = card.querySelector<HTMLButtonElement>('button')!;
    expect(btn.textContent).toContain(m.file_card_download());
    btn.click();
    await vi.waitFor(() => expect(card.textContent).toContain(m.file_card_saved()));
  });

  it.each([
    [Object.assign(new Error('HTTP 404'), { status: 404 }), () => m.file_card_missing()],
    [new Error('rede caiu'), () => m.file_card_failed()],
  ])('falha no download aparece no cartão com tentar de novo', async (err, msg) => {
    vi.mocked(saveFile).mockRejectedValueOnce(err);
    component = mount(FileAttachment, { target, props: { sessionName: 's', refs: parseFilePaths('/tmp/notas.txt') } });
    await tick();
    const card = target.querySelector('.file-card')!;
    card.querySelector<HTMLButtonElement>('button')!.click();
    await vi.waitFor(() => expect(card.textContent).toContain(msg()));
    expect(card.querySelector('button')!.textContent).toContain(m.file_card_retry());
  });

  it('arquivo vazio avisa em vez de baixar nada', async () => {
    vi.mocked(saveFile).mockResolvedValueOnce('empty');
    component = mount(FileAttachment, { target, props: { sessionName: 's', refs: parseFilePaths('/tmp/vazio.csv') } });
    await tick();
    target.querySelector<HTMLButtonElement>('.file-card button')!.click();
    await vi.waitFor(() => expect(target.querySelector('.file-card')!.textContent).toContain(m.file_card_empty()));
  });

  it('PDF mantém a prévia e permite baixar tanto no cartão quanto no visor', async () => {
    component = mount(FileAttachment, { target, props: {
      sessionName: 's', refs: parseFilePaths('/tmp/relatorio.pdf'),
    } });
    await tick();
    target.querySelector<HTMLButtonElement>('button.att-download')!.click();
    await tick();
    expect(vi.mocked(saveFile).mock.calls[0]?.[0]).toContain('download=1');
    target.querySelector<HTMLButtonElement>('button.att-chip')!.click();
    await tick();
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.querySelector('iframe')?.getAttribute('src')).not.toContain('download=');
    const label = m.anexos_baixar({ nome: 'relatorio.pdf' });
    dialog.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!.click();
    await tick();
    expect(vi.mocked(saveFile).mock.calls[1]?.[0]).toContain('download=1');
  });
});
