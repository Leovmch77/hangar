// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { Linking } from 'react-native';
import { describe, expect, it, vi } from 'vitest';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../paraglide/messages', () => ({
  comum_cancelar: () => 'cancelar', permissao_pedido: () => 'perm', comum_falha_envio_opcao: () => 'falha', opcoes_enviar_marcadas: () => 'enviar',
  native_plan_review_auto_mode: () => 'auto', native_plan_review_manual: () => 'manual', native_plan_review_changes: () => 'mudar',
  native_plan_review_bypass: () => 'bypass', native_plan_review_auto: () => 'aceitar', native_plan_review_keep: () => 'manter',
  native_plan_review_changes_placeholder: () => 'o que mudar', native_send: () => 'mandar',
}));
vi.mock('../stores/aparencia', () => ({ useAparencia: () => 'amber' }));
vi.mock('../ui/Icon', () => ({ Icon: () => null }));
const haptic = vi.hoisted(() => ({ selection: vi.fn(), success: vi.fn(), error: vi.fn() }));
vi.mock('../ui/haptics', () => ({ haptic }));

import { OptionButtons } from './OptionButtons';

async function render(question: string) {
  const container = document.createElement('div');
  const root = createRoot(container);
  await act(async () => root.render(createElement(OptionButtons, { question, options: ['Concluí', 'Cancelar'], onSelect: vi.fn(), onCancel: vi.fn() })));
  return { container, root };
}

describe('OptionButtons: identidade exibida', () => {
  it('B idêntica não herda bloqueio nem erro da resposta atrasada de A', async () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    let rejectFirst!: (error: Error) => void;
    const onSelect = vi.fn()
      .mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { rejectFirst = reject; }))
      .mockResolvedValue(undefined);
    const props = { question: 'Permitir?', options: ['Sim'], onSelect, onCancel: vi.fn() };
    await act(async () => root.render(createElement(OptionButtons, { ...props, interactionId: 'interaction-a' })));
    await act(async () => container.querySelector('button')!.click());
    expect(onSelect).toHaveBeenLastCalledWith(1, 'interaction-a');
    await act(async () => root.render(createElement(OptionButtons, { ...props, interactionId: 'interaction-b' })));
    await act(async () => rejectFirst(new Error('erro-antigo')));
    expect(container.textContent).not.toContain('erro-antigo');
    expect(container.querySelector('button')!.disabled).toBe(false);
    await act(async () => container.querySelector('button')!.click());
    expect(onSelect).toHaveBeenLastCalledWith(1, 'interaction-b');
    act(() => root.unmount());
  });

  it('marcar e enviar conservam o token mesmo com opções atualizadas', async () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    const onSelect = vi.fn(); const onSubmit = vi.fn();
    const props = { question: 'Escolha', interactionId: 'multi-a', onSelect, onSubmit, onCancel: vi.fn() };
    await act(async () => root.render(createElement(OptionButtons, { ...props, options: ['[ ] Alfa'] })));
    await act(async () => container.querySelector('button')!.click());
    await act(async () => root.render(createElement(OptionButtons, { ...props, options: ['[✔] Alfa'] })));
    const send = [...container.querySelectorAll('button')].find((b) => b.textContent === 'enviar')!;
    await act(async () => send.click());
    expect(onSelect).toHaveBeenCalledWith(1, 'multi-a');
    expect(onSubmit).toHaveBeenCalledWith('multi-a');
    await act(async () => root.render(createElement(OptionButtons, { ...props, interactionId: undefined, options: ['Sim'] })));
    await act(async () => container.querySelector('button')!.click());
    expect(onSelect).toHaveBeenLastCalledWith(1, undefined);
    act(() => root.unmount());
  });
});

