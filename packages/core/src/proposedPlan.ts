import type { ChatEvent } from './types';

// Marcadores do protocolo só valem em linhas próprias, fora de exemplos de código.
function markers(text: string): { start: number; end: number; close: boolean }[] {
  const found: { start: number; end: number; close: boolean }[] = [];
  let offset = 0;
  let fence = '';
  for (const line of text.split('\n')) {
    const delimiter = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (delimiter) {
      const value = delimiter[1];
      if (!fence) fence = value;
      else if (value[0] === fence[0] && value.length >= fence.length) fence = '';
    } else if (!fence && /^\s*<\/?proposed_plan>\s*$/.test(line)) {
      found.push({ start: offset, end: offset + line.length, close: line.includes('</') });
    }
    offset += line.length + 1;
  }
  return found;
}

export function planTitle(text: string): string | null {
  return planHeading(text).title;
}

// O título do plano e o texto sem ele: quem mostra o título à parte não o repete no corpo.
export function planHeading(text: string): { title: string | null; body: string } {
  const lines = text.split(/\r?\n/);
  let fence = '';
  let previous = '';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const delimiter = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (delimiter) {
      const value = delimiter[1];
      if (!fence) fence = value;
      else if (value[0] === fence[0] && value.length >= fence.length && !delimiter[2].trim()) fence = '';
      previous = '';
      continue;
    }
    if (fence) continue;
    const heading = line.match(/^ {0,3}#{1,6}[ \t]+(.+?)\s*$/);
    const setext = !heading && previous && /^ {0,3}(?:=+|-+)[ \t]*$/.test(line);
    const title = heading?.[1].replace(/[ \t]+#+[ \t]*$/, '') ?? (setext ? previous : '');
    if (title.trim()) {
      const first = setext ? i - 1 : i;
      return { title: title.trim(), body: [...lines.slice(0, first), ...lines.slice(i + 1)].join('\n') };
    }
    previous = /^ {0,3}\S/.test(line) && !/^\s*(?:[-*+]>?|>|#{1,6})\s/.test(line) ? line.trim() : '';
  }
  return { title: null, body: text };
}

// A citação é metadado, inclusive enquanto o rodapé ainda está sendo escrito.
function memCitation(text: string): { start: number; end: number } | null {
  let offset = 0;
  let fence = '';
  let start = -1;
  for (const line of text.split('\n')) {
    if (!fence && (start >= 0 || /^\s*<oai-mem-citation>/.test(line))) {
      if (start < 0) start = offset;
      const close = line.indexOf('</oai-mem-citation>');
      if (close >= 0) return { start, end: offset + close + '</oai-mem-citation>'.length };
    }
    const delimiter = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (delimiter) {
      const value = delimiter[1];
      if (!fence) fence = value;
      else if (value[0] === fence[0] && value.length >= fence.length) fence = '';
    }
    offset += line.length + 1;
  }
  return start >= 0 ? { start, end: text.length } : null;
}

export function planDisplayText(text: string): string {
  const cite = memCitation(text);
  if (cite) text = text.slice(0, cite.start) + text.slice(cite.end);
  for (const marker of markers(text).reverse()) {
    text = text.slice(0, marker.start) + text.slice(marker.end);
  }
  return text;
}

export function proposedPlan(text: string): string | null {
  const found = markers(text).reverse();
  const close = found.find((marker) => marker.close);
  if (!close) return null;
  const open = found.find((marker) => !marker.close && marker.start < close.start);
  return text.slice(open?.end ?? 0, close.start).trim() || null;
}

// Plano que ainda espera decisão: só vale até a próxima mensagem real da pessoa (a da fila não conta).
export function pendingProposedPlan(events: ChatEvent[]): { id: string; plan: string } | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.kind === 'user_msg' && !event.id.startsWith('queued-')) return null;
    if (event.kind === 'assistant_msg' && event.text) {
      const plan = proposedPlan(event.text);
      if (plan) return { id: event.id, plan };
    }
  }
  return null;
}

// Claude sem terminal em modo plano: ninguém pergunta "implementar?", então a última resposta do
// turno é o plano. `anchorId` restringe à resposta em que o arquivo do plano foi descoberto.
export function pendingReplyPlan(events: ChatEvent[], anchorId: string | null = null): { id: string; plan: string } | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.kind === 'user_msg' && !event.id.startsWith('queued-')) return null;
    if (event.kind === 'assistant_msg' && event.text && !event.id.startsWith('local-')
        && (!anchorId || event.id === anchorId)) {
      return { id: event.id, plan: event.text };
    }
  }
  return null;
}

export type PlanChoiceKey = 'bypass' | 'auto_mode' | 'manual' | 'auto' | 'changes' | 'keep';

/** Abrevia só as escolhas conhecidas do diálogo de plano da TUI (mesma tabela do nativo,
 *  `plan_choice_key`); o rótulo completo continua no botão para leitor de tela e dica. */
export function planChoiceKey(option: string): PlanChoiceKey | null {
  switch (option.trim()) {
    case 'Yes, and bypass permissions':
    case 'Yes, and switch to BYPASS PERMISSIONS (no further prompts) for this session': return 'bypass';
    case 'Yes, and use auto mode': return 'auto_mode';
    case 'Yes, manually approve edits': return 'manual';
    case 'Yes, and auto-accept edits': return 'auto';
    case 'Tell Claude what to change': return 'changes';
    case 'No, keep planning': return 'keep';
    default: return null;
  }
}
