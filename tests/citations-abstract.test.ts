// tests/citations-abstract.test.ts
// find_citation candidates must carry Crossref abstracts (JATS-stripped)
// so the writing model can pick papers by more than title alone.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  formatResolveResult,
  resolveCitation,
  clampCitationNumResults,
  CITATION_NUM_RESULTS_DEFAULT,
  CITATION_NUM_RESULTS_MAX,
  CITATION_NUM_RESULTS_MIN,
  type ResolveResult,
} from "../src/citations.ts";
import { stripJats } from "../src/csl/adapters/crossrefToCsl.ts";

function withMockFetch(impl: typeof fetch, fn: () => Promise<void>): Promise<void> {
  const original = globalThis.fetch;
  globalThis.fetch = impl as any;
  return fn().finally(() => {
    globalThis.fetch = original;
  });
}

function baseCandidate(
  overrides: Partial<ResolveResult["candidates"][number]> = {},
): ResolveResult["candidates"][number] {
  return {
    title: "Cancer cachexia: lessons from Drosophila",
    authors: "Ying Liu, Pedro Saavedra",
    year: 2022,
    venue: "Disease Models & Mechanisms",
    doi: "10.1242/dmm.049298",
    source: "crossref",
    ...overrides,
  };
}

// Snapshot of today's format for a candidate with no abstract (and no snippet).
function expectedNoAbstractBlock(c: ResolveResult["candidates"][number]): string {
  const lines: string[] = [];
  lines.push(`  [1] ${c.title}`);
  if (c.authors) lines.push(`      Authors: ${c.authors}`);
  if (c.year) lines.push(`      Year: ${c.year}`);
  if (c.venue) lines.push(`      Venue: ${c.venue}`);
  if (c.doi) lines.push(`      DOI: ${c.doi}`);
  if (c.link) lines.push(`      Link: ${c.link}`);
  if (c.citations !== undefined) lines.push(`      Citations: ${c.citations}`);
  if (c.snippet) lines.push(`      Snippet: ${c.snippet.slice(0, 150)}`);
  lines.push(`      Source: ${c.source}`);
  lines.push("");
  return lines.join("\n");
}

test("formatResolveResult: candidate without abstract is byte-identical to legacy format", () => {
  const c = baseCandidate(); // no abstract, no snippet
  const result: ResolveResult = { topic: "cachexia", candidates: [c], warnings: [] };
  const out = formatResolveResult(result);

  // Full header + footer around the candidate block
  const expected = [
    `=== [CITE:cachexia] — candidates ===`,
    expectedNoAbstractBlock(c).trimEnd(),
    "",
    "Assign a number from the draft by replacing [CITE:topic] with [N].",
    "Then run /cite-verify to check each citation.",
  ].join("\n");

  assert.equal(out, expected);
});

test("formatResolveResult: candidate without abstract but with snippet keeps Snippet line", () => {
  const c = baseCandidate({
    source: "scholar",
    doi: undefined,
    link: "https://scholar.example/1",
    snippet: "A short scholar snippet about cachexia in flies.",
  });
  const result: ResolveResult = { topic: "cachexia", candidates: [c], warnings: [] };
  const out = formatResolveResult(result);
  assert.match(out, /Snippet: A short scholar snippet about cachexia in flies\./);
  assert.doesNotMatch(out, /Abstract:/);
});

test("formatResolveResult: prints Abstract line when present", () => {
  const c = baseCandidate({
    abstract: "Cachexia is a wasting syndrome conserved in Drosophila tumor models.",
  });
  const out = formatResolveResult({
    topic: "cachexia",
    candidates: [c],
    warnings: [],
  });
  assert.match(
    out,
    /Abstract: Cachexia is a wasting syndrome conserved in Drosophila tumor models\./,
  );
  // Abstract replaces Snippet when present
  assert.doesNotMatch(out, /Snippet:/);
});

test("formatResolveResult: caps Abstract at 1200 chars with truncation marker", () => {
  const long = "A".repeat(1300);
  const c = baseCandidate({ abstract: long });
  const out = formatResolveResult({
    topic: "cachexia",
    candidates: [c],
    warnings: [],
  });
  const m = out.match(/Abstract: (.*)/);
  assert.ok(m, "Abstract line present");
  const body = m![1]!;
  // 1200 chars of content + ellipsis marker
  assert.equal(body.length, 1200 + "…".length);
  assert.equal(body.slice(0, 1200), "A".repeat(1200));
  assert.ok(body.endsWith("…"), "truncation marker is …");
  assert.ok(!body.includes("A".repeat(1201)));
});

test("formatResolveResult: abstract exactly 1200 chars has no truncation marker", () => {
  const exact = "B".repeat(1200);
  const c = baseCandidate({ abstract: exact });
  const out = formatResolveResult({
    topic: "cachexia",
    candidates: [c],
    warnings: [],
  });
  const m = out.match(/Abstract: (.*)/);
  assert.ok(m);
  assert.equal(m![1], exact);
  assert.ok(!m![1]!.endsWith("…"));
});

