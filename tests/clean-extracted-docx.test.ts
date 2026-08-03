// tests/clean-extracted-docx.test.ts
// Regression test for the v0.7.6 cleanExtractedDocx DOI-recovery fix.
//
// Before the fix, the plain-form DOI regex `doi:\s*([^\s)\]]+)` truncated
// parenthesised DOIs at the first `(`, so a reference like
//   1. Fearon K. ... Lancet Oncol. 2011;12:489-495. doi:10.1016/S1470-2045(10)70218-7
// was recovered as `10.1016/S1470-2045` (missing the suffix), and the
// corresponding [1] marker came back BARE in the extracted markdown. That
// forced the LLM to "backfill" a DOI it already had (citation-backfill noise)
// and, worse, lost the real DOI. The fix matches `10\.[^\s\]]+` so internal
// parentheses are preserved.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { cleanExtractedDocx } from "../src/pipeline.ts";

describe("cleanExtractedDocx DOI recovery", () => {
  it("recovers a parenthesised DOI from the References section and re-attaches it to [1]", () => {
    const docxText = [
      `Body text with a citation[1] here.`,
      ``,
      `## References`,
      ``,
      `[1] Fearon Kenneth, et al. Definition and classification of cancer cachexia. The Lancet Oncology. 2011;12:489-495. doi:10.1016/S1470-2045(10)70218-7`,
    ].join("\n");
    const out = cleanExtractedDocx(docxText);
    assert.match(out, /\[1\]\(<doi:10\.1016\/S1470-2045\(10\)70218-7>\)/, "full parenthesised DOI must be re-attached in angle form");
    assert.doesNotMatch(out, /## References/, "References section must be stripped (finalize regenerates it)");
  });

  it("recovers multiple DOIs, including ones with and without parentheses", () => {
    const docxText = [
      `Text[1] and more[2].`,
      ``,
      `## References`,
      ``,
      `[1] Fearon K. ... Lancet Oncol. 2011;12:489-495. doi:10.1016/S1470-2045(10)70218-7`,
      `[2] Kwon Y. ... Dev Cell. 2015;33:36-46. doi:10.1016/j.devcel.2015.02.012`,
    ].join("\n");
    const out = cleanExtractedDocx(docxText);
    assert.match(out, /\[1\]\(<doi:10\.1016\/S1470-2045\(10\)70218-7>\)/);
    assert.match(out, /\[2\]\(<doi:10\.1016\/j\.devcel\.2015\.02\.012>\)/);
  });

  it("leaves a bare [N] when no DOI is present in the References section", () => {
    const docxText = [
      `Text[7].`,
      ``,
      `## References`,
      ``,
      `[7] Some Author. A title with no DOI. J. 2020.`,
    ].join("\n");
    const out = cleanExtractedDocx(docxText);
    assert.match(out, /\[7\](?!\()/, "bare [7] preserved when no DOI recoverable");
  });

  it("handles https://doi.org/ form DOIs", () => {
    const docxText = [
      `Text[3].`,
      ``,
      `## References`,
      ``,
      `[3] Author. Title. J. 2022. https://doi.org/10.1038/s41598-022-05991-5`,
    ].join("\n");
    const out = cleanExtractedDocx(docxText);
    assert.match(out, /\[3\]\(<doi:10\.1038\/s41598-022-05991-5>\)/);
  });
});
