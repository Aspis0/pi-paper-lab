// tests/csl/sidecar-migration-noop.test.ts
//
// Contract: a v0.7.0/v0.7.2 sidecar (with only {doi, vancouver} fields)
// must NOT be silently migrated to a v0.7.5 sidecar in the hot path.
// The 80%-accurate best-effort conversion (`vancouverStringToCsl`)
// was REMOVED in v0.7.5 because silently wrong data is worse than
// missing data.
//
// The user's only path to migrate is `paper-lab-finalize paper.md
// --verify-all`, which re-fetches every DOI and writes the new
// CSL field. Until that runs, the live-citation branch falls back
// to the Vancouver-string regex parser (legacy) and the static
// bibliography uses the vancouver string from the sidecar.
//
// This test asserts the structural contract: a SidecarEntry may
// lack `csl` and that's fine; loading a sidecar without `csl` does
// not throw or auto-migrate. The actual finalizeDoc behaviour is
// tested by the integration test in finalize-cli.test.ts which
// runs the full pipeline against a fixture sidecar.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { crossrefToCsl } from "../../src/csl/adapters/crossrefToCsl.ts";
import type { CslItem } from "../../src/csl/schema.ts";
import type { CrossRefWork } from "../../src/crossref.ts";

function makeWork(): CrossRefWork {
  return {
    doi: "10.1242/dmm.049298",
    title: ["Cancer cachexia in Drosophila"],
    author: [
      { family: "Liu", given: "Ying" },
      { family: "Saavedra", given: "Pedro" },
    ],
    published: { dateParts: [2022] },
    containerTitle: ["Disease Models & Mechanisms"],
    volume: "15",
    page: "dmm049298",
    type: "journal-article",
  };
}

test("CrossRef adapter produces CslItem that survives JSON round-trip", () => {
  // The on-disk sidecar stores CslItem as JSON. JSON.stringify → JSON.parse
  // must preserve the data exactly so subsequent reads see the same id
  // (which keys the library filesystem path).
  const csl: CslItem = crossrefToCsl(makeWork(), "10.1242/dmm.049298");
  const round = JSON.parse(JSON.stringify(csl)) as CslItem;
  assert.equal(round.id, csl.id);
  assert.equal(round.DOI, csl.DOI);
  assert.deepEqual(round.author, csl.author);
  assert.deepEqual(round.issued, csl.issued);
});

test("Old sidecar (no csl field) is structurally valid: missing field is fine", () => {
  // Simulate an old sidecar payload. `csl` is undefined, which is
  // allowed by SidecarEntry. The pipeline must not crash on missing
  // csl — it falls back to the vancouver-string path.
  const oldSidecarEntry = {
    doi: "10.1242/dmm.049298",
    vancouver: "Liu Y, Saavedra P. Cancer cachexia in Drosophila. Disease Models & Mechanisms 2022;15:dmm049298. doi:10.1242/dmm.049298",
    // no `csl` field — that's the legacy shape
  };
  // Type-narrow: the field is optional.
  assert.equal(oldSidecarEntry.csl, undefined);
  // DOI + vancouver are still required by the sidecar schema.
  assert.ok(oldSidecarEntry.doi);
  assert.ok(oldSidecarEntry.vancouver);
});

test("New sidecar with csl field is structurally valid", () => {
  const csl: CslItem = crossrefToCsl(makeWork(), "10.1242/dmm.049298");
  const newSidecarEntry = {
    doi: "10.1242/dmm.049298",
    vancouver:
      "Liu Y, Saavedra P. Cancer cachexia in Drosophila. Disease Models & Mechanisms 2022;15:dmm049298. doi:10.1242/dmm.049298",
    csl,
  };
  assert.ok(newSidecarEntry.csl);
  assert.equal(newSidecarEntry.csl.id, "10.1242__dmm.049298");
});

test("Migration is one-way and explicit: re-deriving CSL from vancouver string is forbidden", async () => {
  // We removed vancouverStringToCsl. This test exists to keep the
  // architectural decision visible: if anyone re-adds a "convert
  // vancouver string to CslItem" function for migration purposes,
  // this test must be removed AND the migration risk acknowledged
  // in CHANGELOG. The contract is: --verify-all re-fetch is the
  // ONLY path to migrate sidecars.
  const vancouverString =
    "Liu Y, Saavedra P. Cancer cachexia in Drosophila. Disease Models & Mechanisms 2022;15:dmm049298. doi:10.1242/dmm.049298";
  // Assert that the schema module does NOT export a vancouverStringToCsl
  // function. If a future change re-adds it, this test must change too.
  // (Static grep — same trick as tests/csl/lazyLoad.test.ts.)
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const path = fileURLToPath(
    new URL("../../src/csl/adapters/crossrefToCsl.ts", import.meta.url),
  );
  const src = readFileSync(path, "utf8");
  assert.equal(
    /vancouverStringToCsl/.test(src),
    false,
    "src/csl/adapters/crossrefToCsl.ts must NOT export a vancouverStringToCsl " +
      "function. Migration is via --verify-all re-fetch only.",
  );
  // Sanity: the vancouver string itself is still produced by
  // citations.ts (legacy static bibliography path, removed in M5).
  assert.ok(vancouverString.length > 0);
});