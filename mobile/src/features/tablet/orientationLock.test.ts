import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as ScreenOrientation from 'expo-screen-orientation';
import { applyOrientationLock, orientationFor } from './orientationLock';

const { getSize } = vi.hoisted(() => ({
  getSize: vi.fn(),
}));

vi.mock('react-native', () => ({ Dimensions: { get: getSize } }));
const lockAsync = vi.spyOn(ScreenOrientation, 'lockAsync');
const unlockAsync = vi.spyOn(ScreenOrientation, 'unlockAsync');

beforeEach(() => {
  vi.resetAllMocks();
  getSize.mockImplementation((kind) => kind === 'screen'
    ? { width: 800, height: 1280 }
    : { width: 507, height: 820 });
  lockAsync.mockResolvedValue(undefined);
  unlockAsync.mockResolvedValue(undefined);
});

describe('orientationFor', () => {
  it.each([
    ['celular em pé', 390, 844, 'portrait'],
    ['celular deitado', 844, 390, 'portrait'],
    ['tablet Android em pé', 800, 1280, 'free'],
    ['tablet deitado', 1280, 800, 'free'],
    ['menor lado abaixo de 600', 960, 599, 'portrait'],
    ['menor lado exatamente 600', 960, 600, 'free'],
  ] as const)('%s', (_name, width, height, expected) => {
    expect(orientationFor({ width, height })).toBe(expected);
  });
});

describe('applyOrientationLock', () => {
  it.each([
    ['em pé', 390, 844],
    ['deitado', 844, 390],
  ])('trava o celular %s em retrato', async (_name, width, height) => {
    getSize.mockReturnValue({ width, height });

    await applyOrientationLock();

    expect(getSize).toHaveBeenCalledWith('screen');
    expect(lockAsync).toHaveBeenCalledExactlyOnceWith(3);
    expect(unlockAsync).not.toHaveBeenCalled();
  });

  it('libera o tablet pela tela física mesmo com a janela estreita', async () => {
    await applyOrientationLock();

    expect(getSize).toHaveBeenCalledExactlyOnceWith('screen');
    expect(unlockAsync).toHaveBeenCalledExactlyOnceWith();
    expect(lockAsync).not.toHaveBeenCalled();
  });
});
