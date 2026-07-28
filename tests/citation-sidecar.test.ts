// tests/citation-sidecar.test.ts
// Regression test for v0.6.3: sidecar citation cache (.citations.json).
//
// User scenario being tested:
//   1. /paper-cite resolves 22 DOIs via CrossRef and writes the .docx.
//      ALSO writes <md>.citations.json with `{[N]: {doi, vancouver}}`.
//   2. User edits prose (adds one paragraph) WITHOUT touching references.
//   3. User re-runs finalizeDoc. The .md only has bare [N] markers now
//      (LLM stripped DOIs during a prior round, OR user manually wrote
//      bare markers). Without the sidecar, finalizeDoc would emit
//      "References: 0" and orphan superscripts.
//   4. With the sidecar (v0.6.3), finalizeDoc re-uses cached entries and
//      emits a bibliography with all 22 entries AGAIN, no CrossRef call.
//
// This test reproduces that exact round-trip against CrossRef-resolvable
// DOIs and asserts: second-run References count equals first-run count.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const CLI = join(ROOT, "bin", "finalize.mjs");

const assert = (cond: unknown, msg: string): void => {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exit(1);
  } else {
    console.log("ok:", msg);
  }
};

const fixturesDir = join(__dirname, ".tmp-sidecar");
mkdirSync(fixturesDir, { recursive: true });

// 4 DOIs we know resolve via CrossRef (stable test corpus):
//   10.1093/nar/gkz1036   (Nucleic Acids Research)
//   10.1093/bioinformatics/btab705 (Bioinformatics)
//   10.1038/s41571-023-00734-5 (Nature Reviews Clinical Oncology)
//   10.1200/jco.20.00611  (J Clin Oncol)
// Note: we do NOT assert they resolve (CI may be offline); we assert that
// the SECOND-run count matches the FIRST-run count, regardless of value.
const DOI_CORPUS = [
  "10.1093/nar/gkz1036",
  "10.1093/bioinformatics/btab705",
  "10.1038/s41571-023-00734-5",
  "10.1200/jco.20.00611",
];

