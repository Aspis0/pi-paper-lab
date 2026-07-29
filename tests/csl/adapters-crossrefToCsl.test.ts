// tests/csl/adapters-crossrefToCsl.test.ts
// Round-trip property tests for the CrossRefWork → CslItem adapter.
// We don't snapshot the exact string output (Citestyle decides that);
// we assert the structural invariants the rest of the pipeline relies on.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { crossrefToCsl } from "../../src/csl/adapters/crossrefToCsl.ts";
import type { CrossRefWork } from "../../src/crossref.ts";

function makeWork(overrides: Partial<CrossRefWork> = {}): CrossRefWork {
  return {
    doi: "10.1242/dmm.049298",
    title: ["Cancer cachexia: lessons from Drosophila"],
    author: [
      { family: "Liu", given: "Ying" },
      { family: "Saavedra", given: "Pedro" },
    ],
    published: { dateParts: [2022, 6, 15] },
    containerTitle: ["Disease Models & Mechanisms"],
    volume: "15",
    issue: "6",
    page: "dmm049298",
    issn: ["1754-8403"],
    url: "https://doi.org/10.1242/dmm.049298",
    publisher: "The Company of Biologists",
    type: "journal-article",
    ...overrides,
  };
}

test("crossrefToCsl: maps family+given authors", () => {
  const csl = crossrefToCsl(makeWork(), "10.1242/dmm.049298");
  assert.equal(csl.author?.length, 2);
  assert.deepEqual(csl.author?.[0], { family: "Liu", given: "Ying" });
  assert.deepEqual(csl.author?.[1], { family: "Saavedra", given: "Pedro" });
});

test("crossrefToCsl: institutional author maps to literal", () => {
  const work = makeWork({
    author: [{ name: "World Health Organization" }],
  });
  const csl = crossrefToCsl(work, "10.1234/who.2020");
  assert.equal(csl.author?.[0]?.literal, "World Health Organization");
  assert.equal(csl.author?.[0]?.family, undefined);
  assert.equal(csl.author?.[0]?.given, undefined);
});

test("crossrefToCsl: prefers published > publishedPrint > publishedOnline", () => {
  // published wins
  const csl1 = crossrefToCsl(
    makeWork({
      published: { dateParts: [2022] },
      publishedPrint: { dateParts: [2023] },
      publishedOnline: { dateParts: [2024] },
    }),
    "10.1234/test",
  );
  assert.deepEqual(csl1.issued, { "date-parts": [[2022]] });

  // publishedPrint wins when published missing
  const csl2 = crossrefToCsl(
    makeWork({
      published: undefined,
      publishedPrint: { dateParts: [2023] },
      publishedOnline: { dateParts: [2024] },
    }),
    "10.1234/test",
  );
  assert.deepEqual(csl2.issued, { "date-parts": [[2023]] });

  // publishedOnline wins when both earlier missing
  const csl3 = crossrefToCsl(
    makeWork({
      published: undefined,
      publishedPrint: undefined,
      publishedOnline: { dateParts: [2024] },
    }),
    "10.1234/test",
  );
  assert.deepEqual(csl3.issued, { "date-parts": [[2024]] });
});

test("crossrefToCsl: missing dates yield undefined issued", () => {
  const work = makeWork({
    published: undefined,
    publishedPrint: undefined,
    publishedOnline: undefined,
  });
  const csl = crossrefToCsl(work, "10.1234/test");
  assert.equal(csl.issued, undefined);
});

test("crossrefToCsl: maps journal-article to article-journal", () => {
  const csl = crossrefToCsl(makeWork({ type: "journal-article" }), "10.x/test");
  assert.equal(csl.type, "article-journal");
});

test("crossrefToCsl: maps book-chapter to chapter", () => {
  const csl = crossrefToCsl(makeWork({ type: "book-chapter" }), "10.x/test");
  assert.equal(csl.type, "chapter");
});

test("crossrefToCsl: maps dissertation to thesis", () => {
  const csl = crossrefToCsl(makeWork({ type: "dissertation" }), "10.x/test");
  assert.equal(csl.type, "thesis");
});

test("crossrefToCsl: unknown type falls back to article", () => {
  const csl = crossrefToCsl(makeWork({ type: "weird-thing" }), "10.x/test");
  assert.equal(csl.type, "article");
});

test("crossrefToCsl: page range en-dash normalization", () => {
  const csl = crossrefToCsl(makeWork({ page: "123--145" }), "10.x/test");
  assert.equal(csl.page, "123\u2013145");
});

test("crossrefToCsl: strips JATS tags from abstract", () => {
  const csl = crossrefToCsl(
    makeWork({
      abstract:
        "<jats:p>Background. <jats:bold>Cancer</jats:bold> is bad.</jats:p> <jats:p>Methods. We did X.</jats:p>",
    }),
    "10.x/test",
  );
  assert.equal(csl.abstract, "Background. Cancer is bad. Methods. We did X.");
});

test("crossrefToCsl: decodes XML entities in abstract", () => {
  const csl = crossrefToCsl(
    makeWork({ abstract: "Tom &amp; Jerry &lt;3 mice" }),
    "10.x/test",
  );
  assert.equal(csl.abstract, "Tom & Jerry <3 mice");
});

test("crossrefToCsl: URL defaults to doi.org if missing", () => {
  const csl = crossrefToCsl(makeWork({ url: undefined }), "10.1234/test");
  assert.equal(csl.URL, "https://doi.org/10.1234/test");
});

test("crossrefToCsl: id derives from DOI", () => {
  const csl = crossrefToCsl(makeWork(), "10.1242/dmm.049298");
  assert.equal(csl.id, "10.1242__dmm.049298");
  assert.equal(csl.DOI, "10.1242/dmm.049298");
});

test("crossrefToCsl: source field is 'crossref'", () => {
  const csl = crossrefToCsl(makeWork(), "10.1242/dmm.049298");
  assert.equal(csl.source, "crossref");
});

test("crossrefToCsl: empty title becomes placeholder", () => {
  const csl = crossrefToCsl(makeWork({ title: [] }), "10.x/test");
  assert.equal(csl.title, "(untitled)");
});