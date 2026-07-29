// tests/library/bm25.test.ts
// Unit tests for the BM25 index. We use a small fixture (~6 papers)
// to verify tokenization, IDF computation, length normalisation,
// and ranking stability.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { BM25Index, tokenize, tokenizeForIndex } from "../../src/library/bm25.ts";
import type { CslItem } from "../../src/csl/schema.ts";

const fixture: CslItem[] = [
  {
    id: "cachexia-drosophila",
    type: "article-journal",
    title: "Cancer cachexia in Drosophila melanogaster",
    abstract: "Cachexia is a wasting syndrome associated with cancer. We studied it in flies.",
    author: [{ family: "Liu" }, { family: "Saavedra" }],
    issued: { "date-parts": [[2022]] },
  },
  {
    id: "caspase-immunity",
    type: "article-journal",
    title: "Caspase activation in Drosophila immunity",
    abstract: "Caspases drive programmed cell death during infection.",
    author: [{ family: "Saavedra" }],
    issued: { "date-parts": [[2019]] },
  },
  {
    id: "il6-inflammation",
    type: "article-journal",
    title: "IL-6 signalling in chronic inflammation",
    abstract: "Interleukin-6 (IL-6) is a cytokine involved in cachexia and inflammation.",
    author: [{ family: "Tanaka" }],
    issued: { "date-parts": [[2021]] },
  },
  {
    id: "unrelated-neuro",
    type: "article-journal",
    title: "Neural crest migration in zebrafish",
    abstract: "Neural crest cells migrate during vertebrate embryogenesis.",
    author: [{ family: "Kim" }],
    issued: { "date-parts": [[2020]] },
  },
  {
    id: "drosophila-genetics",
    type: "article-journal",
    title: "Forward genetics in Drosophila",
    abstract: "We performed a forward genetic screen in flies.",
    author: [{ family: "Perrimon" }],
    issued: { "date-parts": [[2018]] },
  },
];

test("tokenize: lowercase + strip punctuation + collapse whitespace", () => {
  assert.deepEqual(tokenize("Hello, World!  Foo bar."), ["hello", "world", "foo", "bar"]);
});

test("tokenizeForIndex: removes English stop-words", () => {
  assert.deepEqual(
    tokenizeForIndex("The cachexia in the mouse and the fly"),
    ["cachexia", "mouse", "fly"],
  );
});

test("BM25Index: empty input has size 0", () => {
  const idx = new BM25Index();
  idx.index([]);
  assert.equal(idx.size, 0);
});

test("BM25Index: search on empty index returns no hits", () => {
  const idx = new BM25Index();
  idx.index([]);
  assert.deepEqual(idx.search("cachexia"), []);
});

test("BM25Index: search on empty query returns no hits", () => {
  const idx = new BM25Index();
  idx.index(fixture);
  assert.deepEqual(idx.search(""), []);
  assert.deepEqual(idx.search("   "), []);
});

test("BM25Index: ranks the most relevant doc first", () => {
  const idx = new BM25Index();
  idx.index(fixture);
  const hits = idx.search("cachexia", 5);
  assert.ok(hits.length > 0);
  assert.equal(hits[0].id, "cachexia-drosophila");
});

test("BM25Index: IL-6 query ranks IL-6 paper first", () => {
  const idx = new BM25Index();
  idx.index(fixture);
  const hits = idx.search("IL-6 cytokine", 5);
  assert.ok(hits.length > 0);
  assert.equal(hits[0].id, "il6-inflammation");
});

test("BM25Index: cachexia query also matches IL-6 paper (mentions cachexia in abstract)", () => {
  const idx = new BM25Index();
  idx.index(fixture);
  const hits = idx.search("cachexia", 5);
  const ids = hits.map((h) => h.id);
  assert.ok(ids.includes("cachexia-drosophila"));
  assert.ok(ids.includes("il6-inflammation"), "IL-6 abstract mentions cachexia; should match");
});

test("BM25Index: unrelated topic (neural crest) doesn't match Drosophila papers", () => {
  const idx = new BM25Index();
  idx.index(fixture);
  const hits = idx.search("neural crest zebrafish", 5);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].id, "unrelated-neuro");
});

test("BM25Index: topN limits results", () => {
  const idx = new BM25Index();
  idx.index(fixture);
  const hits = idx.search("Drosophila", 2);
  assert.ok(hits.length <= 2);
});

test("BM25Index: rerunning index() replaces previous state", () => {
  const idx = new BM25Index();
  idx.index(fixture);
  assert.equal(idx.size, 5);
  idx.index([fixture[0]]);
  assert.equal(idx.size, 1);
  const hits = idx.search("neural crest");
  assert.equal(hits.length, 0);
});

test("BM25Index: scores are non-negative", () => {
  const idx = new BM25Index();
  idx.index(fixture);
  const hits = idx.search("cachexia IL-6", 10);
  for (const hit of hits) {
    assert.ok(hit.score >= 0, `Score for ${hit.id} should be non-negative: ${hit.score}`);
  }
});

test("BM25Index: length normalisation favours shorter matching docs", () => {
  // Create two docs, both contain "cachexia", one is much longer.
  const long: CslItem = {
    id: "long",
    type: "article-journal",
    title: "Cachexia",
    abstract: "lorem ipsum ".repeat(500),
  };
  const short: CslItem = {
    id: "short",
    type: "article-journal",
    title: "Cachexia",
    abstract: "Cachexia in flies.",
  };
  const idx = new BM25Index();
  idx.index([long, short]);
  const hits = idx.search("cachexia", 2);
  // The short doc has a higher density of "cachexia" per unit length.
  // BM25's b parameter (default 0.75) gives the short doc a higher score.
  assert.equal(hits[0].id, "short");
});