// tests/doi-cleanup.test.ts
// MED-1 + MED-2: table-driven offline coverage of cleanDoi and the malformed
// marker fallback regex. Pure unit tests, no CrossRef, no docx CLI on PATH.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { cleanDoi, finalizeDoc } from "../src/pipeline.ts";
import {
  mkdtempSync as mkdtempSyncC, writeFileSync as writeFileSyncC,
  rmSync as rmSyncC, readFileSync as readFileSyncC,
} from "node:fs";
import { tmpdir as tmpdirC } from "node:os";
import { join as joinC } from "node:path";

// === cleanDoi unit tests (MED-1: idempotency) ===

test("cleanDoi: leaves a clean DOI untouched", () => {
  assert.equal(cleanDoi("10.1242/dmm.049298"), "10.1242/dmm.049298");
});

test("cleanDoi: strips trailing ].", () => {
  assert.equal(cleanDoi("10.1242/dmm.049298]."), "10.1242/dmm.049298");
});

test("cleanDoi: strips trailing ]", () => {
  assert.equal(cleanDoi("10.1242/dmm.049298]"), "10.1242/dmm.049298");
});

test("cleanDoi: strips trailing ;]", () => {
  assert.equal(cleanDoi("10.1242/dmm.049298];"), "10.1242/dmm.049298");
});

test("cleanDoi: strips trailing .]", () => {
  assert.equal(cleanDoi("10.1242/dmm.049298.]"), "10.1242/dmm.049298");
});

test("cleanDoi: strips trailing ,]", () => {
  assert.equal(cleanDoi("10.1242/dmm.049298,]"), "10.1242/dmm.049298");
});

test("cleanDoi: strips trailing .,]", () => {
  assert.equal(cleanDoi("10.1242/dmm.049298.,]"), "10.1242/dmm.049298");
});

test("cleanDoi: strips trailing ...]", () => {
  assert.equal(cleanDoi("10.1242/dmm.049298...]"), "10.1242/dmm.049298");
});

test("cleanDoi: preserves real ) inside a DOI", () => {
  // Real DOIs can contain parens (e.g. older Elsevier DOIs).
  assert.equal(cleanDoi("10.1016/S0896-6273(00)80701-1"), "10.1016/S0896-6273(00)80701-1");
});

test("cleanDoi: does NOT strip ) alone (it can be part of a real DOI)", () => {
  // `)` is in the allowed-character set of DOI strings; we only strip it as
  // part of ], ;, ,, ., never alone. The fallback regex (defensive) is what
  // handles trailing ) from a malformed marker like `[1](doi:10.x).`.
  assert.equal(cleanDoi("10.1016/S0896-6273(00)80701-1)"), "10.1016/S0896-6273(00)80701-1)");
});

test("cleanDoi: idempotent — applying twice yields the same result", () => {
  for (const input of [
    "10.1242/dmm.049298].",
    "10.1242/dmm.049298.]",
    "10.1242/dmm.049298.].,",
    "10.1242/dmm.049298.,]",
    "10.1242/dmm.049298..]",
    "10.1242/dmm.049298",
  ]) {
    const once = cleanDoi(input);
    const twice = cleanDoi(once);
    assert.equal(twice, once, `cleanDoi not idempotent for input='${input}' (once='${once}', twice='${twice}')`);
  }
});

test("cleanDoi: trims surrounding whitespace", () => {
  assert.equal(cleanDoi("  10.1242/dmm.049298  "), "10.1242/dmm.049298");
  assert.equal(cleanDoi("\t10.1242/dmm.049298]\n"), "10.1242/dmm.049298");
});

// === finalizeDoc fuzzed, offline (MED-2: defensive regex coverage) ===
//
// For each marker shape, we drive finalizeDoc with a fixture lookupDoi and
// assert the sidecar DOI is clean and the vancouver entry is the real
// resolved one (not the (doi:...) stub). No CrossRef, no docx CLI.

