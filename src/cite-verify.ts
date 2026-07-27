// src/cite-verify.ts
// Claim ↔ reference verification. For each [N] citation in the draft,
// extract the claim text and fetch the abstract, then format a structured
// prompt for the LLM to evaluate (SUPPORTS / REFUTES / UNCLEAR).

import { CITE_NUM } from "./citations.ts";
import { lookupDoi, type CrossRefWork } from "./crossref.ts";

export interface CitationForVerification {
  number: number;
  claim: string;          // the sentence containing [N]
  referenceTitle: string;
  referenceAuthors: string;
  referenceYear: string;
  abstract?: string;     // if we could fetch it
  doi?: string;
}

export interface VerificationPrompt {
  number: number;
  prompt: string;
}

// Extract claims (sentences containing [N]) from draft text.
export function extractCitedClaims(text: string): Array<{ number: number; claim: string }> {
  const sentences = text.split(/(?<=[.!?])\s+/);
  const claims: Array<{ number: number; claim: string }> = [];

  for (const sentence of sentences) {
    let m: RegExpExecArray | null;
    const re = /\[(\d+)\]/g;
    while ((m = re.exec(sentence)) !== null) {
      const num = Number(m[1]);
      // Clean the claim: remove [N] markers for the prompt
      const claim = sentence.replace(/\[\d+\]/g, "").trim();
      claims.push({ number: num, claim });
    }
  }
  return claims;
}

// Build a verification prompt for each cited claim.
// The LLM (in its next turn) evaluates each prompt and returns
// SUPPORTS / REFUTES / UNCLEAR.
export async function buildVerificationPrompts(
  claims: Array<{ number: number; claim: string }>,
  citations: Array<{ number: number; title: string; authors: string; year: string; doi?: string; link?: string }>,
): Promise<VerificationPrompt[]> {
  const prompts: VerificationPrompt[] = [];

  for (const claim of claims) {
    const citation = citations.find((c) => c.number === claim.number);
    if (!citation) {
      prompts.push({
        number: claim.number,
        prompt: `[${claim.number}] CITATION NOT FOUND for claim: "${claim.claim}"`,
      });
      continue;
    }

    // Try to fetch abstract from CrossRef (if DOI available)
    let abstract: string | undefined;
    if (citation.doi) {
      try {
        const work = await lookupDoi(citation.doi);
        if (work?.abstract) {
          // CrossRef abstracts often have <jats:...> tags — strip them
          abstract = work.abstract.replace(/<[^>]+>/g, "").trim();
        }
      } catch {
        // abstract lookup is best-effort
      }
    }

    const prompt = buildPrompt(claim.claim, citation, abstract);
    prompts.push({ number: claim.number, prompt });
  }

  return prompts;
}

function buildPrompt(
  claim: string,
  citation: { title: string; authors: string; year: string; doi?: string; link?: string },
  abstract?: string,
): string {
  const lines: string[] = [];
  lines.push(`=== CITATION VERIFICATION ===`);
  lines.push(``);
  lines.push(`Claim: "${claim}"`);
  lines.push(``);
  lines.push(`Reference: ${citation.authors} (${citation.year}). ${citation.title}.`);
  if (citation.doi) lines.push(`DOI: ${citation.doi}`);
  if (citation.link) lines.push(`Link: ${citation.link}`);
  lines.push(``);
  if (abstract) {
    lines.push(`Abstract:`);
    lines.push(abstract.slice(0, 1500));
    lines.push(``);
  } else {
    lines.push(`Abstract: (not available — verify manually via the link/DOI above)`);
    lines.push(``);
  }
  lines.push(`Question: Does the reference support the claim?`);
  lines.push(`Answer: SUPPORTS / REFUTES / UNCLEAR`);
  lines.push(`Reason: (one line)`);
  lines.push(``);
  return lines.join("\n");
}

export function formatVerificationReport(prompts: VerificationPrompt[]): string {
  if (prompts.length === 0) {
    return "No citations to verify. Run /cite-resolve first.";
  }
  const lines: string[] = ["# Citation Verification Report", ""];
  for (const p of prompts) {
    lines.push(p.prompt);
    lines.push("---");
  }
  lines.push("");
  lines.push("Review each prompt above and answer SUPPORTS / REFUTES / UNCLEAR.");
  lines.push("If REFUTES or UNCLEAR, consider replacing the citation or rephrasing the claim.");
  return lines.join("\n");
}
