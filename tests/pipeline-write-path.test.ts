// tests/pipeline-write-path.test.ts
// Tests for the auto-derived output path in pipelineWrite. The LLM
// does NOT have to remember --output; two calls with different
// descriptions produce different files via the slugified default.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { sep as pathSep } from "node:path";
import { resolveDefaultOutPath } from "../src/pipeline.ts";

test("resolveDefaultOutPath: two different descriptions produce different files", () => {
  const out1 = resolveDefaultOutPath("Write an intro section about cachexia", {
    outputDir: "/tmp/test-x",
  });
  const out2 = resolveDefaultOutPath("Write the methods section about Drosophila", {
    outputDir: "/tmp/test-x",
  });
  assert.notEqual(out1, out2, "different descriptions must produce different file names");
  assert.ok(out1.endsWith(".md"));
  assert.ok(out2.endsWith(".md"));
});

test("resolveDefaultOutPath: explicit outputPath wins over the auto-derived default", () => {
  const out = resolveDefaultOutPath("Write about cachexia", {
    outputDir: "/tmp/should-be-ignored",
    outputPath: "/tmp/explicit.md",
  });
  assert.equal(out, "/tmp/explicit.md");
});

test("resolveDefaultOutPath: same description twice goes to the same file", () => {
  const out1 = resolveDefaultOutPath("Write about cachexia", { outputDir: "/tmp/test-y" });
  const out2 = resolveDefaultOutPath("Write about cachexia", { outputDir: "/tmp/test-y" });
  assert.equal(out1, out2, "same description: same filename");
});

test("resolveDefaultOutPath: default outputDir is <cwd>/paper-write-out/ when not specified", () => {
  const out = resolveDefaultOutPath("Write about cachexia");
  // With stop-word filter: "write" and "about" are filtered out.
  // Only "cachexia" remains.
  assert.ok(out.endsWith("paper-write-out" + pathSep + "cachexia.md"), `out=${out}`);
});

test("resolveDefaultOutPath: slug strips punctuation and limits to 5 tokens", () => {
  // The slug must NOT contain apostrophes, commas, or special chars.
  // It MUST be no more than 5 tokens long.
  const out = resolveDefaultOutPath(
    "The CRISPR-Cas9 model: a review, part one!",
    { outputDir: "/tmp/test-z" },
  );
  // Filename component (between the last separator and .md).
  const m = out.match(/[\\\/]([^\\\/]+)\.md$/);
  assert.ok(m, "filename component must be present");
  const stem = m[1]!;
  // No special chars in the stem.
  assert.ok(!/[!'",:?]/.test(stem), "no punctuation in the stem");
  // At most 5 hyphen-separated tokens.
  assert.ok(stem.split("-").length <= 5, `stem has more than 5 tokens: ${stem}`);
});

test("resolveDefaultOutPath: empty or non-alphanumeric description falls back to 'paper'", () => {
  const out1 = resolveDefaultOutPath("!!!", { outputDir: "/tmp/test-w" });
  const out2 = resolveDefaultOutPath("", { outputDir: "/tmp/test-w" });
  assert.ok(out1.endsWith(pathSep + "paper.md"), `out1=${out1}`);
  assert.ok(out2.endsWith(pathSep + "paper.md"), `out2=${out2}`);
});

test("resolveDefaultOutPath: hyphenated abbreviations are preserved (MED-2 fix)", () => {
  // Split only on whitespace, not on hyphens, so "T-to-C" stays as "t-to-c"
  // instead of being split into ["t", "to", "c"] (all < 3 chars, all filtered).
  const out1 = resolveDefaultOutPath("T-to-C conversion in Drosophila", { outputDir: "/tmp/test-h" });
  const out2 = resolveDefaultOutPath("A-to-G conversion in Drosophila", { outputDir: "/tmp/test-h" });
  const stem1 = out1.split(pathSep).pop()!.replace(".md", "");
  const stem2 = out2.split(pathSep).pop()!.replace(".md", "");
  // "t-to-c" and "a-to-g" must be preserved as distinct tokens
  assert.ok(stem1.includes("t-to-c"), `expected 't-to-c' in stem1, got: ${stem1}`);
  assert.ok(stem2.includes("a-to-g"), `expected 'a-to-g' in stem2, got: ${stem2}`);
  assert.notEqual(stem1, stem2, "hyphenated abbreviations must produce different slugs");
  // "IL-6" is preserved as "il-6" (single token, not split)
  const out3 = resolveDefaultOutPath("IL-6 signaling in cancer", { outputDir: "/tmp/test-h" });
  const stem3 = out3.split(pathSep).pop()!.replace(".md", "");
  assert.ok(stem3.includes("il-6"), `expected 'il-6' in stem3, got: ${stem3}`);
});

test("resolveDefaultOutPath: no collisions across 6 audit descriptions", () => {
  const descriptions = [
    "Write the introduction for a paper on cancer cachexia",
    "Write the introduction for a paper on insulin signaling",
    "Write the methods section about the Drosophila model",
    "Write the results section about the Drosophila model",
    "Write about cancer cachexia in Drosophila",
    "Write about insulin signaling in Drosophila",
  ];
  const slugs = descriptions.map((d) => {
    const out = resolveDefaultOutPath(d, { outputDir: "/tmp/test-col" });
    return out.split(pathSep).pop()!.replace(".md", "");
  });
  const unique = new Set(slugs);
  assert.equal(unique.size, slugs.length, `expected 6 unique slugs, got ${unique.size}: ${slugs.join(", ")}`);
});
