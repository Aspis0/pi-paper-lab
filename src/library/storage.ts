/**
 * Local library storage — file directory CRUD + sql.js SQLite cache.
 *
 * Plan §13.2 storage layout (per-project, gitignored):
 *
 *   <projectRoot>/paper-lab-library/
 *     index.sqlite              # sql.js cache (rebuilt on sync)
 *     papers/<doi-hash>/
 *       metadata.json           # CslItem
 *       abstract.txt            # plain-text abstract
 *     README.md                 # auto-generated stats
 *
 * Why this layout?
 *   - Files are the source of truth. sql.js is just an index.
 *   - Files survive across sql.js schema changes (we can always
 *     rebuild the cache).
 *   - Files are diff-friendly for power users who want to version-
 *     control their library.
 *   - Files are inspectable in any text editor.
 *
 * The library is gitignored (see /paper-lab-library/ in .gitignore).
 * Per-project means no global vs project split (PLAN §13.2 MED-#10
 * fix).
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CslItem } from "../csl/schema.ts";
import { doiToId } from "../csl/schema.ts";

// ── File directory CRUD ────────────────────────────────────────────────────

/**
 * Resolve the library root directory. Always returns
 * `<projectRoot>/paper-lab-library` regardless of cwd.
 */
export function libraryRoot(projectRoot: string): string {
  return join(projectRoot, "paper-lab-library");
}

/**
 * Resolve the directory for a single paper. Idempotent.
 */
function paperDir(libraryPath: string, csl: CslItem): string {
  return join(libraryPath, "papers", csl.id);
}

/**
 * Add or update a paper in the library.
 *
 * If the paper already exists (same id), its metadata is overwritten.
 * If not, a new directory is created with metadata.json + abstract.txt.
 *
 * @returns the path of the paper directory (for inspection).
 */
export function addPaper(libraryPath: string, csl: CslItem): string {
  const dir = paperDir(libraryPath, csl);
  mkdirSync(dir, { recursive: true });

  const metadataPath = join(dir, "metadata.json");
  // Persist only the public-facing fields. Strip the runtime-only
  // "source" field if it's "user" (no provenance to track).
  const persisted: CslItem = {
    ...csl,
    // Stamp addedAt/addedVia for provenance.
    addedAt: csl.addedAt ?? Date.now(),
    addedVia: csl.addedVia ?? "user",
    source: csl.source ?? "user",
  };
  writeFileSync(metadataPath, JSON.stringify(persisted, null, 2), "utf8");

  // Stripped abstract (no JATS tags). The adapter already handles
  // that, but defensively trim and write.
  const abstractPath = join(dir, "abstract.txt");
  if (csl.abstract) {
    writeFileSync(abstractPath, csl.abstract.trim(), "utf8");
  } else {
    // No abstract — write a placeholder so the directory shape is
    // consistent across papers.
    writeFileSync(abstractPath, "", "utf8");
  }

  return dir;
}

/**
 * Remove a paper from the library. Returns true if it existed and
 * was removed, false if it didn't exist.
 */
export function removePaper(libraryPath: string, id: string): boolean {
  const dir = join(libraryPath, "papers", id);
  if (!existsSync(dir)) return false;
  rmSync(dir, { recursive: true, force: true });
  return true;
}

/**
 * Get a paper by id. Returns null if not in the library.
 */
export function getPaper(libraryPath: string, id: string): CslItem | null {
  const metadataPath = join(libraryPath, "papers", id, "metadata.json");
  if (!existsSync(metadataPath)) return null;
  const raw = JSON.parse(readFileSync(metadataPath, "utf8")) as CslItem;
  return raw;
}

/**
 * List all papers in the library. Returns a CslItem[] in insertion
 * order (by directory enumeration, which is OS-dependent — callers
 * that need stable order should sort by id or year themselves).
 */
export function listPapers(libraryPath: string): CslItem[] {
  const papersDir = join(libraryPath, "papers");
  if (!existsSync(papersDir)) return [];
  const entries = readdirSync(papersDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);

  const out: CslItem[] = [];
  for (const id of entries) {
    const paper = getPaper(libraryPath, id);
    if (paper) out.push(paper);
  }
  return out;
}

/**
 * Lookup paper by DOI. Returns null if not in library.
 */
export function lookupByDoi(libraryPath: string, doi: string): CslItem | null {
  return getPaper(libraryPath, doiToId(doi));
}

/**
 * Get library stats (count + total abstract bytes).
 */
export function stats(libraryPath: string): { count: number; totalAbstractBytes: number } {
  const papers = listPapers(libraryPath);
  let bytes = 0;
  for (const p of papers) {
    const abstractPath = join(libraryPath, "papers", p.id, "abstract.txt");
    try {
      bytes += readFileSync(abstractPath, "utf8").length;
    } catch {
      // ignore missing file
    }
  }
  return { count: papers.length, totalAbstractBytes: bytes };
}

