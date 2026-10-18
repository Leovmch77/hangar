import { useEffect, useRef, useState } from 'react';
import { Pressable, Switch, Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { basename, deleteWorktreeBatchForServer, fmtBytes, worktreeReady, type Server, type WorktreeBatchProgress,
         type WorktreeStatus } from '@hangar/core';
import { Sheet } from '../../ui/Sheet';
import * as m from '../../paraglide/messages';
import { dropWorktreeStatus } from './worktreeStatus';
import { sizeSumLabel } from './worktreeUi';

export type WorktreeBatch = { repo: string; deletable: WorktreeStatus[]; blocked: WorktreeStatus[] };
type Props = { server: Server | null; batch: WorktreeBatch | null; onClose: () => void; onDeleted: () => void };

/** Confirmação do lote de mescladas: as prontas entram sempre; as com alteração não commitada só se a pessoa marcar. */
export function WorktreeBatchSheet({ server, batch: aberto, onClose, onDeleted }: Props) {
  const [apagando, setApagando] = useState(false);
  const [erro, setErro] = useState('');
  const [marcadas, setMarcadas] = useState<Set<string>>(new Set());
  // O progresso guarda de qual lote é: ao reabrir com outro, a confirmação nova aparece já no primeiro quadro.
  const [execucao, setExecucao] = useState<{ batch: WorktreeBatch; p: WorktreeBatchProgress } | null>(null);
  // Lote novo invalida o que ainda roda do anterior: o antigo termina no servidor, mas não escreve aqui.
  const corrida = useRef(0);
  // O último lote continua desenhado enquanto a folha anima a saída.
  const [batch, setBatch] = useState(aberto);
  useEffect(() => {
    if (aberto) { corrida.current++; setBatch(aberto); setErro(''); setMarcadas(new Set()); setApagando(false); }
  }, [aberto]);
  const progresso = execucao && execucao.batch === (aberto ?? batch) ? execucao.p : null;

  const prontas = batch?.deletable.filter(worktreeReady) ?? [];
  const comArquivos = batch?.deletable.filter((w) => !worktreeReady(w)) ?? [];
  const escolhidas = [...prontas, ...comArquivos.filter((w) => marcadas.has(w.path))];
  const n = escolhidas.length;
  const libera = escolhidas.reduce((a, w) => a + (w.size ?? 0), 0);

  const alternar = (path: string) => setMarcadas((s) => {
    const novo = new Set(s);
    if (!novo.delete(path)) novo.add(path);
    return novo;
  });

  async function apagar() {
    if (!server || !batch || apagando || !n) return;
    const minha = ++corrida.current;
    const vale = () => minha === corrida.current;
    const lote = batch;
    setApagando(true); setErro('');
    const tiradas = new Set<string>();
    try {
      // O core marca como "perde arquivos" só as que esta tela mostrou perdendo.
      await deleteWorktreeBatchForServer(server, lote.repo, escolhidas, (p) => {
        p.removed.forEach((w) => { if (!tiradas.has(w.path)) { tiradas.add(w.path); dropWorktreeStatus(server.id, w.path); } });
        if (vale()) setExecucao({ batch: lote, p });
      });
    } catch (e) {
      if (vale()) setErro(e instanceof Error ? e.message : String(e));
    } finally {
      if (vale()) setApagando(false);
      onDeleted();   // mesmo com erro, algumas podem ter saído: a lista recarrega
    }
  }

  const perdas = (w: WorktreeStatus) => (
    <>
      {w.dirty ? <Text style={styles.arquivo}>{m.worktree_nao_commitados({ n: w.dirty })}</Text> : null}
      {w.ignored.map((f) => <Text key={f} style={styles.arquivo}>{f}</Text>)}
    </>
  );

  if (progresso) {
    const pct = progresso.total ? (progresso.done / progresso.total) * 100 : 100;
    return (
      <Sheet open={!!aberto} sizes={['auto']} onDismiss={onClose} dismissible={!apagando}>
        <View style={styles.inner}>
          <Text style={styles.title}>{apagando ? m.worktree_lote_apagando_titulo() : m.worktree_lote_fim_titulo()}</Text>
          <View accessible accessibilityRole="progressbar" accessibilityValue={{ min: 0, max: progresso.total, now: progresso.done }}
            style={styles.trilho}>
            <View style={[styles.preenchido, { width: `${pct}%` }]} />
          </View>
          <Text accessibilityLiveRegion="polite" style={styles.text}>
            {m.worktree_lote_progresso({ feitas: progresso.removed.length, total: progresso.total, tamanho: sizeSumLabel(progresso.removed) })}
          </Text>
          {apagando && progresso.current ? (
            <Text style={styles.muted}>{m.worktree_lote_apagando({ nome: basename(progresso.current.path) })}</Text>
          ) : null}
          {progresso.failed.length ? (
            <View accessibilityRole="alert" style={styles.item}>
              <Text style={styles.erro}>{m.worktree_lote_falhas({ n: progresso.failed.length })}</Text>
              {progresso.failed.map(({ worktree: w, error }) => (
                <Text key={w.path} style={styles.erro}>
                  {error == null ? m.worktree_lote_mudou({ nome: basename(w.path) })
                    : m.worktree_lote_erro_item({ nome: basename(w.path), motivo: error })}
                </Text>
              ))}
            </View>
          ) : null}
          {erro ? <Text accessibilityRole="alert" style={styles.erro}>{erro}</Text> : null}
          {!apagando ? (
            <View style={styles.acoes}>
              <Pressable onPress={onClose} accessibilityRole="button" style={styles.cancelar}>
                <Text style={styles.text}>{m.worktree_lote_fechar()}</Text>
              </Pressable>
            </View>
          ) : null}
        </View>
      </Sheet>
    );
  }

  return (
    <Sheet open={!!aberto} sizes={['auto']} onDismiss={onClose} dismissible={!apagando}>
      <View style={styles.inner}>
        <Text style={styles.title}>{m.worktree_lote_titulo({ n })}</Text>
        {libera ? <Text style={styles.ok}>{m.worktree_libera({ tamanho: fmtBytes(libera) })}</Text> : null}
        {prontas.map((w) => (
          <View key={w.path} style={styles.item}>
            <Text style={styles.nome}>{basename(w.path)}</Text>
            {w.ignored.length ? (
              <>
                <Text style={styles.aviso}>{m.worktree_apagar_perde()}</Text>
                {perdas(w)}
              </>
            ) : <Text style={styles.muted}>{m.worktree_lote_nada_perde()}</Text>}
          </View>
        ))}
        {comArquivos.length ? (
          <>
            <Text style={styles.aviso}>{m.worktree_lote_com_arquivos()}</Text>
            {comArquivos.map((w) => (
              <View key={w.path} style={styles.marcavel}>
                <View style={[styles.item, styles.flex]}>
                  <Text style={styles.nome}>{basename(w.path)}</Text>
                  <Text style={styles.aviso}>{m.worktree_apagar_perde()}</Text>
                  {perdas(w)}
                </View>
                <Switch value={marcadas.has(w.path)} onValueChange={() => alternar(w.path)} disabled={apagando}
                  accessibilityLabel={basename(w.path)} style={styles.switch} />
              </View>
            ))}
          </>
        ) : null}
        {batch?.blocked.length ? (
          <>
            <Text style={styles.aviso}>{m.worktree_lote_ficam()}</Text>
            {batch.blocked.map((w) => (
              <View key={w.path} style={styles.item}>
                <Text style={styles.nome}>{basename(w.path)}</Text>
                <Text style={styles.muted}>
                  {w.sessions.length ? m.worktree_sessao_aberta({ nomes: w.sessions.join(', ') }) : m.worktree_lote_leitura_falhou()}
                </Text>
              </View>
            ))}
          </>
        ) : null}
        {erro ? <Text accessibilityRole="alert" style={styles.erro}>{erro}</Text> : null}
        <View style={styles.acoes}>
          <Pressable onPress={onClose} disabled={apagando} accessibilityRole="button"
            accessibilityState={{ disabled: apagando }} style={styles.cancelar}>
            <Text style={styles.text}>{m.comum_cancelar()}</Text>
          </Pressable>
          <Pressable onPress={apagar} disabled={apagando || !n} accessibilityRole="button" accessibilityLabel={m.worktree_lote_apagar_n({ n })}
            accessibilityState={{ busy: apagando, disabled: apagando || !n }} style={[styles.botao, !n && styles.desligado]}>
            <Text style={styles.botaoTexto}>{m.worktree_lote_apagar_n({ n })}</Text>
          </Pressable>
        </View>
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create((theme) => ({
  inner: { padding: theme.base.space[4], gap: theme.base.space[2] },
  title: { fontSize: theme.base.text.lg, fontWeight: theme.base.weight.semibold, color: theme.tokens.text.primary },
  flex: { flex: 1, minWidth: 0 },
  item: { gap: theme.base.space[0.5] },
  marcavel: { flexDirection: 'row', alignItems: 'center', gap: theme.base.space[2], minHeight: 44 },
  switch: { minHeight: 44 },
  nome: { fontWeight: theme.base.weight.semibold, color: theme.tokens.text.primary },
  text: { color: theme.tokens.text.primary },
  muted: { color: theme.tokens.text.secondary },
  aviso: { color: theme.tokens.status.warning },
  ok: { color: theme.tokens.status.success },
  arquivo: { color: theme.tokens.text.secondary, fontFamily: theme.base.fontMono, fontSize: theme.base.text.sm, paddingLeft: theme.base.space[3] },
  erro: { color: theme.tokens.status.error },
  trilho: { height: 8, borderRadius: theme.base.radius.full, overflow: 'hidden', backgroundColor: theme.tokens.border.default },
  preenchido: { height: '100%', backgroundColor: theme.tokens.accent.base },
  acoes: { flexDirection: 'row', justifyContent: 'flex-end', gap: theme.base.space[2], marginTop: theme.base.space[2] },
  cancelar: { minHeight: 44, paddingHorizontal: theme.base.space[4], justifyContent: 'center', borderRadius: theme.base.radius.md,
              borderWidth: 1, borderColor: theme.tokens.border.default },
  botao: { minHeight: 44, paddingHorizontal: theme.base.space[4], justifyContent: 'center',
           borderRadius: theme.base.radius.md, backgroundColor: theme.tokens.status.error },
  desligado: { opacity: 0.4 },
  botaoTexto: { color: theme.ink.onAccent, fontWeight: theme.base.weight.semibold },
}));
