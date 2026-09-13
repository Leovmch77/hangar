// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { mount, unmount, tick } from 'svelte';
import SyncSettings from './SyncSettings.svelte';
import { activateSync, getSyncSetup, disableSync } from '../../lib/sync';
import * as m from '../../paraglide/messages';

vi.mock('../../lib/sync', () => ({ getSyncSetup: vi.fn(), activateSync: vi.fn(), disableSync: vi.fn() }));
const server = { id: 'notebook', label: 'Notebook', baseUrl: 'https://notebook.test/?token=privado', token: 'privado' };
let component: ReturnType<typeof mount> | undefined;
async function flush() { for (let i = 0; i < 12; i++) await tick(); }
async function render() {
  component = mount(SyncSettings, { target: document.body, props: { server } });
  await flush();
}
async function fill(id: string, value: string) {
  const input = document.getElementById(id) as HTMLInputElement;
  input.value = value; input.dispatchEvent(new Event('input', { bubbles: true }));
  await flush();
}
async function submit() {
  document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await flush();
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal('crypto', webcrypto);
  vi.mocked(getSyncSetup).mockResolvedValue({ enabled: false, registered: false, user: null });
  vi.mocked(activateSync).mockResolvedValue({ enabled: true, registered: true, user: 'jefferson' });
  vi.mocked(disableSync).mockResolvedValue({ enabled: false, registered: true, user: 'jefferson' });
});
afterEach(async () => {
  if (component) await unmount(component);
  component = undefined; document.body.innerHTML = ''; vi.unstubAllGlobals();
});

it('valida a confirmação e ativa no servidor escolhido sem expor o token no endereço', async () => {
  await render();
  await fill('sync-setup-user', ' jefferson ');
  await fill('sync-setup-password', 'senha-segura');
  await fill('sync-setup-confirmation', 'outra-senha');
  await submit();
  expect(activateSync).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain(m.sync_config_senhas_diferentes());
  await fill('sync-setup-confirmation', 'senha-segura');
  await submit();
  expect(activateSync).toHaveBeenCalledWith(server, { user: 'jefferson', password: 'senha-segura' });
  expect(document.querySelector('form')).toBeNull();
  expect(document.querySelector('a')?.href).toBe('https://notebook.test/');
  expect(document.body.textContent).not.toContain('privado');
});

it('reativa um cadastro existente sem pedir nem substituir a senha', async () => {
  vi.mocked(getSyncSetup).mockResolvedValue({ enabled: false, registered: true, user: 'jefferson' });
  await render();
  expect(document.querySelector('input')).toBeNull();
  await submit();
  expect(activateSync).toHaveBeenCalledWith(server, undefined);
});

it('após falha parcial conserva o erro e consulta se a conta já existe', async () => {
  await render();
  await fill('sync-setup-user', 'jefferson');
  await fill('sync-setup-password', 'senha-segura');
  await fill('sync-setup-confirmation', 'senha-segura');
  vi.mocked(activateSync).mockRejectedValueOnce(new Error('Não foi possível ativar'));
  vi.mocked(getSyncSetup).mockResolvedValue({ enabled: false, registered: true, user: 'jefferson' });
  await submit();
  expect(getSyncSetup).toHaveBeenCalledTimes(2);
  expect(document.body.textContent).toContain('Não foi possível ativar');
  expect(document.querySelector('input')).toBeNull();
  await submit();
  expect(activateSync).toHaveBeenLastCalledWith(server, undefined);
});

it('sem criptografia segura explica HTTPS e impede criar o acesso', async () => {
  vi.stubGlobal('crypto', {});
  await render();
  expect(document.body.textContent).toContain(m.sync_config_https());
  expect(document.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true);
});

it('status indisponível oferece tentar novamente sem liberar criação às cegas', async () => {
  vi.mocked(getSyncSetup).mockRejectedValueOnce(new Error('Sem conexão'));
  await render();
  expect(document.querySelector('form')).toBeNull();
  document.querySelector<HTMLButtonElement>('button')!.click();
  await flush();
  expect(getSyncSetup).toHaveBeenCalledTimes(2);
  expect(document.querySelector('form')).not.toBeNull();
});

it('cancelar a confirmação preserva sync; confirmar desativa e permite reativar a mesma conta', async () => {
  vi.mocked(getSyncSetup).mockResolvedValue({ enabled: true, registered: true, user: 'jefferson' });
  await render();
  const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent?.trim() === label)!;
  button(m.sync_config_desativar()).click(); await flush();
  button(m.comum_cancelar()).click(); await flush();
  expect(disableSync).not.toHaveBeenCalled();
  button(m.sync_config_desativar()).click(); await flush();
  document.querySelector<HTMLButtonElement>('.btn-confirm')!.click(); await flush();
  expect(disableSync).toHaveBeenCalledWith(server);
  expect(document.body.textContent).toContain(m.sync_config_desativada());
  expect(document.querySelector('input')).toBeNull();
  await submit();
  expect(activateSync).toHaveBeenCalledWith(server, undefined);
});
