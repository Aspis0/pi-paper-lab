// src/citations.ts
// Citation orchestrator: mark claims, resolve [CITE:topic] → [1][2][3],
// generate Vancouver-style bibliography.

import { searchScholar, formatScholarResults, type ScholarResult } from "./serper-scholar.ts";
import { searchExa, type ExaSearchResult } from "./exa-scholar.ts";
import { getCitationBackend, getSerperKey } from "./config.ts";
import { lookupDoi, normalizeWork, type CrossRefWork } from "./crossref.ts";
import { crossrefToCsl, stripJats } from "./csl/adapters/crossrefToCsl.ts";
import { formatBibliography as formatCslBibliography } from "./csl/formatBibliography.ts";

/** Max abstract chars shown in find_citation / formatResolveResult candidates. */
const CANDIDATE_ABSTRACT_CAP = 1200;

/** Bounds for find_citation / resolveCitation `numResults` (abstracts multiply cost). */
export const CITATION_NUM_RESULTS_MIN = 1;
export const CITATION_NUM_RESULTS_MAX = 10;
export const CITATION_NUM_RESULTS_DEFAULT = 5;

/**
 * Clamp per-source result count to [1, 10]. Non-finite / non-number → default 5.
 * Used by find_citation and resolveCitation so unbounded inputs cannot explode
 * Crossref/Serper/Exa fan-out once abstracts are returned.
 */
export function clampCitationNumResults(n: unknown): number {
  if (typeof n !== "number" || !Number.isFinite(n)) return CITATION_NUM_RESULTS_DEFAULT;
  return Math.min(
    CITATION_NUM_RESULTS_MAX,
    Math.max(CITATION_NUM_RESULTS_MIN, Math.trunc(n)),
  );
}

// === [CITE:topic] marker ===
// A claim that needs a source is marked with [CITE:topic_description].
export const CITE_MARKER = /\[CITE:([^\]]+)\]/g;

// === [N] citation reference ===
export const CITE_NUM = /\[(\d+)\]/g;

// === [N](doi:...) inline DOI marker ===
// When the LLM assigns a citation, it writes `[1](doi:10.xxxx)` in the Markdown.
// For DOIs containing special chars (like old Elsevier DOIs with parentheses),
// use angle brackets: `[1](<doi:10.1016/s0896-6273(00)80701-1>)`
export const CITE_WITH_DOI = /\[(\d+)\]\((?:doi:([^)>\s]+)|<doi:([^>]+)>)\)/g;

// === Heuristic: mark claims in draft text ===
// We use simple regex heuristics to identify sentences that make factual claims
// and tag them with [CITE:topic]. This is NOT a replacement for LLM-based marking;
// it's a first pass that the LLM can refine.

