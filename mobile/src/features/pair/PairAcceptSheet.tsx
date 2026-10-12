import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, Text, TextInput, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { acceptPair, parsePairLink, type AggSession, type PairAccepted, type PairLevel, type Server } from '@hangar/core';
import { Sheet } from '../../ui/Sheet';
import { Icon } from '../../ui/Icon';
import { superficie } from '../../theme/superficie';
import { LevelChoice } from './PairInviteSheet';
import * as m from '../../paraglide/messages';

export interface PairAcceptTarget { server: Server; name: string | null; sessions: AggSession[] }

const mensagemDe = (e: unknown) => (e instanceof Error ? e.message : String(e));

// Colar o link /par/ que a outra pessoa mandou. Sem sessão escolhida (Máquinas), pergunta qual;
// o nível é o que quem convidou terá aqui, e a resposta diz o que esta pessoa recebeu lá.
export function PairAcceptSheet({ target, onClose }: { target: PairAcceptTarget | null; onClose: () => void }) {
  const { theme } = useUnistyles();
  const [link, setLink] = useState('');
  const [escolhida, setEscolhida] = useState<string | null>(null);
  const [level, setLevel] = useState<PairLevel>('view');
  const [busy, setBusy] = useState(false);
  const [erro, setErro] = useState('');
  const [feito, setFeito] = useState<PairAccepted | null>(null);
  const vivo = useRef(true);

  useEffect(() => {
    vivo.current = true;
    setLink('');
    setEscolhida(target?.name ?? null);
    setLevel('view');
    setBusy(false);
    setErro('');
    setFeito(null);
    return () => { vivo.current = false; };
    // A lista de sessões muda a cada atualização: só abrir (ou trocar de sessão/máquina) zera o formulário.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!target, target?.server.id, target?.name]);

  const vivas = (target?.sessions ?? []).filter((s) => s.state !== 'dead' && !s.outside);
  const sessao = escolhida ? vivas.find((s) => s.name === escolhida) ?? null : null;
  const valido = parsePairLink(link) !== null;
  const torto = link.trim() !== '' && !valido;
  const pode = !!target && !!escolhida && valido && !busy;

  const aceitar = async () => {
    if (!pode || !target || !escolhida) return;
    setBusy(true);
    setErro('');
    try {
      const r = await acceptPair(escolhida, link, level, target.server);
      if (vivo.current) setFeito(r);
    } catch (e) {
      if (vivo.current) setErro(mensagemDe(e));
    } finally {
      if (vivo.current) setBusy(false);
    }
  };

  const texto = (t: string, cor = theme.tokens.text.secondary, alerta = false) => (
    <Text style={[styles.dica, { color: cor }]} accessibilityRole={alerta ? 'alert' : undefined} selectable={alerta}>{t}</Text>
  );

  let corpo;
  if (feito) {
    corpo = (
      <>
        {texto(m.native_par_aceito({ dono: feito.owner, sessao: feito.session }), theme.tokens.text.primary)}
        {texto(feito.level === 'full' ? m.pair_level_received_full({ dono: feito.owner }) : m.pair_level_received_view({ dono: feito.owner }))}
        {texto(m.pair_not_transitive(), theme.tokens.text.muted)}
        <Pressable onPress={onClose} style={styles.botao} accessibilityRole="button" accessibilityLabel={m.sessao_fechar()}>
          <Text style={[styles.botaoTxt, { color: theme.tokens.accent.base }]}>{m.sessao_fechar()}</Text>
        </Pressable>
      </>
    );
  } else {
    corpo = (
      <>
        {texto(m.native_par_aceitar_ajuda())}
        <TextInput
          value={link}
          onChangeText={setLink}
          placeholder={m.native_par_placeholder()}
          placeholderTextColor={theme.tokens.text.muted}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          accessibilityLabel={m.native_par_campo_aria()}
          style={[styles.campo, { color: theme.tokens.text.primary, backgroundColor: superficie(theme, 0.8), borderColor: theme.tokens.border.subtle }]}
        />
        {torto ? texto(m.erro_par_link_invalido(), theme.tokens.status.error, true) : null}
        {target?.name ? null : (
          <>
            <Text style={[styles.secao, { color: theme.tokens.text.secondary }]}>{m.native_par_qual_sessao()}</Text>
            {vivas.length === 0 ? texto(m.native_par_sem_sessao(), theme.tokens.text.muted) : (
              <View style={styles.lista} accessibilityRole="radiogroup">
                {vivas.map((s) => {
                  const on = s.name === escolhida;
                  return (
                    <Pressable key={s.name} onPress={() => setEscolhida(s.name)} style={styles.item}
                      accessibilityRole="radio" accessibilityLabel={s.name} accessibilityState={{ checked: on }}>
                      <Icon name={on ? 'CircleCheck' : 'Circle'} size={18} color={on ? theme.tokens.accent.base : theme.tokens.text.muted} />
                      <Text style={[styles.nome, { color: theme.tokens.text.primary }]} numberOfLines={1}>{s.name}</Text>
                    </Pressable>
                  );
                })}
              </View>
            )}
          </>
        )}
        <Text style={[styles.secao, { color: theme.tokens.text.secondary }]}>{m.pair_level_title()}</Text>
        <LevelChoice level={level} onChange={setLevel} opens={escolhida ? [escolhida, ...(sessao?.pair_peers ?? []).filter((p) => !p.includes('::'))] : []} />
        {erro ? texto(erro, theme.tokens.status.error, true) : null}
        <Pressable onPress={() => void aceitar()} disabled={!pode} accessibilityRole="button" accessibilityLabel={m.native_par_aceitar()}
          style={[styles.botao, { backgroundColor: theme.tokens.accent.base }, !pode && { opacity: 0.5 }]}>
          {busy ? <ActivityIndicator color={theme.tokens.text.inverse} /> : null}
          <Text style={[styles.botaoTxt, { color: theme.tokens.text.inverse }]}>{busy ? m.native_par_aceitando() : m.native_par_aceitar()}</Text>
        </Pressable>
      </>
    );
  }

  return (
    <Sheet open={!!target} sizes={['auto', 'large']} onDismiss={onClose} scrollable>
      <View style={styles.inner}>
        <Text style={[styles.titulo, { color: theme.tokens.text.primary }]} accessibilityRole="header">
          {target?.name ? m.native_par_titulo_sessao({ sessao: target.name }) : m.native_par_titulo()}
        </Text>
        {corpo}
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create((theme) => ({
  inner: { padding: theme.base.space[4], gap: theme.base.space[3] },
  titulo: { fontSize: theme.base.text.lg, fontWeight: '600' },
  secao: { fontSize: theme.base.text.sm, fontWeight: '600' },
  dica: { fontSize: theme.base.text.sm, lineHeight: 20 },
  campo: { minHeight: 44, borderWidth: 1, borderRadius: theme.base.radius.md, paddingHorizontal: theme.base.space[3], fontSize: theme.base.text.base },
  lista: { gap: 2 },
  item: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 44, paddingHorizontal: theme.base.space[2] },
  nome: { flex: 1, fontSize: theme.base.text.base },
  botao: { flexDirection: 'row', gap: 8, minHeight: 44, alignItems: 'center', justifyContent: 'center', borderRadius: theme.base.radius.full, paddingHorizontal: theme.base.space[4] },
  botaoTxt: { fontSize: theme.base.text.base, fontWeight: '600' },
}));
