// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../paraglide/messages', () => ({
  comum_cancelar: () => 'cancelar', permissao_pedido: () => 'perm', comum_falha_envio_opcao: () => 'falha', opcoes_enviar_marcadas: () => 'enviar',
  native_plan_review_auto_mode: () => 'auto', native_plan_review_manual: () => 'manual', native_plan_review_changes: () => 'mudar',
  native_plan_review_bypass: () => 'bypass', native_plan_review_auto: () => 'aceitar', native_plan_review_keep: () => 'manter',
  native_plan_review_changes_placeholder: () => 'o que mudar', native_send: () => 'mandar',
  native_plan_review_title: () => 'titulo', native_plan_review_hint: () => 'dica', native_plan_review_decision: () => 'decisao',
  native_plan_review_expand: () => 'expandir', native_plan_review_back: () => 'voltar', pending_plan_empty: () => 'vazio',
}));
vi.mock('../stores/aparencia', () => ({ useAparencia: () => 'amber' }));
vi.mock('../ui/Icon', () => ({ Icon: () => null }));
vi.mock('./AssistantBubble', () => ({ mkMarkdownStyle: () => ({}) }));
vi.mock('react-native-enriched-markdown', () => ({
  EnrichedMarkdownText: ({ markdown }: { markdown: string }) => createElement('pre', null, markdown),
}));

import { PendingPlan } from './PendingPlan';

const opcoes = ['Yes, and use auto mode', 'Yes, manually approve edits', 'Tell Claude what to change'];

async function render(props: Record<string, unknown>) {
  const container = document.createElement('div');
  const root = createRoot(container);
  await act(async () => root.render(createElement(PendingPlan, { plan: '# Plano\n\n- passo', path: '/p/plano.md', tool_use_id: 't', ...props } as never)));
  return { container, root };
}

describe('PendingPlan: cartão único de revisão, como o nativo', () => {
  it('cabeça, markdown e rodapé com decisão, caminho e escolhas no mesmo cartão', async () => {
    const onSelect = vi.fn().mockResolvedValue(undefined);
    const { container, root } = await render({ options: opcoes, interactionId: 'plan-a', question: 'Proceed?', onSelect, onCancel: vi.fn() });
    const text = container.textContent!;
    expect(text).toContain('titulo');
    expect(text).toContain('dica');
    expect(container.querySelector('pre')!.textContent).toBe('# Plano\n\n- passo');
    expect(text).toContain('decisao');
    expect(text).toContain('/p/plano.md');
    // A pergunta da TUI não se repete: quem fala é a dica de decisão.
    expect(text).not.toContain('Proceed?');
    const botoes = [...container.querySelectorAll('button')];
    expect(botoes.map((b) => b.textContent)).toEqual(expect.arrayContaining(['1.auto', '2.manual', '3.mudar']));
    await act(async () => botoes.find((b) => b.textContent === '2.manual')!.click());
    expect(onSelect).toHaveBeenLastCalledWith(2, 'plan-a');

    const expandir = botoes.find((b) => b.textContent === 'expandir')!;
    await act(async () => expandir.click());
    expect([...container.querySelectorAll('button')].some((b) => b.textContent === 'voltar')).toBe(true);
    act(() => root.unmount());
  });

  it('sem escolhas ainda, só o plano; plano vazio diz que não está disponível', async () => {
    const { container, root } = await render({ plan: '' });
    expect(container.textContent).toContain('vazio');
    expect(container.textContent).not.toContain('decisao');
    act(() => root.unmount());
  });
});
