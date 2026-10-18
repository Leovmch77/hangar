import { AppState, Platform } from 'react-native';
import { baseOf, configureDiag, criarTransporteDiag, type EventoDiag } from '@hangar/core';
import { useServers } from '../stores/servers';
import { replayFatalError } from './fatalErrors';

let iniciado = false;

export function iniciarDiag(): void {
  if (iniciado) return;
  iniciado = true;
  const cli = Math.random().toString(36).slice(2, 8);
  let seq = 0;
  const destinos = new Set<string>();
  const transporte = criarTransporteDiag((destino) => useServers.getState().servers
    .find((s) => s.baseUrl.replace(/\/+$/, '') === destino || baseOf(s) === destino)?.token);
  // O diário fica nas máquinas desta pessoa, nunca na entrada do par de outra pessoa.
  const ativaPropria = () => { const a = useServers.getState().active(); return a && !a.invite ? a.baseUrl : undefined; };
  const registrar = (evento: EventoDiag, destino = ativaPropria()) => {
    if (!destino) return;
    const base = destino.replace(/\/+$/, '');
    if (!destinos.has(base)) {
      destinos.add(base);
      transporte.registrar(base, { evento: 'app.abriu', cli, seq: ++seq,
        ts: new Date().toISOString(), so: Platform.OS, navegador: 'Expo', vista: 'celular' });
    }
    transporte.registrar(base, { ...evento, cli, seq: ++seq, ts: new Date().toISOString() });
  };
  configureDiag({ registrar, novoReq: () => `${cli}-${(++seq).toString(36)}` });
  const replay = () => {
    void replayFatalError(async (report) => {
      const server = useServers.getState().active();
      if (!server || server.invite || !server.token) return false;
      const event = {
        evento: 'js.fatal', nivel: 'erro', ts: report.timestamp, cli, seq: ++seq,
        codigo: report.name, tela: report.route, detalhe: report.message.slice(0, 300),
        pilha: (report.stack || report.componentStack).slice(0, 300),
        operacao: [report.metadata.runtime, report.metadata.updateId].filter(Boolean).join(' · '),
      };
      const response = await fetch(`${baseOf(server).replace(/\/+$/, '')}/api/diag`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${server.token}` },
        body: JSON.stringify({ eventos: [event] }), signal: AbortSignal.timeout(8000),
      });
      if (!response.ok) return false;
      const ack: unknown = await response.json();
      return !!ack && typeof ack === 'object' && 'gravadas' in ack && ack.gravadas === 1;
    }).catch(() => { console.warn('fatal_error_diary_replay_failed'); });
  };
  replay();
  useServers.subscribe(() => { void transporte.enviar(); replay(); });
  AppState.addEventListener('change', (estado) => {
    registrar({ evento: estado === 'active' ? 'app.visivel' : 'app.oculto' });
    void transporte.enviar();
    if (estado === 'active') replay();
  });
}
