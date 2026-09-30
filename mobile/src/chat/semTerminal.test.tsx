// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FirstConversationAttempt } from '@hangar/core';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async (original) => ({
  ...await original<object>(),
  AppState: { currentState: 'active', addEventListener: () => ({ remove: () => {} }) },
}));

const routerPush = vi.hoisted(() => vi.fn());
const route = vi.hoisted(() => ({ params: { server: 's1', name: 'sess' }, segments: ['s'] }));
vi.mock('expo-router', () => ({
  useRouter: () => ({ push: routerPush, back: vi.fn(), replace: vi.fn() }),
  useLocalSearchParams: () => route.params, useSegments: () => route.segments,
}));
vi.mock('@hangar/core', async (original) => ({
  ...await original<typeof import('@hangar/core')>(),
  fetchSessionsForServer: async () => [{ name: 'sess', provider: 'claude' }],
}));
vi.mock('../stores/servers', () => {
  const state = { ready: true, servers: [{ id: 's1' }, { id: 's2' }], ensureActive: () => true };
  return { useServers: Object.assign((select: (s: typeof state) => unknown) => select(state), { getState: () => state }) };
});
vi.mock('../ui/Screen', () => ({ Screen: ({ children }: { children: ReactNode }) => createElement('div', null, children) }));
vi.mock('react-native-keyboard-controller', () => ({ KeyboardAvoidingView: ({ children }: { children: ReactNode }) => createElement('div', null, children) }));
vi.mock('./LoopChip', () => ({ LoopChip: () => null }));
vi.mock('../features/plan/PlanChip', () => ({ PlanChip: () => null }));
vi.mock('./OrqFooter', () => ({ OrqFooter: () => null }));
vi.mock('./TuiPill', () => ({ TuiPill: () => null }));
vi.mock('./RecarregarPill', () => ({ RecarregarPill: () => null }));
vi.mock('./PendingPlan', () => ({ PendingPlan: () => null }));
vi.mock('./SessionProblem', () => ({ SessionProblem: () => null }));
vi.mock('./StatsStrip', () => ({ StatsStrip: () => null }));
vi.mock('./SessionPickerSheet', () => ({ SessionPickerSheet: () => null }));
vi.mock('../features/create/CreateSessionSheet', () => ({ CreateSessionSheet: () => createElement('div', { 'data-create': true }) }));
vi.mock('../ui/Icon', () => ({ Icon: () => null }));
vi.mock('../ui/Sheet', () => ({ Sheet: ({ children }: { children: ReactNode }) => createElement('div', null, children) }));
vi.mock('../features/sessions/StatePill', () => ({ StatePill: () => null }));
vi.mock('./ContextRing', () => ({ ContextRing: () => null }));
// Cada chave devolve o próprio nome, como nos outros testes de componente do app.
vi.mock('../paraglide/messages', () => Object.fromEntries(
  ('arq_aba askq_sua_resposta bastao_dossie_sub bastao_dossie_titulo chat_voltar_sessoes codex_limites_titulo ctx_anexos ctx_atividade ctx_grupo ctx_limites ctx_repositorio ctx_terminal modo_so_ociosa more_fotos_videos_arquivos more_tarefas_agentes navbar_mais_acoes par_titulo recarregar_sessao recarregar_sessao_detalhe sessao_trocar_de term_titulo '
    + 'askq_enviando board_arquivo board_imagem board_remover_anexo codex_orientar composer_anexar_arquivo composer_desfazer_limpeza composer_ditado_limpo composer_enviando_cancelar composer_enviar_mensagem composer_fila_acao composer_fila_aria composer_fila_contagem composer_gravando_audio composer_gravar_audio composer_mandando_grupo composer_mandar_grupo composer_mandar_tambem composer_mensagem composer_parar composer_parar_gravacao composer_pro_grupo composer_pros_dois composer_sessao_trabalhando composer_transcrevendo_audio composer_transcrever_de_novo')
    .concat(' permissao_pedido comum_cancelar msg_aria_mensagens chat_plan_proposto composer_falha_envio nova_conversa_envio_incerto nova_conversa_resultado_salvar_erro')
    .concat(' askq_enviando board_falha_envio board_falha_upload chat_chegou_mas chat_envio_incerto chat_nao_chegou_em chat_servidor_removido codex_orientar_recebido codex_orientar_sem_envio composer_ditado_anterior composer_ditado_aplicado composer_ditado_indisponivel composer_ditado_interrompido composer_ditado_recuperavel composer_draft_read_again composer_draft_recover_attach_busy composer_falha_gravacao composer_falha_transcricao composer_fila_erro composer_sem_acesso_fotos composer_sem_acesso_mic composer_submission_check composer_submission_rejected composer_submission_sending composer_transcrever_de_novo composer_transcricao_vazia')
    .concat(' draft_read_error draft_invalid draft_write_error draft_clear_error composer_draft_previous composer_draft_recover composer_draft_discard composer_draft_read_again').split(' ').map((k) => [k, () => k]),
));

