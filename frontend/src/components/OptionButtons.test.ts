// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest';
import { mount, unmount, tick } from 'svelte';
import { createClassComponent } from 'svelte/legacy';
import OptionButtons from './OptionButtons.svelte';
import { overwriteGetLocale } from '../paraglide/runtime';

overwriteGetLocale(() => 'pt');

async function montar(question: string) {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const comp = mount(OptionButtons, { target: el, props: { question, options: ['Concluí', 'Cancelar'], onSelect: vi.fn(), onCancel: vi.fn() } });
  await tick();
  return { el, fim: () => { unmount(comp); el.remove(); } };
}

describe('OptionButtons: identidade exibida', () => {
  it('o callback retido de A não responde B com a mesma pergunta', async () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    const onSelect = vi.fn();
    const comp = createClassComponent({ component: OptionButtons, target: el, props: {
      question: 'Permitir?', options: ['Sim'], interactionId: 'interaction-a', onSelect, onCancel: vi.fn(),
    } });
    await tick();
    const first = el.querySelector<HTMLButtonElement>('.option-btn')!;
    comp.$set({ interactionId: 'interaction-b' });
    await tick();
    const second = el.querySelector<HTMLButtonElement>('.option-btn')!;
    expect(first).not.toBe(second);
    // Reanexa o nó retido para exercitar o callback antigo com a delegação do Svelte.
    el.appendChild(first);
    first.click();
    second.click();
    expect(onSelect.mock.calls).toEqual([[1, 'interaction-a'], [1, 'interaction-b']]);
    comp.$destroy(); el.remove();
  });

  it('marcação e Submit conservam o mesmo ID; legado passa undefined', async () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    const onSelect = vi.fn();
    const onSubmit = vi.fn();
    const comp = createClassComponent({ component: OptionButtons, target: el, props: {
      question: 'Escolha', options: ['[ ] Alfa'], interactionId: 'multi-a', onSelect, onSubmit, onCancel: vi.fn(),
    } });
    await tick();
    el.querySelector<HTMLButtonElement>('.option-btn')!.click();
    comp.$set({ options: ['[✔] Alfa'] });
    await tick();
    el.querySelector<HTMLButtonElement>('.option-btn--enviar')!.click();
    expect(onSelect).toHaveBeenCalledWith(1, 'multi-a');
    expect(onSubmit).toHaveBeenCalledWith('multi-a');
    comp.$set({ interactionId: undefined, options: ['Sim'] });
    await tick();
    el.querySelector<HTMLButtonElement>('.option-btn')!.click();
    expect(onSelect).toHaveBeenLastCalledWith(1, undefined);
    comp.$destroy(); el.remove();
  });
});

describe('OptionButtons: links na pergunta', () => {
  it('URL vira link que abre fora do app', async () => {
    const { el, fim } = await montar('srv pede para abrir https://a.com/x: confirme');
    const a = el.querySelector('p.question a') as HTMLAnchorElement;
    expect(a.getAttribute('href')).toBe('https://a.com/x');
    expect(a.target).toBe('_blank');
    expect(a.rel).toContain('noopener');
    expect(el.querySelector('p.question')!.textContent).toBe('srv pede para abrir https://a.com/x: confirme');
    fim();
  });
  it('sem URL não há link; crases seguem em code', async () => {
    const { el, fim } = await montar('rode `curl https://a.com` agora');
    expect(el.querySelector('p.question a')).toBeNull();
    expect(el.querySelector('p.question code')!.textContent).toBe('curl https://a.com');
    fim();
  });
});
