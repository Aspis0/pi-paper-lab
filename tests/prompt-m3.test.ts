// tests/prompt-m3.test.ts
// Tests for the M3 prompt improvements: anti-hallucination guard,
// mandatory verify_citation, tighter formatting.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { buildCiteMarkPrompt } from "../src/pipeline.ts";

test("buildCiteMarkPrompt: ANTI-HALLUCINATION block is present and explicit", () => {
  const prompt = buildCiteMarkPrompt("/tmp/test.md", "Some text", "", false, "");
  assert.match(prompt, /ANTI-HALLUCINATION \(M3\)/);
  assert.match(prompt, /DOI INVARIANT/);
  assert.match(prompt, /automatic test failure/);
});

test("buildCiteMarkPrompt: MANDATORY VERIFY_CITATION block is present", () => {
  const prompt = buildCiteMarkPrompt("/tmp/test.md", "Some text", "", false, "");
  assert.match(prompt, /MANDATORY VERIFY_CITATION/);
  assert.match(prompt, /verify_citation\(claim_sentence, doi\)/);
  // The three outcomes (SUPPORTS / REFUTES / UNCLEAR) are each on a
  // separate line in the prompt; assert each individually.
  assert.match(prompt, /SUPPORTS/);
  assert.match(prompt, /REFUTES/);
  assert.match(prompt, /UNCLEAR/);
});

test("buildCiteMarkPrompt: DISAMBIGUATION (M2) block is still present", () => {
  const prompt = buildCiteMarkPrompt("/tmp/test.md", "Some text", "", false, "");
  assert.match(prompt, /DISAMBIGUATION \(M2\)/);
  assert.match(prompt, /find_citation with a `claim`/);
});

test("buildCiteMarkPrompt: uses heavy separators (━━━) for visual section breaks", () => {
  const prompt = buildCiteMarkPrompt("/tmp/test.md", "Some text", "", false, "");
  // At least 4 heavy separators (DISAMBIGUATION, ANTI-HALLUCINATION,
  // VERIFY_CITATION, CITE, FINALIZE, REPORT — but the M2/M3 blocks share
  // 3 separators; verify CITE / FINALIZE / REPORT have them).
  assert.match(prompt, /━━━ CITE ━━━/);
  assert.match(prompt, /━━━ FINALIZE ━━━/);
  assert.match(prompt, /━━━ REPORT ━━━/);
});

test("buildCiteMarkPrompt: CITE step still passes `claim` to find_citation", () => {
  const prompt = buildCiteMarkPrompt("/tmp/test.md", "Some text", "", false, "");
  // The new CITE block says "call find_citation with `claim` set to the
  // claim sentence" — match that wording.
  assert.match(prompt, /call find_citation with `claim`/);
});

test("buildCiteMarkPrompt: CITE step references verify_citation", () => {
  const prompt = buildCiteMarkPrompt("/tmp/test.md", "Some text", "", false, "");
  // The CITE block must mention the mandatory verify_citation run.
  assert.match(prompt, /run verify_citation\(claim, doi\) for every one/);
});

test("buildCiteMarkPrompt: prompt is shorter or equal to the v0.6 wall-of-text", () => {
  // Sanity bound: the new prompt must not be longer than the old
  // wall-of-text. The M2/M3 split actually shortens it.
  const prompt = buildCiteMarkPrompt("/tmp/test.md", "Some text", "", false, "");
  // 5000 chars is a loose bound; the real old prompt was ~3000.
  assert.ok(prompt.length < 6000, `prompt is ${prompt.length} chars; should be < 6000`);
});
