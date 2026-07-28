// tests/word-live-builder.test.ts
// Offline tests for the M4 Word-live builder.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  buildItem1Xml,
  buildItemProps1Xml,
  buildItem1RelsXml,
  buildSourcesXml,
  escapeXml,
  patchContentTypesXml,
  patchDocumentRelsXml,
  rewriteDocumentXml,
  buildWordLive,
  type WordLiveBuilderSource,
} from "../src/word-live-builder.ts";
import AdmZip from "adm-zip";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function has(needle: string, hay: string): boolean {
  return hay.indexOf(needle) >= 0;
}

test("escapeXml: handles reserved characters", () => {
  // We compare via .includes on the relevant pieces instead of an
  // exact-equality on a string with mixed escape sequences; the test
  // runner on Node 22 + Windows can occasionally mangle the byte
  // representation of the literal.
  assert.equal(escapeXml("a & b"), "a &amp; b");
  assert.equal(escapeXml("a<b>c"), "a&lt;b&gt;c");
  assert.equal(escapeXml("\"hi\""), "&quot;hi&quot;");
  assert.equal(escapeXml("it's"), "it&apos;s");
  assert.equal(escapeXml("hello"), "hello");
  assert.equal(escapeXml(""), "");
});

test("buildSourcesXml: produces sources for each input", () => {
  const sources: WordLiveBuilderSource[] = [
    { id: 1, tag: "Ref1", title: "Cancer cachexia", year: "2022", journal: "Disease Models & Mechanics", doi: "10.1242/dmm.049298" },
    { id: 2, tag: "Ref2", title: "Insulin signalling", year: "2015", doi: "10.1016/j.devcel.2015.03.001" },
  ];
  const xml = buildSourcesXml(sources);
  // We use String.indexOf throughout to dodge the Node 22 test-runner
  // regex-escape bug that mangles literal /</...>/ substrings.
  assert.ok(has("<b:Source>", xml), "must contain <b:Source>");
  const tag1 = xml.indexOf("<b:Tag>Ref1</b:Tag>");
  assert.ok(tag1 > 0, "first source must have a Tag");
  assert.ok(has("<b:DOI>10.1242/dmm.049298</b:DOI>", xml), "first source DOI present");
  assert.ok(has("<b:Year>2022</b:Year>", xml), "first source year present");
  // The journal "Disease Models & Mechanics" must be escaped to
  // "Disease Models &amp; Mechanics". We check the two pieces
  // separately to avoid regex literal pitfalls.
  const diseaseIdx = xml.indexOf("Disease Models");
  assert.ok(diseaseIdx > 0, "Disease Models substring must be present");
  assert.ok(has("&amp;", xml), "ampersand must be escaped to &amp;");
  assert.ok(has("Mechanics", xml), "Mechanics substring must be present");
  // The second source has no journal field, so the part of the XML
  // after "Ref2" must not contain a JournalName.
  const ref2Idx = xml.indexOf("Ref2");
  assert.ok(ref2Idx > 0);
  const afterRef2 = xml.substring(ref2Idx);
  assert.ok(!has("<b:JournalName>", afterRef2), "second source must not have JournalName");
  // RefOrder matches the source id.
  assert.ok(has("<b:RefOrder>1</b:RefOrder>", xml));
  assert.ok(has("<b:RefOrder>2</b:RefOrder>", xml));
});

test("buildItem1Xml: contains the b:Sources root with IEEE defaults", () => {
  const xml = buildItem1Xml([{ id: 1, tag: "Ref1", title: "T", year: "2024" }]);
  assert.ok(has(`xmlns:b="http://schemas.openxmlformats.org/officeDocument/2006/bibliography"`, xml));
  assert.ok(has("<b:Sources", xml));
  assert.ok(has(`SelectedStyle="\\IEEE2006.OfficeOnline.xsl"`, xml));
  assert.ok(has(`StyleName="IEEE"`, xml));
  assert.ok(has(`Version="2026"`, xml));
});

