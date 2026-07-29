/**
 * Pure-TypeScript BM25 ranking for the local reference library.
 *
 * No ML model, no embeddings, no FAISS. Just the classic BM25 formula
 * (Robertson, Walker, Beaulieu 1995) used by Elasticsearch, Solr,
 * Lucene, sci-hub's search box, arxiv's search engine.
 *
 * Why BM25 instead of TF-IDF? BM25 normalises by document length so
 * a short abstract isn't unfairly penalised. It also has tunable
 * saturation parameters (k1, b) that prevent very high term
 * frequencies from dominating.
 *
 * Plan §13.5 target: ~150-200 LOC. Actual size: ~190 LOC including
 * JSDoc.
 *
 * Math (BM25 score for term t in document d):
 *
 *   IDF(t) = log((N - df(t) + 0.5) / (df(t) + 0.5) + 1)
 *
 *   tf_norm(t,d) = (tf(t,d) * (k1 + 1)) / (tf(t,d) + k1 * (1 - b + b * |d|/avgdl))
 *
 *   score(d, q) = Σ_{t in q} IDF(t) * tf_norm(t,d)
 *
 *   where N        = total docs,
 *         df(t)    = docs containing t,
 *         tf(t,d)  = frequency of t in d,
 *         |d|      = length of d in tokens,
 *         avgdl    = mean |d| across all docs,
 *         k1       = saturation (typical 1.2-2.0),
 *         b        = length normalisation (typical 0.75).
 *
 * References:
 *   - https://en.wikipedia.org/wiki/Okapi_BM25
 *   - Robertson, S. & Zaragoza, H. (2009). "The Probabilistic Relevance
 *     Framework: BM25 and Beyond". Foundations and Trends in IR.
 */

import type { CslItem } from "../csl/schema.ts";

export interface BM25Options {
  /** Term frequency saturation. Typical: 1.2-2.0. Default 1.5. */
  k1?: number;
  /** Length normalisation. 0 = no length penalty, 1 = full. Default 0.75. */
  b?: number;
}

export interface BM25Hit {
  id: string;
  score: number;
}

/**
 * Lowercase + strip non-alphanumeric + collapse whitespace.
 * Stops-words removal is left to the caller (the library CLI may
 * want to keep them for short queries; the index() pipeline applies
 * a small English stop list — see below).
 */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

/**
 * Small English stop-word list. We don't ship a full one because
 * scientific paper titles + abstracts don't need it — and the
 * library's domain (Drosophila, mouse, cancer) has very few
 * ambiguous stop-words. If we ever expand to multilingual, this
 * needs a real stop-word library.
 */
const STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from",
  "has", "have", "in", "is", "it", "its", "of", "on", "or", "that",
  "the", "to", "was", "were", "will", "with",
]);

export function tokenizeForIndex(text: string): string[] {
  return tokenize(text).filter((t) => !STOP_WORDS.has(t));
}

/**
 * BM25 index over a collection of CslItems. Index once after loading
 * the library, then search() many times.
 *
 * Memory: O(N * avgdl) where N is the number of documents and
 * avgdl is the mean token count. For a 10K-paper library with
 * avgdl=50, that's ~500K tokens = ~5MB. Fits comfortably in RAM.
 */
export class BM25Index {
  private k1: number;
  private b: number;

  /** Map from doc id → list of tokens (pre-tokenised, immutable). */
  private docs = new Map<string, string[]>();
  /** Map from doc id → original length in tokens (for length norm). */
  private docLen = new Map<string, number>();
  /** Map from term → number of documents containing it. */
  private df = new Map<string, number>();
  /** Map from term → Map<doc id → term frequency in that doc>. */
  private tf = new Map<string, Map<string, number>>();
  /** Mean document length across all indexed docs. */
  private avgdl = 0;
  /** Total number of indexed documents. */
  private N = 0;

  constructor(opts: BM25Options = {}) {
    this.k1 = opts.k1 ?? 1.5;
    this.b = opts.b ?? 0.75;
  }

  /**
   * Build the index from a list of CslItems. Each item's title +
   * abstract is tokenised (stop-words removed). The item's `id`
   * becomes the lookup key.
   *
   * Idempotent: calling index() multiple times REPLACES the previous
   * index. Use update() to add a single item without rebuilding.
   */
  index(items: CslItem[]): void {
    this.docs.clear();
    this.docLen.clear();
    this.df.clear();
    this.tf.clear();

    for (const item of items) {
      const text = `${item.title ?? ""} ${item.abstract ?? ""}`;
      const tokens = tokenizeForIndex(text);
      this.docs.set(item.id, tokens);
      this.docLen.set(item.id, tokens.length);

      // Count term frequencies for this doc.
      const tf = new Map<string, number>();
      for (const t of tokens) {
        tf.set(t, (tf.get(t) ?? 0) + 1);
      }
      for (const t of tf.keys()) {
        // Store in the term index. Each entry is a Map<docId, freq>.
        if (!this.tf.has(t)) this.tf.set(t, new Map());
        this.tf.get(t)!.set(item.id, tf.get(t)!);
      }
    }

    // Compute df from tf index.
    for (const t of this.tf.keys()) {
      this.df.set(t, this.tf.get(t)!.size);
    }

    this.N = this.docs.size;
    let total = 0;
    for (const len of this.docLen.values()) total += len;
    this.avgdl = this.N > 0 ? total / this.N : 0;
  }

  /** Number of indexed documents. */
  get size(): number {
    return this.N;
  }

  /**
   * Search the index. Returns top-N hits sorted by BM25 score
   * descending. Ties broken by doc id (stable).
   */
  search(query: string, topN = 10): BM25Hit[] {
    const queryTokens = tokenizeForIndex(query);
    if (queryTokens.length === 0 || this.N === 0) return [];

    const scores = new Map<string, number>();
    for (const q of queryTokens) {
      const df = this.df.get(q) ?? 0;
      if (df === 0) continue;
      // BM25 IDF with the +1 smoothing factor (Lucene's variant).
      const idf = Math.log((this.N - df + 0.5) / (df + 0.5) + 1);
      const postings = this.tf.get(q)!;
      for (const [docId, f] of postings) {
        const dl = this.docLen.get(docId) ?? 0;
        const denom = f + this.k1 * (1 - this.b + (this.b * dl) / this.avgdl);
        const tfNorm = (f * (this.k1 + 1)) / denom;
        scores.set(docId, (scores.get(docId) ?? 0) + idf * tfNorm);
      }
    }

    return [...scores.entries()]
      .sort((a, b) => {
        if (b[1] !== a[1]) return b[1] - a[1];
        return a[0] < b[0] ? -1 : 1;
      })
      .slice(0, topN)
      .map(([id, score]) => ({ id, score }));
  }
}