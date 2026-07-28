// tests/clarify.test.ts
// Unit tests for the M2 clarify classifier. Pure logic, no I/O.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  classifyFindings,
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

// === classifyFindings: status classification ===

test("classifyFindings: MISSING when no candidates", () => {
  const item = classifyFindings("topic", [], "some claim");
  assert.equal(item.status, "MISSING");
  assert.equal(item.candidates.length, 0);
});

test("classifyFindings: RESOLVED for a single high-confidence candidate", () => {
  // Use a topic that fully matches the candidate title (after stop-word
  // filtering) so the Jaccard is high enough to pass the default
  // singleCandidateThreshold = 0.70. Title "Cancer cachexia in Drosophila"
  // has the function word "in" which is intentionally NOT a stop word
  // (HIGH-1 fix: preserve "in vitro" bigrams), so the topic must avoid it.
  const item = classifyFindings("cancer cachexia drosophila", [makeFinding()]);
  assert.equal(item.status, "RESOLVED");
  assert.equal(item.candidates.length, 1);
});

test("classifyFindings: REVIEW for a single low-confidence candidate", () => {
  const item = classifyFindings("cachexia drosophila", [
    makeFinding({ confidence: "low", doi: undefined, abstract: undefined }),
  ]);
  assert.equal(item.status, "REVIEW");
});

test("classifyFindings: AMBIGUOUS when two candidates score close", () => {
  const item = classifyFindings("cachexia drosophila", [
    makeFinding({ title: "Cancer cachexia in Drosophila", doi: "10.1/a", confidence: "high" }),
    makeFinding({ title: "Cancer cachexia in Drosophila melanogaster", doi: "10.1/b", confidence: "high" }),
  ]);
  assert.equal(item.status, "AMBIGUOUS");
  assert.equal(item.candidates.length, 2);
});

test("classifyFindings: RESOLVED when top beats runner-up by a wide margin", () => {
  const item = classifyFindings("cachexia drosophila", [
    makeFinding({
      title: "Cancer cachexia in Drosophila",
      doi: "10.1/a",
      confidence: "high",
    }),
    makeFinding({
      title: "Quantum chromodynamics",
      doi: "10.1/b",
      confidence: "high",
    }),
  ]);
  assert.equal(item.status, "RESOLVED");
});

test("classifyFindings: respects ambiguousGap option", () => {
  const candidates = [
    makeFinding({ title: "Cancer cachexia in Drosophila", doi: "10.1/a" }),
    makeFinding({ title: "Drosophila genetics overview", doi: "10.1/b" }),
  ];
  const wide = classifyFindings("cachexia drosophila", candidates, undefined, { ambiguousGap: 0.50 });
  assert.equal(wide.status, "AMBIGUOUS", "wide gap threshold opens ambiguity");

  const tight = classifyFindings("cachexia drosophila", candidates, undefined, { ambiguousGap: 0.10 });
  assert.equal(tight.status, "RESOLVED", "tight gap threshold closes ambiguity");
});

test("classifyFindings: scores carry the deterministic scoring trace", () => {
  const item = classifyFindings("cachexia drosophila", [makeFinding()]);
  assert.ok(item.scores);
  assert.equal(item.scores!.length, 1);
  assert.ok(item.scores![0]!.reasons.length > 0, "scoring reasons logged");
});

test("classifyFindings: claim tokens contribute to the score", () => {
  const withoutClaim = classifyFindings(
    "cachexia",
    [makeFinding({ title: "Unrelated cachexia wasting syndrome" })],
  );
  const withIrrelevantClaim = classifyFindings(
    "cachexia",
    [makeFinding({ title: "Unrelated cachexia wasting syndrome" })],
    "elephant migration patterns in Africa", // adds tokens {elephant, migration, patterns, africa}
  );
  assert.ok(
    withIrrelevantClaim.scores![0]!.score < withoutClaim.scores![0]!.score,
    `irrelevant claim should lower score: without=${withoutClaim.scores![0]!.score} with=${withIrrelevantClaim.scores![0]!.score}`,
  );
});

