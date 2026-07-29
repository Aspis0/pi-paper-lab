// tests/library/cli.test.ts
// Subprocess tests for bin/library.mjs. The CLI is the user-facing
// surface for the local library. We test argv parsing, error paths,
// and the offline-only commands (`list`, `search`, `stats`).
//
// Network-dependent commands (`add <doi>`, `add-from-search`) are
// covered by integration tests run manually with `npm run
// test:library:integration` (planned for M5; we skip them in unit
// tests to keep them offline-only per PLAN §9).

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(process.cwd(), "bin", "library.mjs");

function run(args: string[], cwd: string) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    cwd,
    timeout: 30_000,
  });
}

function makeProject(): string {
  return mkdtempSync(join(tmpdir(), "lib-cli-"));
}

test("CLI: --help exits 0 and prints usage", () => {
  const dir = makeProject();
  try {
    const r = run(["--help"], dir);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /paper-lab-library/);
    assert.match(r.stdout, /add/);
    assert.match(r.stdout, /search/);
    assert.match(r.stdout, /list/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI: missing command exits 1 with help", () => {
  const dir = makeProject();
  try {
    const r = run([], dir);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /paper-lab-library/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI: unknown command exits 1", () => {
  const dir = makeProject();
  try {
    const r = run(["nonexistent"], dir);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Unknown command/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI: stats on empty library prints 0 entries", () => {
  const dir = makeProject();
  try {
    const r = run(["stats"], dir);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /0 entries/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI: list on empty library prints Total: 0", () => {
  const dir = makeProject();
  try {
    const r = run(["list"], dir);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /Total: 0/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI: search on empty library prints 'No matches'", () => {
  const dir = makeProject();
  try {
    const r = run(["search", "cachexia"], dir);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /No matches/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI: list requires no args", () => {
  const dir = makeProject();
  try {
    const r = run(["list"], dir);
    assert.equal(r.status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CRIT-4: --domain filters by title/abstract keyword, not author JSON", () => {
  // Bug: the old filter was `JSON.stringify(p.author).includes(domain)`,
  // which matched against the author array's JSON serialization. The
  // user would run `paper-lab-library list --domain drosophila` and
  // get 0 results even when the library has Drosophila papers.
  // Fix: we now filter on title + container-title + abstract (lowercased).
  const dir = makeProject();
  try {
    const f = join(dir, "refs.json");
    writeFileSync(
      f,
      JSON.stringify([
        {
          id: "10.1242__cachexia",
          type: "article-journal",
          title: "Cancer cachexia in Drosophila melanogaster",
          author: [{ family: "Liu", given: "Ying" }],
          issued: { "date-parts": [[2022]] },
          DOI: "10.1242/dmm.049298",
          abstract: "Cachexia is a wasting syndrome in flies.",
        },
        {
          id: "10.1038__caspase",
          type: "article-journal",
          title: "Caspase activation in mice",
          author: [{ family: "Smith", given: "John" }],
          issued: { "date-parts": [[2019]] },
          DOI: "10.1038/caspase",
          abstract: "Caspases drive programmed cell death in mammals.",
        },
      ]),
    );
    run(["import", f], dir);
    // Filter for drosophila — should match the cachexia paper.
    const r = run(["list", "--domain", "drosophila"], dir);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /Cancer cachexia/);
    assert.ok(!r.stdout.includes("Caspase"), "mouse paper should NOT match drosophila filter");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI: search without query exits 1", () => {
  const dir = makeProject();
  try {
    const r = run(["search"], dir);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Usage/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI: add without DOI exits 1", () => {
  const dir = makeProject();
  try {
    const r = run(["add"], dir);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Usage/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI: import requires a file path", () => {
  const dir = makeProject();
  try {
    const r = run(["import"], dir);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Usage/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI: import missing file exits 2", () => {
  const dir = makeProject();
  try {
    const r = run(["import", "/nonexistent.bib"], dir);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /not found/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI: import of unsupported extension exits 5", () => {
  const dir = makeProject();
  try {
    const f = join(dir, "refs.docx");
    writeFileSync(f, "garbage");
    const r = run(["import", f], dir);
    assert.equal(r.status, 5);
    assert.match(r.stderr, /Unsupported file extension/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI: import of malformed JSON exits 4", () => {
  const dir = makeProject();
  try {
    const f = join(dir, "refs.json");
    writeFileSync(f, "{ this is not valid JSON");
    const r = run(["import", f], dir);
    assert.equal(r.status, 4);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI: import of CSL-JSON array adds entries to library", () => {
  const dir = makeProject();
  try {
    const f = join(dir, "refs.json");
    writeFileSync(
      f,
      JSON.stringify([
        {
          id: "10.1242__dmm.049298",
          type: "article-journal",
          title: "Cancer cachexia in Drosophila",
          author: [{ family: "Liu", given: "Ying" }],
          issued: { "date-parts": [[2022]] },
          DOI: "10.1242/dmm.049298",
        },
      ]),
    );
    const r = run(["import", f], dir);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /Imported 1/);
    // Now list should show 1 entry.
    const r2 = run(["list"], dir);
    assert.match(r2.stdout, /Total: 1/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI: export with empty library exits 3", () => {
  const dir = makeProject();
  try {
    const r = run(["export", "--format", "bibtex"], dir);
    assert.equal(r.status, 3);
    assert.match(r.stderr, /Library is empty/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI: sync creates index.sqlite", () => {
  const dir = makeProject();
  try {
    // Pre-populate the library by importing a CSL-JSON file.
    const f = join(dir, "refs.json");
    writeFileSync(
      f,
      JSON.stringify([
        {
          id: "10.1242__dmm.049298",
          type: "article-journal",
          title: "Cachexia",
          DOI: "10.1242/dmm.049298",
        },
      ]),
    );
    run(["import", f], dir);
    // Now sync.
    const r = run(["sync"], dir);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /Synced 1/);
    assert.ok(existsSync(join(dir, "paper-lab-library", "index.sqlite")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});