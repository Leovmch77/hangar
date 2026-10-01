import { Children, Fragment, isValidElement, type ReactNode } from 'react';
import { Pressable, Text, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Icon, type IconName } from '../../ui/Icon';
import { superficie } from '../../theme/superficie';

type Props = {
  titulo: string;
  descricao?: string;
  icon?: IconName;
  onPress?: () => void;
  onLongPress?: () => void;
  /** Controle da linha (segmentado, slider, paleta). Sem ele e com `onPress`, a linha ganha chevron. */
  children?: ReactNode;
  /** Peça à direita do título, na mesma linha (ponto de estado, valor, botão pequeno). */
  direita?: ReactNode;
};

// O Pressable envolve só o bloco ícone+título, nunca a linha inteira: um Pressable com rótulo
// próprio funde tudo que está dentro dele num nó só de acessibilidade, e o botão de `direita`
// (Testar conexão) ou de `children` (Remover) some pro leitor de tela.
export function Linha({ titulo, descricao, icon, onPress, onLongPress, children, direita }: Props) {
  const { theme } = useUnistyles();
  const conteudo = (
    <>
      {icon ? <Icon name={icon} size={20} color={theme.tokens.accent.base} /> : null}
      <View style={styles.textos}>
        <Text style={styles.titulo}>{titulo}</Text>
        {descricao ? <Text style={styles.descricao}>{descricao}</Text> : null}
      </View>
      {/* Chevron só na linha que é PURA navegação: com controle ou botão próprio ele encostaria
          na peça da direita, no meio da linha, e a seta viraria enfeite ambíguo. */}
      {onPress && !children && !direita ? <Icon name="ChevronRight" size={18} /> : null}
    </>
  );
  return (
    <View style={styles.linha}>
      <View style={styles.cabeca}>
        {onPress || onLongPress ? (
          <Pressable
            onPress={onPress}
            onLongPress={onLongPress}
            accessibilityRole="button"
            accessibilityLabel={titulo}
            style={({ pressed }) => [styles.alvo, pressed && styles.tocada]}
          >
            {conteudo}
          </Pressable>
        ) : (
          <View style={styles.alvo}>{conteudo}</View>
        )}
        {direita}
      </View>
      {children}
    </View>
  );
}

/**
 * Grupo de linhas no formato de lista agrupada do iOS: um bloco de vidro só, linhas separadas por
 * divisória fina. Filho nulo some; sem nenhuma linha, a seção (e o título) não aparece.
 */
export function Section({ title, children }: { title?: string; children: ReactNode }) {
  const rows = Children.toArray(children);
  if (rows.length === 0) return null;
  return (
    <View style={styles.secao}>
      {title ? (
        <Text style={styles.secaoTitulo} accessibilityRole="header">
          {title}
        </Text>
      ) : null}
      <View style={styles.grupo}>
        {rows.map((row, i) => (
          <Fragment key={isValidElement(row) && row.key != null ? row.key : i}>
            {i > 0 ? <View style={styles.divisoria} /> : null}
            {row}
          </Fragment>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  secao: { gap: theme.base.space[1] },
  secaoTitulo: {
    fontSize: theme.base.text.xs,
    fontWeight: '600',
    color: theme.tokens.text.muted,
    paddingHorizontal: theme.base.space[3],
  },
  // overflow: o realce de toque da primeira e da última linha não vaza pelos cantos.
  grupo: { backgroundColor: superficie(theme, 0.6), borderRadius: theme.base.radius.lg, overflow: 'hidden' },
  divisoria: {
    height: StyleSheet.hairlineWidth,
    marginLeft: theme.base.space[3],
    backgroundColor: theme.tokens.border.default,
  },
  linha: {
    paddingHorizontal: theme.base.space[3],
    paddingVertical: theme.base.space[3],
    gap: theme.base.space[3],
    minHeight: 56,
    justifyContent: 'center',
  },
  // Realce de estado é tinta por cima da linha, não superfície: cor chapada aqui é de propósito.
  tocada: { backgroundColor: theme.tokens.bg.hover },
  cabeca: { flexDirection: 'row', alignItems: 'center', gap: theme.base.space[3] },
  alvo: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.base.space[3],
    minHeight: 44,
    borderRadius: theme.base.radius.md,
  },
  textos: { flex: 1, gap: 2 },
  titulo: { fontSize: theme.base.text.base, color: theme.tokens.text.primary, fontWeight: '500' },
  descricao: { fontSize: theme.base.text.xs, color: theme.tokens.text.muted },
}));
