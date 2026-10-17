// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseLiveVoiceMessage, type Credencial, type LiveVoiceState, type LiveVoiceSettingsReply } from '@hangar/core';
import { LiveVoiceSheet, type LiveVoiceSheetProps, type LiveVoiceView } from './LiveVoiceSheet';
import { LiveVoiceButton } from './LiveVoiceButton';
import * as m from '../../paraglide/messages';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const native = vi.hoisted(() => ({ markdown: vi.fn() }));
vi.mock('react-native', async original => ({
  ...await original<typeof import('react-native')>(),
  Pressable: ({ children, onPress, accessibilityRole, accessibilityLabel, accessibilityState, disabled }: {
    children?: ReactNode; onPress?: () => void; accessibilityRole?: string; accessibilityLabel?: string; disabled?: boolean;
    accessibilityState?: { selected?: boolean; expanded?: boolean; busy?: boolean; disabled?: boolean };
  }) => createElement('button', { onClick: onPress, role: accessibilityRole, 'aria-label': accessibilityLabel,
    'aria-selected': accessibilityState?.selected, 'aria-expanded': accessibilityState?.expanded,
    'aria-busy': accessibilityState?.busy, disabled }, children),
}));
vi.mock('../../ui/Sheet', () => ({
  Sheet: ({ open, children, onDismiss }: { open?: boolean; children: ReactNode; onDismiss: () => void }) => open
    ? createElement('section', null, children, createElement('button', { onClick: onDismiss, 'aria-label': 'native-dismiss' }, 'native-dismiss')) : null,
}));
vi.mock('../../ui/AnchoredPanel', () => ({
  AnchoredPanel: ({ open, children }: { open: boolean; children: ReactNode }) => open
    ? createElement('div', null, children) : null,
}));
// Fronteira do renderizador nativo; não monta a árvore de bolhas do chat.
vi.mock('../../chat/AssistantBubble', () => ({ mkMarkdownStyle: () => ({ paragraph: {} }) }));
vi.mock('react-native-enriched-markdown', () => ({
  EnrichedMarkdownText: (props: { markdown: string; flavor: string }) => {
    native.markdown(props);
    return createElement('article', { 'data-renderer': 'native-markdown' });
  },
}));

const settingsReply = (): LiveVoiceSettingsReply => ({
  enabled: true, codex: true, jev: true, voices: ['voice-a', 'voice-b'], call: { active: false, client: null },
  settings: { codex_account: 'account-a', voice: 'voice-a', organizer: {
    direct: { model: 'model-a', effort: 'medium', tier: null },
    plan: { model: 'model-b', effort: 'high', tier: 'priority' },
  } },
});
const account = (id: string): Credencial => ({ id, tipo: 'codex', codex_account: id, nome: id, nome_natural: id, ativa: true, usos: [] });
const liveState = (): LiveVoiceState => ({
  phase: 'live', mode: 'direct', activity: 'idle', draft: null, error: null, plan: null,
  effective: { model: 'effective-model', effort: 'effective-effort', tier: 'default' }, context: null,
  limits: { five_hour: { used_percent: 25, resets_at: null }, seven_day: null }, backstage: [], thought: '',
  action: null, followed: [], server: 'voice-server', client: 'mobile',
});
const initialView = (): LiveVoiceView => ({
  phase: 'idle', serverLabel: 'server-fixture', state: null, error: null, muted: false, levels: { input: 0, output: 0 }, liveSince: null,
  settings: { loading: false, reply: settingsReply(), error: null, saving: false, saveError: null,
    accounts: [account('account-a'), account('account-b')],
    models: [{ id: 'model-a', efforts: ['low', 'medium'], default_effort: 'medium' }, { id: 'model-b', efforts: ['medium', 'high'] }], modelsError: null },
  memory: { loading: false, entries: [], error: null, forgetError: null },
});