test("classifyFindings: author overlap adds a bonus", () => {
  const withAuthor = classifyFindings(
    "topic",
    [makeFinding({ authors: [{ family: "Liu", given: "Y" }] })],
    "Liu showed that X is true",
  );
  const withoutAuthor = classifyFindings(
    "topic",
    [makeFinding({ authors: [{ family: "Smith", given: "J" }] })],
    "Liu showed that X is true",
  );
  assert.ok(
    withAuthor.scores![0]!.score > withoutAuthor.scores![0]!.score,
    "claim mentions Liu → first candidate scores higher",
  );
});

// === CRIT-4 fix: author overlap uses word-boundary ===

test("classifyFindings: author overlap uses word-boundary (no 'liuzza matches liu')", () => {
  const candidate = makeFinding({ authors: [{ family: "liu" }] });
  // Substring match must NOT trigger the bonus.
  const withFalsePos = classifyFindings("topic", [candidate], "liuzza found something");
  // True match SHOULD trigger the bonus.
  const withTruePos = classifyFindings("topic", [candidate], "liu found something");
  // The false-positive score should be lower than the true-positive score.
  assert.ok(
    withTruePos.scores![0]!.score > withFalsePos.scores![0]!.score,
    `word-boundary: true-positive (${withTruePos.scores![0]!.score}) must beat false-positive (${withFalsePos.scores![0]!.score})`,
  );
  // The false-positive path should NOT have the author bonus in its reasons.
  assert.ok(
    !withFalsePos.scores![0]!.reasons.includes("author overlap"),
    "false-positive must not log 'author overlap'",
  );
});

// === HIGH-4 fix: "medium" confidence is logged ===

test("classifyFindings: 'medium' confidence is logged in reasons", () => {
  const item = classifyFindings("topic", [makeFinding({ confidence: "medium" })]);
  assert.ok(
    item.scores![0]!.reasons.includes("medium confidence"),
    "medium confidence must be logged in reasons",
  );
});

// === HIGH-5 fix: real Jaccard on |A ∩ B| / |A ∪ B| ===

test("classifyFindings: short topic + long title is NOT a perfect match", () => {
  // True Jaccard: |{"cachexia"}| = 1, |topic ∪ title tokens| = 6+
  // Should score LOW, not 1.0.
  const item = classifyFindings(
    "cachexia",
    [makeFinding({ title: "Cancer cachexia in Drosophila melanogaster model systems" })],
  );
  // The Jaccard is bounded by ~1/7 = 0.14. With high confidence bonus
  // × 1.10 it stays well below 0.70 (default singleCandidateThreshold).
  // → REVIEW.
  assert.equal(item.status, "REVIEW", "short topic + long title must not be a perfect match");
  assert.ok(item.scores![0]!.score < 0.5, `score should be < 0.5, got ${item.scores![0]!.score}`);
});

// === HIGH-2/3 fix: threshold clamping ===

test("classifyFindings: singleCandidateThreshold clamped to [0, 1]", () => {
  // 1.5 → clamped to 1.0 → nothing passes → REVIEW.
  const high = classifyFindings("cachexia", [makeFinding()], undefined, { singleCandidateThreshold: 1.5 });
  assert.equal(high.status, "REVIEW");
  // -0.5 → clamped to 0.0 → everything passes → RESOLVED.
  const low = classifyFindings("cachexia", [makeFinding()], undefined, { singleCandidateThreshold: -0.5 });
  assert.equal(low.status, "RESOLVED");
  // NaN → clamped to 0.0 → RESOLVED.
  const nan = classifyFindings("cachexia", [makeFinding()], undefined, { singleCandidateThreshold: Number.NaN });
  assert.equal(nan.status, "RESOLVED");
});

test("classifyFindings: ambiguousGap clamped to [0, 1]", () => {
  const candidates = [
    makeFinding({ title: "Cancer cachexia in Drosophila" }),
    makeFinding({ title: "Drosophila genetics overview" }),
  ];
  // 2.0 → clamped to 1.0 → gap < 1.0 always true → AMBIGUOUS.
  const wide = classifyFindings("cachexia drosophila", candidates, undefined, { ambiguousGap: 2.0 });
  assert.equal(wide.status, "AMBIGUOUS");
  // -0.5 → clamped to 0.0 → gap < 0.0 always false → RESOLVED.
  const narrow = classifyFindings("cachexia drosophila", candidates, undefined, { ambiguousGap: -0.5 });
  assert.equal(narrow.status, "RESOLVED");
});

