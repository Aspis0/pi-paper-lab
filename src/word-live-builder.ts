// src/word-live-builder.ts
//
// M4 of the v0.7 plan. Post-processes a .docx (produced by `docx create`)
// to inject Word's native citation system so the user can edit the
// document in Word with renumbering-on-F9 and live Source Manager.
//
// What gets injected (per data/word-reference-xml/README.md):
//   - customXml/item1.xml          (b:Sources with one b:Source per citation)
//   - customXml/itemProps1.xml     (datastoreItem + schemaRef)
//   - customXml/_rels/item1.xml.rels  (rId1 -> itemProps1.xml)
//   - word/_rels/document.xml.rels (rId1 -> ../customXml/item1.xml)
//   - [Content_Types].xml          (Override for itemProps1.xml only;
//                                    item1.xml is covered by the default
//                                    "xml" extension rule.)
//   - word/document.xml            (every superscript [N] replaced with an
//                                    <w:sdt><w:citation/></w:sdt> field; the
//                                    bibliography block at the end becomes
//                                    a DOUBLE <w:sdt> with docPartGallery=
//                                    Bibliographies + <w:bibliography/>.)
//
// The byte-level structure was captured from a real Word-saved .docx
// (data/word-citation-reference.docx). The builder does NOT replace
// the base document's root element — it preserves namespaces and adds
// only the bits Word needs to recognise the source list.
//
// KNOWN limitations (M0.5 must validate the runtime):
//   - We do not validate that the user has Word's IEEE2006.OfficeOnline.xsl
//     style installed. The .docx is set to "IEEE" by default; if Word
//     cannot find the style, it falls back to Word's built-in APA
//     rendering, which is a mismatch but not a crash.
//   - We do not test the renumber-after-delete flow (needs a human in
//     real Word — M0.5).
//   - The builder does not handle the case where [Content_Types].xml
//     already has a customXml Override (we would silently produce
//     invalid XML). For the M4 first cut, we assume a clean
//     `docx create` output and validate in tests.

import AdmZip from "adm-zip";

export interface WordLiveBuilderSource {
  /** Numeric id (1, 2, 3, ...). The [N] in the prose. */
  id: number;
  /** b:Tag — the citation key Word uses internally. */
  tag: string;
  /** b:SourceType. Defaults to "JournalArticle". */
  sourceType?: "JournalArticle" | "Book" | "BookChapter" | "Report" | "InternetSite" | "ConferenceProceedings";
  /** b:Title (required). */
  title: string;
  /** Year as a string (b:Year). */
  year?: string;
  /** Journal/book name (b:JournalName). */
  journal?: string;
  /** DOI. */
  doi?: string;
  /** URL. */
  url?: string;
  /** Authors. Each name becomes a <b:Person> with <b:Last>/<b:First>. */
  authors?: { family: string; given?: string }[];
  /** Volume. */
  volume?: string;
  /** Issue. */
  issue?: string;
  /** Pages (e.g. "123-130" or "dmm049298"). */
  pages?: string;
}

export interface BuildLiveOpts {
  /** Citation style. Only "ieee" is supported in v0.7.0 (see PLAN §3.10). */
  style?: "ieee" | "apa";
  /** XSL file to use (overrides the style default). */
  styleXsl?: string;
  /** Style name (overrides the style default). */
  styleName?: string;
  /** Style version (overrides the style default). */
  styleVersion?: string;
}

const STYLE_DEFAULTS: Record<NonNullable<BuildLiveOpts["style"]>, { xsl: string; name: string; version: string }> = {
  ieee: { xsl: "\\IEEE2006.OfficeOnline.xsl", name: "IEEE", version: "2026" },
  apa: { xsl: "\\APASixthEditionOfficeOnline.xsl", name: "APA", version: "6" },
};

/**
 * Build the b:Sources XML body from a list of sources.
 * Exported for testing.
 */
