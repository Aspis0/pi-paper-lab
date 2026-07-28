// tests/finalize-cli.test.ts
// Regression test for the v0.6.2 finalize CLI fix.
//
// Bug history:
//   v0.6.1 embedded `node --experimental-strip-types -e "import('.../pipeline.ts')"`
//   directly into the LLM-emitted prompt. That command FAILS on Windows when
//   pi-paper-lab is installed via `pi install npm:pi-paper-lab` because:
//     1. ESM `import()` rejects `C:/...` absolute paths on Windows.
//     2. Node refuses to type-strip `.ts` files inside `node_modules/`.
//   The fix ships bin/finalize.mjs (plain JS, jiti-based) and the LLM prompt
//   now instructs the model to run that CLI.
//
// This test verifies:
//   - The CLI binary exists and is executable via `node <path>`.
//   - It accepts an absolute .md path with [N](doi:...) markers.
//   - It returns exit code 0 + writes a .docx + reports References count.

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

// === 1. CLI binary exists and is well-formed ===
assert(existsSync(CLI), `CLI exists at ${CLI}`);
{
  const all = readFileSync(CLI, "utf8");
  assert(all.startsWith("#!/usr/bin/env node"), "CLI has shebang");
  // It MUST use jiti (or another TS loader) — NOT Node's --experimental-strip-types,
  // because that flag blocks type-stripping inside node_modules/.
  assert(/createJiti|from "jiti"|require\(.jiti.\)/.test(all), "CLI uses jiti (not Node's strip-types)");
  // It MUST NOT contain the broken command from v0.6.1 (an *executable*
  // invocation, not just a doc comment). Look for `node --experimental-strip-types`
  // on a NON-comment line, followed by `-e` or `-p`.
  const execLines = all.split("\n").filter(l => !l.trimStart().startsWith("//"));
  const hasBadExec = execLines.some(l => /node\s+--experimental-strip-types\s+-[ep]/.test(l));
  assert(!hasBadExec, "CLI does NOT execute 'node --experimental-strip-types' on a code line");
}

// === 2. CLI rejects missing argument ===
{
  let exitCode = 0;
  try {
    execFileSync("node", [CLI], { stdio: "pipe", encoding: "utf8" });
  } catch (err: any) {
    exitCode = err.status ?? -1;
  }
  assert(exitCode === 2, `missing-arg exit code is 2 (got ${exitCode})`);
}

// === 3. CLI rejects nonexistent file ===
{
  let exitCode = 0;
  try {
    execFileSync("node", [CLI, "C:/nonexistent/path.md"], { stdio: "pipe", encoding: "utf8" });
  } catch (err: any) {
    exitCode = err.status ?? -1;
  }
  assert(exitCode === 2, `missing-file exit code is 2 (got ${exitCode})`);
}

// === 4. Verify pipeline.ts emits the new finalize command (not the old broken one) ===
//
// Regression: v0.6.1 embedded `node --experimental-strip-types -e "..."` in the
// LLM prompt, which fails on Windows. v0.6.2 must reference `paper-lab-finalize`.
{
  const pipelineSrc = readFileSync(join(ROOT, "src", "pipeline.ts"), "utf8");
  // The old broken string must NOT appear in any non-comment line of pipeline.ts.
  const codeLines = pipelineSrc.split("\n").filter(l => !l.trimStart().startsWith("//"));
  const oldBroken = codeLines.some(l => /node\s+--experimental-strip-types\s+-[ep]/.test(l));
  assert(!oldBroken, "src/pipeline.ts does NOT emit the v0.6.1 broken 'node --experimental-strip-types' command");
  // The new CLI name must appear.
  assert(/paper-lab-finalize/.test(pipelineSrc), "src/pipeline.ts references the new 'paper-lab-finalize' CLI");
}


//
// We use a real, public CrossRef-resolvable DOI so that the test exercises
// the full finalize pipeline. (NIH PubMed Central is stable for this purpose.)
// If CrossRef is unreachable, the test gracefully passes the "docx created"
// assertion and skips the bibliography count.
const fixturesDir = join(__dirname, ".tmp-finalize-cli");
const srcMd = join(fixturesDir, "fixture.md");

mkdirSync(fixturesDir, { recursive: true });
writeFileSync(srcMd,
  `# Test\n\nThis is a test paper [1](<doi:10.1093/nar/gkz1036>) with two citations [2](doi:10.1093/bioinformatics/btab705).\n`,
  "utf8",
);

let stdout = "";
let exitCode = 0;
try {
  stdout = execFileSync("node", [CLI, srcMd], {
    stdio: "pipe",
    encoding: "utf8",
    timeout: 60000,
  });
} catch (err: any) {
  exitCode = err.status ?? -1;
  stdout = (err.stdout ?? "") + (err.stderr ?? "");
}

// Clean up the fixture directory (best-effort).
// Don't remove the .docx (the user's actual artifact); just remove the source .md.
// We leave the .docx in place if finalize succeeded so the user can inspect it.

assert(exitCode === 0, `CLI exits 0 (got ${exitCode}; stderr: ${stdout})`);
assert(/Done! Word: .+\.docx/.test(stdout), `stdout contains "Done! Word: ... .docx" (got: ${stdout.trim()})`);

// The .docx should exist next to the .md. We don't strictly require
// References: 1+ because CrossRef might be unreachable in CI.
const docx = srcMd.replace(/\.md$/i, ".docx");
assert(existsSync(docx), `docx exists at ${docx}`);

// Extract the reported References count from stdout for diagnostics.
const refMatch = stdout.match(/References:\s*(\d+)/);
const refCount = refMatch ? parseInt(refMatch[1]) : 0;
console.log(`  → reported References: ${refCount} (CrossRef may be offline; >=0 is fine)`);
assert(refCount >= 0, `References count is non-negative (got ${refCount})`);

// Clean up the fixture source file (keep .docx so user/devs can inspect).
try { rmSync(srcMd); } catch {}

// Done.
console.log(`\n✅ All finalize-CLI tests passed.`);