export function markClaims(text: string): { text: string; markedCount: number } {
  // Split into sentences (rough heuristic).
  const sentences = text.split(/(?<=[.!?])\s+/);
  let markedCount = 0;
  const out: string[] = [];

  for (const sentence of sentences) {
    let marked = sentence;
    const lower = sentence.toLowerCase();

    // Heuristic 1: statistical claim (n=, p<, %, etc.)
    if (/\bn\s*=\s*\d|p\s*[<=]\s*0\.|\d+\s*%|\b\d+\s+(?:of|out\s+of)\s+\d+/i.test(sentence)) {
      const topic = extractTopic(sentence, "statistical finding");
      marked = `${sentence.replace(/[.!?]+$/, "")} [CITE:${topic}].`;
      markedCount++;
    }
    // Heuristic 2: gene/protein function claim
    else if (/\b(regulates?|controls?|determines?|drives?|is\s+required\s+for|is\s+essential\s+for)\b/i.test(sentence)) {
      const topic = extractTopic(sentence, "gene function");
      marked = `${sentence.replace(/[.!?]+$/, "")} [CITE:${topic}].`;
      markedCount++;
    }
    // Heuristic 3: prior work reference (extended for non-genetics papers)
    else if (/\b(previously|previous\s+\w*\s*studies?|prior\s+studies?|earlier\s+work|has\s+been\s+shown|known\s+to|it\s+is\s+well\s+established|demonstrated\s+that|shown\s+that|reported\s+that)\b/i.test(sentence)) {
      const topic = extractTopic(sentence, "prior work");
      marked = `${sentence.replace(/[.!?]+$/, "")} [CITE:${topic}].`;
      markedCount++;
    }
    // Heuristic 5: definitions ("X is a Y disease/syndrome/disorder")
    else if (/\b(is\s+a\s+\w+\s+(disease|syndrome|disorder|condition|process|pathway|mechanism|response|phenotype))\b/i.test(sentence)) {
      const topic = extractTopic(sentence, "definition");
      marked = `${sentence.replace(/[.!?]+$/, "")} [CITE:${topic}].`;
      markedCount++;
    }
    // Heuristic 6: micro-CT / imaging technique keywords (cachexia/micro-CT papers)
    else if (/\b(micro-?CT|micro-?computed\s+tomography|three-?dimensional\s+imaging|3D\s+imaging|microscopy|histology|staining|immunofluorescence|confocal)\b/i.test(sentence)) {
      const trimmed = lower.trim();
      const isHeader = /^#{1,6}\s/.test(trimmed) || /^(methods|results|discussion|introduction|references|abstract)/i.test(trimmed);
      if (!isHeader) {
        const topic = extractTopic(sentence, "technique");
        marked = `${sentence.replace(/[.!?]+$/, "")} [CITE:${topic}].`;
        markedCount++;
      }
    }
    // Heuristic 4: method/technique claim
    else if (/\b(MARCM|GAL4|UAS|CRISPR|Cas9|FLP|FRT|RNAi|knockout|knock-in|mutant|transgene)\b/i.test(sentence)) {
      // Only mark if it's a claim, not a methods description or any header level
      const trimmed = lower.trim();
      const isHeader = /^#{1,6}\s/.test(trimmed) || /^(methods|results|discussion|introduction|references|abstract)/i.test(trimmed);
      if (!isHeader) {
        const topic = extractTopic(sentence, "technique");
        marked = `${sentence.replace(/[.!?]+$/, "")} [CITE:${topic}].`;
        markedCount++;
      }
    }

    out.push(marked);
  }

  return { text: out.join(" "), markedCount };
}

function extractTopic(sentence: string, fallback: string): string {
  // Try to extract the key noun phrase from the sentence (first 3-5 words).
  const words = sentence.trim().split(/\s+/).slice(0, 5).join(" ");
  // Remove leading articles
  const cleaned = words.replace(/^(the|a|an|we|our|these|this)\s+/i, "");
  // Slugify
  const slug = cleaned
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .trim()
    .replace(/\s+/g, "_")
    .slice(0, 40);
  return slug || fallback;
}

// === Resolve [CITE:topic] → candidates ===

export interface CitationCandidate {
  topic: string;
  scholarResults: ScholarResult[];
  crossRefWorks: CrossRefWork[];
}

export interface ResolveResult {
  topic: string;
  candidates: Array<{
    title: string;
    authors: string;
    year: number | string;
    venue?: string;
    doi?: string;
    link?: string;
    source: "scholar" | "crossref" | "exa";
    snippet?: string;
    /** Plain-text abstract (JATS-stripped). Present for Crossref when available. */
    abstract?: string;
    citations?: number;
  }>;
  // Search-backend failures (e.g. missing key, network error, HTTP error).
  // Kept OUT of `candidates` — a failed search must never be presented as a
  // found source (that was the root cause of citations showing a fake
  // "(Serper Scholar search failed: …)" entry as if it were a reference).
  warnings: string[];
}

