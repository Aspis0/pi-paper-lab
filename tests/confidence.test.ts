// tests/confidence.test.ts
// Unit tests for the centralized confidence scoring used by all M1 backends.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { computeConfidence } from "../src/source-finders/confidence.ts";

test("computeConfidence: high requires real title + DOI + abstract", () => {
  assert.equal(
    computeConfidence({ title: "Real", doi: "10.x", abstract: "x" }),
    "high",
  );
});

test("computeConfidence: sentinel title caps at medium even with DOI and abstract", () => {
  // The sentinel "(untitled)" should NOT count as a real title.
  assert.equal(
    computeConfidence({ title: "(untitled)", doi: "10.x", abstract: "x" }),
    "medium",
  );
});

test("computeConfidence: medium when title+DOI but no abstract", () => {
  assert.equal(
    computeConfidence({ title: "Real", doi: "10.x" }),
    "medium",
  );
});

test("computeConfidence: medium when abstract but no DOI", () => {
  assert.equal(
    computeConfidence({ title: "Real", abstract: "x" }),
    "medium",
  );
});

test("computeConfidence: medium when DOI + meshTerms only", () => {
  assert.equal(
    computeConfidence({ title: "Real", doi: "10.x", meshTerms: ["a"] }),
    "medium",
  );
});

test("computeConfidence: medium when real title only (no DOI, no abstract)", () => {
  // Real title alone is enough for 'medium' — the LLM can ground the
  // claim against the title even without a stable identifier.
  assert.equal(
    computeConfidence({ title: "Real" }),
    "medium",
  );
});

test("computeConfidence: low when sentinel title only", () => {
  assert.equal(
    computeConfidence({ title: "(untitled)" }),
    "low",
  );
});

test("computeConfidence: low when everything is missing", () => {
  assert.equal(
    computeConfidence({ title: "" }),
    "low",
  );
});
