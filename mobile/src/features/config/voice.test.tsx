// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CampoConfig } from '@hangar/core';
import Voice from '../../../app/config/voice';
import * as m from '../../paraglide/messages';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const calls = vi.hoisted(() => ({ get: vi.fn(), patch: vi.fn() }));
const server = { id: 'voice-server', label: 'voice-fixture', baseUrl: 'https://voice.test', token: 'fixture' };

vi.mock('../../stores/servers', () => ({
  useServers: (selector: (state: { active: () => typeof server }) => unknown) => selector({ active: () => server }),
}));
vi.mock('@hangar/core', async (original) => ({
  ...await original<typeof import('@hangar/core')>(),
  getConfigForServer: calls.get,
  patchConfigForServer: calls.patch,
}));
vi.mock('react-native', async (original) => ({
  ...await original<typeof import('react-native')>(),
  TextInput: ({ value, onChangeText, accessibilityLabel, editable }: {
    value?: string; onChangeText?: (value: string) => void; accessibilityLabel?: string; editable?: boolean;
  }) => createElement('input', { value, 'aria-label': accessibilityLabel, disabled: editable === false,
    onInput: (event: { currentTarget: { value: string } }) => onChangeText?.(event.currentTarget.value) }),
  Switch: ({ value, onValueChange, accessibilityLabel, disabled }: {
    value: boolean; onValueChange: (value: boolean) => void; accessibilityLabel: string; disabled: boolean;
  }) => createElement('button', { role: 'switch', 'aria-label': accessibilityLabel, 'aria-checked': value, disabled,
    onClick: () => onValueChange(!value) }),
}));
vi.mock('@react-native-menu/menu', () => ({ MenuView: ({ children }: { children: ReactNode }) => children }));
vi.mock('../../ui/Icon', () => ({ Icon: () => null }));
vi.mock('./Pagina', () => ({ Pagina: ({ children }: { children: ReactNode }) => createElement('main', null, children) }));
vi.mock('./Slider', () => ({ Slider: () => null }));
vi.mock('./TranscriptionProviders', () => ({ TranscriptionProviders: () => null }));

let root: Root;
let container: HTMLDivElement;
let fields: Record<string, CampoConfig>;

beforeEach(() => {
  calls.get.mockReset();
  calls.patch.mockReset();
  fields = Object.fromEntries(Object.entries({
    dictation_organization_mode: 'none', dictation_claude_model: 'claude-old', dictation_codex_model: 'codex-old',
    dictation_include_recent_messages: false, ditado_estilo: 'limpar', ditado_vocabulario: '',
    groq_api_key: '', transcription_base_url: '', transcription_model: '',
    llm_base_url: 'https://organization.test', llm_api_key: 'masked-key', llm_model: 'api-old', llm_reasoning_effort: '',
    llm_briefing_base_url: '', llm_briefing_api_key: '', llm_briefing_model: '',
    elevenlabs_api_key: '', tts_local_cmd: '', tts_max_chars: 1000,
  }).map(([key, valor]) => [key, { valor, origem: 'app', definido: key === 'llm_api_key' }]));
  calls.get.mockImplementation(async () => ({ campos: fields }));
  calls.patch.mockImplementation(async (_server, payload: Record<string, CampoConfig['valor']>) => {
    fields = { ...fields, ...Object.fromEntries(Object.entries(payload).map(([key, valor]) => [key, { ...fields[key], valor }])) };
    return { campos: fields };
  });
  container = document.createElement('div');
  root = createRoot(container);
});

afterEach(async () => { await act(async () => root.unmount()); });

const input = (label: string) => [...container.querySelectorAll('input')].find((el) => el.getAttribute('aria-label') === label);
const button = (label: string) => [...container.querySelectorAll('button')].find((el) => el.textContent === label
  || el.getAttribute('aria-label') === label || el.getAttribute('aria-label')?.startsWith(`${label}.`))!;
const click = (label: string) => act(async () => button(label).click());
const edit = (label: string, value: string) => act(async () => {
  const el = input(label)!;
  el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
});
const render = () => act(async () => root.render(createElement(Voice)));