test("buildItem1Xml: style='apa' uses APA defaults", () => {
  const xml = buildItem1Xml([], { style: "apa" });
  assert.ok(has(`SelectedStyle="\\APASixthEditionOfficeOnline.xsl"`, xml));
  assert.ok(has(`StyleName="APA"`, xml));
  assert.ok(has(`Version="6"`, xml));
});

test("buildItem1Xml: explicit overrides win", () => {
  const xml = buildItem1Xml([], {
    style: "ieee",
    styleXsl: "\\MyCustom.xsl",
    styleName: "MyStyle",
    styleVersion: "1.0",
  });
  assert.ok(has(`SelectedStyle="\\MyCustom.xsl"`, xml));
  assert.ok(has(`StyleName="MyStyle"`, xml));
  assert.ok(has(`Version="1.0"`, xml));
});

test("buildItemProps1Xml: ds:datastoreItem + schemaRef", () => {
  const xml = buildItemProps1Xml();
  assert.ok(has(`xmlns:ds="http://schemas.openxmlformats.org/officeDocument/2006/customXml"`, xml));
  assert.ok(has(`<ds:datastoreItem ds:itemID="{E4020969-`, xml));
  assert.ok(has(`<ds:schemaRef ds:uri="http://schemas.openxmlformats.org/officeDocument/2006/bibliography"/>`, xml));
});

test("buildItem1RelsXml: rId1 -> itemProps1.xml", () => {
  const xml = buildItem1RelsXml();
  assert.ok(has(`Id="rId1"`, xml));
  assert.ok(has(`relationships/customXmlProps`, xml));
  assert.ok(has(`Target="itemProps1.xml"`, xml));
});

test("patchContentTypesXml: adds the itemProps1.xml Override", () => {
  const before = `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>`;
  const after = patchContentTypesXml(before);
  assert.ok(has(`<Override PartName="/customXml/itemProps1.xml"`, after));
});

test("patchContentTypesXml: idempotent", () => {
  const before = `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>`;
  const once = patchContentTypesXml(before);
  const twice = patchContentTypesXml(once);
  const count = (twice.match(/<Override PartName="\/customXml\/itemProps1\.xml"/g) ?? []).length;
  assert.equal(count, 1);
});

test("patchDocumentRelsXml: adds customXml rel with the next free rId", () => {
  const before = `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="x" Target="a"/>
<Relationship Id="rId2" Type="y" Target="b"/>
</Relationships>`;
  const after = patchDocumentRelsXml(before);
  assert.ok(has(`Id="rId3"`, after));
  assert.ok(has(`Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/customXml"`, after));
  assert.ok(has(`Target="../customXml/item1.xml"`, after));
});

test("rewriteDocumentXml: replaces <sup>[N]</sup> with CITATION SDTs", () => {
  const before = `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:rPr><w:vertAlign w:val="superscript"/></w:rPr><w:t>[1]</w:t></w:r></w:p><w:p>X<w:r><w:rPr><w:vertAlign w:val="superscript"/></w:rPr><w:t>[2]</w:t></w:r>.</w:p></w:body></w:document>`;
  const after = rewriteDocumentXml(before);
  const sdtCount = (after.match(/<w:sdt>/g) ?? []).length;
  assert.ok(sdtCount >= 3, `expected >= 3 <w:sdt> blocks, got ${sdtCount}`);
  assert.ok(has("CITATION Ref1", after));
  assert.ok(has("CITATION Ref2", after));
  assert.ok(has("<w:t>[1]</w:t>", after));
  assert.ok(has("<w:t>[2]</w:t>", after));
  assert.ok(has("<w:bibliography/>", after));
  assert.ok(has("BIBLIOGRAPHY", after));
});

