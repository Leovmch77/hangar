import { useMemo, useState } from 'react';
import { Pressable, ScrollView, Text, View, useWindowDimensions } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { EnrichedMarkdownText } from 'react-native-enriched-markdown';
import { planDisplayText } from '@hangar/core';
import type { StateEvent } from '@hangar/core';
import * as m from '../paraglide/messages';
import { mkMarkdownStyle } from './AssistantBubble';
import { OptionButtons } from './OptionButtons';
import { superficie } from '../theme/superficie';
import { Icon } from '../ui/Icon';
import { useAparencia } from '../stores/aparencia';

type Plan = NonNullable<StateEvent['claude_plan_pending']>;
interface Props extends Plan {
  /** Escolhas do diálogo da TUI. Ausentes = o cartão só mostra o plano. */
  options?: string[];
  interactionId?: string | null;
  question?: string;
  onSelect?: (n: number, interactionId: string | null | undefined, text?: string) => void | Promise<void>;
  onCancel?: () => void | Promise<void>;
}

// Mesmo desenho do cartão de revisão do nativo (plan_review.rs): cabeça, plano e rodapé com a decisão.
export function PendingPlan({ plan, path, options, interactionId, question, onSelect, onCancel }: Props) {
  const { theme } = useUnistyles();
  const { height } = useWindowDimensions();
  const destaque = useAparencia((s) => s.destaquePergunta);
  const [expanded, setExpanded] = useState(false);
  const markdownStyle = useMemo(() => mkMarkdownStyle(theme), [theme]);
  const display = useMemo(() => planDisplayText(plan).trim(), [plan]);
  const choices = !!(options?.length && onSelect && onCancel);
  const border = destaque === 'amber' ? theme.tokens.status.warning : theme.tokens.accent.base;

  return (
    <View style={[styles.wrap, { borderColor: border }]}>
      <View style={[styles.head, { borderColor: theme.tokens.border.default }]}>
        <View style={styles.headText}>
          <Text style={styles.title} accessibilityRole="header">{m.native_plan_review_title()}</Text>
          <Text style={styles.muted}>{m.native_plan_review_hint()}</Text>
        </View>
        {display ? (
          <Pressable
            onPress={() => setExpanded((v) => !v)}
            accessibilityRole="button"
            accessibilityState={{ expanded }}
            style={[styles.expand, { borderColor: theme.tokens.border.default }]}
          >
            <Icon name={expanded ? 'Minimize2' : 'Maximize2'} size={14} color={theme.tokens.text.secondary} />
            <Text style={styles.expandTxt}>{expanded ? m.native_plan_review_back() : m.native_plan_review_expand()}</Text>
          </Pressable>
        ) : null}
      </View>
      {display ? (
        <ScrollView nestedScrollEnabled style={expanded ? null : { maxHeight: Math.min(440, Math.max(100, height * 0.42)) }}
                    contentContainerStyle={styles.body}>
          <EnrichedMarkdownText markdown={display} markdownStyle={markdownStyle} flavor="github" />
        </ScrollView>
      ) : (
        <Text style={[styles.muted, styles.body]}>{m.pending_plan_empty()}</Text>
      )}
      {choices || path ? (
        <View style={[styles.footer, { borderColor: theme.tokens.border.default }]}>
          {choices ? <Text style={styles.muted}>{m.native_plan_review_decision()}</Text> : null}
          {path ? <Text style={styles.path} selectable numberOfLines={1}>{path}</Text> : null}
          {choices ? (
            <OptionButtons embedded planReview question={question ?? ''} options={options!} interactionId={interactionId}
                           onSelect={onSelect!} onCancel={onCancel!} />
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  wrap: {
    backgroundColor: superficie(theme, 0.8),
    borderRadius: 14,
    borderWidth: 1,
    overflow: 'hidden',
  },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.base.space[3],
    padding: theme.base.space[3],
    borderBottomWidth: 1,
  },
  headText: {
    flex: 1,
    gap: theme.base.space[1],
  },
  title: {
    color: theme.tokens.text.primary,
    fontSize: theme.base.text.base,
    fontWeight: '600',
  },
  muted: {
    color: theme.tokens.text.secondary,
    fontSize: theme.base.text.sm,
  },
  expand: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.base.space[1],
    paddingHorizontal: theme.base.space[3],
    borderWidth: 1,
    borderRadius: theme.base.radius.lg,
  },
  expandTxt: {
    color: theme.tokens.text.secondary,
    fontSize: theme.base.text.sm,
  },
  body: {
    padding: theme.base.space[3],
  },
  footer: {
    padding: theme.base.space[3],
    gap: theme.base.space[2],
    borderTopWidth: 1,
  },
  path: {
    color: theme.tokens.text.secondary,
    fontFamily: theme.base.fontMono,
    fontSize: theme.base.text.xs,
  },
}));
