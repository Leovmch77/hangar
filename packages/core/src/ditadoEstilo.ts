import * as m from './paraglide/messages.js';
import { getConfig, getConfigForServer, type CampoConfig } from './api';
import type { Server } from './servers';

export type EstiloDitado = 'limpar' | 'prosa' | 'briefing';

export function estilosDitado(): { valor: EstiloDitado; rotulo: string; hint: string }[] {
  return [
    { valor: 'limpar', rotulo: m.ditado_estilo_limpar(), hint: m.ditado_estilo_limpar_hint() },
    { valor: 'prosa', rotulo: m.ditado_estilo_prosa(), hint: m.ditado_estilo_prosa_hint() },
    { valor: 'briefing', rotulo: m.ditado_estilo_briefing(), hint: m.ditado_estilo_briefing_hint() },
  ];
}

export function ehEstilo(v: unknown): v is EstiloDitado {
  return v === 'limpar' || v === 'prosa' || v === 'briefing';
}

/** 'off' = o servidor devolve o texto cru em todo estilo, então escolher estilo não faz nada.
 *  'unknown' = servidor anterior ao campo ou leitura que falhou: a tela segue como sempre. */
export type DictationOrganization = 'on' | 'off' | 'unknown';

/** Mesma leitura do Rust (`OrganizationMode::saved`): só `harness` e `external_api` organizam. */
export function dictationOrganizationOf(
  campos: Record<string, Pick<CampoConfig, 'valor'> | undefined> | undefined,
): DictationOrganization {
  const campo = campos?.dictation_organization_mode;
  if (!campo) return 'unknown';
  return campo.valor === 'harness' || campo.valor === 'external_api' ? 'on' : 'off';
}

/** O modo é da máquina da sessão: `s` nulo lê o servidor ativo. */
export async function fetchDictationOrganization(s: Server | null | undefined): Promise<DictationOrganization> {
  try {
    const cfg = await (s ? getConfigForServer(s) : getConfig());
    return dictationOrganizationOf(cfg.campos);
  } catch {
    return 'unknown';
  }
}