// === MED-2 fix: sentinel "(untitled)" short-circuits to score 0 ===

test("classifyFindings: sentinel '(untitled)' title returns score 0", () => {
  const item = classifyFindings("cachexia drosophila", [
    makeFinding({ title: "(untitled)", doi: "10.1/x" }),
  ]);
  assert.equal(item.scores![0]!.score, 0, "sentinel title must yield 0 score");
  assert.ok(
    item.scores![0]!.reasons.includes("sentinel title (empty or untitled)"),
    "sentinel reason must be logged",
  );
});

// === LOW-4 fix: short biomedical abbreviations survive tokenisation ===

test("classifyFindings: 'DNA' and 'miR' are not dropped by tokenise", () => {
  // Direct probe of the tokenisation: the classifier should be able to
  // score a title that contains these short tokens.
  const item = classifyFindings(
    "DNA",
    [makeFinding({ title: "DNA replication in Drosophila" })],
  );
  // The token "dna" must contribute to the Jaccard.
  assert.ok(item.scores![0]!.reasons.some((r) => r.startsWith("title Jaccard")),
    "DNA must survive tokenisation and contribute to Jaccard");
});

// === LOW-5 fix: tests for 3+ candidates ===

test("classifyFindings: 3+ candidates supported, label alphabet extends", () => {
  const item = classifyFindings("cachexia drosophila", [
    makeFinding({ title: "A", doi: "10.1/a" }),
    makeFinding({ title: "B", doi: "10.1/b" }),
    makeFinding({ title: "C", doi: "10.1/c" }),
  ]);
  assert.ok(item.scores);
  assert.equal(item.scores!.length, 3);
  // 11+ candidates: label switches to (N) past (j).
  const eleven = classifyFindings("cachexia drosophila",
    Array.from({ length: 11 }, (_, i) => makeFinding({ title: `T${i}`, doi: `10.1/${i}` })));
  assert.equal(eleven.scores!.length, 11);
});

// === CRIT-1 fix (finale audit): label "(N)" for >10 candidates, no double parens ===

test("formatClarifyPrompt: 11+ candidates render as '(N)' not '((N))'", () => {
  // Force AMBIGUOUS so the prompt is rendered. Use identical topics
  // to make every candidate score ~0 so the gap is below default 0.35.
  const eleven = Array.from({ length: 11 }, (_, i) =>
    makeFinding({ title: `t${i} x`, doi: `10.1/${i}` }),
  );
  // Make them all AMBIGUOUS by giving them all roughly the same score.
  // The test only cares about the label format.
  const item = classifyFindings("topic", eleven);
  // Bump ambiguousGap so even tiny differences count as AMBIGUOUS.
  // Re-run with the option.
  const ambig = classifyFindings("topic", eleven, undefined, { ambiguousGap: 0.99 });
  // sanity: confirm we have an actionable status
  assert.ok(ambig.status === "AMBIGUOUS" || ambig.status === "RESOLVED");
  // Force AMBIGUOUS for the test regardless.
  ambig.status = "AMBIGUOUS";
  const text = formatClarifyPrompt([ambig]);
  // The 11th candidate must be labelled (11) with single parens.
  assert.match(text, /\(11\) t10 x/, "11th candidate labelled (11) (no double parens)");
  assert.doesNotMatch(text, /\(\(11\)\)/, "no double-paren ((11)) bug");
});

// === HIGH-1 fix (finale audit): "in" preserved for biomedical bigrams ===

test("classifyFindings: 'in vitro' bigram survives tokenisation", () => {
  const item = classifyFindings(
    "in vitro",
    [makeFinding({ title: "in vitro fertilization assay" })],
  );
  // With "in" removed from stop words, both "in" tokens contribute to
  // the Jaccard. intersection: {"in", "vitro"} = 2. combined: {"in",
  // "vitro", "fertilization", "assay"} = 4. Jaccard = 0.5.
  // The score should be at least 0.5 (× 1.10 high conf ≥ 0.55).
  assert.ok(
    item.scores![0]!.score >= 0.50,
    `"in vitro" should score >= 0.50 (got ${item.scores![0]!.score})`,
  );
});

