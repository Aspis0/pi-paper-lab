// tests/verify-all-flag.test.ts
// Regression for v0.6.3.2: --verify-all flag forces fresh CrossRef
// resolution of every inline DOI even when the sidecar has a matching
// entry. Use case: user says "controlla TUTTE LE CITAZIONI" or after a
// retraction / errata / metadata correction.

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

const fixturesDir = join(__dirname, ".tmp-verify-all");
mkdirSync(fixturesDir, { recursive: true });

// === Test 1: --verify-all makes CrossRef calls even with matching cache ===
//
// We plant a sidecar with a known-correct (real) DOI for [1]. Without
// --verify-all, the cache wins. With --verify-all, the sidecar is loaded
// (so DOI comparison still happens) but the trustCache shortcut is
// disabled — every inline DOI triggers a CrossRef call.
//
// We assert:
//   - exit code 0
//   - the sidecar is rewritten with a lastResolvedAt timestamp (proving the
//     finalization completed and wrote the cache)
//   - the stdout mentions "all citations re-fetched"
{
  const srcMd = join(fixturesDir, "verify-all.md");
  const sidecarPath = srcMd.replace(/\.md$/, ".citations.json");
  writeFileSync(srcMd, `Paper [1](<doi:10.1093/nar/gkz1036>).\n`, "utf8");

  // Seed the sidecar with the matching DOI cached.
  writeFileSync(sidecarPath, JSON.stringify({
    schemaVersion: 1,
    sourceMarkdown: srcMd,
    lastResolvedAt: "2020-01-01T00:00:00.000Z",
    citationBackend: "crossref",
    citations: {
      "1": { doi: "10.1093/nar/gkz1036", vancouver: "1. SEED CACHE. seeded. Fake J. 2099;1:1. doi:10.1093/nar/gkz1036" },
    },
  }, null, 2), "utf8");

  let stdout = "";
  let exitCode = 0;
  try {
    stdout = execFileSync("node", [CLI, srcMd, "--verify-all"], {
      stdio: "pipe", encoding: "utf8", timeout: 60000,
    });
  } catch (err: any) {
    exitCode = err.status ?? -1;
    stdout = (err.stdout ?? "") + (err.stderr ?? "");
  }
  assert(exitCode === 0, `verify-all run exits 0 (got ${exitCode}; ${stdout.slice(0, 200)})`);
  assert(/all citations re-fetched/.test(stdout), `stdout flags verify-all (got: ${stdout.trim()})`);

  // The sidecar's lastResolvedAt should have advanced past the seed (2020).
  const sc = JSON.parse(readFileSync(sidecarPath, "utf8"));
  const stamp = Date.parse(sc.lastResolvedAt);
  assert(stamp > Date.parse("2020-01-01T00:00:00.000Z"), `sidecar timestamp advanced (got ${sc.lastResolvedAt})`);
}

// === Test 2: --verify-all + --no-cache flag combination behavior ===
//
// Both flags together: --no-cache already skips the sidecar entirely;
// verifyAll additionally forces every inline DOI to be re-fetched.
// Net effect is the same as just --no-cache for inline markers, but the
// CLI parsing must not fail when both are passed together.
{
  const srcMd = join(fixturesDir, "both-flags.md");
  writeFileSync(srcMd, `Reference [1](<doi:10.1093/nar/gkz1036>).\n`, "utf8");

  let stdout = "";
  let exitCode = 0;
  try {
    stdout = execFileSync("node", [CLI, srcMd, "--no-cache", "--verify-all"], {
      stdio: "pipe", encoding: "utf8", timeout: 60000,
    });
  } catch (err: any) {
    exitCode = err.status ?? -1;
    stdout = (err.stdout ?? "") + (err.stderr ?? "");
  }
  assert(exitCode === 0, `combined flags exit 0 (got ${exitCode})`);
  // Both annotations should appear in the output.
  assert(/cache bypassed/.test(stdout) && /all citations re-fetched/.test(stdout),
    `combined flags show both annotations (got: ${stdout.trim()})`);
}

// === Test 3: buildCiteMarkPrompt detects "verify all" intent in instructions ===
{
  const src = readFileSync(join(ROOT, "src", "pipeline.ts"), "utf8");
  assert(/export function buildCiteMarkPrompt/.test(src),
    "buildCiteMarkPrompt is exported (so tests can introspect without an LLM)");

  const tmpMd = join(fixturesDir, "verify-prompt.md");
  writeFileSync(tmpMd, `# Test\n\nCite something [1](<doi:10.1093/nar/gkz1036>).\n`, "utf8");
  const text = readFileSync(tmpMd, "utf8");

  const loaderPath = join(fixturesDir, "dump3.mjs");
  writeFileSync(loaderPath, `
import { createJiti } from "jiti";
import { pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";
const jiti = createJiti(import.meta.url, { moduleCache: false, interopDefault: true });
const mod = await jiti.import(pathToFileURL(${JSON.stringify(ROOT + "/src/pipeline.ts")}).href);
const text = readFileSync(${JSON.stringify(tmpMd)}, "utf8");
const italianPrompt = mod.buildCiteMarkPrompt(${JSON.stringify(tmpMd)}, text, "", false, "controlla TUTTE LE CITAZIONI");
const englishPrompt = mod.buildCiteMarkPrompt(${JSON.stringify(tmpMd)}, text, "", false, "please verify all citations");
const plainPrompt = mod.buildCiteMarkPrompt(${JSON.stringify(tmpMd)}, text, "", false, "");
process.stdout.write(JSON.stringify({ italianPrompt, englishPrompt, plainPrompt }));
`, "utf8");

  let stdout = "";
  let exitCode = 0;
  try {
    stdout = execFileSync("node", [loaderPath], {
      stdio: "pipe", encoding: "utf8", cwd: ROOT, timeout: 60000,
    });
  } catch (err: any) {
    exitCode = err.status ?? -1;
    stdout = (err.stdout ?? "") + (err.stderr ?? "");
  }
  assert(exitCode === 0, `prompt-builder loader ran (exit ${exitCode}; ${stdout.slice(0, 200)})`);

  const parsed = JSON.parse(stdout);

  // Match the SHELL-COMMAND form: `' --verify-all'` (with leading space) so we
  // don't catch the help-text mention in the prompt. The finalize command line
  // always quotes the flag with a single space prefix when verifyAll is true.
  assert(/ --verify-all\b/.test(parsed.italianPrompt),
    `Italian 'controlla TUTTE LE CITAZIONI' → finalize command line contains ' --verify-all'`);
  assert(/ --verify-all\b/.test(parsed.englishPrompt),
    `English 'verify all citations' → finalize command line contains ' --verify-all'`);
  assert(!/ --verify-all\b/.test(parsed.plainPrompt),
    `plain instructions do NOT trigger --verify-all on the command line (prompt stays default)`);
}

