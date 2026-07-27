// tests/draft-score.mjs
// Score a real-looking Drosophila paper draft and print before/after rewrite.

import { loadLexicon, scoreText, silentRewrite } from "../src/anti-ai-lexicon.ts";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const lex = loadLexicon(ROOT);
const text = readFileSync(join(ROOT, "tests", "fixtures", "ai-tells-paper.md"), "utf8");

const scoreBefore = scoreText(text, lex);
console.log("=== BEFORE ===");
console.log(`Total: ${scoreBefore.total.toFixed(2)} | Verdict: ${scoreBefore.verdict}`);
console.log("Hits by category:");
const byCat = new Map();
for (const h of scoreBefore.hits) {
  if (!byCat.has(h.category)) byCat.set(h.category, []);
  byCat.get(h.category).push(h.hit);
}
for (const [cat, hits] of byCat) {
  console.log(`  [${cat}] ${hits.length}: ${hits.slice(0, 8).join(", ")}${hits.length > 8 ? "..." : ""}`);
}

console.log("\n=== SILENT REWRITE ===");
const { text: rewritten, stats } = silentRewrite(text, lex);
console.log(`Stats: connectors=${stats.connectors}, fillers=${stats.fillers}, verbs=${stats.verbs}, unresolved=${stats.flaggedVerbs.length > 0 ? stats.flaggedVerbs.join(", ") : "(none)"}`);

const scoreAfter = scoreText(rewritten, lex);
console.log(`Score after: ${scoreAfter.total.toFixed(2)} | Verdict: ${scoreAfter.verdict}`);
console.log(`Reduction: ${scoreBefore.total.toFixed(2)} → ${scoreAfter.total.toFixed(2)} (${((1 - scoreAfter.total / Math.max(scoreBefore.total, 0.001)) * 100).toFixed(0)}%)`);

console.log("\n=== METHODS / RESULTS SECTION OF REWRITTEN ===");
const lines = rewritten.split("\n");
const inMethods = false;
const inResults = false;
for (let i = 0; i < lines.length; i++) {
  const l = lines[i];
  if (/^###?\s/.test(l)) {
    if (/results/i.test(l)) break;
  }
  if (/^###?\s/.test(l) && /results/i.test(l)) {
    for (let j = i; j < Math.min(i + 12, lines.length); j++) {
      console.log(lines[j]);
    }
    break;
  }
}

console.log("\n=== DISCUSSION OF REWRITTEN ===");
const startIdx = rewritten.search(/^## Discussion/m);
if (startIdx >= 0) {
  console.log(rewritten.slice(startIdx, startIdx + 600));
}

const draftOut = join(ROOT, "tests", "fixtures", "ai-tells-paper.rewritten.md");
import("node:fs").then((fs) => fs.writeFileSync(draftOut, rewritten));
