import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, Share, Text, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import * as Clipboard from 'expo-clipboard';
import { createPairInvite, type PairLevel, type Server } from '@hangar/core';
import { Sheet } from '../../ui/Sheet';
import { Icon } from '../../ui/Icon';
import { toast } from '../../ui/Toast';
import { superficie } from '../../theme/superficie';
import * as m from '../../paraglide/messages';

export interface PairTarget { server: Server; name: string; members: string[] }

const mensagemDe = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Escolha do nível, a mesma no convite e no aceite: acesso completo lista o que fica aberto. */
export function LevelChoice({ level, onChange, opens }: { level: PairLevel; onChange: (l: PairLevel) => void; opens: string[] }) {
  const { theme } = useUnistyles();
  const opcao = (l: PairLevel, title: string, hint: string) => {
    const on = level === l;
    return (
      <Pressable
        key={l}
        onPress={() => onChange(l)}
        style={[styles.opcao, { borderColor: on ? theme.tokens.accent.base : theme.tokens.border.subtle, backgroundColor: superficie(theme, on ? 0.8 : 0.4) }]}
        accessibilityRole="radio"
        accessibilityLabel={title}
        accessibilityState={{ checked: on }}
      >
        <Icon name={on ? 'CircleCheck' : 'Circle'} size={18} color={on ? theme.tokens.accent.base : theme.tokens.text.muted} />
        <View style={styles.opcaoTxt}>
          <Text style={[styles.opcaoTitulo, { color: theme.tokens.text.primary }]}>{title}</Text>
          <Text style={[styles.dica, { color: theme.tokens.text.secondary }]}>{hint}</Text>
        </View>
      </Pressable>
    );
  };
  return (
    <View style={styles.niveis} accessibilityRole="radiogroup">
      {opcao('view', m.pair_level_view(), m.pair_level_view_hint())}
      {opcao('full', m.pair_level_full(), m.pair_level_full_hint())}
      {level === 'full' ? (
        <Text style={[styles.dica, { color: theme.tokens.status.warning }]}>{m.pair_opens_sessions({ sessoes: opens.join(', ') })}</Text>
      ) : null}
    </View>
  );
}

// Convite de par a partir de uma sessão própria: o nível escolhido vale para o grupo inteiro.
// A criação espera o link abrir pela internet (até minutos); falhou, o motivo fica e dá para repetir.
export function PairInviteSheet({ target, onClose }: { target: PairTarget | null; onClose: () => void }) {
  const { theme } = useUnistyles();
  const [level, setLevel] = useState<PairLevel>('view');
  const [busy, setBusy] = useState(false);
  const [erro, setErro] = useState('');
  const [link, setLink] = useState('');
  const abort = useRef<AbortController | null>(null);

  useEffect(() => {
    setLevel('view');
    setBusy(false);
    setErro('');
    setLink('');
    return () => abort.current?.abort();
  }, [target]);

  const criar = async () => {
    if (!target || busy) return;
    abort.current?.abort();
    const ctrl = new AbortController();
    abort.current = ctrl;
    setBusy(true);
    setErro('');
    try {
      const r = await createPairInvite(target.name, level, target.server, ctrl.signal);
      if (!ctrl.signal.aborted) setLink(r.link);
    } catch (e) {
      if (!ctrl.signal.aborted) setErro(mensagemDe(e));
    } finally {
      if (!ctrl.signal.aborted) setBusy(false);
    }
  };

  const copiar = () => {
    Clipboard.setStringAsync(link).then(() => toast.ok(m.toast_copiado()), (e: unknown) => toast.erro(mensagemDe(e)));
  };
  const compartilhar = () => {
    Share.share({ message: m.native_par_whatsapp({ link }) }).catch((e: unknown) => toast.erro(mensagemDe(e)));
  };

  const botao = (label: string, onPress: () => void, primario = false, disabled = false) => (
    <Pressable onPress={onPress} disabled={disabled} accessibilityRole="button" accessibilityLabel={label}
      style={[styles.botao, primario && { backgroundColor: theme.tokens.accent.base }, disabled && { opacity: 0.5 }]}>
      <Text style={[styles.botaoTxt, { color: primario ? theme.tokens.text.inverse : theme.tokens.accent.base }]}>{label}</Text>
    </Pressable>
  );

  return (
    <Sheet open={!!target} sizes={['auto', 'large']} onDismiss={onClose} scrollable>
      <View style={styles.inner}>
        <Text style={[styles.titulo, { color: theme.tokens.text.primary }]} accessibilityRole="header">
          {m.native_par_titulo_sessao({ sessao: target?.name ?? '' })}
        </Text>
        {link ? (
          <>
            <Text style={[styles.dica, { color: theme.tokens.text.secondary }]}>{level === 'full' ? m.pair_level_full() : m.pair_level_view()}</Text>
            <Text selectable style={[styles.link, { color: theme.tokens.text.primary, backgroundColor: superficie(theme, 0.8) }]}>{link}</Text>
            <View style={styles.botoes}>
              {botao(m.acesso_copiar(), copiar)}
              {botao(m.pair_share_link(), compartilhar, true)}
            </View>
            <Text style={[styles.dica, { color: theme.tokens.text.muted }]}>{m.pair_not_transitive()}</Text>
            {botao(m.sessao_fechar(), onClose)}
          </>
        ) : (
          <>
            <Text style={[styles.secao, { color: theme.tokens.text.secondary }]}>{m.pair_level_title()}</Text>
            <LevelChoice level={level} onChange={setLevel} opens={target ? [target.name, ...target.members] : []} />
            {busy ? (
              <View style={styles.esperando}>
                <ActivityIndicator color={theme.tokens.text.muted} />
                <Text style={[styles.dica, { color: theme.tokens.text.secondary }]}>{m.share_reach_checking()}</Text>
              </View>
            ) : erro ? (
              <>
                <Text style={[styles.dica, { color: theme.tokens.status.error }]} accessibilityRole="alert" selectable>{erro}</Text>
                {botao(m.share_reach_retry(), () => void criar(), true)}
              </>
            ) : (
              botao(m.native_par_convidar(), () => void criar(), true)
            )}
          </>
        )}
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create((theme) => ({
  inner: { padding: theme.base.space[4], gap: theme.base.space[3] },
  titulo: { fontSize: theme.base.text.lg, fontWeight: theme.base.weight.semibold },
  secao: { fontSize: theme.base.text.sm, fontWeight: theme.base.weight.semibold },
  niveis: { gap: theme.base.space[2] },
  opcao: { flexDirection: 'row', alignItems: 'flex-start', gap: theme.base.space[2], padding: theme.base.space[3], borderRadius: theme.base.radius.md, borderWidth: 1, minHeight: 44 },
  opcaoTxt: { flex: 1, gap: theme.base.space[0.5] },
  opcaoTitulo: { fontSize: theme.base.text.base, fontWeight: theme.base.weight.semibold },
  dica: { fontSize: theme.base.text.sm, lineHeight: 20 },
  link: { fontSize: theme.base.text.sm, fontFamily: theme.base.fontMono, padding: theme.base.space[3], borderRadius: theme.base.radius.md },
  esperando: { flexDirection: 'row', alignItems: 'center', gap: theme.base.space[2] },
  botoes: { flexDirection: 'row', gap: theme.base.space[2] },
  botao: { flex: 1, minHeight: 44, alignItems: 'center', justifyContent: 'center', borderRadius: theme.base.radius.full, paddingHorizontal: theme.base.space[4] },
  botaoTxt: { fontSize: theme.base.text.base, fontWeight: theme.base.weight.semibold },
}));
