import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isTabletLandscape, useTabletLandscape } from './layout';

const { windowSize } = vi.hoisted(() => ({ windowSize: { width: 390, height: 844 } }));
vi.mock('react-native', () => ({ useWindowDimensions: () => windowSize }));

describe('isTabletLandscape', () => {
  it.each([
    ['iPad deitado', 1180, 820, true],
    ['iPad em pé', 820, 1180, false],
    ['Split View estreito', 507, 820, false],
    ['celular deitado', 844, 390, false],
    ['menor lado exatamente 600', 960, 600, true],
    ['menor lado abaixo de 600', 960, 599, false],
    ['janela quadrada', 820, 820, false],
  ])('%s', (_name, width, height, expected) => {
    expect(isTabletLandscape({ width, height })).toBe(expected);
  });
});

describe('useTabletLandscape', () => {
  beforeEach(() => { Object.assign(windowSize, { width: 390, height: 844 }); });

  it('acompanha o tamanho atual da janela ao girar e entrar em Split View', () => {
    expect(useTabletLandscape()).toBe(false);
    Object.assign(windowSize, { width: 1180, height: 820 });
    expect(useTabletLandscape()).toBe(true);
    Object.assign(windowSize, { width: 507, height: 820 });
    expect(useTabletLandscape()).toBe(false);
  });
});
