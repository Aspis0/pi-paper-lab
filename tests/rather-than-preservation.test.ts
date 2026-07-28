// tests/rather-than-preservation.test.ts
// Regression test for Bug 1 (v0.7.0-alpha.11): silentRewrite was destroying
// the grammatical construction "rather than" by removing "rather" even when
// it was part of the standard English comparative phrase.
//
// Before fix: "suggest rather than" → "suggest than" (broken grammar)
// After fix: "rather than" is preserved when the word is followed by "than".

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { silentRewrite, loadLexicon } from "../src/anti-ai-lexicon.ts";

const ROOT = process.cwd();
const lex = loadLexicon(ROOT);

test("silentRewrite: 'rather than' is NOT deleted (comparative construction)", () => {
  const input = "We used imaging rather than spectroscopy to measure the signal.";
  const { text } = silentRewrite(input, lex);
  assert.ok(
    text.includes("rather than"),
    `"rather than" kept intact; got: "${text}"`,
  );
});

test("silentRewrite: standalone 'rather' (filler) IS deleted", () => {
  const input = "The outcome was rather uncertain in this context.";
  const { text } = silentRewrite(input, lex);
  assert.ok(
    !text.toLowerCase().includes("rather"),
    `standalone "rather" as filler should be deleted; got: "${text}"`,
  );
});

test("silentRewrite: 'rather,' (filler with commas) IS deleted", () => {
  const input = "The process, rather, was more complex than expected.";
  const { text } = silentRewrite(input, lex);
  assert.ok(
    !text.toLowerCase().includes("rather"),
    `filler "rather" with commas should be deleted; got: "${text}"`,
  );
});

test("silentRewrite: 'X rather than Y' comparison — 'rather' preserved", () => {
  // Bug case: "The results suggest rather than inferring causality..."
  // should NOT become "The results suggest than inferring causality..."
  const input = "The data indicate that imaging is preferred rather than spectroscopy.";
  const { text } = silentRewrite(input, lex);
  assert.ok(
    text.includes("rather than"),
    `"X rather than Y" comparison must be preserved; got: "${text}"`,
  );
});

test("silentRewrite: filler count for 'rather than' is 0", () => {
  const input = "We use A rather than B and C rather than D.";
  const { stats } = silentRewrite(input, lex);
  assert.equal(stats.fillers, 0, `no filler removals in comparative; got ${stats.fillers}`);
});
