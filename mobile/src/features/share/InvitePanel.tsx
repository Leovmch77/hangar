import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Platform, Pressable, Text, TextInput, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import Constants from 'expo-constants';
import { parseInviteLink, redeemInvite, type Server } from '@hangar/core';
import { useServers } from '../../stores/servers';
import { superficie } from '../../theme/superficie';
import * as m from '../../paraglide/messages';

export function InvitePanel({ initialLink = '', initialError = '', onAccepted }: { initialLink?: string; initialError?: string; onAccepted: (server: Server, session: string) => void }) {
  const { theme } = useUnistyles();
  const ready = useServers((state) => state.ready);
  const vaultReadable = useServers((state) => state.vaultReadable);
  const [link, setLink] = useState(initialLink);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(initialError);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const reloadVault = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try { await useServers.getState().load(); }
    finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  const accept = async () => {
    const state = useServers.getState();
    if (inFlight.current || !state.ready || !state.vaultReadable) return;
    const invite = parseInviteLink(link);
    if (!invite) { setError(m.mobile_share_invite_invalid()); return; }
    const matches = (server: Server) => {
      try { return new URL(server.baseUrl).origin === new URL(invite.address).origin; }
      catch { return false; }
    };
    if (state.servers.some((server) => !server.invite && matches(server))) {
      setError(m.mobile_share_invite_own_server());
      return;
    }
    const existing = state.servers.find((server) => server.invite && !server.ephemeral && matches(server));
    inFlight.current = true;
    setBusy(true);
    try {
      const result = await redeemInvite(link.trim(), Constants.deviceName || Platform.OS, undefined, existing?.token);
      const saved = useServers.getState().addInvite(result, mounted.current);
      if (!mounted.current) return;
      setError('');
      onAccepted(saved, result.session);
    } catch (cause) {
      if (mounted.current) setError(m.mobile_share_invite_failed({ error: cause instanceof Error ? cause.message : String(cause) }));
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  const disabled = !ready || !vaultReadable || busy;
  const vaultError = ready && !vaultReadable;
  const label = error ? m.mobile_share_invite_retry() : m.mobile_share_invite_accept();
  return (
    <View style={styles.inner}>
      <Text style={styles.title} accessibilityRole="header">{m.mobile_share_invite_title()}</Text>
      <Text style={styles.hint}>{m.mobile_share_invite_hint()}</Text>
      <Text style={styles.label}>{m.mobile_share_invite_link_label()}</Text>
      <TextInput
        value={link}
        onChangeText={setLink}
        editable={!busy}
        accessibilityLabel={m.mobile_share_invite_link_label()}
        placeholder={m.mobile_share_invite_placeholder()}
        placeholderTextColor={theme.tokens.text.muted}
        autoCapitalize="none"
        autoCorrect={false}
        spellCheck={false}
        keyboardType="url"
        textContentType="URL"
        style={styles.input}
      />
      {!ready ? <Text style={styles.hint}>{m.mobile_share_invite_loading()}</Text> : null}
      {vaultError || error ? <Text style={styles.error} accessibilityRole="alert" selectable>{vaultError ? m.servers_warning_vault_unread() : error}</Text> : null}
      {vaultError ? (
        <Pressable onPress={() => void reloadVault()} disabled={busy} accessibilityRole="button" accessibilityLabel={m.mobile_share_invite_retry()} style={styles.retry}>
          <Text style={styles.hint}>{m.mobile_share_invite_retry()}</Text>
        </Pressable>
      ) : null}
      <Pressable onPress={() => void accept()} disabled={disabled} accessibilityRole="button" accessibilityLabel={label}
        accessibilityState={{ disabled, busy }} style={[styles.button, disabled && styles.disabled]}>
        {busy ? <ActivityIndicator color={theme.tokens.text.inverse} /> : null}
        <Text style={styles.buttonText}>{busy ? m.mobile_share_invite_accepting() : label}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  inner: { gap: theme.base.space[3] },
  title: { color: theme.tokens.text.primary, fontSize: theme.base.text.lg, fontWeight: '600' },
  hint: { color: theme.tokens.text.secondary, fontSize: theme.base.text.sm, lineHeight: 20 },
  label: { color: theme.tokens.text.secondary, fontSize: theme.base.text.sm, fontWeight: '500' },
  input: { minHeight: 48, borderWidth: 1, borderColor: theme.tokens.border.default, borderRadius: theme.base.radius.md, backgroundColor: superficie(theme, 0.8), color: theme.tokens.text.primary, paddingHorizontal: theme.base.space[3], fontSize: theme.base.text.sm },
  error: { color: theme.tokens.status.error, fontSize: theme.base.text.sm, lineHeight: 20 },
  button: { minHeight: 48, flexDirection: 'row', gap: theme.base.space[2], alignItems: 'center', justifyContent: 'center', borderRadius: theme.base.radius.md, backgroundColor: theme.tokens.accent.base, paddingHorizontal: theme.base.space[4] },
  buttonText: { color: theme.tokens.text.inverse, fontSize: theme.base.text.base, fontWeight: '600' },
  disabled: { opacity: 0.5 },
  retry: { minHeight: 44, alignItems: 'center', justifyContent: 'center' },
}));
