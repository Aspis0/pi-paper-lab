// src/clarify.ts
// Disambiguation / "ask when unsure" UX (M2 of v0.7 plan).
//
// Adopts the citeground disambiguate.py contract: classify each topic's
// Finding[] into RESOLVED / AMBIGUOUS / REVIEW / MISSING, and only escalate
// the ambiguous/review rows to the user. The resolver NEVER invents a
// citation; the LLM only picks among pre-retrieved candidates.
//
// The output is a ClarifyItem[] + a `formatClarifyPrompt()` that renders the
// audit trail as a numbered menu the LLM can paste to the user (when the
// tool `ask_user` is not yet wired) or that the LLM uses to drive the
// `ask_user` tool (when it is).
//
// Audit findings addressed (see /tmp/audit-m2.1.md):
//   CRIT-1..5  : label `(a)` uniqueness, candidate ordering, confidence tag,
//                 author word-boundary matching, tokenise JSDoc + escapeRegex.
//   HIGH-1..5  : `"year"` dead enum removed, threshold clamping,
//                 `"medium"` confidence reason logged, Jaccard is now
//                 real Jaccard (∩/∪ including candidate tokens).
//   MED-1..7   : generatedAt deterministic via optional `now`,
//                 sentinel "(untitled)" short-circuit, tokenise JSDoc,
//                 spread reduction, bidirectional concept/mesh matching,
//                 author false-positive test, AMBIGUOUS vs REVIEW copy.
//   LOW-1..7   : classify→classifyFindings rename, serialise includes
//                 abstract/concepts/meshTerms, pre-cap score budget,
//                 token length lowered to 2, more tests.

import type { Finding } from "./source-finders/openalex.ts";

export type ClarifyStatus = "RESOLVED" | "AMBIGUOUS" | "REVIEW" | "MISSING";

export interface ClarifyItem {
  topic: string;
  status: ClarifyStatus;
  /** The pre-retrieved candidates in play. Empty for MISSING. */
  candidates: Finding[];
  /** Optional context the LLM passed in (the claim sentence). */
  claim?: string;
  /** Deterministic scoring trace, useful for the audit CSV. */
  scores?: Array<{ doi?: string; title: string; score: number; reasons: string[] }>;
}

export interface ClassifyOpts {
  /**
   * Subset of high-signal fields to compare. Defaults to `["title",
   * "authors", "concepts", "meshTerms"]` — the same four fields that
   * influence the score in `scoreCandidate`. (HIGH-1 fix: `"year"` was
   * removed because the scoreCandidate bonus logic does not depend on
   * publication year; if year matching is added in a later milestone
   * it can come back.)
   */
  fields?: Array<"title" | "authors" | "concepts" | "meshTerms">;
  /** Score gap below which two candidates are considered AMBIGUOUS. Default 0.35. Clamped to [0, 1]. */
  ambiguousGap?: number;
  /** Minimum absolute score for a sole candidate to count as RESOLVED. Default 0.70. Clamped to [0, 1]. */
  singleCandidateThreshold?: number;
}

/**
 * The deterministic classifier. Pure function — no I/O. The caller
 * supplies the Finding[] already retrieved from the source-finder
 * backend(s). The classifier never asks the network for more candidates.
 *
 * Renamed from `classify` to `classifyFindings` (LOW-1) with a
 * deprecation alias for back-compat.
 */
