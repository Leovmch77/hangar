// Dublê do sessionsStore para o teste da tela: como o real, o retain lê e grava estado reativo.
let refs = $state(0);
export const sessionsStore = {
  retain() { refs = refs + 1; },
  release() { refs = Math.max(0, refs - 1); },
  get rows() { return []; },
};
