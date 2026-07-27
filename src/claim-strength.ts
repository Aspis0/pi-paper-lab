// src/claim-strength.ts
// Detects over-claiming or under-claiming in Results sentences based on
// the claim_strength policy in data/drosophila-lexicon.yaml.
//
// Given a sentence + statistics, returns the assertion grade the data supports
// and flags if the verb used is too strong or too weak.

import type { Lexicon } from "./anti-ai-lexicon.ts";

export type ClaimGrade = "strong_observation" | "observation" | "preliminary" | "speculative";

export interface ClaimCheckResult {
  sentence: string;
  detectedN?: number;
  detectedP?: number;
  detectedReplicates?: number;
  detectedEffectSize: boolean;
  detectedCI: boolean;
  grade: ClaimGrade;
  gradeReason: string;
  verbsInSentence: string[];
  verdict: "ok" | "overclaim" | "underclaim";
  suggestion?: string;
}

const extractNumber = (text: string, pattern: RegExp): number | undefined => {
  const m = text.match(pattern);
  if (!m) return undefined;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : undefined;
};

export function checkClaimStrength(sentence: string, lex: Lexicon): ClaimCheckResult {
  const lower = sentence.toLowerCase();

  // Extract statistics from the sentence itself.
  const nMatch = lower.match(/\bn\s*=\s*(\d+)/);
  const detectedN = nMatch ? Number(nMatch[1]) : undefined;

  // p-value: "p<0.001", "p=0.013", "p<0.05"
  const pMatch = lower.match(/\bp\s*[<=]\s*0\.(\d+)/);
  let detectedP: number | undefined;
  if (pMatch) {
    detectedP = Number(`0.${pMatch[1]}`);
  }

  // Replicates: "3 biological replicates", "n=3 replicates"
  const repMatch = lower.match(/(\d+)\s+biological\s+replicates?/) ??
    lower.match(/(\d+)\s+replicates?/);
  const detectedReplicates = repMatch ? Number(repMatch[1]) : undefined;

  const detectedEffectSize = /\b(cohen'?s?\s*d|hedges'?s?\s+g|pearson'?s?\s*r|r\^?2|η\^?2|eta\s+squared)\b/i.test(lower);
  const detectedCI = /\b(95|99)\s*%\s*(ci|confidence\s+interval)\b/i.test(lower);

  // Determine grade.
  let grade: ClaimGrade;
  let gradeReason: string;
  if (detectedP !== undefined && detectedP <= 0.01 && (detectedN ?? 0) >= 30 && (detectedReplicates ?? 0) >= 3 && detectedEffectSize && detectedCI) {
    grade = "strong_observation";
    gradeReason = "p<0.01, n>=30, >=3 replicates, effect size + CI reported";
  } else if (detectedP !== undefined && detectedP <= 0.05 && (detectedN ?? 0) >= 15 && (detectedReplicates ?? 0) >= 2) {
    grade = "observation";
    gradeReason = "p<0.05, n>=15, >=2 replicates";
  } else if (detectedP !== undefined && detectedP <= 0.05) {
    grade = "preliminary";
    gradeReason = `p<0.05 but small sample (n=${detectedN ?? "?"}) or insufficient replication (replicates=${detectedReplicates ?? "?"})`;
  } else {
    grade = "speculative";
    gradeReason = "no supporting p-value detected in sentence";
  }

  // Find verbs used in the sentence.
  const allVerbs = [
    ...lex.claimStrength.overclaimVerbsInResults,
    ...lex.claimStrength.underclaimVerbsInResults,
    ...(lex.claimStrength.grades[grade]?.allowedVerbs ?? []),
  ];
  const verbsInSentence = allVerbs.filter((v) =>
    new RegExp(`\\b${v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(sentence),
  );

  // Verdict: is the verb allowed for this grade?
  const allowed = lex.claimStrength.grades[grade]?.allowedVerbs ?? [];
  const overclaim = lex.claimStrength.overclaimVerbsInResults;
  const underclaim = lex.claimStrength.underclaimVerbsInResults;

  let verdict: "ok" | "overclaim" | "underclaim" = "ok";
  let suggestion: string | undefined;
  const hasOverclaim = verbsInSentence.some((v) => overclaim.includes(v));
  const hasUnderclaim = verbsInSentence.some((v) => underclaim.includes(v));

  if (hasOverclaim && (grade === "preliminary" || grade === "speculative" || grade === "observation")) {
    verdict = "overclaim";
    suggestion = `Sentence uses overclaim verb but data only supports "${grade}". Rephrase to "${allowed[0] ?? "report"}".`;
  } else if (hasUnderclaim && grade === "strong_observation") {
    verdict = "underclaim";
    suggestion = `Sentence underclaims: data supports strong observation but verb is hedged. Use "${allowed[0] ?? "show"}".`;
  }

  return {
    sentence,
    detectedN,
    detectedP,
    detectedReplicates,
    detectedEffectSize,
    detectedCI,
    grade,
    gradeReason,
    verbsInSentence,
    verdict,
    suggestion,
  };
}

export function formatClaimReport(r: ClaimCheckResult): string {
  const lines: string[] = [];
  lines.push(`Sentence: "${r.sentence}"`);
  lines.push(`  n=${r.detectedN ?? "?"}, p=${r.detectedP ?? "?"}, replicates=${r.detectedReplicates ?? "?"}`);
  lines.push(`  effect_size=${r.detectedEffectSize}, CI=${r.detectedCI}`);
  lines.push(`  Grade: ${r.grade} (${r.gradeReason})`);
  lines.push(`  Verbs found: ${r.verbsInSentence.join(", ") || "(none)"}`);
  lines.push(`  Verdict: ${r.verdict.toUpperCase()}`);
  if (r.suggestion) lines.push(`  Suggestion: ${r.suggestion}`);
  return lines.join("\n");
}
