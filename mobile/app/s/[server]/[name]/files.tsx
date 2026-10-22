import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { FilesPanel } from '../../../../src/features/files/FilesPanel';

export default function FilesSheet() {
  const { theme } = useUnistyles();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { server, name, path } = useLocalSearchParams<{ server: string; name: string; path?: string }>();
  const pathParam = Array.isArray(path) ? path[0] : path;

  return (
    <View style={{ flex: 1, backgroundColor: theme.tokens.bg.base }}>
      <FilesPanel serverId={String(server ?? '')} name={String(name ?? '')} path={pathParam} onBack={() => router.back()} bottomInset={insets.bottom} />
    </View>
  );
}
