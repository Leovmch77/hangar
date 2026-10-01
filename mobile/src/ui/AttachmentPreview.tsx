import { Pressable, Text, View } from 'react-native';
import { Image } from 'expo-image';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Icon } from './Icon';
import { superficie } from '../theme/superficie';
import * as m from '../paraglide/messages';
import type { PickedAttachment } from './attachmentPicker';

// O anexo à espera do Enviar, acima do campo: miniatura (ou clipe), nome, tamanho e remover.
export function AttachmentPreview({ attachment, onRemove, disabled }: {
  attachment: PickedAttachment;
  onRemove: () => void;
  disabled?: boolean;
}) {
  const { theme } = useUnistyles();
  return (
    <View style={[styles.preview, { backgroundColor: superficie(theme, 0.8), borderColor: theme.tokens.border.subtle }]}>
      {attachment.kind === 'image' ? (
        <Image source={{ uri: attachment.uri }} style={styles.thumb} contentFit="cover" transition={150} />
      ) : (
        <View style={[styles.fileIcon, { backgroundColor: superficie(theme) }]}>
          <Icon name="Paperclip" size={18} color={theme.tokens.text.secondary} />
        </View>
      )}
      <View style={styles.info}>
        <Text style={[styles.name, { color: theme.tokens.text.primary }]} numberOfLines={1}>{attachment.name}</Text>
        {attachment.size ? (
          <Text style={[styles.meta, { color: theme.tokens.text.muted }]}>{Math.round(attachment.size / 1024)} KB</Text>
        ) : null}
      </View>
      <Pressable
        onPress={onRemove}
        disabled={disabled}
        style={[styles.remove, { borderColor: theme.tokens.border.subtle }, disabled && styles.disabled]}
        accessibilityLabel={m.board_remover_anexo()}
        accessibilityRole="button"
        accessibilityState={{ disabled: !!disabled }}
      >
        <Icon name="X" size={16} color={theme.tokens.text.secondary} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  preview: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.base.space[2],
    padding: theme.base.space[2],
    borderRadius: theme.base.radius.md,
    borderWidth: 1,
  },
  thumb: { width: 48, height: 48, borderRadius: theme.base.radius.sm, backgroundColor: superficie(theme) },
  fileIcon: { width: 48, height: 48, borderRadius: theme.base.radius.sm, alignItems: 'center', justifyContent: 'center' },
  info: { flex: 1, gap: 2 },
  name: { fontSize: theme.base.text.sm, fontWeight: '600' },
  meta: { fontSize: theme.base.text.xs },
  remove: { width: 44, height: 44, borderRadius: theme.base.radius.full, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  disabled: { opacity: 0.5 },
}));
