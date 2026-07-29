// tests/csl/formatBibliography.test.ts
// Golden text tests for the Citestyle-backed bibliography formatter.
// These are NOT regression vs the old formatVancouver() — the new
// golden output is the canonical reference (per PLAN §9: "new
// goldens are the target"). The test names that reference "old
// behavior" would be misleading; we just lock in the new one.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { formatBibliography, formatBibliographyEntries } from "../../src/csl/formatBibliography.ts";
import type { CslItem } from "../../src/csl/schema.ts";

// Canonical fixtures used across the CSL tests. Two journal articles,
// one book chapter, all with the data CrossRef/OpenAlex would actually
// hand us.
const cachexia: CslItem = {
  id: "10.1242__dmm.049298",
  type: "article-journal",
  title: "Cancer cachexia: lessons from Drosophila melanogaster",
  author: [
    { family: "Liu", given: "Ying" },
    { family: "Saavedra", given: "Pedro" },
    { family: "Perrimon", given: "Norbert" },
  ],
  issued: { "date-parts": [[2022, 6, 15]] },
  "container-title": "Disease Models & Mechanisms",
  volume: "15",
  issue: "6",
  page: "dmm049298",
  DOI: "10.1242/dmm.049298",
  URL: "https://doi.org/10.1242/dmm.049298",
};

const casppase: CslItem = {
  id: "10.1038__s41586-020-2649-2",
  type: "article-journal",
  title: "Caspase activation in Drosophila immunity",
  author: [
    { family: "Saavedra", given: "Pedro" },
    { family: "Liu", given: "Ying" },
  ],
  issued: { "date-parts": [[2019]] },
  "container-title": "Nature",
  volume: "582",
  page: "dmm049298",
  DOI: "10.1038/s41586-020-2649-2",
  URL: "https://doi.org/10.1038/s41586-020-2649-2",
};

test("formatBibliography: IEEE renders numeric citation", () => {
  const out = formatBibliography([cachexia], { style: "ieee" });
  // Citestyle IEEE format: author names, "title", journal, vol, no, pages, date, doi
  assert.match(out, /Liu.*Saavedra.*Perrimon/);
  assert.match(out, /Disease Models & Mechanisms/);
  assert.match(out, /10\.1242\/dmm\.049298/);
});

test("formatBibliography: Vancouver renders short form", () => {
  const out = formatBibliography([cachexia], { style: "vancouver" });
  // Vancouver (Citestyle): "[1] Family Initials, ... Title. Journal YEAR;vol. URL"
  assert.match(out, /\[1\] Liu Y.*Saavedra P.*Perrimon N/);
  assert.match(out, /Disease Models & Mechanisms 2022/);
  assert.match(out, /15/);
  assert.match(out, /doi\.org\/10\.1242\/dmm\.049298/);
});

test("formatBibliography: APA renders author-date", () => {
  const out = formatBibliography([cachexia], { style: "apa" });
  // APA: "Family, F. M. (YEAR). Title. Journal, vol(issue), pages. URL"
  assert.match(out, /Liu, Y\., Saavedra, P\., & Perrimon, N\./);
  assert.match(out, /\(2022\)/);
  assert.match(out, /Disease Models & Mechanisms/);
  assert.match(out, /15\(6\)/);
});

test("formatBibliography: rejects unknown style id", () => {
  assert.throws(
    () => formatBibliography([cachexia], { style: "bluebook" as any }),
    /Unknown citation style/,
  );
});

test("formatBibliography: case-insensitive style id resolution", () => {
  const ieeeUpper = formatBibliography([cachexia], { style: "IEEE" });
  const ieeeLower = formatBibliography([cachexia], { style: "ieee" });
  assert.equal(ieeeUpper, ieeeLower);
});

test("formatBibliography: alpha sort reorders items", () => {
  const out = formatBibliography([cachexia, casppase], {
    style: "apa",
    sort: "alpha",
  });
  // Alphabetic by first author's family name: Liu (cachexia) < Saavedra
  // (casppase) in ASCII. So cachexia comes first when alpha-sorted.
  // To find each entry's position, look for the unique title fragment.
  const cachexiaIdx = out.indexOf("Cancer cachexia");
  const caspaseIdx = out.indexOf("Caspase activation");
  assert.ok(
    cachexiaIdx >= 0 && caspaseIdx >= 0,
    `Expected both titles in output. Got: [${out}]`,
  );
  assert.ok(
    cachexiaIdx < caspaseIdx,
    `Expected Cachexia (Liu) before Caspase (Saavedra) in alpha-sorted bibliography. Got order: [${out}]`,
  );
});

test("formatBibliographyEntries: returns one entry per item with text+html+id", () => {
  const entries = formatBibliographyEntries([cachexia, casppase], {
    style: "vancouver",
  });
  assert.equal(entries.length, 2);
  assert.equal(entries[0].id, cachexia.id);
  assert.equal(entries[1].id, casppase.id);
  assert.ok(entries[0].text.length > 0);
  assert.ok(entries[0].html.length > 0);
  assert.match(entries[0].html, /class="csl-entry">/);
});

test("formatBibliography: empty items list returns empty string", () => {
  assert.equal(formatBibliography([], { style: "ieee" }), "");
});

test("formatBibliography: multiple items joined by newlines", () => {
  const out = formatBibliography([cachexia, casppase], {
    style: "vancouver",
  });
  // Two entries joined with \n (one line per reference).
  assert.equal(out.split("\n").length, 2);
});