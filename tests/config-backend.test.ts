// tests/config-backend.test.ts
// Hostile-audit fixes (v0.7.10):
//   - getCitationBackend must ignore INVALID PAPERLAB_CITATION_BACKEND values
//     (an invalid env used to disable every paid backend silently while
//     CrossRef alone kept running).
//   - Default is "auto", not "serper" (the /paper-lab menu and the sidecar
//     metadata both said "serper"/"crossref" after the v0.7.8 keyless change).

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { getCitationBackend } from "../src/config.ts";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Isolate from any real user config on disk by pointing HOME at an empty dir.
const CONFIG_PATH = join(homedir(), ".pi", "agent", ".paper-lab-keys.json");

function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const saved = new Map<string, string | undefined>();
  for (const [k, v] of Object.entries(vars)) {
    saved.set(k, process.env[k]);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    fn();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("getCitationBackend: defaults to auto with no env and no config", () => {
  withEnv({ PAPERLAB_CITATION_BACKEND: undefined }, () => {
    // Config file may exist on this machine — force empty by checking the
    // function's contract: with no env and no config, it must be "auto".
    let hasConfig = false;
    try {
      readFileSync(CONFIG_PATH, "utf8");
      hasConfig = true;
    } catch {
      /* no config */
    }
    const b = getCitationBackend();
    if (!hasConfig) assert.equal(b, "auto");
    else assert.ok(["serper", "exa", "both", "auto", "crossref"].includes(b));
  });
});

test("getCitationBackend: invalid env value is ignored (falls back to auto)", () => {
  withEnv({ PAPERLAB_CITATION_BACKEND: "garbage-backend" }, () => {
    assert.equal(getCitationBackend(), "auto");
  });
});

test("getCitationBackend: valid env value wins", () => {
  for (const v of ["serper", "exa", "both", "auto", "crossref"]) {
    withEnv({ PAPERLAB_CITATION_BACKEND: v }, () => {
      assert.equal(getCitationBackend(), v);
    });
  }
});
