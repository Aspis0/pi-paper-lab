#!/usr/bin/env node
// bin/finalize.mjs
// Standalone CLI for pi-paper-lab finalizeDoc().
//
// Why this exists:
//   `node --experimental-strip-types -e "import('.../pipeline.ts')"` fails on
//   Windows + node_modules-installed extensions because:
//     1. ESM `import()` rejects `C:/...` paths on Windows (must be file:// URL).
//     2. Node refuses to type-strip `.ts` files inside `node_modules/`.
//   This shim works around both by using jiti (in-process transpiler) on a
//   plain `.mjs` script that lives outside the strip-types restriction.
//
// Usage:
//   paper-lab-finalize <path-to.md>
//   npx -y paper-lab-finalize <path-to.md>
//
// Exit codes:
//   0 — success
//   1 — finalizeDoc returned an error
//   2 — usage error (bad args / file not found)
//   3 — package installation problem (jiti missing or pipeline.ts not found)
//
// Output: prints "Done! Word: <path> | References: <n>" on success.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

// ── 1. Locate the pi-paper-lab package root ────────────────────────────
// We expect this file to live at:
//   <somewhere>/node_modules/pi-paper-lab/bin/finalize.mjs
// Walk up the directory tree until we find package.json with name=pi-paper-lab.
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

// __dirname equivalent for ESM (handles Windows drive letters correctly).
const here = fileURLToPath(import.meta.url);
const startDir = dirname(here);
const ROOT = findPackageRoot(startDir);
if (!ROOT) {
  console.error("[paper-lab-finalize] FATAL: cannot locate the pi-paper-lab package root.");
  console.error("  Searched up from:", startDir);
  console.error("  Make sure pi-paper-lab is installed (e.g. `pi install npm:pi-paper-lab`).");
  process.exit(3);
}
const PIPELINE = join(ROOT, "src", "pipeline.ts");
if (!existsSync(PIPELINE)) {
  console.error(`[paper-lab-finalize] FATAL: pipeline.ts not found at ${PIPELINE}`);
  console.error("  The package may be corrupt. Try reinstalling.");
  process.exit(3);
}

// ── 2. Import pipeline.ts via jiti ──────────────────────────────────────
// jiti transpiles TypeScript in-process — it does NOT trigger Node's
// strip-types restriction against files under node_modules/.
// Prefer the package's own jiti (declared dep) — fall back to host resolution.
async function loadPipeline() {
  let createJiti;
  try {
    // Direct dep (preferred)
    ({ createJiti } = await import("jiti"));
  } catch {
    // Fallback: try resolving relative to this package
    try {
      const jitiPath = join(ROOT, "node_modules", "jiti");
      if (existsSync(jitiPath)) {
        ({ createJiti } = await import(pathToFileURL(join(jitiPath, "lib", "jiti.mjs")).href));
      } else {
        throw new Error("jiti not installed");
      }
    } catch {
      // Last resort: try the user's hoisted node_modules
      const hoisted = join(ROOT, "..", "..", "jiti", "lib", "jiti.mjs");
      if (existsSync(hoisted)) {
        ({ createJiti } = await import(pathToFileURL(hoisted).href));
      } else {
        throw new Error("jiti module not found anywhere on the resolution path");
      }
    }
  }
  const jiti = createJiti(import.meta.url, { moduleCache: false });
  // Convert Windows path to a file:// URL — jiti accepts both absolute paths
  // and file:// URLs, but the URL form is the only one that works on Windows
  // when this entry script itself was loaded from a file:// URL.
  return await jiti.import(pathToFileURL(PIPELINE).href);
}

