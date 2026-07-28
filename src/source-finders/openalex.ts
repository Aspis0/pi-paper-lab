// src/source-finders/openalex.ts
// OpenAlex API client for topic search + metadata.
// Docs: https://api.openalex.org/works?search=…
// Polite pool: requires `mailto` query param for the "polite" tier (faster
// rate limits, recommended). We always include the mailto so this works
// for production users without them having to configure anything.
//
// Returns a normalised `Finding` type (see below). Abstracts are
// reconstructed from `abstract_inverted_index` (word → positions map) into
// a single plaintext string, which is the main reason we picked OpenAlex
// over the existing Serper/Exa backends for the LLM prompt content.

/**
 * A normalised bibliographic finding returned by any of the source-finder
 * backends. The richer fields here (abstract, meshTerms, concepts, tldr)
 * are what the LLM uses to verify a citation actually supports a claim;
 * without them the AI is forced to guess from title alone.
 */
export interface Finding {
  doi?: string;
  title: string;
  authors: { family: string; given?: string; orcid?: string }[];
  year?: number;
  venue?: string;
  volume?: string;
  issue?: string;
  pages?: string;
  abstract?: string;
  meshTerms?: string[];   // biomedical signal (Europe PMC)
  concepts?: string[];     // OpenAlex topic score
  tldr?: string;           // Semantic Scholar one-line summary
  citedByCount?: number;
  isOpenAccess?: boolean;
  oaUrl?: string;
  source: "openalex" | "europepmc" | "crossref" | "serper" | "exa" | "s2";
  confidence: "high" | "medium" | "low";
  // Backend-specific metadata that may be useful for the LLM prompt.
  openAlexId?: string;     // e.g. "https://openalex.org/W123"
  pmid?: string;           // PubMed ID (Europe PMC)
  pmcid?: string;          // PubMed Central ID (Europe PMC)
}

export interface SearchOpts {
  num?: number;
  signal?: AbortSignal;
}

const OPENALEX_ENDPOINT = "https://api.openalex.org/works";
const POLITE_MAILTO = "pi-paper-lab@example.com";

interface OpenAlexAuthor {
  author?: { id?: string; display_name?: string; orcid?: string };
}

interface OpenAlexWork {
  id?: string;
  doi?: string | null;
  title?: string | null;
  authorships?: OpenAlexAuthor[];
  publication_year?: number | null;
  "primary_location"?: {
    source?: { display_name?: string | null } | null;
  } | null;
  "best_oa_location"?: { pdf_url?: string | null } | null;
  open_access?: { is_oa?: boolean; oa_url?: string | null } | null;
  cited_by_count?: number | null;
  concepts?: { display_name?: string; score?: number }[];
  abstract_inverted_index?: Record<string, number[]> | null;
  biblio?: {
    volume?: string | null;
    issue?: string | null;
    first_page?: string | null;
    last_page?: string | null;
  } | null;
}

interface OpenAlexResponse {
  meta?: { count?: number; per_page?: number };
  results?: OpenAlexWork[];
}

export async function searchOpenAlex(
  query: string,
  opts?: SearchOpts,
): Promise<Finding[]> {
  const num = Math.min(opts?.num ?? 5, 50);
  const url = new URL(OPENALEX_ENDPOINT);
  url.searchParams.set("search", query);
  url.searchParams.set("per_page", String(num));
  url.searchParams.set("mailto", POLITE_MAILTO);
  const res = await fetch(url, {
    headers: { "User-Agent": "pi-paper-lab/0.7 (mailto:pi-paper-lab@example.com)" },
    signal: opts?.signal,
  });
  if (!res.ok) {
    throw new Error(`OpenAlex API error: ${res.status} ${res.statusText}`);
  }
  const data = (await res.json()) as OpenAlexResponse;
  return (data.results ?? []).map(normaliseWork);
}

/**
 * Reconstruct plaintext from OpenAlex's `abstract_inverted_index` format:
 * `{ "word": [positions...] }`. This is OpenAlex's way of being copyright-
 * safe (full abstract isn't redistributed, but the index lets us rebuild
 * the abstract locally). The reconstruction is lossy for very long
 * abstracts if words are out of index range, but the resulting string is
 * good enough for the LLM to verify a citation supports a claim.
 */
export function reconstructAbstract(invertedIndex: Record<string, number[]>): string {
  const positions: { word: string; pos: number }[] = [];
  for (const [word, posArray] of Object.entries(invertedIndex)) {
    if (!Array.isArray(posArray)) continue;
    for (const p of posArray) {
      if (typeof p === "number") positions.push({ word, pos: p });
    }
  }
  positions.sort((a, b) => a.pos - b.pos);
  const tokens: string[] = [];
  for (const { word, pos } of positions) {
    tokens[pos] = word;
  }
  // Strip undefined holes (rare, but the API can have gaps).
  return tokens.filter(Boolean).join(" ");
}

function normaliseWork(w: OpenAlexWork): Finding {
  const doi = w.doi?.replace(/^https?:\/\/doi\.org\//i, "") ?? undefined;
  const title = w.title ?? "(untitled)";
  const authors: Finding["authors"] = (w.authorships ?? [])
    .map((a) => {
      const name = a.author?.display_name ?? "";
      // Heuristic split on "Family, Given" → "Family Given"
      // OpenAlex normally returns "Family Name" already; if it has a
      // comma (e.g. institution), treat the whole as family.
      const [family, given] = name.includes(",")
        ? name.split(",").map((s) => s.trim())
        : [name, undefined];
      return { family: family ?? "?", given, orcid: a.author?.orcid };
    });
  const venue = w.primary_location?.source?.display_name ?? undefined;
  const oaUrl = w.open_access?.oa_url ?? w.best_oa_location?.pdf_url ?? undefined;
  const concepts = (w.concepts ?? [])
    .filter((c) => typeof c.score === "number" && c.score >= 0.4)
    .map((c) => c.display_name)
    .filter((s): s is string => typeof s === "string");
  const abstract = w.abstract_inverted_index
    ? reconstructAbstract(w.abstract_inverted_index)
    : undefined;
  const pages = w.biblio
    ? [w.biblio.first_page, w.biblio.last_page].filter(Boolean).join("-") || undefined
    : undefined;
  return {
    doi,
    title,
    authors,
    year: w.publication_year ?? undefined,
    venue,
    volume: w.biblio?.volume ?? undefined,
    issue: w.biblio?.issue ?? undefined,
    pages,
    abstract,
    concepts,
    citedByCount: w.cited_by_count ?? undefined,
    isOpenAccess: w.open_access?.is_oa ?? undefined,
    oaUrl,
    source: "openalex",
    // OpenAlex matches are full-text; confidence is high when both title AND
    // an abstract are present, medium otherwise.
    confidence: abstract ? "high" : "medium",
    openAlexId: w.id,
  };
}