describe('organização do ditado na tela de Voz', () => {
  it('parte desligada, muda pelo rascunho e salva modelos, estilo e referência do harness', async () => {
    await render();
    expect(container.textContent).toContain(m.native_voice_transcribe());
    expect(container.textContent).toContain(m.native_voice_read());
    expect(container.textContent).not.toContain(m.native_voice_style());
    expect(container.textContent).not.toContain(m.native_voice_recent_messages());
    expect(input(m.native_voice_harness_model_claude())).toBeUndefined();
    expect(input(m.native_voice_llm_endpoint())).toBeUndefined();
    expect(container.textContent).not.toContain(m.native_voice_briefing_own());

    await click(m.native_voice_organization_harness());
    expect(calls.patch).not.toHaveBeenCalled();
    expect(fields.dictation_organization_mode.valor).toBe('none');
    expect(input(m.native_voice_harness_model_claude())?.value).toBe('claude-old');
    expect(input(m.native_voice_harness_model_codex())?.value).toBe('codex-old');
    expect(container.textContent).toContain(m.native_voice_organization_harness_hint());
    expect(input(m.native_voice_llm_endpoint())).toBeUndefined();
    expect(container.textContent).not.toContain(m.native_voice_briefing_own());
    await edit(m.native_voice_harness_model_claude(), 'claude-new');
    await edit(m.native_voice_harness_model_codex(), 'codex-new');
    await click(m.native_voice_recent_messages());
    await click(m.native_voice_style_briefing());
    await click(m.native_server_save());
    expect(calls.patch).toHaveBeenCalledWith(server, {
      dictation_organization_mode: 'harness', dictation_claude_model: 'claude-new', dictation_codex_model: 'codex-new',
      dictation_include_recent_messages: true, ditado_estilo: 'briefing',
    });
  });

  it('API externa mostra só sua configuração e briefing; desligar esconde a organização antes de salvar', async () => {
    fields.dictation_organization_mode.valor = 'harness';
    await render();
    await click(m.native_voice_organization_external_api());
    expect(input(m.native_voice_harness_model_claude())).toBeUndefined();
    expect(input(m.native_voice_harness_model_codex())).toBeUndefined();
    expect(input(m.native_voice_llm_endpoint())?.value).toBe('https://organization.test');
    await edit(m.native_voice_llm_model(), 'api-new');
    await edit(m.native_voice_llm_key(), 'new-key');
    await click(m.native_voice_briefing_own());
    await edit(m.native_voice_briefing_model(), 'briefing-new');
    await click(m.native_server_save());
    expect(calls.patch).toHaveBeenLastCalledWith(server, {
      dictation_organization_mode: 'external_api', llm_model: 'api-new', llm_api_key: 'new-key', llm_briefing_model: 'briefing-new',
    });

    await click(m.native_voice_organization_none());
    expect(input(m.native_voice_llm_endpoint())).toBeUndefined();
    expect(input(m.native_voice_briefing_model())).toBeUndefined();
    expect(container.textContent).not.toContain(m.native_voice_style());
    expect(container.textContent).not.toContain(m.native_voice_recent_messages());
    expect(container.textContent).not.toContain(m.native_voice_briefing_own());
    expect(container.textContent).toContain(m.native_voice_transcribe());
    expect(container.textContent).toContain(m.native_voice_elevenlabs_section());
    expect(container.textContent).toContain(m.native_voice_local_section());
    await click(m.native_server_save());
    expect(calls.patch).toHaveBeenLastCalledWith(server, { dictation_organization_mode: 'none' });
  });

  it('não grava campos que um servidor antigo não trouxe', async () => {
    delete fields.dictation_organization_mode;
    await render();
    expect(button(m.native_voice_organization_harness()).disabled).toBe(true);
    await click(m.native_voice_organization_harness());
    expect(input(m.native_voice_harness_model_claude())).toBeUndefined();
    expect(calls.patch).not.toHaveBeenCalled();
  });
});
