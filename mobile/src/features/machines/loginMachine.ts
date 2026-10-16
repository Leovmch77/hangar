import { errorDetail, getSessions, probeServerResponse, type Server } from '@hangar/core';
import { useServers } from '../../stores/servers';
import { toast } from '../../ui/Toast';
import * as m from '../../paraglide/messages';

export async function verifyLoginMachine(server: Server, resolveName: boolean): Promise<void> {
  await getSessions(server);
  if (!resolveName) return;

  try {
    const response = await probeServerResponse(server, '/api/peers/identificador');
    if (!response.ok) throw new Error(`${response.status}: ${await errorDetail(response)}`);
    const identity: unknown = await response.json();
    if (!identity || typeof identity !== 'object' || !('identificador' in identity)
      || typeof identity.identificador !== 'string') {
      throw new Error(m.mobile_machines_invalid_response());
    }
    const label = identity.identificador.trim();
    if (label) useServers.getState().update(server.id, { label });
  } catch (error) {
    toast.aviso(error instanceof Error ? error.message : String(error));
  }
}
