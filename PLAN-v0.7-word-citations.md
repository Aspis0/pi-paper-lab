# PLAN — pi-paper-lab v0.7.0 — Word-native citations + research UX

> Status: DRAFT for user review. Implementation starts after the 4 open
> questions at the bottom are answered. Big minor bump (0.6.x → 0.7.0)
> because the .docx output format changes and new modules ship.

## 0. Goal

Make pi-paper-lab produce a `.docx` whose references are **live Word citation
fields** (the built-in Source Manager system), so that when the user edits
the document in Word — adds/deletes text with citations — the in-text numbers
and the bibliography renumber automatically via `Ctrl+A, F9` (or right-click
→ Update Field). Plus: stronger source-finding, better LLM prompts, and an
interactive "ask the user when unsure" UX.

Scope is deliberately split into 4 features so each can ship/roll back
independently:

- **A** — Word-native citation DOCX generator (the headline feature)
- **B** — Improved source-finding (official, free, richer APIs)
- **C** — Disambiguation / "ask when unsure" UX
- **D** — Prompt improvements

---

## 1. Research findings (what is actually possible)

### 1A. Word's built-in citation system is reachable from raw OOXML

Verified against the OOXML spec, the Microsoft citation-management add-in
sample, the `citeground` project (Zotero-flavoured field injection), and a
real-world demonstration (bacsich.org, June 2026) where an LLM-built `.docx`
was opened in Word, the Source Manager accepted the injected sources as
first-class peers, and `F9` rendered both citation and bibliography.

The system lives in **three places** inside the `.docx` zip:

1. **A CustomXML part** `customXml/item1.xml` in the `b:` (bibliography)
   namespace — this *is* the document's source list. Anything here appears
   in Source Manager's **Current List** when the document opens.
   - Companion `customXml/itemProps1.xml` declares the schema ref
     (`http://schemas.openxmlformats.org/officeDocument/2006/bibliography`)
     and a stable GUID `itemID`.
   - Relationships live in `customXml/_rels/item1.xml.rels`.
   - `[Content_Types].xml` MUST declare a content type for the customXml
     item or Word shows an "unreadable content" repair prompt. This is the
     #1 failure point in community attempts.

2. **`CITATION Tag \l <locale>` field codes** in the body, resolved by Word
   against the CustomXML part and rendered per the selected style. Built as
   a complex field: `w:fldChar begin` → `w:instrText " CITATION Tag \l 1033 "`
   → `w:fldChar separate` → visible run `[N]` → `w:fldChar end`.

3. **A `BIBLIOGRAPHY` field inside an `sdt`** (structured document tag)
   from the Bibliographies gallery, so Insert Bibliography / Update behaves
   natively. Instruction text: ` BIBLIOGRAPHY \l 1033 `.

**Behaviour confirmed**: with a numeric style (IEEE / Vancouver via a `.xsl`
or built-in), Word numbers citations in order of appearance and renumbers
when a citation field is deleted and fields are updated. The bibliography
field regenerates from the source list. Known limitation: Word's built-in
manager does **not** collapse consecutive numeric citations (`[1,2,3]` stays
`[1][2][3]`) — acceptable for a first version.

**The `b:` schema is poorer than CSL/CSL-JSON** (no DOI on some types, crude
contributor roles, no original-date). The DOI field *does* exist on
`JournalArticle`/`BookChapter`/`Report`, which covers our use cases. The
lossy mapping must warn, never silently drop.

### 1B. Free, official, no-key bibliographic APIs give the AI more signal

Tested live on 2026-07-28 (cachexia/Drosophila/ImpL2 query):

| API | Key? | Returns we get | Why it helps |
|---|---|---|---|
| **OpenAlex** `api.openalex.org/works?search=` | No key (polite pool w/ mailto) | title, DOI, `cited_by_count`, `open_access.oa_url`, `concepts[]`, `authorships[]` (incl. ORCID), `publication_year`, `abstract_inverted_index` (reconstructable) | Structured topic search + influence + OA link + concepts for disambiguation |
| **Europe PMC** `ebi.ac.uk/europepmc/webservices/rest/search` | No key | title, DOI, `journalTitle`, `pubYear`, `citedByCount`, MeSH headings, `abstractText`, `fullTextUrlList` | **Biomedical-native**: real abstracts, MeSH terms, full-text links — best for our domain |
| **CrossRef** (already used) | No key (mailto polite) | title, authors, journal, vol/issue/pages, `abstract` (rare) | Canonical metadata + DOI lookup — keep as the resolver |
| Semantic Scholar | Free but **429 without key** | TLDR, abstract, citations, references | Optional, only if user sets `S2_API_KEY` |
| Serper Scholar / Exa | Paid key | Google Scholar mirror / semantic web | Keep as fallback; noisier than OpenAlex for topic search |