describe('OptionButtons: aprovação de plano', () => {
  const opcoes = ['Yes, and use auto mode', 'Yes, manually approve edits', 'Tell Claude what to change'];
  // O mock do TextInput não traduz onChangeText: chama o handler React direto.
  const digitar = (el: Element, text: string) => {
    const key = Object.keys(el).find((k) => k.startsWith('__reactProps$'))!;
    (el as unknown as Record<string, { onChangeText: (t: string) => void }>)[key].onChangeText(text);
  };

  it('rótulos curtos com o completo acessível; "o que mudar" manda o texto', async () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    let rejeitar!: (e: Error) => void;
    const onSelect = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockImplementationOnce(() => new Promise<void>((_r, reject) => { rejeitar = reject; }));
    await act(async () => root.render(createElement(OptionButtons, {
      question: 'Proceed?', options: opcoes, interactionId: 'plan-a', planReview: true, onSelect, onCancel: vi.fn(),
    })));
    const botoes = [...container.querySelectorAll('button')].slice(0, 3);
    expect(botoes.map((b) => b.textContent)).toEqual(['1.auto', '2.manual', '3.mudar']);
    expect(botoes.map((b) => b.getAttribute('aria-label'))).toEqual(opcoes.map((o, i) => `${i + 1}. ${o}`));

    await act(async () => botoes[0].click());
    expect(onSelect).toHaveBeenLastCalledWith(1, 'plan-a');

    await act(async () => botoes[2].click());
    expect(onSelect).toHaveBeenCalledTimes(1);
    const enviar = () => [...container.querySelectorAll('button')].find((b) => b.textContent === 'mandar')!;
    expect(enviar().disabled).toBe(true);
    await act(async () => digitar(container.querySelector('textarea')!, '  troque o passo 2 '));
    expect(enviar().disabled).toBe(false);
    await act(async () => enviar().click());
    expect(onSelect).toHaveBeenLastCalledWith(3, 'plan-a', 'troque o passo 2');
    expect(enviar().disabled).toBe(true);
    await act(async () => rejeitar(new Error('409: erro_interacao_desatualizada')));
    expect(container.querySelector('[role="alert"]')!.textContent).toBe('409: erro_interacao_desatualizada');
    expect((container.querySelector('textarea') as HTMLTextAreaElement).value).toBe('  troque o passo 2 ');
    act(() => root.unmount());
  });
});

describe('OptionButtons: links na pergunta', () => {
  it('URL na pergunta abre fora do app com Linking.openURL', async () => {
    const open = vi.spyOn(Linking, 'openURL');
    const { container, root } = await render('srv pede para abrir https://a.com/x: confirme');
    const link = container.querySelector('[role="link"]') as HTMLElement;
    expect(link.textContent).toBe('https://a.com/x');
    await act(async () => link.click());
    expect(open).toHaveBeenCalledWith('https://a.com/x');
    act(() => root.unmount());
  });

  it('sem URL não há link', async () => {
    const { container, root } = await render('Aprovar o plano?');
    expect(container.querySelector('[role="link"]')).toBeNull();
    act(() => root.unmount());
  });
});

describe('OptionButtons: haptics', () => {
  async function mount(options: string[], onSelect: () => Promise<void>) {
    const container = document.createElement('div');
    const root = createRoot(container);
    await act(async () => root.render(createElement(OptionButtons, { question: 'q', options, onSelect, onCancel: vi.fn() })));
    return { container, root };
  }

  it('resposta aceita vibra sucesso; recusada vibra erro', async () => {
    vi.clearAllMocks();
    const ok = await mount(['Sim'], vi.fn().mockResolvedValue(undefined));
    await act(async () => ok.container.querySelector('button')!.click());
    expect(haptic.success).toHaveBeenCalledTimes(1);
    act(() => ok.root.unmount());
    const bad = await mount(['Sim'], vi.fn().mockRejectedValue(new Error('x')));
    await act(async () => bad.container.querySelector('button')!.click());
    expect(haptic.error).toHaveBeenCalledTimes(1);
    act(() => bad.root.unmount());
  });

  it('marcar caixa de múltipla escolha é seleção, não resultado', async () => {
    vi.clearAllMocks();
    const { container, root } = await mount(['[ ] Alfa'], vi.fn().mockResolvedValue(undefined));
    await act(async () => container.querySelector('button')!.click());
    expect(haptic.selection).toHaveBeenCalledTimes(1);
    expect(haptic.success).not.toHaveBeenCalled();
    act(() => root.unmount());
  });
});
