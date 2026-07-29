// tests/csl/export-ris.test.ts
// v0.7.5 (M3.4) tests for the lazy RIS exporter.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { exportRis } from "../../src/csl/exportRis.ts";
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
};

test("exportRis: produces a standard RIS entry", async () => {
  const out = await exportRis([cachexia]);
  // RIS starts with TY  - JOUR for journal articles.
  assert.match(out, /^TY  - JOUR\n/);
  assert.match(out, /AU  - Liu, Ying\n/);
  assert.match(out, /AU  - Saavedra, Pedro\n/);
  assert.match(out, /TI  - Cancer cachexia in Drosophila\n/);
  assert.match(out, /T2  - Disease Models & Mechanisms\n/);
  assert.match(out, /PY  - 2022\n/);
  assert.match(out, /DO  - 10\.1242\/dmm\.049298\n/);
  // Each entry ends with ER  - .
  assert.match(out, /\nER  - \n?$/);
});

test("exportRis: empty list produces whitespace-only output", async () => {
  const out = await exportRis([]);
  assert.equal(out.trim(), "");
});

test("exportRis: multiple items separated by ER boundary", async () => {
  const casppase: CslItem = {
    id: "10.1038__test",
    type: "article-journal",
    title: "Caspase activation in immunity",
    author: [{ family: "Saavedra", given: "Pedro" }],
    issued: { "date-parts": [[2019]] },
  };
  const out = await exportRis([cachexia, casppase]);
  // Two ER markers.
  const erCount = (out.match(/^ER  - /gm) ?? []).length;
  assert.equal(erCount, 2);
});

test("exportRis: book type emits TY  - BOOK", async () => {
  const book: CslItem = {
    id: "10.1234__book.2020",
    type: "book",
    title: "Methods in cancer research",
    author: [{ family: "Hanahan", given: "Douglas" }],
    issued: { "date-parts": [[2020]] },
    publisher: "Cold Spring Harbor",
  };
  const out = await exportRis([book]);
  assert.match(out, /^TY  - BOOK\n/);
  assert.match(out, /PB  - Cold Spring Harbor\n/);
});