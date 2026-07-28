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
  authorList?: { author?: EpmcAuthor[] };
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
  const num = clampNum(opts?.num ?? 5);
  const url = new URL(EPMC_ENDPOINT);
  url.searchParams.set("query", query);
  url.searchParams.set("format", "json");
  url.searchParams.set("pageSize", String(num));
  // M1.2 audit HIGH-1: by default Europe PMC returns the 'lite' resultType,
  // which omits the biomedical fields that motivate this backend
  // (abstract, MeSH, full-text URLs). Asking for 'core' explicitly.
  url.searchParams.set("resultType", "core");
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

/**
 * Normalise the user-supplied `num` to a finite integer in [1, 50].
 * M1.2 audit LOW-2: previously negative, fractional, or NaN values were
 * serialised to `pageSize` verbatim and sent to the server.
 */
function clampNum(input: number): number {
  if (!Number.isFinite(input)) return 5;
  return Math.min(Math.max(Math.trunc(input), 1), 50);
}

function normaliseResult(r: EpmcResult): Finding {
  const title = r.title?.trim() || "(untitled)";
  const doi = r.doi?.trim() || undefined;
  const abstract = r.abstractText?.trim() || undefined;
  const year = parseYear(r.pubYear);
  const meshTerms = (r.meshHeadingList?.meshHeading ?? [])
    .map((m) => m.descriptorName)
    .filter((s): s is string => typeof s === "string");
  // M1.2 audit LOW-1: prefer the first AVAILABLE full-text URL over the
  // first URL on the list (which may be marked unavailable).
  const fullTextUrl = (r.fullTextUrlList?.fullTextUrl ?? [])
    .find((u) => u.url && (u.availability === "Y" || u.availabilityCode === "F"))?.url
    ?? r.fullTextUrlList?.fullTextUrl?.find((u) => u.url)?.url;
  const authors = parseAuthors(r.authorString, r.authorList?.author);
  const pages = r.pageInfo?.trim() || undefined;
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
 * Parse the publication year. M1.2 audit MED-2: Europe PMC returns
 * `pubYear` as a string that can be "2024", "2024-01-15", or "in press".
 * We accept the four-digit year component of any string that starts with
 * one; otherwise we return undefined (and never emit NaN).
 */
function parseYear(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const m = raw.match(/^\d{4}/);
  if (!m) return undefined;
  return parseInt(m[0], 10);
}

/**
 * Parse authors. Europe PMC provides either:
 *   - authorList.author: [{ fullName, firstName, lastName, initials,
 *     authorAffiliationDetailsList }] (THE CORE format; preferred).
 *   - authorString: "Doe J, Smith A, Brown C" (literal comma-separated
 *     string; used as fallback because Europe PMC also exposes it).
 * The core format is the reliable source — the authorString is a
 * pre-flattened secondary representation. We prefer the structured array
 * and fall back to splitting the string at commas ONLY when the
 * structured array is missing.
 *
 * M1.2 audit MED-1: when only `fullName` is available (no firstName/lastName)
 * we do NOT try to split it. The international name-order rules are
 * ambiguous across cultures (Eastern vs Western order, particles like
 * "van", "de", "di"), and a wrong split is worse than no split. Instead
 * the entire fullName goes into `family` and `given` is left undefined.
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
        if (a.fullName) {
          // Conservatively: whole name in family, no split.
          return { family: a.fullName, given: undefined };
        }
        return null;
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);
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