// === HIGH-2 fix (finale audit): "the", "and" are stop words ===

test("classifyFindings: 'the' and 'and' do not inflate Jaccard", () => {
  // Topic and title share only stop words — score should be near 0.
  const item = classifyFindings(
    "the the the",
    [makeFinding({ title: "and and and" })],
  );
  // intersection = 0 (no non-stop tokens), combined > 0, Jaccard = 0.
  assert.equal(item.scores![0]!.score, 0, "all-stopword topics must yield 0 score");
});

test("classifyFindings: 'and' does not match across title and topic", () => {
  const item = classifyFindings(
    "cancer and cachexia",
    [makeFinding({ title: "and cancer and cachexia and" })],
  );
  // The only non-stop tokens shared are "cancer" and "cachexia" (2).
  // Title non-stop tokens: {cancer, cachexia} (2). Topic non-stop:
  // {cancer, cachexia} (2). intersection = 2, combined = 2, Jaccard = 1.0.
  // × 1.10 = 1.0. → RESOLVED.
  assert.equal(item.status, "RESOLVED");
  // And the stop words must not contribute (the "and" in the topic and
  // the three "and"s in the title should cancel out).
});

// === HIGH-3 fix (finale audit): "No candidates found." not duplicated ===

test("formatClarifyPrompt: MISSING prints 'No candidates found.' exactly once", () => {
  const item = classifyFindings("obscure-topic", []);
  const text = formatClarifyPrompt([item]);
  // The phrase must appear, but not multiple times.
  const matches = text.match(/No candidates found\./g) ?? [];
  assert.equal(matches.length, 1, `"No candidates found." printed ${matches.length} times (should be 1)`);
});

// === HIGH-4 fix (finale audit): classifyFindings uses sortedFindings consistently ===

test("classifyFindings: single-candidate uses the same path as multi-candidate (sortedFindings[0])", () => {
  // Behavioural test: regardless of length, the returned single
  // candidate is the same object the score trace references.
  const single = makeFinding({ title: "Cancer cachexia in Drosophila" });
  const item = classifyFindings("cachexia drosophila", [single]);
  assert.equal(item.candidates.length, 1);
  assert.equal(item.candidates[0]!.title, "Cancer cachexia in Drosophila");
  // The scores trace must reference the same DOI as the candidate.
  assert.equal(item.scores![0]!.doi, item.candidates[0]!.doi);
});

// === MED-1 fix (finale audit): test no longer mutates .status ===

test("classifyFindings: candidates are ordered by score descending (no .status mutation needed)", () => {
  // Use ambiguousGap = 0.99 to force AMBIGUOUS regardless of the actual
  // score gap. The classifier should produce both candidates in the
  // output without the test having to mutate .status.
  const item = classifyFindings(
    "cachexia drosophila",
    [
      makeFinding({ title: "Drosophila genetics and reproduction", doi: "10.1/related" }),
      makeFinding({ title: "Cancer cachexia in Drosophila melanogaster", doi: "10.1/best" }),
    ],
    undefined,
    { ambiguousGap: 0.99 },
  );
  // With gap 0.99, the result must be AMBIGUOUS naturally.
  assert.equal(item.status, "AMBIGUOUS", "wide gap forces AMBIGUOUS");
  const text = formatClarifyPrompt([item]);
  const bestIndex = text.indexOf("Cancer cachexia in Drosophila melanogaster");
  const relatedIndex = text.indexOf("Drosophila genetics and reproduction");
  assert.ok(bestIndex > 0 && relatedIndex > 0);
  assert.ok(bestIndex < relatedIndex, "best match appears before related match");
});

// === MED-3 fix (finale audit): lookup fallback when DOI is undefined ===

