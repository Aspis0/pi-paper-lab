// src/source-finders/europepmc.ts
// Europe PMC API client for biomedical topic search + metadata.
// Docs: https://europepmc.org/RestfulWebService
// Endpoint: https://www.ebi.ac.uk/europepmc/webservices/rest/search
//
// Europe PMC is the best biomedical-native source: real abstracts, MeSH
// terms, full-text URLs, and PubMed/PMC linking. No API key required.
// We always measure the response once for the LLM to use MeSH terms
// as a high-signal disambiguation aid (biomedical jargon is too dense
// for title-only matching).

import { computeConfidence } from "./confidence.ts";
import type { Finding } from "./openalex.ts";

export interface SearchOpts {
  num?: number;
  signal?: AbortSignal;
}

const EPMC_ENDPOINT = "https://www.ebi.ac.uk/europepmc/webservices/rest/search";

interface EpmcMeshHeading {
  descriptorName?: string;
  qualifiers?: string[];
}

interface EpmcFullTextUrl {
  url?: string;
  documentStyle?: string;
  availability?: string;
  availabilityCode?: string;
}

interface EpmcAuthor {
  fullName?: string;
  firstName?: string;
  lastName?: string;
  affiliation?: string;
}

interface EpmcResult {
  id?: string;
  source?: string;
  pmid?: string;
  pmcid?: string;
  doi?: string;
  title?: string;
  authorString?: string;
  authors?: EpmcAuthor[];
  journalTitle?: string;
  journalVolume?: string;
  journalIssue?: string;
  pageInfo?: string;
  pubYear?: string;
  abstractText?: string;
  citedByCount?: number;
  isOpenAccess?: string; // "Y" / "N"
  inEPMC?: string;
  inPMC?: string;
  hasPDF?: string;
  hasBook?: string;
  hasSuppl?: string;
  meshHeadingList?: { meshHeading?: EpmcMeshHeading[] };
  fullTextUrlList?: { fullTextUrl?: EpmcFullTextUrl[] };
}

interface EpmcResponse {
  version?: string;
  hitCount?: number;
  resultList?: { result?: EpmcResult[] };
}

export async function searchEuropePmc(
  query: string,
  opts?: SearchOpts,
): Promise<Finding[]> {
  const num = Math.min(opts?.num ?? 5, 50);
  const url = new URL(EPMC_ENDPOINT);
  url.searchParams.set("query", query);
  url.searchParams.set("format", "json");
  url.searchParams.set("pageSize", String(num));
  const res = await fetch(url, {
    headers: { "User-Agent": "pi-paper-lab/0.7 (mailto:pi-paper-lab@example.com)" },
    signal: opts?.signal,
  });
  if (!res.ok) {
    throw new Error(`Europe PMC API error: ${res.status} ${res.statusText}`);
  }
  const data = (await res.json()) as EpmcResponse;
  return (data.resultList?.result ?? []).map(normaliseResult);
}

function normaliseResult(r: EpmcResult): Finding {
  const title = r.title?.trim() || "(untitled)";
  const doi = r.doi || undefined;
  const abstract = r.abstractText?.trim() || undefined;
  const year = r.pubYear ? parseInt(r.pubYear, 10) : undefined;
  const meshTerms = (r.meshHeadingList?.meshHeading ?? [])
    .map((m) => m.descriptorName)
    .filter((s): s is string => typeof s === "string");
  const fullTextUrl = r.fullTextUrlList?.fullTextUrl?.find((u) => u.url)?.url;
  const authors = parseAuthors(r.authorString, r.authors);
  const pages = r.pageInfo || undefined;
  const isOpenAccess = r.isOpenAccess === "Y";
  return {
    doi,
    title,
    authors,
    year,
    venue: r.journalTitle || undefined,
    volume: r.journalVolume || undefined,
    issue: r.journalIssue || undefined,
    pages,
    abstract,
    meshTerms: meshTerms.length > 0 ? meshTerms : undefined,
    citedByCount: r.citedByCount ?? undefined,
    isOpenAccess,
    oaUrl: fullTextUrl,
    source: "europepmc",
    confidence: computeConfidence({
      title,
      doi,
      abstract,
      meshTerms: meshTerms.length > 0 ? meshTerms : undefined,
      tldr: undefined,
    }),
    pmid: r.pmid || undefined,
    pmcid: r.pmcid || undefined,
  };
}

/**
 * Parse authors. Europe PMC provides either:
 *   - authorString: "Doe J, Smith A, Brown C" (comma-separated, no full
 *     Given/Family separation), or
 *   - authors: [{ fullName, firstName, lastName, affiliation }] (full
 *     structure but the per-author breakdown is rare in lite JSON).
 * We prefer the structured `authors` array when present and fall back to
 * splitting the string at the comma.
 */
function parseAuthors(
  authorString: string | undefined,
  authors: EpmcAuthor[] | undefined,
): Finding["authors"] {
  if (Array.isArray(authors) && authors.length > 0) {
    return authors
      .map((a) => {
        if (a.lastName) {
          return { family: a.lastName, given: a.firstName };
        }
        const full = a.fullName ?? "";
        const [family, given] = full.split(/\s+/, 2);
        return { family: family || "?", given };
      })
      .filter((a) => a.family);
  }
  if (!authorString) return [];
  return authorString
    .split(/,\s*/)
    .map((s) => {
      const trimmed = s.trim();
      if (!trimmed) return null;
      const parts = trimmed.split(/\s+/);
      const family = parts[0] ?? trimmed;
      const given = parts.length > 1 ? parts.slice(1).join(" ") : undefined;
      return { family, given };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);
}
