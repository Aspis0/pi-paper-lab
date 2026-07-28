// Smoke-test diretto: chiama finalizeDoc con --live sul sidecar reale di devboule.
// Bypassa /reload: carica il modulo via import dinamico e verifica che il .docx
// risultante contenga customXml/item1.xml (prova che --live mode ha funzionato
// invece di fallire silenziosamente nel require dinamico).

import { writeFile, readFile, rm, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { finalizeDoc } from "../src/pipeline.ts";
import AdmZip from "adm-zip";

const WORK_DIR = join(tmpdir(), "live-smoke-test-" + Date.now());
await import("node:fs").then(fs => fs.mkdirSync(WORK_DIR, { recursive: true }));

const sidecarPayload = {
  schemaVersion: 1,
  sourceMarkdown: "",
  lastResolvedAt: new Date().toISOString(),
  citationBackend: "auto",
  citations: {
    "1": { doi: "10.48550/arXiv.2603.27277", vancouver: "1. (doi:10.48550/arXiv.2603.27277)" },
    "6": { doi: "10.35784/jcsi.7831", vancouver: "6. Milichiewicz Rafał, Badurowicz Marcin. Comparative analysis of cross-platform application development tools. Journal of Computer Sciences Institute. 2025;36:357-364. doi:10.35784/jcsi.7831" },
    "7": { doi: "10.1109/VISSOFT64034.2024.00012", vancouver: "7. Štěpánek Adam, Kuťák David, Kozlíková Barbora, Byška Jan. Interactive Diagrams for Software Documentation. 2024 IEEE Working Conference on Software Visualization. 2024:12-23. doi:10.1109/VISSOFT64034.2024.00012" },
    "8": { doi: "10.18653/v1/2025.acl-long.189", vancouver: "8. Yu Boxi, Zhu Yuxuan. UTBoost. ACL. 2025:3762-3774. doi:10.18653/v1/2025.acl-long.189" },
  },
};

const md = `# Smoke test

A paragraph with citations [1](<doi:10.48550/arXiv.2603.27277>), [6](<doi:10.35784/jcsi.7831>), [7](<doi:10.1109/VISSOFT64034.2024.00012>), [8](<doi:10.18653/v1/2025.acl-long.189>).
`;

const mdPath = join(WORK_DIR, "smoke.md");
const sidecarPath = mdPath.replace(/\.md$/, ".citations.json");
await writeFile(mdPath, md, "utf8");
await writeFile(sidecarPath, JSON.stringify(sidecarPayload), "utf8");

console.log("MD:", mdPath);
console.log("Sidecar:", sidecarPath);

const result = await finalizeDoc(mdPath, {
  live: true,
  lookupDoi: async (doi) => {
    // Non chiamiamo mai CrossRef: il sidecar già ha i Vancouver.
    throw new Error("no CrossRef in smoke test");
  },
});

console.log("Result:", result);

if (!result.docxPath) {
  console.error("❌ finalizeDoc did not return docxPath");
  process.exit(1);
}

const zip = new AdmZip(result.docxPath);
const entries = zip.getEntries().map(e => e.entryName);
console.log("DOCX entries:", entries);

const hasCustomXml = entries.some(e => e === "customXml/item1.xml");
const hasItemProps = entries.some(e => e === "customXml/itemProps1.xml");
const hasDocRel = entries.includes("word/_rels/document.xml.rels");

if (!hasCustomXml) {
  console.error("❌ customXml/item1.xml NOT injected into the .docx");
  console.error("   This means --live mode fell back to static.");
  process.exit(1);
}

const sourcesXml = zip.readAsText("customXml/item1.xml");
const sourceCount = (sourcesXml.match(/<b:Source>/g) ?? []).length;
console.log("✅ customXml/item1.xml present");
console.log("✅ customXml/itemProps1.xml present:", hasItemProps);
console.log("✅ b:Source count:", sourceCount);

const docXml = zip.readAsText("word/document.xml");
const citationCount = (docXml.match(/CITATION Ref\d+/g) ?? []).length;
const bibliographyCount = (docXml.match(/BIBLIOGRAPHY/g) ?? []).length;
console.log("✅ CITATION fields in document.xml:", citationCount);
console.log("✅ BIBLIOGRAPHY field present:", bibliographyCount > 0);

if (sourceCount === 0 || citationCount === 0) {
  console.error("❌ Zero sources or citations — live build incomplete");
  process.exit(1);
}

await rm(WORK_DIR, { recursive: true, force: true });
console.log("\n🎉 Smoke test PASSED. --live mode works in pi runtime.");