export async function resolveCitation(
  topic: string,
  opts?: { signal?: AbortSignal; numResults?: number },
): Promise<ResolveResult> {
  const num = clampCitationNumResults(opts?.numResults);
  const candidates: ResolveResult["candidates"] = [];
  const warnings: string[] = [];
  const backend = getCitationBackend();
  const hasSerperKey = !!getSerperKey();

  // Helper: run Serper, push results
  const runSerper = () => searchScholar(topic, { num, signal: opts?.signal }).then(r => {
    for (const s of r) {
      const authors = Array.isArray(s.authors) ? s.authors.join(", ") : (s.authors ?? "");
      candidates.push({
        title: s.title ?? "(untitled)",
        authors,
        year: s.year ?? "?",
        venue: s.venue,
        link: s.link,
        source: "scholar",
        snippet: s.snippet,
        citations: s.citations,
      });
    }
  }).catch(err => {
    // N.B. do NOT push this into `candidates` — a failed search is not a
    // source. See the `warnings` field on ResolveResult.
    warnings.push(`Serper Scholar search failed: ${String(err).slice(0, 200)}`);
  });

  // Helper: run Exa, push results. Returns true if any results added.
  const runExa = async (): Promise<number> => {
    try {
      const exaResults = await searchExa(topic, { num, signal: opts?.signal });
      for (const r of exaResults) {
        const year = r.publishedDate ? new Date(r.publishedDate).getFullYear() : undefined;
        candidates.push({
          title: r.title ?? "(untitled)",
          authors: r.author ?? "",
          year: year ?? "?",
          venue: undefined,
          link: r.url,
          source: "exa",
          snippet: r.highlights?.[0],
        });
      }
      return exaResults.length;
    } catch (err) {
      // Same rule as Serper: failures are warnings, never fake candidates.
      warnings.push(`Exa search failed: ${String(err).slice(0, 200)}`);
      return 0;
    }
  };

  // 1. Backend-specific search
  if (backend === "serper") {
    await runSerper();
  } else if (backend === "exa") {
    await runExa();
  } else if (backend === "both") {
    // Parallel query
    await Promise.allSettled([runSerper(), runExa()]);
  } else if (backend === "auto") {
    // Prefer Exa: REST when key present, else free unauthenticated MCP
    // (https://mcp.exa.ai/mcp — rate-limited). Then Serper if keyed; CrossRef always.
    const exaCount = await runExa();
    if (exaCount === 0 && hasSerperKey) {
      await runSerper();
    }
    // CrossRef below still fills DOIs even with zero paid keys.
  }
  // backend === "crossref": intentionally no Scholar/Exa call here — the
  // CrossRef lookup below always runs, which is exactly "CrossRef only".

  // CrossRef search by topic (always runs, for DOI + Vancouver citation)
  // 2. CrossRef search by topic (smart query — filter to journal articles only)
  try {
    const crossRes = await fetch(
      `https://api.crossref.org/works?query.bibliographic=${encodeURIComponent(topic)}&rows=${num}&filter=type:journal-article`,
      { signal: opts?.signal },
    );
    if (crossRes.ok) {
      const crossData = await crossRes.json() as { message?: { items?: any[] } };
      for (const rawW of crossData.message?.items ?? []) {
        // Shared normalizer — same shape as lookupDoi (DOI casing, published/issued).
        const w = normalizeWork(rawW);
        if (!w.doi) continue;
        const authors = w.author
          .map((a) => (a.family ? `${a.given ?? ""} ${a.family}`.trim() : a.name ?? "?"))
          .join(", ");
        const year =
          w.published?.dateParts?.[0] ??
          w.publishedPrint?.dateParts?.[0] ??
          w.publishedOnline?.dateParts?.[0] ??
          "?";
        const abstract = stripJats(w.abstract);
        candidates.push({
          title: w.title?.[0] ?? "(untitled)",
          authors,
          year,
          venue: w.containerTitle?.[0],
          doi: w.doi,
          source: "crossref",
          ...(abstract ? { abstract: abstract.slice(0, CANDIDATE_ABSTRACT_CAP) } : {}),
        });
      }
    }
  } catch {
    // CrossRef is optional
  }

  return { topic, candidates: dedupeCandidates(candidates), warnings };
}

// N3 fix: deduplicate candidates by DOI (keep first occurrence)
function dedupeCandidates(candidates: ResolveResult["candidates"]): ResolveResult["candidates"] {
  const seenDois = new Set<string>();
  const seenTitles = new Set<string>();
  return candidates.filter((c) => {
    // Dedupe by DOI if present
    if (c.doi) {
      if (seenDois.has(c.doi)) return false;
      seenDois.add(c.doi);
      return true;
    }
    // Dedupe by title (normalized) for non-DOI candidates
    const titleKey = c.title.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 60);
    if (seenTitles.has(titleKey)) return false;
    seenTitles.add(titleKey);
    return true;
  });
}

