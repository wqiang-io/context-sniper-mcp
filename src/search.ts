import type { IndexedChunk, SearchIndex } from "./repo-index.js";
import { tokenize } from "./tokenize.js";

const MAX_SNIPPET_CHARS = 4000;

export interface SearchHit {
  path: string;
  startLine: number;
  endLine: number;
  score: number;
  snippet: string;
  truncated: boolean;
}

/** Safe lookup on a possibly JSON-parsed (Object.prototype-bearing) map. */
function freq(map: Record<string, number>, term: string): number {
  return Object.hasOwn(map, term) ? map[term] : 0;
}

/**
 * BM25 scoring over a prebuilt index. Term frequencies, document frequencies,
 * and average length are computed once at index time (see buildSearchIndex),
 * so each query only computes per-term idf and scans chunks to score them.
 */
export function searchChunks(index: SearchIndex, query: string, topK = 5): SearchHit[] {
  const queryTokens = Array.from(new Set(tokenize(query)));
  if (queryTokens.length === 0 || index.chunkCount === 0) return [];

  const N = index.chunkCount;
  const avgLen = index.avgLength || 1;
  const k1 = 1.5;
  const b = 0.75;

  // Precompute idf for the query terms that actually occur in the corpus.
  const idf = new Map<string, number>();
  for (const term of queryTokens) {
    const df = freq(index.df, term);
    if (df === 0) continue;
    idf.set(term, Math.log(1 + (N - df + 0.5) / (df + 0.5)));
  }
  if (idf.size === 0) return [];

  const scored: Array<{ chunk: IndexedChunk; score: number }> = [];
  for (const chunk of index.chunks) {
    let score = 0;
    for (const [term, termIdf] of idf) {
      const tf = freq(chunk.termFreq, term);
      if (tf === 0) continue;
      const denom = tf + k1 * (1 - b + (b * chunk.length) / avgLen);
      score += termIdf * ((tf * (k1 + 1)) / denom);
    }
    if (score > 0) scored.push({ chunk, score });
  }

  scored.sort((a, b2) => b2.score - a.score);

  return scored.slice(0, topK).map(({ chunk, score }) => {
    const raw = chunk.text;
    const truncated = raw.length > MAX_SNIPPET_CHARS;
    const snippet = truncated ? raw.slice(0, MAX_SNIPPET_CHARS) : raw;
    return {
      path: chunk.path,
      startLine: chunk.startLine,
      endLine: chunk.endLine,
      score: Math.round(score * 1000) / 1000,
      snippet,
      truncated,
    };
  });
}

export function formatEvidencePacket(hits: SearchHit[]): string {
  if (hits.length === 0) {
    return "No matching chunks found.";
  }

  return hits
    .map((hit, i) => {
      const header = `[${i + 1}] FILE: ${hit.path}\nLINES: ${hit.startLine}-${hit.endLine}\nSCORE: ${hit.score}`;
      const body = "```\n" + hit.snippet + (hit.truncated ? "\n... (truncated at 4000 chars)" : "") + "\n```";
      return `${header}\n${body}`;
    })
    .join("\n\n");
}
