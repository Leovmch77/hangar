import { Stack, useRouter } from 'expo-router';
import { HeaderBack, useGlassHeader } from '../../src/ui/glassHeader';
import * as m from '../../src/paraglide/messages';

// O recuo do conteúdo vem da `Pagina`. As páginas internas não repetem o título na barra: quem o
// mostra é o PageHeader, como no desktop. Aqui o voltar leva o nome da página anterior.
export default function ConfigLayout() {
  const router = useRouter();
  return (
    <Stack screenOptions={{ ...useGlassHeader(), headerBackButtonDisplayMode: 'default' }}>
      <Stack.Screen
        name="index"
        options={{
          title: m.config_modal_titulo(),
          // Raiz da pilha das configurações não ganha "voltar" sozinha: sai para a tela de onde veio.
          headerLeft: () => <HeaderBack onPress={() => router.back()} />,
        }}
      />
    </Stack>
  );
}
