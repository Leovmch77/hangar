// @vitest-environment happy-dom
// O cérebro do raciocínio é o `brain` atual do Lucide, o mesmo do T3 e do app nativo.
import { describe, it, expect } from 'vitest';
import { mount, unmount } from 'svelte';
import IconCerebro from './IconCerebro.svelte';

const LUCIDE_BRAIN = [
  'M12 18V5',
  'M15 13a4.17 4.17 0 0 1-3-4 4.17 4.17 0 0 1-3 4',
  'M17.598 6.5A3 3 0 1 0 12 5a3 3 0 1 0-5.598 1.5',
  'M17.997 5.125a4 4 0 0 1 2.526 5.77',
  'M18 18a4 4 0 0 0 2-7.464',
  'M19.967 17.483A4 4 0 1 1 12 18a4 4 0 1 1-7.967-.517',
  'M6 18a4 4 0 0 1-2-7.464',
  'M6.003 5.125a4 4 0 0 0-2.526 5.77',
];

describe('IconCerebro', () => {
  it('desenha o brain atual do Lucide, no tamanho pedido e escondido do leitor de tela', () => {
    const el = document.createElement('div');
    const comp = mount(IconCerebro, { target: el, props: { size: 15 } });
    const svg = el.querySelector('svg')!;
    expect([...svg.querySelectorAll('path')].map((p) => p.getAttribute('d'))).toEqual(LUCIDE_BRAIN);
    expect(svg.getAttribute('width')).toBe('15');
    expect(svg.getAttribute('aria-hidden')).toBe('true');
    unmount(comp);
  });
});
