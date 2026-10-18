// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const native = vi.hoisted(() => ({ props: {} as Record<string, unknown> }));
vi.mock('react-native-gesture-handler', async (original) => {
  const mock = await original<{ BaseButton: (props: Record<string, unknown>) => ReactNode }>();
  return { ...mock, BaseButton: (props: Record<string, unknown>) => { native.props = props; return mock.BaseButton(props); } };
});

import { EdgeButton } from './EdgeButton';

async function render(onPress: () => void) {
  const container = document.createElement('div');
  await act(async () => createRoot(container).render(
    createElement(EdgeButton, { onPress, accessibilityLabel: 'Voltar', children: 'ícone' }),
  ));
  return container;
}

it('ativa ao encostar e o arrasto da gaveta não interrompe', async () => {
  await render(() => {});
  expect(native.props).toMatchObject({ shouldActivateOnStart: true, disallowInterruption: true });
});

it('toque que termina fora do botão não dispara a ação', async () => {
  const onPress = vi.fn();
  await render(onPress);
  const press = native.props.onPress as (pointerInside: boolean) => void;
  act(() => press(false));
  expect(onPress).not.toHaveBeenCalled();
  act(() => press(true));
  expect(onPress).toHaveBeenCalledTimes(1);
});

it('o leitor de tela encontra o botão no filho, como o gesture-handler exige', async () => {
  const container = await render(() => {});
  expect(native.props.accessibilityLabel).toBeUndefined();
  const target = container.querySelector('[aria-label="Voltar"]');
  expect(target?.getAttribute('role')).toBe('button');
  expect(target?.tagName).not.toBe('BUTTON');
});