// Also fix Test 2 of pipeline-preserves-existing in the same way:
{
  // We re-do Test 2 with the now-exported buildCiteMarkPrompt.
  const srcMd = join(fixturesDir, "inline-only-2.md");
  writeFileSync(srcMd,
    `# Test\n\n` +
    `Existing one [1](<doi:10.1038/s41571-023-00734-5>).\n` +
    `Existing two [2](doi:10.1093/nar/gkz1036).\n` +
    `Bare three [3].\n` +
    `New claim [CITE:some-topic].\n`,
    "utf8",
  );
  const loaderPath = join(fixturesDir, "dump-px.mjs");
  writeFileSync(loaderPath, `
import { createJiti } from "jiti";
import { pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";
const jiti = createJiti(import.meta.url, { moduleCache: false, interopDefault: true });
const mod = await jiti.import(pathToFileURL(${JSON.stringify(ROOT + "/src/pipeline.ts")}).href);
const text = readFileSync(${JSON.stringify(srcMd)}, "utf8");
const prompt = mod.buildCiteMarkPrompt(${JSON.stringify(srcMd)}, text, "", false, "");
process.stdout.write(prompt);
`, "utf8");
  let stdout = "";
  let exitCode = 0;
  try {
    stdout = execFileSync("node", [loaderPath], {
      stdio: "pipe", encoding: "utf8", cwd: ROOT, timeout: 60000,
    });
  } catch (err: any) {
    exitCode = err.status ?? -1;
    stdout = (err.stdout ?? "") + (err.stderr ?? "");
  }
  assert(exitCode === 0, `inline-only prompt loader runs (exit ${exitCode})`);
  assert(/CITATIONS ALREADY PRESENT/.test(stdout), "CITATIONS ALREADY PRESENT block in prompt");
  assert(/\[1\] → 10\.1038\/s41571-023-00734-5 \(in text\)/.test(stdout), "[1] inline (in text)");
  assert(/\[2\] → 10\.1093\/nar\/gkz1036 \(in text\)/.test(stdout), "[2] inline (in text)");
  assert(/Highest \[N\] in use: 3/.test(stdout), "Highest [N] in use reported (3 for inline 1, 2 plus bare 3)");
}

// === Test 4: stale-sidecar "verify-all" scenario where the cached DOI is wrong ===
//
// This is the specific bug the user was worried about. We have:
//   - Inline [1](<doi:REAL>) in prose.
//   - Sidecar cached [1] → DIFFERENT (stale) doi.
//   - With --no-cache:   the inline DOI wins (the cache is skipped).
//   - Without flags:     cached wins (BUG from v0.6.3 HIGH-1 already fixed).
//   - With --verify-all: inline DOI re-fetches, cache is also present but
//     the trustCache shortcut is off.
// We verify the sidecar ends up with the REAL DOI matching the prose, not
// the stale one.
{
  const srcMd = join(fixturesDir, "verify-all-stale.md");
  const sidecarPath = srcMd.replace(/\.md$/, ".citations.json");
  writeFileSync(srcMd, `Real paper [1](<doi:10.1093/nar/gkz1036>).\n`, "utf8");
  writeFileSync(sidecarPath, JSON.stringify({
    schemaVersion: 1,
    sourceMarkdown: srcMd,
    lastResolvedAt: "2020-01-01T00:00:00.000Z",
    citationBackend: "crossref",
    citations: {
      "1": { doi: "10.9999/STALE-WRONG", vancouver: "1. STALE. fake. Fake J. 2099;1:1. doi:10.9999/STALE-WRONG" },
    },
  }, null, 2), "utf8");

  let stdout = "";
  let exitCode = 0;
  try {
    stdout = execFileSync("node", [CLI, srcMd, "--verify-all"], {
      stdio: "pipe", encoding: "utf8", timeout: 60000,
    });
  } catch (err: any) {
    exitCode = err.status ?? -1;
    stdout = (err.stdout ?? "") + (err.stderr ?? "");
  }
  assert(exitCode === 0, `stale-cache verify-all exits 0 (got ${exitCode})`);
  const sc = JSON.parse(readFileSync(sidecarPath, "utf8"));
  // The cached DOI for [1] should NOT be the stale fake one anymore.
  assert(sc.citations["1"]?.doi !== "10.9999/STALE-WRONG",
    `stale cached DOI is overwritten by fresh CrossRef (got ${sc.citations["1"]?.doi})`);
}

// Clean up
try { rmSync(fixturesDir, { recursive: true, force: true }); } catch {}

console.log("\n✅ All verify-all flag tests passed.");
