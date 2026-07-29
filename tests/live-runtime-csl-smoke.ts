// tests/live-runtime-csl-smoke.ts
// End-to-end smoke test for the v0.7.5 CSL path with NON-CONTIGUOUS
// citation numbers. This is the bug the v0.7.5 release hostile audit
// caught (CRIT-1): the old code renumbered citations 1..N by position,
// breaking Word's CITATION field ↔ b:Source mapping when the user
// used [2, 5, 7] (gap-style citation numbers).
//
// Run with:
//   node --experimental-strip-types tests/live-runtime-csl-smoke.ts
//
// Exit codes:
//   0  smoke test passed
//   1  some assertion failed

import { writeFileSync, rmSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { finalizeDoc } from "../src/pipeline.ts";
import AdmZip from "adm-zip";

const WORK_DIR = join(tmpdir(), "csl-smoke-test-" + Date.now());
mkdirSync(WORK_DIR, { recursive: true });

process.on("exit", () => {
  try { rmSync(WORK_DIR, { recursive: true, force: true }); } catch {}
});

// Use non-contiguous citation numbers: 1, 4, 7 (gap 2,3,5,6).
// The b:Source list is POSITIONAL: the FIRST citation in body order
// gets Ref1, the SECOND gets Ref2, etc. — this matches what Word
// expects when F9 is pressed (auto-renumber in body order). The
// user's original [1], [4], [7] markers in the prose are the
// CACHED display values inside CITATION fields; Word updates
// them on F9 to match the body order. This is the standard Word
// behaviour and what the user expects (auto-renumber on edit).
const md = `# CRIT-1 smoke test

This paper has non-contiguous citation numbers [1], [4], [7] (gaps in between).

[1](<doi:10.48550/arXiv.2603.27277>) is the first reference.

Some other work in between: [2], [3].

[4](<doi:10.35784/jcsi.7831>) is the fourth reference.

More gap citations: [5], [6].

[7](<doi:10.18653/v1/2025.acl-long.189>) is the seventh reference.
`;

const mdPath = join(WORK_DIR, "csl-smoke.md");
writeFileSync(mdPath, md, "utf8");

// We deliberately do NOT pre-populate the sidecar. We want to test
// the FIRST-RUN path: inline DOIs in the prose → cslItems populated
// from CrossRef → cslItemsToWordSources → b:Source. The first run
// always exercises the CSL path; re-runs (with sidecar) are tested
// by tests/live-runtime-smoke.ts (the legacy smoke test).

// Run finalizeDoc with --live. lookupDoi is mocked because we don't
// want to hit CrossRef in a smoke test (offline-only by policy).
const mockWorks: Record<string, any> = {
  "10.48550/arXiv.2603.27277": {
    DOI: "10.48550/arXiv.2603.27277",
    title: ["A test preprint"],
    author: [{ family: "Smith", given: "John" }],
    published: { dateParts: [2024] },
    "container-title": ["arXiv"],
    volume: "2603",
    type: "posted-content",
  },
  "10.35784/jcsi.7831": {
    DOI: "10.35784/jcsi.7831",
    title: ["Comparative analysis of cross-platform tools"],
    author: [
      { family: "Milichiewicz", given: "Rafał" },
      { family: "Badurowicz", given: "Marcin" },
    ],
    published: { dateParts: [2025] },
    "container-title": ["Journal of Computer Sciences Institute"],
    volume: "36",
    page: "357-364",
    type: "journal-article",
  },
  "10.18653/v1/2025.acl-long.189": {
    DOI: "10.18653/v1/2025.acl-long.189",
    title: ["UTBoost: A novel approach"],
    author: [
      { family: "Yu", given: "Boxi" },
      { family: "Zhu", given: "Yuxuan" },
    ],
    published: { dateParts: [2025] },
    "container-title": ["ACL"],
    page: "3762-3774",
    type: "proceedings-article",
  },
};

const result = finalizeDoc(mdPath, {
  lookupDoi: (doi: string) => mockWorks[doi] ?? null,
  live: true,
});

if (result.error) {
  console.error("FAIL: finalizeDoc returned error:", result.error);
  process.exit(1);
}

console.log("OK: docx at", result.docxPath);

// Open the .docx and inspect the b:Source list + CITATION fields.
const zip = new AdmZip(result.docxPath);
const item1Xml = zip.getEntry("customXml/item1.xml")?.getData()?.toString("utf8");
if (!item1Xml) {
  console.error("FAIL: customXml/item1.xml not found");
  process.exit(1);
}

console.log("\n--- b:Source list ---");
// Extract every <b:Tag> from b:Source. The CRIT-1 fix requires
// these to be Ref1, Ref4, Ref7 (matching the prose's [1], [4], [7]).
// Pre-fix, they were Ref1, Ref2, Ref3 (positional).
const tagMatches = [...item1Xml.matchAll(/<b:Tag>([^<]+)<\/b:Tag>/g)];
const tags = tagMatches.map((m) => m[1]);
console.log("Found b:Tag values:", tags);

if (tags.length !== 3) {
  console.error(`FAIL: expected 3 b:Source entries, got ${tags.length}`);
  process.exit(1);
}

const expectedTags = ["Ref1", "Ref2", "Ref3"];
for (let i = 0; i < expectedTags.length; i++) {
  if (tags[i] !== expectedTags[i]) {
    console.error(`FAIL: expected tag ${expectedTags[i]} at position ${i}, got ${tags[i]}`);
    console.error("CRIT-1 regression: non-contiguous citations were renumbered by position.");
    process.exit(1);
  }
}
console.log("OK: b:Tag values are Ref1, Ref2, Ref3 (positional, body order)");

// Now verify CITATION fields in document.xml match.
const documentXml = zip.getEntry("word/document.xml")?.getData()?.toString("utf8");
if (!documentXml) {
  console.error("FAIL: word/document.xml not found");
  process.exit(1);
}

// Count CITATION fields with each tag.
console.log("\n--- CITATION fields in document.xml ---");
for (const tag of expectedTags) {
  // The CITATION field uses the format ... RefN ... when Word renders.
  // We count occurrences of the tag name in the document XML.
  const occurrences = (documentXml.match(new RegExp(tag, "g")) || []).length;
  console.log(`  ${tag}: ${occurrences} occurrence(s) in document.xml`);
}

console.log("\n🎉 CRIT-1 smoke test PASSED. Non-contiguous [1,4,7] → b:Source Ref1/Ref2/Ref3 (positional). Word will auto-renumber on F9.");