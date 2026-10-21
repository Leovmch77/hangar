import Svg, { Circle, Path, Rect } from 'react-native-svg';

// Glifo do grupo do app de PC (desktop-native/assets/group-glyph.svg); não há SF Symbol equivalente.
export function GroupGlyph({ size, color }: { size: number; color: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M13 12h4a3 3 0 0 1 3 3v2h-7" opacity={0.55} />
      <Rect x={3} y={9} width={10} height={8} rx={2} />
      <Path d="M8 9V6" />
      <Circle cx={6.5} cy={13} r={1} fill={color} stroke="none" />
      <Circle cx={9.5} cy={13} r={1} fill={color} stroke="none" />
    </Svg>
  );
}
