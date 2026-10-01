import type { ReactNode } from 'react';
import { Pressable, Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Icon, type IconName } from '../../ui/Icon';
import { useSettingsColors } from './colors';

type Props = {
  title: string;
  description?: string;
  /** Ícone na caixinha à esquerda; sem ele, a linha usa o ícone da seção (line_with do Rust). */
  icon?: IconName;
  onPress?: () => void;
  onLongPress?: () => void;
  /** Controle da linha (segmentado, slider, cores): no celular desce para baixo do título. */
  children?: ReactNode;
  /** Peça à direita do título, na mesma linha (ponto de estado, botão pequeno). */
  right?: ReactNode;
};

// O Pressable envolve só o bloco ícone+título, nunca a linha inteira: um Pressable com rótulo
// próprio funde tudo que está dentro dele num nó só de acessibilidade, e o botão de `right`
// ou do controle some pro leitor de tela.
export function SettingsRow({ title, description, icon, onPress, onLongPress, children, right }: Props) {
  const c = useSettingsColors();
  const head = (
    <>
      {icon ? (
        <View style={[styles.iconBox, { borderColor: c.border, backgroundColor: c.inset }]}>
          <Icon name={icon} size={16} color={c.muted} />
        </View>
      ) : null}
      <View style={styles.texts}>
        <Text style={[icon ? styles.title : styles.titleSmall, { color: c.text }]}>{title}</Text>
        {description ? (
          <Text style={[icon ? styles.desc : styles.descSmall, { color: c.muted }]}>{description}</Text>
        ) : null}
      </View>
      {/* Chevron só na linha que é pura navegação: com controle ou botão próprio ele viraria enfeite ambíguo. */}
      {onPress && !children && !right ? <Icon name="ChevronRight" size={18} color={c.faint} /> : null}
    </>
  );
  return (
    <View style={[styles.row, { borderTopColor: c.border }]}>
      <View style={styles.headLine}>
        {onPress || onLongPress ? (
          <Pressable
            onPress={onPress}
            onLongPress={onLongPress}
            accessibilityRole="button"
            accessibilityLabel={title}
            style={({ pressed }) => [styles.head, pressed && { opacity: 0.6 }]}
          >
            {head}
          </Pressable>
        ) : (
          <View style={styles.head}>{head}</View>
        )}
        {right}
      </View>
      {children ? <View style={icon ? styles.controlIndented : undefined}>{children}</View> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { borderTopWidth: 1, paddingVertical: 14, paddingHorizontal: 16, gap: 10 },
  headLine: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  head: { flex: 1, minHeight: 36, flexDirection: 'row', alignItems: 'center', gap: 14 },
  iconBox: { width: 36, height: 36, borderRadius: 10, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  texts: { flex: 1, minWidth: 0, gap: 2 },
  title: { fontSize: 15, fontWeight: '500' },
  desc: { fontSize: 14 },
  titleSmall: { fontSize: 15, fontWeight: '500' },
  descSmall: { fontSize: 13.5 },
  controlIndented: { paddingLeft: 50 },
});