export function classifyFindings(
  topic: string,
  findings: Finding[],
  claim?: string,
  opts: ClassifyOpts = {},
): ClarifyItem {
  if (findings.length === 0) {
    return { topic, status: "MISSING", candidates: [], claim };
  }

  // HIGH-1 fix: default no longer includes "year".
  const fields = opts.fields ?? ["title", "authors", "concepts", "meshTerms"];
  const scores = findings.map((f) => scoreCandidate(f, topic, claim, fields));

  // Sort by score descending. We keep a parallel array of Findings
  // sorted by score so the LLM-facing order matches the score order.
  const indexed = findings.map((f, i) => ({ f, s: scores[i]! }));
  indexed.sort((a, b) => b.s.score - a.s.score);
  const sortedScores = indexed.map((x) => x.s);
  const sortedFindings = indexed.map((x) => x.f);
  const top = sortedScores[0]!;
  const second = sortedScores[1];

  if (findings.length === 1) {
    // A single 'low' confidence candidate is always REVIEW — the candidate
    // exists but the LLM cannot ground the claim in real metadata, so the
    // user should confirm or replace it. Score alone is not enough.
    if (findings[0]!.confidence === "low") {
      return { topic, status: "REVIEW", candidates: [findings[0]!], claim, scores: sortedScores };
    }
    // HIGH-2 fix: clamp singleCandidateThreshold to [0, 1].
    const threshold = clamp(opts.singleCandidateThreshold ?? 0.70, 0, 1);
    if (top.score >= threshold) {
      return { topic, status: "RESOLVED", candidates: [findings[0]!], claim, scores: sortedScores };
    }
    return { topic, status: "REVIEW", candidates: [findings[0]!], claim, scores: sortedScores };
  }

  // 2+ candidates: ambiguous if top two are close enough.
  // HIGH-3 fix: clamp ambiguousGap to [0, 1].
  const gap = clamp(opts.ambiguousGap ?? 0.35, 0, 1);
  if (second && top.score - second.score < gap) {
    return { topic, status: "AMBIGUOUS", candidates: sortedFindings, claim, scores: sortedScores };
  }
  // Top beats the runner-up by a wide margin → RESOLVED on top.
  return { topic, status: "RESOLVED", candidates: [sortedFindings[0]!], claim, scores: sortedScores };
}

/**
 * @deprecated use `classifyFindings` instead. Kept as a back-compat
 * alias for callers that imported the old name. (LOW-1)
 */
export const classify = classifyFindings;

/**
 * Score a single finding against a topic + optional claim. Pure,
 * deterministic, no AI. The score is a Jaccard-style similarity on
 * the union of topic + claim tokens vs candidate title tokens (the
 * real Jaccard — HIGH-5 fix: numerator = |A ∩ B|, denominator = |A ∪ B|,
 * where B = candidate title tokens), plus bonuses for author overlap,
 * concepts/MeSH overlap, and a confidence multiplier.
 *
 * CRIT-4 fix: author overlap uses a word-boundary regex (via
 * `escapeRegex`) so "liuzza" does not match "liu".
 *
 * MED-5 fix: concepts/MeSH overlap is bidirectional (token in concept
 * OR concept in token) for robustness.
 *
 * MED-4 fix: the union is materialised ONCE as an array to avoid
 * repeated spread allocations.
 */
