import { useEffect, useRef, useState } from 'react';
import { Text, TextInput, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { criarConta, credentialAuth, type Credencial, type Server } from '@hangar/core';
import { Sheet } from '../../ui/Sheet';
import { Pill } from '../config/PageHeader';
import { SectionCard } from '../config/SectionCard';
import { SettingsRow } from '../config/SettingsRow';
import { ClaudeAccountLogin } from './ClaudeAccountLogin';
import * as m from '../../paraglide/messages';

export type ClaudeAccountCreateProps = {
  server: Server;
  credentials: Credencial[];
  onChanged: () => void | Promise<void>;
  onClose: () => void;
};

export function ClaudeAccountCreate({ server, credentials, onChanged, onClose }: ClaudeAccountCreateProps) {
  const key = JSON.stringify([server.id, server.baseUrl, server.token]);
  const identity = useRef(key); identity.current = key;
  const generation = useRef(0);
  const attempted = useRef(false);
  const creating = useRef(false);
  const [name, setName] = useState('');
  const [label, setLabel] = useState<string | null>(null);
  const loginLabel = useRef(label); loginLabel.current = label;
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    ++generation.current; attempted.current = false; creating.current = false;
    setName(''); setLabel(null); setBusy(false); setUncertain(false); setError('');
    return () => { ++generation.current; };
  }, [key]);

  const base = credentials.find(c => c.tipo === 'claude' && credentialAuth(c) === 'oauth' && c.login?.loggedIn === false
    && c.id.startsWith('claude:') && c.id.slice(7).replace(/[\\/]+$/, '').split(/[\\/]/).at(-1) === '.claude');
  async function create() {
    if (attempted.current) return;
    const trimmed = name.trim();
    if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(trimmed)) { setError(m.erro_conta_nome_invalido()); return; }
    const target = { ...server }, epoch = generation.current;
    const active = () => identity.current === key && generation.current === epoch;
    attempted.current = true; creating.current = true; setBusy(true); setError('');
    try {
      const created = await criarConta(target, trimmed);
      if (active()) { loginLabel.current = created.label; setLabel(created.label); }
    } catch (e) {
      if (active()) { setUncertain(true); setError(e instanceof Error ? e.message : m.erro_desconhecido()); }
    } finally { if (active()) { creating.current = false; setBusy(false); } }
  }
  const close = () => { if (!creating.current && !loginLabel.current) onClose(); };

  if (label) return <ClaudeAccountLogin server={server} label={label} onComplete={onChanged} onClose={onClose} />;
  return <Sheet open dismissible={!busy} onDismiss={close}>
    <View style={styles.root}>
      <Text accessibilityRole="header" style={styles.title}>{m.novacred_claude_nome()}</Text>
      <Text style={styles.text}>{m.contas_login_servidor({ nome: server.label })}</Text>
      {base ? <SectionCard><SettingsRow title={m.novacred_base_deslogada({ nome: base.nome })}>
        <Pill label={m.novacred_entrar_base({ nome: base.nome })} disabled={busy || uncertain} onPress={() => {
          if (attempted.current) return;
          loginLabel.current = base.nome_natural; setLabel(base.nome_natural);
        }} />
      </SettingsRow></SectionCard> : null}
      <SectionCard><SettingsRow title={m.novacred_nome_conta()}>
        <TextInput accessibilityLabel={m.criar_conta_nova_aria()} placeholder={m.criar_conta_placeholder()} value={name}
          onChangeText={setName} autoCapitalize="none" autoCorrect={false} editable={!busy && !uncertain} style={styles.input} />
      </SettingsRow></SectionCard>
      {busy ? <Text style={styles.text} accessibilityLiveRegion="polite">{m.contas_login_preparando()}</Text> : null}
      {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
      <View style={styles.actions}>
        <Pill label={m.comum_cancelar()} disabled={busy} onPress={close} />
        <Pill label={m.comum_criar()} disabled={busy || uncertain} onPress={() => void create()} />
      </View>
    </View>
  </Sheet>;
}
const styles = StyleSheet.create(theme => ({
  root: { padding: theme.base.space[4], gap: theme.base.space[3] },
  title: { color: theme.tokens.text.primary, fontSize: theme.base.text.lg, fontWeight: '600' },
  text: { color: theme.tokens.text.primary },
  error: { color: theme.tokens.status.error },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.base.space[2] },
  input: { minHeight: 44, color: theme.tokens.text.primary, borderColor: theme.tokens.border.default,
    borderWidth: 1, borderRadius: theme.base.radius.md, paddingHorizontal: theme.base.space[3] },
}));
