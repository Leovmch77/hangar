const KEY = 'cp_session_org';
export type SessionOrganization = 'sessions' | 'conversations';

function load(): SessionOrganization {
  try { return localStorage.getItem(KEY) === 'conversations' ? 'conversations' : 'sessions'; } catch { return 'sessions'; }
}

let mode = $state<SessionOrganization>(load());

export const sessionOrganization = {
  get mode() { return mode; },
  set mode(v: SessionOrganization) {
    mode = v;
    try {
      if (v === 'conversations') localStorage.setItem(KEY, v);
      else localStorage.removeItem(KEY);
    } catch { /* modo privado: vale pela sessão */ }
  },
};
