// Cadastro de convidados feito pelo navegador do dono: cria o acesso em cada servidor com a chave
// do dono e grava no hub a conta do convidado só com as chaves dele. O cadastro (inclusive a senha
// que o dono definiu) fica cifrado com a chave do dono, pra editar sem pedir a senha de novo.
import { createGuestForServer, updateGuestForServer, deleteGuestForServer } from '@hangar/core';
import * as m from '../paraglide/messages';
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

// O status HTTP vem no erro do core (`status`), sem depender do texto.
const gone = (e: unknown) => (e as { status?: number } | null)?.status === 404;

export async function saveGuest(
  draft: GuestDraft, prev: GuestAdmin | null,
): Promise<{ saved: GuestAdmin; errors: ServerFailure[]; hubFailed: boolean }> {
  const byId = new Map(listOwnServers().map((s) => [s.id, s]));
  const before = new Map((prev?.servers ?? []).map((s) => [s.serverId, s]));
  const settings = { sees_owner: draft.seesOwner, owner_sees: draft.ownerSees };
  const kept: GuestServer[] = [];
  const errors: ServerFailure[] = [];
  const create = async (server: Server, root: string) => {
    const r = await createGuestForServer(server, { name: draft.user, root, ...settings });
    kept.push({ serverId: server.id, guestId: r.id, token: r.token, root });
  };
  for (const want of draft.servers) {
    const server = byId.get(want.serverId);
    const old = before.get(want.serverId);
    if (!server) {
      // Sem o servidor na lista não dá pra agir nele; o token antigo fica no cadastro.
      errors.push({ label: want.serverId, message: m.convidados_servidor_fora_da_lista() });
      if (old) kept.push(old);
      continue;
    }
    try {
      if (!old) {
        await create(server, want.root);
        continue;
      }
      try {
        await updateGuestForServer(server, old.guestId, { root: want.root, ...settings });
        kept.push({ ...old, root: want.root });
      } catch (e) {
        if (!gone(e)) throw e;
        // Sumiu no servidor: recria em vez de ficar com um id morto.
        await create(server, want.root);
      }
    } catch (e) {
      errors.push({ label: server.label, message: message(e) });
      if (old) kept.push(old);
    }
  }
  for (const old of prev?.servers ?? []) {
    if (draft.servers.some((w) => w.serverId === old.serverId)) continue;
    const server = byId.get(old.serverId);
    if (!server) {
      errors.push({ label: old.serverId, message: m.convidados_servidor_fora_da_lista() });
      kept.push(old);
      continue;
    }
    try {
      await deleteGuestForServer(server, old.guestId);
    } catch (e) {
      if (gone(e)) continue; // já removido
      // Fica no cadastro pra poder tentar remover de novo.
      errors.push({ label: server.label, message: message(e) });
      kept.push(old);
    }
  }
  const saved: GuestAdmin = { ...draft, servers: kept };
  const guestServers: Server[] = kept.flatMap((k) => {
    const s = byId.get(k.serverId);
    return s ? [{ id: s.id, label: s.label, baseUrl: s.baseUrl, token: k.token }] : [];
  });
  try {
    await putGuestAccount(saved.user, saved.password, guestServers, saved);
  } catch (e) {
    // Os servidores já mudaram: devolve `saved` pra quem chamou repetir com ele e não duplicar.
    errors.push({ label: m.sync_config_titulo(), message: message(e) });
    return { saved, errors, hubFailed: true };
  }
  return { saved, errors, hubFailed: false };
}

export async function removeGuest(g: GuestAdmin): Promise<ServerFailure[]> {
  const { saved, errors, hubFailed } = await saveGuest({ ...g, servers: [] }, g);
  // Só apaga a conta do hub quando todos os servidores largaram o acesso e o hub aceitou a gravação.
  if (saved.servers.length === 0 && !hubFailed) await deleteGuestAccount(g.user);
  return errors;
}