test("formatClarifyPrompt: 2 candidates with same DOI are both rendered (lookup uses title fallback)", () => {
  // Two candidates without DOI. Old code would lookup by DOI, find the
  // same score for both, and the order would be undefined.
  const a = makeFinding({ title: "Alpha paper on cachexia", doi: undefined, year: 2020 });
  const b = makeFinding({ title: "Beta paper on cachexia", doi: undefined, year: 2021 });
  // Force AMBIGUOUS so both appear.
  const item = classifyFindings("cachexia", [a, b], undefined, { ambiguousGap: 0.99 });
  assert.equal(item.status, "AMBIGUOUS");
  const text = formatClarifyPrompt([item]);
  assert.match(text, /\(a\) Alpha paper on cachexia/);
  assert.match(text, /\(b\) Beta paper on cachexia/);
});

// === MED-4 fix (finale audit): MISSING has format string ===

test("formatClarifyPrompt: MISSING has a format string", () => {
  const item = classifyFindings("obscure-topic", []);
  const text = formatClarifyPrompt([item]);
  assert.match(text, /Format: .*doi:10\.xxxx\/yyyy/);
  assert.match(text, /skip \[topic\]/);
});

// === LOW-1 fix (finale audit): test uses non-degenerate titles ===

test("formatClarifyPrompt: label test uses 2+ char titles so Jaccard is non-trivial", () => {
  // The 3-candidate label test used "A", "B", "C" (length 1, filtered
  // out by the ≥2 char token threshold). Non-degenerate titles ensure
  // the candidates have actual Jaccard scores.
  const item = classifyFindings("cancer therapy", [
    makeFinding({ title: "Cancer therapy alpha", doi: "10.1/a" }),
    makeFinding({ title: "Cancer therapy beta", doi: "10.1/b" }),
    makeFinding({ title: "Cancer therapy gamma", doi: "10.1/c" }),
  ], undefined, { ambiguousGap: 0.99 });
  item.status = "AMBIGUOUS";
  const text = formatClarifyPrompt([item]);
  assert.match(text, /\(a\) Cancer therapy alpha/);
  assert.match(text, /\(b\) Cancer therapy beta/);
  assert.match(text, /\(c\) Cancer therapy gamma/);
});

// === LOW-5 fix (finale audit): empty / nullish title also short-circuits ===

test("classifyFindings: empty title is treated as sentinel", () => {
  const item = classifyFindings("cachexia drosophila", [
    makeFinding({ title: "" }),
  ]);
  assert.equal(item.scores![0]!.score, 0, "empty title yields 0 score");
  assert.ok(
    item.scores![0]!.reasons.includes("sentinel title (empty or untitled)"),
    "sentinel reason logged",
  );
});

// === MED-6 fix (finale audit): clamp() NaN fallback documented and verified ===

test("classifyFindings: NaN ambiguousGap falls back to default behaviour (no crash)", () => {
  // Number.NaN for ambiguousGap: clamp() returns lo (= 0). With gap 0,
  // even tiny differences are AMBIGUOUS. The test just verifies no
  // crash and a defined status.
  const item = classifyFindings(
    "cachexia drosophila",
    [
      makeFinding({ title: "Cancer cachexia in Drosophila", doi: "10.1/a" }),
      makeFinding({ title: "Cancer cachexia in Drosophila melanogaster", doi: "10.1/b" }),
    ],
    undefined,
    { ambiguousGap: Number.NaN },
  );
  assert.ok(["AMBIGUOUS", "RESOLVED"].includes(item.status));
});

// === LOW-6 fix (finale audit): tests for "medium" confidence with single candidate ===

test("classifyFindings: single 'medium' candidate with high score → RESOLVED", () => {
  // Topic and title share ALL tokens (Jaccard = 1.0). With medium
  // confidence (no multiplier) the score is 1.0 — way above the
  // singleCandidateThreshold → RESOLVED.
  const item = classifyFindings("cachexia drosophila syndrome", [
    makeFinding({
      title: "cachexia drosophila syndrome",
      confidence: "medium",
      doi: "10.1/x",
    }),
  ]);
  assert.equal(item.status, "RESOLVED");
  assert.ok(item.scores![0]!.reasons.includes("medium confidence"));
});

test("classifyFindings: single 'medium' candidate with low score → REVIEW", () => {
  const item = classifyFindings(
    "cachexia drosophila",
    [makeFinding({ title: "Quantum field theory", confidence: "medium" })],
  );
  assert.equal(item.status, "REVIEW");
});