// Rascunho em memória no lugar do MMKV; cada teste começa sem nada guardado.
const storage = vi.hoisted(() => ({ memory: new Map<string, string>(), failSet: false }));
vi.mock('react-native-mmkv', () => ({
  createMMKV: () => ({
    getString: (key: string) => storage.memory.get(key),
    set: (key: string, value: string) => {
      if (storage.failSet) throw new Error('storage unavailable');
      storage.memory.set(key, value);
    },
    remove: (key: string) => { storage.memory.delete(key); },
    getNumber: () => undefined, getBoolean: () => undefined, contains: (key: string) => storage.memory.has(key),
  }),
}));
beforeEach(() => { storage.memory.clear(); storage.failSet = false; sessionsState.rows = []; });

const sessionsState = vi.hoisted(() => ({ rows: [] as { serverId: string; name: string; jsonl?: string | null }[], byServerRecord: {} }));

// Composer isolado: sem picker, pills, ditado nem store real — só o que decide o botão Parar.
const composerChat = vi.hoisted(() => ({ state: 'idle' as string, send: vi.fn(async (_text: string) => {}) }));
vi.mock('expo-image-picker', () => ({}));
vi.mock('expo-document-picker', () => ({}));
vi.mock('./draftAttachments', () => ({
  retainDraftAttachment: vi.fn(async (attachment: import('../stores/drafts').DraftAttachment) => attachment),
  removeDraftAttachment: vi.fn(),
}));
vi.mock('../ui/Glass', () => ({ Glass: ({ children }: { children: ReactNode }) => createElement('div', null, children) }));
vi.mock('../ui/MultilineInput', () => ({ MultilineInput: ({ value, onChangeText }: { value: string; onChangeText: (text: string) => void }) =>
  createElement('textarea', { value, readOnly: true, onInput: (e: { currentTarget: { value: string } }) => onChangeText(e.currentTarget.value) }),
}));
vi.mock('../features/pills/ModelPill', () => ({ ModelPill: () => null }));
vi.mock('../features/pills/EffortPill', () => ({ EffortPill: () => null }));
vi.mock('../features/pills/PermissionPill', () => ({ PermissionPill: () => null }));
vi.mock('../features/pills/PillMenu', () => ({ PillMenu: () => null }));
vi.mock('../features/ditado/EstiloPill', () => ({ EstiloPill: () => null }));
vi.mock('../features/ditado/useDitado', () => ({ useDitado: () => ({ gravando: false, rms: 0, iniciar: () => {}, parar: () => {} }) }));
vi.mock('../features/ditado/ditadoEstiloStore', () => ({ useDitadoEstiloStore: { getState: () => ({ pronto: false }) } }));
vi.mock('./CommandSheet', () => ({ CommandSheet: () => null }));
vi.mock('../stores/sessions', () => ({
  useSessions: (sel: (s: unknown) => unknown) => sel(sessionsState),
}));
vi.mock('../stores/chat', () => {
  const snap = () => ({ pending: [], events: [], stateEvent: { state: composerChat.state } });
  const use = Object.assign((sel: (s: unknown) => unknown) => sel(snap()), {
    getState: snap, setState: () => {}, subscribe: () => () => {},
  });
  return { chatStore: () => ({ use, send: composerChat.send, retain: () => {}, release: () => {}, retry: () => {} }), filaCount: () => 0, isSubmitting: () => false };
});

const firstInput = vi.hoisted(() => ({
  attempt: null as FirstConversationAttempt | null,
  send: vi.fn<(serverId: string, id: string) => Promise<void>>(),
  confirm: vi.fn(),
}));
vi.mock('../stores/newConversation', () => ({
  useNewConversation: Object.assign((select: (state: unknown) => unknown) => select({
    attempts: firstInput.attempt ? { s1: firstInput.attempt } : {}, issues: {}, busy: {},
  }), { getState: () => ({ attempts: firstInput.attempt ? { s1: firstInput.attempt } : {}, issues: {} }) }),
  readFirstInput: (serverId: string, name: string) => firstInput.attempt?.serverId === serverId
    && firstInput.attempt.sessionName === name ? firstInput.attempt : null,
  confirmFirstInput: firstInput.confirm,
  sendFirstInput: firstInput.send,
}));