test("resolveCitation: Crossref search keeps JATS-stripped abstract on candidate", async () => {
  const prevBackend = process.env.PAPERLAB_CITATION_BACKEND;
  process.env.PAPERLAB_CITATION_BACKEND = "crossref";

  try {
    await withMockFetch(async (input: any) => {
      const url = String(input);
      assert.ok(
        url.includes("api.crossref.org/works"),
        `expected Crossref works search, got ${url}`,
      );
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({
          message: {
            items: [
              {
                DOI: "10.1242/dmm.049298",
                title: ["Cancer cachexia: lessons from Drosophila"],
                author: [
                  { given: "Ying", family: "Liu" },
                  { given: "Pedro", family: "Saavedra" },
                ],
                published: { "date-parts": [[2022, 6, 15]] },
                "container-title": ["Disease Models & Mechanisms"],
                volume: "15",
                issue: "6",
                page: "dmm049298",
                type: "journal-article",
                abstract:
                  "<jats:p>Background. <jats:bold>Cancer</jats:bold> is bad.</jats:p> <jats:p>Methods. We did X.</jats:p>",
              },
              {
                DOI: "10.1038/no-abstract",
                title: ["A paper without abstract"],
                author: [{ given: "A", family: "Author" }],
                published: { "date-parts": [[2020]] },
                "container-title": ["Nature"],
                type: "journal-article",
                // no abstract field
              },
            ],
          },
        }),
      } as any;
    }, async () => {
      const result = await resolveCitation("cancer cachexia drosophila", {
        numResults: 5,
      });
      assert.equal(result.candidates.length, 2);

      const withAbs = result.candidates.find((c) => c.doi === "10.1242/dmm.049298");
      assert.ok(withAbs, "first Crossref hit present");
      assert.equal(withAbs!.source, "crossref");
      assert.equal(
        withAbs!.abstract,
        "Background. Cancer is bad. Methods. We did X.",
      );
      // No raw JATS tags
      assert.ok(!withAbs!.abstract!.includes("<jats:"));
      assert.ok(!withAbs!.abstract!.includes("</"));

      const noAbs = result.candidates.find((c) => c.doi === "10.1038/no-abstract");
      assert.ok(noAbs);
      assert.equal(noAbs!.abstract, undefined);
    });
  } finally {
    if (prevBackend === undefined) delete process.env.PAPERLAB_CITATION_BACKEND;
    else process.env.PAPERLAB_CITATION_BACKEND = prevBackend;
  }
});

// ── B1: stripJats defensive on non-strings; one bad item must not wipe Crossref ─

test("stripJats: non-string inputs return undefined without throwing", () => {
  assert.equal(stripJats(undefined), undefined);
  assert.equal(stripJats(null), undefined);
  assert.equal(stripJats(42), undefined);
  assert.equal(stripJats(true), undefined);
  assert.equal(stripJats(["<jats:p>x</jats:p>"]), undefined);
  assert.equal(stripJats({ abstract: "x" }), undefined);
  assert.equal(stripJats(""), undefined);
  // Still works for real strings
  assert.equal(stripJats("<jats:p>ok</jats:p>"), "ok");
});

test("resolveCitation: malformed abstract on one item does not wipe other Crossref candidates", async () => {
  const prevBackend = process.env.PAPERLAB_CITATION_BACKEND;
  process.env.PAPERLAB_CITATION_BACKEND = "crossref";

  try {
    await withMockFetch(async () => {
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({
          message: {
            items: [
              {
                DOI: "10.9999/bad-abstract",
                title: ["Paper with non-string abstract"],
                author: [{ given: "Bad", family: "Payload" }],
                published: { "date-parts": [[2021]] },
                "container-title": ["Junk"],
                type: "journal-article",
                // Truthy non-string — used to throw in stripJats and kill the whole loop
                abstract: ["<jats:p>should not crash</jats:p>"],
              },
              {
                DOI: "10.1242/dmm.049298",
                title: ["Cancer cachexia: lessons from Drosophila"],
                author: [{ given: "Ying", family: "Liu" }],
                published: { "date-parts": [[2022]] },
                "container-title": ["Disease Models & Mechanisms"],
                type: "journal-article",
                abstract: "<jats:p>Good abstract survives.</jats:p>",
              },
            ],
          },
        }),
      } as any;
    }, async () => {
      const result = await resolveCitation("cachexia", { numResults: 5 });
      assert.equal(result.candidates.length, 2, "both items must survive");

      const bad = result.candidates.find((c) => c.doi === "10.9999/bad-abstract");
      assert.ok(bad);
      assert.equal(bad!.abstract, undefined, "non-string abstract dropped, candidate kept");

      const good = result.candidates.find((c) => c.doi === "10.1242/dmm.049298");
      assert.ok(good);
      assert.equal(good!.abstract, "Good abstract survives.");
    });
  } finally {
    if (prevBackend === undefined) delete process.env.PAPERLAB_CITATION_BACKEND;
    else process.env.PAPERLAB_CITATION_BACKEND = prevBackend;
  }
});

