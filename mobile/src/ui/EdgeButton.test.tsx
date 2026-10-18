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

it('ativa ao encostar e o arrasto da gaveta não interrompe; toque e rótulo chegam ao botão nativo', async () => {
  const onPress = vi.fn();
  const container = document.createElement('div');
  await act(async () => createRoot(container).render(
    createElement(EdgeButton, { onPress, accessibilityLabel: 'Voltar', children: 'ícone' }),
  ));
  expect(native.props).toMatchObject({ shouldActivateOnStart: true, disallowInterruption: true, accessible: true, accessibilityRole: 'button' });
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Voltar"]')!.click());
  expect(onPress).toHaveBeenCalledTimes(1);
});
