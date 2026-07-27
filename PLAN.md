# pi-paper-lab v0.4 — Scientific Paper Pipeline Plan

> Source of truth for the v0.4 extension work. Everything lives inside `pi-paper-lab/`.
> Last updated: 2026-07-27

## Architecture (3 modules, single extension)

```
User input (Markdown)
        │
        ▼
┌─────────────────────────────────────────────────────────┐
│  MODULE 1: anti-AI sloppy writing (EXISTING, extend)   │
│  - Silent rewrite of AI-tells + human sloppy patterns  │
│  - Drosophila voice injection                          │
│  - Lexicon expanded (+5 papers, +150 entries)          │
│  - NEW: /bio-sloppy, claim_strength_check tool         │
│  Output: clean draft .md                               │
└─────────────────────────────────────────────────────────┘
        │
        ▼
┌─────────────────────────────────────────────────────────┐
│  MODULE 2: citations (NEW, all inside pi-paper-lab)    │
│  - /cite-mark: LLM marks claims with [CITE:topic]      │
│  - /cite-resolve: Serper Scholar + PubMed + Exa +      │
│    CrossRef → [1][2][3]                                │
│  - /cite-verify: LLM checks claim ↔ reference match    │
│  - Tools: scholar_search, crossref_lookup,             │
│    verify_citation                                     │
│  Output: draft.resolved.md + bibliography.bib          │
└─────────────────────────────────────────────────────────┘
        │
        ▼
┌─────────────────────────────────────────────────────────┐
│  MODULE 3: Word generation via bun-docx (NEW)          │
│  - /paper-to-word: Markdown → .docx                    │
│  - Vancouver style: [N] → superscript + footnotes      │
│  - Bibliography section at end                         │
│  - /paper-check: re-read .docx, verify citations       │
│  Output: paper.docx                                    │
└─────────────────────────────────────────────────────────┘
```

## File layout (everything inside pi-paper-lab/)

```
pi-paper-lab/
├── extensions/
│   └── index.ts                  # single entry, registers ALL tools/commands
├── src/
│   ├── anti-ai-lexicon.ts        # MODULE 1 (existing, extended)
│   ├── claim-strength.ts         # MODULE 1 (NEW)
│   ├── citations.ts              # MODULE 2 (NEW)
│   ├── serper-scholar.ts         # MODULE 2 (NEW)
│   ├── crossref.ts               # MODULE 2 (NEW)
│   ├── cite-verify.ts            # MODULE 2 (NEW)
│   ├── word-builder.ts           # MODULE 3 (NEW)
│   ├── footnote-injector.ts      # MODULE 3 (NEW)
│   ├── system-injection.ts       # (existing)
│   ├── commands.ts               # (existing, extended)
│   ├── tools.ts                  # (existing, extended)
│   └── imrad.ts                  # (existing)
├── data/
│   └── drosophila-lexicon.yaml   # extended (+150 entries)
└── tests/
```

## Phase 1 — Module 1: anti-AI improvement

1. Read 5 additional Drosophila papers (eLife/Genetics 2020-2024, focus on clean prose)
   - 2 neurogenetics (Bellen lab, Bhatt lab style)
   - 2 CRISPR/tool papers (Port lab, Bullock lab style)
   - 1 methodological review (Jennings 2011 extended)
2. Extract +150 lexicon entries:
   - New AI-tells specific to junior scientists (not just LLM)
   - Preferred verbs more granular per section
   - Numeric conventions (n= vs N=, SD vs SEM)
   - Antibody/stock/genotype reporting patterns
3. Implement `/bio-sloppy <file.md>` — finds human sloppy patterns
4. Implement `claim_strength_check(text)` LLM-callable tool
5. Regression tests
6. **HOSTILE REVIEW** (deepseek-v4-pro)

## Phase 2 — Module 2: citations

7. Implement `serper-scholar.ts` — Serper Scholar API client (env: `SERPER_API_KEY`)
8. Implement `crossref.ts` — CrossRef REST API for DOI metadata
9. Implement `citations.ts` — orchestrator:
   - mark claims → [CITE:topic]
   - resolve [CITE:topic] → [1][2][3] (priority: PubMed > Serper > Exa > CrossRef)
   - generate bibliography.bib + bibliography.md
10. Implement `cite-verify.ts` — LLM check claim ↔ abstract match
11. Register commands: `/cite-mark`, `/cite-resolve`, `/cite-verify`
12. Register tools: `scholar_search`, `crossref_lookup`, `verify_citation`
13. End-to-end test with draft fixture
14. **HOSTILE REVIEW** (oracle for scientific accuracy, deepseek for code)

## Phase 3 — Module 3: Word generation

15. Implement `word-builder.ts` — calls `docx create --from draft.md`
16. Implement `footnote-injector.ts` — calls `docx footnotes add` per citation
17. Implement markdown preprocessor: `[N]` → `^[N]^` (superscript)
18. Register `/paper-to-word <draft.md>` command (Vancouver style)
19. Register `/paper-check <paper.docx>` command (re-read, verify)
20. End-to-end: draft.md → paper.docx
21. **HOSTILE REVIEW** (deepseek for code, manual for output quality)

## Phase 4 — Integration

22. Full pipeline test: bozza → anti-AI → cite-mark → cite-resolve → cite-verify → word
23. Update README + memory
24. Final hostile review

## Citation style: Vancouver

- In-text: superscript numbers `^[1]^`
- Footnotes: full citation at bottom of page
- Bibliography: cumulative "References" section at end
- Priority for source selection: primary research > review > preprint

## API keys (env vars, NEVER in code)

```bash
SERPER_API_KEY=...        # user-provided, for scholar_search
NCBI_API_KEY=...          # optional, for PubMed rate limit
# Exa: already configured in pi (web_search tool)
```

## Decisions locked

- **Single extension**: everything inside pi-paper-lab, no separate packages
- **Citation style**: Vancouver (numeric superscript + footnotes + bibliography)
- **Hostile review at every step**: deepseek-v4-pro for code, oracle for science
- **Test draft**: user has one, will provide at end
- **Order**: Module 1 → 2 → 3 (logical dependency chain)
