import { useCallback, useMemo, useRef, useState } from 'react';
import { BackHandler, Platform } from 'react-native';
import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useUnistyles } from 'react-native-unistyles';
import { ActivityPanel } from '../../../../src/features/activity/ActivityPanel';

export default function ActivitySheet() {
  const { theme } = useUnistyles();
  const router = useRouter();
  const params = useLocalSearchParams<{ server: string; name: string }>();
  const serverId = Array.isArray(params.server) ? params.server[0] : (params.server ?? '');
  const name = Array.isArray(params.name) ? params.name[0] : (params.name ?? '');
  const [focused, setFocused] = useState(false);
  useFocusEffect(useCallback(() => {
    setFocused(true);
    return () => setFocused(false);
  }, []));
  const backRequest = useRef<() => boolean>(() => false);
  const registerBack = useCallback((handler: () => boolean) => { backRequest.current = handler; }, []);

  useFocusEffect(useCallback(() => {
    if (Platform.OS !== 'android') return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => backRequest.current());
    return () => sub.remove();
  }, []));

  const backgroundColor = theme.tokens.bg.base;
  const headerOptions = useMemo(() => ({
    headerShown: false,
    sheetAllowedDetents: [0.92],
    sheetGrabberVisible: true,
    contentStyle: { backgroundColor },
  }), [backgroundColor]);

  const close = () => {
    if (router.canGoBack()) router.back();
    else router.replace(`/s/${encodeURIComponent(serverId)}/${encodeURIComponent(name)}` as never);
  };

  return (
    <>
      <Stack.Screen options={headerOptions} />
      <ActivityPanel serverId={serverId} name={name} focused={focused} onBackRequest={registerBack} onClose={close} />
    </>
  );
}
