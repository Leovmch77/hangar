// @vitest-environment happy-dom
// @vitest-environment-options {"settings":{"navigation":{"disableChildFrameNavigation":true}}}
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mount, tick, unmount } from 'svelte';
import { configureApi, parseFilePaths } from '@hangar/core';
import FileAttachment from './FileAttachment.svelte';
import * as m from '../paraglide/messages';

let component: ReturnType<typeof mount> | undefined;
let target: HTMLDivElement;

beforeEach(() => {
  configureApi({ getBaseUrl: () => 'https://desktop.example.ts.net', getToken: () => 'test-token',
    onUnauthorized: () => {}, origin: 'https://pwa.example',
    createEventSource: () => { throw new Error('Unexpected stream'); } });
  target = document.createElement('div');
  document.body.append(target);
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
    const download = target.querySelector<HTMLAnchorElement>('a[download]')!;
    expect(download.getAttribute('aria-label')).toBe(m.anexos_baixar({ nome: 'Relatório final.docx' }));
    const url = new URL(download.href);
    expect(url.origin).toBe('https://desktop.example.ts.net');
    expect(url.searchParams.get('download')).toBe('1');
    expect(url.searchParams.get('token')).toBe('test-token');
    expect(url.searchParams.get('path')).toBe('/tmp/Relatório final.docx');
    expect(download.download).toBe('Relatório final.docx');
    expect(target.querySelector('button, iframe')).toBeNull();
  });

  it('PDF mantém a prévia e permite baixar tanto no cartão quanto no visor', async () => {
    component = mount(FileAttachment, { target, props: {
      sessionName: 's', refs: parseFilePaths('/tmp/relatorio.pdf'),
    } });
    await tick();
    expect(target.querySelector('a[download]')).not.toBeNull();
    target.querySelector<HTMLButtonElement>('button.att-chip')!.click();
    await tick();
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.querySelector('iframe')?.getAttribute('src')).not.toContain('download=');
    expect(dialog.querySelector<HTMLAnchorElement>('a[download]')?.href).toContain('download=1');
  });
});