// Lista isolada: a bolha só registra o texto recebido, pra provar o que chega nela.
const bubbleTexts = vi.hoisted(() => [] as string[]);
vi.mock('./AssistantBubble', () => ({ AssistantBubble: ({ text }: { text: string }) => { bubbleTexts.push(text); return null; } }));
vi.mock('./UserBubble', () => ({ UserBubble: () => null }));
vi.mock('./PreviewBubble', () => ({ PreviewBubble: () => null }));
vi.mock('./StatusLine', () => ({ StatusLine: () => null }));
vi.mock('./ThinkingBlock', () => ({ ThinkingBlock: () => null }));
vi.mock('./tools/ToolCard', () => ({ ToolCard: () => null }));
vi.mock('./tools/ToolGroup', () => ({ ToolGroup: () => null }));
vi.mock('./tools/ToolDetailSheet', () => ({ ToolDetailSheet: () => null }));
vi.mock('../stores/aparencia', () => ({ useAparencia: (sel: (s: unknown) => unknown) => sel({ pensamentoTools: 'busca' }) }));
vi.mock('@legendapp/list/react-native', () => ({
  LegendList: ({ data, renderItem, keyExtractor }: {
    data: unknown[]; renderItem: (a: { item: unknown }) => ReactNode; keyExtractor: (i: unknown) => string;
  }) => createElement('div', null, data.map((item) => createElement('div', { key: keyExtractor(item) }, renderItem({ item })))),
}));

vi.mock('react-native-enriched-markdown', () => ({
  EnrichedMarkdownText: ({ markdown }: { markdown: string }) => createElement('pre', null, markdown),
}));
vi.mock('./TableChart', () => ({ TableChart: () => null }));
vi.mock('./tableChartPref', () => ({ getTableChartPref: () => 'table', setTableChartPref: () => {} }));
vi.mock('./BubbleActions', () => ({ BubbleActions: () => null, pararTts: () => {} }));
vi.mock('./ArquivoChip', () => ({
  ArquivoChip: ({ caminho, onPress }: { caminho: string; onPress: () => void }) =>
    createElement('button', { onClick: onPress, 'aria-label': caminho }, caminho),
}));

import { ChatHeader } from './ChatHeader';
import { MessageList } from './MessageList';
import { MoreSheet } from './MoreSheet';
import { Composer } from './Composer';
import { OptionButtons } from './OptionButtons';
import ChatScreen from '../../app/s/[server]/[name]/index';
import CreateRoute from '../../app/create';

async function render(el: ReturnType<typeof createElement>) {
  const container = document.createElement('div');
  const root = createRoot(container);
  await act(async () => root.render(el));
  return { container, root };
}

const header = { name: 'g1-orq', state: null, onBack: () => {}, onMore: () => {}, onTitlePress: () => {} };
const sheet = { open: true, onClose: () => {}, serverId: 's1', name: 'g1-orq' };

it.each([0, 1])('opção %s e cancelar compartilham trava, mantendo índice 1-based e liberando no erro', async (selected) => {
  let fail!: (reason: Error) => void;
  const onSelect = vi.fn(() => new Promise<void>((_, reject) => { fail = reject; }));
  const onCancel = vi.fn(async () => {});
  const { container, root } = await render(createElement(OptionButtons, {
    question: 'permission', options: ['Yes', 'No'], onSelect, onCancel,
  }));
  const buttons = container.querySelectorAll<HTMLButtonElement>('button');
  act(() => { buttons[selected].click(); buttons[1 - selected].click(); buttons[2].click(); });
  expect(onSelect).toHaveBeenCalledExactlyOnceWith(selected + 1);
  expect(onCancel).not.toHaveBeenCalled();
  expect([...buttons].every((b) => b.disabled)).toBe(true);
  await act(async () => fail(new Error('recusado')));
  await act(async () => buttons[2].click());
  expect(onCancel).toHaveBeenCalledTimes(1);
  act(() => root.unmount());
});

