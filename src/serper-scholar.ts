// src/serper-scholar.ts
// Serper.dev Scholar API client.
// Docs: POST https://google.serper.dev/scholar with X-API-KEY header.
// Returns { organic: [{ title, authors, year, venue, citations, link, snippet }] }

export interface ScholarResult {
  title: string;
  authors: string[] | string;
  year?: number;
  venue?: string;
  citations?: number;
  link?: string;
  snippet?: string;
}

export interface ScholarResponse {
  organic: ScholarResult[];
  searchParameters?: { q: string; };
}

import { getSerperKey } from "./config.ts";

export async function searchScholar(
  query: string,
  opts?: { num?: number; signal?: AbortSignal },
): Promise<ScholarResult[]> {
  let apiKey = process.env.SERPER_API_KEY;
  if (!apiKey) apiKey = getSerperKey();
  if (!apiKey) {
    throw new Error(
      "SERPER_API_KEY not set. Run /paper-lab to configure it interactively.",
    );
  }
  const num = Math.min(opts?.num ?? 5, 20);
  const res = await fetch("https://google.serper.dev/scholar", {
    method: "POST",
    headers: {
      "X-API-KEY": apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ q: query, num }),
    signal: opts?.signal,
  });
  if (!res.ok) {
    throw new Error(`Serper Scholar API error: ${res.status} ${res.statusText}`);
  }
  const data = (await res.json()) as ScholarResponse;
  return data.organic ?? [];
}

export function formatScholarResults(results: ScholarResult[]): string {
  if (results.length === 0) return "No Scholar results.";
  const lines: string[] = [];
  results.forEach((r, i) => {
    const authors = Array.isArray(r.authors) ? r.authors.join(", ") : (r.authors ?? "");
    lines.push(`[${i + 1}] ${r.title ?? "(untitled)"}`);
    if (authors) lines.push(`    Authors: ${authors}`);
    if (r.year) lines.push(`    Year: ${r.year}`);
    if (r.venue) lines.push(`    Venue: ${r.venue}`);
    if (r.citations !== undefined) lines.push(`    Citations: ${r.citations}`);
    if (r.link) lines.push(`    Link: ${r.link}`);
    if (r.snippet) lines.push(`    Snippet: ${r.snippet.slice(0, 200)}`);
    lines.push("");
  });
  return lines.join("\n");
}