**Conclusion**: add OpenAlex (primary topic search, structured) + Europe PMC
(biomedical abstracts + MeSH). Both free, no key, more info than the current
Serper/Exa path. This directly feeds Feature C (verification) and Feature D
(prompts) because the AI now sees abstracts + MeSH, not just snippets.

### 1C. The disambiguation-then-ask pattern is proven

`citeground`'s `disambiguate.py` classifies each candidate as
`RESOLVED / AMBIGUOUS / REVIEW / MISSING` and only escalates the ambiguous
~5–15% to a human (or chat LLM picking among pre-retrieved candidates —
never inventing). We adopt the same contract: the resolver never fabricates;
uncertain rows become structured questions to the user.

---

## 2. Architecture — new / changed modules

```
src/
  pipeline.ts                 (changed: --live flag, new prompt, marker contract)
  citations.ts                (changed: resolveCitation gains OpenAlex/PMC backends)
  crossref.ts                 (unchanged; already good)
  source-finders/
    openalex.ts               (NEW — topic search + metadata, no key)
    europepmc.ts              (NEW — biomedical abstracts + MeSH, no key)
    semantic-scholar.ts       (NEW, optional — needs S2_API_KEY)
    serper-scholar.ts         (keep)
    exa-scholar.ts            (keep)
  word-live-builder.ts        (NEW — the headline: injects Word citation fields)
  cite-verify.ts              (changed: uses Europe PMC abstracts)
  clarify.ts                  (NEW — disambiguation + ask-the-user UX)
  tools.ts                    (changed: register new tools + ask_user)
  config.ts                   (changed: new fields)
bin/
  finalize.mjs                (changed: --live flag routes to word-live-builder)
  seed-sidecar.mjs            (unchanged)
  word-live.mjs               (NEW — standalone CLI for the live builder)
data/
  ieee-numeric.xsl  (optional)  (NEW — Vancouver/IEEE citation style if not built-in)
tests/
  word-live-builder.test.ts   (NEW)
  openalex.test.ts             (NEW — mocked)
  europepmc.test.ts           (NEW — mocked)
  clarify.test.ts             (NEW)
  audit-regressions.test.ts   (extended — HIGH-3 malformed DOI stays green)
```

Dependency change: add **`adm-zip`** (tiny, pure-JS, sync) for zip
post-processing of the bun-docx output. Alternative considered: hand-roll
ZIP with `node:zlib` — rejected (CRC + central-directory bookkeeping is bug-
prone). `adm-zip` is the standard choice and keeps the sync code style of
the existing pipeline.

---

## 3. Feature A — Word-native citation DOCX generator

### 3.1 Two output modes

- **`static` (current default, unchanged)** — `<sup>[N]</sup>` + manual
  `## References` section. Identical to v0.6.x output. Safe for submission.
- **`live` (new)** — Word citation fields + CustomXML source list +
  BIBLIOGRAPHY SDT. Editable in Word with auto-renumber. Default for
  drafting; the user flips to `static` for the final submission build.

CLI: `paper-lab-finalize paper.md --live` (and `--static` to be explicit).
Prompt: the LLM appends `--live` when the user says "campi live" / "renumber"
/ "native citations" / "citazioni Word".

### 3.2 Marker contract (the hard part)

The current pipeline converts `[N](<doi:...>)` → `<sup>[N]</sup>` *in the
Markdown* before bun-docx renders. For `--live` we must NOT lose the DOI, and
we must give the post-processor an unambiguous anchor.

**Decision**: in `--live` mode, `finalizeDoc` emits a token marker
`⟦N⟧` (U+27E6 / U+27E7 mathematical brackets — never appear in prose) as
plain text where the citation goes, and collects `N → {doi, vancouver,
b:Source-XML}` in memory. bun-docx renders `⟦N⟧` as a normal text run. The
post-processor scans `document.xml` runs for `⟦N⟧` and replaces each run
group with the CITATION field runs. This is unambiguous vs. real `[N]` in
text and survives bun-docx's renderer.

