import { useEffect, useRef, useState } from 'react';
import { Linking, Pressable, Text, TextInput, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { kindOf, isPermission, questionParts, planChoiceKey, type PlanChoiceKey } from '@hangar/core';
import * as m from '../paraglide/messages';
import { superficie } from '../theme/superficie';
import { Icon } from '../ui/Icon';
import { semEmoji } from '../ui/semEmoji';
import { useAparencia } from '../stores/aparencia';

interface Props {
  question: string;
  options: string[];
  interactionId?: string | null;
  /** `text` só no "o que mudar" do plano. */
  onSelect: (n: number, interactionId: string | null | undefined, text?: string) => void | Promise<void>;
  onCancel: () => void | Promise<void>;
  /** Envia as opções marcadas (só múltipla escolha). Ausente = sem botão de enviar. */
  onSubmit?: (interactionId: string | null | undefined) => void | Promise<void>;
  /** Diálogo de aprovação do plano: rótulos curtos (como o nativo) e "o que mudar" abre um campo. */
  planReview?: boolean;
  /** Dentro de outro cartão (o do plano): sem moldura própria e sem repetir a pergunta. */
  embedded?: boolean;
}

const PLAN_LABEL: Record<PlanChoiceKey, () => string> = {
  bypass: () => m.native_plan_review_bypass(), auto_mode: () => m.native_plan_review_auto_mode(),
  manual: () => m.native_plan_review_manual(), auto: () => m.native_plan_review_auto(),
  changes: () => m.native_plan_review_changes(), keep: () => m.native_plan_review_keep(),
};

// MÚLTIPLA ESCOLHA: o TUI desenha a caixinha antes do rótulo ("[ ] Alfa", "[✔] Alfa"), e só por ela
// dá pra saber. Marcar e enviar são ações diferentes: o toque alterna, quem envia é o botão.
const CAIXA = /^\[(.?)\]\s*/;
const marcada = (o: string) => /^\[[^\s\]]\]/.test(o);

export function OptionButtons(props: Props) {
  return <OptionButtonsContent key={props.interactionId} {...props} />;
}

