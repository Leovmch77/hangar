import * as Haptics from 'expo-haptics';
import { Platform } from 'react-native';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { haptic } from './haptics';

describe('haptic', () => {
  afterEach(() => {
    Platform.OS = 'android';
    vi.restoreAllMocks();
  });

  it('vibra no iOS com o tipo certo', () => {
    Platform.OS = 'ios';
    const sel = vi.spyOn(Haptics, 'selectionAsync');
    const note = vi.spyOn(Haptics, 'notificationAsync');
    haptic.selection();
    haptic.success();
    haptic.error();
    expect(sel).toHaveBeenCalledTimes(1);
    expect(note.mock.calls).toEqual([[Haptics.NotificationFeedbackType.Success], [Haptics.NotificationFeedbackType.Error]]);
  });

  it('não vibra no Android', () => {
    const sel = vi.spyOn(Haptics, 'selectionAsync');
    const note = vi.spyOn(Haptics, 'notificationAsync');
    haptic.selection();
    haptic.success();
    haptic.error();
    expect(sel).not.toHaveBeenCalled();
    expect(note).not.toHaveBeenCalled();
  });
});