let container: HTMLDivElement;
let root: Root;
let view: LiveVoiceView;
let callbacks: Omit<LiveVoiceSheetProps, 'open' | 'view' | 'servers' | 'serverId'>;
const servers = [{ id: 'server-a', label: 'server-fixture' }, { id: 'server-b', label: 'other-server' }];
let serverId: string;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-15T12:00:00Z'));
  native.markdown.mockClear();
  container = document.createElement('div');
  root = createRoot(container);
  view = initialView();
  serverId = 'server-a';
  callbacks = { onSelectServer: vi.fn(), onDismiss: vi.fn(), onStart: vi.fn(), onStop: vi.fn(), onToggleMute: vi.fn(), onMode: vi.fn(), onRetry: vi.fn(),
    onSaveSettings: vi.fn(), onSettingsOpen: vi.fn(), onForgetMemory: vi.fn() };
});
afterEach(async () => { await act(async () => root.unmount()); vi.useRealTimers(); });
const render = (open = true) => act(async () => root.render(createElement(LiveVoiceSheet, { open, view, servers, serverId, ...callbacks })));
const button = (label: string) => [...container.querySelectorAll('button')].find(el => el.getAttribute('aria-label') === label)!;
const click = (label: string) => act(async () => button(label).click());
const choose = async (title: string, option: string) => {
  const triggers = [...container.querySelectorAll<HTMLButtonElement>('button[aria-label]')]
    .filter(el => el.getAttribute('aria-label')!.startsWith(`${title}: `));
  expect(triggers).toHaveLength(1);
  await act(async () => triggers[0].click());
  await act(async () => [...container.querySelectorAll<HTMLButtonElement>('button[role="radio"]')]
    .find(el => el.getAttribute('aria-label') === option)!.click());
};

