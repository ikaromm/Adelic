// Fuzzy matching for the command palette: case- and accent-insensitive subsequence search
// with a score that prefers contiguous matches, word starts and short targets.

/** Lowercase without diacritics ("Configurações" → "configuracoes"). */
export function fold(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();
}

const isWordStart = (text: string, index: number) => index === 0 || !/[\p{L}\p{N}]/u.test(text[index - 1]);

/** Contiguous matches always outrank scattered ones. */
const SUBSTRING_BASE = 1000;

/**
 * Score of `query` against `target`, higher is better; null when the folded query (spaces
 * ignored) is not a subsequence of the folded target. An empty query scores 0 for anything.
 */
export function fuzzyScore(query: string, target: string): number | null {
  const q = fold(query).replace(/\s+/g, '');
  if (!q) return 0;
  const t = fold(target);
  if (q.length > t.length) return null;

  // Contiguous: best occurrence, preferring the start of the text and of a word.
  let best: number | null = null;
  for (let at = t.indexOf(q); at !== -1; at = t.indexOf(q, at + 1)) {
    const score =
      SUBSTRING_BASE + (at === 0 ? 60 : 0) + (isWordStart(t, at) ? 40 : 0) - at - (t.length - q.length) * 0.1;
    if (best === null || score > best) best = score;
  }
  if (best !== null) return best;

  // Scattered: greedy left-to-right, rewarding runs and word starts, penalising gaps.
  let score = 0;
  let from = 0;
  let previous = -2;
  for (const char of q) {
    const index = t.indexOf(char, from);
    if (index === -1) return null;
    score += 1;
    if (index === previous + 1) score += 6;
    if (isWordStart(t, index)) score += 8;
    if (previous >= 0) score -= Math.min(index - previous - 1, 6) * 0.5;
    previous = index;
    from = index + 1;
  }
  return score - t.length * 0.05;
}
