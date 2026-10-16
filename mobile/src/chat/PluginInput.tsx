import { useLayoutEffect, useMemo, useEffect, useRef, useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { FieldSync, fieldSender, pluginFailureText, type PluginElement, type PluginInputKind } from '@hangar/core';
import * as m from '../paraglide/messages';

interface Props {
  frame: PluginElement;
  onInput?: (kind: PluginInputKind, value: string) => Promise<unknown>;
}
const str = (value: unknown) => typeof value === 'string' ? value : '';

export function PluginInput({ frame, onInput }: Props) {
  const p = frame.props ?? {};
  const [value, setValue] = useState(() => str(p.value));
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const submitFlight = useRef(false);
  const writable = !!onInput;
  const wasWritable = useRef(writable);
  const heldDraft = useRef(false);
  const shown = useRef(value);
  const focused = useRef(false);
  const active = useRef(true);
  const callback = useRef(onInput);
  callback.current = onInput;
  const sync = useRef<FieldSync>(null);
  if (!sync.current) sync.current = new FieldSync(str(p.value));
  const send = useMemo(() => fieldSender(async (kind, text) => {
    try {
      if (!active.current) return;
      if (!callback.current) throw new Error(m.plugin_input_desativado());
      await callback.current(kind, text);
    } finally {
      if (kind === 'submit') {
        submitFlight.current = false;
        if (active.current) setSubmitting(false);
      }
    }
  }, err => {
    if (active.current) setError(callback.current ? pluginFailureText(err, m.plugin_input_falhou) : m.plugin_input_desativado());
  }), []);
  useEffect(() => {
    active.current = true;
    return () => { active.current = false; };
  }, []);
  const put = (next: string | null) => {
    if (next !== null) { shown.current = next; setValue(next); }
  };
  useLayoutEffect(() => {
    if (wasWritable.current && !writable) {
      heldDraft.current = true;
      setError(m.plugin_input_desativado());
    } else if (!wasWritable.current && writable) {
      setError('');
    }
    wasWritable.current = writable;
  }, [writable]);
  useLayoutEffect(() => {
    if (!heldDraft.current) put(sync.current!.draw(str(frame.props?.value), shown.current, focused.current));
  }, [frame]);
  const submit = () => {
    if (!callback.current || submitFlight.current) return;
    submitFlight.current = true;
    setSubmitting(true);
    setError('');
    heldDraft.current = false;
    sync.current!.submitted();
    send('submit', shown.current);
  };
  return <View style={styles.wrap}>
    {str(p.label) ? <Text style={styles.label}>{str(p.label)}</Text> : null}
    <TextInput value={value} editable={!!onInput} placeholder={str(p.placeholder)} accessibilityLabel={str(p.label) || str(p.placeholder)}
      style={styles.input} maxLength={16384}
      onFocus={() => { focused.current = true; }}
      onBlur={() => { focused.current = false; if (!heldDraft.current) put(sync.current!.draw(null, shown.current, false)); }}
      onChangeText={text => {
        if (!callback.current) return;
        heldDraft.current = false;
        shown.current = text;
        setValue(text);
        setError('');
        sync.current!.typed(text);
        send('change', text);
      }} onSubmitEditing={submit} />
    {onInput ? <Pressable accessibilityRole="button" accessibilityLabel={str(p.submitLabel) || m.plugin_input_enviar()}
      style={styles.send} disabled={submitting} accessibilityState={{ disabled: submitting, busy: submitting }} onPressIn={() => sync.current!.leftToSend()} onPress={submit}>
      <Text style={styles.sendText}>{str(p.submitLabel) || m.plugin_input_enviar()}</Text>
    </Pressable> : <Text style={styles.hint}>{m.erro_mod_sem_digitacao()}</Text>}
    {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
  </View>;
}

const styles = StyleSheet.create(theme => ({
  wrap: { flexGrow: 1, flexShrink: 1, minWidth: 0, gap: theme.base.space[1] },
  label: { color: theme.tokens.text.secondary, fontSize: theme.base.text.xs },
  input: { minHeight: 44, padding: theme.base.space[2], color: theme.tokens.text.primary, borderColor: theme.tokens.border.default, borderWidth: 1, borderRadius: theme.base.radius.sm },
  send: { alignSelf: 'flex-end', minHeight: 44, justifyContent: 'center', paddingHorizontal: theme.base.space[2] },
  sendText: { color: theme.tokens.accent.base, fontSize: theme.base.text.sm },
  hint: { color: theme.tokens.text.muted, fontSize: theme.base.text.xs },
  error: { color: theme.tokens.status.error, fontSize: theme.base.text.xs },
}));
