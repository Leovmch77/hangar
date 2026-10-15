import { Modal } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { Lightbox, type LightboxProps } from './Lightbox';

// O Lightbox é camada absoluta: dentro de uma bolha ele ficaria do tamanho dela. O Modal dá a tela
// inteira, e o gesto de zoom precisa da própria raiz do gesture-handler ali dentro. `media` nulo =
// visor fechado.
export function LightboxModal({ media, onClose }: { media: Omit<LightboxProps, 'visible' | 'onClose'> | null; onClose: () => void }) {
  return (
    <Modal visible={media !== null} transparent animationType="fade" statusBarTranslucent onRequestClose={onClose}>
      <GestureHandlerRootView style={{ flex: 1 }}>
        {media ? <Lightbox visible {...media} onClose={onClose} /> : null}
      </GestureHandlerRootView>
    </Modal>
  );
}