function scoreCandidate(
  finding: Finding,
  topic: string,
  claim: string | undefined,
  fields: Array<"title" | "authors" | "concepts" | "meshTerms">,
): { doi?: string; title: string; score: number; reasons: string[] } {
  const reasons: string[] = [];

  // MED-2 fix: the sentinel title "(untitled)" must never match anything.
  // computeConfidence() already penalises it; we go further and return
  // 0 here so the title-Jaccard does not spuriously include the token
  // "untitled" itself.
  const title = finding.title;
  if (title === "(untitled)") {
    return { doi: finding.doi, title, score: 0, reasons: ["sentinel title (untitled)"] };
  }

  const topicTokens = tokenise(topic);
  const claimTokens = claim ? tokenise(claim) : new Set<string>();
  const union = new Set<string>([...topicTokens, ...claimTokens]);
  const unionArr = [...union]; // MED-4 fix: pre-allocate once

  // Title Jaccard: real |A ∩ B| / |A ∪ B| (HIGH-5 fix).
  let score = 0;
  if (fields.includes("title")) {
    const candidateTokens = tokenise(title);
    const intersection = new Set<string>(unionArr.filter((t) => candidateTokens.has(t)));
    const combined = new Set<string>([...union, ...candidateTokens]);
    if (combined.size > 0) {
      score = intersection.size / combined.size;
    }
    if (intersection.size > 0) {
      reasons.push(`title Jaccard=${score.toFixed(2)}`);
    }
  }

  // Author bonus: word-boundary match. CRIT-4 fix.
  if (fields.includes("authors") && finding.authors.length > 0) {
    const haystack = " " + unionArr.join(" ") + " ";
    const claimHasAuthor = finding.authors.some((a) => {
      if (!a.family) return false;
      const re = new RegExp(`\\b${escapeRegex(a.family.toLowerCase())}\\b`);
      return re.test(haystack);
    });
    if (claimHasAuthor) {
      score += 0.10;
      reasons.push("author overlap");
    }
  }

  // Concepts bonus. MED-5 fix: bidirectional match.
  if (fields.includes("concepts") && finding.concepts?.length) {
    const conceptOverlap = finding.concepts.filter((c) => {
      const lower = c.toLowerCase();
      return unionArr.some((t) => lower.includes(t) || t.includes(lower));
    }).length;
    if (conceptOverlap > 0) {
      score += 0.05 * Math.min(conceptOverlap, 4);
      reasons.push(`concepts=${conceptOverlap}`);
    }
  }

  // MeSH bonus. MED-5 fix: bidirectional match.
  if (fields.includes("meshTerms") && finding.meshTerms?.length) {
    const meshOverlap = finding.meshTerms.filter((m) => {
      const lower = m.toLowerCase();
      return unionArr.some((t) => lower.includes(t) || t.includes(lower));
    }).length;
    if (meshOverlap > 0) {
      score += 0.05 * Math.min(meshOverlap, 4);
      reasons.push(`mesh=${meshOverlap}`);
    }
  }

  // HIGH-4 fix: "medium" confidence gets an explicit reason log so
  // the audit trail can distinguish "medium" from "field absent".
  if (finding.confidence === "high") {
    score *= 1.10;
    reasons.push("high confidence");
  } else if (finding.confidence === "medium") {
    // No multiplier; explicit log entry so the score trace records it.
    reasons.push("medium confidence");
  } else if (finding.confidence === "low") {
    score *= 0.85;
    reasons.push("low confidence");
  }

  // Cap at 1.0 to keep the score interpretable.
  score = Math.min(score, 1.0);

  return { doi: finding.doi, title, score, reasons };
}

/**
 * English stop words. LOW-4: lowering the token length threshold to 2
 * brings in common short words ("in", "of", "is", "on", "to", "at")
 * that pollute Jaccard intersections. We keep the lowered threshold
 * (so DNA/RNA/ATP/miR/pH survive) but explicitly drop these stop
 * words to avoid the pollution.
 */
const STOP_WORDS: ReadonlySet<string> = new Set([
  "in", "of", "is", "on", "to", "at", "as", "by", "or", "an", "be",
  "it", "we", "us", "no", "so", "up", "do", "if",
]);

/**
 * Tokenise a string into a Set of lower-case word tokens.
 *
 * The regex `[^a-z0-9\s]` only preserves ASCII letters, digits, and
 * whitespace. Non-ASCII text (e.g. "Drosophila melanogaster" survives
 * because it's ASCII; "α-actinin" or CJK characters are dropped) is
 * collapsed to whitespace and effectively removed from the scoring.
 * LOW-4: token length threshold lowered from 3 to 2 so short biomedical
 * abbreviations (DNA, RNA, ATP, pH, miR) survive tokenisation. Stop
 * words are dropped explicitly to keep short noise out of the Jaccard.
 *
 * For our use case (English biomedical abstracts + paper titles) this
 * is acceptable; a future Unicode-aware tokeniser can be swapped in
 * without changing the classifyFindings() contract.
 */
function tokenise(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 2 && !STOP_WORDS.has(w)),
  );
}

/**
 * Escape a string for safe use inside a `RegExp`. Used for the
 * word-boundary author match. (CRIT-5 fix: needed by scoreCandidate.)
 */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Clamp a number to [lo, hi]. Returns `fallback` if the input is not
 * a finite number. (HIGH-2 / HIGH-3 fix.)
 */
function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}

/**
 * Format the clarify items as a numbered menu the LLM can paste to the
 * user via either a synchronous block (current mode) or the `ask_user`
 * tool (M2.2). The output is plain-text by design: Markdown formatting
 * that the LLM cannot misinterpret.
 *
 * CRIT-1 fix: each candidate gets a unique label `(a)`, `(b)`, …, `(j)`,
 * then `(11)`, `(12)`, … for >10 candidates. The label is the only
 * way the user can refer to a candidate ("scelgo (a)").
 *
 * CRIT-2 fix: candidates are sorted by score descending so the best
 * match is at the top of the list.
 *
 * CRIT-3 fix: each candidate shows its confidence level `[high]` /
 * `[medium]` / `[low]`.
 *
 * MED-7 fix: AMBIGUOUS items get a "pick one" instruction; REVIEW
 * items get a "confirm or reject" instruction.
 */
