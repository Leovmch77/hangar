import { Dimensions } from 'react-native';
import * as ScreenOrientation from 'expo-screen-orientation';
import { TABLET_MIN_SIDE } from './layout';

export function orientationFor({ width, height }: { width: number; height: number }): 'portrait' | 'free' {
  return Math.min(width, height) < TABLET_MIN_SIDE ? 'portrait' : 'free';
}

export async function applyOrientationLock(screen = Dimensions.get('screen')): Promise<void> {
  if (orientationFor(screen) === 'portrait') {
    await ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP);
  } else {
    await ScreenOrientation.unlockAsync();
  }
}
