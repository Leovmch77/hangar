import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { useRouter, useSegments } from 'expo-router';
import { Screen } from '../src/ui/Screen';
import { CreateSessionSheet } from '../src/features/create/CreateSessionSheet';

export default function CreateRoute() {
  const router = useRouter();
  const segments = useSegments();
  return (
    <Screen>
      <View style={styles.wrap}>
        {segments[0] === 'create' ? <CreateSessionSheet onClose={() => router.back()} /> : null}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create((theme) => ({
  wrap: { flex: 1, backgroundColor: theme.tokens.bg.base },
}));
