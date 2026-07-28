# Word citation reference XML — golden files

Byte-level ground truth captured 2026-07-28 from `data/word citation reference.docx`
(a document created in real Word by inserting 1 citation + 1 bibliography via
References → Insert Citation / Bibliography).

These are the reference templates the `word-live-builder.ts` reproduces.

## Files
- `content-types.xml` — `[Content_Types].xml`. NOTE: no Override for item1.xml
  (covered by `<Default Extension="xml">`). Only itemProps1.xml needs an Override.
- `item1-sources.xml` — `customXml/item1.xml`. The `b:Sources` source list.
  Carries `SelectedStyle`/`StyleName`/`Version` at the root (style switching).
- `itemProps1.xml` — `customXml/itemProps1.xml`. datastoreItem + schemaRef.
- `item1.xml.rels` — `customXml/_rels/item1.xml.rels`. Points to itemProps1.xml.
- `document.xml.rels` — `word/_rels/document.xml.rels`. rId1 → customXml/item1.xml.
- `document.xml` — `word/document.xml` (pretty-printed). Contains:
  - CITATION field INSIDE an `<w:sdt>` with `<w:citation/>` in sdtPr (NOT naked)
  - BIBLIOGRAPHY as a DOUBLE SDT: outer `docPartGallery="Bibliographies"` +
    inner `<w:bibliography/>` with the ` BIBLIOGRAPHY ` field
