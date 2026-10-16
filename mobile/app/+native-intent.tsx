import { parseInviteLink } from '@hangar/core';

export function redirectSystemPath({ path }: { path: string; initial: boolean }): string {
  const invite = parseInviteLink(path);
  return invite ? `/convite/${invite.code}?link=${encodeURIComponent(path)}` : path;
}
