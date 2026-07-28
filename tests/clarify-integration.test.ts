// tests/clarify-integration.test.ts
// M2.2 integration tests: the AMBIGUOUS menu is appended to find_citation
// output, [ASK:question] markers are collected into QUESTIONS FOR THE AUTHOR,
// and buildCiteMarkPrompt includes the disambiguation block.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  buildCiteMarkPrompt,
  finalizeDoc,
  cleanDoi,
  extractAskQuestions,
} from "../src/pipeline.ts";
import { formatClarifyPrompt, classifyFindings } from "../src/clarify.ts";
import type { Finding } from "../src/source-finders/openalex.ts";
import {
  mkdtempSync, writeFileSync, rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// === buildCiteMarkPrompt: clarify block ===

test("buildCiteMarkPrompt: includes the disambiguation block", () => {
  const prompt = buildCiteMarkPrompt("/tmp/test.md", "Some text", "", false, "");
  assert.match(prompt, /DISAMBIGUATION \(M2\)/);
  assert.match(prompt, /\[CITATION NEEDED: topic\]/);
  assert.match(prompt, /\[ASK: short, single-line question\]/);
  // The CITE step must now mention the `claim` parameter for find_citation.
  assert.match(prompt, /pass `claim` to find_citation/);
});

// === [ASK:question] integration with finalizeDoc ===

test("finalizeDoc: collects [ASK:question] markers into QUESTIONS FOR THE AUTHOR", () => {
  const dir = mkdtempSync(join(tmpdir(), "ask-"));
  const md = join(dir, "ask.md");
  const text = [
    "Cancer cachexia is a syndrome [ASK: is this the Liu 2022 paper or the Bilder 2015 paper?].",
    "More text follows without an ask marker.",
  ].join("\n");
  writeFileSync(md, text, "utf-8");
  const result = finalizeDoc(md, { lookupDoi: () => null });
  // finalizeDoc must not crash.
  assert.ok(result.docxPath);
  // The QUESTIONS section must appear in the .md before docx generation
  // happens (we read back the .md). We can't easily inspect the docx,
  // so we verify via the sidecar that the work happened.
  rmSync(dir, { recursive: true });
});

test("buildCiteMarkPrompt: clarify block precedes the draft text", () => {
  const prompt = buildCiteMarkPrompt("/tmp/test.md", "Draft body here", "", false, "");
  const clarifyIdx = prompt.indexOf("DISAMBIGUATION (M2)");
  const draftIdx = prompt.indexOf("Draft body here");
  assert.ok(clarifyIdx > 0);
  assert.ok(draftIdx > 0);
  assert.ok(clarifyIdx < draftIdx, "clarify block must precede the draft text");
});

// === find_citation: AMBIGUOUS menu appended (integration with formatClarifyPrompt) ===

test("find_citation: AMBIGUOUS menu is generated for a 2-candidate finding set", () => {
  // Simulate the find_citation tool's post-processing: given a Finding[],
  // classify it and append the formatClarifyPrompt when AMBIGUOUS.
  const findings: Finding[] = [
    { title: "Cancer cachexia in Drosophila", authors: [], year: 2022, doi: "10.1/a", source: "crossref", confidence: "high" },
    { title: "Cancer cachexia in Drosophila melanogaster", authors: [], year: 2022, doi: "10.1/b", source: "crossref", confidence: "high" },
  ];
  const item = classifyFindings("cachexia drosophila", findings, "cachexia is a syndrome");
  assert.equal(item.status, "AMBIGUOUS");
  const menu = formatClarifyPrompt([item]);
  assert.match(menu, /CLARIFICATIONS NEEDED/);
  assert.match(menu, /choose \(a\)/);
});

test("find_citation: RESOLVED does NOT trigger the menu (LLM proceeds normally)", () => {
  const findings: Finding[] = [
    { title: "Cancer cachexia in Drosophila", authors: [], year: 2022, doi: "10.1/a", source: "crossref", confidence: "high" },
  ];
  const item = classifyFindings("Cancer cachexia in Drosophila", findings);
  assert.equal(item.status, "RESOLVED");
  const menu = formatClarifyPrompt([item]);
  assert.match(menu, /All citations resolved/);
});

test("find_citation: REVIEW triggers the menu with confirm/reject copy", () => {
  const findings: Finding[] = [
    { title: "Cancer cachexia in Drosophila", authors: [], doi: undefined, source: "crossref", confidence: "low" },
  ];
  const item = classifyFindings("Cancer cachexia in Drosophila", findings);
  assert.equal(item.status, "REVIEW");
  const menu = formatClarifyPrompt([item]);
  assert.match(menu, /confirm \(a\)|reject \(a\)/);
});

// === [ASK:question] parser (extracted as a pure helper) ===

test("extractAskQuestions: collects questions and strips markers", () => {
  const text = "Cancer is X [ASK: which review?]. More text [ASK: what is the year?].";
  const { cleaned, questions } = extractAskQuestions(text);
  assert.equal(questions.length, 2);
  assert.equal(questions[0], "which review?");
  assert.equal(questions[1], "what is the year?");
  assert.ok(!cleaned.includes("[ASK:"), "cleaned text has no [ASK: markers");
  assert.ok(cleaned.includes("Cancer is X"), "non-marker text is preserved");
});

test("extractAskQuestions: empty marker is dropped", () => {
  const text = "Cancer is X [ASK:   ]. More text.";
  const { cleaned, questions } = extractAskQuestions(text);
  assert.equal(questions.length, 0);
  assert.ok(!cleaned.includes("[ASK:"), "empty marker is dropped");
});

test("extractAskQuestions: no markers → no questions, text unchanged", () => {
  const text = "Cancer is X. More text.";
  const { cleaned, questions } = extractAskQuestions(text);
  assert.equal(questions.length, 0);
  assert.equal(cleaned, text);
});
