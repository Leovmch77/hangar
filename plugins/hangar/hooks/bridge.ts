// A ponte da sessão, gravada só pelo long-poll do input.ts quando o backend o aceita como dono.
// Os outros arquivos leem SÓ daqui: um `claude -p` filho ou um segundo `claude` no mesmo pane
// herda o ambiente e não pode falar pela sessão.
export type Bridge = { url: string; token: string; sessao: string };

let atual: Bridge | null = null;
const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

export function setBridge(b: Bridge): void {
  atual = b;
}

export function clearBridge(): void {
  atual = null;
}

export function bridge(): Bridge | null {
  return atual;
}

export function instance(): string {
  return id;
}
