import * as m from '../../paraglide/messages';

// Nomes dos modos como o app de PC escreve. Modo que o app não conhece (CLI novo) sai como o id cru:
// dado, não interface.
const LABEL: Record<string, () => string> = {
  plan: m.native_mode_plan,
  auto: m.native_mode_auto,
  manual: m.native_mode_manual,
  acceptEdits: m.native_mode_acceptEdits,
  bypassPermissions: m.native_mode_bypassPermissions,
  dontAsk: m.native_mode_dontAsk,
};

export const permissionLabel = (mode: string) => LABEL[mode]?.() ?? mode;

// Rótulo curto da pílula na linha do composer, o mesmo do PWA.
const SHORT: Record<string, () => string> = {
  plan: m.permissao_modo_plan,
  auto: m.permissao_modo_auto,
  manual: m.permissao_modo_manual,
  acceptEdits: m.permissao_modo_acceptEdits,
  bypassPermissions: m.permissao_modo_bypassPermissions,
  dontAsk: m.permissao_modo_dontAsk,
};

export const permissionShortLabel = (mode: string) => SHORT[mode]?.() ?? mode;

// Consequência prática de cada modo: no celular não há tooltip, a frase vai na própria linha.
const DESCRIPTION: Record<string, () => string> = {
  plan: m.permissao_desc_plan,
  auto: m.permissao_desc_auto,
  manual: m.permissao_desc_manual,
  acceptEdits: m.permissao_desc_acceptEdits,
  bypassPermissions: m.permissao_desc_bypassPermissions,
  dontAsk: m.permissao_desc_dontAsk,
};

export const permissionDescription = (mode: string) => DESCRIPTION[mode]?.();
