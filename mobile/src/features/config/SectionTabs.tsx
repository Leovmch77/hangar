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

const styles = StyleSheet.create({
  sticky: { paddingVertical: 6 },
  rail: { flexGrow: 0, borderWidth: 1, borderRadius: 10 },
  railContent: { padding: 3, gap: 4 },
  tab: { height: 32, paddingHorizontal: 11, borderRadius: 7, justifyContent: 'center' },
  text: { fontSize: 15, fontWeight: '500' },
});
