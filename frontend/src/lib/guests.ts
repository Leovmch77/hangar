// Cadastro de convidados feito pelo navegador do dono: cria o acesso em cada servidor com a chave
// do dono e grava no hub a conta do convidado só com as chaves dele. O cadastro (inclusive a senha
// que o dono definiu) fica cifrado com a chave do dono, pra editar sem pedir a senha de novo.
import { createGuestForServer, updateGuestForServer, deleteGuestForServer } from '@hangar/core';
import { listOwnServers, type Server } from './auth';
import { getGuestAccounts, putGuestAccount, deleteGuestAccount } from './sync';

export type GuestServer = { serverId: string; guestId: string; token: string; root: string };
export type GuestAdmin = { user: string; password: string; seesOwner: boolean; ownerSees: boolean; servers: GuestServer[] };
export type GuestDraft = Omit<GuestAdmin, 'servers'> & { servers: { serverId: string; root: string }[] };
export type ServerFailure = { label: string; message: string };

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function listGuests(): Promise<GuestAdmin[]> {
  return (await getGuestAccounts<GuestAdmin>()).map((row) => row.admin);
}

export async function saveGuest(draft: GuestDraft, prev: GuestAdmin | null): Promise<{ saved: GuestAdmin; errors: ServerFailure[] }> {
  const byId = new Map(listOwnServers().map((s) => [s.id, s]));
  const before = new Map((prev?.servers ?? []).map((s) => [s.serverId, s]));
  const settings = { sees_owner: draft.seesOwner, owner_sees: draft.ownerSees };
  const kept: GuestServer[] = [];
  const errors: ServerFailure[] = [];
  for (const want of draft.servers) {
    const server = byId.get(want.serverId);
    if (!server) continue;
    const old = before.get(want.serverId);
    try {
      if (old) {
        await updateGuestForServer(server, old.guestId, { root: want.root, ...settings });
        kept.push({ ...old, root: want.root });
      } else {
        const r = await createGuestForServer(server, { name: draft.user, root: want.root, ...settings });
        kept.push({ serverId: server.id, guestId: r.id, token: r.token, root: want.root });
      }
    } catch (e) {
      errors.push({ label: server.label, message: message(e) });
      if (old) kept.push(old);
    }
  }
  for (const old of prev?.servers ?? []) {
    if (draft.servers.some((w) => w.serverId === old.serverId)) continue;
    const server = byId.get(old.serverId);
    try {
      if (server) await deleteGuestForServer(server, old.guestId);
    } catch (e) {
      // Fica no cadastro pra poder tentar remover de novo.
      errors.push({ label: server?.label ?? old.serverId, message: message(e) });
      kept.push(old);
    }
  }
  const saved: GuestAdmin = { ...draft, servers: kept };
  const guestServers: Server[] = kept.flatMap((k) => {
    const s = byId.get(k.serverId);
    return s ? [{ id: s.id, label: s.label, baseUrl: s.baseUrl, token: k.token }] : [];
  });
  await putGuestAccount(saved.user, saved.password, guestServers, saved);
  return { saved, errors };
}

export async function removeGuest(g: GuestAdmin): Promise<ServerFailure[]> {
  const { saved, errors } = await saveGuest({ ...g, servers: [] }, g);
  // Só apaga a conta do hub quando todos os servidores largaram o acesso; senão fica pra repetir.
  if (saved.servers.length === 0) await deleteGuestAccount(g.user);
  return errors;
}
