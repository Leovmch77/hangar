import { useMemo, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { parseStatusLine } from '@hangar/core';
import { chatStore } from '../stores/chat';
import { Sheet } from '../ui/Sheet';
import { Icon } from '../ui/Icon';
import { ModelPill } from '../features/pills/ModelPill';
import { EffortPill } from '../features/pills/EffortPill';
import { PermissionPill } from '../features/pills/PermissionPill';
import { settingsLabel, spacedModel } from './usage';
import { superficie } from '../theme/superficie';
import * as m from '../paraglide/messages';

interface Props {
  serverId: string;
  name: string;
}

// Botão único do composer: "Opus 5.5 · 1M  high" abre a folha com os três seletores. O anel de
// contexto e a folha de Uso moram na linha de status, embaixo do composer.
export function SessionSettingsButton({ serverId, name }: Props) {
  const { theme } = useUnistyles();
  const chat = chatStore(serverId, name);
  const statusLine = chat.use((s) => s.statusLine);
  const f = useMemo(() => parseStatusLine(statusLine), [statusLine]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Os seletores montam na primeira abertura: a Permissão lê o modo atual ao montar, e isso não
  // precisa acontecer a cada conversa aberta.
  const [settingsMounted, setSettingsMounted] = useState(false);
  const label = settingsLabel(f?.model, f?.effort);

  return (
    <>
      {/* A Pressable ocupa a sobra da linha (alvo de toque largo) e o chip visível encosta à direita:
          só encolhendo, o Android media o texto antes e cortava o rótulo mesmo com espaço livre.
          A folha é irmã, não filha: aninhada, o leitor de tela trataria tudo como um botão só. */}
      <Pressable
        onPress={() => {
          setSettingsMounted(true);
          setSettingsOpen(true);
        }}
        style={styles.slot}
        accessibilityRole="button"
        accessibilityLabel={m.composer_session_settings()}
        accessibilityValue={{ text: label }}
        accessibilityHint={m.composer_session_settings_hint()}
      >
        {({ pressed }) => (
          <View style={[styles.chip, { backgroundColor: pressed ? theme.tokens.bg.hover : superficie(theme, 0.6) }]}>
            <Text style={styles.label} numberOfLines={1}>
              <Text style={[styles.model, { color: theme.tokens.text.primary }]}>{f?.model ? spacedModel(f.model) : m.composer_modelo()}</Text>
              {f?.model && f.effort ? <Text style={{ color: theme.tokens.text.muted }}>{`  ${f.effort}`}</Text> : null}
            </Text>
            <Icon name="ChevronDown" size={12} color={theme.tokens.text.muted} />
          </View>
        )}
      </Pressable>

      <Sheet open={settingsOpen} onDismiss={() => setSettingsOpen(false)} sizes={['auto']}>
        <View style={styles.sheet}>
          <Text style={[styles.title, { color: theme.tokens.text.primary }]} accessibilityRole="header">
            {m.composer_session_settings()}
          </Text>
          {/* Cada linha abre o seletor de sempre por cima desta folha; ao escolher, ela volta. */}
          {settingsMounted ? (
            <>
              <ModelPill serverId={serverId} name={name} />
              <EffortPill serverId={serverId} name={name} />
              <PermissionPill serverId={serverId} name={name} />
            </>
          ) : null}
        </View>
      </Sheet>
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  slot: {
    flex: 1,
    minWidth: 44,
    minHeight: 40,
    alignItems: 'flex-end',
    justifyContent: 'center',
  },
  chip: {
    maxWidth: '100%',
    height: 28,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderRadius: theme.base.radius.xs,
    paddingHorizontal: theme.base.space[2],
  },
  label: {
    flexShrink: 1,
    fontSize: theme.base.text.xs,
  },
  model: {
    fontWeight: '600',
  },
  sheet: {
    padding: theme.base.space[3],
    gap: theme.base.space[1],
  },
  title: {
    fontSize: theme.base.text.base,
    fontWeight: '600',
    marginBottom: theme.base.space[2],
  },
}));
