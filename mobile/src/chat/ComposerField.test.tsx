// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { ComposerActions, modeMenuHandlers } from './ComposerField';
import * as m from '../paraglide/messages';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type MenuProps = { actions: { id: string; title: string; state?: string; attributes?: { disabled?: boolean } }[];
  onPressAction: (e: { nativeEvent: { event: string } }) => void; children: ReactNode };
const menu = vi.hoisted(() => ({ last: null as null | MenuProps }));
// O mock de react-native diz Android: o toque longo é do MenuView.
vi.mock('@react-native-menu/menu', () => ({ MenuView: (props: MenuProps) => { menu.last = props; return createElement('div', null, props.children); } }));
const native = vi.hoisted(() => ({ platform: { OS: 'android', select: (x: Record<string, unknown>) => x.android ?? x.default },
  sheet: { showActionSheetWithOptions: (() => {}) as (o: unknown, cb: (i: number) => void) => void } }));
vi.mock('react-native', async (original) => ({ ...await original<object>(), Platform: native.platform, ActionSheetIOS: native.sheet }));
vi.mock('../ui/Icon', () => ({ Icon: () => null }));
vi.mock('../ui/Glass', () => ({ Glass: ({ children }: { children: ReactNode }) => createElement('div', null, children) }));
vi.mock('../ui/MultilineInput', () => ({ MultilineInput: () => null }));
vi.mock('../ui/RecordingWave', () => ({ RecordingWave: () => null }));

function render(status: 'ready' | 'setup', sendDisabled: boolean) {
  const onPick = vi.fn();
  const onSend = vi.fn();
  const container = document.createElement('div');
  const root = createRoot(container);
  act(() => root.render(createElement(ComposerActions, {
    attach: { onPress: vi.fn(), disabled: false },
    mic: { onPress: vi.fn(), disabled: false, recording: false, styleLabel: 'cru', onStyle: vi.fn() },
    send: { onPress: onSend, disabled: sendDisabled, label: 'enviar' },
    settings: null,
    modeMenu: { delivery: { mode: 'direct', status, help: 'jev-help' }, onPick },
  })));
  return { container, root, onPick, onSend };
}

it('toque longo no Enviar troca o modo sem enviar; o Enviar continua desativado com o campo vazio', () => {
  const { container, root, onPick, onSend } = render('ready', true);
  // O PopupMenu do Android não marca a opção (state é só iOS): a atual vem dita no título.
  expect(menu.last!.actions.map((a) => a.title)).toEqual([m.mobile_queue_mode_queued(),
    m.mobile_queue_mode_selected({ mode: m.mobile_queue_mode_direct() }), m.mobile_queue_mode_jev()]);
  act(() => menu.last!.onPressAction({ nativeEvent: { event: 'jev' } }));
  expect(onPick).toHaveBeenCalledWith('jev');
  act(() => menu.last!.onPressAction({ nativeEvent: { event: 'direct' } }));
  expect(onPick).toHaveBeenCalledTimes(1);
  const send = container.querySelector<HTMLButtonElement>('[aria-label="enviar"]')!;
  expect(send.disabled).toBe(true);
  act(() => send.click());
  expect(onSend).not.toHaveBeenCalled();
  act(() => root.unmount());
});

it('Jev indisponível vem desativado no menu e não é escolhido', () => {
  const { root, onPick } = render('setup', false);
  expect(menu.last!.actions.find((a) => a.id === 'jev')?.attributes?.disabled).toBe(true);
  act(() => menu.last!.onPressAction({ nativeEvent: { event: 'jev' } }));
  expect(onPick).not.toHaveBeenCalled();
  act(() => root.unmount());
});

it('iOS: folha de ações só com os modos possíveis, a atual e a causa do Jev na mensagem', () => {
  const sheet = vi.fn();
  native.sheet.showActionSheetWithOptions = sheet;
  const onPick = vi.fn();
  modeMenuHandlers({ delivery: { mode: 'jev', status: 'setup', help: 'jev-help' }, onPick })!.openIOS();
  const [options, done] = sheet.mock.calls[0] as [{ options: string[]; cancelButtonIndex: number; message: string }, (i: number) => void];
  expect(options.options).toEqual([m.mobile_queue_mode_queued(), m.mobile_queue_mode_direct(), m.comum_cancelar()]);
  expect(options.cancelButtonIndex).toBe(2);
  expect(options.message).toContain(m.mobile_queue_mode_current({ mode: m.mobile_queue_mode_queued() }));
  expect(options.message).toContain('jev-help');
  done(2);
  expect(onPick).not.toHaveBeenCalled();
  // Fila aparece como a atual, mas o salvo é Jev: escolher Fila grava a troca.
  done(0);
  expect(onPick).toHaveBeenLastCalledWith('queued');
  done(1);
  expect(onPick).toHaveBeenLastCalledWith('direct');
});

it('leitor de tela: uma ação por modo possível, nas duas plataformas', () => {
  const onPick = vi.fn();
  const handlers = modeMenuHandlers({ delivery: { mode: 'queued', status: 'setup', help: 'jev-help' }, onPick })!;
  expect(handlers.a11yActions).toEqual([{ name: 'queued', label: m.mobile_queue_mode_queued() }, { name: 'direct', label: m.mobile_queue_mode_direct() }]);
  handlers.pick('direct');
  expect(onPick).toHaveBeenCalledWith('direct');
});
