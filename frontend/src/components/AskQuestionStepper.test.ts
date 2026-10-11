// @vitest-environment happy-dom
// `escapes`: uma pergunta que veio de um SELETOR DE TUI (Codex sem thread, picker do pane) só tem
// as opções — "Digitar resposta" e "Conversar sobre isso" mandariam texto por um caminho que
// aquela sessão não tem. A primeira versão desligava as saídas com `{#if !textOpen && escapes}`,
// e o `{:else}` desenhava justamente o campo de texto: o oposto do pedido, e sem teste nenhum
// dizendo isso.
import { describe, it, expect, vi } from 'vitest';
import { mount, unmount, tick } from 'svelte';
import { createClassComponent } from 'svelte/legacy';
import AskQuestionStepper from './AskQuestionStepper.svelte';
import AskQuestionCard from './AskQuestionCard.svelte';
import type { AskQuestionPayload } from '@hangar/core';
import { overwriteGetLocale } from '../paraglide/runtime';

overwriteGetLocale(() => 'pt');

const payload: AskQuestionPayload = {
  questions: [{
    header: 'Codex',
    question: 'Confia nos hooks?',
    multiSelect: false,
    options: [{ label: 'Revisar', description: '' }, { label: 'Confiar', description: '' }],
  }],
};

function montar(escapes: boolean) {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const comp = mount(AskQuestionStepper, {
    target: el,
    props: { open: true, payload, onSubmit: vi.fn(), onClose: vi.fn(), escapes },
  });
  return { el, comp };
}

