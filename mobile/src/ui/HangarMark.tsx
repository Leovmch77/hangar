import Svg, { Path } from 'react-native-svg';

// Marca do Hangar (dois arcos), a mesma do app nativo de PC. Na lista e no cabeçalho do chat ela
// carrega a cor do estado da sessão, no lugar da bolinha.
export function HangarMark({ size = 18, color }: { size?: number; color: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2.1} strokeLinecap="round">
      <Path d="M 4.00 15.40 A 8.90 8.90 0 1 1 20.00 15.40" />
      <Path d="M 6.82 12.60 A 5.30 5.30 0 1 1 17.18 12.60" />
    </Svg>
  );
}
