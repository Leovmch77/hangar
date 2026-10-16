import { useState } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Icon } from './Icon';
import * as m from '../paraglide/messages';

export interface SettingsItem {
  id: string;
  label: string;
  hint?: string;
  selected?: boolean;
  disabled?: boolean;
}

export function SettingsList({ items, onPick, searchable = true }: {
  items: SettingsItem[]; onPick: (id: string) => void; searchable?: boolean;
}) {
  const { theme } = useUnistyles();
  const [query, setQuery] = useState('');
  const long = searchable && items.length > 8;
  const q = long ? query.trim().toLowerCase() : '';
  const visible = q ? items.filter((it) => `${it.label} ${it.hint ?? ''}`.toLowerCase().includes(q)) : items;
  return <>
    {long ? <View style={styles.search}>
      <Icon name="Search" size={14} color={theme.tokens.text.muted} />
      <TextInput value={query} onChangeText={setQuery} placeholder={m.native_ctl_search()}
        accessibilityLabel={m.native_ctl_search()} placeholderTextColor={theme.tokens.text.muted}
        autoCorrect={false} autoCapitalize="none" returnKeyType="search" style={styles.searchInput} />
    </View> : null}
    {visible.length ? <ScrollView style={styles.list} keyboardShouldPersistTaps="handled" nestedScrollEnabled accessibilityRole="radiogroup">
      {visible.map((it) => <Pressable key={it.id} onPress={() => onPick(it.id)} disabled={it.disabled}
        style={({ pressed }) => [styles.row, { backgroundColor: it.selected ? theme.tokens.accent.dim : pressed ? theme.tokens.fillSubtle : 'transparent' }, it.disabled && styles.disabled]}
        accessibilityRole="radio" accessibilityLabel={it.label} accessibilityHint={it.hint}
        accessibilityState={{ selected: !!it.selected, disabled: !!it.disabled }}>
        <Text style={styles.rowText} numberOfLines={2}>
          <Text style={styles.modelName}>{it.label}</Text>
          {it.hint ? <Text style={styles.detail}>{`  ${it.hint}`}</Text> : null}
        </Text>
        {it.selected ? <Icon name="Check" size={16} color={theme.tokens.accent.base} /> : null}
      </Pressable>)}
    </ScrollView> : <Text style={styles.empty}>{q ? m.native_ctl_no_results() : m.comum_nenhum_modelo()}</Text>}
  </>;
}

const styles = StyleSheet.create((theme) => ({
  search: { height: 32, marginHorizontal: 4, marginBottom: 4, flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 8, borderRadius: 8, borderWidth: 1, borderColor: theme.tokens.border.default, backgroundColor: theme.tokens.fillSubtle },
  searchInput: { flex: 1, padding: 0, fontSize: 13, color: theme.tokens.text.primary },
  list: { flexGrow: 0, flexShrink: 1, minHeight: 72, maxHeight: 288 },
  row: { minHeight: 36, flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 8, paddingVertical: 6, borderRadius: 7 },
  rowText: { flex: 1, minWidth: 0, fontSize: 13, color: theme.tokens.text.primary },
  modelName: { fontWeight: '500' },
  detail: { fontSize: 12, color: theme.tokens.text.muted },
  empty: { paddingHorizontal: 8, paddingVertical: 16, fontSize: 12, textAlign: 'center', color: theme.tokens.text.muted },
  disabled: { opacity: 0.5 },
}));