export function formatClarifyPrompt(items: ClarifyItem[]): string {
  if (items.length === 0) return "No clarifications needed.";
  const lines: string[] = [];
  const actionable = items.filter((i) => i.status === "AMBIGUOUS" || i.status === "REVIEW" || i.status === "MISSING");
  if (actionable.length === 0) {
    lines.push("All citations resolved — no clarifications needed.");
    return lines.join("\n");
  }
  lines.push(`CLARIFICATIONS NEEDED (${actionable.length} item${actionable.length === 1 ? "" : "s"}):`);
  lines.push("");
  for (let i = 0; i < actionable.length; i++) {
    const it = actionable[i]!;
    lines.push(`[${i + 1}] Topic: "${it.topic}" — status: ${it.status}`);
    if (it.claim) lines.push(`    Claim: "${it.claim}"`);

    if (it.status === "AMBIGUOUS") {
      lines.push('    Pick the best candidate. Format: `choose (a) for [topic]`.');
    } else if (it.status === "REVIEW") {
      lines.push('    Confirm or reject the candidate. Format: `confirm (a) for [topic]` or `reject (a) for [topic]`.');
    } else {
      // MISSING
      lines.push('    No candidates found. Either provide a DOI, or skip.');
    }

    if (it.candidates.length === 0) {
      lines.push("    No candidates found.");
      lines.push(`    → Recommend: emit [CITATION NEEDED: ${it.topic}] in the draft, or [ASK: try a different search term for ${it.topic}?]`);
    } else {
      // CRIT-2 fix: order candidates by score descending.
      const labelFor = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"];
      const sorted = [...it.candidates].sort((a, b) => {
        const sa = it.scores?.find((s) => s.doi === a.doi)?.score ?? 0;
        const sb = it.scores?.find((s) => s.doi === b.doi)?.score ?? 0;
        return sb - sa;
      });
      for (let j = 0; j < sorted.length; j++) {
        const c = sorted[j]!;
        const label = labelFor[j] ?? `(${j + 1})`;
        const meta = c.doi ? `DOI: ${c.doi}` : "(no DOI)";
        const year = c.year ? ` (${c.year})` : "";
        const venue = c.venue ? ` — ${c.venue}` : "";
        // CRIT-3 fix: confidence label visible on each candidate.
        const conf = ` [${c.confidence}]`;
        lines.push(`    (${label}) ${c.title}${year}${venue} — ${meta}${conf}`);
      }
    }
    lines.push("");
  }
  return lines.join("\n");
}

/**
 * Serialise ClarifyItems to JSON for the `.clarifications.json` sidecar.
 * The sidecar is the audit trail: every AMBIGUOUS/REVIEW decision is
 * recorded with the chosen candidate + reason, so re-runs are stable.
 *
 * MED-1 fix: `now` is an optional parameter (default `new Date()`); for
 * deterministic tests pass a fixed Date.
 *
 * LOW-2 fix: the candidate record now includes `abstract`, `concepts`,
 * `meshTerms`, and `tldr` so the audit trail can reconstruct the
 * score reasoning (these are the fields that drive computeConfidence and
 * influence the LLM's verification of the citation).
 */
export function serialiseClarifications(items: ClarifyItem[], now: Date = new Date()): string {
  return JSON.stringify(
    {
      schemaVersion: 1,
      generatedAt: now.toISOString(),
      items: items.map((it) => ({
        topic: it.topic,
        status: it.status,
        claim: it.claim,
        candidates: it.candidates.map((c) => ({
          doi: c.doi,
          title: c.title,
          year: c.year,
          authors: c.authors,
          venue: c.venue,
          volume: c.volume,
          issue: c.issue,
          pages: c.pages,
          confidence: c.confidence,
          source: c.source,
          abstract: c.abstract,
          concepts: c.concepts,
          meshTerms: c.meshTerms,
          tldr: c.tldr,
        })),
        scores: it.scores,
      })),
    },
    null,
    2,
  );
}
