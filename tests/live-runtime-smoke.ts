// tests/live-runtime-smoke.ts
// Smoke-test for the --live flag in finalizeDoc. Bypasses /reload by
// loading the module directly via node --experimental-strip-types.
//
// Goal: produce a .docx with the parts Word needs to recognise citation
// fields, and assert those parts exist (customXml/item1.xml with
// multiple b:Source entries, CITATION fields in document.xml, the
// BIBLIOGRAPHY SDT, etc.).
//
// Run manually with:
//   node --experimental-strip-types tests/live-runtime-smoke.ts
//
// Exit codes:
//   0  smoke test passed
//   1  some assertion failed (cleanup is best-effort; process.exit wins
//      over try/finally completion, so we register an exit handler)
//
// The temp directory is removed on every exit path (success, error,
// uncaught exception) via a process.on("exit") hook.

import { writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { finalizeDoc } from "../src/pipeline.ts";
import AdmZip from "adm-zip";

const WORK_DIR = join(tmpdir(), "live-smoke-test-" + Date.now());
mkdirSync(WORK_DIR, { recursive: true });

// Cleanup hook — runs on success, error, exception, all exits.
process.on("exit", () => {
  try { rmSync(WORK_DIR, { recursive: true, force: true }); } catch {}
});

const sidecarPayload = {
  schemaVersion: 1,
  sourceMarkdown: "",
  lastResolvedAt: new Date().toISOString(),
  citationBackend: "auto",
  citations: {
    "1": { doi: "10.48550/arXiv.2603.27277", vancouver: "1. (doi:10.48550/arXiv.2603.27277)" },
    // v0.7.2 fix: placeholder entries must produce a b:Source (CRIT-2).
    "2": { doi: null, vancouver: "2. [Citation metadata unavailable — no DOI found. Re-run /paper-cite to resolve this reference.]" },
    // v0.7.2 fix: multi-trailing-paren DOIs must be cleaned (MED-1).
    "3": { doi: "10.1234/example-multi-paren", vancouver: "3. (doi:10.1234/example-multi-paren)))" },
    "6": { doi: "10.35784/jcsi.7831", vancouver: "6. Milichiewicz Rafał, Badurowicz Marcin. Comparative analysis of cross-platform application development tools. Journal of Computer Sciences Institute. 2025;36:357-364. doi:10.35784/jcsi.7831" },
    "7": { doi: "10.1109/VISSOFT64034.2024.00012", vancouver: "7. Štěpánek Adam, Kuťák David, Kozlíková Barbora, Byška Jan. Interactive Diagrams for Software Documentation. 2024 IEEE Working Conference on Software Visualization. 2024:12-23. doi:10.1109/VISSOFT64034.2024.00012" },
    "8": { doi: "10.18653/v1/2025.acl-long.189", vancouver: "8. Yu Boxi, Zhu Yuxuan. UTBoost. ACL. 2025:3762-3774. doi:10.18653/v1/2025.acl-long.189" },
  },
};

const md = `# Smoke test\n\nA paragraph with citations [1](<doi:10.48550/arXiv.2603.27277>), [2], [3](<doi:10.1234/example-multi-paren>), [6](<doi:10.35784/jcsi.7831>), [7], [8].\n`;

const mdPath = join(WORK_DIR, "smoke.md");
const sidecarPath = mdPath.replace(/\.md$/, ".citations.json");
writeFileSync(mdPath, md, "utf8");
writeFileSync(sidecarPath, JSON.stringify(sidecarPayload), "utf8");

console.log("MD:", mdPath);
console.log("Sidecar:", sidecarPath);

function fail(msg: string): never {
  console.error(`❌ ${msg}`);
  process.exit(1);
}

const result = await finalizeDoc(mdPath, {
  live: true,
  lookupDoi: async () => {
    // CrossRef is mocked: sidecar pre-populates all DOIs.
    throw new Error("no CrossRef in smoke test");
  },
});

console.log("Result:", result);
if (!result.docxPath) fail("finalizeDoc returned no docxPath");

const zip = new AdmZip(result.docxPath);
const entries = zip.getEntries().map(e => e.entryName);
console.log("DOCX entries:", entries);

if (!entries.includes("customXml/item1.xml")) {
  fail("customXml/item1.xml NOT injected into the .docx (--live fell back to static)");
}
if (!entries.includes("customXml/itemProps1.xml")) {
  fail("customXml/itemProps1.xml NOT injected into the .docx");
}
if (!entries.includes("customXml/_rels/item1.xml.rels")) {
  fail("customXml/_rels/item1.xml.rels NOT injected into the .docx");
}

const sourcesXml = zip.readAsText("customXml/item1.xml");
const sourceCount = (sourcesXml.match(/<b:Source>/g) ?? []).length;
console.log("✅ b:Source count:", sourceCount);

// Expected sources: 6 total (4 Vancouver full + 1 placeholder + 1 doi-only).
// Without the v0.7.2 placeholder fix (CRIT-2) the count would be 5; verify
// we hit the higher bar.
if (sourceCount < 6) fail(`expected ≥6 b:Source entries (got ${sourceCount}; placeholder fix missing?)`);

const docXml = zip.readAsText("word/document.xml");
const citationCount = (docXml.match(/CITATION Ref\d+/g) ?? []).length;
const bibCount = (docXml.match(/BIBLIOGRAPHY/g) ?? []).length;
console.log("✅ CITATION fields in document.xml:", citationCount);
console.log("✅ BIBLIOGRAPHY field present:", bibCount > 0);

if (citationCount < 4) fail(`expected ≥4 CITATION fields (got ${citationCount})`);
if (bibCount === 0) fail("BIBLIOGRAPHY field missing");

console.log("\n🎉 Smoke test PASSED. --live mode works in pi runtime.");
