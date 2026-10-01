// A ponte da sessão, gravada só pelo `session.start` interativo (input.ts). Os outros arquivos leem
// SÓ daqui: um `claude -p` filho no mesmo pane herda o ambiente e não pode falar pela sessão.
export type Bridge = { url: string; token: string; sessao: string };

let atual: Bridge | null = null;
const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

export function setBridge(b: Bridge): void {
  atual = b;
}

export function bridge(): Bridge | null {
  return atual;
}

export function instance(): string {
  return id;
}