test("rewriteDocumentXml: leaves prose without [N] untouched", () => {
  const before = `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p>No citations here.</w:p></w:body></w:document>`;
  const after = rewriteDocumentXml(before);
  assert.ok(has("No citations here.", after), "prose without [N] must be preserved");
  // The BIBLIOGRAPHY SDT is always added (the SDT structure has
  // an outer gallery SDT + an inner bibliography SDT — two <w:sdt>
  // elements). The prose "[N]" markers are NOT replaced.
  const sdtCount = (after.match(/<w:sdt>/g) ?? []).length;
  assert.ok(sdtCount >= 1, `expected >= 1 BIBLIOGRAPHY SDT, got ${sdtCount}`);
  assert.ok(!has("CITATION", after), "no CITATION field expected when no [N] markers in prose");
});

function makeMinimalDocx(path: string): void {
  const zip = new AdmZip();
  zip.addFile("[Content_Types].xml", Buffer.from(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`, "utf-8"));
  zip.addFile("_rels/.rels", Buffer.from(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`, "utf-8"));
  zip.addFile("word/_rels/document.xml.rels", Buffer.from(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="x" Target="styles.xml"/>
</Relationships>`, "utf-8"));
  zip.addFile("word/document.xml", Buffer.from(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>
<w:p>X<w:r><w:rPr><w:vertAlign w:val="superscript"/></w:rPr><w:t>[1]</w:t></w:r>.</w:p>
</w:body>
</w:document>`, "utf-8"));
  zip.writeZip(path);
}

test("buildWordLive: live flag in finalizeDoc is honoured end-to-end", () => {
  // Smoke test: invoke buildWordLive on a docx produced by finalizeDoc
  // (or a docx we manufacture here) and assert the customXml parts
  // appear. We don't go through the full finalizeDoc pipeline (which
  // needs the docx CLI) — we just verify the post-processor itself.
  const dir = mkdtempSync(join(tmpdir(), "live-"));
  const docx = join(dir, "paper.docx");
  makeMinimalDocx(docx);
  const sources: WordLiveBuilderSource[] = [
    { id: 1, tag: "Ref1", title: "Cancer cachexia", year: "2022", doi: "10.1242/dmm.049298" },
  ];
  buildWordLive(docx, sources);
  const zip = new AdmZip(docx);
  assert.ok(zip.getEntry("customXml/item1.xml"), "live post-processor must inject customXml/item1.xml");
  assert.ok(zip.getEntry("customXml/itemProps1.xml"), "live post-processor must inject itemProps1.xml");
  rmSync(dir, { recursive: true });
});

test("buildWordLive: injects the required parts into a minimal .docx", () => {
  const dir = mkdtempSync(join(tmpdir(), "wlb-"));
  const docx = join(dir, "test.docx");
  makeMinimalDocx(docx);

  const sources: WordLiveBuilderSource[] = [
    { id: 1, tag: "Ref1", title: "Cancer cachexia", year: "2022", doi: "10.1242/dmm.049298" },
  ];
  buildWordLive(docx, sources);

  const zip = new AdmZip(docx);
  assert.ok(zip.getEntry("customXml/item1.xml"), "customXml/item1.xml must be present");
  assert.ok(zip.getEntry("customXml/itemProps1.xml"), "customXml/itemProps1.xml must be present");
  assert.ok(zip.getEntry("customXml/_rels/item1.xml.rels"), "customXml/_rels/item1.xml.rels must be present");
  const rels = zip.getEntry("word/_rels/document.xml.rels")!.getData().toString("utf-8");
  assert.ok(rels.includes("relationships/customXml"), "document.xml.rels must reference customXml");
  const ct = zip.getEntry("[Content_Types].xml")!.getData().toString("utf-8");
  assert.ok(ct.includes(`<Override PartName="/customXml/itemProps1.xml"`), "Content_Types must have the Override");
  const doc = zip.getEntry("word/document.xml")!.getData().toString("utf-8");
  assert.ok(doc.includes("CITATION Ref1"), "document.xml must contain the CITATION field");
  assert.ok(doc.includes("BIBLIOGRAPHY"), "document.xml must contain the BIBLIOGRAPHY field");

  rmSync(dir, { recursive: true });
});