// ── sql.js cache (optional, rebuilt on demand) ─────────────────────────────
//
// The SQLite cache is an OPTIMIZATION, not the source of truth. The
// filesystem above is canonical. The cache is rebuilt by `sync()` and
// used by the BM25 search path to avoid per-search file I/O.
//
// We do not bind to a specific sql.js API; consumers (library CLI,
// future pi extension) can call initCache() to get a ready-to-query
// SQL.Database instance. The DB has a single table `entries` keyed
// by doi_hash.

export interface LibraryCacheSchema {
  version: number;
}

export const CACHE_SCHEMA_VERSION = 1;

/**
 * Open (and initialise if needed) the sql.js cache for a library.
 *
 * @param libraryPath Path to the library root.
 * @returns Object with `db` (sql.js Database) and `path` (sqlite file).
 *          Caller is responsible for `db.close()` on shutdown.
 */
export async function initCache(libraryPath: string): Promise<{
  db: any;
  path: string;
}> {
  // sql.js + node integration: import lazily to avoid pulling WASM
  // into the hot path of paper-lab-finalize.
  const initSqlJs = (await import("sql.js")).default;

  // sql.js uses locateFile for the WASM blob. In Node, the WASM file
  // lives at node_modules/sql.js/dist/sql-wasm.wasm. We resolve it
  // RELATIVE TO THIS MODULE FILE, not cwd, so the CLI works from any
  // directory the user invokes it from.
  const moduleUrl = new URL(import.meta.url);
  const modulePath = fileURLToPath(moduleUrl);
  // modulePath is .../src/library/storage.ts → walk up to .../pi-paper-lab/
  const packageRoot = join(modulePath, "..", "..", "..");
  const wasmDir = join(packageRoot, "node_modules", "sql.js", "dist");
  const SQL = await initSqlJs({
    locateFile: (file: string) => join(wasmDir, file),
  });

  const sqlitePath = join(libraryPath, "index.sqlite");
  let db: any;
  if (existsSync(sqlitePath)) {
    const buf = readFileSync(sqlitePath);
    db = new SQL.Database(new Uint8Array(buf));
  } else {
    db = new SQL.Database();
  }

  // Schema: see PLAN §13.4. We use INTEGER (0/1) instead of BOOLEAN
  // for sql.js compatibility (SQLite has no native BOOLEAN).
  //
  // The FTS5 virtual table from the plan is intentionally NOT
  // created here: the default sql.js build (sql-wasm.js) ships
  // without the FTS5 extension, and `CREATE VIRTUAL TABLE ... USING
  // fts5(...)` would throw at init time. For v0.7.5 we cover the
  // <10K-paper search case with the in-memory BM25 index in
  // `library/bm25.ts` (same ranking algorithm, no SQL dependency).
  // To enable FTS5 in v0.8+, swap the loaded sql.js WASM for the
  // `sql-wasm-fts5.js` build or load the FTS5 extension explicitly.
  db.run(`
    CREATE TABLE IF NOT EXISTS entries (
      doi_hash TEXT PRIMARY KEY,
      doi TEXT NOT NULL,
      title TEXT NOT NULL,
      year INTEGER,
      authors TEXT,
      source TEXT,
      added_via TEXT,
      indexed_at INTEGER,
      added_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_year ON entries(year);
  `);

  return { db, path: sqlitePath };
}

/**
 * Rebuild the cache from the file directory. Idempotent. Drops the
 * existing entries table and re-populates from `papers/<id>/metadata.json`.
 *
 * @param libraryPath Library root.
 * @returns Number of entries indexed.
 */
export async function syncCache(libraryPath: string): Promise<number> {
  const { db, path } = await initCache(libraryPath);

  // Drop and re-create. Faster than diffing for small libraries.
  db.run(`DELETE FROM entries;`);

  const papers = listPapers(libraryPath);
  for (const paper of papers) {
    const authorsJson = JSON.stringify(paper.author ?? []);
    db.run(
      `INSERT INTO entries (doi_hash, doi, title, year, authors, source, added_via, indexed_at, added_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        paper.id,
        paper.DOI ?? "",
        paper.title ?? "(untitled)",
        paper.issued?.["date-parts"]?.[0]?.[0] ?? null,
        authorsJson,
        paper.source ?? "user",
        paper.addedVia ?? "user",
        Date.now(),
        paper.addedAt ?? Date.now(),
      ],
    );
  }

  // Persist back to disk.
  const binary = db.export();
  writeFileSync(path, Buffer.from(binary));
  db.close();
  return papers.length;
}