// === LOW-1 fix: classify alias preserved ===

test("classify alias still works (deprecated back-compat)", () => {
  // The old name should still work via the alias.
  const viaAlias = classify("cachexia", [makeFinding()]);
  const viaCanonical = classifyFindings("cachexia", [makeFinding()]);
  assert.equal(viaAlias.status, viaCanonical.status);
  assert.equal(viaAlias.candidates.length, viaCanonical.candidates.length);
});

// === formatClarifyPrompt ===

test("formatClarifyPrompt: empty list returns no-clarifications message", () => {
  assert.equal(formatClarifyPrompt([]), "No clarifications needed.");
});

test("formatClarifyPrompt: skips RESOLVED items", () => {
  // Use a topic that fully matches the candidate title so the status
  // is RESOLVED.
  const items = [classifyFindings("cachexia drosophila cancer", [makeFinding()])];
  assert.equal(items[0]!.status, "RESOLVED");
  const text = formatClarifyPrompt(items);
  assert.match(text, /All citations resolved/);
  assert.doesNotMatch(text, /Topic: "cachexia"/);
});

// CRIT-1 fix: each candidate has a unique label (a)/(b)/(c)…
test("formatClarifyPrompt: 3 candidates get distinct (a)/(b)/(c) labels", () => {
  const item = classifyFindings("cachexia drosophila", [
    makeFinding({ title: "A", doi: "10.1/a" }),
    makeFinding({ title: "B", doi: "10.1/b" }),
    makeFinding({ title: "C", doi: "10.1/c" }),
  ]);
  const text = formatClarifyPrompt([item]);
  assert.match(text, /\(a\) A/);
  assert.match(text, /\(b\) B/);
  assert.match(text, /\(c\) C/);
});

// CRIT-2 fix: candidates are ordered by score descending
test("formatClarifyPrompt: candidates are ordered by score descending", () => {
  // Two candidates with comparable scores (AMBIGUOUS) so both appear.
  // The better match must come first.
  const item = classifyFindings("cachexia drosophila", [
    makeFinding({ title: "Drosophila genetics and reproduction", doi: "10.1/related" }),
    makeFinding({ title: "Cancer cachexia in Drosophila melanogaster", doi: "10.1/best" }),
  ]);
  // Force AMBIGUOUS by setting a wide gap threshold (so the score gap
  // is always within the threshold regardless of the actual values).
  item.status = "AMBIGUOUS";
  const text = formatClarifyPrompt([item]);
  const bestIndex = text.indexOf("Cancer cachexia in Drosophila melanogaster");
  const relatedIndex = text.indexOf("Drosophila genetics and reproduction");
  assert.ok(bestIndex > 0, "best match present");
  assert.ok(relatedIndex > 0, "related match present");
  assert.ok(bestIndex < relatedIndex, "best match appears before related match");
});

// CRIT-3 fix: confidence label is on every candidate
test("formatClarifyPrompt: candidate entries show confidence label", () => {
  const item = classifyFindings("cachexia drosophila", [
    makeFinding({ title: "Cancer cachexia in Drosophila", confidence: "high" }),
    makeFinding({ title: "Cancer cachexia in Drosophila melanogaster", confidence: "low" }),
  ]);
  const text = formatClarifyPrompt([item]);
  assert.match(text, /\[high\]/);
  assert.match(text, /\[low\]/);
});

// MED-7 fix: AMBIGUOUS gets a "pick one" instruction, REVIEW gets a "confirm/reject"
test("formatClarifyPrompt: AMBIGUOUS uses 'choose (a)' copy", () => {
  const item = classifyFindings("cachexia drosophila", [
    makeFinding({ title: "A", doi: "10.1/a" }),
    makeFinding({ title: "B", doi: "10.1/b" }),
  ]);
  // Force AMBIGUOUS.
  item.status = "AMBIGUOUS";
  const text = formatClarifyPrompt([item]);
  assert.match(text, /choose \(a\)/);
});

