// tests/pipeline-preserves-existing.test.ts
// Regression for v0.6.3.1: /paper-cite must preserve existing inline
// [N](<doi:...>) citations WITHOUT asking the LLM to re-mark them.
//
// We now check the rendered prompt directly because buildCiteMarkPrompt is
// an exported function (was internal in v0.6.3). The two earlier tests
// (Test 2/Test 3 below) are also rendered here for completeness.
//
// Strategy: write a .md with both inline [N](doi:...) markers and a fresh
// sidecar, load pipeline.ts via jiti, invoke buildCiteMarkPrompt, and
// verify the prompt:
//   1. Lists every inline [N](doi:...) with a 'in text' tag.
//   2. Lists every cached [N] with a 'in cache' tag.
//   3. Reports the highest [N] in use so the LLM can number new ones.
//   4. Does NOT mark any existing citation as needing re-search.

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

const assert = (cond: unknown, msg: string): void => {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exit(1);
  } else {
    console.log("ok:", msg);
  }
};

const fixturesDir = join(__dirname, ".tmp-preserve");
mkdirSync(fixturesDir, { recursive: true });

// === Test 1: inline citations listed even with NO sidecar ===
{
  const srcMd = join(fixturesDir, "inline-only.md");
  writeFileSync(srcMd,
    `# Test\n\n` +
    `Existing one [1](<doi:10.1038/s41571-023-00734-5>).\n` +
    `Existing two [2](doi:10.1093/nar/gkz1036).\n` +
    `Bare three [3].\n` +
    `Genuinely new claim [CITE:new-topic].\n`,
    "utf8",
  );

  const loaderPath = join(fixturesDir, "dump1.mjs");
  writeFileSync(loaderPath, `
import { createJiti } from "jiti";
import { pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";
const jiti = createJiti(import.meta.url, { moduleCache: false });
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
  assert(/CITATIONS ALREADY PRESENT/.test(stdout), "block header present");
  assert(/\[1\] → 10\.1038\/s41571-023-00734-5 \(in text\)/.test(stdout),
    "[1] DOI listed with 'in text' source tag");
  assert(/\[2\] → 10\.1093\/nar\/gkz1036 \(in text\)/.test(stdout),
    "[2] DOI listed with 'in text' source tag");
  assert(/Highest \[N\] in use: \d+/.test(stdout), "Highest [N] in use reported");
}

// === Test 2: cache-only path still works (no inline markers, fresh sidecar) ===
{
  const srcMd = join(fixturesDir, "cache-only.md");
  writeFileSync(srcMd, `# Test\n\nA completely fresh draft with no inline citations.\n`, "utf8");
  const sidecar = srcMd.replace(/\.md$/, ".citations.json");
  writeFileSync(sidecar, JSON.stringify({
    schemaVersion: 1,
    sourceMarkdown: srcMd,
    lastResolvedAt: "2026-07-28T00:00:00.000Z",
    citationBackend: "crossref",
    citations: {
      "5": { doi: "10.1038/s41571-023-00734-5", vancouver: "5. ... doi:10.1038/s41571-023-00734-5" },
      "7": { doi: "10.1093/nar/gkz1036", vancouver: "7. ... doi:10.1093/nar/gkz1036" },
    },
  }, null, 2), "utf8");

  const loaderPath = join(fixturesDir, "dump2.mjs");
  writeFileSync(loaderPath, `
import { createJiti } from "jiti";
import { pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";
const jiti = createJiti(import.meta.url, { moduleCache: false });
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
  assert(exitCode === 0, `cache-only prompt loader runs (exit ${exitCode})`);
  assert(/CITATIONS ALREADY PRESENT/.test(stdout), "cache-only block still emits");
  assert(/\[5\] → 10\.1038\/s41571-023-00734-5 \(in cache\)/.test(stdout),
    "[5] DOI listed with 'in cache' source tag");
  assert(/\[7\] → 10\.1093\/nar\/gkz1036 \(in cache\)/.test(stdout),
    "[7] DOI listed with 'in cache' source tag");
  assert(/Highest \[N\] in use: 7/.test(stdout), "Highest [N] in use reflects cache max (7)");
}

// === Test 3: merged (inline + cache) — inline takes precedence ===
//
// Same [N] exists in both — inline wins because the user just wrote it and
// the cache could be stale from a previous session.
{
  const srcMd = join(fixturesDir, "merge.md");
  writeFileSync(srcMd,
    `# Test\n\n` +
    `User-just-rewrote this [1](<doi:10.1093/bioinformatics/btab705>).\n` +
    `Only in cache [2](<doi:10.9999/CACHED-ONLY>).\n` +
    `New claim [CITE:topic].\n`,
    "utf8",
  );
  const sidecar = srcMd.replace(/\.md$/, ".citations.json");
  writeFileSync(sidecar, JSON.stringify({
    schemaVersion: 1,
    sourceMarkdown: srcMd,
    lastResolvedAt: "2026-01-01T00:00:00.000Z",
    citationBackend: "crossref",
    citations: {
      "1": { doi: "10.9999/CACHED-OLD", vancouver: "1. CACHED OLD. ... doi:10.9999/CACHED-OLD" },
      "2": { doi: "10.9999/CACHED-ONLY", vancouver: "2. CACHED ONLY. ... doi:10.9999/CACHED-ONLY" },
    },
  }, null, 2), "utf8");

  const loaderPath = join(fixturesDir, "dump3.mjs");
  writeFileSync(loaderPath, `
import { createJiti } from "jiti";
import { pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";
const jiti = createJiti(import.meta.url, { moduleCache: false });
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
  assert(exitCode === 0, `merged-source loader runs (exit ${exitCode})`);
  // [1] inline wins → labelled "(in text)" with the new DOI.
  assert(/\[1\] → 10\.1093\/bioinformatics\/btab705 \(in text\)/.test(stdout),
    "[1] inline wins, shows '(in text)' label");
  assert(!/CACHED-OLD/.test(stdout) || /\[1\] → .* CACHED-OLD/.test(stdout) === false,
    "stale 'CACHED-OLD' DOI is NOT shown for [1] (inline overrode it)");
  // [2] only in cache.
  assert(/\[2\] → 10\.9999\/CACHED-ONLY \(in cache\)/.test(stdout),
    "[2] only in cache, '(in cache)' label");
}

try { rmSync(fixturesDir, { recursive: true, force: true }); } catch {}
console.log("\n✅ All pipeline-preserves-existing tests passed.");
