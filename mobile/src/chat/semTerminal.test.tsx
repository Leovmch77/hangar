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
  'arq_aba askq_sua_resposta bastao_dossie_sub bastao_dossie_titulo chat_voltar_sessoes codex_limites_titulo ctx_anexos ctx_atividade ctx_grupo ctx_limites ctx_repositorio ctx_terminal modo_so_ociosa more_fotos_videos_arquivos more_tarefas_agentes navbar_mais_acoes par_titulo recarregar_sessao recarregar_sessao_detalhe sessao_trocar_de term_titulo'
    .split(' ').map((k) => [k, () => k]),
));

import { ChatHeader } from './ChatHeader';
import { MoreSheet } from './MoreSheet';

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

  it('"⋯" do orquestrador não lista Terminal, resposta nem anexos', async () => {
    const { container, root } = await render(createElement(MoreSheet, { ...sheet, orq: true }));
    expect(container.querySelector('[aria-label="term_titulo"]')).toBeNull();
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
    act(() => root.unmount());
  });
});
