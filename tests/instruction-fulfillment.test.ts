// tests/instruction-fulfillment.test.ts
// Covers the v0.7.6 instruction-fulfillment check added to pipelineRewrite.
// The AI-tell loop cannot see the user's structural requests (remove Future
// directions, RNA-seq -> blank, first Results paragraph == Methods copy).
// These tests assert the heuristic surfaces those unmet requests.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { checkInstructionFulfillment } from "../src/pipeline.ts";

describe("checkInstructionFulfillment", () => {
  it("flags a surviving Future directions section when the user asked to remove it", () => {
    const draft = `## Results\n\nSome findings.\n\n## Discussion\n\nTalk.\n\n## Future directions\n\n1. Do X.\n`;
    const instructions = `its a paper there are no future directions, remove that section`;
    const w = checkInstructionFulfillment(draft, instructions);
    assert.ok(w.length >= 1, "should warn about surviving Future directions");
    assert.match(w[0], /Future directions/i);
  });

  it("does NOT flag when Future directions is gone", () => {
    const draft = `## Results\n\nFindings.\n\n## Discussion\n\nTalk.\n`;
    const instructions = `remove the future directions section`;
    const w = checkInstructionFulfillment(draft, instructions);
    assert.equal(w.length, 0);
  });

  it("flags a substantive RNA-seq result when the user asked for a blank/placeholder", () => {
    const draft = `## Discussion\n\nA whole-organism RNA-seq comparison of control and arrested flies is underway and will test whether the arrest brings the signature back toward control.\n`;
    const instructions = `the next rna-seq just leave a blank saying here rna seq results when available`;
    const w = checkInstructionFulfillment(draft, instructions);
    assert.ok(w.length >= 1, "should warn that RNA-seq result was not replaced with a placeholder");
    assert.match(w[0], /RNA-seq/i);
  });

  it("does NOT flag when the RNA-seq text is already a placeholder", () => {
    const draft = `## Discussion\n\n[RNA-seq results will be inserted here when available].\n`;
    const instructions = `replace the rna-seq sentence with a blank placeholder`;
    const w = checkInstructionFulfillment(draft, instructions);
    assert.equal(w.length, 0);
  });

  it("flags a first Results paragraph that copies Methods phrasing", () => {
    const draft = [
      `## Methods`,
      ``,
      `Flies were shifted to 18 °C, held for 7 days, and then sampled.`,
      ``,
      `## Results`,
      ``,
      `Tumor induction used the esg-GAL4 driver. Flies were shifted to 18 °C, held for 7 days. Each imaging condition contained n = 5 flies, with one organ measured per fly. The biological replicate was the individual fly.`,
      ``,
      `Some real result sentence here.`,
      ``,
      `## Discussion`,
      ``,
      `Discussion text.`,
    ].join("\n");
    const instructions = `the first paragraph of the results is like a method copy, rewrite it`;
    const w = checkInstructionFulfillment(draft, instructions);
    assert.ok(w.length >= 1, "should warn that first Results paragraph is a Methods copy");
    assert.match(w[0], /method phrasing/i);
  });

  it("returns nothing when there are no specific structural instructions", () => {
    const draft = `## Results\n\nFindings.\n`;
    const w = checkInstructionFulfillment(draft, "make it sound more human");
    assert.equal(w.length, 0);
  });
});
