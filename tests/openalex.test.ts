// tests/openalex.test.ts
// Offline test suite for the OpenAlex source-finder. Mocks `fetch` so the
// tests don't hit api.openalex.org. The shape of the mocked response
// mirrors the real OpenAlex response (camelCase keys allowed at the
// boundary but the codebase speaks kebab-case OpenAlex keys).

import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  searchOpenAlex,
  reconstructAbstract,
} from "../src/source-finders/openalex.ts";

// Helper: monkey-patch `globalThis.fetch` for one test, restore in finally.
function withMockFetch(impl: typeof fetch, fn: () => Promise<void>): Promise<void> {
  const original = globalThis.fetch;
  globalThis.fetch = impl as any;
  return fn().finally(() => {
    globalThis.fetch = original;
  });
}

test("reconstructAbstract: real OpenAlex inverted-index format", () => {
  const inverted = {
    "Cancer": [0],
    "cachexia": [1],
    "is": [2],
    "a": [3, 7],
    "set": [4],
    "of": [5, 8],
    "syndromes": [6, 9],
  };
  assert.equal(
    reconstructAbstract(inverted),
    "Cancer cachexia is a set of syndromes a of syndromes",
  );
});

test("reconstructAbstract: empty input returns empty string", () => {
  assert.equal(reconstructAbstract({}), "");
});

test("reconstructAbstract: tolerates non-array values gracefully", () => {
  const inverted = { "Cancer": [0] as number[], "bad": null as any };
  assert.equal(reconstructAbstract(inverted), "Cancer");
});

test("searchOpenAlex: happy path returns normalised Findings", async () => {
  await withMockFetch(async (input: any) => {
    const url = String(input);
    assert.ok(url.includes("api.openalex.org/works"), "calls the right endpoint");
    assert.ok(url.includes("search="), "uses search query");
    assert.ok(url.includes("mailto="), "polite pool with mailto");
    assert.ok(url.includes("per_page="), "pagination param");
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({
        meta: { count: 2, per_page: 5 },
        results: [
          {
            id: "https://openalex.org/W2741809807",
            doi: "https://doi.org/10.1242/dmm.049298",
            title: "Cancer cachexia: lessons from Drosophila",
            authorships: [
              { author: { display_name: "Liu, Ying", orcid: "https://orcid.org/0000-0001-2345-6789" } },
              { author: { display_name: "Saavedra, Pedro" } },
            ],
            publication_year: 2022,
            primary_location: { source: { display_name: "Disease Models & Mechanisms" } },
            open_access: { is_oa: true, oa_url: "https://example.com/pdf" },
            cited_by_count: 42,
            concepts: [
              { display_name: "Wasting", score: 0.9 },
              { display_name: "Biology", score: 0.3 },
              { display_name: "Cachexia", score: 0.8 },
            ],
            abstract_inverted_index: {
              "Cancer": [0], "cachexia": [1], "is": [2], "common": [3],
            },
            biblio: { volume: "15", issue: "7", first_page: "dmm049298", last_page: "dmm049298" },
          },
          {
            id: "https://openalex.org/W2345678901",
            doi: null,
            title: "Conference paper without DOI",
            authorships: [{ author: { display_name: "Smith, John" } }],
            publication_year: 2020,
          },
        ],
      }),
    } as any;
  }, async () => {
    const findings = await searchOpenAlex("cachexia drosophila", { num: 5 });
    assert.equal(findings.length, 2);
    const first = findings[0]!;
    assert.equal(first.doi, "10.1242/dmm.049298", "doi stripped of https://doi.org/ prefix");
    assert.equal(first.title, "Cancer cachexia: lessons from Drosophila");
    assert.equal(first.year, 2022);
    assert.equal(first.venue, "Disease Models & Mechanisms");
    assert.equal(first.citedByCount, 42);
    assert.equal(first.isOpenAccess, true);
    assert.equal(first.oaUrl, "https://example.com/pdf");
    assert.equal(first.abstract, "Cancer cachexia is common");
    assert.deepEqual(first.concepts, ["Wasting", "Cachexia"], "concepts filtered by score >= 0.4");
    assert.equal(first.source, "openalex");
    assert.equal(first.confidence, "high", "abstract present → high confidence");
    assert.equal(first.openAlexId, "https://openalex.org/W2741809807");
    assert.equal(first.authors.length, 2);
    assert.equal(first.authors[0]!.family, "Liu");
    assert.equal(first.authors[0]!.given, "Ying");
    assert.equal(first.authors[0]!.orcid, "https://orcid.org/0000-0001-2345-6789");
    assert.equal(first.pages, "dmm049298-dmm049298");

    const second = findings[1]!;
    assert.equal(second.doi, undefined, "DOI absent when null in source");
    assert.equal(second.abstract, undefined);
    assert.equal(second.confidence, "medium", "no abstract → medium confidence");
  });
});

test("searchOpenAlex: respects num option (capped at 50)", async () => {
  let seenUrl = "";
  await withMockFetch(async (input: any) => {
    seenUrl = String(input);
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({ results: [] }),
    } as any;
  }, async () => {
    await searchOpenAlex("test", { num: 7 });
    assert.ok(seenUrl.includes("per_page=7"), "respects num");

    await searchOpenAlex("test", { num: 999 });
    assert.ok(seenUrl.includes("per_page=50"), "caps per_page at 50 (OpenAlex limit)");
  });
});

test("searchOpenAlex: surfaces API errors", async () => {
  await withMockFetch(async () => ({
    ok: false,
    status: 429,
    statusText: "Too Many Requests",
    json: async () => ({}),
  } as any), async () => {
    await assert.rejects(
      searchOpenAlex("test"),
      (err: Error) => /OpenAlex API error: 429/.test(err.message),
    );
  });
});

test("searchOpenAlex: takes default num=5 when not specified", async () => {
  let seenUrl = "";
  await withMockFetch(async (input: any) => {
    seenUrl = String(input);
    return { ok: true, status: 200, statusText: "OK", json: async () => ({ results: [] }) } as any;
  }, async () => {
    await searchOpenAlex("test");
    assert.ok(seenUrl.includes("per_page=5"), "default num=5");
  });
});
