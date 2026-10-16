import { useEffect, useRef, useState } from 'react';
import { Alert, View } from 'react-native';
import { getConfigForServer, type Server } from '@hangar/core';
import { useServers } from '../../stores/servers';
import { SectionCard } from '../config/SectionCard';
import { InfoNotice } from '../config/InfoNotice';
import { Pill } from '../config/PageHeader';
import { Field, MachineSheet, Notice, styles, useMachineAction } from './parts';
import { ensureActive, normalizeUrl } from './api';
import { ServerSettings } from './ServerSettings';
import { MachineOperations } from './MachineOperations';
import { PeerSettings } from './PeerSettings';
import * as m from '../../paraglide/messages';

export function useForgetMachine(onForgot?: () => void) {
  const alive = useRef(true);
  const pending = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; pending.current = false; }; }, []);
  return (server: Server) => {
    if (!alive.current || pending.current) return;
    pending.current = true;
    const cancel = () => { pending.current = false; };
    Alert.alert(m.config_servidores_remover({ nome: server.label }), m.mobile_machines_leave_body({ name: server.label }), [
      { text: m.comum_cancelar(), style: 'cancel', onPress: cancel },
      { text: m.mobile_machines_leave(), style: 'destructive', onPress: () => {
        if (!alive.current || !pending.current) return;
        pending.current = false;
        useServers.getState().remove(server.id); onForgot?.();
      } },
    ], { cancelable: true, onDismiss: cancel });
  };
}

export function MachineSettingsSheet({ server, onClose }: { server: Server; onClose: () => void }) {
  const [label, setLabel] = useState(server.label);
  const [address, setAddress] = useState(server.baseUrl);
  const local = useMachineAction();
  const forget = useForgetMachine(onClose);
  const saveLocal = () => local.run(async (signal) => {
    const baseUrl = normalizeUrl(address);
    if (baseUrl !== server.baseUrl) {
      // O id salvo pode ter rota LAN em cache; este teste precisa atingir o endereço digitado.
      await getConfigForServer({ id: `machine-probe:${baseUrl}`, label: server.label, baseUrl, token: server.token }, 15_000);
      ensureActive(signal);
    }
    return { label: label.trim() || server.label, baseUrl };
  }, (patch) => {
    useServers.getState().update(server.id, patch);
    if (patch.baseUrl !== server.baseUrl) onClose();
  }, m.mobile_machines_saved());
  return <MachineSheet title={server.label} onClose={onClose}>
    <SectionCard icon="Smartphone" title={m.mobile_machines_local()}>
      <View style={styles.content}>
        <Field label={m.mobile_machines_label()} value={label} onChangeText={setLabel} editable={!local.busy} />
        <Field label={m.mobile_machines_endpoint()} value={address} onChangeText={setAddress} editable={!local.busy} keyboardType="url" />
        <InfoNotice text={m.mobile_machines_endpoint_help()} />
        <Notice text={local.error} error /><Notice text={local.message} />
        <View style={styles.actions}>
          <Pill label={local.busy ? m.mobile_machines_busy() : m.mobile_machines_save()} disabled={local.busy} onPress={saveLocal} />
          <Pill icon="LogOut" label={m.mobile_machines_leave()} disabled={local.busy} onPress={() => forget(server)} />
        </View>
      </View>
    </SectionCard>
    <ServerSettings server={server} />
    <PeerSettings server={server} />
    <MachineOperations server={server} />
  </MachineSheet>;
}