export function buildSourcesXml(sources: WordLiveBuilderSource[]): string {
  const sourceNodes = sources.map((s) => {
    const id = `Ref${s.id}`;
    const tag = escapeXml(s.tag || id);
    const sourceType = escapeXml(s.sourceType ?? "JournalArticle");
    const title = escapeXml(s.title);
    const year = s.year ? escapeXml(s.year) : "";
    const journal = s.journal ? `<b:JournalName>${escapeXml(s.journal)}</b:JournalName>` : "";
    const doi = s.doi ? `<b:DOI>${escapeXml(s.doi)}</b:DOI>` : "";
    const url = s.url ? `<b:URL>${escapeXml(s.url)}</b:URL>` : "";
    const volume = s.volume ? `<b:Volume>${escapeXml(s.volume)}</b:Volume>` : "";
    const issue = s.issue ? `<b:Issue>${escapeXml(s.issue)}</b:Issue>` : "";
    const pages = s.pages ? `<b:Pages>${escapeXml(s.pages)}</b:Pages>` : "";
    const authors = (s.authors ?? []).map((a) => {
      const last = escapeXml(a.family);
      const first = a.given ? `<b:First>${escapeXml(a.given)}</b:First>` : "";
      return `<b:Person><b:Last>${last}</b:Last>${first}</b:Person>`;
    }).join("");
    const authorBlock = authors
      ? `<b:Author><b:Author><b:NameList>${authors}</b:NameList></b:Author></b:Author>`
      : "";
    return `<b:Source><b:Tag>${tag}</b:Tag><b:SourceType>${sourceType}</b:SourceType><b:Guid>{${s.id}-0000-0000-0000-000000000000}</b:Guid>${authorBlock}<b:Title>${title}</b:Title>${journal}<b:Year>${year}</b:Year>${volume}${issue}${pages}${doi}${url}<b:RefOrder>${s.id}</b:RefOrder></b:Source>`;
  }).join("");
  return sourceNodes;
}

/**
 * Escape XML special characters. Exported for testing.
 */
export function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Build the customXml/item1.xml content (the b:Sources source list).
 * Exported for testing.
 */
export function buildItem1Xml(sources: WordLiveBuilderSource[], opts: BuildLiveOpts = {}): string {
  const style = opts.style ?? "ieee";
  const defaults = STYLE_DEFAULTS[style];
  const xsl = escapeXml(opts.styleXsl ?? defaults.xsl);
  const name = escapeXml(opts.styleName ?? defaults.name);
  const version = escapeXml(opts.styleVersion ?? defaults.version);
  const body = buildSourcesXml(sources);
  return `<?xml version="1.0" encoding="UTF-8" standalone="no"?><b:Sources xmlns:b="http://schemas.openxmlformats.org/officeDocument/2006/bibliography" xmlns="http://schemas.openxmlformats.org/officeDocument/2006/bibliography" SelectedStyle="${xsl}" StyleName="${name}" Version="${version}">${body}</b:Sources>`;
}

/**
 * Build the customXml/itemProps1.xml content (the datastoreItem + schemaRef).
 * Exported for testing.
 */
export function buildItemProps1Xml(guid: string = "{E4020969-16DB-42B6-89B5-299465DA5302}"): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="no"?><ds:datastoreItem ds:itemID="${guid}" xmlns:ds="http://schemas.openxmlformats.org/officeDocument/2006/customXml"><ds:schemaRefs><ds:schemaRef ds:uri="http://schemas.openxmlformats.org/officeDocument/2006/bibliography"/></ds:schemaRefs></ds:datastoreItem>`;
}

/**
 * Build the customXml/_rels/item1.xml.rels content.
 * Exported for testing.
 */
export function buildItem1RelsXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/customXmlProps" Target="itemProps1.xml"/></Relationships>`;
}

/**
 * Build the CITATION field XML for a given [N] reference.
 * Returns a sequence of <w:r> elements wrapped in a <w:sdt> that Word
 * recognises as a managed citation. The visible text is the literal
 * "[N]" — Word rewrites it on F9 per the active citation style.
 */
function buildCitationSdt(refId: number, visibleText: string): string {
  const tag = `Ref${refId}`;
  // Use a stable ID derived from refId. Word only requires uniqueness
  // within the document.
  const sdtId = String(100000 + refId);
  return `<w:sdt><w:sdtPr><w:id w:val="${sdtId}"/><w:citation/></w:sdtPr><w:sdtContent><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> CITATION ${tag} \\l 1033 </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:rPr><w:noProof/></w:rPr><w:t>${escapeXml(visibleText)}</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:sdtContent></w:sdt>`;
}

/**
 * Build the BIBLIOGRAPHY SDT — the outer docPartGallery SDT that holds
 * the "Bibliography" heading paragraph, wrapping the inner
 * <w:bibliography/> SDT that contains the actual field.
 *
 * Returned as a sequence of <w:p> paragraphs (the heading + the
 * bibliography field) that go at the end of the body.
 */
function buildBibliographySdt(visibleText: string = "(Update Field to render)"): string {
  return `<w:sdt><w:sdtPr><w:id w:val="111145805"/><w:docPartObj><w:docPartGallery w:val="Bibliographies"/><w:docPartUnique/></w:docPartObj></w:sdtPr><w:sdtContent><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Bibliography</w:t></w:r></w:p><w:sdt><w:sdtPr><w:id w:val="222111456"/><w:bibliography/></w:sdtPr><w:sdtContent><w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> BIBLIOGRAPHY </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:rPr><w:noProof/></w:rPr><w:t>${escapeXml(visibleText)}</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p></w:sdtContent></w:sdt></w:sdtContent></w:sdt>`;
}