describe('LiveVoiceSheet', () => {
  it.each(['idle', 'closed'] as const)('seletor de servidor permite escolher próxima chamada em %s mesmo após erro', async phase => {
    view.phase = phase;
    if (phase === 'closed') view.error = { code: 'connection_lost' };
    await render();
    expect(button(`${m.live_voice_server()}: server-fixture`)).toBeDefined();
    await choose(m.live_voice_server(), 'other-server');
    expect(callbacks.onSelectServer).toHaveBeenCalledExactlyOnceWith('server-b');
    expect(callbacks.onStart).not.toHaveBeenCalled();
  });

  it('servidor removido após erro permite selecionar B sem oferecer A', async () => {
    view.phase = 'closed';
    view.error = { code: 'server_removed', detail: m.chat_servidor_removido() };
    await act(async () => root.render(createElement(LiveVoiceSheet, { open: true, view, servers: [servers[1]], serverId, ...callbacks })));
    const trigger = button(`${m.live_voice_server()}: server-fixture`);
    expect(trigger).toBeDefined();
    await act(async () => trigger.click());
    const options = [...container.querySelectorAll<HTMLButtonElement>('button[role="radio"]')];
    expect(options.map(option => option.getAttribute('aria-label'))).toEqual(['other-server']);
    await act(async () => options[0].click());
    expect(callbacks.onSelectServer).toHaveBeenCalledExactlyOnceWith('server-b');
    expect(callbacks.onStart).not.toHaveBeenCalled();
  });

  it.each(['connecting', 'live'] as const)('seletor de servidor fica desabilitado em %s', async phase => {
    view.phase = phase;
    await render();
    const trigger = button(`${m.live_voice_server()}: server-fixture`);
    expect(trigger).toBeDefined();
    expect(trigger.disabled).toBe(true);
    await act(async () => trigger.click());
    expect(container.querySelectorAll('button[role="radio"]')).toHaveLength(0);
    expect(callbacks.onSelectServer).not.toHaveBeenCalled();
  });

  it('seletor de servidor fecha ajustes da máquina anterior quando a escolha muda', async () => {
    await render();
    await click(m.native_live_voice_settings_memory());
    expect(button(m.native_live_voice_settings_memory()).getAttribute('aria-expanded')).toBe('true');
    serverId = 'server-b';
    view = { ...initialView(), serverLabel: 'other-server' };
    await render();
    expect(button(m.native_live_voice_settings_memory()).getAttribute('aria-expanded')).toBe('false');
    expect(button(`${m.live_voice_server()}: other-server`)).toBeDefined();
  });

  it('conserva o rótulo salvo no app antes e durante a chamada mesmo com outro nome no estado do servidor', async () => {
    view.serverLabel = 'app-server-label';
    await render();
    expect(button(`${m.live_voice_server()}: app-server-label`)).toBeDefined();
    view.state = { ...liveState(), server: 'runtime-hostname' };
    for (const phase of ['connecting', 'live'] as const) {
      view.phase = phase;
      await render();
      expect(button(`${m.live_voice_server()}: app-server-label`)).toBeDefined();
      expect(container.textContent).not.toContain('runtime-hostname');
    }
  });

  it('mostra carregamento, erro selecionável e nova tentativa antes de permitir iniciar', async () => {
    view.settings = { ...view.settings, reply: null, loading: true };
    await render();
    expect(container.textContent).toContain(m.comum_carregando());
    expect(button(m.live_voice_start())).toBeUndefined();
    view.settings = { ...view.settings, loading: false, error: 'settings-error' };
    await render();
    expect(container.textContent).toContain('settings-error');
    await click(m.sync_retry());
    expect(callbacks.onRetry).toHaveBeenCalledOnce();
    view.settings = { ...view.settings, reply: settingsReply(), error: null };
    await render();
    await click(m.live_voice_start());
    expect(callbacks.onStart).toHaveBeenCalledOnce();
  });

  it('mostra falha e nova tentativa com ajustes fechados mesmo conservando resposta anterior', async () => {
    view.settings.error = 'cached-settings-error';
    await render();
    expect(callbacks.onSettingsOpen).not.toHaveBeenCalled();
    expect(container.textContent).toContain('cached-settings-error');
    expect(button(m.live_voice_start())).toBeDefined();
    await click(m.sync_retry());
    expect(callbacks.onRetry).toHaveBeenCalledOnce();
    await click(m.native_live_voice_settings_memory());
    expect(button(`${m.live_voice_account()}: account-a`)).toBeDefined();
    expect(button(`${m.live_voice_mode_direct()}: ${m.live_voice_model()}: model-a`)).toBeDefined();
    expect(callbacks.onSaveSettings).not.toHaveBeenCalled();
  });

  it('explica Codex ausente e conta ausente sem oferecer iniciar', async () => {
    view.settings.reply = { ...settingsReply(), codex: false };
    await render();
    expect(container.textContent).toContain(m.live_voice_error_codex_missing());
    expect(button(m.live_voice_start())).toBeUndefined();
    view.settings.reply = { ...settingsReply(), enabled: false };
    await render();
    expect(container.textContent).toContain(m.live_voice_error_no_account());
    expect(button(m.live_voice_start())).toBeUndefined();
  });

  it('distingue permissões nativas de erro do navegador e conserva o detalhe recebido', async () => {
    view.phase = 'closed';
    view.error = { code: 'microphone', detail: 'device-permission-detail' };
    await render();
    expect(container.textContent).toContain(m.native_live_voice_error_microphone());
    expect(container.textContent).not.toContain(m.live_voice_error_microphone());
    expect(container.textContent).toContain('device-permission-detail');
    await click(m.sync_retry());
    expect(callbacks.onRetry).toHaveBeenCalledOnce();
  });

  it.each([
    { code: 'audio_restore', message: () => m.native_live_voice_error_audio_restore() },
    { code: 'opening_timeout', message: () => m.native_live_voice_error_opening_timeout() },
  ])('apresenta a mensagem traduzida de $code sem mostrar o código cru', async ({ code, message }) => {
    view.phase = 'closed';
    view.error = { code };
    await render();
    expect(container.textContent).toContain(message());
    expect(container.textContent).not.toContain(code);
    await click(m.sync_retry());
    expect(callbacks.onRetry).toHaveBeenCalledOnce();
  });

  it('não exibe token recebido como código de erro desconhecido', async () => {
    view.phase = 'closed';
    view.error = { code: 'token-fixture' };
    await render();
    expect(container.textContent).toContain(m.live_voice_error_failed());
    expect(container.textContent).not.toContain('token-fixture');
  });

  it('mantém mudo e encerrar acessíveis enquanto conecta e fecha a folha sem parar a chamada', async () => {
    view.phase = 'connecting';
    await render();
    expect(container.textContent).toContain(m.live_voice_connecting());
    await click(m.live_voice_mute());
    expect(callbacks.onToggleMute).toHaveBeenCalledOnce();
    view.phase = 'live';
    view.muted = true;
    await render();
    expect(button(m.live_voice_unmute()).getAttribute('aria-selected')).toBe('true');
    await click(m.native_live_voice_close());
    await click('native-dismiss');
    expect(callbacks.onDismiss).toHaveBeenCalledTimes(2);
    expect(callbacks.onStop).not.toHaveBeenCalled();
    await click(m.live_voice_stop());
    expect(callbacks.onStop).toHaveBeenCalledOnce();
  });

  it('segura o mudo durante ditado sem oferecer ativação que não teria efeito e mantém Encerrar', async () => {
    view.phase = 'live';
    view.dictating = true;
    view.state = liveState();
    await render();
    expect(button(m.native_live_voice_dictation_hold_short()).disabled).toBe(true);
    expect(button(m.live_voice_unmute())).toBeUndefined();
    expect(container.textContent).toContain(m.native_live_voice_dictation_hold());
    expect(container.textContent).toContain(m.codex_voice_muted());
    await click(m.native_live_voice_dictation_hold_short());
    expect(callbacks.onToggleMute).not.toHaveBeenCalled();
    await click(m.live_voice_stop());
    expect(callbacks.onStop).toHaveBeenCalledOnce();
  });

  it('troca somente o modo pelo callback e segue a seleção recebida do servidor', async () => {
    view.phase = 'live';
    view.state = liveState();
    await render();
    expect(button(m.live_voice_mode_direct()).getAttribute('aria-selected')).toBe('true');
    await click(m.live_voice_mode_plan());
    expect(callbacks.onMode).toHaveBeenCalledWith('planejar');
    expect(callbacks.onStart).not.toHaveBeenCalled();
    expect(callbacks.onSaveSettings).not.toHaveBeenCalled();
    expect(button(m.live_voice_mode_direct()).getAttribute('aria-selected')).toBe('true');
    view.state = { ...view.state, mode: 'plan' };
    await render();
    expect(button(m.live_voice_mode_plan()).getAttribute('aria-selected')).toBe('true');
  });

  it('não inventa modo nem atividade em enums futuros e conserva a chamada e seus controles', async () => {
    const message = parseLiveVoiceMessage(JSON.stringify({ type: 'state', state: { ...liveState(),
      mode: 'future-mode', activity: 'future-activity', draft: 'draft-fixture',
      backstage: [{ kind: 'future-backstage', text: 'backstage-fixture' }],
      action: { kind: 'future-action', text: 'action-fixture' }, progress: 'progress-fixture', thought: 'thought-fixture' } }));
    if (message?.type !== 'state') throw new Error('missing-state');
    view.phase = 'live';
    view.state = message.state;
    await render();
    expect(button(m.live_voice_mode_direct())).toBeUndefined();
    expect(button(m.live_voice_mode_plan())).toBeUndefined();
    expect(container.textContent).toContain(m.codex_voice_listening());
    for (const text of ['draft-fixture', 'backstage-fixture', 'effective-model', '25%']) expect(container.textContent).toContain(text);
    for (const text of ['action-fixture', 'progress-fixture', 'thought-fixture', 'future-mode', 'future-activity'])
      expect(container.textContent).not.toContain(text);
    expect(button(m.live_voice_mute()).disabled).toBe(false);
    expect(button(m.live_voice_stop()).disabled).toBe(false);
    await click(m.live_voice_mute());
    expect(callbacks.onToggleMute).toHaveBeenCalledOnce();
    await click(m.live_voice_stop());
    expect(callbacks.onStop).toHaveBeenCalledOnce();
    expect(callbacks.onMode).not.toHaveBeenCalled();
    view.state = { ...message.state, mode: 'plan' };
    await render();
    expect(button(m.live_voice_mode_plan()).getAttribute('aria-selected')).toBe('true');
  });

  it('conserva os textos de ação e bastidores sem exigir categoria reconhecida', async () => {
    const message = parseLiveVoiceMessage(JSON.stringify({ type: 'state', state: { ...liveState(), activity: 'working',
      backstage: [{ kind: 'future-backstage', text: 'backstage-fixture' }], action: { kind: 'future-action', text: 'action-fixture' } } }));
    if (message?.type !== 'state') throw new Error('missing-state');
    view.phase = 'live';
    view.state = message.state;
    await render();
    expect(container.textContent).toContain(m.live_voice_status_working());
    expect(container.textContent).toContain('backstage-fixture');
    expect(container.textContent).toContain('action-fixture');
    expect(container.textContent).not.toContain('future-backstage');
    expect(container.textContent).not.toContain('future-action');
  });

  it('entrega plano ao renderizador Markdown e mostra pedido, atividade, seguidas e escolhas efetivas', async () => {
    const markdown = '# plan-fixture\n\n- **step-fixture**';
    view.phase = 'live';
    view.state = { ...liveState(), plan: { path: '/plan-fixture.md', markdown }, draft: 'held-request',
      activity: 'working', action: { kind: 'tool', text: 'tool-action' }, progress: 'step-progress', thought: '**thought-tail**',
      error: { code: 'state-error', text: 'state-error-detail' },
      backstage: [{ kind: 'heard', text: 'heard-fixture' }], followed: [{ server: 'peer-fixture', name: 'session-fixture' }] };
    await render();
    expect(native.markdown).toHaveBeenCalledWith(expect.objectContaining({ markdown, flavor: 'github' }));
    expect(container.querySelector('[data-renderer="native-markdown"]')).not.toBeNull();
    expect(container.textContent).not.toContain(markdown);
    for (const data of ['held-request', 'tool-action', 'step-progress', 'thought-tail', 'state-error-detail',
      'heard-fixture', 'peer-fixture::session-fixture', 'effective-model', 'effective-effort', '25%']) {
      expect(container.textContent).toContain(data);
    }
    expect(container.textContent).not.toContain('model-a');
  });

  it('mostra tempo somente ao vivo e retoma o início original ao reabrir a folha', async () => {
    view.phase = 'live';
    view.liveSince = Date.now();
    await render();
    expect(container.textContent).toContain('00:00');
    await act(async () => vi.advanceTimersByTime(2000));
    expect(container.textContent).toContain('00:02');
    await render(false);
    await act(async () => vi.advanceTimersByTime(3000));
    expect(container.textContent).toBe('');
    await render();
    expect(container.textContent).toContain('00:05');
    view.phase = 'closed';
    await render();
    expect(container.textContent).not.toContain('00:05');
  });

  it('abre catálogo e memória só por ação explícita e salva o objeto inteiro sem alterar os campos antes da resposta', async () => {
    await render();
    expect(callbacks.onSettingsOpen).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain(m.live_voice_memory_title());
    await click(m.native_live_voice_settings_memory());
    expect(callbacks.onSettingsOpen).toHaveBeenCalledOnce();
    expect(container.textContent).toContain(m.native_live_voice_next_call());
    const saved = settingsReply().settings;
    await choose(m.live_voice_account(), 'account-b');
    expect(callbacks.onSaveSettings).toHaveBeenLastCalledWith({ ...saved, codex_account: 'account-b' });
    expect(button(`${m.live_voice_account()}: account-a`)).toBeDefined();
    await choose(`${m.live_voice_mode_plan()}: ${m.live_voice_model()}`, 'model-a');
    expect(callbacks.onSaveSettings).toHaveBeenLastCalledWith({ ...saved, organizer: { ...saved.organizer,
      plan: { ...saved.organizer.plan, model: 'model-a', effort: 'medium' } } });
    expect(view.settings.reply?.settings).toEqual(saved);
    view.settings.saving = true;
    await render();
    expect(button(`${m.live_voice_account()}: account-a`).disabled).toBe(true);
    await click(`${m.live_voice_account()}: account-a`);
    expect(container.querySelectorAll('button[role="radio"]')).toHaveLength(0);
    expect(callbacks.onSaveSettings).toHaveBeenCalledTimes(2);
    view.settings.saving = false;
    view.settings.saveError = 'save-failed';
    await render();
    expect(container.textContent).toContain('save-failed');
    expect(button(`${m.live_voice_account()}: account-a`).disabled).toBe(false);
    await click(m.native_live_voice_reload_settings_memory());
    expect(callbacks.onSettingsOpen).toHaveBeenCalledTimes(2);
  });

  it.each([
    { current: 'medium', efforts: ['low', 'medium'], defaultEffort: 'low', expected: 'medium' },
    { current: 'high', efforts: ['low', 'medium'], defaultEffort: 'unknown-effort', expected: 'low' },
    { current: 'high', efforts: undefined, defaultEffort: null, expected: 'high' },
  ])('troca de modelo conserva esforço válido ou desconhecido e só usa opção suportada ($expected)', async ({ current, efforts, defaultEffort, expected }) => {
    view.settings.reply!.settings.organizer.plan.effort = current;
    view.settings.models = [{ id: 'model-new', efforts, default_effort: defaultEffort }];
    await render();
    await click(m.native_live_voice_settings_memory());
    await choose(`${m.live_voice_mode_plan()}: ${m.live_voice_model()}`, 'model-new');
    const saved = view.settings.reply!.settings;
    expect(callbacks.onSaveSettings).toHaveBeenCalledWith({ ...saved, organizer: { ...saved.organizer,
      plan: { ...saved.organizer.plan, model: 'model-new', effort: expected } } });
    expect(button(`${m.live_voice_mode_plan()}: ${m.live_voice_model()}: model-b`)).toBeDefined();
  });

  it('catálogo vazio ou com erro conserva conta, modelo, esforço, velocidade e voz atuais', async () => {
    view.settings.accounts = [];
    view.settings.models = [];
    view.settings.reply!.voices = [];
    await render();
    await click(m.native_live_voice_settings_memory());
    expect(container.textContent).toContain(m.native_live_voice_accounts_empty());
    expect(container.textContent).toContain(m.native_live_voice_models_empty());
    expect(button(`${m.live_voice_account()}: account-a`)).toBeDefined();
    expect(button(`${m.live_voice_voice()}: voice-a`)).toBeDefined();
    expect(button(`${m.live_voice_mode_plan()}: ${m.live_voice_model()}: model-b`)).toBeDefined();
    expect(button(`${m.live_voice_mode_plan()}: ${m.live_voice_effort()}: high`)).toBeDefined();
    view.settings.modelsError = 'catalog-error';
    view.settings.error = 'accounts-error';
    await render();
    expect(container.textContent).toContain(m.comum_falha_carregar_modelos());
    expect(container.textContent).toContain('catalog-error');
    expect(container.textContent).toContain('accounts-error');
    expect(callbacks.onSaveSettings).not.toHaveBeenCalled();
  });

  it('memória trata carregamento, vazio, falha e esquecimento pelo id sem remover a entrada antes da resposta', async () => {
    view.memory.loading = true;
    await render();
    await click(m.native_live_voice_settings_memory());
    expect(container.textContent).toContain(m.comum_carregando());
    expect(container.textContent).not.toContain(m.live_voice_memory_empty());
    view.memory.loading = false;
    await render();
    expect(container.textContent).toContain(m.live_voice_memory_empty());
    view.memory.entries = [{ id: 'memory-id', kind: 'preferencia', text: 'memory-fixture', learned: 'learned-fixture', confirmed: 'confirmed-fixture' }];
    view.memory.error = 'memory-read-error';
    view.memory.forgetError = 'memory-forget-error';
    await render();
    expect(container.textContent).toContain(m.live_voice_memory_error());
    expect(container.textContent).toContain(m.live_voice_memory_forget_failed());
    expect(container.textContent).toContain(m.live_voice_memory_kind_preferencia());
    expect(container.textContent).toContain('memory-read-error');
    expect(container.textContent).toContain('memory-forget-error');
    await click(m.live_voice_memory_forget({ text: 'memory-fixture' }));
    expect(callbacks.onForgetMemory).toHaveBeenCalledWith('memory-id');
    expect(container.textContent).toContain('memory-fixture');
  });
});

