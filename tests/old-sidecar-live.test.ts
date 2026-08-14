// tests/old-sidecar-live.test.ts
// v0.7.6 regression: a pre-v0.7.5 sidecar (has {doi, vancouver} but NO `csl`
// field) must NOT produce broken live citations. Before the fix, the
// cache-hit shortcut `continue`d before populating cslItems, so the live
// builder dropped entries from b:Sources — cited in the body, missing from
// the source list (broken citation in Word).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import AdmZip from "adm-zip";
import { finalizeDoc } from "../src/pipeline.ts";
import type { CrossRefWork } from "../src/crossref.ts";

// Minimal CrossRef fixtures for two DOIs.
const works: Record<string, CrossRefWork> = {
  "10.1242/dmm.049298": {
    doi: "10.1242/dmm.049298",
    title: ["Cancer cachexia: lessons from Drosophila"],
    author: [{ family: "Liu", given: "Ying" }],
    published: { dateParts: [2022] },
    containerTitle: ["Disease Models & Mechanisms"],
    volume: "15",
  },
  "10.1098/rsob.190087": {
    doi: "10.1098/rsob.190087",
    title: ["Adult Drosophila muscle morphometry through microCT"],
    author: [{ family: "Chaturvedi", given: "Dhananjay" }],
    published: { dateParts: [2019] },
    containerTitle: ["Open Biology"],
    volume: "9",
  },
};

function writeOldSidecar(mdPath: string, entries: Record<string, { doi: string; vancouver: string }>) {
  const sidecar = {
    schemaVersion: 1 as const,
    sourceMarkdown: mdPath,
    lastResolvedAt: "2026-07-28T00:00:00.000Z",
    citationBackend: "crossref",
    citations: entries,
  };
  writeFileSync(mdPath.replace(/\.md$/i, ".citations.json"), JSON.stringify(sidecar, null, 2), "utf-8");
}

describe("v0.7.6 old-sidecar live migration", () => {
  it("an old sidecar (no csl) still yields a complete b:Sources list (no dropped citations)", () => {
    const dir = mkdtempSync(join(tmpdir(), "oldsidecar-"));
    const md = join(dir, "paper.md");
    // Body cites [1] and [2]; sidecar has both but WITHOUT csl.
    writeFileSync(md, "Body [1](<doi:10.1242/dmm.049298>) and [2](<doi:10.1098/rsob.190087>).\n", "utf-8");
    writeOldSidecar(md, {
      "1": { doi: "10.1242/dmm.049298", vancouver: "1. Liu Y. Cancer cachexia. Dis Model Mech. 2022;15. doi:10.1242/dmm.049298" },
      "2": { doi: "10.1098/rsob.190087", vancouver: "2. Chaturvedi D. Adult Drosophila muscle morphometry. Open Biol. 2019;9. doi:10.1098/rsob.190087" },
    });

    const r = finalizeDoc(md, { live: true, lookupDoi: (d) => works[d] ?? null });
    assert.equal(r.error, undefined);
    assert.equal(r.liveApplied, true);

    const zip = new AdmZip(r.docxPath);
    const item1 = zip.getEntry("customXml/item1.xml")!.getData().toString("utf-8");
    const doc = zip.getEntry("word/document.xml")!.getData().toString("utf-8");

    // Both Ref1 AND Ref2 must be in b:Sources (the bug dropped Ref2).
    assert.ok(item1.includes("<b:Tag>Ref1</b:Tag>"), "Ref1 in b:Sources");
    assert.ok(item1.includes("<b:Tag>Ref2</b:Tag>"), "Ref2 in b:Sources (old-sidecar migration)");
    // Both cited in body.
    assert.ok(doc.includes("CITATION Ref1"), "Ref1 cited in body");
    assert.ok(doc.includes("CITATION Ref2"), "Ref2 cited in body");

    // The sidecar must now be UPGRADED with csl fields (so next run is cache-fast).
    const upgraded = JSON.parse(readFileSync(md.replace(/\.md$/i, ".citations.json"), "utf-8"));
    assert.ok(upgraded.citations?.["1"]?.csl, "sidecar upgraded: [1] now has csl");
    assert.ok(upgraded.citations?.["2"]?.csl, "sidecar upgraded: [2] now has csl");

    rmSync(dir, { recursive: true });
  });
});
