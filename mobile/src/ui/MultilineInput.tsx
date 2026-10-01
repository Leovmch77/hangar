import { forwardRef, useState } from 'react';
import { TextInput, type TextInputProps } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

// Campo multilinha do app: cresce até `maxHeight` e daí rola. Fundo é do contêiner (o composer
// carrega o vidro), por isso o input não pinta nada.
export const MultilineInput = forwardRef<TextInput, TextInputProps & { maxHeight?: number; mono?: boolean }>(
  function MultilineInput({ maxHeight = 120, mono, style, onContentSizeChange, ...rest }, ref) {
    const { theme } = useUnistyles();
    // Texto posto por código (ditado, rascunho) não faz o iOS crescer o campo sozinho: a linha de
    // baixo ficava cortada. A altura passa a seguir o conteúdo medido.
    const [contentH, setContentH] = useState(0);
    return (
      <TextInput
        ref={ref}
        multiline
        scrollEnabled
        placeholderTextColor={theme.tokens.text.muted}
        onContentSizeChange={(e) => {
          setContentH(e.nativeEvent.contentSize.height);
          onContentSizeChange?.(e);
        }}
        style={[
          styles.input,
          { maxHeight, color: theme.tokens.text.primary },
          contentH > 0 && { height: Math.min(maxHeight, contentH + 16) },
          mono && { fontFamily: theme.base.fontMono },
          style,
        ]}
        {...rest}
      />
    );
  },
);

const styles = StyleSheet.create((theme) => ({
  input: { fontSize: theme.base.text.base, paddingVertical: 8, paddingHorizontal: 10, textAlignVertical: 'top' },
}));
