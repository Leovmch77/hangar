import { useEffect, useRef, useState } from 'react';
import { Alert, Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { sairConta, apagarConta, accountDeletedNotice, credentialAuth, type Credencial, type Server } from '@hangar/core';
import { Pill } from '../config/PageHeader';
import { ClaudeAccountLogin } from './ClaudeAccountLogin';
import * as m from '../../paraglide/messages';

export type ClaudeAccountActionsProps = {
  server: Server;
  credential: Credencial;
  onChanged: () => void | Promise<void>;
};

export function ClaudeAccountActions({ server, credential, onChanged }: ClaudeAccountActionsProps) {
  const key = JSON.stringify([server.id, server.baseUrl, server.token, credential.id]);
  const identity = useRef(key); identity.current = key;
  const generation = useRef(0);
  const locked = useRef(false);
  const changed = useRef(onChanged); changed.current = onChanged;
  const [busy, setBusy] = useState(false);
  const [login, setLogin] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    ++generation.current; locked.current = false;
    setBusy(false); setLogin(false); setError('');
    return () => { ++generation.current; };
  }, [key]);

  const folder = credential.id.startsWith('claude:') ? credential.id.slice(7).replace(/[\\/]+$/, '').split(/[\\/]/).at(-1) : undefined;
  const expired = credential.cota?.estado === 'expirada'
    || (credential.login?.refreshExpiresAt != null && credential.login.refreshExpiresAt <= Date.now() / 1000);
  const connected = credential.login?.loggedIn === true && !expired;
  const removable = credential.gerenciada !== false && !credential.ativa && !credential.usos?.length && !!folder && /^\.claude-[a-z0-9][a-z0-9_-]{0,31}$/.test(folder);

  function confirm(remove: boolean) {
    if (locked.current) return;
    const target = { ...server }, account = { ...credential }, name = folder, epoch = generation.current;
    const active = () => identity.current === key && generation.current === epoch;
    let accepted = false;
    locked.current = true; setBusy(true); setError('');
    const release = () => { if (active()) { locked.current = false; setBusy(false); } };
    async function execute(keep = true) {
      if (accepted || !active()) return;
      accepted = true;
      try {
        if (remove) {
          if (!name) return;
          const result = await apagarConta(target, name.slice('.claude-'.length), keep);
          if (result.ok !== true) throw new Error(m.erro_desconhecido());
          if (!active()) return;
          Alert.alert(accountDeletedNotice(account.nome, keep, result));
        } else await sairConta(target, account.nome_natural);
        if (active()) await changed.current();
      } catch (e) {
        if (active()) setError(e instanceof Error ? e.message : remove ? m.erro_desconhecido() : m.contas_sair_erro());
      } finally { release(); }
    }
    const cancel = { text: m.comum_cancelar(), style: 'cancel' as const, onPress: release };
    if (remove) Alert.alert(m.contas_apagar_pergunta({ nome: account.nome }), m.contas_apagar_opcoes_desc(), [
      cancel,
      { text: m.contas_apagar_com_conversas(), style: 'destructive', onPress: () => void execute(false) },
      { text: m.contas_apagar_juntando(), isPreferred: true, onPress: () => void execute(true) },
    ], { cancelable: true, onDismiss: () => { if (!accepted) release(); } });
    else Alert.alert(m.contas_sair(), m.contas_sair_pergunta({ nome: account.nome }), [
      cancel, { text: m.contas_sair(), style: 'destructive', onPress: () => void execute() },
    ], { cancelable: true, onDismiss: () => { if (!accepted) release(); } });
  }

  if (credential.tipo !== 'claude' || credentialAuth(credential) !== 'oauth' || credential.gerenciada === false) return null;
  return <View style={styles.root}>
    <View style={styles.actions}>
      {connected ? <Pill label={m.contas_sair()} disabled={busy} onPress={() => confirm(false)} />
        : <Pill label={expired ? m.contas_renovar_login() : m.contas_entrar()} disabled={busy} onPress={() => setLogin(true)} />}
      {removable ? <Pill label={m.comum_apagar()} disabled={busy} onPress={() => confirm(true)} /> : null}
    </View>
    {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
    {login ? <ClaudeAccountLogin server={server} label={credential.nome_natural} onComplete={onChanged} onClose={() => setLogin(false)} /> : null}
  </View>;
}
const styles = StyleSheet.create(theme => ({
  root: { gap: theme.base.space[2] },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.base.space[2] },
  error: { color: theme.tokens.status.error },
}));