function OptionButtonsContent({ question, options, interactionId, onSelect, onCancel, onSubmit, planReview = false, embedded = false }: Props) {
  const { theme } = useUnistyles();
  const permission = !planReview && isPermission(options);
  const planKeys = options.map((o) => (planReview ? planChoiceKey(o) : null));
  // O texto fica até o cartão sair (ele remonta por interactionId): envio recusado não o perde.
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [feedback, setFeedback] = useState('');
  const kinds = options.map((o) => kindOf(o));
  const multipla = options.some((o) => CAIXA.test(o));
  const marcadas = options.filter(marcada).length;
  const locked = useRef(false);
  const mounted = useRef(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // Aparência › Destaque das perguntas: a moldura do pedido que espera a pessoa.
  const destaque = useAparencia((s) => s.destaquePergunta);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  async function run(action: () => void | Promise<void>) {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setError('');
    try { await action(); }
    catch (e) {
      if (mounted.current) setError(e instanceof Error ? e.message : m.comum_falha_envio_opcao());
    } finally {
      locked.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  return (
    <View style={embedded ? styles.embedded : [styles.wrap, { borderColor: destaque === 'amber' ? theme.tokens.status.warning : theme.tokens.accent.base }]}>
      {permission ? (
        <View style={[styles.permChip, { backgroundColor: theme.tokens.accent.dim }]}>
          <Icon name="ShieldAlert" size={13} color={theme.tokens.accent.base} />
          <Text style={[styles.permTxt, { color: theme.tokens.accent.base }]}>{semEmoji(m.permissao_pedido())}</Text>
        </View>
      ) : null}
      {embedded ? null : <Text style={[styles.question, { color: theme.tokens.text.primary }]}>
        {questionParts(question).map((part, i) =>
          part.kind === 'code' ? (
            <Text key={i} style={[styles.qCode, { backgroundColor: superficie(theme, 0.8), color: theme.tokens.text.primary }]}>
              {part.text}
            </Text>
          ) : part.kind === 'link' ? (
            <Text
              key={i}
              accessibilityRole="link"
              style={{ color: theme.tokens.accent.base, textDecorationLine: 'underline' }}
              onPress={() => void Linking.openURL(part.text).catch((e: unknown) => setError(e instanceof Error ? e.message : m.comum_falha_envio_opcao()))}
            >
              {part.text}
            </Text>
          ) : (
            part.text
          ),
        )}
      </Text>}
      <View style={styles.list}>
        {options.map((opt, i) => {
          const kind = kinds[i];
          const isAllow = permission && kind === 'allow';
          const isAlways = permission && kind === 'always';
          const isDeny = permission && kind === 'deny';
          const planKey = planKeys[i];
          const changes = planKey === 'changes';
          const sendFeedback = () => void run(() => onSelect(i + 1, interactionId, feedback.trim()));
          return (
            <View key={i} style={styles.list}>
            <Pressable
              onPress={() => (changes ? setFeedbackOpen((v) => !v) : void run(() => onSelect(i + 1, interactionId)))}
              disabled={busy}
              accessibilityLabel={planKey ? `${i + 1}. ${opt}` : undefined}
              accessibilityState={{ disabled: busy, busy, checked: multipla ? marcada(opt) : undefined, expanded: changes ? feedbackOpen : undefined }}
              style={[
                styles.btn,
                { backgroundColor: superficie(theme, 0.8), borderColor: theme.tokens.border.default },
                isAllow && { backgroundColor: theme.tokens.accent.base, borderColor: theme.tokens.accent.base },
                isAlways && { backgroundColor: theme.tokens.accent.dim, borderColor: theme.tokens.accent.base },
                isDeny && { borderColor: theme.tokens.status.error },
              ]}
              accessibilityRole="button"
            >
              <Text
                style={[
                  styles.num,
                  { color: theme.tokens.text.secondary },
                  isAllow && { color: '#fff' },
                  isAlways && { color: theme.tokens.accent.base },
                  isDeny && { color: theme.tokens.status.error },
                ]}
              >
                {i + 1}.
              </Text>
              {multipla ? (
                <View
                  style={[styles.caixa, { borderColor: theme.tokens.border.default }, marcada(opt) && { backgroundColor: theme.tokens.accent.base, borderColor: theme.tokens.accent.base }]}
                  accessibilityElementsHidden
                  importantForAccessibility="no-hide-descendants"
                >
                  {marcada(opt) ? <Icon name="Check" size={12} color="#fff" /> : null}
                </View>
              ) : null}
              <Text
                style={[
                  styles.optTxt,
                  { color: theme.tokens.text.primary },
                  isAllow && { color: '#fff' },
                  isAlways && { color: theme.tokens.accent.base },
                  isDeny && { color: theme.tokens.status.error },
                ]}
              >
                {multipla ? opt.replace(CAIXA, '') : planKey ? PLAN_LABEL[planKey]() : opt}
              </Text>
            </Pressable>
            {changes && feedbackOpen ? (
              <View style={styles.feedback}>
                <TextInput
                  value={feedback}
                  onChangeText={setFeedback}
                  multiline
                  autoFocus
                  editable={!busy}
                  placeholder={m.native_plan_review_changes_placeholder()}
                  placeholderTextColor={theme.tokens.text.secondary}
                  accessibilityLabel={m.native_plan_review_changes_placeholder()}
                  style={[styles.feedbackInput, { color: theme.tokens.text.primary, backgroundColor: superficie(theme, 0.8), borderColor: theme.tokens.border.default }]}
                />
                <Pressable
                  onPress={sendFeedback}
                  disabled={busy || !feedback.trim()}
                  accessibilityRole="button"
                  accessibilityState={{ disabled: busy || !feedback.trim(), busy }}
                  style={[styles.btn, styles.feedbackSend, { backgroundColor: theme.tokens.accent.base, borderColor: theme.tokens.accent.base }, (busy || !feedback.trim()) && styles.off]}
                >
                  <Text style={[styles.sendTxt, { color: '#fff' }]}>{m.native_send()}</Text>
                </Pressable>
              </View>
            ) : null}
            </View>
          );
        })}
        {multipla && onSubmit ? (
          <Pressable
            onPress={() => void run(() => onSubmit(interactionId))}
            disabled={busy || marcadas === 0}
            accessibilityState={{ disabled: busy || marcadas === 0, busy }}
            style={[styles.btn, { backgroundColor: theme.tokens.accent.base, borderColor: theme.tokens.accent.base }, marcadas === 0 && styles.off]}
            accessibilityRole="button"
          >
            <Icon name="Send" size={14} color="#fff" />
            <Text style={[styles.optTxt, { color: '#fff' }]}>{m.opcoes_enviar_marcadas({ n: marcadas })}</Text>
          </Pressable>
        ) : null}
        <Pressable
          onPress={() => void run(onCancel)}
          disabled={busy}
          accessibilityState={{ disabled: busy, busy }}
          style={[styles.btn, styles.btnCancel, { borderColor: theme.tokens.status.error }]}
          accessibilityRole="button"
        >
          <Text style={[styles.num, { color: theme.tokens.status.error }]}>✕</Text>
          <Text style={[styles.optTxt, { color: theme.tokens.status.error }]}>{m.comum_cancelar()}</Text>
        </Pressable>
      </View>
      {error ? <Text accessibilityRole="alert" style={{ color: theme.tokens.status.error }}>{error}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  wrap: {
    padding: theme.base.space[3],
    gap: theme.base.space[3],
    borderWidth: 1,
    borderRadius: 14,
  },
  embedded: {
    gap: theme.base.space[2],
  },
  permChip: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    borderRadius: theme.base.radius.full,
    paddingHorizontal: theme.base.space[2],
    paddingVertical: 4,
  },
  permTxt: {
    fontSize: theme.base.text.xs,
    fontWeight: '600',
  },
  question: {
    fontSize: theme.base.text.base,
    fontWeight: '500',
    lineHeight: 22,
  },
  qCode: {
    fontFamily: theme.base.fontMono,
    fontSize: 14,
    paddingHorizontal: 4,
    borderRadius: 4,
  },
  list: {
    gap: theme.base.space[2],
  },
  btn: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.base.space[3],
    paddingHorizontal: theme.base.space[3],
    borderWidth: 1,
    borderRadius: theme.base.radius.lg,
  },
  btnCancel: {
    borderColor: theme.tokens.status.error,
  },
  num: {
    fontFamily: theme.base.fontMono,
    fontSize: theme.base.text.sm,
    minWidth: 20,
  },
  optTxt: {
    fontSize: theme.base.text.base,
    flex: 1,
  },
  caixa: {
    width: 18,
    height: 18,
    borderRadius: 4,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  off: {
    opacity: 0.45,
  },
  feedback: {
    gap: theme.base.space[2],
  },
  feedbackInput: {
    minHeight: 72,
    borderWidth: 1,
    borderRadius: theme.base.radius.lg,
    padding: theme.base.space[3],
    fontSize: theme.base.text.base,
    textAlignVertical: 'top',
  },
  feedbackSend: {
    alignSelf: 'flex-end',
    justifyContent: 'center',
  },
  sendTxt: {
    fontSize: theme.base.text.base,
    fontWeight: '600',
  },
}));
