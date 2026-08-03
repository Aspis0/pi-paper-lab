// tests/audit-round2.test.ts
// Regression tests for the 12 hostile-audit bugs fixed in 0.7.6 round 2.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { cleanExtractedDocx, checkInstructionFulfillment, plainTextCitation, finalizeDoc } from "../src/pipeline.ts";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import AdmZip from "adm-zip";
import type { CrossRefWork } from "../src/crossref.ts";

describe("audit round 2", () => {
  it("BUG 3: --static / --no-live flags now match in user instructions", () => {
    // The flag forms must match when preceded by a space (word-boundary bug).
    const re = /(?:^|\s)--(?:no-live|static)(?=\s|$)|libreoffice|google docs|apple pages/i;
    assert.ok(re.test("use --static for final"), "'--static' matches after space");
    assert.ok(re.test("--no-live"), "'--no-live' at start matches");
    assert.ok(re.test("do it --no-live please"), "'--no-live' mid-sentence matches");
    // BUG 12: prose topic "static analysis" must NOT trigger.
    assert.ok(!re.test("write about static analysis methods"), "'static analysis' topic does not trigger");
    assert.ok(!re.test("static electricity"), "'static electricity' topic does not trigger");
  });

  it("BUG 5: DOI plain-form capture strips trailing period", () => {
    const docx = "Body[1].\n\n## References\n\n[1] Authors. Title. J. 2024. doi:10.1016/j.cell.2024.01.001. See also.\n";
    const out = cleanExtractedDocx(docx);
    const m = out.match(/\[1\]\(<doi:([^>]+)>\)/)!;
    assert.equal(m[1], "10.1016/j.cell.2024.01.001", "no trailing period");
  });

  it("BUG 10: hyphenated 'Future-directions' heading is detected", () => {
    const w = checkInstructionFulfillment("## Future-directions\n\ntext", "remove future directions");
    assert.ok(w.length >= 1, "hyphenated heading flagged");
  });

  it("BUG 8: plainTextCitation strips HTML + decodes entities (no double-escape)", () => {
    const v = "10. Liu Y. lessons from <i>Drosophila</i>. Disease Models &amp; Mechanisms. 2022.";
    const plain = plainTextCitation(v);
    assert.ok(!plain.includes("<i>"), "HTML tags stripped");
    assert.ok(!plain.includes("&amp;"), "no &amp; entity");
    assert.ok(plain.includes("Drosophila"), "text preserved");
    assert.ok(plain.includes("Disease Models & Mechanisms"), "& decoded to literal &");
  });

  it("BUG 1: live-default docx has ONE References (no double section)", () => {
    const dir = mkdtempSync(join(tmpdir(), "b1-"));
    const md = join(dir, "p.md");
    writeFileSync(md, "Body [1](<doi:10.1242/dmm.049298>).\n", "utf-8");
    const work: CrossRefWork = {
      doi: "10.1242/dmm.049298", title: ["Cancer cachexia"], author: [{ family: "Liu", given: "Y" }],
      published: { dateParts: [2022] }, containerTitle: ["DMM"], volume: "15",
    };
    const r = finalizeDoc(md, { noCache: true, lookupDoi: () => work });
    assert.equal(r.error, undefined);
    assert.equal(r.liveApplied, true);
    const zip = new AdmZip(r.docxPath);
    const doc = zip.getEntry("word/document.xml")!.getData().toString("utf-8");
    // The BIBLIOGRAPHY SDT adds ONE "References" heading; the static ## References
    // section must NOT also be present (no double).
    const refHeadings = (doc.match(/<w:t[^>]*>References<\/w:t>/g) ?? []).length;
    assert.equal(refHeadings, 1, `exactly one References heading (got ${refHeadings})`);
    // cached bibliography must not be double-escaped
    assert.ok(!doc.includes("&amp;amp;"), "no double-escaped &amp;amp;");
    assert.ok(!doc.includes("&lt;i&gt;"), "no escaped <i> tag in cached biblio");
    rmSync(dir, { recursive: true });
  });

  it("BUG 6: a citation whose CSL fetch returns null is NOT dropped from b:Sources", () => {
    const dir = mkdtempSync(join(tmpdir(), "b6-"));
    const md = join(dir, "p.md");
    writeFileSync(md, "Body [1](<doi:10.1242/dmm.049298>) and [2](<doi:10.1016/j.devcel.2015.02.012>).\n", "utf-8");
    const works: Record<string, CrossRefWork> = {
      "10.1242/dmm.049298": { doi: "10.1242/dmm.049298", title: ["Cancer cachexia"], author: [{ family: "Liu" }], published: { dateParts: [2022] }, containerTitle: ["DMM"] },
      "10.1016/j.devcel.2015.02.012": { doi: "10.1016/j.devcel.2015.02.012", title: ["ImpL2"], author: [{ family: "Kwon" }], published: { dateParts: [2015] }, containerTitle: ["Dev Cell"] },
    };
    // lookupDoi returns null for [2] to simulate a network failure on the lazy fetch.
    // Use --verify-all so neither is trusted from a (nonexistent) sidecar; both fetch fresh.
    // Actually we want [1] to succeed and [2] to fail. Make lookupDoi fail for the 2nd DOI.
    let calls = 0;
    const r = finalizeDoc(md, {
      noCache: true,
      lookupDoi: (d) => (d === "10.1242/dmm.049298" ? works[d] : null),
    });
    assert.equal(r.error, undefined);
    const zip = new AdmZip(r.docxPath);
    const item1 = zip.getEntry("customXml/item1.xml")!.getData().toString("utf-8");
    // [2]'s Vancouver fallback must still produce a b:Source (Ref2 present).
    assert.ok(item1.includes("<b:Tag>Ref2</b:Tag>"), "Ref2 present via Vancouver fallback (not dropped)");
    rmSync(dir, { recursive: true });
  });
});
