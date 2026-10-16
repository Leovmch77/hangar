// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Motor, Server } from '@hangar/core';
import { overwriteGetLocale } from '../../paraglide/runtime';
import { EngineEditor } from './EngineEditor';

const calls = vi.hoisted(() => ({ put: vi.fn() }));
vi.mock('@hangar/core', async original => ({ ...await original<typeof import('@hangar/core')>(), putEngineForServer: calls.put }));
vi.mock('../../ui/Sheet', () => ({ Sheet: ({ children, open }: { children: ReactNode; open?: boolean }) => open === false ? null : createElement('div', { role: 'dialog' }, children) }));
vi.mock('react-native', async original => ({
  ...await original<typeof import('react-native')>(),
  TextInput: (props: { accessibilityLabel: string; value: string; editable?: boolean; secureTextEntry?: boolean; onChangeText: (value: string) => void }) => createElement('textarea', {
    'aria-label': props.accessibilityLabel, 'data-secure': props.secureTextEntry, value: props.value, disabled: props.editable === false,
    onInput: (event: { currentTarget: { value: string } }) => props.onChangeText(event.currentTarget.value),
  }),
  Switch: (props: { accessibilityLabel: string; value: boolean; disabled?: boolean; onValueChange: (v: boolean) => void }) => createElement('input', {
    type: 'checkbox', 'aria-label': props.accessibilityLabel, checked: props.value, disabled: props.disabled,
    onChange: (event: { currentTarget: { checked: boolean } }) => props.onValueChange(event.currentTarget.checked),
  }),
}));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
overwriteGetLocale(() => 'pt');
const server: Server = { id: 'b', label: 'B', baseUrl: 'https://b.local', token: 'token-b' };
const existing: Motor = { base_url: 'https://provider.example/v1', model: 'model-a', label: 'Meu motor',
  api_key: 'sk-••••1234', api_key_definida: true, context_window: 200000, subagent_model: 'small', vision: false,
  auto_compact_window: 170000, max_output_tokens: 10000, prompt_caching: false, adaptive_thinking: true };
const roots: Array<ReturnType<typeof createRoot>> = [];
beforeEach(() => { calls.put.mockReset(); calls.put.mockResolvedValue({ motores: {} }); });
afterEach(async () => { for (const root of roots.splice(0)) await act(async () => root.unmount()); });
function input(container: HTMLElement, label: string) { return container.querySelector<HTMLTextAreaElement>(`textarea[aria-label="${label}"]`)!; }
async function fill(container: HTMLElement, label: string, value: string) {
  const target = input(container, label); expect(target, label).toBeTruthy();
  await act(async () => { target.value = value; target.dispatchEvent(new Event('input', { bubbles: true })); });
}
async function click(container: HTMLElement, label: string) {
  const target = [...container.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === label)!;
  expect(target, label).toBeTruthy(); await act(async () => target.click());
}
async function show(engine?: Motor, names = ['saved']) {
  const container = document.createElement('div'); const root = createRoot(container); roots.push(root);
  const onSaved = vi.fn(); const onClose = vi.fn();
  await act(async () => root.render(createElement(EngineEditor, { server, name: engine ? 'saved' : undefined, engine, names, onSaved, onClose })));
  return { container, root, onSaved, onClose };
}
async function validNew(container: HTMLElement) {
  await fill(container, 'Identificador', 'new-engine');
  await fill(container, 'Nome de exibição', 'Novo motor');
  await fill(container, 'URL do provedor', 'https://provider.example/v1');
  await fill(container, 'Chave de API', 'secret-new');
  await fill(container, 'Modelo', 'main-model');
}