// ── 3. CLI entry ───────────────────────────────────────────────────────
function usageAndExit(msg) {
  if (msg) console.error("Error:", msg);
  console.error("Usage: paper-lab-finalize <path-to.md> [--no-cache] [--verify-all] [--no-live|--static] [--help] [--version]");
  console.error("  --no-cache     Force fresh DOI resolution via CrossRef, ignoring any sidecar cache.");
  console.error("                 Use after manually editing the .citations.json sidecar or when");
  console.error("                 refreshing stale metadata.");
  console.error("  --verify-all   Re-fetch ALL inline DOIs via CrossRef, even ones with matching cached");
  console.error("                 metadata. Use when the user says 'verify all citations' or 'controlla");
  console.error("                 tutte le citazioni', or after errata / retractions were issued.");
  console.error("                 Bare [N] markers without DOIs still resolve from the sidecar cache if");
  console.error("                 available; the LLM pipeline fills those via the citation_search path.");
  console.error("  --live         Inject Word-native CITATION/BIBLIOGRAPHY fields (renumber on F9 in Word).");
  console.error("                 This is the DEFAULT. Citations render superscript [N] once the bibliography XSL");
  console.error("                 is installed (see --install-style, run once with consent). The BIBLIOGRAPHY field");
  console.error("                 also caches the list so non-Word apps show a complete bibliography.");
  console.error("                 NOTE: Word never auto-renumbers on delete — run Ctrl+A → F9 after editing citations.");
  console.error("  --no-live      Force a STATIC References section (plain <sup>[N]</sup> + text list, no Word fields).");
  console.error("  --static       Alias for --no-live. Use for LibreOffice / Google Docs / Pages, or when you want");
  console.error("                 a dead-simple .docx with no field-update step.");
  console.error("  --install-style  Install the bundled superscript bibliography XSL to Word's style folder");
  console.error("                 (%APPDATA%\\Microsoft\\Bibliography\\Style). OPT-IN only — run once, then");
  console.error("                 --live citations render superscript. Never done automatically.");
  process.exit(2);
}

async function main() {
  // Parse flags out of process.argv early (they can appear before or after
  // the path). Order-independent.
  const argv = process.argv.slice(2);
  const positional = [];
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--no-cache") opts.noCache = true;
    else if (a === "--verify-all") opts.verifyAll = true;
    else if (a === "--no-live" || a === "--static") opts.live = false;
    else if (a === "--live") opts.live = true;
    else if (a === "--install-style") opts.installStyleXsl = true;
    else if (a === "-h" || a === "--help") usageAndExit();
    else if (a === "--version" || a === "-v") { /* handled below */ }
    else positional.push(a);
  }
  const arg = positional[0];
  if (!arg) usageAndExit();
  if (arg === "--version" || arg === "-v") {
    try {
      const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
      console.log(`${pkg.name} v${pkg.version}`);
    } catch { console.log("unknown"); }
    process.exit(0);
  }

  const target = resolve(process.cwd(), arg);
  if (!existsSync(target)) usageAndExit(`File not found: ${target}`);

  let mod;
  try {
    mod = await loadPipeline();
  } catch (err) {
    console.error("[paper-lab-finalize] FATAL: failed to load pipeline:", err?.message ?? err);
    console.error("  This usually means jiti is missing. Try `npm i jiti`.");
    process.exit(3);
  }
  if (typeof mod.finalizeDoc !== "function") {
    console.error("[paper-lab-finalize] FATAL: pipeline.ts did not export finalizeDoc");
    process.exit(3);
  }

  let result;
  try {
    result = mod.finalizeDoc(target, opts);
  } catch (err) {
    console.log("Error:", err?.message ?? String(err));
    process.exit(1);
  }
  if (result?.error) {
    console.log("Error:", result.error);
    process.exit(1);
  }
  const flagSummary = [
    opts.noCache ? "cache bypassed" : "",
    opts.verifyAll ? "all citations re-fetched" : "",
    opts.live ? "live citations" : "",
  ].filter(Boolean).join(", ");
  console.log(`Done! Word: ${result.docxPath} | References: ${result.bibliographyCount}${flagSummary ? ` | (${flagSummary})` : ""}`);
  // v0.7.6: live is the default. Remind the user that superscript needs the
  // XSL installed (one-time, with consent) when they did NOT pass --install-style.
  // We NEVER install silently — this is just a printed hint.
  if (result.liveApplied && !opts.installStyleXsl) {
    console.log("  → Live citations render superscript only after installing the bibliography XSL (one-time, with consent):");
    console.log("    paper-lab-finalize --install-style <file.md>   (or re-run --live --install-style)");
    console.log("    Without it, citations render plain (1) and renumber still works in Word via F9.");
  }
}

main().catch((err) => {
  console.error("[paper-lab-finalize] unexpected error:", err?.message ?? String(err));
  process.exit(3);
});