describe('terminal escondido', () => {
  it('cabeçalho sem onTerminal não mostra o botão Terminal', async () => {
    const { container, root } = await render(createElement(ChatHeader, header));
    expect(container.querySelector('[aria-label="term_titulo"]')).toBeNull();
    act(() => root.unmount());
  });

  it('cabeçalho com onTerminal continua mostrando o botão', async () => {
    const { container, root } = await render(createElement(ChatHeader, { ...header, onTerminal: () => {} }));
    expect(container.querySelector('[aria-label="term_titulo"]')).not.toBeNull();
    act(() => root.unmount());
  });

  it('"⋯" do orquestrador não lista Terminal, resposta, anexos nem grupo', async () => {
    const { container, root } = await render(createElement(MoreSheet, { ...sheet, orq: true }));
    expect(container.querySelector('[aria-label="term_titulo"]')).toBeNull();
    expect(container.querySelector('[aria-label="par_titulo"]')).toBeNull();
    expect(container.querySelector('[aria-label="askq_sua_resposta"]')).toBeNull();
    expect(container.querySelector('[aria-label="ctx_anexos"]')).toBeNull();
    expect(container.querySelector('[aria-label="arq_aba"]')).not.toBeNull();
    act(() => root.unmount());
  });

  it('"⋯" de sessão comum continua listando Terminal, resposta e anexos', async () => {
    const { container, root } = await render(createElement(MoreSheet, sheet));
    expect(container.querySelector('[aria-label="term_titulo"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="askq_sua_resposta"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="ctx_anexos"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="par_titulo"]')).not.toBeNull();
    act(() => root.unmount());
  });
});

describe('Parar no Composer', () => {
  const props = { serverId: 's1', name: 'sess' };

  it('ocioso: sem Parar, envio presente', async () => {
    composerChat.state = 'idle';
    const { container, root } = await render(createElement(Composer, { ...props, onStop: () => {} }));
    expect(container.querySelector('[aria-label="composer_parar"]')).toBeNull();
    expect(container.querySelector('[aria-label="composer_enviar_mensagem"]')).not.toBeNull();
    act(() => root.unmount());
  });

  it('trabalhando: Parar ao lado do envio, e o toque chama onStop', async () => {
    composerChat.state = 'working';
    const onStop = vi.fn();
    const { container, root } = await render(createElement(Composer, { ...props, onStop }));
    const parar = container.querySelector<HTMLButtonElement>('[aria-label="composer_parar"]');
    expect(parar).not.toBeNull();
    expect(container.querySelector('[aria-label="composer_enviar_mensagem"]')).not.toBeNull();
    act(() => parar!.click());
    expect(onStop).toHaveBeenCalledTimes(1);
    act(() => root.unmount());
  });

  it('interrupção em voo: Parar desabilitado', async () => {
    composerChat.state = 'working';
    const { container, root } = await render(createElement(Composer, { ...props, onStop: () => {}, stopping: true }));
    expect(container.querySelector<HTMLButtonElement>('[aria-label="composer_parar"]')!.disabled).toBe(true);
    act(() => root.unmount());
  });

  it('sem onStop (quem não pode parar): nada de Parar mesmo trabalhando', async () => {
    composerChat.state = 'working';
    const { container, root } = await render(createElement(Composer, props));
    expect(container.querySelector('[aria-label="composer_parar"]')).toBeNull();
    act(() => root.unmount());
  });
});

