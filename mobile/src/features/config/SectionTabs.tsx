import { Pressable, ScrollView, Text, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { superficie } from '../../theme/superficie';
import { useSettingsColors } from './colors';

export interface Tab<K extends string> {
  key: K;
  label: string;
}

/** Atalhos para as seções da Aparência (section_tabs do Rust): tocar rola até a seção. */
export function SectionTabs<K extends string>({
  tabs,
  current,
  onPick,
}: {
  tabs: ReadonlyArray<Tab<K>>;
  current: K | null;
  onPick: (k: K) => void;
}) {
  const { theme } = useUnistyles();
  const c = useSettingsColors();
  return (
    // Fica preso no topo da rolagem: o trilho precisa de fundo próprio para o conteúdo não atravessar.
    <View style={styles.sticky}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={[styles.rail, { borderColor: c.border, backgroundColor: superficie(theme, 0.95) }]}
        contentContainerStyle={styles.railContent}
      >
        {tabs.map((t) => {
          const on = t.key === current;
          return (
            <Pressable
              key={t.key}
              onPress={() => onPick(t.key)}
              accessibilityRole="tab"
              accessibilityState={{ selected: on }}
              style={({ pressed }) => [
                styles.tab,
                { backgroundColor: on ? c.accentDim : pressed ? c.hover : 'transparent' },
              ]}
            >
              <Text style={[styles.text, { color: on ? c.accentText : c.muted }]}>{t.label}</Text>
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  sticky: { paddingVertical: theme.base.space[1.5] },
  rail: { flexGrow: 0, borderWidth: 1, borderRadius: theme.base.radius.sm },
  railContent: { padding: theme.base.space[0.5], gap: theme.base.space[1] },
  tab: { height: 32, paddingHorizontal: theme.base.space[3], borderRadius: theme.base.radius.sm, justifyContent: 'center' },
  text: { fontSize: theme.base.text.sm, fontWeight: theme.base.weight.medium },
}));
