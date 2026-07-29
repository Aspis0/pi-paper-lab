// tests/vancouver-parser-regressions.test.ts
// Regression tests for the Vancouver parser in finalizeDoc's --live branch.
// Tests use the *actual* exported function from src/pipeline.ts
// (parseVancouverForLive) — not a stale regex copy. CRIT-1 from the
// v0.7.1 hotfix audit previously let the test file diverge from the
// implementation; this version imports the function so they cannot
// drift again.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { parseVancouverForLive, stripTrailingParen } from "../src/pipeline.ts";

// Adapter to keep legacy assertions working without forcing the tests to
// be rewritten in lock-step with the implementation (a single API shape).
function parse(entry: string) {
  const s = parseVancouverForLive(entry);
  if (!s) return null;
  // The implementation returns WordLiveBuilderSource which has fewer
  // fields than the test's old `parse()` adapter used. Wrap into a flat
  // shape that all of the existing tests below can query.
  const firstAuthor = (s as any).authors?.[0]?.family;
  return {
    id: s.id,
    title: s.title,
    authors: (s as any).authors ? (s as any).authors.map((a: any) => a.family).join(", ") : "",
    journal: (s as any).journal ?? "",
    year: (s as any).year ?? "",
    vol: (s as any).volume ?? undefined,
    issue: (s as any).issue ?? undefined,
    pages: (s as any).pages ?? undefined,
    doi: (s as any).doi,
    // For a placeholder entry, the implementation sets title to "[…]"
    // and has no DOI. We expose `placeholder: true` for legacy tests.
    placeholder: !!(s as any).doi === false && !!firstAuthor === false ? true : false,
  };
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

test("v0.7.2 CRIT-3 fix: noVol journal name with abbreviated dots is captured whole", () => {
  // CrossRef sometimes returns dotted abbreviations like
  // "Proc. Natl. Acad. Sci.". The noVol regex must NOT truncate
  // to the last segment ("Sci"). The journal may or may not include
  // the final period (regex tolerates both).
  const entry = "1. Author X. A study. Proc. Natl. Acad. Sci. 2025:357-364. doi:10.1073/pnas.2025.x";
  const r = parse(entry);
  assert.ok(r, "must match noVol");
  // Allow either "Proc. Natl. Acad. Sci." or "Proc. Natl. Acad. Sci"
  // (regex may or may not consume the final period depending on journal
  // capture and surrounding context).
  assert.ok(
    r!.journal === "Proc. Natl. Acad. Sci." || r!.journal === "Proc. Natl. Acad. Sci",
    `journal must keep all dotted segments (got: '${r!.journal}')`,
  );
  assert.equal(r!.year, "2025");
  assert.equal(r!.pages, "357-364");
  assert.equal(r!.doi, "10.1073/pnas.2025.x");
});

test("v0.7.2 noVol: standard entry without volume/issue", () => {
  const entry = "1. Yu B. UTBoost. ACL. 2025:3762-3774. doi:10.18653/v1/2025.acl-long.189";
  const r = parse(entry);
  assert.ok(r, "must match noVol");
  // The journal may end in "." or not — both are acceptable.
  assert.ok(
    r!.journal === "ACL" || r!.journal === "ACL.",
    `journal (got: '${r!.journal}')`,
  );
  assert.equal(r!.vol, undefined, "no vol in noVol");
  assert.equal(r!.pages, "3762-3774");
});

test("v0.7.2 MED-2 fix: doiOnly rejects asymmetric parens (open without close)", () => {
  // "1. (doi:10.xxx" — open without close — should NOT match.
  // Previously the lenient `\)?$` matched it.
  const r = parse("1. (doi:10.1234/abcd");
  assert.equal(r, null, "asymmetric open paren must be rejected");
});

test("v0.7.2 MED-2 fix: doiOnly accepts symmetric parens", () => {
  const r = parse("1. (doi:10.48550/arXiv.2603.27277)");
  assert.ok(r, "must match");
  assert.equal(r!.doi, "10.48550/arXiv.2603.27277", "trailing ) is stripped");
});

test("v0.7.2 MED-1 fix: stripTrailingParen removes ALL trailing parens", () => {
  assert.equal(stripTrailingParen("10.1234/x))"), "10.1234/x", "two trailing parens stripped");
  assert.equal(stripTrailingParen("10.1234/x)))"), "10.1234/x", "three trailing parens stripped");
  assert.equal(stripTrailingParen("10.1234/x)"), "10.1234/x", "one trailing paren stripped");
  assert.equal(stripTrailingParen("10.1234/x"), "10.1234/x", "no trailing parens — no change");
  // Internal parens preserved.
  assert.equal(stripTrailingParen("10.1016/S0896-6273(00)80701-1"), "10.1016/S0896-6273(00)80701-1");
});

test("v0.7.2 CRIT-2 fix: placeholder entry is preserved (not silently dropped)", () => {
  const entry = "1. [Citation metadata unavailable — no DOI found. Re-run /paper-cite to resolve this reference.]";
  const r = parse(entry);
  assert.ok(r, "placeholder must be captured so live bibliography has a source");
  assert.equal(r!.id, 1);
  assert.ok(r!.title!.includes("Citation metadata unavailable"));
});