(Rejected alternative: emit the field XML directly as HTML-ish in Markdown
and hope bun-docx passes it through — bun-docx sanitises, so it would drop
the OOXML. The post-processor approach is the same one `citeground` uses
and is the proven path.)

### 3.3 The build pipeline (`word-live-builder.ts`)

```
paper.md
  │  finalizeDoc(--live)  →  paper.live.md  (⟦N⟧ tokens, NO References section)
  │                             + paper.live.citations.json  (N → doi + metadata)
  ▼
docx create paper.live.docx --from paper.live.md   (bun-docx, base document)
  │
  ▼  word-live-builder.postProcess(docxPath, citations.json)
       1. unzip (adm-zip)
       2. build customXml/item1.xml  (b:Sources, one b:Source per citation)
       3. build customXml/itemProps1.xml  (schemaRef + GUID)
       4. build customXml/_rels/item1.xml.rels  (relationship → itemProps1)
       5. patch [Content_Types].xml  (declare customXml content type — critical)
       6. patch word/_rels/document.xml.rels  (relationship → customXml/item1)
       7. rewrite word/document.xml:
            - every run containing ⟦N⟧ → CITATION field runs (Tag = "Ref"+N)
            - append BIBLIOGRAPHY SDT at the end
       8. zip back → paper.live.docx
  ▼
paper.live.docx   (open in Word: Source Manager shows all sources; F9 renders)
```

### 3.4 The `b:Source` XML (per citation)

Derived from CrossRef/EuropePMC metadata. Field mapping (CSL-ish → b:):

```xml
<b:Source>
  <b:Tag>Ref13</b:Tag>                       <!-- stable, unique -->
  <b:SourceType>JournalArticle</b:SourceType>
  <b:Author>
    <b:Author><b:NameList>
      <b:Person><b:Last>Liu</b:Last><b:First>Ying</b:First></b:Person>
      ...
    </b:NameList></b:Author>
  </b:Author>
  <b:Title>Cancer cachexia: lessons from Drosophila</b:Title>
  <b:JournalName>Disease Models &amp; Mechanisms</b:JournalName>
  <b:Year>2022</b:Year>
  <b:Volume>15</b:Volume>
  <b:Pages>...</b:Pages>
  <b:DOI>10.1242/dmm.049298</b:DOI>
  <b:URL>https://doi.org/10.1242/dmm.049298</b:URL>
</b:Source>
```

- Corporate authors → `<b:Corporate><b:Name>...</b:Name></b:Corporate>`.
- Editors → `<b:Editor>` (parallel structure).
- Source types we support: `JournalArticle`, `Book`, `BookChapter`, `Report`,
  `InternetSite`, `ConferenceProceedings`. Others map to `JournalArticle`
  with a warning (the lossy-mapping warning from §1A).

### 3.5 The CITATION field XML (per in-text occurrence)

Verified from `data/word-reference-xml/document.xml`: the field is wrapped
in an `<w:sdt>` carrying `<w:citation/>` in its `sdtPr` — NOT naked runs.
```xml
<w:sdt>
  <w:sdtPr>
    <w:id w:val="<any unique int>"/>
    <w:citation/>
  </w:sdtPr>
  <w:sdtContent>
    <w:r><w:fldChar w:fldCharType="begin"/></w:r>
    <w:r><w:instrText xml:space="preserve"> CITATION Ref13 \l 1033 </w:instrText></w:r>
    <w:r><w:fldChar w:fldCharType="separate"/></w:r>
    <w:r><w:rPr><w:noProof/></w:rPr><w:t>[13]</w:t></w:r>
    <w:r><w:fldChar w:fldCharType="end"/></w:r>
  </w:sdtContent>
</w:sdt>
```
The `Ref13` matches the `<b:Tag>` in the source list. The `[13]` visible
text is a placeholder; Word rewrites it on `F9` to the style-rendered
form. `w:noProof` on the visible run stops spell-check underlining the
rendered citation.

