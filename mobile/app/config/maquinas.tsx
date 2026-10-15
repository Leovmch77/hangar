import { useEffect, useMemo, useState } from 'react';
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
import { ownServers, useServers } from '../../src/stores/servers';
import { useSessions } from '../../src/stores/sessions';
import { PairAcceptSheet, type PairAcceptTarget } from '../../src/features/pair/PairAcceptSheet';
import * as m from '../../src/paraglide/messages';

export default function Maquinas() {
  const router = useRouter();
  const todos = useServers((s) => s.servers);
  // A entrada do par de fora não é máquina desta pessoa.
  const servers = useMemo(() => ownServers(todos), [todos]);
  const activeId = useServers((s) => s.activeId);
  const [aceite, setAceite] = useState<PairAcceptTarget | null>(null);
  const rows = useSessions((s) => s.rows);
  const byServer = useSessions((s) => s.byServer);
  // A folha escolhe entre as sessões vivas da máquina: a lista precisa estar aberta enquanto ela está.
  useEffect(() => (aceite ? useSessions.getState().retain() : undefined), [aceite]);
  const alvo = aceite ? { ...aceite, sessions: rows.filter((r) => r.serverId === aceite.server.id) } : null;

  const parear = () => {
    const server = servers.find((s) => s.id === activeId) ?? servers[0];
    if (server) setAceite({ server, name: null, sessions: [] });
  };

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
        actions={[
          { icon: 'Plus', label: m.sessao_adicionar_servidor(), onPress: () => router.push('/login' as never) },
          ...(servers.length ? [{ icon: 'Link' as const, label: m.native_par_menu(), onPress: parear }] : []),
        ]}
      />
      {servers.length === 0 ? <InfoNotice text={m.maquinas_vazio()} /> : null}
      {servers.length > 0 ? (
        <SectionCard icon="Server" title={m.native_machines_others()}>
          {servers.map((s) => {
            const error = byServer.find((bucket) => bucket.server.id === s.id)?.error;
            return <SettingsRow
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
              {error && error !== 'offline' ? (
                <View accessibilityRole="alert" accessibilityLiveRegion="polite">
                  <InfoNotice text={error} />
                </View>
              ) : null}
              <View style={styles.pills}>
                <Pill icon="Plug" label={m.config_maquinas_testar()} onPress={() => testar(s)} />
              </View>
            </SettingsRow>;
          })}
        </SectionCard>
      ) : null}
      <PairAcceptSheet target={alvo} onClose={() => setAceite(null)} />
    </Pagina>
  );
}

const styles = StyleSheet.create({
  pills: { flexDirection: 'row' },
});