describe('primeiro texto recuperado no Composer', () => {
  const props = { serverId: 's1', name: 'sess', draft: 'primeiro texto', firstInputId: 'attempt-1' };
  beforeEach(() => {
    composerChat.send.mockClear(); firstInput.confirm.mockClear(); firstInput.send.mockReset();
    firstInput.attempt = {
      id: 'attempt-1', serverId: 's1', body: { name: 'sess', cwd: '/repo', provider: 'codex' },
      sessionName: 'sess', text: 'primeiro texto', phase: 'created',
    };
  });

  it('montar/remontar não envia; dois toques explícitos fazem um envio à mesma sessão sem eco local', async () => {
    let done!: () => void;
    firstInput.send.mockImplementation(() => new Promise<void>((resolve) => { done = resolve; }));
    const first = await render(createElement(Composer, props));
    act(() => first.root.unmount());
    const { container, root } = await render(createElement(Composer, props));
    expect(container.querySelector('textarea')!.value).toBe('primeiro texto');
    expect(firstInput.send).not.toHaveBeenCalled();
    const send = container.querySelector<HTMLButtonElement>('[aria-label="composer_enviar_mensagem"]')!;
    act(() => { send.click(); send.click(); });
    expect(firstInput.send).toHaveBeenCalledExactlyOnceWith('s1', 'attempt-1');
    expect(composerChat.send).not.toHaveBeenCalled();
    firstInput.attempt!.phase = 'sent';
    await act(async () => done());
    expect(firstInput.confirm).toHaveBeenCalledWith('attempt-1');
    act(() => root.unmount());
  });

  it('recusa conserva rascunho; resultado incerto não repete POST', async () => {
    firstInput.send.mockResolvedValue(undefined);
    const { container, root } = await render(createElement(Composer, props));
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="composer_enviar_mensagem"]')!.click());
    expect(container.querySelector('textarea')!.value).toBe('primeiro texto');
    expect(firstInput.confirm).not.toHaveBeenCalled();
    firstInput.attempt!.phase = 'send_unknown';
    firstInput.send.mockClear();
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="composer_enviar_mensagem"]')!.click());
    expect(firstInput.send).not.toHaveBeenCalled();
    expect(composerChat.send).not.toHaveBeenCalled();
    expect(container.querySelector('textarea')!.value).toBe('primeiro texto');
    expect(container.textContent).toContain('nova_conversa_envio_incerto');
    act(() => root.unmount());
  });

  it('ACK confirmado antes de o botão atualizar não repete o texto que ainda aparece', async () => {
    const { container, root } = await render(createElement(Composer, props));
    firstInput.attempt = null;
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="composer_enviar_mensagem"]')!.click());
    expect(firstInput.send).not.toHaveBeenCalled();
    expect(composerChat.send).not.toHaveBeenCalled();
    expect(container.querySelector('textarea')!.value).toBe('');
    act(() => root.unmount());
  });

  it('ACK tardio preserva nova edição e sent não repete o primeiro input', async () => {
    let done!: () => void;
    firstInput.send.mockImplementation(() => new Promise<void>((resolve) => { done = resolve; }));
    const { container, root } = await render(createElement(Composer, props));
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="composer_enviar_mensagem"]')!.click());
    const field = container.querySelector('textarea')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(field, 'texto novo');
      field.dispatchEvent(new Event('input', { bubbles: true }));
    });
    firstInput.attempt!.phase = 'sent';
    await act(async () => done());
    expect(field.value).toBe('texto novo');
    expect(firstInput.confirm).toHaveBeenCalledWith('attempt-1');
    act(() => root.unmount());
    const reopened = await render(createElement(Composer, props));
    // A edição guardada vence o texto de handoff que a rota ainda carrega; enviá-la é mensagem nova.
    expect(reopened.container.querySelector('textarea')!.value).toBe('texto novo');
    await act(async () => reopened.container.querySelector<HTMLButtonElement>('[aria-label="composer_enviar_mensagem"]')!.click());
    expect(firstInput.send).toHaveBeenCalledTimes(1);
    expect(composerChat.send).toHaveBeenCalledExactlyOnceWith('texto novo', expect.any(Number));
    act(() => reopened.root.unmount());
  });
});