const fixtureWork = {
  DOI: "10.1242/dmm.049298",
  title: ["Cancer cachexia: lessons from Drosophila"],
  author: [
    { family: "Liu", given: "Ying" },
    { family: "Saavedra", given: "Pedro" },
    { family: "Perrimon", given: "Norbert" },
  ],
  published: { "date-parts": [[2022]] },
  "container-title": ["Disease Models & Mechanisms"],
  volume: "15",
  page: "dmm049298",
} as any;

const lookupFixture = (_doi: string) => fixtureWork;

const cases: Array<{ name: string; input: string; expectedDoi: string }> = [
  { name: "well-formed angle-bracket", input: "x [1](<doi:10.1242/dmm.049298>).", expectedDoi: "10.1242/dmm.049298" },
  { name: "well-formed plain", input: "x [1](doi:10.1242/dmm.049298).", expectedDoi: "10.1242/dmm.049298" },
  { name: "trailing ].", input: "x [1](doi:10.1242/dmm.049298].", expectedDoi: "10.1242/dmm.049298" },
  { name: "trailing ]", input: "x [1](doi:10.1242/dmm.049298].", expectedDoi: "10.1242/dmm.049298" },
  { name: "trailing ,", input: "x [1](doi:10.1242/dmm.049298,", expectedDoi: "10.1242/dmm.049298" },
  { name: "trailing ;", input: "x [1](doi:10.1242/dmm.049298;", expectedDoi: "10.1242/dmm.049298" },
  { name: "trailing .", input: "x [1](doi:10.1242/dmm.049298.", expectedDoi: "10.1242/dmm.049298" },
  { name: "trailing ).", input: "x [1](doi:10.1242/dmm.049298).", expectedDoi: "10.1242/dmm.049298" },
  { name: "trailing ]. and adjacent text", input: "x [1](doi:10.1242/dmm.049298]. More text.", expectedDoi: "10.1242/dmm.049298" },
  { name: "lowercase doi:", input: "x [1](doi:10.1242/dmm.049298).", expectedDoi: "10.1242/dmm.049298" },
  { name: "multiple citations in same doc", input: "x [1](doi:10.1242/dmm.049298) and [2](<doi:10.1242/dmm.049298>).", expectedDoi: "10.1242/dmm.049298", expectedCount: 2 },
];

for (const c of cases) {
  test(`finalizeDoc marker: ${c.name}`, () => {
    const dir = mkdtempSyncC(joinC(tmpdirC(), "doi-cleanup-"));
    const md = joinC(dir, "in.md");
    writeFileSyncC(md, c.input, "utf-8");
    const result = finalizeDoc(md, { noCache: true, lookupDoi: lookupFixture });
    const expectedCount = (c as any).expectedCount ?? 1;
    assert.equal(result.bibliographyCount, expectedCount, `bibliography count for case '${c.name}' got=${result.bibliographyCount} expected=${expectedCount}`);
    const sidecar = JSON.parse(
      readFileSyncC(md.replace(/\.md$/, ".citations.json"), "utf-8"),
    ) as any;
    const entry = sidecar.citations?.["1"];
    assert.ok(entry, `sidecar entry for [1] missing for case '${c.name}'`);
    assert.equal(entry.doi, c.expectedDoi, `DOI clean for case '${c.name}' got='${entry.doi}'`);
    assert.ok(!entry.vancouver.startsWith("1. (doi:"), `NOT the (doi:...) stub for case '${c.name}' got='${entry.vancouver.slice(0, 60)}'`);
    assert.ok(entry.vancouver.includes("Cancer cachexia"), `real title for case '${c.name}' got='${entry.vancouver.slice(0, 60)}'`);
    if (expectedCount === 2) {
      const entry2 = sidecar.citations?.["2"];
      assert.ok(entry2, `sidecar entry for [2] missing for case '${c.name}'`);
      assert.equal(entry2.doi, c.expectedDoi, `[2] DOI clean for case '${c.name}' got='${entry2.doi}'`);
    }
    rmSyncC(dir, { recursive: true });
  });
}