// ── B2: scientific comparisons must survive tag strip ─────────────────────────

test("stripJats: preserves scientific P < 0.001 / fold-change > 2 text", () => {
  const raw =
    "<jats:p>Results: P < 0.001 and a fold-change > 2 were observed.</jats:p>";
  const out = stripJats(raw);
  assert.equal(
    out,
    "Results: P < 0.001 and a fold-change > 2 were observed.",
  );
  // Entity-encoded forms still decode after strip
  assert.equal(
    stripJats("<jats:p>P &lt; 0.05 and n &gt; 10</jats:p>"),
    "P < 0.05 and n > 10",
  );
});

// ── B3: multi-paragraph abstract renders as one Key: value line ───────────────

test("formatResolveResult: multi-paragraph abstract is one Abstract line", () => {
  const c = baseCandidate({
    abstract: "Background.\n\nMethods.\nWe studied X.\r\nResults: ok.",
  });
  const out = formatResolveResult({
    topic: "cachexia",
    candidates: [c],
    warnings: [],
  });
  const abstractLines = out.split("\n").filter((l) => l.includes("Abstract:"));
  assert.equal(abstractLines.length, 1, "exactly one Abstract: line");
  assert.equal(
    abstractLines[0],
    "      Abstract: Background. Methods. We studied X. Results: ok.",
  );
  // Source: still on its own indented line after Abstract
  const absIdx = out.indexOf("Abstract:");
  const srcIdx = out.indexOf("Source: crossref");
  assert.ok(absIdx >= 0 && srcIdx > absIdx);
  // No raw newlines inside the Abstract value (between "Abstract:" and next line)
  const afterAbs = out.slice(absIdx, srcIdx);
  assert.ok(!afterAbs.includes("\n\n"), "no blank line inside abstract block");
  assert.match(afterAbs, /^Abstract: [^\n]+\n/);
});

test("formatResolveResult: multi-paragraph long abstract still caps at 1200 with …", () => {
  // Newlines collapse first; cap applies to collapsed text
  const body = ("word ".repeat(400)).trim(); // 1999 chars of "word " pattern → trim
  const multi = `Para1.\n\n${body}`;
  const c = baseCandidate({ abstract: multi });
  const out = formatResolveResult({
    topic: "cachexia",
    candidates: [c],
    warnings: [],
  });
  const m = out.match(/Abstract: (.*)/);
  assert.ok(m);
  const rendered = m![1]!;
  assert.ok(rendered.endsWith("…"));
  assert.equal(rendered.length, 1200 + "…".length);
  assert.ok(!rendered.includes("\n"));
});

// ── num_results clamp ─────────────────────────────────────────────────────────

test("clampCitationNumResults: pins bounds (0→1, 100→10, default 5)", () => {
  assert.equal(clampCitationNumResults(0), CITATION_NUM_RESULTS_MIN);
  assert.equal(clampCitationNumResults(100), CITATION_NUM_RESULTS_MAX);
  assert.equal(clampCitationNumResults(-3), CITATION_NUM_RESULTS_MIN);
  assert.equal(clampCitationNumResults(1), 1);
  assert.equal(clampCitationNumResults(10), 10);
  assert.equal(clampCitationNumResults(5), 5);
  assert.equal(clampCitationNumResults(5.9), 5); // trunc then clamp
  assert.equal(clampCitationNumResults(undefined), CITATION_NUM_RESULTS_DEFAULT);
  assert.equal(clampCitationNumResults(null), CITATION_NUM_RESULTS_DEFAULT);
  assert.equal(clampCitationNumResults(NaN), CITATION_NUM_RESULTS_DEFAULT);
  assert.equal(clampCitationNumResults("3" as any), CITATION_NUM_RESULTS_DEFAULT);
});

test("resolveCitation: numResults is clamped before Crossref rows= param", async () => {
  const prevBackend = process.env.PAPERLAB_CITATION_BACKEND;
  process.env.PAPERLAB_CITATION_BACKEND = "crossref";
  let seenUrl = "";

  try {
    await withMockFetch(async (input: any) => {
      seenUrl = String(input);
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({ message: { items: [] } }),
      } as any;
    }, async () => {
      await resolveCitation("x", { numResults: 100 });
      assert.match(seenUrl, /rows=10/, `expected rows=10, got ${seenUrl}`);

      seenUrl = "";
      await resolveCitation("x", { numResults: 0 });
      assert.match(seenUrl, /rows=1/, `expected rows=1, got ${seenUrl}`);
    });
  } finally {
    if (prevBackend === undefined) delete process.env.PAPERLAB_CITATION_BACKEND;
    else process.env.PAPERLAB_CITATION_BACKEND = prevBackend;
  }
});
