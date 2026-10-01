import { Alert, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { useRouter } from 'expo-router';
import { getConfigForServer, type Server } from '@hangar/core';
import { Pagina } from '../../src/features/config/Pagina';
import { PageHeader, Pill } from '../../src/features/config/PageHeader';
import { SectionCard } from '../../src/features/config/SectionCard';
import { SettingsRow } from '../../src/features/config/SettingsRow';
import { InfoNotice } from '../../src/features/config/InfoNotice';
import { StateDot } from '../../src/ui/StateDot';
import { toast } from '../../src/ui/Toast';
import { useServers } from '../../src/stores/servers';
import * as m from '../../src/paraglide/messages';

export default function Maquinas() {
  const router = useRouter();
  const servers = useServers((s) => s.servers);
  const activeId = useServers((s) => s.activeId);

  const testar = (s: Server) => {
    getConfigForServer(s)
      .then(() => toast.ok(m.config_maquinas_conexao_ok()))
      .catch((e: unknown) => toast.erro(e instanceof Error ? e.message : m.erro_desconhecido()));
  };

  // Remover é sempre com confirmação: a lista pode ter uma máquina só, e sem ela o app volta pro login.
  const remover = (s: Server) =>
    Alert.alert(m.config_servidores_remover({ nome: s.label }), s.baseUrl, [
      { text: m.comum_cancelar(), style: 'cancel' },
      { text: m.lista_remover(), style: 'destructive', onPress: () => useServers.getState().remove(s.id) },
    ]);

  return (
    <Pagina>
      <PageHeader
        title={m.maquinas_titulo()}
        subtitle={m.maquinas_intro()}
        actions={[{ icon: 'Plus', label: m.sessao_adicionar_servidor(), onPress: () => router.push('/login' as never) }]}
      />
      {servers.length === 0 ? <InfoNotice text={m.maquinas_vazio()} /> : null}
      {servers.length > 0 ? (
        <SectionCard icon="Server" title={m.native_machines_others()}>
          {servers.map((s) => (
            <SettingsRow
              key={s.id}
              icon="Monitor"
              title={s.label}
              description={s.baseUrl}
              onPress={() => useServers.getState().setActive(s.id)}
              onLongPress={() => remover(s)}
              // Ponto só na ativa: as outras não estão erradas, estão paradas — um ponto
              // vermelho ali leria como máquina fora do ar, que ninguém mediu.
              right={s.id === activeId ? <StateDot state="idle" /> : null}
            >
              <View style={styles.pills}>
                <Pill icon="Plug" label={m.config_maquinas_testar()} onPress={() => testar(s)} />
              </View>
            </SettingsRow>
          ))}
        </SectionCard>
      ) : null}
    </Pagina>
  );
}

const styles = StyleSheet.create({
  pills: { flexDirection: 'row' },
});
