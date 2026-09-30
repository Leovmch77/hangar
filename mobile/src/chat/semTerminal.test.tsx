// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const routerPush = vi.hoisted(() => vi.fn());
vi.mock('expo-router', () => ({ useRouter: () => ({ push: routerPush }) }));
vi.mock('../ui/Icon', () => ({ Icon: () => null }));
vi.mock('../ui/Sheet', () => ({ Sheet: ({ children }: { children: ReactNode }) => createElement('div', null, children) }));
vi.mock('../features/sessions/StatePill', () => ({ StatePill: () => null }));
vi.mock('./ContextRing', () => ({ ContextRing: () => null }));
// Cada chave devolve o próprio nome, como nos outros testes de componente do app.
vi.mock('../paraglide/messages', () => Object.fromEntries(
  ('arq_aba askq_sua_resposta bastao_dossie_sub bastao_dossie_titulo chat_voltar_sessoes codex_limites_titulo ctx_anexos ctx_atividade ctx_grupo ctx_limites ctx_repositorio ctx_terminal modo_so_ociosa more_fotos_videos_arquivos more_tarefas_agentes navbar_mais_acoes par_titulo recarregar_sessao recarregar_sessao_detalhe sessao_trocar_de term_titulo '
    + 'askq_enviando board_arquivo board_imagem board_remover_anexo codex_orientar composer_anexar_arquivo composer_desfazer_limpeza composer_ditado_limpo composer_enviando_cancelar composer_enviar_mensagem composer_fila_acao composer_fila_aria composer_fila_contagem composer_gravando_audio composer_gravar_audio composer_mandando_grupo composer_mandar_grupo composer_mandar_tambem composer_mensagem composer_parar composer_parar_gravacao composer_pro_grupo composer_pros_dois composer_sessao_trabalhando composer_transcrevendo_audio composer_transcrever_de_novo')
    .concat(' permissao_pedido comum_cancelar msg_aria_mensagens chat_plan_proposto').split(' ').map((k) => [k, () => k]),
));

// Composer isolado: sem picker, pills, ditado nem store real — só o que decide o botão Parar.
const composerChat = vi.hoisted(() => ({ state: 'idle' as string }));
vi.mock('expo-image-picker', () => ({}));
vi.mock('expo-document-picker', () => ({}));
vi.mock('../ui/Glass', () => ({ Glass: ({ children }: { children: ReactNode }) => createElement('div', null, children) }));
vi.mock('../ui/MultilineInput', () => ({ MultilineInput: () => null }));
vi.mock('../features/pills/ModelPill', () => ({ ModelPill: () => null }));
vi.mock('../features/pills/EffortPill', () => ({ EffortPill: () => null }));
vi.mock('../features/pills/PermissionPill', () => ({ PermissionPill: () => null }));
vi.mock('../features/pills/PillMenu', () => ({ PillMenu: () => null }));
vi.mock('../features/ditado/EstiloPill', () => ({ EstiloPill: () => null }));
vi.mock('../features/ditado/useDitado', () => ({ useDitado: () => ({ gravando: false, rms: 0, iniciar: () => {}, parar: () => {} }) }));
vi.mock('../features/ditado/ditadoEstiloStore', () => ({ useDitadoEstiloStore: { getState: () => ({ pronto: false }) } }));
vi.mock('./CommandSheet', () => ({ CommandSheet: () => null }));
vi.mock('../stores/sessions', () => ({
  useSessions: (sel: (s: unknown) => unknown) => sel({ rows: [], byServerRecord: {} }),
}));
vi.mock('../stores/chat', () => {
  const snap = () => ({ pending: [], events: [], stateEvent: { state: composerChat.state } });
  const use = Object.assign((sel: (s: unknown) => unknown) => sel(snap()), { getState: snap, setState: () => {} });
  return { chatStore: () => ({ use, send: async () => {} }), filaCount: () => 0 };
});

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
vi.mock('./BubbleActions', () => ({ BubbleActions: () => null }));
vi.mock('./ArquivoChip', () => ({
  ArquivoChip: ({ caminho, onPress }: { caminho: string; onPress: () => void }) =>
    createElement('button', { onClick: onPress, 'aria-label': caminho }, caminho),
}));

import { ChatHeader } from './ChatHeader';
import { MessageList } from './MessageList';
import { MoreSheet } from './MoreSheet';
import { Composer } from './Composer';
import { OptionButtons } from './OptionButtons';

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
