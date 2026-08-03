// tests/live-superscript-autoupdate.test.ts
// v0.7.6: live citations must render as SUPERSCRIPT (regression: they showed
// plain [1] [2]), and the .docx must auto-renumber on open (updateFields).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import AdmZip from "adm-zip";
import { buildWordLive, patchStylesXml, patchSettingsXml, type WordLiveBuilderSource } from "../src/word-live-builder.ts";

function makeMinimalDocx(path: string) {
  const zip = new AdmZip();
  zip.addFile("[Content_Types].xml", Buffer.from(`<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="text/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/></Types>`, "utf-8"));
  zip.addFile("_rels/.rels", Buffer.from(`<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`, "utf-8"));
  zip.addFile("word/_rels/document.xml.rels", Buffer.from(`<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>`, "utf-8"));
  zip.addFile("word/document.xml", Buffer.from(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p>X<w:r><w:rPr><w:vertAlign w:val="superscript"/></w:rPr><w:t>[1]</w:t></w:r>.</w:p></w:body></w:document>`, "utf-8"));
  zip.writeZip(path);
}

describe("v0.7.6 superscript + auto-update", () => {
  it("citation visible run references the Citation character style (superscript)", () => {
    const dir = mkdtempSync(join(tmpdir(), "sup-"));
    const docx = join(dir, "d.docx");
    makeMinimalDocx(docx);
    const sources: WordLiveBuilderSource[] = [{ id: 1, tag: "Ref1", title: "T", year: "2022", doi: "10.1/x" }];
    buildWordLive(docx, sources);
    const doc = new AdmZip(docx).getEntry("word/document.xml")!.getData().toString("utf-8");
    assert.match(doc, /<w:rStyle w:val="Citation"\/>/, "citation run uses the Citation character style");
    assert.match(doc, /<w:t xml:space="preserve">\[1\]<\/w:t>/, "visible text is [1] with preserved spacing");
    rmSync(dir, { recursive: true });
  });

  it("styles.xml gets a Citation character style with superscript", () => {
    const patched = patchStylesXml(`<?xml version="1.0"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:styleId="Normal"/></w:styles>`);
    assert.match(patched, /w:styleId="Citation"/, "Citation style added");
    assert.match(patched, /<w:vertAlign w:val="superscript"\/>/, "Citation style has superscript");
    // idempotent
    const again = patchStylesXml(patched);
    assert.equal((again.match(/w:styleId="Citation"/g) || []).length, 1, "idempotent — no duplicate Citation style");
  });

  it("patchSettingsXml sets updateFields=true (exported helper, NOT used by buildWordLive)", () => {
    // BUG 4 fix: buildWordLive no longer calls patchSettingsXml (Word's citation
    // fields are excluded from open-auto-update, so the flag only caused an
    // annoying popup). The helper is still exported for callers who want it.
    const patched = patchSettingsXml(`<?xml version="1.0"?><w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:zoom w:percent="100"/></w:settings>`);
    assert.match(patched, /<w:updateFields w:val="true"\/>/, "updateFields set to true");
    const again = patchSettingsXml(patched);
    assert.equal((again.match(/<w:updateFields/g) || []).length, 1, "idempotent — single updateFields");
  });

  it("buildWordLive injects the Citation style but NOT updateFields (no popup)", () => {
    const dir = mkdtempSync(join(tmpdir(), "e2e-"));
    const docx = join(dir, "d.docx");
    makeMinimalDocx(docx);
    buildWordLive(docx, [{ id: 1, tag: "Ref1", title: "T", year: "2022", doi: "10.1/x" }]);
    const zip = new AdmZip(docx);
    const styles = zip.getEntry("word/styles.xml")!.getData().toString("utf-8");
    assert.match(styles, /w:styleId="Citation"[^]*<w:vertAlign w:val="superscript"/, "styles.xml has Citation+superscript");
    // BUG 4: buildWordLive must NOT inject updateFields (popup with zero citation benefit).
    if (zip.getEntry("word/settings.xml")) {
      const settings = zip.getEntry("word/settings.xml")!.getData().toString("utf-8");
      assert.ok(!/<w:updateFields w:val="true"/.test(settings), "settings.xml has NO updateFields (no popup)");
    }
    rmSync(dir, { recursive: true });
  });
});
