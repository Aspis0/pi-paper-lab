// tests/live-default.test.ts
// v0.7.6: live Word citations are the DEFAULT. Covers:
//   - finalizeDoc() with no opts → liveApplied true, customXml/item1.xml present
//   - finalizeDoc({ live: false }) → liveApplied false, no customXml parts
//   - buildWordLive embeds the cached static list in the BIBLIOGRAPHY field
//     (the non-Word fallback: the list must be present as cached field result)

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import AdmZip from "adm-zip";
import { finalizeDoc } from "../src/pipeline.ts";
import { buildWordLive, type WordLiveBuilderSource } from "../src/word-live-builder.ts";
import type { CrossRefWork } from "../src/crossref.ts";

const fixture: CrossRefWork = {
  doi: "10.1242/dmm.049298",
  title: ["Cancer cachexia: lessons from Drosophila"],
  author: [{ family: "Liu", given: "Ying" }, { family: "Saavedra", given: "Pedro" }, { family: "Perrimon", given: "Norbert" }],
  published: { dateParts: [2022] },
  containerTitle: ["Disease Models & Mechanisms"],
  volume: "15",
  page: "dmm049298",
};

function writeTmp(md: string): string {
  const dir = mkdtempSync(join(tmpdir(), "livedefault-"));
  const p = join(dir, "paper.md");
  writeFileSync(p, md, "utf-8");
  return p;
}

describe("v0.7.6 live-citation default + fallback", () => {
  it("finalizeDoc() with NO opts defaults to LIVE (renumber-on-F9 in Word)", () => {
    const md = writeTmp("Body text with a citation [1](<doi:10.1242/dmm.049298>).");
    const r = finalizeDoc(md, { noCache: true, lookupDoi: () => fixture });
    assert.equal(r.error, undefined);
    assert.equal(r.liveApplied, true, "live is the default → liveApplied true");
    const zip = new AdmZip(r.docxPath);
    assert.ok(zip.getEntry("customXml/item1.xml"), "live default injects customXml/item1.xml");
    rmSync(join(md, ".."), { recursive: true });
  });

  it("finalizeDoc({ live: false }) → static build, no customXml parts", () => {
    const md = writeTmp("Body text with a citation [1](<doi:10.1242/dmm.049298>).");
    const r = finalizeDoc(md, { noCache: true, live: false, lookupDoi: () => fixture });
    assert.equal(r.liveApplied, false, "explicit live:false → static");
    const zip = new AdmZip(r.docxPath);
    assert.ok(!zip.getEntry("customXml/item1.xml"), "static build has NO customXml/item1.xml");
    rmSync(join(md, ".."), { recursive: true });
  });

  it("BIBLIOGRAPHY field carries the cached reference list (non-Word fallback)", () => {
    // Build a minimal docx with a superscript [1], then run buildWordLive with
    // a cached bibliography. The cached refs must appear inside the BIBLIOGRAPHY
    // SDT so LibreOffice/Google Docs display a complete list.
    const dir = mkdtempSync(join(tmpdir(), "cacheref-"));
    const docx = join(dir, "c.docx");
    const zip = new AdmZip();
    zip.addFile("[Content_Types].xml", Buffer.from(`<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="text/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/></Types>`, "utf-8"));
    zip.addFile("_rels/.rels", Buffer.from(`<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`, "utf-8"));
    zip.addFile("word/_rels/document.xml.rels", Buffer.from(`<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>`, "utf-8"));
    zip.addFile("word/document.xml", Buffer.from(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p>X<w:r><w:rPr><w:vertAlign w:val="superscript"/></w:rPr><w:t>[1]</w:t></w:r>.</w:p></w:body></w:document>`, "utf-8"));
    zip.writeZip(docx);

    const sources: WordLiveBuilderSource[] = [
      { id: 1, tag: "Ref1", title: "Cancer cachexia", year: "2022", doi: "10.1242/dmm.049298" },
    ];
    const cached = ["[1] Liu Y, Saavedra P, Perrimon N. Cancer cachexia: lessons from Drosophila. Dis Model Mech. 2022;15. doi:10.1242/dmm.049298"];
    buildWordLive(docx, sources, { cachedBibliography: cached });

    const out = new AdmZip(docx).getEntry("word/document.xml")!.getData().toString("utf-8");
    assert.ok(out.includes("BIBLIOGRAPHY"), "BIBLIOGRAPHY field present");
    assert.ok(out.includes("Cancer cachexia: lessons from Drosophila"), "cached ref text embedded as field result (non-Word fallback)");
    assert.ok(!out.includes("(Update Field to render)"), "no placeholder when cached refs are supplied");
    rmSync(dir, { recursive: true });
  });

  it("CLI --no-live flag is parsed (static build via the CLI path)", () => {
    // Indirectly: the usage string documents --no-live and bin/finalize.mjs
    // parses it. We assert the CLI source wires opts.live=false for the flag.
    const cli = readFileSync(join(process.cwd(), "bin", "finalize.mjs"), "utf-8");
    assert.match(cli, /--no-live|--static/, "CLI recognises --no-live/--static");
    assert.match(cli, /opts\.live\s*=\s*false/, "CLI sets opts.live=false for the flag");
  });
});