describe('rascunho guardado no Composer', () => {
  const props = { serverId: 's1', name: 'sess' };
  const type = (container: HTMLElement, value: string) => act(() => {
    const field = container.querySelector('textarea')!;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const stored = (serverId: string, name: string) => {
    const raw = storage.memory.get(`draft.v1:${serverId}::${name}`);
    return raw ? JSON.parse(raw) as { text: string; revision: number; transcript: string | null } : null;
  };
  const button = (container: HTMLElement, label: string) => [...container.querySelectorAll('button, [role="button"]')]
    .find((el) => el.textContent === label) as HTMLElement | undefined;

  it.each(['sending', 'unknown', 'rejected'])('reabre upload confirmado com input %s sem reenviar; Recuperar devolve só o texto', async (status) => {
    composerChat.send.mockClear();
    const attachment = {
      uri: 'file:///draft-attachments/1-1.txt', name: 'nota.txt', mime: 'text/plain', kind: 'file',
      uploadedPath: '/uploads/nota.txt', uploadedFor: { serverId: 's1', name: 'sess', transcript: null },
    };
    storage.memory.set('draft.v1:s1::sess', JSON.stringify({
      version: 1, text: 'nota', revision: 1, transcript: null, attachment,
      submission: { text: 'nota — 📎 board_arquivo: /uploads/nota.txt', draftRevision: 1, status },
    }));
    const first = await render(createElement(Composer, props));
    act(() => first.root.unmount());
    const reopened = await render(createElement(Composer, props));
    expect(composerChat.send).not.toHaveBeenCalled();
    expect(reopened.container.textContent).toContain('nota.txt');
    act(() => button(reopened.container, 'composer_draft_recover')!.click());
    expect(reopened.container.querySelector('textarea')!.value).toBe('nota');
    expect(JSON.parse(storage.memory.get('draft.v1:s1::sess')!)).toMatchObject({ attachment, submission: null });
    act(() => reopened.root.unmount());
  });

  it('recuperação não troca anexo atual; depois de removê-lo adota o anterior sem reutilizar upload da sessão morta', async () => {
    const attachment = { uri: 'file:///draft-attachments/2-1.txt', name: 'atual.txt', mime: 'text/plain', kind: 'file' };
    const previous = { ...attachment, uri: 'file:///draft-attachments/1-1.txt', name: 'anterior.txt',
      uploadedPath: '/uploads/anterior.txt', uploadedFor: { serverId: 's1', name: 'sess', transcript: '/old' } };
    storage.memory.set('draft.v1:s1::sess', JSON.stringify({
      version: 1, text: 'atual', revision: 1, transcript: null, attachment, submission: null,
    }));
    storage.memory.set('draft.v1.recoverable:s1::sess', JSON.stringify({
      version: 1, text: 'anterior', revision: 1, transcript: '/old', attachment: previous, submission: null,
    }));
    const { container, root } = await render(createElement(Composer, props));
    act(() => button(container, 'composer_draft_recover')!.click());
    expect(container.textContent).toContain('composer_draft_recover_attach_busy');
    expect(container.querySelector('textarea')!.value).toBe('atual');
    expect(JSON.parse(storage.memory.get('draft.v1:s1::sess')!).attachment).toEqual(attachment);
    expect(storage.memory.has('draft.v1.recoverable:s1::sess')).toBe(true);
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="board_remover_anexo"]')!.click());
    act(() => button(container, 'composer_draft_recover')!.click());
    expect(container.querySelector('textarea')!.value).toBe('atual\nanterior');
    expect(JSON.parse(storage.memory.get('draft.v1:s1::sess')!).attachment).toEqual({
      uri: previous.uri, name: previous.name, mime: previous.mime, kind: previous.kind,
    });
    expect(storage.memory.has('draft.v1.recoverable:s1::sess')).toBe(false);
    act(() => root.unmount());
  });

  it('cada edição grava na conversa de origem; desmontar não apaga e outro servidor com mesmo nome não recebe', async () => {
    sessionsState.rows = [{ serverId: 's1', name: 'sess', jsonl: '/t/a.jsonl' }];
    const first = await render(createElement(Composer, props));
    type(first.container, 'o');
    type(first.container, 'oi');
    expect(stored('s1', 'sess')).toMatchObject({ text: 'oi', revision: 2, transcript: '/t/a.jsonl' });
    act(() => first.root.unmount());
    expect(stored('s1', 'sess')?.text).toBe('oi');

    const other = await render(createElement(Composer, { serverId: 's2', name: 'sess' }));
    expect(other.container.querySelector('textarea')!.value).toBe('');
    act(() => other.root.unmount());
    const reopened = await render(createElement(Composer, props));
    expect(reopened.container.querySelector('textarea')!.value).toBe('oi');
    act(() => reopened.root.unmount());
  });

  it('texto devolvido pelo cancelar das opções é adotado e guardado na mesma conversa', async () => {
    const { container, root } = await render(createElement(Composer, props));
    await act(async () => root.render(createElement(Composer, { ...props, draft: 'resposta cancelada' })));
    expect(container.querySelector('textarea')!.value).toBe('resposta cancelada');
    expect(stored('s1', 'sess')?.text).toBe('resposta cancelada');
    act(() => root.unmount());
  });

  it('primeiro jsonl associa o rascunho provisório sem tratar como sessão recriada', async () => {
    sessionsState.rows = [{ serverId: 's1', name: 'sess', jsonl: null }];
    const { container, root } = await render(createElement(Composer, props));
    type(container, 'antes do transcript');
    expect(stored('s1', 'sess')?.transcript).toBeNull();
    sessionsState.rows = [{ serverId: 's1', name: 'sess', jsonl: '/t/first.jsonl' }];
    await act(async () => root.render(createElement(Composer, props)));
    expect(container.querySelector('textarea')!.value).toBe('antes do transcript');
    expect(stored('s1', 'sess')?.transcript).toBe('/t/first.jsonl');
    expect(container.textContent).not.toContain('composer_draft_previous');
    act(() => root.unmount());
  });

  it('sessão recriada não recebe o texto antigo; ele sobrevive a texto novo e reabertura até recuperar', async () => {
    sessionsState.rows = [{ serverId: 's1', name: 'sess', jsonl: '/t/old.jsonl' }];
    const old = await render(createElement(Composer, props));
    type(old.container, 'texto da sessão morta');
    act(() => old.root.unmount());

    sessionsState.rows = [{ serverId: 's1', name: 'sess', jsonl: '/t/new.jsonl' }];
    const recreated = await render(createElement(Composer, props));
    expect(recreated.container.querySelector('textarea')!.value).toBe('');
    expect(recreated.container.textContent).toContain('composer_draft_previous');
    type(recreated.container, 'texto novo');
    expect(stored('s1', 'sess')).toMatchObject({ text: 'texto novo', transcript: '/t/new.jsonl' });
    act(() => recreated.root.unmount());

    const reopened = await render(createElement(Composer, props));
    expect(reopened.container.querySelector('textarea')!.value).toBe('texto novo');
    act(() => button(reopened.container, 'composer_draft_recover')!.click());
    expect(reopened.container.querySelector('textarea')!.value).toBe('texto novo\ntexto da sessão morta');
    expect(stored('s1', 'sess')?.text).toBe('texto novo\ntexto da sessão morta');
    expect(storage.memory.has('draft.v1.recoverable:s1::sess')).toBe(false);
    expect(reopened.container.textContent).not.toContain('composer_draft_previous');
    act(() => reopened.root.unmount());
  });

  it('sessão recriada enquanto aberta tira o texto antigo do campo e oferece recuperar; descartar não reoferece', async () => {
    sessionsState.rows = [{ serverId: 's1', name: 'sess', jsonl: '/t/old.jsonl' }];
    const { container, root } = await render(createElement(Composer, props));
    type(container, 'antigo');
    sessionsState.rows = [{ serverId: 's1', name: 'sess', jsonl: '/t/new.jsonl' }];
    await act(async () => root.render(createElement(Composer, props)));
    expect(container.querySelector('textarea')!.value).toBe('');
    expect(container.textContent).toContain('composer_draft_previous');
    act(() => button(container, 'composer_draft_discard')!.click());
    expect(container.textContent).not.toContain('composer_draft_previous');
    act(() => root.unmount());
    const reopened = await render(createElement(Composer, props));
    expect(reopened.container.textContent).not.toContain('composer_draft_previous');
    act(() => reopened.root.unmount());
  });

  it('"Ler de novo" após falha na recriação não traz o texto morto ao campo e Recuperar o devolve uma vez', async () => {
    sessionsState.rows = [{ serverId: 's1', name: 'sess', jsonl: '/t/old.jsonl' }];
    const { container, root } = await render(createElement(Composer, props));
    type(container, 'hello');
    storage.failSet = true;
    sessionsState.rows = [{ serverId: 's1', name: 'sess', jsonl: '/t/new.jsonl' }];
    await act(async () => root.render(createElement(Composer, props)));
    expect(container.textContent).toContain('draft_write_error');
    storage.failSet = false;
    act(() => button(container, 'composer_draft_read_again')!.click());
    expect(container.querySelector('textarea')!.value).toBe('');
    expect(container.textContent).toContain('composer_draft_previous');
    expect(stored('s1', 'sess')?.text).not.toBe('hello');
    act(() => button(container, 'composer_draft_recover')!.click());
    expect(container.querySelector('textarea')!.value).toBe('hello');
    act(() => root.unmount());
  });

  it('falha ao gravar aparece como aviso e o texto continua no campo', async () => {
    const { container, root } = await render(createElement(Composer, props));
    storage.failSet = true;
    type(container, 'sem espaço');
    expect(container.querySelector('textarea')!.value).toBe('sem espaço');
    expect(container.textContent).toContain('draft_write_error');
    act(() => root.unmount());
  });

  it('rascunho em formato inválido avisa sem travar e a edição seguinte grava por cima', async () => {
    storage.memory.set('draft.v1:s1::sess', '{"text":');
    const { container, root } = await render(createElement(Composer, props));
    expect(container.textContent).toContain('draft_invalid');
    type(container, 'recomeço');
    expect(stored('s1', 'sess')?.text).toBe('recomeço');
    act(() => root.unmount());
  });
});

describe('handoff nas rotas reais', () => {
  beforeEach(() => {
    route.params = { server: 's1', name: 'sess' }; route.segments = ['s'];
    composerChat.send.mockClear(); firstInput.send.mockClear(); firstInput.confirm.mockClear();
    firstInput.attempt = {
      id: 'attempt-route', serverId: 's1', body: { name: 'sess', cwd: '/repo', provider: 'claude' },
      sessionName: 'sess', text: 'rascunho recuperável', phase: 'created',
    };
  });

  it('chat recebe rascunho sem POST e a troca de servidor não carrega o texto antigo', async () => {
    const { container, root } = await render(createElement(ChatScreen));
    expect(container.querySelector('textarea')!.value).toBe('rascunho recuperável');
    expect(firstInput.send).not.toHaveBeenCalled();
    expect(composerChat.send).not.toHaveBeenCalled();
    route.params = { server: 's2', name: 'sess' };
    await act(async () => root.render(createElement(ChatScreen)));
    expect(container.querySelector('textarea')!.value).toBe('');
    expect(firstInput.confirm).not.toHaveBeenCalled();
    act(() => root.unmount());
  });

  it('chat confirma sent sem retornar texto ao campo nem enviar novamente', async () => {
    firstInput.attempt!.phase = 'sent';
    const { container, root } = await render(createElement(ChatScreen));
    expect(container.querySelector('textarea')!.value).toBe('');
    expect(firstInput.confirm).toHaveBeenCalledWith('attempt-route');
    expect(firstInput.send).not.toHaveBeenCalled();
    expect(composerChat.send).not.toHaveBeenCalled();
    act(() => root.unmount());
  });

  it.each([false, true])('ACK que chega após o handoff limpa somente o snapshot, edição nova: %s', async (edited) => {
    const { container, root } = await render(createElement(ChatScreen));
    const field = container.querySelector('textarea')!;
    if (edited) act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(field, 'outra mensagem');
      field.dispatchEvent(new Event('input', { bubbles: true }));
    });
    firstInput.attempt = { ...firstInput.attempt!, phase: 'sent' };
    await act(async () => root.render(createElement(ChatScreen)));
    expect(field.value).toBe(edited ? 'outra mensagem' : '');
    expect(composerChat.send).not.toHaveBeenCalled();
    expect(firstInput.send).not.toHaveBeenCalled();
    act(() => root.unmount());
  });

  it('Nova conversa desmonta o formulário ao perder a rota para impedir navegação tardia', async () => {
    route.segments = ['create'];
    const { container, root } = await render(createElement(CreateRoute));
    expect(container.querySelector('[data-create]')).not.toBeNull();
    route.segments = ['s'];
    await act(async () => root.render(createElement(CreateRoute)));
    expect(container.querySelector('[data-create]')).toBeNull();
    act(() => root.unmount());
  });
});

