import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Linking, Pressable, ScrollView, Share, Text, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import * as Clipboard from 'expo-clipboard';
import {
  createShare, fmtWhen, listShares, revokeAllShares, revokeShare, SharePrerequisiteError, ShareReachError,
  type Server, type ShareCreated, type ShareInfo,
} from '@hangar/core';
import { superficie } from '../../theme/superficie';
import * as m from '../../paraglide/messages';

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

export function SharePanel({ server, name }: { server: Server; name: string }) {
  const { theme } = useUnistyles();
  // A máquina e a sessão são as da abertura, nunca as que ficaram ativas depois.
  const [target] = useState(() => ({ server: { ...server }, name }));
  const [shares, setShares] = useState<ShareInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState('');
  const [created, setCreated] = useState<ShareCreated | null>(null);
  const [createError, setCreateError] = useState<unknown>(null);
  const [actionError, setActionError] = useState('');
  const [notice, setNotice] = useState('');
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState<'create' | 'revoke' | null>(null);
  const writeLock = useRef(false);
  const lifetime = useRef<AbortController | null>(null);
  const listSequence = useRef(0);

  const load = useCallback(async (controller: AbortController) => {
    const sequence = ++listSequence.current;
    setLoading(true);
    setListError('');
    try {
      const result = await listShares(target.name, target.server);
      if (!controller.signal.aborted && sequence === listSequence.current) setShares(result.shares);
    } catch (error) {
      if (!controller.signal.aborted && sequence === listSequence.current) setListError(errorText(error));
    } finally {
      if (!controller.signal.aborted && sequence === listSequence.current) setLoading(false);
    }
  }, [target]);

  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    void load(controller);
    return () => controller.abort();
  }, [load]);

  async function create() {
    const controller = lifetime.current;
    if (!controller || controller.signal.aborted || writeLock.current) return;
    writeLock.current = true;
    setBusy('create');
    setCreateError(null);
    setActionError('');
    setNotice('');
    setCopied(false);
    setCreated(null);
    try {
      const result = await createShare(target.name, false, target.server, controller.signal);
      if (!controller.signal.aborted) setCreated(result);
    } catch (error) {
      if (!controller.signal.aborted) setCreateError(error);
    } finally {
      if (!controller.signal.aborted) {
        await load(controller);
        if (!controller.signal.aborted) { writeLock.current = false; setBusy(null); }
      }
    }
  }

  async function revoke(id?: string) {
    const controller = lifetime.current;
    if (!controller || controller.signal.aborted || writeLock.current) return;
    writeLock.current = true;
    setBusy('revoke');
    setActionError('');
    setNotice('');
    try {
      const result = id === undefined
        ? await revokeAllShares(target.name, target.server)
        : await revokeShare(target.name, id, target.server);
      if (!result.ok) throw new Error(m.native_invalid_response());
      if (controller.signal.aborted) return;
      if (id === undefined || id === created?.id) { setCreated(null); setCopied(false); }
      setNotice(id === undefined ? m.mobile_share_revoked_all() : m.mobile_share_revoked());
    } catch (error) {
      if (!controller.signal.aborted) setActionError(m.mobile_share_revoke_error({ error: errorText(error) }));
    } finally {
      if (!controller.signal.aborted) {
        await load(controller);
        if (!controller.signal.aborted) { writeLock.current = false; setBusy(null); }
      }
    }
  }

  async function copy(text: string, isLink = false) {
    const controller = lifetime.current;
    setActionError('');
    try {
      await Clipboard.setStringAsync(text);
      if (!controller?.signal.aborted) {
        if (isLink) setCopied(true);
        else setNotice(m.compartilhar_copiado());
      }
    } catch (error) {
      if (!controller?.signal.aborted) setActionError(m.mobile_share_copy_error({ error: errorText(error) }));
    }
  }

  async function shareLink() {
    if (!created) return;
    const controller = lifetime.current;
    setActionError('');
    try {
      await Share.share({ message: m.compartilhar_whatsapp_texto({ link: created.link }) });
    } catch (error) {
      if (!controller?.signal.aborted) setActionError(m.mobile_share_send_error({ error: errorText(error) }));
    }
  }

  async function openTailscale(url: string) {
    const controller = lifetime.current;
    setActionError('');
    try {
      await Linking.openURL(url);
    } catch (error) {
      if (!controller?.signal.aborted) setActionError(m.mobile_share_open_error({ error: errorText(error) }));
    }
  }

  const text = (value: string, alert = false) => (
    <Text selectable style={[styles.text, { color: alert ? theme.tokens.status.error : theme.tokens.text.secondary }]}
      accessibilityRole={alert ? 'alert' : undefined}>{value}</Text>
  );
  const button = (label: string, onPress: () => void, primary = false, disabled = !!busy, accessibilityLabel = label) => (
    <Pressable onPress={onPress} disabled={disabled} accessibilityRole="button" accessibilityLabel={accessibilityLabel}
      style={[styles.button, primary && { backgroundColor: theme.tokens.accent.base }, disabled && { opacity: 0.5 }]}>
      <Text style={[styles.buttonText, { color: primary ? theme.tokens.text.inverse : theme.tokens.accent.base }]}>{label}</Text>
    </Pressable>
  );
  const prereqs = createError instanceof SharePrerequisiteError ? createError : null;

  return (
    <ScrollView contentContainerStyle={styles.inner} contentInsetAdjustmentBehavior="automatic" showsVerticalScrollIndicator={false}>
      <Text style={[styles.warning, { color: theme.tokens.status.warning, backgroundColor: superficie(theme, 0.4) }]}>
        {m.mobile_share_warning()}
      </Text>
      {busy ? (
        <View style={styles.waiting} accessibilityLiveRegion="polite">
          <ActivityIndicator color={theme.tokens.text.muted} />
          {text(busy === 'create' ? m.share_reach_checking() : m.mobile_share_revoking())}
        </View>
      ) : null}
      {createError !== null ? (
        <View style={styles.block}>
          {text(errorText(createError), true)}
          {createError instanceof ShareReachError ? (
            <>{text(m.mobile_share_stage({ stage: createError.stage }))}{createError.detail ? text(createError.detail) : null}</>
          ) : null}
          {prereqs ? (
            <>
              {prereqs.missing.map((missing, index) => (
                <Text key={`${missing}-${index}`} style={[styles.text, { color: theme.tokens.status.warning }]}>
                  {missing === 'operator' ? m.compartilhar_falta_operador() : missing === 'funnel' ? m.compartilhar_falta_funnel() : missing}
                </Text>
              ))}
              {prereqs.fix ? <>
                <Text selectable style={[styles.code, { color: theme.tokens.text.primary, backgroundColor: superficie(theme, 0.8) }]}>{prereqs.fix}</Text>
                {button(m.mobile_share_copy_fix(), () => void copy(prereqs.fix))}
              </> : null}
              {prereqs.enableUrl ? button(m.compartilhar_liberar_tailscale(), () => void openTailscale(prereqs.enableUrl!)) : null}
            </>
          ) : null}
        </View>
      ) : null}
      {created ? (
        <View style={styles.block}>
          <Text style={[styles.heading, { color: theme.tokens.text.primary }]}>{m.compartilhar_link_novo()}</Text>
          <Text selectable style={[styles.code, { color: theme.tokens.text.primary, backgroundColor: superficie(theme, 0.8) }]}>{created.link}</Text>
          {text(m.compartilhar_vale_ate({ quando: fmtWhen(created.expires_at) }))}
          <View style={styles.actions}>
            {button(copied ? m.compartilhar_copiado() : m.compartilhar_copiar(), () => void copy(created.link, true))}
            {button(m.mobile_share_send_link(), () => void shareLink(), true)}
          </View>
        </View>
      ) : button(busy === 'create' ? m.compartilhar_gerando() : m.compartilhar_gerar(), () => void create(), true)}
      {actionError ? text(actionError, true) : null}
      {notice ? <Text style={[styles.text, { color: theme.tokens.text.secondary }]} accessibilityLiveRegion="polite">{notice}</Text> : null}
      <Text style={[styles.heading, { color: theme.tokens.text.primary }]} accessibilityRole="header">{m.compartilhar_quem_entrou()}</Text>
      {button(m.mobile_share_refresh(), () => { if (lifetime.current) void load(lifetime.current); }, false, loading || !!busy)}
      {loading ? (
        <View style={styles.waiting}><ActivityIndicator color={theme.tokens.text.muted} />{text(m.compartilhar_carregando())}</View>
      ) : listError ? text(m.compartilhar_erro_lista({ erro: listError }), true) : shares.length === 0 ? text(m.compartilhar_vazio()) : (
        <View style={styles.block}>
          {shares.map((entry) => {
            const device = entry.pending ? m.compartilhar_link_aguardando() : entry.device || m.compartilhar_aparelho_sem_nome();
            return (
              <View key={entry.id} style={[styles.entry, { borderColor: theme.tokens.border.subtle }]}>
                <Text selectable style={[styles.heading, { color: theme.tokens.text.primary }]}>{device}</Text>
                {!entry.pending ? text(m.compartilhar_entrou({ quando: fmtWhen(entry.redeemed_at ?? entry.created_at) })) : null}
                {entry.pending ? text(m.compartilhar_pendente({ quando: fmtWhen(entry.expires_at) })) : null}
                {button(m.compartilhar_revogar(), () => void revoke(entry.id), false, !!busy, m.mobile_share_revoke_access({ device }))}
              </View>
            );
          })}
        </View>
      )}
      {shares.length || created ? button(m.compartilhar_encerrar_todos(), () => void revoke()) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create((theme) => ({
  inner: { padding: theme.base.space[4], gap: theme.base.space[3], paddingBottom: theme.base.space[6] },
  block: { gap: theme.base.space[2] },
  heading: { fontSize: theme.base.text.base, fontWeight: '600' },
  text: { fontSize: theme.base.text.sm, lineHeight: 20, flexShrink: 1 },
  warning: { fontSize: theme.base.text.sm, lineHeight: 20, padding: theme.base.space[3], borderRadius: theme.base.radius.md },
  code: { fontSize: theme.base.text.sm, fontFamily: theme.base.fontMono, padding: theme.base.space[3], borderRadius: theme.base.radius.md },
  entry: { gap: theme.base.space[1], padding: theme.base.space[3], borderWidth: 1, borderRadius: theme.base.radius.md },
  waiting: { flexDirection: 'row', alignItems: 'center', gap: theme.base.space[2] },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.base.space[2] },
  button: { minHeight: 44, alignItems: 'center', justifyContent: 'center', borderRadius: theme.base.radius.full, paddingHorizontal: theme.base.space[4] },
  buttonText: { fontSize: theme.base.text.base, fontWeight: '600' },
}));
