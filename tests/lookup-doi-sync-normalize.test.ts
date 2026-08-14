// tests/lookup-doi-sync-normalize.test.ts
// BUG-29: lookupDoiSync must return a normalized CrossRefWork (camelCase),
// the same shape as async lookupDoi. Raw CrossRef kebab-case made
// crossrefToCsl miss issued/container-title → every ref rendered "n.d."
// with no journal name.
//
// Fixture captured from:
//   GET https://api.crossref.org/works/10.1016/j.devcel.2015.03.001
// (one of the user's actual references that rendered as n.d.)

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { normalizeWork } from "../src/crossref.ts";
import { crossrefToCsl } from "../src/csl/adapters/crossrefToCsl.ts";
import { formatBibliography } from "../src/csl/formatBibliography.ts";
import { finalizeDoc } from "../src/pipeline.ts";
import {
  mkdtempSync,
  writeFileSync,
  rmSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Minimal real CrossRef wire-shape message for
 * 10.1016/j.devcel.2015.03.001 (Developmental Cell 2015).
 * Keys are kebab-case / uppercase DOI as the API returns them.
 */
const CROSSREF_RAW_DEVCEL = {
  DOI: "10.1016/j.devcel.2015.03.001",
  title: [
    "Malignant Drosophila Tumors Interrupt Insulin Signaling to Induce Cachexia-like Wasting",
  ],
  author: [
    {
      given: "Alejandra",
      family: "Figueroa-Clarevega",
      sequence: "first",
      affiliation: [],
    },
    {
      given: "David",
      family: "Bilder",
      sequence: "additional",
      affiliation: [],
    },
  ],
  published: {
    "date-parts": [[2015, 4]],
  },
  issued: {
    "date-parts": [[2015, 4]],
  },
  "published-print": {
    "date-parts": [[2015, 4]],
  },
  "container-title": ["Developmental Cell"],
  volume: "33",
  issue: "1",
  page: "47-55",
  type: "journal-article",
  URL: "https://doi.org/10.1016/j.devcel.2015.03.001",
  publisher: "Elsevier BV",
};

test("BUG-29: normalizeWork maps CrossRef kebab-case to camelCase keys crossrefToCsl reads", () => {
  // This is the post-JSON.parse step of lookupDoiSync. Feeding the raw
  // wire message must yield published.dateParts + containerTitle.
  const work = normalizeWork(CROSSREF_RAW_DEVCEL);

  assert.equal(work.doi, "10.1016/j.devcel.2015.03.001");
  assert.deepEqual(work.published?.dateParts, [2015, 4]);
  assert.deepEqual(work.publishedPrint?.dateParts, [2015, 4]);
  assert.deepEqual(work.containerTitle, ["Developmental Cell"]);
  assert.equal(work.volume, "33");
  assert.equal(work.page, "47-55");

  // Explicitly assert the keys the adapter reads are present (not the
  // kebab-case wire keys).
  assert.equal(
    (work as any)["container-title"],
    undefined,
    "normalized work must not keep kebab-case container-title",
  );
  assert.equal(
    (work.published as any)?.["date-parts"],
    undefined,
    "normalized published must use dateParts, not date-parts",
  );

  // Adapter must produce issued + container-title for CSL rendering.
  const csl = crossrefToCsl(work, "10.1016/j.devcel.2015.03.001");
  assert.deepEqual(csl.issued, { "date-parts": [[2015]] });
  assert.equal(csl["container-title"], "Developmental Cell");
});

test("BUG-29: normalizeWork falls back to issued when published is absent", () => {
  const raw = {
    DOI: "10.1234/issued-only",
    title: ["Issued only paper"],
    author: [{ family: "Doe", given: "Jane" }],
    issued: { "date-parts": [[2019, 6, 1]] },
    "container-title": ["Some Journal"],
    type: "journal-article",
  };
  const work = normalizeWork(raw);
  assert.deepEqual(work.published?.dateParts, [2019, 6, 1]);
  const csl = crossrefToCsl(work, "10.1234/issued-only");
  assert.deepEqual(csl.issued, { "date-parts": [[2019]] });
});

test("BUG-29: bibliography from raw CrossRef fixture has year + journal, not n.d.", () => {
  const work = normalizeWork(CROSSREF_RAW_DEVCEL);
  const csl = crossrefToCsl(work, "10.1016/j.devcel.2015.03.001");
  const rendered = formatBibliography([csl], { style: "vancouver" });

  // Before fix (raw work → crossrefToCsl): year missing → "n.d.", journal empty.
  // After fix:
  assert.match(rendered, /2015/, `expected year 2015 in: ${rendered}`);
  assert.match(
    rendered,
    /Developmental Cell/,
    `expected journal name in: ${rendered}`,
  );
  assert.doesNotMatch(
    rendered,
    /\bn\.d\./i,
    `must not contain n.d. but got: ${rendered}`,
  );
  assert.match(rendered, /Figueroa-Clarevega/);
  assert.match(rendered, /33/);
});

test("BUG-29: finalizeDoc with kebab-case fixture (via normalizeWork) renders year + journal", () => {
  // Simulate what lookupDoiSync now returns: normalize the raw wire message
  // before finalizeDoc's crossrefToCsl call. Inject via lookupDoi DI so the
  // test stays offline. Bibliography lands in the .citations.json sidecar
  // (and .docx); the source .md is not rewritten with a References section.
  const normalized = normalizeWork(CROSSREF_RAW_DEVCEL);
  const dir = mkdtempSync(join(tmpdir(), "bug29-"));
  const md = join(dir, "paper.md");
  try {
    writeFileSync(
      md,
      [
        "# Test",
        "",
        `Tumors induce wasting [1](<doi:10.1016/j.devcel.2015.03.001>).`,
        "",
      ].join("\n"),
      "utf-8",
    );
    const result = finalizeDoc(md, {
      noCache: true,
      lookupDoi: () => normalized,
    });
    assert.ok(
      result.bibliographyCount >= 1,
      `expected bibliographyCount >= 1, got ${result.bibliographyCount} error=${result.error ?? ""}`,
    );
    const sidecar = JSON.parse(
      readFileSync(md.replace(/\.md$/, ".citations.json"), "utf-8"),
    ) as { citations: Record<string, { vancouver: string; csl?: { issued?: unknown; "container-title"?: string } }> };
    const entry = sidecar.citations?.["1"];
    assert.ok(entry, "sidecar entry for [1] missing");
    const vancouver = entry.vancouver;
    assert.match(vancouver, /2015/, `sidecar vancouver missing year: ${vancouver}`);
    assert.match(
      vancouver,
      /Developmental Cell/,
      `sidecar vancouver missing journal: ${vancouver}`,
    );
    assert.doesNotMatch(vancouver, /\bn\.d\./i, `n.d. leaked into: ${vancouver}`);
    // CSL sidecar must also carry issued + container-title for --live.
    assert.ok(entry.csl, "csl field missing on sidecar entry");
    assert.deepEqual(entry.csl?.issued, { "date-parts": [[2015]] });
    assert.equal(entry.csl?.["container-title"], "Developmental Cell");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
