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
// `ask_user` tool call (when it is).

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
  /** Subset of high-signal fields to compare. Defaults to title + year + authors. */
  fields?: Array<"title" | "year" | "authors" | "concepts" | "meshTerms">;
  /** Score gap below which two candidates are considered AMBIGUOUS. Default 0.35. */
  ambiguousGap?: number;
  /** Minimum absolute score for a sole candidate to count as RESOLVED. Default 0.70. */
  singleCandidateThreshold?: number;
}

/**
 * The deterministic classifier. Pure function — no I/O. The caller
 * supplies the Finding[] already retrieved from the source-finder
 * backend(s). The classifier never asks the network for more candidates.
 */
export function classify(
  topic: string,
  findings: Finding[],
  claim?: string,
  opts: ClassifyOpts = {},
): ClarifyItem {
  if (findings.length === 0) {
    return { topic, status: "MISSING", candidates: [], claim };
  }

  const scores = findings.map((f) => scoreCandidate(f, topic, claim, opts.fields ?? ["title", "year", "authors"]));

  // Sort by score descending.
  const sorted = [...scores].sort((a, b) => b.score - a.score);
  const top = sorted[0]!;
  const second = sorted[1];

  if (findings.length === 1) {
    const threshold = opts.singleCandidateThreshold ?? 0.70;
    // A single 'low' confidence candidate is always REVIEW — the candidate
    // exists but the LLM cannot ground the claim in real metadata, so the
    // user should confirm or replace it. Score alone is not enough.
    if (findings[0]!.confidence === "low") {
      return { topic, status: "REVIEW", candidates: [findings[0]!], claim, scores: sorted };
    }
    if (top.score >= threshold) {
      return { topic, status: "RESOLVED", candidates: [findings[0]!], claim, scores: sorted };
    }
    return { topic, status: "REVIEW", candidates: [findings[0]!], claim, scores: sorted };
  }

  // 2+ candidates: ambiguous if top two are close enough.
  const gap = opts.ambiguousGap ?? 0.35;
  if (second && top.score - second.score < gap) {
    return { topic, status: "AMBIGUOUS", candidates: findings, claim, scores: sorted };
  }
  // Top beats the runner-up by a wide margin → RESOLVED on top.
  return { topic, status: "RESOLVED", candidates: [findings[0]!], claim, scores: sorted };
}

/**
 * Score a single finding against a topic + optional claim. Pure, deterministic,
 * no AI. The score is the Jaccard similarity between the topic tokens and
 * the candidate's title tokens, plus bonuses for year match and author overlap.
 */
function scoreCandidate(
  finding: Finding,
  topic: string,
  claim: string | undefined,
  fields: Array<"title" | "year" | "authors" | "concepts" | "meshTerms">,
): { doi?: string; title: string; score: number; reasons: string[] } {
  const topicTokens = tokenise(topic);
  const claimTokens = claim ? tokenise(claim) : new Set<string>();
  const union = new Set<string>([...topicTokens, ...claimTokens]);
  const reasons: string[] = [];

  const candidateTokens = fields.includes("title") ? tokenise(finding.title) : new Set<string>();
  const intersection = new Set<string>([...union].filter((t) => candidateTokens.has(t)));

  // Jaccard on the union of topic + claim tokens vs candidate title tokens.
  let score = intersection.size / Math.max(union.size, 1);
  if (intersection.size > 0) reasons.push(`title Jaccard=${score.toFixed(2)}`);

  // Bonuses.
  if (fields.includes("authors") && finding.authors.length > 0) {
    // Mention-an-author-in-the-claim heuristic: low signal but cheap.
    const claimHasAuthor = [...finding.authors].some((a) =>
      [...union].some((t) => t.toLowerCase().includes(a.family.toLowerCase())),
    );
    if (claimHasAuthor) {
      score += 0.10;
      reasons.push("author overlap");
    }
  }

  if (fields.includes("concepts") && finding.concepts?.length) {
    const conceptOverlap = finding.concepts.filter((c) =>
      [...union].some((t) => c.toLowerCase().includes(t.toLowerCase())),
    ).length;
    if (conceptOverlap > 0) {
      score += 0.05 * Math.min(conceptOverlap, 4);
      reasons.push(`concepts=${conceptOverlap}`);
    }
  }

  if (fields.includes("meshTerms") && finding.meshTerms?.length) {
    const meshOverlap = finding.meshTerms.filter((m) =>
      [...union].some((t) => m.toLowerCase().includes(t.toLowerCase())),
    ).length;
    if (meshOverlap > 0) {
      score += 0.05 * Math.min(meshOverlap, 4);
      reasons.push(`mesh=${meshOverlap}`);
    }
  }

  // Confidence as a final multiplier (high confidence boosts the score).
  if (finding.confidence === "high") {
    score *= 1.10;
    reasons.push("high confidence");
  } else if (finding.confidence === "low") {
    score *= 0.85;
    reasons.push("low confidence");
  }

  // Cap at 1.0 to keep the score interpretable.
  score = Math.min(score, 1.0);

  return { doi: finding.doi, title: finding.title, score, reasons };
}

function tokenise(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 3),
  );
}

/**
 * Format the clarify items as a numbered menu the LLM can paste to the
 * user via either a synchronous block (current mode) or the `ask_user`
 * tool (M2.2). The output is plain-text by design: Markdown formatting
 * that the LLM cannot misinterpret.
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
  lines.push("For each item below, pick the candidate (or write `[CITATION NEEDED: topic]` to skip).");
  lines.push("Format: `choose <number> for [topic]`, or `decline <number>` to mark as not-cited.");
  lines.push("");
  for (let i = 0; i < actionable.length; i++) {
    const it = actionable[i]!;
    lines.push(`[${i + 1}] Topic: "${it.topic}" — status: ${it.status}`);
    if (it.claim) lines.push(`    Claim: "${it.claim}"`);
    if (it.candidates.length === 0) {
      lines.push("    No candidates found.");
      lines.push("    → Recommend: emit [CITATION NEEDED: " + it.topic + "] in the draft.");
    } else {
      for (let j = 0; j < it.candidates.length; j++) {
        const c = it.candidates[j]!;
        const meta = c.doi ? `DOI: ${c.doi}` : "(no DOI)";
        const year = c.year ? ` (${c.year})` : "";
        const venue = c.venue ? ` — ${c.venue}` : "";
        lines.push(`    (a) ${c.title}${year}${venue} — ${meta}`);
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
 */
export function serialiseClarifications(items: ClarifyItem[]): string {
  return JSON.stringify(
    {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
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
          confidence: c.confidence,
          source: c.source,
        })),
        scores: it.scores,
      })),
    },
    null,
    2,
  );
}
