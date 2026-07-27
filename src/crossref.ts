// src/crossref.ts
// CrossRef REST API client for DOI metadata lookup.
// Docs: GET https://api.crossref.org/works/{doi}
// Returns canonical metadata: title, authors, year, journal, ISSN, URL.

export interface CrossRefAuthor {
  given?: string;
  family?: string;
  name?: string; // for organizations
}

export interface CrossRefWork {
  doi: string;
  title: string[];
  author: CrossRefAuthor[];
  published?: { dateParts: number[] };
  publishedPrint?: { dateParts: number[] };
  publishedOnline?: { dateParts: number[] };
  containerTitle: string[]; // journal name
  volume?: string;
  issue?: string;
  page?: string;
  issn?: string[];
  url?: string;
  abstract?: string;
  publisher?: string;
  type?: string;
}

export interface CrossRefResponse {
  status: string;
  message: CrossRefWork;
}

export async function lookupDoi(
  doi: string,
  opts?: { signal?: AbortSignal },
): Promise<CrossRefWork | null> {
  const cleanDoi = doi.replace(/^https?:\/\/doi\.org\//i, "").trim();
  const url = `https://api.crossref.org/works/${encodeURIComponent(cleanDoi)}`;
  const res = await fetch(url, {
    headers: {
      "User-Agent": "pi-paper-lab/0.4 (mailto:paper-lab@example.com)",
    },
    signal: opts?.signal,
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`CrossRef API error: ${res.status} ${res.statusText}`);
  }
  const data = (await res.json()) as CrossRefResponse;
  return normalizeWork(data.message);
}

// CrossRef API returns kebab-case keys (date-parts, container-title, published-print, published-online).
// Normalize to camelCase so the TypeScript interface and consuming code work correctly.
function normalizeWork(raw: any): CrossRefWork {
  if (!raw) return raw;
  return {
    doi: raw.doi,
    title: raw.title ?? [],
    author: raw.author ?? [],
    published: normalizeDateParts(raw.published),
    publishedPrint: normalizeDateParts(raw["published-print"]),
    publishedOnline: normalizeDateParts(raw["published-online"]),
    containerTitle: raw["container-title"] ?? raw.containerTitle ?? [],
    volume: raw.volume,
    issue: raw.issue,
    page: raw.page,
    issn: raw.issn,
    url: raw.url,
    abstract: raw.abstract,
    publisher: raw.publisher,
    type: raw.type,
  };
}

function normalizeDateParts(raw: any): { dateParts: number[] } | undefined {
  if (!raw) return undefined;
  // CrossRef returns { "date-parts": [[2024, 4, 30]] } — array of arrays
  const dp = raw["date-parts"] ?? raw.dateParts;
  if (!dp || !Array.isArray(dp)) return undefined;
  const first = Array.isArray(dp[0]) ? dp[0] : dp;
  return { dateParts: first.filter((n: any) => typeof n === "number") };
}

export function formatCrossRefWork(work: CrossRefWork, doi: string): string {
  const title = work.title?.[0] ?? "(untitled)";
  const authors = work.author
    .map((a) => {
      if (a.family) return a.given ? `${a.given} ${a.family}` : a.family;
      return a.name ?? "?";
    })
    .join(", ");
  const year =
    work.published?.dateParts?.[0] ??
    work.publishedPrint?.dateParts?.[0] ??
    work.publishedOnline?.dateParts?.[0] ??
    "?";
  const journal = work.containerTitle?.[0] ?? "";
  const vol = work.volume ?? "";
  const issue = work.issue ?? "";
  const pages = work.page ?? "";
  return `${authors} (${year}). ${title}. ${journal}${vol ? `, ${vol}` : ""}${issue ? `(${issue})` : ""}${pages ? `:${pages}` : ""}. doi:${doi}`;
}

// Vancouver-style citation (for bibliography)
export function formatVancouver(work: CrossRefWork, doi: string): string {
  const title = work.title?.[0] ?? "(untitled)";
  const authors = work.author
    .map((a) => {
      if (a.family) return `${a.family} ${a.given ?? ""}`.trim();
      return a.name ?? "?";
    })
    .join(", ");
  const year =
    work.published?.dateParts?.[0] ??
    work.publishedPrint?.dateParts?.[0] ??
    work.publishedOnline?.dateParts?.[0] ??
    "?";
  const journal = work.containerTitle?.[0] ?? "";
  const vol = work.volume ?? "";
  const issue = work.issue ?? "";
  const pages = work.page ?? "";
  return `${authors}. ${title}. ${journal}. ${year}${vol ? `;${vol}` : ""}${issue ? `(${issue})` : ""}${pages ? `:${pages}` : ""}. doi:${doi}`;
}
