// tests/clarify.test.ts
// Unit tests for the M2 clarify classifier. Pure logic, no I/O.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  classify,
  formatClarifyPrompt,
  serialiseClarifications,
} from "../src/clarify.ts";
import type { Finding } from "../src/source-finders/openalex.ts";

function makeFinding(over: Partial<Finding> = {}): Finding {
  return {
    title: "Cancer cachexia in Drosophila",
    authors: [{ family: "Liu", given: "Ying" }],
    year: 2022,
    venue: "Disease Models & Mechanisms",
    doi: "10.1242/dmm.049298",
    source: "openalex",
    confidence: "high",
    ...over,
  };
}

test("classify: MISSING when no candidates", () => {
  const item = classify("topic", [], "some claim");
  assert.equal(item.status, "MISSING");
  assert.equal(item.candidates.length, 0);
});

test("classify: RESOLVED for a single high-confidence candidate", () => {
  const item = classify("cachexia drosophila", [makeFinding()]);
  assert.equal(item.status, "RESOLVED");
  assert.equal(item.candidates.length, 1);
});

test("classify: REVIEW for a single low-confidence candidate", () => {
  const item = classify("cachexia drosophila", [
    makeFinding({ confidence: "low", doi: undefined, abstract: undefined }),
  ]);
  assert.equal(item.status, "REVIEW");
});

test("classify: AMBIGUOUS when two candidates score close", () => {
  const item = classify("cachexia drosophila", [
    makeFinding({ title: "Cancer cachexia in Drosophila", doi: "10.1/a", confidence: "high" }),
    makeFinding({ title: "Cancer cachexia in Drosophila melanogaster", doi: "10.1/b", confidence: "high" }),
  ]);
  assert.equal(item.status, "AMBIGUOUS");
  assert.equal(item.candidates.length, 2);
});

test("classify: RESOLVED when top beats runner-up by a wide margin", () => {
  const item = classify("cachexia drosophila", [
    makeFinding({
      title: "Cancer cachexia in Drosophila",
      doi: "10.1/a",
      confidence: "high",
    }),
    makeFinding({
      // Very irrelevant title — should not match the topic tokens.
      title: "Quantum chromodynamics",
      doi: "10.1/b",
      confidence: "high",
    }),
  ]);
  assert.equal(item.status, "RESOLVED");
});

test("classify: respects ambiguousGap option", () => {
  // Two candidates with a real score gap. With a wide threshold
  // (0.50) the gap is below the threshold → AMBIGUOUS. With a tight
  // threshold (0.10) the gap is above the threshold → RESOLVED.
  const candidates = [
    makeFinding({ title: "Cancer cachexia in Drosophila", doi: "10.1/a" }),
    makeFinding({ title: "Drosophila genetics overview", doi: "10.1/b" }),
  ];
  const wide = classify("cachexia drosophila", candidates, undefined, { ambiguousGap: 0.50 });
  assert.equal(wide.status, "AMBIGUOUS", "wide gap threshold opens ambiguity");

  const tight = classify("cachexia drosophila", candidates, undefined, { ambiguousGap: 0.10 });
  assert.equal(tight.status, "RESOLVED", "tight gap threshold closes ambiguity");
});

test("classify: scores carry the deterministic scoring trace", () => {
  const item = classify("cachexia drosophila", [makeFinding()]);
  assert.ok(item.scores);
  assert.equal(item.scores!.length, 1);
  assert.ok(item.scores![0]!.reasons.length > 0, "scoring reasons logged");
});

