import { formataErro, leavePair, type Server } from '@hangar/core';
import { markLeavingPair } from '../../stores/sessions';
import { toast } from '../../ui/Toast';
import * as m from '../../paraglide/messages';

const mensagemDe = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Desfaz o par externo no servidor próprio; falha (lançada ou `ok:false`) tira a marca e avisa. */
export function leaveExternal(alias: string, session: string, server: Server): void {
  const desfazer = markLeavingPair(alias, session);
  leavePair(alias, session, server)
    .then((r) => {
      if (r.ok) return;
      desfazer();
      toast.erro(formataErro((r as { error?: unknown }).error) ?? m.par_falhou_saida());
    })
    .catch((e: unknown) => { desfazer(); toast.erro(mensagemDe(e)); });
}