export function formatResolveResult(r: ResolveResult): string {
  const lines: string[] = [];
  lines.push(`=== [CITE:${r.topic}] — candidates ===`);
  if (r.warnings.length > 0) {
    lines.push("  Warnings (search backend failures — do NOT treat as a source):");
    for (const w of r.warnings) lines.push(`    - ${w}`);
  }
  if (r.candidates.length === 0) {
    lines.push(
      r.warnings.length > 0
        ? "  No candidates found (search backend(s) failed — see warnings above)."
        : "  No candidates found.",
    );
    return lines.join("\n");
  }
  r.candidates.forEach((c, i) => {
    lines.push(`  [${i + 1}] ${c.title}`);
    if (c.authors) lines.push(`      Authors: ${c.authors}`);
    if (c.year) lines.push(`      Year: ${c.year}`);
    if (c.venue) lines.push(`      Venue: ${c.venue}`);
    if (c.doi) lines.push(`      DOI: ${c.doi}`);
    if (c.link) lines.push(`      Link: ${c.link}`);
    if (c.citations !== undefined) lines.push(`      Citations: ${c.citations}`);
    // Prefer Abstract when present (Crossref); otherwise keep Snippet (Serper/Exa).
    if (c.abstract) {
      // Collapse interior whitespace so multi-<jats:p> abstracts stay one
      // `Key: value` line (newlines would break indentation / Source: position).
      // Cap at CANDIDATE_ABSTRACT_CAP (1200) and append "…" when truncated.
      const collapsed = c.abstract.replace(/\s+/g, " ").trim();
      const truncated = collapsed.length > CANDIDATE_ABSTRACT_CAP;
      const text = truncated
        ? `${collapsed.slice(0, CANDIDATE_ABSTRACT_CAP)}…`
        : collapsed;
      lines.push(`      Abstract: ${text}`);
    } else if (c.snippet) {
      lines.push(`      Snippet: ${c.snippet.slice(0, 150)}`);
    }
    lines.push(`      Source: ${c.source}`);
    lines.push("");
  });
  lines.push("Assign a number from the draft by replacing [CITE:topic] with [N].");
  lines.push("Then run /cite-verify to check each citation.");
  return lines.join("\n");
}

// === Generate bibliography from resolved draft ===
// The draft must contain inline DOI markers: [N](doi:10.xxxx)
// The LLM writes these when assigning citations from /cite-resolve candidates.

export interface BibliographyEntry {
  number: number;
  citation: string; // Vancouver format
  doi?: string;
}

export async function generateBibliography(
  draftText: string,
  _resolvedCitations: Map<string, ResolveResult>,
): Promise<{ bibliography: BibliographyEntry[]; unresolved: string[] }> {
  const bibliography: BibliographyEntry[] = [];
  const unresolved: string[] = [];

  // Find all [N](doi:...) markers in order of appearance
  const doiMarkers: Array<{ num: number; doi: string }> = [];
  let m: RegExpExecArray | null;
  const doiRe = CITE_WITH_DOI;
  while ((m = doiRe.exec(draftText)) !== null) {
    // group 2 = plain DOI, group 3 = angle-bracket DOI
    const doi = m[2] ?? m[3];
    if (doi) doiMarkers.push({ num: Number(m[1]), doi });
  }

  // Also find bare [N] markers (without DOI) — these need manual resolution
  const bareNumRe = /\[(\d+)\](?!\()/g;
  const bareNums: number[] = [];
  while ((m = bareNumRe.exec(draftText)) !== null) {
    const num = Number(m[1]);
    if (!doiMarkers.some((d) => d.num === num)) {
      bareNums.push(num);
    }
  }

  // Find remaining [CITE:topic] markers (unresolved)
  const citeRe = CITE_MARKER;
  while ((m = citeRe.exec(draftText)) !== null) {
    unresolved.push(m[1]);
  }

  // Deduplicate DOI markers by number, keep first occurrence
  const seen = new Set<number>();
  for (const { num, doi } of doiMarkers) {
    if (seen.has(num)) continue;
    seen.add(num);
    try {
      const work = await lookupDoi(doi);
      if (work) {
        const csl = crossrefToCsl(work, doi);
        bibliography.push({
          number: num,
          citation: formatCslBibliography([csl], { style: "vancouver" }),
          doi,
        });
      } else {
        bibliography.push({
          number: num,
          citation: `[DOI not found: ${doi}]`,
          doi,
        });
      }
    } catch (err) {
      bibliography.push({
        number: num,
        citation: `[Lookup failed for doi:${doi}: ${String(err).slice(0, 60)}]`,
          doi,
        });
    }
  }

  // Add bare [N] markers as unresolved
  for (const num of bareNums) {
    if (!seen.has(num)) {
      bibliography.push({
        number: num,
        citation: `[CITATION NOT FOUND — placeholder ${num}. Add DOI inline as [${num}](doi:10.xxxx)]`,
      });
    }
  }

  // Sort by number
  bibliography.sort((a, b) => a.number - b.number);

  return { bibliography, unresolved };
}

export function formatBibliography(entries: BibliographyEntry[]): string {
  const lines: string[] = ["# References", ""];
  for (const e of entries) {
    lines.push(`${e.number}. ${e.citation}`);
  }
  return lines.join("\n");
}
