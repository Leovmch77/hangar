import * as Haptics from 'expo-haptics';
import { Platform } from 'react-native';

// Só no iOS (HIG): seleção ao marcar, notificação no resultado. Falha do motor de vibração não é erro do app.
function ios(run: () => Promise<void>) {
  if (Platform.OS === 'ios') void run().catch(() => {});
}

export const haptic = {
  selection: () => ios(() => Haptics.selectionAsync()),
  success: () => ios(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)),
  error: () => ios(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error)),
};
