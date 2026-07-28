#!/usr/bin/env node
// bin/generate-word.mjs
// Standalone CLI for pi-paper-lab generateWord() — used by /paper-to-word.
// Same Windows/node_modules-friendly wrapper as bin/finalize.mjs.
//
// Usage:
//   paper-lab-word <path-to.md> [output.docx]
//   npx -y paper-lab-word <path-to.md> [output.docx]

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

function findPackageRoot(startDir) {
  let dir = startDir;
  for (let i = 0; i < 8; i++) {
    const pkgPath = join(dir, "package.json");
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
        if (pkg.name === "pi-paper-lab") return dir;
      } catch { /* keep walking */ }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

const here = fileURLToPath(import.meta.url);
const ROOT = findPackageRoot(dirname(here));
if (!ROOT) {
  console.error("[paper-lab-word] FATAL: cannot locate pi-paper-lab package root.");
  process.exit(3);
}
const PIPELINE = join(ROOT, "src", "pipeline.ts");
if (!existsSync(PIPELINE)) {
  console.error(`[paper-lab-word] FATAL: pipeline.ts not found at ${PIPELINE}`);
  process.exit(3);
}

async function loadPipeline() {
  const { createJiti } = await import("jiti");
  const jiti = createJiti(import.meta.url, { moduleCache: false });
  return await jiti.import(pathToFileURL(PIPELINE).href);
}

function usageAndExit(msg) {
  if (msg) console.error("Error:", msg);
  console.error("Usage: paper-lab-word <path-to.md> [output.docx]");
  process.exit(2);
}

async function main() {
  const targetArg = process.argv[2];
  const outputArg = process.argv[3];
  if (!targetArg || targetArg === "-h" || targetArg === "--help") usageAndExit();

  const target = resolve(process.cwd(), targetArg);
  if (!existsSync(target)) usageAndExit(`File not found: ${target}`);
  const output = outputArg ? resolve(process.cwd(), outputArg) : undefined;

  const mod = await loadPipeline();
  if (typeof mod.generateWord !== "function") {
    console.error("[paper-lab-word] FATAL: pipeline.ts did not export generateWord");
    process.exit(3);
  }
  let r;
  try {
    r = mod.generateWord(target, output);
  } catch (err) {
    console.log("Error:", err?.message ?? String(err));
    process.exit(1);
  }
  if (r?.error) { console.log("Error:", r.error); process.exit(1); }
  console.log(`Done! Word: ${r.docxPath}${r.footnoteCount != null ? ` | Footnotes: ${r.footnoteCount}` : ""}`);
}

main().catch((err) => {
  console.error("[paper-lab-word] unexpected error:", err?.message ?? String(err));
  process.exit(3);
});
