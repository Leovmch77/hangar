import type { ReactNode } from 'react';
import { Text, View, type LayoutChangeEvent } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Icon, type IconName } from '../../ui/Icon';
import { superficie } from '../../theme/superficie';
import { useSettingsColors } from './colors';

/**
 * Cartão de seção das Configurações (section_head + settings_box do Rust): quadradinho de destaque
 * com o ícone, título e a linha que explica. Sem `icon`/`title` é só a caixa, para linhas com ícone próprio.
 */
export function SectionCard({
  icon,
  title,
  subtitle,
  extra,
  children,
  onLayout,
}: {
  icon?: IconName;
  title?: string;
  subtitle?: string;
  /** Peça à direita do título (pílula de ação). */
  extra?: ReactNode;
  children?: ReactNode;
  onLayout?: (e: LayoutChangeEvent) => void;
}) {
  const { theme } = useUnistyles();
  const c = useSettingsColors();
  return (
    <View
      onLayout={onLayout}
      style={[styles.box, { borderColor: c.border, backgroundColor: superficie(theme, 0.6) }]}
    >
      {icon && title ? (
        <View style={styles.head}>
          <View style={[styles.square, { backgroundColor: c.accentDim }]}>
            <Icon name={icon} size={17} color={c.accentText} />
          </View>
          <View style={styles.texts}>
            <Text style={[styles.title, { color: c.text }]} accessibilityRole="header">{title}</Text>
            {subtitle ? <Text style={[styles.subtitle, { color: c.muted }]}>{subtitle}</Text> : null}
          </View>
          {extra}
        </View>
      ) : null}
      {/* Sem cabeçalho a divisória da primeira linha encostaria na borda da caixa: sobe 1px e some. */}
      <View style={icon && title ? undefined : styles.bare}>{children}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  box: { borderRadius: 14, borderWidth: 1, overflow: 'hidden' },
  head: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 14, paddingHorizontal: 16 },
  square: { width: 32, height: 32, borderRadius: 9, alignItems: 'center', justifyContent: 'center' },
  texts: { flex: 1, minWidth: 0, gap: 2 },
  title: { fontSize: 15, fontWeight: '600' },
  subtitle: { fontSize: 13.5 },
  bare: { marginTop: -1 },
});