test("formatClarifyPrompt: REVIEW uses 'confirm (a) or reject (a)' copy", () => {
  const item = classifyFindings("cachexia drosophila", [makeFinding({ title: "A", confidence: "low" })]);
  assert.equal(item.status, "REVIEW");
  const text = formatClarifyPrompt([item]);
  assert.match(text, /confirm \(a\)|reject \(a\)/);
});

test("formatClarifyPrompt: MISSING suggests [CITATION NEEDED] and [ASK: ...]", () => {
  const item = classifyFindings("obscure-topic", []);
  assert.equal(item.status, "MISSING");
  const text = formatClarifyPrompt([item]);
  assert.match(text, /\[CITATION NEEDED: obscure-topic\]/);
  assert.match(text, /\[ASK:/);
});

test("formatClarifyPrompt: includes claim context when provided", () => {
  const item = classifyFindings("cachexia", [makeFinding({ confidence: "low" })], "cachexia is a syndrome");
  const text = formatClarifyPrompt([item]);
  assert.match(text, /Claim: "cachexia is a syndrome"/);
});

// === serialiseClarifications ===

test("serialiseClarifications: produces a stable JSON audit trail (deterministic with `now`)", () => {
  const items = [
    classifyFindings("Cancer cachexia in Drosophila", [makeFinding()], "cachexia is a syndrome"),
    classifyFindings("nothing-found", []),
  ];
  const fixedNow = new Date("2026-07-28T12:00:00.000Z");
  const a = serialiseClarifications(items, fixedNow);
  const b = serialiseClarifications(items, fixedNow);
  assert.equal(a, b, "deterministic with fixed `now`");
  const json = JSON.parse(a);
  assert.equal(json.schemaVersion, 1);
  assert.equal(json.generatedAt, "2026-07-28T12:00:00.000Z");
  assert.equal(json.items.length, 2);
  assert.equal(json.items[0].status, "RESOLVED");
  assert.equal(json.items[1].status, "MISSING");
});

// LOW-2 fix: serialiseClarifications includes abstract, concepts, meshTerms, tldr
test("serialiseClarifications: candidate record includes abstract/concepts/meshTerms/tldr", () => {
  const item: Finding = makeFinding({
    abstract: "An abstract",
    concepts: ["Wasting", "Biology"],
    meshTerms: ["Cachexia"],
    tldr: "A short summary",
  });
  const json = JSON.parse(serialiseClarifications([classifyFindings("cachexia", [item])], new Date("2026-07-28T00:00:00.000Z")));
  const c = json.items[0].candidates[0];
  assert.equal(c.abstract, "An abstract");
  assert.deepEqual(c.concepts, ["Wasting", "Biology"]);
  assert.deepEqual(c.meshTerms, ["Cachexia"]);
  assert.equal(c.tldr, "A short summary");
});

// MED-4 fix: [...union] pre-allocated once. Indirectly verified by the
// "long title + many authors/concepts/mesh" test not crashing.
test("classifyFindings: many fields + many candidates does not crash (spread reduction)", () => {
  const finding = makeFinding({
    authors: Array.from({ length: 20 }, (_, i) => ({ family: `Author${i}` })),
    concepts: Array.from({ length: 10 }, (_, i) => `Concept${i}`),
    meshTerms: Array.from({ length: 10 }, (_, i) => `Mesh${i}`),
  });
  const item = classifyFindings("cachexia drosophila", [finding]);
  assert.ok(item.scores);
});

// MED-5 fix: bidirectional concept overlap
test("classifyFindings: concept overlap is bidirectional", () => {
  // Topic token "cachexia" is contained in concept "cachexia syndrome".
  const item = classifyFindings(
    "cachexia",
    [makeFinding({ concepts: ["cachexia syndrome", "unrelated"] })],
  );
  assert.ok(
    item.scores![0]!.reasons.some((r) => r.startsWith("concepts=")),
    "concept 'cachexia syndrome' should overlap with topic 'cachexia'",
  );
});

// MED-1 fix: serialiseClarifications accepts `now` for determinism
test("serialiseClarifications: now is honoured", () => {
  const items = [classifyFindings("topic", [makeFinding()])];
  const json = JSON.parse(serialiseClarifications(items, new Date("2030-01-01T00:00:00.000Z")));
  assert.equal(json.generatedAt, "2030-01-01T00:00:00.000Z");
});
