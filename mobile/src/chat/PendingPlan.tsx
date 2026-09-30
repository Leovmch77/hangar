import { useMemo } from 'react';
import { Text, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { EnrichedMarkdownText } from 'react-native-enriched-markdown';
import { planDisplayText } from '@hangar/core';
import type { StateEvent } from '@hangar/core';
import * as m from '../paraglide/messages';
import { mkMarkdownStyle } from './AssistantBubble';
import { superficie } from '../theme/superficie';

type Props = NonNullable<StateEvent['claude_plan_pending']>;

export function PendingPlan({ plan, path }: Props) {
  const { theme } = useUnistyles();
  const markdownStyle = useMemo(() => mkMarkdownStyle(theme), [theme]);
  const display = useMemo(() => planDisplayText(plan).trim(), [plan]);

  return (
    <View style={styles.wrap}>
      <Text style={styles.title} accessibilityRole="header">{m.native_plan_pending_title()}</Text>
      {path ? <Text style={styles.path} selectable>{path}</Text> : null}
      {display ? (
        <EnrichedMarkdownText markdown={display} markdownStyle={markdownStyle} flavor="github" />
      ) : (
        <Text style={styles.empty}>{m.pending_plan_empty()}</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  wrap: {
    backgroundColor: superficie(theme, 0.8),
    borderRadius: theme.base.radius.lg,
    padding: theme.base.space[3],
    gap: theme.base.space[2],
  },
  title: {
    color: theme.tokens.text.primary,
    fontSize: theme.base.text.base,
    fontWeight: '600',
  },
  path: {
    color: theme.tokens.text.secondary,
    fontFamily: theme.base.fontMono,
    fontSize: theme.base.text.sm,
  },
  empty: {
    color: theme.tokens.text.secondary,
    fontSize: theme.base.text.base,
  },
}));
