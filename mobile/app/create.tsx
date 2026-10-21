import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { useRouter, useSegments } from 'expo-router';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { Screen } from '../src/ui/Screen';
import { CreateSessionSheet } from '../src/features/create/CreateSessionSheet';

// Nova sessão do menu: o formulário completo, com Cancelar e Criar no próprio cabeçalho.
export default function CreateRoute() {
  const router = useRouter();
  const segments = useSegments();
  const close = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/');
  };
  return (
    <Screen independent>
      <KeyboardAvoidingView behavior="padding" automaticOffset style={styles.wrap}>
        {segments[0] === 'create' ? <CreateSessionSheet layout="form" onClose={close} /> : <View />}
      </KeyboardAvoidingView>
    </Screen>
  );
}

// Transparente: o Background da Screen pinta o fundo escolhido em Aparência.
const styles = StyleSheet.create(() => ({
  wrap: { flex: 1, backgroundColor: 'transparent' },
}));
