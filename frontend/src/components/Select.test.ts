// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';
import { mount, tick, unmount } from 'svelte';
import Select from './Select.svelte';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('abre menu legível, pesquisa caminho e mantém seleção/foco sem vazar Escape', async () => {
  const target = document.body.appendChild(document.createElement('div'));
  const onchange = vi.fn();
  const escaped = vi.fn();
  window.addEventListener('keydown', escaped);
  const component = mount(Select, { target, props: {
    value: '', ariaLabel: 'Projeto', filtroAcimaDe: 0, onchange,
    opcoes: [
      { value: '', label: 'Todos' },
      { value: '/pessoal/hangar', label: 'hangar', hint: 'US$ 100,00' },
      { value: '/trabalho/hangar', label: 'hangar', hint: 'US$ 50,00' },
    ],
  } });
  const settle = async () => { await tick(); await tick(); };
  try {
    await settle();
    const trigger = target.querySelector('button')!;
    vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue(new DOMRect(100, 100, 109, 40));
    trigger.click();
    await settle();
    expect((document.querySelector('.sel-lista') as HTMLElement).style.width).toBe('320px');
    const search = document.querySelector<HTMLInputElement>('.sel-filtro')!;
    expect(document.activeElement).toBe(search);
    expect(search.getAttribute('aria-label')).toContain('Projeto');
    expect(document.getElementById(search.getAttribute('aria-controls')!)?.getAttribute('role')).toBe('listbox');
    search.value = '/trabalho/';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    await settle();
    expect(document.querySelectorAll('[role="option"]')).toHaveLength(1);
    search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await settle();
    expect(onchange).toHaveBeenCalledWith('/trabalho/hangar');
    expect(document.querySelector('.sel-lista')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    trigger.click();
    await settle();
    escaped.mockClear();
    document.querySelector('.sel-filtro')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await settle();
    expect(escaped).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(trigger);
    trigger.click();
    await settle();
    const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    document.querySelector('.sel-filtro')!.dispatchEvent(tab);
    await settle();
    expect(tab.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(trigger);
    expect(document.querySelector('.sel-lista')).toBeNull();
  } finally { window.removeEventListener('keydown', escaped); await unmount(component); target.remove(); }
});

it('limita o menu à tela estreita e ancora a lista curta acima do campo', async () => {
  vi.stubGlobal('innerWidth', 390);
  vi.stubGlobal('innerHeight', 844);
  const target = document.body.appendChild(document.createElement('div'));
  const component = mount(Select, { target, props: {
    value: 'codex', ariaLabel: 'CLI', onchange: vi.fn(), opcoes: [{ value: 'codex', label: 'Codex' }],
  } });
  try {
    await tick();
    const trigger = target.querySelector('button')!;
    vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue(new DOMRect(280, 780, 102, 40));
    trigger.click();
    await tick(); await tick();
    const style = (document.querySelector('.sel-lista') as HTMLElement).style;
    expect(style.width).toBe('374px');
    expect(style.left).toBe('8px');
    expect(style.top).toBe('auto');
    expect(style.bottom).toBe('68px');
  } finally { await unmount(component); target.remove(); }
});

it('modo livre: digitar vale como valor e filtra; Enter escolhe; aviso toma o lugar da lista', async () => {
  const target = document.body.appendChild(document.createElement('div'));
  const onchange = vi.fn();
  const aoAbrir = vi.fn();
  const opcoes = [{ value: 'openai/gpt-4o', label: 'openai/gpt-4o' }, { value: 'anthropic/claude-haiku', label: 'anthropic/claude-haiku' }];
  const settle = async () => { await tick(); await tick(); };
  const buscando = mount(Select, { target, props: { value: '', livre: true, aviso: 'buscando', aoAbrir, onchange, opcoes } });
  try {
    await settle();
    target.querySelector<HTMLInputElement>('input[role="combobox"]')!.click();
    await settle();
    expect(aoAbrir).toHaveBeenCalledTimes(1);
    expect(document.querySelector('.sel-lista [role="status"]')?.textContent).toBe('buscando');
    expect(document.querySelectorAll('[role="option"]')).toHaveLength(0);
  } finally {
    unmount(buscando);
  }
  const component = mount(Select, { target, props: { value: '', livre: true, ariaLabel: 'Modelo', vazio: 'nenhum com esse nome', onchange, opcoes } });
  try {
    await settle();
    const campo = target.querySelector<HTMLInputElement>('input[role="combobox"]')!;
    campo.value = 'HAIKU';
    campo.dispatchEvent(new Event('input', { bubbles: true }));
    await settle();
    expect(onchange).toHaveBeenLastCalledWith('HAIKU');
    expect(document.querySelectorAll('[role="option"]')).toHaveLength(1);
    // Nada destacado depois de digitar: a seta escolhe, e só então o Enter troca o texto.
    expect(campo.getAttribute('aria-activedescendant')).toBeNull();
    campo.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    await settle();
    campo.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await settle();
    expect(onchange).toHaveBeenLastCalledWith('anthropic/claude-haiku');
    expect(document.querySelector('.sel-lista')).toBeNull();
    // Texto fora da lista continua valendo: Enter só fecha.
    campo.value = 'meu/modelo';
    campo.dispatchEvent(new Event('input', { bubbles: true }));
    await settle();
    expect(document.querySelector('.sel-vazio')?.textContent).toBe('nenhum com esse nome');
    campo.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await settle();
    expect(onchange).toHaveBeenLastCalledWith('meu/modelo');
    expect(document.querySelector('.sel-lista')).toBeNull();
  } finally {
    unmount(component);
    target.remove();
  }
});
