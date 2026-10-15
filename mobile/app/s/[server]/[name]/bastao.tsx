import { useLocalSearchParams } from 'expo-router';
import { BastaoSheet } from '../../../../src/chat/BastaoSheet';

export default function BastaoRoute() {
  const { server, name } = useLocalSearchParams<{ server: string; name: string }>();
  return <BastaoSheet serverId={String(server ?? '')} name={String(name ?? '')} />;
}
