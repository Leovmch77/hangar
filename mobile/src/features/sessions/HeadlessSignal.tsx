import { View } from 'react-native';
import Svg, { Path, Rect } from 'react-native-svg';
import { useUnistyles } from 'react-native-unistyles';
import * as m from '../../paraglide/messages';

// Terminal riscado do PWA; não há SF Symbol equivalente.
export function HeadlessSignal() {
  const { theme } = useUnistyles();
  const size = theme.base.text.xxs;
  return (
    <View accessibilityRole="image" accessibilityLabel={m.criar_modo_exec_headless()}>
      <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={theme.tokens.text.muted}
        strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round">
        <Rect x={3} y={5} width={18} height={14} rx={2} />
        <Path d="m7 10 2 2-2 2M12 14h4M4 4l16 16" />
      </Svg>
    </View>
  );
}
