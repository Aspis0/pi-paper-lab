// src/sloppy-detector.ts
// Detects sloppy human writing patterns (not AI-tells). Used by /bio-sloppy.

import type { Lexicon } from "./anti-ai-lexicon.ts";

export interface SloppyHit {
  pattern: string;
  category: "vague_quantifier" | "vague_time" | "vague_location" | "causal_overclaim" | "correlation_causation" | "passive_overuse" | "hedge_overuse";
  match: string;
  suggestion: string;
}

const escapeForRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function detectSloppy(text: string, lex: Lexicon): SloppyHit[] {
  const hits: SloppyHit[] = [];

  const check = (
    list: string[],
    category: SloppyHit["category"],
    suggestion: string,
  ) => {
    for (const p of list) {
      if (!p) continue;
      const re = new RegExp(`\\b${escapeForRegex(p.toLowerCase())}\\b`, "gi");
      const matches = text.match(re);
      if (matches) {
        for (const m of matches) {
          hits.push({ pattern: p, category, match: m, suggestion });
        }
      }
    }
  };

  check(lex.sloppyPatterns.vagueQuantifiers, "vague_quantifier", "replace with exact n or percentage");
  check(lex.sloppyPatterns.vagueTime, "vague_time", "replace with stage, hours post-fertilization, or specific timepoint");
  check(lex.sloppyPatterns.vagueLocation, "vague_location", "specify brain region or neuropil");
  check(lex.sloppyPatterns.causalOverclaim, "causal_overclaim", "unless rescue + loss-of-function shown, rephrase to 'is associated with'");
  check(lex.sloppyPatterns.correlationCausationConflation, "correlation_causation", "if only co-expression data, rephrase to 'correlates with'");
  check(lex.sloppyPatterns.passiveOveruse, "passive_overuse", "Results prefer active voice: 'We observed X'");
  check(lex.sloppyPatterns.hedgeOveruseInResults, "hedge_overuse", "Results should state findings directly when data supports them");

  return hits;
}

export function formatSloppyReport(hits: SloppyHit[]): string {
  if (hits.length === 0) return "No sloppy patterns detected. Draft is clean.";
  const lines: string[] = [];
  lines.push(`Sloppy patterns found: ${hits.length}`);
  lines.push("");
  const byCat = new Map<string, SloppyHit[]>();
  for (const h of hits) {
    if (!byCat.has(h.category)) byCat.set(h.category, []);
    byCat.get(h.category)!.push(h);
  }
  for (const [cat, list] of byCat) {
    lines.push(`[${cat}] (${list.length}):`);
    for (const h of list) {
      lines.push(`  - "${h.match}" — ${h.suggestion}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}
