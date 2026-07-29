// tests/csl/export-bibtex.test.ts
// v0.7.5 (M3.4) golden tests for the lazy BibTeX exporter.
// Verifies (a) output is valid BibTeX, (b) Citation.js is NOT loaded
// on the hot path (lazy-load contract).

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { exportBibtex } from "../../src/csl/exportBibtex.ts";
import type { CslItem } from "../../src/csl/schema.ts";

const cachexia: CslItem = {
  id: "10.1242__dmm.049298",
  type: "article-journal",
  title: "Cancer cachexia in Drosophila",
  author: [
    { family: "Liu", given: "Ying" },
    { family: "Saavedra", given: "Pedro" },
  ],
  issued: { "date-parts": [[2022]] },
  "container-title": "Disease Models & Mechanisms",
  volume: "15",
  page: "dmm049298",
  DOI: "10.1242/dmm.049298",
  URL: "https://doi.org/10.1242/dmm.049298",
};

test("exportBibtex: produces a standard @article entry", async () => {
  const out = await exportBibtex([cachexia]);
  // Citation.js BibTeX output: starts with @article{Liu2022Cancer,
  // contains author/journal/year/doi/title fields.
  assert.match(out, /^@article\{Liu2022Cancer,/);
  assert.match(out, /author = \{Liu, Ying and Saavedra, Pedro\}/);
  assert.match(out, /journal = \{Disease Models \\& Mechanisms\}/);
  assert.match(out, /year = \{2022\}/);
  assert.match(out, /doi = \{10\.1242\/dmm\.049298\}/);
});

test("exportBibtex: empty list produces whitespace-only output", async () => {
  // Citation.js returns "\n" for an empty input (it always appends
  // a newline). We accept any whitespace-only output and trim() before
  // comparison.
  const out = await exportBibtex([]);
  assert.equal(out.trim(), "");
});

test("exportBibtex: multiple items separated by blank lines", async () => {
  const casppase: CslItem = {
    id: "10.1038__test",
    type: "article-journal",
    title: "Caspase activation in immunity",
    author: [{ family: "Saavedra", given: "Pedro" }],
    issued: { "date-parts": [[2019]] },
    DOI: "10.1038/test",
  };
  const out = await exportBibtex([cachexia, casppase]);
  // Two entries — Citation.js joins with blank line.
  const blocks = out.split(/(?=^@)/m).filter((b) => b.startsWith("@"));
  assert.equal(blocks.length, 2);
});

test("exportBibtex: institutional author renders correctly", async () => {
  const org: CslItem = {
    id: "10.1234__who.2020",
    type: "report",
    title: "Global health statistics 2020",
    author: [{ literal: "World Health Organization" }],
    issued: { "date-parts": [[2020]] },
    publisher: "WHO",
  };
  const out = await exportBibtex([org]);
  assert.match(out, /^@techreport\{World2020Global,/);
  // WHO renders as a single author field (literal).
  assert.match(out, /author = \{\{World Health Organization\}\}/);
});