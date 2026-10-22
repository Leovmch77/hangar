// Reserva pré-aquecida da tela de nova conversa: um Claude sem terminal já iniciado no servidor
// enquanto a tela está aberta. Celular e PWA usam o mesmo agendador; o servidor decide a adoção.
import type { CreateSessionBody, PrewarmTicket } from './api';
import type { Server } from './servers';

export type PrewarmBody = Omit<CreateSessionBody, 'name' | 'prewarm'>;

export const PREWARM_SETTLE_MS = 600;
export const PREWARM_RENEW_MS = 30_000;

// Fora disto o servidor recusa a reserva: outro provedor, com terminal, motor ou worktree.
export function prewarmEligible(body: Partial<CreateSessionBody> | null | undefined): boolean {
  return !!body?.cwd && body.provider === 'claude' && body.headless === true && !body.engine
    && !body.branch && !body.new_branch && !body.base;
}

export interface PrewarmApi {
  reserve(server: Server, body: PrewarmBody, clientId: string): Promise<PrewarmTicket>;
  release(server: Server, id: string | null, clientId: string): Promise<void>;
}

// Falha de reserva não aparece na tela: a abertura cai no caminho frio.
const quiet = (what: string) => (cause: unknown) => console.warn(`prewarm ${what}:`, cause);

export class PrewarmReserve {
  readonly clientId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  #api: PrewarmApi;
  #server: Server | null = null;
  #body: PrewarmBody | null = null;
  #key = '';
  #ticket: PrewarmTicket | null = null;
  #timer: ReturnType<typeof setTimeout> | undefined;
  // Invalida a resposta de um PUT pedido para escolhas que já mudaram.
  #gen = 0;
  // Houve PUT desde a última entrega ou liberação: só então há o que soltar no servidor.
  #asked = false;

  constructor(api: PrewarmApi) { this.#api = api; }

  /** Corpo de abertura atual (com ou sem `name`); null ou inelegível solta a reserva. */
  update(server: Server | null, body: Partial<CreateSessionBody> | null): void {
    if (!server || !body || !prewarmEligible(body)) { this.release(); return; }
    const { name: _name, prewarm: _prewarm, ...rest } = body;
    const key = JSON.stringify([server.id, server.baseUrl, rest]);
    if (key === this.#key) return;
    if (this.#server && (this.#server.id !== server.id || this.#server.baseUrl !== server.baseUrl)) this.release();
    this.#gen++;
    this.#key = key;
    this.#server = server;
    this.#body = rest as PrewarmBody;
    this.#ticket = null;
    this.#schedule(PREWARM_SETTLE_MS);
  }

  /** No envio, antes do POST: para a renovação e entrega a reserva que vale para o corpo atual. */
  take(): PrewarmTicket | null {
    clearTimeout(this.#timer);
    this.#gen++;
    const ticket = this.#ticket;
    this.#ticket = null;
    // Reserva de escolhas anteriores ainda subindo: não será adotada, então sai agora.
    if (!ticket && this.#asked && this.#server) this.#drop(this.#server, null);
    this.#asked = false;
    return ticket;
  }

  /** A criação falhou e a tela continua: volta a reservar para o mesmo corpo. */
  resume(): void {
    if (!this.#server || !this.#body) return;
    this.#gen++;
    this.#schedule(PREWARM_SETTLE_MS);
  }

  release(): void {
    clearTimeout(this.#timer);
    this.#gen++;
    const server = this.#server, id = this.#ticket?.id ?? null, asked = this.#asked;
    this.#server = null; this.#body = null; this.#key = ''; this.#ticket = null; this.#asked = false;
    if (server && asked) this.#drop(server, id);
  }

  #schedule(ms: number) {
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => { void this.#put(); }, ms);
  }

  async #put() {
    const server = this.#server, body = this.#body, gen = this.#gen;
    if (!server || !body) return;
    this.#asked = true;
    let refused = false;
    try {
      const ticket = await this.#api.reserve(server, body, this.clientId);
      if (gen === this.#gen && ticket?.id) this.#ticket = ticket;
    } catch (cause) {
      const status = (cause as { status?: unknown } | null)?.status;
      refused = typeof status === 'number' && status >= 400 && status < 500;
      if (gen === this.#gen) quiet('reserve')(cause);
    } finally {
      // Renova com o mesmo corpo; troca de escolha já agendou o seu PUT. Recusa (4xx) se repetiria
      // igual: espera o corpo mudar ou o `resume()`.
      if (gen === this.#gen && !refused) this.#schedule(PREWARM_RENEW_MS);
    }
  }

  #drop(server: Server, id: string | null) {
    try { this.#api.release(server, id, this.clientId).catch(quiet('release')); } catch (cause) { quiet('release')(cause); }
  }
}
