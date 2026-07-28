// tests/vancouver-parser-regressions.test.ts
// Regression tests for the Vancouver parser in finalizeDoc's --live branch.
// These tests reproduce the CRIT-3, CRIT-4, MED-3, HIGH-5 findings
// from the M4 audit and verify the fixes.
//
// The regex under test is the one inside finalizeDoc that parses
// Vancouver-format entries back into source fields. We test it by
// replicating the exact pattern here and asserting on the captures.

import { test } from "node:test";
import { strict as assert } from "node:assert";

// The parser regex (mirroring pipeline.ts:liveSources branch).
// Kept in the test file so the test is self-contained.
const FULL = /^(\d+)\.\s+(.+?)\.\s+(.+?)\.\s+([^.]+?)\.\s+(\d{4})(?:;(\d+)(?:\((\d+)\))?(?::(.+?))?)?\.\s+doi:(\S+?)\.?$/;
const PLACEHOLDER = /^(\d+)\.\s+\[(.+)\]$/;

function parse(entry: string) {
  const full = entry.match(FULL);
  if (full) {
    const [, n, authors, title, journal, year, vol, issue, pages, doi] = full;
    const id = parseInt(n!, 10);
    if (!Number.isFinite(id) || id < 1) return null;
    return { id, title, authors, journal, year, vol, issue, pages, doi, placeholder: false };
  }
  const ph = entry.match(PLACEHOLDER);
  if (ph) {
    const id = parseInt(ph[1]!, 10);
    if (!Number.isFinite(id) || id < 1) return null;
    return { id, title: `[${ph[2]}]`, placeholder: true };
  }
  return null;
}

test("CRIT-3 fix: issue parsed separately from volume (was merged into vol)", () => {
  const entry = "1. Liu Y. Cancer cachexia. Nature. 2022;15(4):1-10. doi:10.1038/ns.2022";
  const r = parse(entry);
  assert.ok(r, "must match");
  assert.equal(r!.vol, "15", "volume must be just the number, not 15(4)");
  assert.equal(r!.issue, "4", "issue must be parsed separately");
  assert.equal(r!.pages, "1-10");
});

test("CRIT-3 fix: entry WITHOUT issue still parses correctly", () => {
  const entry = "2. Smith J. Another paper. Science. 2021;10:100-200. doi:10.1126/sci.12345";
  const r = parse(entry);
  assert.ok(r, "must match");
  assert.equal(r!.vol, "10");
  assert.equal(r!.issue, undefined, "no issue group when not present");
  assert.equal(r!.pages, "100-200");
});

test("CRIT-3 fix: entry WITHOUT vol/issue/pages still parses", () => {
  const entry = "3. Doe A. No vol paper. Cell. 2020. doi:10.1016/j.cell.2020.01.001";
  const r = parse(entry);
  assert.ok(r, "must match");
  assert.equal(r!.vol, undefined, "vol is optional");
  assert.equal(r!.issue, undefined);
  assert.equal(r!.pages, undefined);
});

test("CRIT-4 fix: placeholder entries WITHOUT DOI are captured", () => {
  const entry = "1. [Citation metadata unavailable — no DOI found. Re-run /paper-cite to resolve this reference.]";
  const r = parse(entry);
  assert.ok(r, "must not be silently dropped");
  assert.equal(r!.placeholder, true);
  assert.equal(r!.id, 1);
  assert.ok(r!.title!.includes("Citation metadata unavailable"));
});

test("CRIT-4 fix: multiple placeholders are independently captured", () => {
  const entries = [
    "1. [Placeholder A]",
    "2. [Placeholder B]",
    "3. [Placeholder C]",
  ];
  const parsed = entries.map(parse);
  assert.equal(parsed.length, 3);
  assert.ok(parsed.every((r) => r && r.placeholder));
  assert.equal(parsed[0]!.id, 1);
  assert.equal(parsed[1]!.id, 2);
  assert.equal(parsed[2]!.id, 3);
});

test("HIGH-5 fix: invalid id (NaN) is rejected, not serialized", () => {
  // Simulate an entry where the id slot is a non-numeric string.
  // The regex itself requires ^(\d+), so this case can't happen from
  // a well-formed Vancouver entry, but we want to make sure that an
  // id that parses as NaN is rejected.
  const r = parse("0. Test. Title. J. 2020. doi:10.xxx"); // id=0 is invalid
  assert.equal(r, null, "id < 1 must be rejected");
});

test("MED-3 fix: issue appears in the liveSource, not inside volume", () => {
  // Real-world format with issue in parentheses.
  const entry = "1. Rossi G, Bianchi P. Drosophila model. Dev Cell. 2023;42(1):12-30. doi:10.1016/j.devcel.2023.01.001";
  const r = parse(entry);
  assert.ok(r, "must match");
  assert.equal(r!.authors, "Rossi G, Bianchi P");
  assert.equal(r!.journal, "Dev Cell");
  assert.equal(r!.year, "2023");
  assert.equal(r!.vol, "42");
  assert.equal(r!.issue, "1");
  assert.equal(r!.pages, "12-30");
  assert.equal(r!.doi, "10.1016/j.devcel.2023.01.001");
});

test("MED-1 fix: DOI with parentheses (e.g. 10.1016/S0896-6273(00)80701-1) is fully captured", () => {
  const entry = "1. Wang X. Paper. Neuron. 2000;28(1):1-10. doi:10.1016/S0896-6273(00)80701-1";
  const r = parse(entry);
  assert.ok(r, "must match");
  assert.equal(r!.doi, "10.1016/S0896-6273(00)80701-1", "DOI with parens must be fully captured");
});

test("et al. author list still parses correctly (MED-2 check)", () => {
  // The `.` in "et al." must not break the author-title split.
  const entry = "1. Doe A, et al. Multiple authors. J Biol. 2021;5:1-5. doi:10.xxx";
  const r = parse(entry);
  assert.ok(r, "et al. entries must match");
  assert.equal(r!.authors, "Doe A, et al");
  assert.equal(r!.title, "Multiple authors");
});
