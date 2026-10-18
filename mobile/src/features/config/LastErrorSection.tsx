import { useState } from 'react';
import { Pressable, Share, Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import * as Clipboard from 'expo-clipboard';
import { readFatalError } from '../../net/fatalErrors';
import { toast } from '../../ui/Toast';
import { SectionCard } from './SectionCard';
import { SettingsRow } from './SettingsRow';
import { InfoNotice } from './InfoNotice';
import * as m from '../../paraglide/messages';

export function LastErrorSection() {
  const [saved] = useState(() => {
    try { return { report: readFatalError(), failed: false }; }
    catch { return { report: null, failed: true }; }
  });
  const text = saved.report ? JSON.stringify(saved.report, null, 2) : '';
  const copy = async () => {
    try { await Clipboard.setStringAsync(text); toast.ok(m.toast_copiado()); }
    catch { toast.erro(m.native_last_error_copy_failed()); }
  };
  const share = async () => {
    try { await Share.share({ message: text }); }
    catch { toast.erro(m.native_last_error_export_failed()); }
  };
  return (
    <SectionCard icon="Info" title={m.native_last_error_title()}>
      {saved.report ? (
        <>
          <SettingsRow title={saved.report.name} description={m.native_last_error_privacy()}>
            <Text selectable style={styles.report}>{text}</Text>
            <View style={styles.actions}>
              <Pressable accessibilityRole="button" accessibilityLabel={m.native_last_error_copy()} onPress={copy} style={styles.action}>
                <Text style={styles.actionText}>{m.native_last_error_copy()}</Text>
              </Pressable>
              <Pressable accessibilityRole="button" accessibilityLabel={m.native_last_error_export()} onPress={share} style={styles.action}>
                <Text style={styles.actionText}>{m.native_last_error_export()}</Text>
              </Pressable>
            </View>
          </SettingsRow>
        </>
      ) : saved.failed ? <InfoNotice text={m.native_last_error_read_failed()} />
        : <SettingsRow title={m.native_last_error_empty()} />}
    </SectionCard>
  );
}

const styles = StyleSheet.create(theme => ({
  report: { fontFamily: theme.base.fontMono, fontSize: theme.base.text.xxs, color: theme.tokens.text.primary },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  action: { minHeight: 44, paddingHorizontal: 12, justifyContent: 'center' },
  actionText: { fontSize: theme.base.text.sm, color: theme.tokens.accent.base },
}));
