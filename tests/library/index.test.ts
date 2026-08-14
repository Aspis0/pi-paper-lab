// tests/library/index.test.ts
// Integration tests for the Library class. Each test uses a fresh
// temp directory for the library root.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Library } from "../../src/library/index.ts";
import type { CslItem } from "../../src/csl/schema.ts";

function makeProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "library-test-"));
  return dir;
}

function cachexia(overrides: Partial<CslItem> = {}): CslItem {
  return {
    id: "10.1242__dmm.049298",
    type: "article-journal",
    title: "Cancer cachexia in Drosophila",
    author: [{ family: "Liu", given: "Ying" }],
    issued: { "date-parts": [[2022]] },
    DOI: "10.1242/dmm.049298",
    abstract: "Cachexia is a wasting syndrome in cancer patients.",
    source: "user",
    ...overrides,
  };
}

test("Library.init: creates the library directory if missing", async () => {
  const project = makeProject();
  try {
    const lib = new Library(project);
    assert.equal(existsSync(lib.path), false);
    await lib.init();
    assert.equal(existsSync(lib.path), true);
    assert.equal(existsSync(join(lib.path, "README.md")), true);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("Library.init: is idempotent (re-init doesn't wipe data)", async () => {
  const project = makeProject();
  try {
    const lib = new Library(project);
    await lib.init();
    lib.add(cachexia());
    await lib.init();
    assert.equal(lib.size, 1, "Second init must not lose papers");
    assert.equal(lib.get("10.1242__dmm.049298")?.title, "Cancer cachexia in Drosophila");
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("Library.add: returns directory path", async () => {
  const project = makeProject();
  try {
    const lib = new Library(project);
    await lib.init();
    const dir = lib.add(cachexia());
    // Windows uses \ separators; POSIX uses /. We match the path
    // suffix without hardcoding the separator.
    const sep = (await import("node:path")).sep;
    assert.ok(
      dir.endsWith(`papers${sep}10.1242__dmm.049298`),
      `Expected path to end with papers${sep}10.1242__dmm.049298, got: ${dir}`,
    );
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("Library.add: updates in-memory cache for BM25 search", async () => {
  const project = makeProject();
  try {
    const lib = new Library(project);
    await lib.init();
    lib.add(cachexia());
    const hits = lib.search("cachexia cancer", 5);
    assert.ok(hits.length > 0);
    assert.equal(hits[0].id, "10.1242__dmm.049298");
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("Library.lookupByDoi: finds paper by canonical DOI", async () => {
  const project = makeProject();
  try {
    const lib = new Library(project);
    await lib.init();
    lib.add(cachexia());
    const p = lib.lookupByDoi("10.1242/dmm.049298");
    assert.equal(p?.id, "10.1242__dmm.049298");
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("Library.remove: deletes paper from filesystem + cache", async () => {
  const project = makeProject();
  try {
    const lib = new Library(project);
    await lib.init();
    lib.add(cachexia());
    assert.equal(lib.size, 1);
    assert.equal(lib.remove("10.1242__dmm.049298"), true);
    assert.equal(lib.size, 0);
    assert.equal(lib.get("10.1242__dmm.049298"), null);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("Library.search: returns top-N hits sorted by score", async () => {
  const project = makeProject();
  try {
    const lib = new Library(project);
    await lib.init();
    lib.add(cachexia());
    lib.add(cachexia({
      id: "10.1038__caspase",
      DOI: "10.1038/caspase",
      title: "Caspase activation in flies",
      abstract: "Caspases in immunity.",
    }));
    const hits = lib.search("cachexia cancer", 5);
    assert.ok(hits[0].id === "10.1242__dmm.049298");
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("Library.sync: builds SQLite cache", async () => {
  const project = makeProject();
  try {
    const lib = new Library(project);
    await lib.init();
    lib.add(cachexia());
    const n = await lib.sync();
    assert.equal(n, 1);
    assert.ok(existsSync(join(lib.path, "index.sqlite")));
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("Library.stats: returns count + bytes", async () => {
  const project = makeProject();
  try {
    const lib = new Library(project);
    await lib.init();
    lib.add(cachexia({ abstract: "abcde" }));
    const s = lib.stats();
    assert.equal(s.count, 1);
    assert.equal(s.totalAbstractBytes, 5);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("Library.list: returns all papers", async () => {
  const project = makeProject();
  try {
    const lib = new Library(project);
    await lib.init();
    lib.add(cachexia());
    lib.add(cachexia({
      id: "10.1038__test",
      DOI: "10.1038/test",
      title: "Other paper",
    }));
    const papers = lib.list();
    assert.equal(papers.length, 2);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});