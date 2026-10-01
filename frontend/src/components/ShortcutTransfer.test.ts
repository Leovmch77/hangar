// @vitest-environment happy-dom
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { mount, tick, unmount } from 'svelte';
import { exportShortcuts, importShortcuts } from '@hangar/core';
import ShortcutTransfer from './ShortcutTransfer.svelte';
import { reloadShortcuts } from '../lib/shortcuts.svelte';
import * as m from '../paraglide/messages';

const fixture = vi.hoisted(() => ({
  active: 'a',
  servers: [
    { id: 'a', label: 'Servidor A', baseUrl: 'https://a.test', token: 'a' },
    { id: 'b', label: 'Servidor B', baseUrl: 'https://b.test', token: 'b' },
  ],
}));
vi.mock('@hangar/core', async (original) => ({
  ...(await original<typeof import('@hangar/core')>()), exportShortcuts: vi.fn(), importShortcuts: vi.fn(),
}));
vi.mock('../lib/auth', () => ({ getActiveId: () => fixture.active, listServers: () => fixture.servers }));
vi.mock('../lib/shortcuts.svelte', () => ({ reloadShortcuts: vi.fn(async () => {}) }));

let component: ReturnType<typeof mount>;
let target: HTMLDivElement;
const flush = async () => { await tick(); await new Promise((resolve) => setTimeout(resolve, 0)); await tick(); };
const shortcuts = [
  { id: 'one', type: 'shell' as const, label: 'primeiro', command: 'one' },
  { id: 'two', type: 'shell' as const, label: 'segundo', command: 'two' },
  { id: 'three', type: 'send_text' as const, label: 'terceiro', text: 'hello' },
];
const scripts = [{ path: '.local/bin/one', content: '#!/bin/sh\necho ok\n', executable: true }];
const blobUrl = vi.fn<(blob: Blob) => string>(() => 'blob:export');

beforeEach(() => {
  vi.clearAllMocks();
  fixture.active = 'a';
  vi.mocked(exportShortcuts).mockResolvedValue({ version: 2, shortcuts, scripts: [], warnings: [], removed: 0 });
  vi.mocked(importShortcuts).mockResolvedValue({ added: 1, replaced: 0, placeholders: [] });
  vi.stubGlobal('URL', class extends URL {
    static createObjectURL = blobUrl;
    static revokeObjectURL = vi.fn();
  });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  target = document.createElement('div'); document.body.append(target);
  component = mount(ShortcutTransfer, { target, props: {} });
});
afterEach(async () => {
  await unmount(component); target.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

function button(label: string, scope: ParentNode = document): HTMLButtonElement {
  return [...scope.querySelectorAll('button')].find((b) => b.textContent?.trim() === label) as HTMLButtonElement;
}
async function readFile(data: unknown) {
  const input = target.querySelector<HTMLInputElement>('input[type=file]')!;
  Object.defineProperty(input, 'files', { configurable: true, value: [new File([JSON.stringify(data)], 'shortcuts.json')] });
  input.dispatchEvent(new Event('change', { bubbles: true })); await flush();
}

describe('transferência seletiva', () => {
  it('começa sem seleção e exporta somente os IDs marcados com scripts e avisos', async () => {
    button(m.atalhos_exportar()).click(); await flush();
    expect(exportShortcuts).toHaveBeenLastCalledWith(fixture.servers[0], { includeScripts: false });
    expect(button(m.shortcut_export_selected({ n: 0 })).disabled).toBe(true);
    const checks = document.querySelectorAll<HTMLInputElement>('input[type=checkbox]');
    checks[0].click(); checks[1].click(); await flush();
    vi.mocked(exportShortcuts).mockResolvedValue({ version: 2, shortcuts: shortcuts.slice(0, 2), scripts,
      warnings: ['external-file'], removed: 0 });
    button(m.shortcut_export_selected({ n: 2 })).click(); await flush();
    expect(exportShortcuts).toHaveBeenLastCalledWith(fixture.servers[0], { ids: ['one', 'two'], includeScripts: true });
    const payload = JSON.parse(await blobUrl.mock.calls[0][0].text());
    expect(payload.shortcuts.map((s: { id: string }) => s.id)).toEqual(['one', 'two']);
    expect(payload.scripts).toEqual(scripts);
    expect(payload.warnings).toEqual(['external-file']);
    expect(target.textContent).toContain('external-file');
  });

  it('servidor antigo não exporta tudo por ignorar a seleção', async () => {
    vi.mocked(exportShortcuts).mockResolvedValue({ version: 1, shortcuts, removed: 0 });
    button(m.atalhos_exportar()).click(); await flush();
    expect(document.body.textContent).toContain(m.shortcut_transfer_update_required());
    expect(blobUrl).not.toHaveBeenCalled();
  });

  it('prévia lista destinos, conserva servidor e mantém erro de importação visível', async () => {
    vi.mocked(importShortcuts).mockResolvedValue({ added: 1, replaced: 0, placeholders: [],
      files: [{ path: '/home/dest/.local/bin/one', status: 'replace', content: 'echo ok' }], warnings: ['external-file'] });
    await readFile({ version: 2, shortcuts: [shortcuts[0]], scripts });
    const dialog = document.querySelector('[role=dialog]')!;
    expect(dialog.textContent).toContain('/home/dest/.local/bin/one');
    expect(dialog.textContent).toContain(m.shortcut_file_replace());
    expect(dialog.textContent).toContain('echo ok');
    fixture.active = 'b';
    vi.mocked(importShortcuts).mockRejectedValue(new Error('write refused'));
    button(m.atalhos_importar(), dialog).click(); await flush();
    expect(importShortcuts).toHaveBeenLastCalledWith(expect.objectContaining({ apply: true }), fixture.servers[0]);
    expect(dialog.querySelector('[role=alert]')?.textContent).toBe('write refused');
    expect(reloadShortcuts).not.toHaveBeenCalled();
  });

  it('bloqueia importação até preencher os segredos de scripts', async () => {
    vi.mocked(importShortcuts).mockResolvedValue({ added: 1, replaced: 0, files: [],
      placeholders: [{ id: 'script:.local/bin/one', label: '.local/bin/one', names: ['token'] }] });
    await readFile({ version: 2, shortcuts: [shortcuts[0]], scripts });
    const dialog = document.querySelector('[role=dialog]')!;
    expect(button(m.atalhos_importar(), dialog).disabled).toBe(true);
    const input = dialog.querySelector<HTMLInputElement>('input[type=password]')!;
    input.value = 'own-token'; input.dispatchEvent(new Event('input', { bubbles: true })); await tick();
    expect(button(m.atalhos_importar(), dialog).disabled).toBe(false);
  });

  it('recusa prévia antiga para bundle v2 antes de permitir gravar', async () => {
    await readFile({ version: 2, shortcuts: [shortcuts[0]], scripts });
    expect(target.textContent).toContain(m.shortcut_transfer_update_required());
    expect(document.querySelector('[role=dialog]')).toBeNull();
    expect(importShortcuts).toHaveBeenCalledTimes(1);
    expect(importShortcuts).toHaveBeenCalledWith({ data: expect.anything() }, fixture.servers[0]);
    expect(reloadShortcuts).not.toHaveBeenCalled();
  });

  it('continua aceitando arquivo legado em servidor legado', async () => {
    await readFile({ version: 1, shortcuts: [shortcuts[0]] });
    const dialog = document.querySelector('[role=dialog]')!;
    expect(dialog).not.toBeNull();
    expect(button(m.atalhos_importar(), dialog).disabled).toBe(false);
  });
});
