const KEY = 'cp_skip_chat_confirmations';

export function skipChatConfirmations(): boolean {
  try { return localStorage.getItem(KEY) === '1'; } catch { return false; }
}

export function rememberSkipChatConfirmations(): boolean {
  try { localStorage.setItem(KEY, '1'); return true; } catch { return false; }
}
