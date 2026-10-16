const KEY = 'cp_home_screen';
export type HomeScreen = 'sessions' | 'newConversation';

function load(): HomeScreen {
  try { return localStorage.getItem(KEY) === 'newConversation' ? 'newConversation' : 'sessions'; } catch { return 'sessions'; }
}

let pref = $state<HomeScreen>(load());

export const homeScreen = {
  get pref() { return pref; },
  set pref(v: HomeScreen) {
    pref = v;
    try {
      if (v === 'newConversation') localStorage.setItem(KEY, v);
      else localStorage.removeItem(KEY);
    } catch { /* modo privado: vale pela sessão */ }
  },
};
