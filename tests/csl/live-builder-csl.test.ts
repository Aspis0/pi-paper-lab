// tests/csl/live-builder-csl.test.ts
// Tests that cslItemsToWordSources produces the right WordLiveBuilderSource
// for buildWordLive. This is the bridge that replaces the v0.7.0 regex
// Vancouver parser; if these tests pass, the bug surface from the M4
// audit (CRIT-3, CRIT-4, MED-1, MED-2, MED-3) cannot re-occur from
// this path.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  cslItemToWordSource,
  cslItemsToWordSources,
} from "../../src/word-live-builder.ts";
import type { CslItem } from "../../src/csl/schema.ts";

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

test("cslItemToWordSource: numeric id comes from caller, not from CslItem.id", () => {
  // The CslItem id is a DOI hash (10.1242__dmm.049298), but Word's
  // b:Tag uses the citation-order index (1, 2, 3). We must NOT
  // substitute the DOI hash for the number — that would break
  // Word's renumbering on F9.
  const ws = cslItemToWordSource(cachexia, 1);
  assert.equal(ws.id, 1);
  assert.equal(ws.tag, "Ref1");
});

test("cslItemToWordSource: maps family/given authors", () => {
  const ws = cslItemToWordSource(cachexia, 1);
  assert.equal(ws.authors?.length, 3);
  assert.deepEqual(ws.authors?.[0], { family: "Liu", given: "Ying" });
});

test("cslItemToWordSource: institutional author maps to family+empty given", () => {
  const ws = cslItemToWordSource(
    {
      ...cachexia,
      author: [{ literal: "World Health Organization" }],
    },
    1,
  );
  assert.equal(ws.authors?.[0]?.family, "World Health Organization");
  assert.equal(ws.authors?.[0]?.given, "");
});

test("cslItemToWordSource: maps title, journal, volume, issue, pages", () => {
  const ws = cslItemToWordSource(cachexia, 1);
  assert.equal(ws.title, cachexia.title);
  assert.equal(ws.journal, "Disease Models & Mechanisms");
  assert.equal(ws.volume, "15");
  assert.equal(ws.issue, "6");
  assert.equal(ws.pages, "dmm049298");
});

test("cslItemToWordSource: year is string from date-parts[0][0]", () => {
  const ws = cslItemToWordSource(cachexia, 1);
  assert.equal(ws.year, "2022");
});

test("cslItemToWordSource: maps DOI and URL", () => {
  const ws = cslItemToWordSource(cachexia, 1);
  assert.equal(ws.doi, "10.1242/dmm.049298");
  assert.equal(ws.url, "https://doi.org/10.1242/dmm.049298");
});

test("cslItemsToWordSources: assigns 1..N numeric ids in input order", () => {
  const items: CslItem[] = [
    { ...cachexia, id: "10.1242__dmm.049298" },
    { ...cachexia, id: "10.1038__s41586-020-2649-2" },
    { ...cachexia, id: "10.1234__other" },
  ];
  const ws = cslItemsToWordSources(items);
  assert.equal(ws.length, 3);
  assert.equal(ws[0].id, 1);
  assert.equal(ws[1].id, 2);
  assert.equal(ws[2].id, 3);
  assert.equal(ws[0].tag, "Ref1");
  assert.equal(ws[1].tag, "Ref2");
  assert.equal(ws[2].tag, "Ref3");
});

test("cslItemsToWordSources: empty list returns empty array", () => {
  assert.deepEqual(cslItemsToWordSources([]), []);
});

test("cslItemToWordSource: missing title becomes placeholder", () => {
  const ws = cslItemToWordSource({ ...cachexia, title: undefined }, 1);
  assert.equal(ws.title, "(untitled)");
});

test("cslItemToWordSource: missing issued yields no year", () => {
  const ws = cslItemToWordSource({ ...cachexia, issued: undefined }, 1);
  assert.equal(ws.year, undefined);
});