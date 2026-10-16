import { create } from 'zustand';

// Realce breve da resposta de origem quando a pessoa toca numa citação, como a PWA faz no trecho.
// A biblioteca de Markdown não marca um intervalo do texto, então quem acende é a bolha inteira.
interface QuoteFlashState {
  eventId: string | null;
}

export const useQuoteFlash = create<QuoteFlashState>(() => ({ eventId: null }));

const FLASH_MS = 1600;
let timer: ReturnType<typeof setTimeout> | undefined;

export function flashQuoteSource(eventId: string) {
  clearTimeout(timer);
  useQuoteFlash.setState({ eventId });
  timer = setTimeout(() => useQuoteFlash.setState({ eventId: null }), FLASH_MS);
}
