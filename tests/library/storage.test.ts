// tests/library/storage.test.ts
// Tests for the file-directory CRUD + sql.js cache. Each test gets
// its own temporary library directory to avoid cross-test pollution.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  libraryRoot,
  addPaper,
  getPaper,
  listPapers,
  lookupByDoi,
  removePaper,
  stats,
  syncCache,
} from "../../src/library/storage.ts";
import type { CslItem } from "../../src/csl/schema.ts";

function makeLib(): string {
  const dir = mkdtempSync(join(tmpdir(), "paper-lib-"));
  return dir;
}

function sampleCsl(overrides: Partial<CslItem> = {}): CslItem {
  return {
    id: "10.1242__dmm.049298",
    type: "article-journal",
    title: "Cancer cachexia in Drosophila",
    author: [
      { family: "Liu", given: "Ying" },
      { family: "Saavedra", given: "Pedro" },
    ],
    issued: { "date-parts": [[2022]] },
    "container-title": "Disease Models & Mechanisms",
    DOI: "10.1242/dmm.049298",
    abstract: "Cachexia is bad.",
    source: "user",
    ...overrides,
  };
}

test("libraryRoot: returns <projectRoot>/paper-lab-library", () => {
  assert.equal(libraryRoot("/some/proj"), join("/some/proj", "paper-lab-library"));
});

test("addPaper: creates a paper directory with metadata.json + abstract.txt", () => {
  const lib = makeLib();
  try {
    const dir = addPaper(lib, sampleCsl());
    assert.ok(existsSync(join(dir, "metadata.json")));
    assert.ok(existsSync(join(dir, "abstract.txt")));
    const meta = JSON.parse(readFileSync(join(dir, "metadata.json"), "utf8"));
    assert.equal(meta.id, "10.1242__dmm.049298");
    assert.equal(meta.title, "Cancer cachexia in Drosophila");
    const abstract = readFileSync(join(dir, "abstract.txt"), "utf8");
    assert.equal(abstract, "Cachexia is bad.");
  } finally {
    rmSync(lib, { recursive: true, force: true });
  }
});

test("addPaper: stamps addedAt + addedVia + source if missing", () => {
  const lib = makeLib();
  try {
    addPaper(lib, sampleCsl({ addedAt: undefined, addedVia: undefined, source: undefined }));
    const p = getPaper(lib, "10.1242__dmm.049298");
    assert.ok(p && typeof p.addedAt === "number");
    assert.equal(p.addedVia, "user");
    assert.equal(p.source, "user");
  } finally {
    rmSync(lib, { recursive: true, force: true });
  }
});

test("addPaper: idempotent on id (overwrites existing)", () => {
  const lib = makeLib();
  try {
    addPaper(lib, sampleCsl({ title: "Original" }));
    addPaper(lib, sampleCsl({ title: "Updated" }));
    const p = getPaper(lib, "10.1242__dmm.049298");
    assert.equal(p?.title, "Updated");
    // Only one paper.
    assert.equal(listPapers(lib).length, 1);
  } finally {
    rmSync(lib, { recursive: true, force: true });
  }
});

test("addPaper: missing abstract writes empty file (directory shape consistent)", () => {
  const lib = makeLib();
  try {
    addPaper(lib, sampleCsl({ abstract: undefined }));
    const abstract = readFileSync(
      join(lib, "papers", "10.1242__dmm.049298", "abstract.txt"),
      "utf8",
    );
    assert.equal(abstract, "");
  } finally {
    rmSync(lib, { recursive: true, force: true });
  }
});

test("getPaper: returns null for missing id", () => {
  const lib = makeLib();
  try {
    assert.equal(getPaper(lib, "10.9999__missing"), null);
  } finally {
    rmSync(lib, { recursive: true, force: true });
  }
});

test("removePaper: returns true when paper existed", () => {
  const lib = makeLib();
  try {
    addPaper(lib, sampleCsl());
    assert.equal(removePaper(lib, "10.1242__dmm.049298"), true);
    assert.equal(getPaper(lib, "10.1242__dmm.049298"), null);
  } finally {
    rmSync(lib, { recursive: true, force: true });
  }
});

test("removePaper: returns false when paper missing", () => {
  const lib = makeLib();
  try {
    assert.equal(removePaper(lib, "10.9999__missing"), false);
  } finally {
    rmSync(lib, { recursive: true, force: true });
  }
});

test("listPapers: empty library returns empty array", () => {
  const lib = makeLib();
  try {
    assert.deepEqual(listPapers(lib), []);
  } finally {
    rmSync(lib, { recursive: true, force: true });
  }
});

test("listPapers: returns all added papers", () => {
  const lib = makeLib();
  try {
    addPaper(lib, sampleCsl({ id: "10.1242__dmm.049298" }));
    addPaper(lib, sampleCsl({ id: "10.1038__test", DOI: "10.1038/test" }));
    const papers = listPapers(lib);
    assert.equal(papers.length, 2);
  } finally {
    rmSync(lib, { recursive: true, force: true });
  }
});

test("lookupByDoi: returns paper by DOI hash", () => {
  const lib = makeLib();
  try {
    addPaper(lib, sampleCsl());
    const p = lookupByDoi(lib, "10.1242/dmm.049298");
    assert.equal(p?.id, "10.1242__dmm.049298");
  } finally {
    rmSync(lib, { recursive: true, force: true });
  }
});

test("lookupByDoi: returns null for unknown DOI", () => {
  const lib = makeLib();
  try {
    assert.equal(lookupByDoi(lib, "10.9999/missing"), null);
  } finally {
    rmSync(lib, { recursive: true, force: true });
  }
});

test("stats: counts papers + sums abstract bytes", () => {
  const lib = makeLib();
  try {
    addPaper(lib, sampleCsl({ abstract: "abcde" }));
    addPaper(lib, sampleCsl({ id: "10.1038__test", DOI: "10.1038/test", abstract: "xyz" }));
    const s = stats(lib);
    assert.equal(s.count, 2);
    assert.equal(s.totalAbstractBytes, 8); // 5 + 3
  } finally {
    rmSync(lib, { recursive: true, force: true });
  }
});

test("syncCache: builds index.sqlite from filesystem", async () => {
  const lib = makeLib();
  try {
    addPaper(lib, sampleCsl());
    addPaper(lib, sampleCsl({ id: "10.1038__test", DOI: "10.1038/test" }));
    const n = await syncCache(lib);
    assert.equal(n, 2);
    assert.ok(existsSync(join(lib, "index.sqlite")));
    // SQLite header: starts with "SQLite format 3\0"
    const buf = readFileSync(join(lib, "index.sqlite"));
    const header = buf.subarray(0, 15).toString("utf8");
    assert.ok(header.startsWith("SQLite format 3"));
  } finally {
    rmSync(lib, { recursive: true, force: true });
  }
});

test("syncCache: rebuild is idempotent (same papers → same count)", async () => {
  const lib = makeLib();
  try {
    addPaper(lib, sampleCsl());
    await syncCache(lib);
    const n1 = await syncCache(lib);
    assert.equal(n1, 1);
  } finally {
    rmSync(lib, { recursive: true, force: true });
  }
});

test("syncCache: empty library writes an empty DB", async () => {
  const lib = makeLib();
  try {
    const n = await syncCache(lib);
    assert.equal(n, 0);
    assert.ok(existsSync(join(lib, "index.sqlite")));
  } finally {
    rmSync(lib, { recursive: true, force: true });
  }
});