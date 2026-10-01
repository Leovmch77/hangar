import { useState } from 'react';
import { useRouter } from 'expo-router';
import { Screen } from '../src/ui/Screen';
import { SessionList } from '../src/features/sessions/SessionList';
import { ServerSheet } from '../src/features/sessions/ServerSheet';

// A lista é um painel de vidro flutuante (gaveta do app nativo): marca, ações e "Nova" moram
// dentro dele, então a tela só monta o fundo e as folhas.
export default function Index() {
  const router = useRouter();
  const [servidoresAberto, setServidoresAberto] = useState(false);
  return (
    <Screen>
      <SessionList onOpenServers={() => setServidoresAberto(true)} onOpenSettings={() => router.push('/config' as never)} />
      <ServerSheet open={servidoresAberto} onFechar={() => setServidoresAberto(false)} />
    </Screen>
  );
}
