import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { BlurTargetView } from 'expo-blur';
import { SafeAreaView, type Edge } from 'react-native-safe-area-context';
import { StyleSheet } from 'react-native-unistyles';
import { Background } from './Background';
import { BlurTargetContext } from './blurTarget';

const TODAS: Edge[] = ['top', 'bottom', 'left', 'right'];
const WindowBackground = createContext(false);

export function Screen({ children, edges = TODAS, background = true, independent = false }: {
  children: React.ReactNode; edges?: Edge[]; background?: boolean; independent?: boolean;
}) {
  const inherited = useContext(WindowBackground) && !independent;
  const parentTarget = useContext(BlurTargetContext);
  const paint = background && !inherited;
  // O alvo do blur do Android: o Glass lá dentro pega esta ref pelo contexto. O alvo envolve SÓ o
  // fundo: um BlurView dentro do próprio alvo desenha a si mesmo, e num cabeçalho fixo de lista isso
  // estoura a pilha do RenderThread (crash ao agrupar por Projeto). A ref só vai pelo contexto depois
  // de montada: o BlurView que nasce com `current` nulo cai em "none" e nunca refaz a conta.
  const alvo = useRef<View>(null);
  const [montado, setMontado] = useState(false);
  useEffect(() => setMontado(true), []);
  return (
    <WindowBackground.Provider value={inherited || background}>
    <BlurTargetContext.Provider value={paint ? (montado ? alvo : null) : parentTarget}>
      <View style={styles.root}>
        {paint ? <BlurTargetView ref={alvo} style={StyleSheet.absoluteFillObject}>
          <Background />
        </BlurTargetView> : null}
        <SafeAreaView style={styles.safe} edges={inherited ? [] : edges}>
          {children}
        </SafeAreaView>
      </View>
    </BlurTargetContext.Provider>
    </WindowBackground.Provider>
  );
}

// Fundo transparente: quem pinta é o Background, e ele já começa com a cor opaca do tema.
const styles = StyleSheet.create(() => ({
  root: { flex: 1, backgroundColor: 'transparent' },
  safe: { flex: 1 },
}));