NOTE on superscript: the captured Word file does NOT apply `vertAlign
superscript` to the citation run — numeric IEEE/Vancouver superscript is a
RENDERING concern handled by the citation style's `.xsl`, not by run
properties. We follow Word's convention: emit plain runs inside the SDT;
the style makes them superscript. (If a style turns out to not render
superscript, we add `vertAlign` as a fallback — but start faithful to
Word's own output.)

### 3.6 The BIBLIOGRAPHY SDT (appended at end of body)

Verified from the capture: it is a DOUBLE SDT — an outer gallery SDT
holding the "Bibliography" heading paragraph, wrapping an inner
`<w:bibliography/>` SDT that holds the ` BIBLIOGRAPHY ` field.
```xml
<w:sdt>
  <w:sdtPr>
    <w:id w:val="<int>"/>
    <w:docPartObj>
      <w:docPartGallery w:val="Bibliographies"/>
      <w:docPartUnique/>
    </w:docPartObj>
  </w:sdtPr>
  <w:sdtEndPr><w:rPr>...heading run props...</w:rPr></w:sdtEndPr>
  <w:sdtContent>
    <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr>
      <w:r><w:t>Bibliography</w:t></w:r></w:p>
    <w:sdt>
      <w:sdtPr><w:id w:val="<int>"/><w:bibliography/></w:sdtPr>
      <w:sdtContent>
        <w:p>
          <w:r><w:fldChar w:fldCharType="begin"/></w:r>
          <w:r><w:instrText xml:space="preserve"> BIBLIOGRAPHY </w:instrText></w:r>
          <w:r><w:fldChar w:fldCharType="separate"/></w:r>
          <w:r><w:rPr><w:b/><w:bCs/><w:noProof/></w:rPr>
            <w:t>(right-click → Update Field to render)</w:t></w:r>
          <w:r><w:rPr><w:b/><w:bCs/><w:noProof/></w:rPr>
            <w:fldChar w:fldCharType="end"/></w:r>
        </w:p>
      </w:sdtContent>
    </w:sdt>
  </w:sdtContent>
</w:sdt>
```
The builder emits exactly ONE of these at the end of the body (the user's
reference file had two because they inserted the bibliography twice; we
only ever need one).

### 3.7 Tag & GUID discipline

- `b:Tag` = `Ref` + N (stable across regenerations of the same .md).
- `itemID` GUID for the CustomXML datastore: deterministic from the .md path
  hash so re-running `--live` on the same file updates in place rather than
  spawning duplicates in the Master List on "Copy to Master List".
- The sidecar `.citations.json` (v0.6.3) is extended to carry the chosen
  `b:Tag` per N so a later `--static` build stays consistent.

### 3.8 Validation strategy (no Word on the build machine)

We cannot run Word in CI. Mitigations:

1. **Round-trip test**: build a `--live` docx, unzip, assert the parts exist
   and the XML is well-formed + namespace-correct (xmllint-style via
   `adm-zip` + a tiny XML validator, or `fast-xml-parser` in
   `--validate-only` mode).
2. **Fixture-golden test**: check in a known-good `word-live-sample.docx`
   (built once in real Word by the user) and assert our generator's
   `customXml/item1.xml` matches byte-for-byte for the same input. Catches
   drift.
3. **`docx read` smoke**: the bun-docx reader must still extract the prose
   text (the `⟦N⟧` tokens become `[N]` after we also write a readable
   fallback). This keeps `cleanExtractedDocx` working on re-edit.

### 3.0 Step 0 — DONE (2026-07-28)

The reference `.docx` (captured from real Word, renamed to
`data/word-citation-reference.docx`) was unzipped. Golden XML templates
saved to `data/word-reference-xml/`:
- `content-types.xml`, `item1-sources.xml`, `itemProps1.xml`,
  `item1.xml.rels`, `document.xml.rels`, `document.xml` (raw one-line, 7.2 KB).

**Three corrections to my original assumptions** (§3.4–3.6 below are the
fixed versions, derived from the real Word output):

1. The CITATION field is **NOT** naked runs — it lives inside an `<w:sdt>`
   with `<w:citation/>` in `<w:sdtPr>`. Without the SDT wrapper, Word does
   not recognise the field as a managed citation.
2. The BIBLIOGRAPHY is a **DOUBLE SDT**: an outer SDT with
   `<w:docPartGallery w:val="Bibliographies">` (the gallery container,
   also holds the "Bibliography" heading paragraph) wrapping an inner SDT
   with `<w:bibliography/>` that holds the ` BIBLIOGRAPHY ` field.
3. `[Content_Types].xml` does **NOT** need an Override for `customXml/item1.xml`
   — the generic `<Default Extension="xml" ContentType="application/xml"/>`
   covers it. Only `customXml/itemProps1.xml` needs an Override
   (`application/vnd.openxmlformats-officedocument.customXmlProperties+xml`).
   This is the subtlety most community attempts get wrong.

**Style switching lives at the `b:Sources` root**: the captured file has
`SelectedStyle="\APASixthEditionOfficeOnline.xsl" StyleName="APA" Version="6"`.
For IEEE we change these three attributes (see §3.10 — IEEE only in v0.7).

#### What Step 0 actually validates vs what it does NOT

The Step 0 capture validates the **form** of Word's citation system:
the exact OOXML parts, the SDT nesting, the relationship plumbing, the
content-type rules. It does NOT validate the **behaviour** our v0.7.0
promises:

| Capability | Validated by Step 0? | Why |
|---|---|---|
| Word opens the `.docx` without repair prompt | Inferred (ZIP+XML valid), NOT live-confirmed | We have no Word on the build machine |
| Sources appear in Source Manager → Current List | Inferred from the same structure Word itself writes | Same as above |
| CITATION field renders as `[1]` in IEEE | NOT validated | The capture uses APA, not IEEE |
| BIBLIOGRAPHY field renders a real bibliography | NOT validated | The capture has `Placeholder1` only + citations in author-year format |
| Deleting a citation + F9 renumbers the rest | NOT validated | Needs a live Word session with a real IEEE doc |

**Action M0.5** (added after the audit): before M4 starts, the user
must run a small manual matrix in real Word and commit the artefacts:

1. Insert 2 citations in IEEE style with DOIs to see whether
   `F9` renders numbers in order of appearance.
2. Delete the first citation, `F9`, verify the second citation is now
   `[1]` and the bibliography still has 2 entries.
3. Open the Source Manager, confirm both sources are in the Current List.
4. Save the before/after `.docx` and screenshot the rendered output
   into `data/word-citation-validation/`.

This is the only way to prove the auto-renumber behaviour. The OOXML
form is now captured; the runtime behaviour still needs human eyes.

### 3.9 Fallback if `--live` fails

If the post-processor throws (bad XML, missing part), `finalizeDoc` falls
back to the `static` output and prints a clear error: "live build failed:
<reason>; produced static docx instead. Re-run without --live or report."
Never produces a corrupt docx.

### 3.10 Style switching (IEEE / Vancouver, user-selectable)

**User decision (2026-07-28)**: citation style is selectable from the
paper-lab settings (where API keys already live) — both IEEE and Vancouver
must be supported IN PRINCIPLE, but the audit (MED-4) flagged that the
original "bundled .xsl at absolute path" strategy is not portable.

#### v0.7.0: IEEE-only as the supported target

For v0.7.0 we ship IEEE numeric as the only fully-supported style. The
`citation_style` setting accepts `ieee` (default) or `apa`. The user
selects `ieee` from `config.ts` (`citation_style: "ieee"`) and the
builder writes:

```xml
<b:Sources xmlns:b="..." SelectedStyle="\IEEE2006.OfficeOnline.xsl"
           StyleName="IEEE" Version="2026">
```

`IEEE2006.OfficeOnline.xsl` ships with Word on Windows + macOS. We have
no portable way to test "is this `.xsl` present on the target machine"
without actually opening Word; the risk surface is acceptable because
`IEEE` is the most commonly-shipped built-in style.

#### Vancouver: experimental, opt-in, requires local install

When the user sets `citation_style: "vancouver"`, the builder:

1. Refuses to proceed with a clear error reporting that Vancouver is not
   bundled in v0.7.0; prints the README section that describes the
   opt-in path.
2. Does NOT silently fall back to IEEE (the audit explicitly rejected
   that). The user MUST explicitly choose `ieee` or install a Vancouver
   XSL themselves.

This is a deliberate scope cut: promising a non-portable Vancouver
shipping as IEEE is worse than being honest about v0.7.0 limitations.

#### v0.8+ candidate: bundled Vancouver XSL

A future major can investigate bundling a Vancouver XSL (BibWord
`Vancouver.OfficeOnline.xsl` is BSD-licensed) inside `data/styles/`. The
builder would then write a `SelectedStyle` path relative to the user's
Word startup directory (Word resolves these paths at startup). This work
is explicitly out of scope for v0.7.0.

#### Style switching remains a field-render-time concern

The same `.docx` can be re-rendered in a different style later by editing
`SelectedStyle` in `customXml/item1.xml` + pressing F9 — no rebuild
needed. This is what the audit (MED-4) flagged as portable within Word:
the OXML handles style switching without our involvement.

---

## 4. Feature B — Improved source-finding

### 4.1 New backends (`src/source-finders/`)

- **`openalex.ts`** — `searchOpenAlex(query, {num, signal})`. Reconstruct
  abstract from `abstract_inverted_index` (trivial: word→positions map).
  Return a normalised `Finding` type (see 4.3).
- **`europepmc.ts`** — `searchEuropePmc(query, {num, signal})`. Real
  abstracts, MeSH, full-text URLs. Domain-perfect for biology.
- **`semantic-scholar.ts`** — optional; only called if `S2_API_KEY` set.
  TLDRs + citation graph (find supporting/contradicting papers).

### 4.2 New `resolveCitation` ranking

`resolveCitation(topic)` now returns a unified, ranked `Finding[]`:

1. **OpenAlex** (structured, free) — primary.
2. **Europe PMC** (biomedical abstract + MeSH) — merged, de-duped by DOI.
3. **CrossRef** — metadata enrichment for any DOI-bearing candidate missing
   fields.
4. Serper/Exa — only if OpenAlex returns < 3 (configurable threshold) or
   the user explicitly sets `citation_backend: serper|exa`.

De-dup key = normalised DOI. Merge strategy: OpenAlex fields win; PMC fills
`abstract`/`mesh`; CrossRef fills `volume/issue/pages` (OpenAlex has these
too but CrossRef is canonical for pagination).

### 4.3 A richer `Finding` type (the "more info for the AI" part)

```ts
interface Finding {
  doi?: string;
  title: string;
  authors: { family: string; given?: string; orcid?: string }[];
  year?: number;
  venue?: string;
  volume?: string; issue?: string; pages?: string;
  abstract?: string;          // ← the big win: AI can now verify claims
  meshTerms?: string[];       // ← biomedical signal for disambiguation
  concepts?: string[];         // OpenAlex
  tldr?: string;              // S2 one-line summary
  citedByCount?: number;
  isOpenAccess?: boolean;
  oaUrl?: string;
  source: "openalex" | "europepmc" | "crossref" | "serper" | "exa" | "s2";
  confidence: "high" | "medium" | "low";  // for the clarify step
}
```

This type replaces the loose `ResolveResult.candidates` and is what the
prompts and the clarify step consume.

### 4.4 New tools for the LLM

- `find_citation` (existing) — now returns `Finding[]` with abstracts.
- `search_literature` (NEW) — broad topic search returning `Finding[]`
  with TLDRs + concepts; for the "study phase" of `/paper-write`.
- `get_abstract` (NEW) — Europe PMC / OpenAlex abstract fetch by DOI; used
  by `verify_citation` so the LLM sees real text, not just a title.

---

## 5. Feature C — Disambiguation / "ask when unsure" UX

### 5.1 The contract

The resolver classifies every candidate per topic into a status (adopted
from `citeground`):

| Status | Meaning | Action |
|---|---|---|
| `RESOLVED` | one clear winner, DOI present | assign `[N](<doi:...>)` |
| `AMBIGUOUS` | 2+ candidates within tie-break threshold | **ask the user** |
| `REVIEW` | one weak candidate or year mismatch | **ask the user** |
| `MISSING` | no candidate | mark `[CITATION NEEDED: topic]`, never fabricate |

**Never invent a citation.** The LLM only ever picks among candidates the
deterministic resolver retrieved, or marks the gap.

### 5.2 `clarify.ts`

- `classify(findings: Finding[], topic: string): ClarifyItem[]` — deterministic
  scoring (title/author/year overlap + MeSH/concept overlap with the claim
  sentence). Thresholds tuned so ~5–15% of items escalate (citeground's
  proven ratio).
- `formatClarifyPrompt(items: ClarifyItem[]): string` — renders a numbered
  menu the LLM can paste to the user: "I'm unsure about citation [N].
  Candidates: (a) Liu 2022 ... [DOI] (b) ... Which supports the claim
  '...'?".
- `clarifications.json` sidecar — the audit trail (same discipline as the
  citation sidecar): every AMBIGUOUS/REVIEW decision recorded with the
  chosen candidate + reason, so re-runs are stable.

### 5.3 The interactive loop

Two integration modes (pick per pipeline):

- **Synchronous (default)**: `buildCiteMarkPrompt` emits a
  `CLARIFICATIONS NEEDED` block listing every AMBIGUOUS/REVIEW item as a
  multiple-choice question. The LLM, in the same turn, surfaces them to the
  user via a normal message and waits. Once the user answers, the LLM
  assigns DOIs and proceeds to FINALIZE. This uses pi's existing chat —
  no new infra.
- **Tool-based (optional, cleaner)**: register an `ask_user` tool the LLM
  calls when it hits `[ASK:question]`. pi surfaces it as a prompt; the
  user's reply returns as the tool result. Requires the LLM to actually
  pause — works in pi because tool calls naturally yield.

Start with synchronous (ships in v0.7.0); add `ask_user` tool in a point
release if the synchronous block proves noisy.

### 5.4 Marker `[ASK:question]` in prose

The LLM may emit `[ASK: short question]` inline when it is unsure mid-write
(not just at cite time). `finalizeDoc` surfaces these as a
`QUESTIONS FOR THE AUTHOR` section at the top of the .docx (comment-style,
removed in `--static` final build). This is the "AI asks when not sure"
feature in its most general form.

---

## 6. Feature D — Prompt improvements

### 6.1 Tighter `buildCiteMarkPrompt`

- Drop the verbose step-by-step wall; replace with a compact ordered list.
- Add the new `CLARIFICATIONS NEEDED` block (Feature C).
- Add a `STUDY SNAPSHOT` block: for `/paper-write`, the top-3 OpenAlex
  findings per claim-topic with TLDR + DOI, so the LLM writes grounded prose
  without re-searching.
- Make the marker contract explicit and testable: "every citation MUST be
  exactly `[N](<doi:10.xxxx>)`; if unsure, write `[ASK: ...]` and STOP — do
  not guess a DOI."

### 6.2 New domain-aware instructions

- For biology (active domain): "prefer Europe PMC / OpenAlex candidates with
  matching MeSH terms; a paper without an abstract is low-confidence — ask."
- Verification is mandatory, not optional: "For every `[N]`, call
  `verify_citation(claim, doi)`. If it returns UNCLEAR or REFUTES, replace
  the citation or hedge the claim."

### 6.3 Anti-hallucination guard

The prompt now states the one rule that matters most: **the DOI must come
from a `find_citation` / `search_literature` result you can see above. If
you cannot point to a retrieved candidate, the citation does not exist —
emit `[CITATION NEEDED]` instead.** This is reinforced by the clarify step
(§5): the resolver only ever offers real candidates.

---

## 7. CLI surface

```
paper-lab-finalize paper.md              # static (default, submission-safe)
paper-lab-finalize paper.md --live       # Word-native citation fields
paper-lab-finalize paper.md --static     # explicit static
paper-lab-finalize paper.md --verify-all # (existing) re-fetch all DOIs
paper-lab-finalize paper.md --no-cache   # (existing)
paper-lab-word paper.md --live          # alias, generates only the .docx
```

Intent detection (Italian + English) added to `buildCiteMarkPrompt`:
- "campi live" / "citazioni native" / "renumber" / "auto-number" → `--live`
- "versione finale" / "submission" / "final build" → `--static`

---

## 8. Test plan

- `word-live-builder.test.ts` — build a minimal 1-citation docx; assert
  parts exist, XML well-formed, `[Content_Types].xml` declares customXml,
  CITATION field present, BIBLIOGRAPHY SDT present. Golden-file compare
  `customXml/item1.xml` against `data/word-citation-reference.docx`.
- `openalex.test.ts` / `europepmc.test.ts` — mocked fetch; assert
  `Finding` normalisation (abstract reconstruction, MeSH, OA URL).
- `clarify.test.ts` — feed synthetic `Finding[]`; assert RESOLVED vs
  AMBIGUOUS vs MISSING classification; assert `formatClarifyPrompt` shape.
- `finalize-live.test.ts` — end-to-end: `paper.md` → `--live` docx; assert
  no crash, fallback-to-static on injected bad XML.
- `audit-regressions.test.ts` — extend with `LIVE-1` (marker `⟦N⟧` survives
  bun-docx round-trip) and keep `HIGH-3` (malformed DOI, already green).
- All existing tests stay green (the `static` path is untouched).

---

## 9. Versioning, migration, risk

- **Version**: `0.6.5` → `0.7.0`. Big minor bump because the .docx format
  gains a new mode and new modules ship. `package-lock.json` refreshed
  (currently stale at 0.6.2).
- **Backward compat**: default stays `--static`; nothing breaks for existing
  users. `--live` is opt-in.
- **Risks**:
  1. Word "repair" prompt if the CustomXML/`[Content_Types]` plumbing is
     wrong → mitigated by the §3.8 golden-file test + Step 0 reference capture.
  2. bun-docx may escape/alter the `⟦N⟧` token → tested in `LIVE-1`; if it
     does, switch to a run-anchoring strategy (insert a bookmark via bun-docx
     if supported, else build the whole docx from XML — bigger but bounded).
  3. OpenAlex/Europe PMC rate limits (no key) → polite `mailto` + 1 req/sec
     cap; cache in the sidecar.
  4. The `b:` lossy mapping silently drops fields → converter warns and
     logs every dropped field to `clarifications.json`.

---

## 10. Implementation phases (milestones)

Each phase is independently shippable as a point release on the 0.7 branch:

- **M0.5 — Manual validation matrix in Word** — user runs IEEE-style
  insert + delete + F9 matrix in real Word, commits before/after .docx
  + screenshots to `data/word-citation-validation/`. **No code.** Required
  before M4 can claim the renumber feature works. Live-validated proof
  that the OOXML form from Step 0 actually produces the runtime behaviour.
- **M1 — Source-finders (Feature B)** — `openalex.ts`, `europepmc.ts`, new
  `Finding` type, `resolveCitation` rewrite, `search_literature`/`get_abstract`
  tools, mocked tests. Ships as `0.7.0-alpha.1`. Lowest risk, highest
  immediate value (better info for the AI now).
- **M2 — Clarify UX (Feature C)** — `clarify.ts`, `CLARIFICATIONS NEEDED`
  block, `[ASK:...]` marker, `clarifications.json`. Ships as `0.7.0-alpha.2`.
- **M3 — Prompt improvements (Feature D)** — tighter `buildCiteMarkPrompt`,
  mandatory verification, anti-hallucination guard, domain-aware study
  snapshot. `0.7.0-alpha.3`.
- **M4 — Word-live builder (Feature A)** — (Step 0 already done;
  M0.5 validates the runtime form.) `word-live-builder.ts` post-processor,
  `--live` CLI, golden-file + e2e tests, fallback to static on failure.
  Ships as `0.7.0`. Highest risk, saved for last so the earlier features
  already de-risk it (better sources → better sources.xml; clarify →
  cleaner tag/GUID discipline; M0.5 → confirmed behaviour target).
- **M5 — Hardening + release** — refresh `package-lock.json`, CHANGELOG,
  README "live citations" section, `npm publish` (prepack without audit per
  v0.6.4 lesson), tag `v0.7.0`.

---

## 11. Open questions for the user (decide before M1)

1. **Word reference capture (Step 0)**: ✅ DONE 2026-07-28. User posted
   `data/word citation reference.docx` (now renamed to
   `data/word-citation-reference.docx`); captured to
   `data/word-reference-xml/`. What is NOT done yet is the M0.5 manual
   validation matrix (insert 2 IEEE citations, delete one, F9, verify
   renumbering); see §3.0.
2. **Citation style**: ✅ IEEE-only fully supported in v0.7.0; Vancouver
   marker exists in `config.ts` but refuses to build (per audit MED-4).
   Future major may bundle a Vancouver XSL — see §3.10.
3. **`ask_user` tool**: ✅ real pausing tool (not synchronous block).
   Implemented in M2.
4. **New dependency**: `adm-zip` will be added in M4 (when the post-processor
   ships). `fast-xml-parser` is optional — only added if xmllint-style
   validation proves too painful in CI. Confirmation at M4 start.
