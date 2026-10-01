import { useEffect, useRef, useState } from 'react';
import { StyleSheet } from 'react-native';
import { WebView } from 'react-native-webview';
import { effectWorkerHtml } from './effectWorkerHtml';
import { attachWorker, detachWorker, workerFailed, workerMessage } from './effectImage';

// Cada Screen tem um Background; só um deles hospeda a WebView. Quando o dono desmonta, o próximo
// assume e os pedidos pendentes são reenviados para ele.
let owner: symbol | null = null;
const waiting = new Set<() => void>();

/** WebView invisível que decodifica, reduz, aplica o efeito e gera o PNG fora da thread JS. */
export function EffectWorker() {
  const me = useRef(Symbol('effect-worker')).current;
  const view = useRef<WebView>(null);
  const [own, setOwn] = useState(false);
  useEffect(() => {
    const claim = () => {
      if (owner) return;
      owner = me;
      setOwn(true);
    };
    claim();
    waiting.add(claim);
    return () => {
      waiting.delete(claim);
      if (owner !== me) return;
      owner = null;
      detachWorker();
      for (const next of waiting) next();
    };
  }, [me]);
  // Processo da WebView morto (memória): o pedido em curso falha com aviso e a página renasce.
  const [generation, setGeneration] = useState(0);
  const died = (why: string) => {
    detachWorker();
    workerFailed(why);
    setGeneration((g) => g + 1);
  };
  if (!own) return null;
  return (
    <WebView
      key={generation}
      ref={view}
      style={styles.hidden}
      originWhitelist={['*']}
      source={{ html: effectWorkerHtml }}
      javaScriptEnabled
      onMessage={(e) => {
        if (e.nativeEvent.data.startsWith('{"ready"')) attachWorker((msg) => view.current?.postMessage(msg));
        else workerMessage(e.nativeEvent.data);
      }}
      onError={(e) => workerFailed(`load ${e.nativeEvent.description}`)}
      onContentProcessDidTerminate={() => died('process terminated')}
      onRenderProcessGone={() => died('render process gone')}
    />
  );
}

const styles = StyleSheet.create({
  hidden: { position: 'absolute', width: 1, height: 1, opacity: 0 },
});