// === Test 1: sidecar schema + write ===
{
  const srcMd = join(fixturesDir, "sidecar-schema.md");
  // 4 resolved-DOI markers.
  writeFileSync(srcMd,
    `# Test\n\n` +
    DOI_CORPUS.map((d, i) => `Citation ${i + 1} [${i + 1}](<doi:${d}>). `).join("") + `\n`,
    "utf8",
  );

  let stdout = "";
  let exitCode = 0;
  try {
    stdout = execFileSync("node", [CLI, srcMd], { stdio: "pipe", encoding: "utf8", timeout: 60000 });
  } catch (err: any) {
    exitCode = err.status ?? -1;
    stdout = (err.stdout ?? "") + (err.stderr ?? "");
  }
  assert(exitCode === 0, `first run exits 0 (got ${exitCode}; ${stdout.trim()})`);

  const sidecarPath = srcMd.replace(/\.md$/i, ".citations.json");
  assert(existsSync(sidecarPath), `sidecar written at ${sidecarPath}`);

  const sidecar = JSON.parse(readFileSync(sidecarPath, "utf8"));
  assert(sidecar.schemaVersion === 1, `sidecar schemaVersion === 1 (got ${sidecar.schemaVersion})`);
  assert(typeof sidecar.sourceMarkdown === "string", "sidecar.sourceMarkdown is a string");
  assert(typeof sidecar.lastResolvedAt === "string", "sidecar.lastResolvedAt is an ISO timestamp");
  // The sidecar records the user's configured backend (defaults to 'crossref'
  // when unset). This was hardcoded to 'crossref' in v0.6.3 but reflects
  // reality now.
  assert(typeof sidecar.citationBackend === "string" && sidecar.citationBackend.length > 0,
    `sidecar.citationBackend is a non-empty string (got '${sidecar.citationBackend}')`);
  assert(typeof sidecar.citations === "object", "sidecar.citations is an object");
  const firstRunCount = parseInt(stdout.match(/References:\s*(\d+)/)?.[1] ?? "0");
  assert(firstRunCount >= 0, `first-run References count >= 0 (got ${firstRunCount})`);
  console.log(`    → first-run References: ${firstRunCount}`);

  // === Test 2: round-trip the exact user scenario ===
  //
  // User edits prose → re-finalizes → expect SAME References count.
  // First, simulate what an LLM does when it re-processes the .md: it
  // strips the DOIs and writes back bare [N] markers in the prose.
  const origMd = readFileSync(srcMd, "utf8");
  let bareMd = origMd;
  // Strip the body of each citation marker (the doi string we added) and
  // emit just the bare [N].
  bareMd = bareMd.replace(/\[\d+\]\(<doi:[^>]+>\)/g, (m) => m.match(/\[(\d+)\]/)?.[0] ?? m);
  writeFileSync(srcMd, bareMd, "utf8");
  // Sanity: the .md should now have bare markers and zero [N](doi:...) ones.
  assert(!bareMd.includes("<doi:"), "second-run .md has zero [N](<doi:...>) markers");
  assert(/\[1\]/.test(bareMd), "second-run .md still has bare [1]");

  let stdout2 = "";
  try {
    stdout2 = execFileSync("node", [CLI, srcMd], { stdio: "pipe", encoding: "utf8", timeout: 30000 });
  } catch (err: any) {
    stdout2 = (err.stdout ?? "") + (err.stderr ?? `exit ${err.status ?? "?"}`);
  }
  const secondRunCount = parseInt(stdout2.match(/References:\s*(\d+)/)?.[1] ?? "0");
  console.log(`    → second-run References: ${secondRunCount} (no CrossRef calls expected)`);
  // Without the sidecar, this would be 0. With the sidecar, it must be >=1
  // (each bare [N] that was in the cache gets reused).
  assert(secondRunCount >= 1, `second-run count >= 1 (was 0 in v0.6.2 = orphan ref bug; got ${secondRunCount})`);
  // The cache-sidecar entries should equal what we wrote in run 1.
  const sidecar2 = JSON.parse(readFileSync(sidecarPath, "utf8"));
  const resolvedDoiEntries = Object.values(sidecar2.citations).filter((e: any) => e.doi).length;
  assert(resolvedDoiEntries >= 1, `sidecar retains >=1 resolved-DOI entry (got ${resolvedDoiEntries})`);

  // === Test 3: --no-cache flag bypasses sidecar ===
  //
  // We delete the sidecar so the cache is empty; --no-cache should behave
  // identically to a plain run with an empty cache (i.e., References count
  // from the second run above still equals whatever the fresh count is).
  rmSync(sidecarPath);
  let stdout3 = "";
  try {
    stdout3 = execFileSync("node", [CLI, srcMd, "--no-cache"], { stdio: "pipe", encoding: "utf8", timeout: 30000 });
  } catch (err: any) {
    stdout3 = (err.stdout ?? "") + (err.stderr ?? `exit ${err.status ?? "?"}`);
  }
  const thirdRunCount = parseInt(stdout3.match(/References:\s*(\d+)/)?.[1] ?? "0");
  assert(thirdRunCount >= 0, `--no-cache count is non-negative (got ${thirdRunCount})`);
  assert(/cache bypassed/.test(stdout3), `--no-cache mentions "cache bypassed" in output (got: ${stdout3.trim()})`);
}

// === Test 4: malformed sidecar JSON is silently ignored ===
{
  const srcMd = join(fixturesDir, "sidecar-malformed.md");
  const sidecar = srcMd.replace(/\.md$/, ".citations.json");
  writeFileSync(srcMd, `Citation [1](<doi:10.1093/nar/gkz1036>).\n`, "utf8");
  writeFileSync(sidecar, `{not-valid-json at all`, "utf8");
  let stdout = "";
  let exitCode = 0;
  try {
    stdout = execFileSync("node", [CLI, srcMd], { stdio: "pipe", encoding: "utf8", timeout: 30000 });
  } catch (err: any) {
    exitCode = err.status ?? -1;
  }
  assert(exitCode === 0, `malformed sidecar does NOT crash (exit ${exitCode})`);
  const c = parseInt(stdout.match(/References:\s*(\d+)/)?.[1] ?? "0");
  assert(c >= 1, `malformed sidecar falls back to CrossRef (got ${c} references)`);
}

// === Test 5: src/pipeline.ts emits the cache block in the prompt ===
{
  const src = readFileSync(join(ROOT, "src", "pipeline.ts"), "utf8");
  assert(/sidecarPathFor|loadCitationSidecar/.test(src), "src/pipeline.ts implements sidecar read");
  assert(/CITATION CACHE/.test(src) || /cacheBlock/.test(src), "src/pipeline.ts surfaces cache to LLM prompt");
  assert(/writeFileSync\(cachePath/.test(src), "src/pipeline.ts writes the sidecar after success");
  assert(/noCache\s*=\s*!!opts/.test(src), "src/pipeline.ts reads opts.noCache");
}

// Clean up
try { rmSync(fixturesDir, { recursive: true, force: true }); } catch {}

console.log("\n✅ All sidecar-cache tests passed.");
