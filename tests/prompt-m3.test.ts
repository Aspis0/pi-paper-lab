// tests/prompt-m3.test.ts
// Tests for the M3 prompt improvements: anti-hallucination guard,
// mandatory verify_citation, tighter formatting.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { buildCiteMarkPrompt } from "../src/pipeline.ts";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

test("buildCiteMarkPrompt: ANTI-HALLUCINATION block is present and the rejection bluff is honest", () => {
  const prompt = buildCiteMarkPrompt("/tmp/test.md", "Some text", "", false, "");
  assert.match(prompt, /ANTI-HALLUCINATION \(M3\)/);
  assert.match(prompt, /DOI INVARIANT/);
  // HIGH-4 fix: the bluff is no longer an outright threat.
  assert.match(prompt, /no code enforcement/);
  assert.ok(!/paper will be rejected/.test(prompt), "old bluff wording is gone");
});

test("buildCiteMarkPrompt: MANDATORY VERIFY_CITATION block describes the actual flow", () => {
  const prompt = buildCiteMarkPrompt("/tmp/test.md", "Some text", "", false, "");
  assert.match(prompt, /MANDATORY VERIFY_CITATION/);
  assert.match(prompt, /verify_citation\(claim_sentence, doi\)/);
  // HIGH-3 fix: explicit that the tool returns a structured prompt, not
  // a verdict directly. The LLM must read the abstract and decide.
  assert.match(prompt, /does NOT return a verdict directly/);
  assert.match(prompt, /MUST read the abstract/);
  // The three outcomes (SUPPORTS / REFUTES / UNCLEAR) are each on a
  // separate line in the prompt; assert each individually.
  assert.match(prompt, /SUPPORTS/);
  assert.match(prompt, /REFUTES/);
  assert.match(prompt, /UNCLEAR/);
  // MED-2 fix: a recovery path after REFUTES is now specified.
  assert.match(prompt, /re-run find_citation with a different query/);
});

test("buildCiteMarkPrompt: M2 block has the post-pick step (HIGH-1 fix)", () => {
  const prompt = buildCiteMarkPrompt("/tmp/test.md", "Some text", "", false, "");
  assert.match(prompt, /DISAMBIGUATION \(M2\)/);
  // HIGH-1 fix: the "After the user picks" step is back.
  assert.match(prompt, /After the user picks/);
  assert.match(prompt, /menu's labels ARE the candidate ids/);
});

test("buildCiteMarkPrompt: ANTI-HALLUCINATION reference to CITATIONS ALREADY PRESENT is conditional (HIGH-2 fix)", () => {
  // When there are no existing citations, the prompt must NOT mention
  // "CITATIONS ALREADY PRESENT" (it would point to a block that does
  // not exist). Extract the M3 block by capturing text between the
  // ANTI-HALLUCINATION header and the MANDATORY VERIFY_CITATION header.
  const noExisting = buildCiteMarkPrompt("/tmp/no-existing.md", "Fresh text", "", false, "");
  const m3Match = noExisting.match(/ANTI-HALLUCINATION \(M3\).*?(?=━━━ MANDATORY VERIFY_CITATION|$)/s);
  assert.ok(m3Match, "M3 block must be present in the prompt");
  const m3Block = m3Match[0]!;
  assert.ok(!/CITATIONS ALREADY PRESENT/.test(m3Block), "M3 block must not reference CITATIONS ALREADY PRESENT when no existing citations");
  assert.match(m3Block, /DOIs returned by find_citation/);
});

test("buildCiteMarkPrompt: when existing citations are present, the reference is included", async () => {
  // Write a sidecar with one existing citation, then build a prompt.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "p3-"));
  const md = path.join(dir, "test.md");
  await fs.writeFile(md, "# draft\nSome claim [1](<doi:10.1/exists>).\n", "utf-8");
  await fs.writeFile(path.join(dir, "test.citations.json"),
    JSON.stringify({ citations: { "1": { doi: "10.1/exists", vancouver: "1. existing. doi:10.1/exists" } } }),
    "utf-8",
  );
  const prompt = buildCiteMarkPrompt(md, "Some claim [1](<doi:10.1/exists>).", "", false, "");
  const m3Match = prompt.match(/ANTI-HALLUCINATION \(M3\).*?(?=━━━ MANDATORY VERIFY_CITATION|$)/s);
  assert.ok(m3Match, "M3 block must be present in the prompt");
  const m3Block = m3Match[0]!;
  assert.match(m3Block, /DOIs in CITATIONS ALREADY PRESENT/, "with existing citations, the reference must be present");
  await fs.rm(dir, { recursive: true });
});

test("buildCiteMarkPrompt: CITE step tells the LLM to pause for AMBIGUOUS menus (HIGH-5 fix)", () => {
  const prompt = buildCiteMarkPrompt("/tmp/test.md", "Some text", "", false, "");
  assert.match(prompt, /PAUSE the batch/);
  assert.match(prompt, /present the menu\(s\) to the user before proceeding/);
});

test("buildCiteMarkPrompt: uses heavy separators (━━━) for visual section breaks", () => {
  const prompt = buildCiteMarkPrompt("/tmp/test.md", "Some text", "", false, "");
  assert.match(prompt, /━━━ CITE ━━━/);
  assert.match(prompt, /━━━ FINALIZE ━━━/);
  assert.match(prompt, /━━━ REPORT ━━━/);
});

test("buildCiteMarkPrompt: prompt is shorter or equal to the v0.6 wall-of-text", () => {
  const prompt = buildCiteMarkPrompt("/tmp/test.md", "Some text", "", false, "");
  assert.ok(prompt.length < 8000, `prompt is ${prompt.length} chars; should be < 8000`);
});

