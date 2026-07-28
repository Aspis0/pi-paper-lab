// tests/europepmc.test.ts
// Offline test suite for the Europe PMC source-finder. Mocks `fetch`
// similarly to tests/openalex.test.ts.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { searchEuropePmc } from "../src/source-finders/europepmc.ts";

function withMockFetch(impl: typeof fetch, fn: () => Promise<void>): Promise<void> {
  const original = globalThis.fetch;
  globalThis.fetch = impl as any;
  return fn().finally(() => {
    globalThis.fetch = original;
  });
}

test("searchEuropePmc: happy path returns normalised Findings", async () => {
  await withMockFetch(async (input: any) => {
    const url = String(input);
    assert.ok(url.includes("europepmc.org/RestfulWebService") || url.includes("ebi.ac.uk/europepmc"), "calls Europe PMC");
    assert.ok(url.includes("query="), "uses query param");
    assert.ok(url.includes("format=json"), "asks for JSON");
    assert.ok(url.includes("pageSize="), "pagination param");
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({
        version: "6.9",
        hitCount: 2,
        resultList: {
          result: [
            {
              id: "42299622",
              source: "MED",
              pmid: "42299622",
              pmcid: "PMC9876543",
              doi: "10.1242/dmm.052659",
              title: "A Drosophila tumor model identifies a conserved Upd-JAK/STAT-Akh axis.",
              authorString: "Yu K, Moroak GS, Verheyen EM",
              journalTitle: "Dis Model Mech",
              journalVolume: "19",
              journalIssue: "7",
              pageInfo: "dmm052659",
              pubYear: "2026",
              abstractText: "Cancer cachexia is conserved in Drosophila tumor models.",
              citedByCount: 5,
              isOpenAccess: "N",
              meshHeadingList: {
                meshHeading: [
                  { descriptorName: "Drosophila melanogaster" },
                  { descriptorName: "Cachexia" },
                  { descriptorName: "JAK-STAT Signaling Pathway" },
                ],
              },
              fullTextUrlList: {
                fullTextUrl: [
                  { url: "https://europepmc.org/article/PMC/9876543", documentStyle: "pdf", availability: "Y" },
                ],
              },
            },
            {
              id: "99999999",
              source: "PMC",
              pmid: null,
              pmcid: "PMC9999999",
              doi: null,
              title: "Preprint without DOI",
              authorString: "Smith J, Doe J",
              pubYear: "2024",
            },
          ],
        },
      }),
    } as any;
  }, async () => {
    const findings = await searchEuropePmc("drosophila cachexia", { num: 5 });
    assert.equal(findings.length, 2);

    const first = findings[0]!;
    assert.equal(first.doi, "10.1242/dmm.052659");
    assert.equal(first.title, "A Drosophila tumor model identifies a conserved Upd-JAK/STAT-Akh axis.");
    assert.equal(first.year, 2026);
    assert.equal(first.venue, "Dis Model Mech");
    assert.equal(first.volume, "19");
    assert.equal(first.issue, "7");
    assert.equal(first.pages, "dmm052659");
    assert.equal(first.abstract, "Cancer cachexia is conserved in Drosophila tumor models.");
    assert.equal(first.citedByCount, 5);
    assert.equal(first.isOpenAccess, false, "isOpenAccess 'N' → false");
    assert.equal(first.oaUrl, "https://europepmc.org/article/PMC/9876543");
    assert.equal(first.source, "europepmc");
    assert.deepEqual(first.meshTerms, ["Drosophila melanogaster", "Cachexia", "JAK-STAT Signaling Pathway"]);
    assert.equal(first.confidence, "high", "real title + DOI + abstract → high");
    assert.equal(first.pmid, "42299622");
    assert.equal(first.pmcid, "PMC9876543");
    assert.equal(first.authors.length, 3);
    assert.equal(first.authors[0]!.family, "Yu");

    const second = findings[1]!;
    assert.equal(second.doi, undefined);
    assert.equal(second.pmid, undefined);
    assert.equal(second.pmcid, "PMC9999999");
    assert.deepEqual(second.meshTerms, undefined, "no meshHeadingList → undefined");
    assert.equal(second.confidence, "medium", "no DOI + no abstract but real title → medium");
  });
});

test("searchEuropePmc: respects num option (capped at 50)", async () => {
  let seenUrl = "";
  await withMockFetch(async (input: any) => {
    seenUrl = String(input);
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({ resultList: { result: [] } }),
    } as any;
  }, async () => {
    await searchEuropePmc("test", { num: 7 });
    assert.ok(seenUrl.includes("pageSize=7"), "respects num");

    await searchEuropePmc("test", { num: 999 });
    assert.ok(seenUrl.includes("pageSize=50"), "caps pageSize at 50");
  });
});

test("searchEuropePmc: takes default num=5 when not specified", async () => {
  let seenUrl = "";
  await withMockFetch(async (input: any) => {
    seenUrl = String(input);
    return { ok: true, status: 200, statusText: "OK", json: async () => ({ resultList: { result: [] } }) } as any;
  }, async () => {
    await searchEuropePmc("test");
    assert.ok(seenUrl.includes("pageSize=5"), "default num=5");
  });
});

test("searchEuropePmc: surfaces API errors", async () => {
  await withMockFetch(async () => ({
    ok: false,
    status: 503,
    statusText: "Service Unavailable",
    json: async () => ({}),
  } as any), async () => {
    await assert.rejects(
      searchEuropePmc("test"),
      (err: Error) => /Europe PMC API error: 503/.test(err.message),
    );
  });
});

test("searchEuropePmc: parses structured authors[] when present", async () => {
  await withMockFetch(async () => ({
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => ({
      resultList: {
        result: [
          {
            id: "X",
            doi: "10.1/x",
            title: "T",
            authors: [
              { lastName: "Liu", firstName: "Ying", affiliation: "Harvard" },
              { fullName: "Pedro Saavedra" },
            ],
          },
        ],
      },
    }),
  } as any), async () => {
    const findings = await searchEuropePmc("test");
    assert.equal(findings[0]!.authors.length, 2);
    assert.equal(findings[0]!.authors[0]!.family, "Liu");
    assert.equal(findings[0]!.authors[0]!.given, "Ying");
    assert.equal(findings[0]!.authors[1]!.family, "Pedro");
    assert.equal(findings[0]!.authors[1]!.given, "Saavedra");
  });
});

test("searchEuropePmc: empty resultList returns []", async () => {
  await withMockFetch(async () => ({
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => ({ hitCount: 0, resultList: {} }),
  } as any), async () => {
    const findings = await searchEuropePmc("nothing matches");
    assert.deepEqual(findings, []);
  });
});

test("searchEuropePmc: low confidence when no metadata at all", async () => {
  await withMockFetch(async () => ({
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => ({
      resultList: {
        result: [
          { id: "X", title: null, doi: null, authorString: undefined, authors: undefined },
        ],
      },
    }),
  } as any), async () => {
    const findings = await searchEuropePmc("test");
    assert.equal(findings[0]!.confidence, "low", "sentinel title + no DOI → low");
  });
});