/**
 * Rewrite word/document.xml: replace every `<sup>[N]</sup>` with a
 * CITATION SDT, and append a BIBLIOGRAPHY SDT at the end of the body
 * (just before `</w:body>`). Returns the modified document.xml.
 */
export function rewriteDocumentXml(docXml: string): string {
  // Replace <w:r><w:rPr>...<w:vertAlign w:val="superscript"/>...</w:rPr>
  // <w:t>[N]</w:t></w:r> with a CITATION SDT. The bun-docx output uses
  // <sup>...</sup> which becomes a <w:r>...<w:vertAlign>...</w:vertAlign>
  // <w:t>[N]</w:t></w:r> in OOXML.
  let out = docXml;
  // Match a run that has the [N] in a <w:t>, with optional <w:vertAlign
  // superscript> somewhere in the same <w:rPr>.
  const supRunRe = /<w:r\b[^>]*>(?:<w:rPr>(?:[^<]|<(?!w:t\b)[^<]*)*<w:vertAlign w:val="superscript"\/>(?:[^<]|<(?!w:t\b)[^<]*)*<\/w:rPr>)?\s*<w:t[^>]*>\[(\d+)\]<\/w:t>\s*<\/w:r>/g;
  out = out.replace(supRunRe, (_m, n) => buildCitationSdt(parseInt(n, 10), `[${n}]`));

  // Append the BIBLIOGRAPHY SDT just before </w:body>.
  out = out.replace("</w:body>", buildBibliographySdt() + "</w:body>");
  return out;
}

/**
 * Patch [Content_Types].xml to add the itemProps1.xml Override.
 * The default "xml" extension already covers item1.xml — no Override
 * needed for it.
 */
export function patchContentTypesXml(ctXml: string, itemPropsTarget: string = "/customXml/itemProps1.xml"): string {
  const override = `<Override PartName="${itemPropsTarget}" ContentType="application/vnd.openxmlformats-officedocument.customXmlProperties+xml"/>`;
  // Insert before the closing </Types>. If the Override is already
  // present, leave it alone.
  if (ctXml.includes(itemPropsTarget)) return ctXml;
  return ctXml.replace("</Types>", override + "</Types>");
}

/**
 * Patch word/_rels/document.xml.rels to add a customXml relationship
 * pointing at customXml/item1.xml. The first unused rId number is
 * computed by scanning existing relationships.
 */
export function patchDocumentRelsXml(relsXml: string): string {
  // Find the highest existing rId number (e.g. rId1, rId2, ...).
  const rids = [...relsXml.matchAll(/Id="rId(\d+)"/g)].map((m) => parseInt(m[1], 10));
  const nextRid = (rids.length > 0 ? Math.max(...rids) : 0) + 1;
  const rel = `<Relationship Id="rId${nextRid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/customXml" Target="../customXml/item1.xml"/>`;
  return relsXml.replace("</Relationships>", rel + "</Relationships>");
}

/**
 * Process a .docx file in place: read it, inject the citation system,
 * write it back. Returns nothing (the file is mutated in place).
 */
export function buildWordLive(
  docxPath: string,
  sources: WordLiveBuilderSource[],
  opts: BuildLiveOpts = {},
): void {
  const zip = new AdmZip(docxPath);
  // 1. customXml/item1.xml
  zip.addFile("customXml/item1.xml", Buffer.from(buildItem1Xml(sources, opts), "utf-8"));
  // 2. customXml/itemProps1.xml
  zip.addFile("customXml/itemProps1.xml", Buffer.from(buildItemProps1Xml(), "utf-8"));
  // 3. customXml/_rels/item1.xml.rels
  zip.addFile("customXml/_rels/item1.xml.rels", Buffer.from(buildItem1RelsXml(), "utf-8"));
  // 4. word/_rels/document.xml.rels
  const relsEntry = zip.getEntry("word/_rels/document.xml.rels");
  if (!relsEntry) throw new Error(`word/_rels/document.xml.rels not found in ${docxPath}`);
  const rels = relsEntry.getData().toString("utf-8");
  zip.updateFile(relsEntry, Buffer.from(patchDocumentRelsXml(rels), "utf-8"));
  // 5. [Content_Types].xml
  const ctEntry = zip.getEntry("[Content_Types].xml");
  if (!ctEntry) throw new Error(`[Content_Types].xml not found in ${docxPath}`);
  const ct = ctEntry.getData().toString("utf-8");
  zip.updateFile(ctEntry, Buffer.from(patchContentTypesXml(ct), "utf-8"));
  // 6. word/document.xml
  const docEntry = zip.getEntry("word/document.xml");
  if (!docEntry) throw new Error(`word/document.xml not found in ${docxPath}`);
  const doc = docEntry.getData().toString("utf-8");
  zip.updateFile(docEntry, Buffer.from(rewriteDocumentXml(doc), "utf-8"));
  // Write back.
  zip.writeZip(docxPath);
}
