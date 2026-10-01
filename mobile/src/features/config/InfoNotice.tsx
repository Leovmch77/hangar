import { Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Icon } from '../../ui/Icon';
import { useSettingsColors } from './colors';

export function InfoNotice({ text }: { text: string }) {
  const c = useSettingsColors();
  return (
    <View style={[styles.box, { backgroundColor: c.accentDim }]}>
      <View style={styles.icon}><Icon name="Info" size={15} color={c.accentText} /></View>
      <Text style={[styles.text, { color: c.text }]}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  box: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10 },
  icon: { paddingTop: 1 },
  text: { flex: 1, fontSize: 14, lineHeight: 18 },
});
