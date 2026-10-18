import { forwardRef, useImperativeHandle, useRef, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { AnchoredPanel } from '../../ui/AnchoredPanel';
import { SettingsList } from '../../ui/SettingsList';
import { Icon, type IconName } from '../../ui/Icon';
import * as m from '../../paraglide/messages';
import type { PillAction } from './QuietPill';

type Props = {
  icon: IconName;
  label: string;
  value: string;
  // Linha de baixo do rótulo (caminho da pasta, motivo da cota).
  detail?: string;
  disabled?: boolean;
  actions?: PillAction[];
  menuTitle?: string;
  onAction?: (id: string) => void;
  onPress?: () => void;
  tone?: 'warning' | 'accent';
};

// Linha de ajuste do formulário Nova sessão (estilo Ajustes do iOS). Mesmo menu preso da QuietPill:
// as escolhas são as mesmas, só a forma muda.
export const SettingRow = forwardRef<View, Props>(function SettingRow(
  { icon, label, value, detail, disabled, actions, menuTitle, onAction, onPress, tone }, ref,
) {
  const anchor = useRef<View>(null);
  useImperativeHandle(ref, () => anchor.current!, []);
  const [open, setOpen] = useState(false);
  const { theme } = useUnistyles();
  const ink = tone === 'warning' ? theme.tokens.status.warning : tone === 'accent' ? theme.tokens.accent.base : theme.tokens.text.secondary;
  return (
    <>
      <Pressable
        ref={anchor}
        onPress={actions ? () => setOpen(true) : onPress}
        disabled={disabled}
        accessibilityRole="button"
        accessibilityLabel={`${label}: ${value}`}
        accessibilityState={{ disabled: !!disabled }}
        style={({ pressed }) => [styles.row, pressed && styles.pressed, disabled && styles.disabled]}
      >
        <Icon name={icon} size={18} color={theme.tokens.text.secondary} />
        <View style={styles.texts}>
          <Text style={styles.label} numberOfLines={1}>{label}</Text>
          {detail ? <Text style={styles.detail} numberOfLines={1} ellipsizeMode="head">{detail}</Text> : null}
        </View>
        <Text style={[styles.value, { color: ink }]} numberOfLines={1}>{value}</Text>
        <Icon name={actions ? 'ChevronsUpDown' : 'ChevronRight'} size={14} color={theme.tokens.text.muted} />
      </Pressable>
      {actions ? <AnchoredPanel open={open && !disabled} anchor={anchor.current} onClose={() => setOpen(false)}
        label={menuTitle ?? label} closeLabel={m.native_close()} radius={12} padding={4}>
        <SettingsList items={actions.map((it) => ({ id: it.id, label: it.title, hint: it.subtitle,
          selected: it.state === 'on', disabled: it.attributes?.disabled }))}
          onPick={(id) => { setOpen(false); onAction?.(id); }} />
      </AnchoredPanel> : null}
    </>
  );
});

const styles = StyleSheet.create((theme) => ({
  row: { minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: theme.base.space[3], paddingHorizontal: theme.base.space[3] },
  pressed: { backgroundColor: theme.tokens.bg.hover },
  disabled: { opacity: 0.5 },
  texts: { flexShrink: 0, maxWidth: '45%' },
  label: { fontSize: theme.base.text.base, color: theme.tokens.text.primary },
  detail: { fontSize: theme.base.text.xs, color: theme.tokens.text.muted },
  value: { flex: 1, textAlign: 'right', fontSize: theme.base.text.sm },
}));
