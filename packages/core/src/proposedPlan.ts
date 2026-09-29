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
  let fence = '';
  let previous = '';
  for (const line of text.split(/\r?\n/)) {
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
    const title = heading?.[1].replace(/[ \t]+#+[ \t]*$/, '')
      ?? (previous && /^ {0,3}(?:=+|-+)[ \t]*$/.test(line) ? previous : '');
    if (title.trim()) return title.trim();
    previous = /^ {0,3}\S/.test(line) && !/^\s*(?:[-*+]>?|>|#{1,6})\s/.test(line) ? line.trim() : '';
  }
  return null;
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