describe('plano proposto na lista', () => {
  it('Codex: a bolha recebe o texto original, com os marcadores, pra detectar o plano', async () => {
    bubbleTexts.length = 0;
    const text = 'Antes\n<proposed_plan>\n# Plano\n- passo\n</proposed_plan>';
    const { root } = await render(createElement(MessageList, {
      events: [{ id: 'a1', kind: 'assistant_msg', text }],
      preview: '', statusLine: null, olderFailed: '', onLoadOlder: () => {},
      session: { provider: 'codex' } as never,
    } as never));
    expect(bubbleTexts).toEqual([text]);
    act(() => root.unmount());
  });
});

it('plano real preserva prosa, links e abertura do arquivo sem tags do protocolo', async () => {
  const { AssistantBubble } = await vi.importActual<typeof import('./AssistantBubble')>('./AssistantBubble');
  routerPush.mockClear();
  const text = 'Prosa antes\n<proposed_plan>\n# Plano Android\n[Documentação](https://docs.example.test/android)\n[Arquivo do plano](/repo/docs/plano.md)\n</proposed_plan>\nProsa depois';
  const { container, root } = await render(createElement(AssistantBubble, { text, sessionName: 'sess', serverId: 'srv' }));
  const markdown = container.querySelector('pre')!.textContent;
  expect(markdown).toContain('Prosa antes');
  expect(markdown).toContain('Prosa depois');
  expect(markdown).toContain('[Documentação](https://docs.example.test/android)');
  expect(markdown).toContain('[Arquivo do plano](/repo/docs/plano.md)');
  expect(markdown).not.toContain('proposed_plan');
  expect(container.textContent).toContain('chat_plan_proposto');
  const chip = container.querySelector<HTMLButtonElement>('[aria-label="/repo/docs/plano.md"]');
  expect(chip).not.toBeNull();
  act(() => chip!.click());
  expect(routerPush).toHaveBeenCalledExactlyOnceWith('/s/srv/sess/files?path=%2Frepo%2Fdocs%2Fplano.md');
  act(() => root.unmount());
});
