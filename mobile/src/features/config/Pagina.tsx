import type { ReactNode } from 'react';
import { ScrollView } from 'react-native';
import { useHeaderHeight } from 'expo-router/react-navigation';
import { StyleSheet } from 'react-native-unistyles';
import type { Edge } from 'react-native-safe-area-context';
import { Screen } from '../../ui/Screen';

// O cabeçalho das telas de config é transparente (o papel de parede passa por trás do título) e,
// no Android, não tem fundo. A rolagem começa na borda de baixo dele e corta ali, então o texto dos
// cards nunca passa sob o título. A altura é a medida: no formSheet do Android ela já inclui o recuo
// da barra de status, e por isso a borda de cima da área segura fica de fora.
const BORDAS_SEM_TOPO: Edge[] = ['bottom', 'left', 'right'];

/** Casca das telas de `/config`: papel de parede, área segura e rolagem com o recuo do cabeçalho. */
export function Pagina({ children }: { children: ReactNode }) {
  const cabecalho = useHeaderHeight();
  return (
    <Screen edges={BORDAS_SEM_TOPO}>
      <ScrollView style={{ marginTop: cabecalho }} contentContainerStyle={styles.conteudo} keyboardShouldPersistTaps="handled">
        {children}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create((theme) => ({
  conteudo: {
    paddingTop: theme.base.space[3],
    paddingHorizontal: theme.base.space[3],
    paddingBottom: theme.base.space[8],
    gap: theme.base.space[2],
  },
}));