describe('AskQuestionStepper: saídas de texto', () => {
  it.each(['review', 'text'])('cancelar devolve A exibida antes do render de B: %s', async (step) => {
    const el = document.createElement('div'); document.body.appendChild(el);
    const first: AskQuestionPayload = { ...payload, provider: 'codex', is_async: true,
      request_id: 'same-native-id', interaction_id: 'form-a',
      questions: step === 'text' ? [{ ...payload.questions[0], options: [] }] : payload.questions };
    const second = { ...first, interaction_id: 'form-b' };
    const onClose = vi.fn();
    const comp = createClassComponent({ component: AskQuestionStepper, target: el, props: {
      open: true, payload: first, onSubmit: vi.fn(), onClose,
    } });
    await tick();
    if (step === 'review') { el.querySelector<HTMLButtonElement>('.option-btn')!.click(); await tick(); }
    const cancel = el.querySelector<HTMLButtonElement>(step === 'text' ? '.text-actions .ghost-btn' : '.review-list ~ .ghost-btn')!;
    expect(cancel).not.toBeNull();
    comp.$set({ payload: second });
    cancel.click();
    expect(onClose).toHaveBeenLastCalledWith(expect.objectContaining({ interaction_id: 'form-a', request_id: 'same-native-id' }));
    await tick(); await tick();
    if (step === 'review') { el.querySelector<HTMLButtonElement>('.option-btn')!.click(); await tick(); }
    el.querySelector<HTMLButtonElement>(step === 'text' ? '.text-actions .ghost-btn' : '.review-list ~ .ghost-btn')!.click();
    expect(onClose).toHaveBeenLastCalledWith(expect.objectContaining({ interaction_id: 'form-b' }));
    comp.$destroy(); el.remove();
  });

  it('troca A na revisão por B com menos opções sem quebrar a tela', async () => {
    const el = document.createElement('div'); document.body.appendChild(el);
    const first = { ...payload, request_id: 'same-native-id', interaction_id: 'interaction-a' };
    const second: AskQuestionPayload = { ...first, interaction_id: 'interaction-b',
      questions: [{ ...payload.questions[0], options: [{ label: 'Única', description: '' }] }] };
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const comp = createClassComponent({ component: AskQuestionStepper, target: el, props: {
      open: true, payload: first, onSubmit, onClose: vi.fn(),
    } });
    await tick();
    el.querySelectorAll<HTMLButtonElement>('.option-btn')[1].click(); await tick();
    expect(el.querySelector('.review-list')).not.toBeNull();
    comp.$set({ payload: second }); await tick(); await tick();
    expect(el.querySelector('.review-list')).toBeNull();
    expect(el.querySelectorAll('.option-btn')).toHaveLength(1);
    el.querySelector<HTMLButtonElement>('.option-btn')!.click(); await tick();
    el.querySelector<HTMLButtonElement>('.primary-btn')!.click(); await tick();
    expect(onSubmit).toHaveBeenLastCalledWith([expect.objectContaining({ indices: [0], labels: ['Única'] })], second);
    comp.$destroy(); el.remove();
  });

  it('troca A por B idêntica e ignora erro e liberação tardios de A', async () => {
    const el = document.createElement('div'); document.body.appendChild(el);
    const first = { ...payload, request_id: 'same-native-id', interaction_id: 'interaction-a' };
    const second = { ...first, interaction_id: 'interaction-b' };
    let rejectFirst!: (error: Error) => void;
    let finishSecond!: () => void;
    const onSubmit = vi.fn()
      .mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { rejectFirst = reject; }))
      .mockImplementationOnce(() => new Promise<void>((resolve) => { finishSecond = resolve; }));
    const comp = createClassComponent({ component: AskQuestionStepper, target: el, props: {
      open: true, payload: first, onSubmit, onClose: vi.fn(),
    } });
    await tick();
    el.querySelector<HTMLButtonElement>('.option-btn')!.click(); await tick();
    el.querySelector<HTMLButtonElement>('.primary-btn')!.click(); await tick();
    expect(onSubmit).toHaveBeenLastCalledWith(expect.any(Array), first);
    comp.$set({ payload: second }); await tick(); await tick();
    expect(first.questions).toEqual(second.questions);
    expect(el.querySelector('.review-list')).toBeNull();
    el.querySelector<HTMLButtonElement>('.option-btn')!.click(); await tick();
    el.querySelector<HTMLButtonElement>('.primary-btn')!.click(); await tick();
    rejectFirst(new Error('erro-antigo')); await tick(); await tick();
    expect(el.textContent).not.toContain('erro-antigo');
    expect(el.querySelector<HTMLButtonElement>('.primary-btn')!.disabled).toBe(true);
    expect(onSubmit).toHaveBeenLastCalledWith(expect.any(Array), second);
    finishSecond(); await tick(); await tick();
    expect(el.querySelector<HTMLButtonElement>('.primary-btn')!.disabled).toBe(false);
    comp.$destroy(); el.remove();
  });

  it('responde várias perguntas do Codex pelos ids e mantém o erro para tentar de novo', async () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    const onSubmit = vi.fn().mockRejectedValueOnce(new Error('Conexão interrompida')).mockResolvedValueOnce(undefined);
    const comp = mount(AskQuestionStepper, { target: el, props: {
      open: true, onSubmit, onClose: vi.fn(), payload: {
        provider: 'codex', request_id: 0, questions: [
          { id: 'cor', header: 'Cor', question: 'Qual cor?', options: [{ label: 'Azul', description: '' }], multiSelect: false },
          { id: 'nome', header: 'Nome', question: 'Qual nome?', options: [], multiSelect: false },
        ],
      },
    } });
    await tick();
    el.querySelector<HTMLButtonElement>('.option-btn')!.click();
    await tick();
    const input = el.querySelector<HTMLInputElement>('input')!;
    expect(input).not.toBeNull();
    input.value = 'João';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await tick();
    el.querySelector<HTMLButtonElement>('.text-actions .primary-btn')!.click();
    await tick();
    el.querySelector<HTMLButtonElement>('.primary-btn')!.click();
    await tick();
    expect(onSubmit).toHaveBeenCalledWith([
      expect.objectContaining({ question_id: 'cor', kind: 'option', labels: ['Azul'] }),
      expect.objectContaining({ question_id: 'nome', kind: 'text', value: 'João' }),
    ], expect.objectContaining({ request_id: 0 }));
    await vi.waitFor(() => expect(el.textContent).toContain('Conexão interrompida'));
    expect(el.textContent).toContain('João');
    el.querySelector<HTMLButtonElement>('.primary-btn')!.click();
    await tick();
    expect(onSubmit).toHaveBeenCalledTimes(2);
    await unmount(comp);
    el.remove();
  });
  it('escapes=false não desenha campo de texto nem as saídas', () => {
    const { el, comp } = montar(false);
    expect(el.querySelector('input[type="text"]')).toBeNull();
    expect(el.querySelectorAll('.option-btn').length).toBe(2);   // as opções continuam
    unmount(comp);
  });

  it('escapes=true (o padrão do AskUserQuestion) mantém as duas saídas', () => {
    const { el, comp } = montar(true);
    expect(el.querySelectorAll('.escapes .ghost-btn').length).toBe(2);
    expect(el.querySelector('input[type="text"]')).toBeNull();   // só depois de clicar em digitar
    unmount(comp);
  });

  it('volta da revisão para a pergunta com a escolha errada ainda marcada', async () => {
    // Escolha única avança sozinha: sem a volta na revisão, um toque errado só saía cancelando.
    const onSubmit = vi.fn();
    const el = document.createElement('div');
    document.body.appendChild(el);
    const comp = mount(AskQuestionStepper, {
      target: el, props: { open: true, payload, onSubmit, onClose: vi.fn(), escapes: true },
    });
    await tick();
    el.querySelectorAll<HTMLButtonElement>('.option-btn')[1].click();   // "Confiar", sem querer
    await tick();
    expect(el.querySelector('.review-list')).not.toBeNull();
    el.querySelector<HTMLButtonElement>('.back-link')!.click();
    await tick();
    const opcoes = el.querySelectorAll<HTMLButtonElement>('.option-btn');
    expect(opcoes).toHaveLength(2);
    expect(opcoes[1].classList.contains('selected')).toBe(true);
    opcoes[0].click();                                                  // agora a certa
    await tick();
    el.querySelector<HTMLButtonElement>('.primary-btn')!.click();
    await tick();
    expect(onSubmit).toHaveBeenCalledWith([expect.objectContaining({ labels: ['Revisar'] })], payload);
    await unmount(comp);
    el.remove();
  });

  it('refina só o Ask nativo e mantém a múltipla escolha selecionável', async () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    const comp = mount(AskQuestionCard, { target: el, props: {
      open: true, onSubmit: vi.fn(), onClose: vi.fn(), escapes: true, payload: {
        ...payload,
        questions: [{ ...payload.questions[0], multiSelect: true }],
      },
    } });
    await tick();
    expect(el.querySelector('.ask-status')).not.toBeNull();
    const marks = el.querySelectorAll('.choice-mark.multiple');
    expect(marks).toHaveLength(2);
    el.querySelector<HTMLButtonElement>('.option-btn')!.click();
    await tick(); await tick();
    expect(el.querySelector('.choice-mark.multiple.selected')).not.toBeNull();
    expect(el.querySelector<HTMLButtonElement>('.primary-btn')!.disabled).toBe(false);
    await unmount(comp);
    el.remove();
  });
});
