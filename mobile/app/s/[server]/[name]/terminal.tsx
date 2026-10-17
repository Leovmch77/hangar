import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { useIsFocused, useLocalSearchParams } from 'expo-router';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { TerminalScreen } from '../../../../src/features/terminal/TerminalScreen';

export default function TerminalSheet() {
  const { server, name, aviso } = useLocalSearchParams<{ server: string; name: string; aviso?: string }>();
  const focused = useIsFocused();
  const serverId = Array.isArray(server) ? server[0] : (server ?? '');
  const sessionName = Array.isArray(name) ? name[0] : (name ?? '');
  const avisoText = Array.isArray(aviso) ? aviso[0] : aviso;
  return (
    <KeyboardAvoidingView behavior="padding" automaticOffset style={styles.root}>
      <View style={styles.inner}>
        <TerminalScreen serverId={serverId} name={sessionName} focused={focused} aviso={avisoText} />
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: {
    flex: 1,
    backgroundColor: theme.tokens.bg.base,
  },
  inner: {
    flex: 1,
  },
}));
