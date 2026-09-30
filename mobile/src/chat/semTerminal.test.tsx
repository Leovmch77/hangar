// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('../ui/Icon', () => ({ Icon: () => null }));
vi.mock('../ui/Sheet', () => ({ Sheet: ({ children }: { children: ReactNode }) => createElement('div', null, children) }));
vi.mock('../features/sessions/StatePill', () => ({ StatePill: () => null }));
vi.mock('./ContextRing', () => ({ ContextRing: () => null }));
// Cada chave devolve o próprio nome, como nos outros testes de componente do app.
vi.mock('../paraglide/messages', () => Object.fromEntries(
  ('arq_aba askq_sua_resposta bastao_dossie_sub bastao_dossie_titulo chat_voltar_sessoes codex_limites_titulo ctx_anexos ctx_atividade ctx_grupo ctx_limites ctx_repositorio ctx_terminal modo_so_ociosa more_fotos_videos_arquivos more_tarefas_agentes navbar_mais_acoes par_titulo recarregar_sessao recarregar_sessao_detalhe sessao_trocar_de term_titulo '
    + 'askq_enviando board_arquivo board_imagem board_remover_anexo codex_orientar composer_anexar_arquivo composer_desfazer_limpeza composer_ditado_limpo composer_enviando_cancelar composer_enviar_mensagem composer_fila_acao composer_fila_aria composer_fila_contagem composer_gravando_audio composer_gravar_audio composer_mandando_grupo composer_mandar_grupo composer_mandar_tambem composer_mensagem composer_parar composer_parar_gravacao composer_pro_grupo composer_pros_dois composer_sessao_trabalhando composer_transcrevendo_audio composer_transcrever_de_novo')
    .split(' ').map((k) => [k, () => k]),
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

import { ChatHeader } from './ChatHeader';
import { MoreSheet } from './MoreSheet';
import { Composer } from './Composer';

async function render(el: ReturnType<typeof createElement>) {
  const container = document.createElement('div');
  const root = createRoot(container);
  await act(async () => root.render(el));
  return { container, root };
}

const header = { name: 'g1-orq', state: null, onBack: () => {}, onMore: () => {}, onTitlePress: () => {} };
const sheet = { open: true, onClose: () => {}, serverId: 's1', name: 'g1-orq' };

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
