// tests/csl/lazyLoad.test.ts
// M1 lazy-load proof: importing pipeline.ts must NOT pull in @citation-js
// (citation-js is reserved for paper-lab-export CLI only).
//
// Why this test exists: v0.7.2 was broken by a dynamic `require()` that
// silently failed under pi's jiti runtime, dropping us back to static
// mode. The same class of regression could happen if someone adds a
// `import "@citation-js/..."` at the top of pipeline.ts. This test
// fails fast in that case.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

test("pipeline.ts does not statically import @citation-js (hot path stays lean)", async () => {
  // Module._cache is an object whose keys are absolute resolved paths.
  // If any @citation-js/* path is in there after a static-import walk
  // of pipeline.ts, this assertion fails.
  const Module = (await import("node:module")).default as any;
  const cache = Module._cache as Record<string, unknown>;

  const before = new Set<string>();
  for (const key of Object.keys(cache)) {
    if (key.includes("@citation-js")) before.add(key);
  }

  // Trigger the static import of pipeline.ts. If pipeline.ts (or any of
  // its top-level imports) had `import "@citation-js/..."`, the module
  // would land in the cache before this call resolves.
  await import("../../src/pipeline.ts");

  const after = new Set<string>();
  for (const key of Object.keys(cache)) {
    if (key.includes("@citation-js")) after.add(key);
  }

  const newlyLoaded = [...after].filter((k) => !before.has(k));
  assert.deepEqual(
    newlyLoaded,
    [],
    `pipeline.ts statically imported @citation-js modules: ${newlyLoaded.join(", ")}\n` +
      `Citation.js must stay in paper-lab-export only.`
  );
});

test("schema.ts only imports from @citestyle packages (NOT @citation-js)", async () => {
  // schema.ts defines the canonical CslItem type. It must NOT pull
  // @citation-js into the hot path. Reading its source and asserting
  // no `from "@citation-js"` import is the simplest portable check.
  const path = fileURLToPath(new URL("../../src/csl/schema.ts", import.meta.url));
  const src = readFileSync(path, "utf8");
  assert.equal(
    /from\s+["']@citation-js/.test(src),
    false,
    "src/csl/schema.ts must not import from @citation-js (hot path)"
  );
});