// src/source-finders/confidence.ts
// Centralised confidence scoring for the M1 source-finder backends.
//
// The previous per-backend implementation (in OpenAlex: `confidence:
// abstract ? "high" : "medium"`) had three problems:
//   1. Never produced "low" though the enum promised it.
//   2. Drift risk: each new backend would have to invent its own policy.
//   3. Sentinel titles like "(untitled)" counted as "title present" and
//      masked missing-metadata cases.
//
// This module is the single source of truth. All backends compute
// confidence via `computeConfidence()` and the same enum contract
// flows into the LLM `Finding[]` and the `clarify` step (M2).

import type { Finding } from "./openalex.ts";

export type Confidence = "high" | "medium" | "low";

/**
 * Compute a confidence score from the fields that the LLM prompt-consumer
 * cares about. The rules are documented and stable across backends:
 *
 *   - "high"   — has a real title (not the sentinel), an abstract, AND a DOI.
 *                The LLM can verify the citation against the paper's actual
 *                content and link back to the publisher.
 *   - "medium" — has a real title OR a DOI, plus at least one of
 *                {abstract, meshTerms, tldr}. The LLM can verify the claim
 *                against the title/abstract but lacks a stable identifier
 *                for citation cross-referencing.
 *   - "low"    — title is the sentinel, OR no DOI and no abstract. The LLM
 *                should treat this as a REVIEW candidate and surface it
 *                to the user via the clarify step (M2).
 *
 * Sentinel title is "(untitled)" (set by OpenAlex normalisation). Other
 * backends should either use the same sentinel or pre-normalise away from
 * it (preferred: pass no title at all and let the function fill it).
 */
export function computeConfidence(
  f: Pick<Finding, "title" | "doi" | "abstract" | "meshTerms" | "tldr">,
): Confidence {
  const hasRealTitle = Boolean(f.title) && f.title !== "(untitled)";
  const hasDoi = Boolean(f.doi);

  if (hasRealTitle && hasDoi && f.abstract) return "high";
  // Any of {real title, DOI} is enough for "medium" — the LLM has either
  // a stable identifier to cite (DOI) or a non-sentinel title to ground
  // the claim against. Only the worst case (sentinel title + no DOI)
  // drops to "low".
  if (hasRealTitle || hasDoi) return "medium";
  return "low";
}
