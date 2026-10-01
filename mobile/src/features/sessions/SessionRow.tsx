import { useMemo, useRef, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import ReanimatedSwipeable, { type SwipeableMethods } from 'react-native-gesture-handler/ReanimatedSwipeable';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import * as Haptics from 'expo-haptics';
import { cwdParts, isOrq, loopBadge, planBadge, providerName, relativeTime, rotuloEstado, untrackedReason, type AggSession, type State } from '@hangar/core';
import { Chip, type Tone } from '../../ui/Chip';
import { HangarMark } from '../../ui/HangarMark';
import { Icon } from '../../ui/Icon';
import { PlanBar } from '../plan/PlanBar';
import { SessionMenu } from './SessionMenu';
import { superficie } from '../../theme/superficie';
import * as m from '../../paraglide/messages';

// LOOP_TONE_COLOR do core é CSS var (`var(--accent)`) — não serve em RN; o tom vira `Chip tone`.
const TOM_DO_LOOP: Record<'ok' | 'warn' | 'attention' | 'muted', Tone> = {
  ok: 'success',
  warn: 'warning',
  attention: 'error',
  muted: 'neutral',
};

// A marca é a única pista visual de estado na linha: lê a cor da pílula do tema, que acompanha
// tema claro/escuro e o acento escolhido na Aparência.
const PILL_DO_ESTADO: Record<State, 'working' | 'idle' | 'input' | 'dead'> = {
  working: 'working',
  idle: 'idle',
  awaiting_input: 'input',
  dead: 'dead',
};

interface Props {
  session: AggSession;
  mostrarServidor: boolean; // false quando a lista já está agrupada por servidor
  onPress: () => void;
  onGit: () => void;
  onExcluir: () => void;
  onRenomear: () => void;
  onResume: () => void;
  // a lista fecha a linha aberta anterior quando esta abre (uma aberta por vez)
  aoAbrir?: (metodos: SwipeableMethods | null) => void;
}

export function SessionRow({ session: s, mostrarServidor, onPress, onGit, onExcluir, onRenomear, onResume, aoAbrir }: Props) {
  const { theme } = useUnistyles();
  const swipe = useRef<SwipeableMethods>(null);
  const [menuAberto, setMenuAberto] = useState(false);
  // O orquestrador não se renomeia nem se fecha: o backend recusa, então a linha nem oferece.
  const orq = isOrq(s);
  // Toque longo pelo gesture-handler, não pelo `Pressable`: assim ele convive com o arrasto do
  // swipe (o mesmo reconhecedor decide quem ganha) em vez de disputar o toque com ele.
  const toqueLongo = useMemo(
    () =>
      Gesture.LongPress()
        .minDuration(500)
        .runOnJS(true)
        .enabled(!orq)
        .onStart(() => {
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
          setMenuAberto(true);
        }),
    [orq],
  );
  // Renomear/Git/Loop/Excluir só existiam no toque longo e no arrasto — dois gestos que o leitor
  // de tela não alcança. Aqui elas viram ações do rotor/menu de acessibilidade da própria linha.
  const acoesA11y = useMemo(
    () => [
      ...(orq ? [] : [{ name: 'rename', label: m.sessao_renomear() }]),
      ...(s.cwd ? [{ name: 'git', label: 'Git' }] : []),
      ...(orq ? [] : [{ name: 'delete', label: m.sessao_excluir_curto() }]),
    ],
    [s.cwd, orq],
  );
  const untracked = s.tracked === false;
  const cwd = cwdParts(s.cwd);
  const loop = loopBadge(s.loop_status, s.loop_iter, s.loop_max);
  const plan = planBadge(s);
  const pendingQuestions = s.pending_questions ?? 0;
  const sub = s.question ?? (s.state === 'working' ? s.label : null) ?? null;
  const peers = s.pair_peers ?? [];
  // o rótulo do grupo (ex.: o ticket) diz mais que o nome do par; sem ele, o par ou o tamanho
  const pairLabel = peers.length ? (s.pair_task ?? (peers.length === 1 ? peers[0] : String(peers.length + 1))) : null;
  const corEstado = theme.tokens.pill[PILL_DO_ESTADO[s.state]].fg;
  const muted = theme.tokens.text.muted;

  const acoes = () => (
    <View style={styles.acoes}>
      {s.cwd ? (
        <Pressable onPress={onGit} style={[styles.acao, { backgroundColor: superficie(theme, 0.8) }]} accessibilityRole="button" accessibilityLabel="Git">
          <Icon name="GitBranch" size={18} color={theme.tokens.text.secondary} />
        </Pressable>
      ) : null}
      {orq ? null : (
        <Pressable onPress={onExcluir} style={[styles.acao, { backgroundColor: superficie(theme, 0.8) }]} accessibilityRole="button" accessibilityLabel={m.sessao_excluir_curto()}>
          <Icon name="Trash2" size={18} color={theme.tokens.status.error} />
        </Pressable>
      )}
    </View>
  );

  return (
    <ReanimatedSwipeable
      ref={swipe}
      renderRightActions={orq && !s.cwd ? undefined : acoes}
      rightThreshold={40}
      overshootRight={false}
      onSwipeableWillOpen={() => aoAbrir?.(swipe.current)}
      simultaneousWithExternalGesture={toqueLongo}
    >
      <SessionMenu
        aberto={menuAberto}
        onFechar={() => setMenuAberto(false)}
        temCwd={!!s.cwd}
        onRenomear={onRenomear}
        onGit={onGit}
        onExcluir={onExcluir}
      >
      <GestureDetector gesture={toqueLongo}>
        <Pressable
          onPress={onPress}
          // sem onLongPress: o toque longo é do `toqueLongo` acima, que abre a folha de ações
          // kimi sem id é estado NORMAL pré-1º prompt, e codex sem thread ainda está no startup:
          // a tela da conversa espera o vínculo sem herdar transcript de outra sessão
          disabled={untracked && s.provider !== 'kimi' && s.provider !== 'codex'}
          style={({ pressed }) => [styles.row, pressed && { backgroundColor: superficie(theme, 0.8) }]}
          accessibilityRole="button"
          // rótulo composto: um label explícito no pai faz o RN descartar o texto dos filhos, e o
          // estado e a pergunta sumiriam do leitor de tela.
          // Máquina e projeto entram mesmo quando a tela os esconde (lista agrupada, pasta = nome):
          // é o que distingue duas conversas de mesmo nome no leitor de tela.
          accessibilityLabel={`${s.name}, ${rotuloEstado(s.state)}${pendingQuestions > 0 ? `, ${m.ask_perguntas()}: ${pendingQuestions}` : ''}${sub ? `, ${sub}` : ''}, ${providerName(s.provider)}, ${s.serverLabel}${s.cwd ? `, ${cwd.base}` : ''}${s.branch ? `, ${s.branch}` : ''}`}
          accessibilityActions={acoesA11y}
          onAccessibilityAction={({ nativeEvent }) => {
            if (nativeEvent.actionName === 'rename') onRenomear();
            else if (nativeEvent.actionName === 'git') onGit();
            else if (nativeEvent.actionName === 'delete') onExcluir();
          }}
        >
          <View style={styles.lead}><HangarMark size={18} color={corEstado} /></View>
          <View style={styles.col}>
            <View style={styles.linha}>
              <Text style={[styles.nome, { color: theme.tokens.text.primary }]} numberOfLines={1}>{s.name}</Text>
              {pairLabel ? (
                <View style={[styles.tag, { borderColor: theme.tokens.border.default }]}>
                  <Icon name="Users" size={11} color={muted} />
                  <Text style={[styles.tagTxt, { color: theme.tokens.text.secondary }]} numberOfLines={1}>{pairLabel}</Text>
                </View>
              ) : null}
              {pendingQuestions > 0 ? <Chip tone="warning">{`? ${pendingQuestions}`}</Chip> : null}
              {orq ? <Chip>{m.orq_row_badge()}</Chip> : null}
              {untracked ? <Chip tone="warning">{m.sessao_sem_id()}</Chip> : null}
              <Text style={[styles.tempo, { color: muted }]} numberOfLines={1}>{relativeTime(s.last_activity)}</Text>
            </View>
            {/* O que a sessão está fazendo: a pergunta (cor de input), a atividade (itálico) ou o estado. */}
            <Text
              style={[
                styles.sub,
                s.question
                  ? { color: theme.tokens.pill.input.fg }
                  : sub
                    ? { color: theme.tokens.text.secondary, fontStyle: 'italic' }
                    : { color: muted },
              ]}
              numberOfLines={1}
            >
              {sub ?? rotuloEstado(s.state)}
            </Text>
            {/* Uma linha só, sem quebrar: pasta e ramo encolhem juntos, o diff nunca. */}
            <View style={styles.meta}>
              {orq ? null : <Text style={[styles.metaTxt, styles.provedor, { color: theme.tokens.text.secondary }]} numberOfLines={1}>{providerName(s.provider)}</Text>}
              {mostrarServidor ? <Text style={[styles.metaTxt, styles.encolhe, { color: s.serverColor }]} numberOfLines={1}>{s.serverLabel}</Text> : null}
              {s.cwd ? (
                // Ícone no lugar do prefixo: ele truncava justo a última pasta, que é o que
                // identifica o projeto. O caminho inteiro segue no menu da linha.
                <View style={styles.par}>
                  <Icon name="Folder" size={11} color={muted} />
                  <Text style={[styles.metaTxt, styles.encolhe, { color: muted }]} numberOfLines={1}>{cwd.base}</Text>
                </View>
              ) : null}
              {s.worktree ? <Icon name="FolderGit2" size={11} color={muted} /> : null}
              {s.branch ? (
                <View style={styles.par}>
                  <Icon name="GitBranch" size={11} color={muted} />
                  <Text style={[styles.metaTxt, styles.mono, styles.encolhe, { color: muted }]} numberOfLines={1}>{s.branch}</Text>
                </View>
              ) : null}
              {s.git_added || s.git_removed ? (
                <Text style={[styles.metaTxt, styles.mono, styles.fixo]}>
                  {s.git_added ? <Text style={{ color: theme.tokens.status.success }}>+{s.git_added}</Text> : null}
                  {s.git_removed ? <Text style={{ color: theme.tokens.status.error }}> −{s.git_removed}</Text> : null}
                </Text>
              ) : null}
            </View>
            {s.limited || loop || plan || s.engine ? (
              <View style={styles.chips}>
                {s.limited ? <Chip tone="warning" icon="Hourglass">{s.limit_reset ?? ''}</Chip> : null}
                {loop ? <Chip tone={TOM_DO_LOOP[loop.tone]}>{loop.label}</Chip> : null}
                {plan ? <Chip tone={plan.complete ? 'success' : 'neutral'} icon={plan.complete ? 'CircleCheck' : 'ClipboardList'}>{plan.text}</Chip> : null}
                {s.engine ? <Chip icon="Cog">{s.engine}</Chip> : null}
              </View>
            ) : null}
            {/* não `compact`: ali a barra é absoluta no rodapé da coluna e atravessa o chip do plano */}
            {plan ? <PlanBar session={s} /> : null}
            {untracked && s.provider !== 'kimi' && s.provider !== 'pi' && s.provider !== 'omp' ? (
              <Pressable onPress={onResume} style={styles.resume} accessibilityRole="button" accessibilityLabel={m.sessao_retomar()}>
                <Icon name="RotateCw" size={12} color={theme.tokens.text.secondary} />
                <Text style={[styles.metaTxt, { color: theme.tokens.text.primary }]}>{m.sessao_retomar()}</Text>
              </Pressable>
            ) : untracked ? (
              <Text style={[styles.metaTxt, { color: muted }]}>{untrackedReason(s.provider)}</Text>
            ) : null}
          </View>
        </Pressable>
      </GestureDetector>
      </SessionMenu>
    </ReanimatedSwipeable>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, paddingVertical: 9, paddingHorizontal: 10, borderRadius: theme.base.radius.md },
  // a marca alinha com a linha do nome, não com o centro do bloco de 3 linhas
  lead: { width: 22, alignItems: 'center', paddingTop: 1 },
  col: { flex: 1, gap: 2, minWidth: 0 },
  linha: { flexDirection: 'row', alignItems: 'center', gap: 6, minWidth: 0 },
  nome: { fontSize: theme.base.text.base, fontWeight: '600', flexShrink: 1 },
  tag: { flexDirection: 'row', alignItems: 'center', gap: 4, flexShrink: 1, minWidth: 0, maxWidth: '45%', paddingHorizontal: 6, paddingVertical: 1, borderRadius: theme.base.radius.full, borderWidth: 1 },
  tagTxt: { fontSize: theme.base.text.xxs, flexShrink: 1 },
  tempo: { marginLeft: 'auto', flexShrink: 0, fontSize: theme.base.text.xxs },
  sub: { fontSize: theme.base.text.xs },
  meta: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 1, overflow: 'hidden' },
  metaTxt: { fontSize: theme.base.text.xxs },
  provedor: { fontWeight: '600', flexShrink: 0 },
  mono: { fontFamily: theme.base.fontMono },
  encolhe: { flexShrink: 1, minWidth: 0 },
  fixo: { flexShrink: 0 },
  par: { flexDirection: 'row', alignItems: 'center', gap: 3, flexShrink: 1, minWidth: 0 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginTop: 3 },
  resume: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 3, alignSelf: 'flex-start' },
  acoes: { flexDirection: 'row' },
  acao: { width: 64, justifyContent: 'center', alignItems: 'center' },
}));
