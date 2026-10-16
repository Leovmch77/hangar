import { parseInviteLink } from '@hangar/core';

export function redirectSystemPath({ path }: { path: string; initial: boolean }): string {
  const invite = parseInviteLink(path);
  if (invite) return `/convite/${invite.code}?link=${encodeURIComponent(path)}`;

  try {
    const url = new URL(path);
    const isApp = url.protocol === 'hangar:';
    const isInvitePath = url.pathname === '/convite' || url.pathname.startsWith('/convite/');
    if (isApp && url.host !== 'convite' && url.pathname.startsWith('/convite/') && !url.username && !url.password) {
      // Conserva query e fragmento para validar o convite inteiro.
      const suffix = path.slice(path.indexOf('/convite/') + '/convite/'.length);
      const canonical = `hangar://convite/${url.host}/${suffix}`;
      const aliasInvite = parseInviteLink(canonical);
      if (aliasInvite) return `/convite/${aliasInvite.code}?link=${encodeURIComponent(canonical)}`;
    }
    if ((isApp && (url.host === 'convite' || isInvitePath))
      || ((url.protocol === 'http:' || url.protocol === 'https:') && isInvitePath)) {
      return '/convite/invalid';
    }
  } catch {
    const isInvite = /^(?:hangar:\/\/convite(?:[/?#]|$)|(?:hangar|https?):\/\/[^/?#]*\/convite(?:[/?#]|$))/i.test(path.trim());
    return isInvite ? '/convite/invalid' : path;
  }
  return path;
}