describe('LiveVoiceButton', () => {
  it('respeita visibilidade e abre pelo callback, sem iniciar ou encerrar chamadas por conta própria', async () => {
    const props = { phase: 'idle' as const, muted: false, levels: { input: 0, output: 0 }, error: false, visible: false, onPress: vi.fn() };
    await act(async () => root.render(createElement(LiveVoiceButton, props)));
    expect(container.textContent).toBe('');
    await act(async () => root.render(createElement(LiveVoiceButton, { ...props, visible: true })));
    await act(async () => container.querySelector('button')!.click());
    expect(props.onPress).toHaveBeenCalledOnce();
  });

  it('expõe conectando, ao vivo, mudo e erro sem anunciar valores dos níveis', async () => {
    const props = { phase: 'connecting' as const, muted: false, levels: { input: 0.6, output: 0.4 }, error: false, visible: true, onPress: vi.fn() };
    await act(async () => root.render(createElement(LiveVoiceButton, props)));
    expect(container.querySelector('button')!.getAttribute('aria-busy')).toBe('true');
    expect(container.querySelector('button')!.getAttribute('aria-label')).toContain(m.live_voice_connecting());
    await act(async () => root.render(createElement(LiveVoiceButton, { ...props, phase: 'live', muted: true })));
    expect(container.querySelector('button')!.getAttribute('aria-label')).toContain(m.codex_voice_muted());
    expect(container.textContent).not.toContain('0.6');
    await act(async () => root.render(createElement(LiveVoiceButton, { ...props, phase: 'closed', error: true })));
    expect(container.textContent).toContain(m.native_live_voice_error_short());
    expect(container.querySelector('button')!.getAttribute('aria-label')).toContain(m.live_voice_error_failed());
  });
});