describe('editor de motores', () => {
  it('cria só na máquina escolhida com os campos e capacidades suportados', async () => {
    const view = await show();
    expect(view.container.querySelector('[role="dialog"]')).toBeTruthy();
    await validNew(view.container);
    expect(input(view.container, 'Chave de API').getAttribute('data-secure')).toBe('true');
    await fill(view.container, 'Modelo dos subagentes', 'small');
    await fill(view.container, 'Janela de contexto', '200000');
    await fill(view.container, 'Janela de compactação', '170000');
    await fill(view.container, 'Máximo de tokens de saída', '12000');
    await click(view.container, 'Salvar motor');
    expect(calls.put).toHaveBeenCalledWith(server, 'new-engine', {
      label: 'Novo motor', base_url: 'https://provider.example/v1', api_key: 'secret-new', model: 'main-model', subagent_model: 'small',
      context_window: 200000, auto_compact_window: 170000, max_output_tokens: 12000,
      bundled_skills: false, experimental_betas: false, prompt_caching: true, adaptive_thinking: true,
      tool_search: false, gateway_model_discovery: false, fine_grained_tool_streaming: false, auth_via_api_key: false,
    });
    expect(view.onSaved).toHaveBeenCalledTimes(1);
  });

  it('editar conserva o identificador, nunca manda máscara como chave e limpa opcionais vazios', async () => {
    const view = await show(existing);
    expect(input(view.container, 'Identificador')?.disabled).toBe(true);
    expect([...view.container.querySelectorAll('button')].some(b => b.getAttribute('aria-label') === 'Visão: automática')).toBe(false);
    expect(input(view.container, 'Chave de API').value).toBe('');
    expect(view.container.textContent).not.toContain('sk-••••1234');
    for (const label of ['Modelo dos subagentes', 'Janela de contexto', 'Janela de compactação', 'Máximo de tokens de saída']) await fill(view.container, label, '');
    await click(view.container, 'Salvar motor');
    const [target, name, payload] = calls.put.mock.calls[0];
    expect(target).toEqual(server); expect(name).toBe('saved');
    expect(payload).not.toHaveProperty('api_key');
    expect(payload).toMatchObject({ subagent_model: '', context_window: '', auto_compact_window: '', max_output_tokens: '', vision: false, prompt_caching: false });
  });

  it.each([
    ['Identificador', '', 'obrigatórios'], ['Identificador', 'saved', 'já existe'],
    ['URL do provedor', 'ftp://provider.example', 'HTTP'], ['URL do provedor', 'https://user:pass@provider.example', 'HTTP'],
    ['Janela de contexto', '0', 'inteiros positivos'], ['Janela de compactação', '-4', 'inteiros positivos'],
    ['Máximo de tokens de saída', '1.5', 'inteiros positivos'], ['Modelo', '', 'obrigatórios'],
    ['Chave de API', '', 'obrigatórios'],
  ])('recusa %s=%s antes de gravar', async (label, value, reason) => {
    const view = await show(); await validNew(view.container); await fill(view.container, label, value);
    await click(view.container, 'Salvar motor');
    expect(calls.put).not.toHaveBeenCalled();
    expect(view.container.querySelector('[role="alert"]')?.textContent).toContain(reason);
  });

  it('conserva o rascunho e o motivo da falha, sem repetir escrita automaticamente', async () => {
    calls.put.mockRejectedValue(new Error('provider refused'));
    const view = await show(existing);
    await fill(view.container, 'Modelo', 'changed'); await fill(view.container, 'Chave de API', 'real-key');
    await click(view.container, 'Salvar motor');
    expect(view.container.textContent).toContain('provider refused');
    expect(input(view.container, 'Modelo').value).toBe('changed');
    expect(calls.put).toHaveBeenCalledTimes(1);
    expect(calls.put.mock.calls[0][2].api_key).toBe('real-key');
    expect(view.onSaved).not.toHaveBeenCalled();
  });

  it('trava duplo toque e descarta conclusão depois de sair da máquina', async () => {
    let done!: (value: { motores: Record<string, Motor> }) => void;
    calls.put.mockImplementation(() => new Promise(resolve => { done = resolve; }));
    const view = await show(existing);
    const save = [...view.container.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === 'Salvar motor')!;
    expect(save).toBeTruthy();
    await act(async () => { save.click(); save.click(); });
    expect(calls.put).toHaveBeenCalledTimes(1);
    await act(async () => view.root.unmount()); roots.splice(roots.indexOf(view.root), 1);
    await act(async () => done({ motores: {} }));
    expect(view.onSaved).not.toHaveBeenCalled();
  });
});