test("classify: claim tokens contribute to the score", () => {
  // When the claim adds a token that the candidate title does NOT contain,
  // the Jaccard denominator grows (union) but the numerator stays the same,
  // so the score DECREASES. This is the real effect of adding a claim:
  // irrelevant claims penalise irrelevant candidates, which is exactly
  // the behaviour we want from the disambiguator.
  const withoutClaim = classify(
    "cachexia",
    [makeFinding({ title: "Cancer cachexia in Drosophila" })],
  );
  const withIrrelevantClaim = classify(
    "cachexia",
    [makeFinding({ title: "Cancer cachexia in Drosophila" })],
    "elephant migration patterns in Africa", // adds tokens {elephant, migration, patterns, africa}
  );
  assert.ok(
    withIrrelevantClaim.scores![0]!.score < withoutClaim.scores![0]!.score,
    `irrelevant claim should lower score: without=${withoutClaim.scores![0]!.score} with=${withIrrelevantClaim.scores![0]!.score}`,
  );
});

test("classify: author overlap adds a bonus", () => {
  const withAuthor = classify(
    "topic",
    [makeFinding({ authors: [{ family: "Liu", given: "Y" }] })],
    "Liu showed that X is true",
  );
  const withoutAuthor = classify(
    "topic",
    [makeFinding({ authors: [{ family: "Smith", given: "J" }] })],
    "Liu showed that X is true",
  );
  assert.ok(
    withAuthor.scores![0]!.score > withoutAuthor.scores![0]!.score,
    "claim mentions Liu → first candidate scores higher",
  );
});

test("formatClarifyPrompt: empty list returns no-clarifications message", () => {
  assert.equal(formatClarifyPrompt([]), "No clarifications needed.");
});

test("formatClarifyPrompt: skips RESOLVED items", () => {
  const items = [classify("cachexia", [makeFinding()])];
  assert.equal(items[0]!.status, "RESOLVED");
  const text = formatClarifyPrompt(items);
  assert.match(text, /All citations resolved/);
  assert.doesNotMatch(text, /Topic: "cachexia"/);
});

test("formatClarifyPrompt: renders AMBIGUOUS with multiple candidates", () => {
  const items = [
    classify("cachexia drosophila", [
      makeFinding({ title: "Cancer cachexia in Drosophila", doi: "10.1/a" }),
      makeFinding({ title: "Cancer cachexia in Drosophila melanogaster", doi: "10.1/b" }),
    ]),
  ];
  const text = formatClarifyPrompt(items);
  assert.match(text, /CLARIFICATIONS NEEDED/);
  assert.match(text, /Topic: "cachexia drosophila"/);
  assert.match(text, /status: AMBIGUOUS/);
  assert.match(text, /\(a\) Cancer cachexia in Drosophila/);
  assert.match(text, /10\.1\/a/);
  assert.match(text, /10\.1\/b/);
});

test("formatClarifyPrompt: renders MISSING with [CITATION NEEDED] recommendation", () => {
  const items = [classify("obscure-topic", [])];
  const text = formatClarifyPrompt(items);
  assert.match(text, /Topic: "obscure-topic"/);
  assert.match(text, /status: MISSING/);
  assert.match(text, /\[CITATION NEEDED: obscure-topic\]/);
});

test("formatClarifyPrompt: includes claim context when provided", () => {
  const items = [classify("cachexia", [makeFinding()], "cachexia is a syndrome")];
  const text = formatClarifyPrompt(items);
  // single candidate with confidence high → RESOLVED → skipped
  // Force a REVIEW path to keep the item in the prompt:
  const reviewItems = [
    classify("cachexia", [makeFinding({ confidence: "low" })], "cachexia is a syndrome"),
  ];
  const reviewText = formatClarifyPrompt(reviewItems);
  assert.match(reviewText, /Claim: "cachexia is a syndrome"/);
});

test("serialiseClarifications: produces a stable JSON audit trail", () => {
  const items = [
    classify("Cancer cachexia in Drosophila", [makeFinding()], "cachexia is a syndrome"),
    classify("nothing-found", []),
  ];
  const json = JSON.parse(serialiseClarifications(items));
  assert.equal(json.schemaVersion, 1);
  assert.equal(json.items.length, 2);
  assert.equal(json.items[0].status, "RESOLVED");
  assert.equal(json.items[1].status, "MISSING");
  assert.ok(json.items[0].candidates.length > 0);
  assert.ok(typeof json.generatedAt === "string");
});
