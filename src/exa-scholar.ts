// src/exa-scholar.ts
// Exa.ai API client. Returns ExaSearchResult format.
// Used as an alternative backend to Serper.dev Scholar for find_citation.

import { getExaKey } from "./config.ts";

export interface ExaSearchResult {
  id: string;
  url: string;
  title: string;
  author?: string;
  publishedDate?: string;  // ISO 8601
  text?: string;           // full text (if requested)
  highlights?: string[];   // token-efficient extracts
  score?: number;          // Exa relevance score
}

const EXA_ENDPOINT = "https://api.exa.ai/search";

export async function searchExa(
  query: string,
  opts?: { num?: number; signal?: AbortSignal; fullText?: boolean }
): Promise<ExaSearchResult[]> {
  const apiKey = process.env.EXA_API_KEY ?? getExaKey();
  if (!apiKey) {
    throw new Error("EXA_API_KEY not set. Run /paper-lab to configure it interactively.");
  }

  const num = opts?.num ?? 10;
  const body = {
    query,
    type: "auto",
    category: "publication",
    numResults: num,
    contents: {
      // Exa expects an OBJECT, not a boolean. Default: 3 sentences per result, query-aware.
      highlights: { numSentences: 3, highlightsPerUrl: 1, query },
      text: opts?.fullText ?? false,
    },
  };

  const res = await fetch(EXA_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
      "User-Agent": "pi-paper-lab/0.6",
    },
    body: JSON.stringify(body),
    signal: opts?.signal,
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Exa search failed (${res.status}): ${err.slice(0, 200)}`);
  }

  const data = await res.json();
  return (data.results ?? []).map((r: any) => ({
    id: r.id,
    url: r.url,
    title: r.title,
    author: r.author,
    publishedDate: r.publishedDate,
    text: r.text,
    highlights: r.highlights,
    score: r.score,
  }));
}
