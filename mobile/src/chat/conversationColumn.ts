export const READING_MAX = 760;

export function conversationInset(boxWidth: number, coluna: number, pad: number, maxReading?: number): number {
  const available = boxWidth - 2 * pad;
  const inset = (available * (1 - coluna)) / 2;
  return maxReading === undefined ? inset : Math.max(inset, (available - maxReading) / 2);
}
