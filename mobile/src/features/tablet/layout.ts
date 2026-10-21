import { useWindowDimensions } from 'react-native';

export const TABLET_MIN_SIDE = 600;

export function isTabletLandscape({ width, height }: { width: number; height: number }): boolean {
  return Math.min(width, height) >= TABLET_MIN_SIDE && width > height;
}

export function useTabletLandscape(): boolean {
  return isTabletLandscape(useWindowDimensions());
}
