# pi-paper-lab

A [pi](https://github.com/earendil-works/pi-coding-agent) extension for writing scientific papers in any biology field. Anti-AI rewrite, Vancouver citations, `.docx` output.

v0.7.5 adds **Word-native auto-renumbering** (`--live`): the `.docx` gets live CITATION fields that renumber when you edit in Word (`Ctrl+A, F9`). The BIBLIOGRAPHY field populates from the source list.

**v0.7.6**: live is the **default**. Citations render as superscript `[N]` once the bundled `IEEE2006SuperscriptOfficeOnline.xsl` is installed (one-time, with consent: `paper-lab-finalize --install-style file.md`). The BIBLIOGRAPHY field also caches the rendered list, so non-Word apps still show a complete bibliography. Pass `--no-live`/`--static` for a plain `<sup>[N]</sup>` + text References section (no Word fields).

> **On auto-renumber:** Word never renumbers citation fields automatically when you delete one — that requires a plugin (Zotero/Mendeley intercept edits). After deleting a `[N]` in the text, run `Ctrl+A` → `F9` (or the ribbon *Update Citations & Bibliography*) to renumber. This is a Word engine limit, not fixable from a `.docx`.

Reads and writes `.docx` via the [bun-docx](https://www.npmjs.com/package/bun-docx) CLI.

See [CHANGELOG.md](./CHANGELOG.md) for version history.

## Install

Requires [pi](https://github.com/earendil-works/pi-coding-agent) ≥ 0.6.

**macOS / Linux / WSL:**

```bash
pi install github:Aspis0/pi-paper-lab
```

This clones the repo to `~/.pi/agent/extensions/pi-paper-lab/` and loads it on next pi start. The bun-docx CLI is a peer dependency:

```bash
npm install -g bun-docx
```

**Windows (Git Bash):**

Download `docx.exe` from the [bun-docx releases](https://github.com/SFETNI/bun-docx/releases) and put it in `~/.local/bin/` so the extension can find it.

**Get a Serper API key** at https://serper.dev (2,500 free searches/month). Optional: get an [Exa](https://dashboard.exa.ai/api-keys) key for the alternative backend.

**Configure** inside pi:

```
/paper-lab
```

Interactive menu for API keys, domain selection, citation backend.

## Use

```
/paper-write "introduction section for a mouse immunology paper"
/paper-rewrite MyDraft.md "tighten the methods section"
/paper-cite MyDraft.docx "verify all citations"
```

`/paper-write` and `/paper-rewrite` start with a study phase: the LLM searches the literature and saves findings to `study-notes.md` next to the draft. The draft then cites the real papers it found.

`/paper-cite` skips the study phase. It finds citations for existing claims.

### Word-native citations

By default, the `.docx` has **Word-native citation fields** (live mode, v0.7.6 default). This means:

- The **Source Manager** shows all your citations (References → Manage Sources)
- In-text numbers renumber automatically when you add/delete citations (`Ctrl+A, F9`)
- The bibliography regenerates from the source list
- The field also caches the rendered list, so LibreOffice / Google Docs / Pages still show a complete bibliography (they can't renumber, but they display it)

To force a fully static `.docx` (no Word fields — plain `<sup>[N]</sup>` + a manual `## References` section), pass `--no-live` (alias `--static`):

```
/paper-write "topic" --static
```

The static output has `<sup>[N]</sup>` + a manual `## References` section — no Word dependency.

### Offline resolution

Once you run `paper-lab-finalize`, it writes a **sidecar file** (`paper.citations.json`) caching every resolved citation (DOI, title, formatted text). On subsequent runs, cached entries resolve instantly — no CrossRef roundtrip. Only new `[N]` markers or changed DOIs trigger fresh lookups.

## Commands

| Command | What it does |
|---|---|
| `/paper-write <description> [--output path] [--no-live\|--static]` | Generate text from a description. Default is live (Word-native citations). Pass `--no-live`/`--static` for any-editor output |
| `/paper-rewrite <file> [instructions] [--no-live\|--static]` | Rewrite anti-AI + add citations. Same live/`--no-live` flag |
| `/paper-cite <file> [--strict] [instructions]` | Add citations to existing draft. Pass `--strict` to forbid rewriting surrounding prose (citation-only mode) |
| `/paper-lab` | API keys + domain + citation backend + style |

## Domains

Domains are YAML files in `data/domains/`. The extension scans the folder at runtime. Adding a domain = creating one file, no code changes.

Built-in: `drosophila-genetics`, `mouse-mammalian`, `cancer-biology`, `c-elegans`, `neuroscience`, `general-biology`.

A YAML needs only `name:` to be valid. Example:

```yaml
name: "Zebrafish"
detect_keywords: [zebrafish, "Danio rerio", ZFIN]
species:
  first_mention: "Danio rerio"
```

## Citation styles (v0.7.5)

Three styles ship out of the box. Pass `--style <id>` to `paper-lab-finalize`
or `paper-lab-export`:

| Style | What it is | Numbered? | Example output |
|---|---|---|---|
| `ieee` (default) | IEEE 2006 | Yes — `[1]`, `[2]`, ... | `Y. Liu and P. Saavedra, "Cachexia in Drosophila", Disease Models & Mechanisms, vol. 15, no. 6, p. dmm049298, Jun 2022, doi: 10.1242/dmm.049298.` |
| `vancouver` | ISO 690 - Numerical Reference | Yes — `[1]`, `[2]`, ... | `Liu Y, Saavedra P. Cachexia in Drosophila. Disease Models & Mechanisms 2022;15:dmm049298. https://doi.org/10.1242/dmm.049298.` |
| `apa` | APA 7th edition (author-date) | No — `(Liu & Saavedra, 2022)` | `Liu, Y., & Saavedra, P. (2022). Cachexia in Drosophila. Disease Models & Mechanisms, 15(6), dmm049298.` |

Set the default style in `/paper-lab` (or by editing
`~/.pi/agent/.paper-lab-keys.json` → `citation_style`). The Word
bibliography field auto-populates with the chosen style on Ctrl+A,
F9. Word's numbering ([1], [2], …) renumbers automatically when you
add, remove, or reorder citations — the underlying b:Source list is
positional; your in-text `[N]` markers are remapped to positional
ids so the rendering stays correct.

The styles are powered by [Citestyle](https://github.com/uniweb/csl)
(pre-compiled CSL XML bundled into JavaScript modules, ~9-13KB total
per style). No runtime CSL parsing — the styles are compiled at
Uniweb's build time.

## Export bibliography to BibTeX / RIS / CSL-JSON (v0.7.5)

The `paper-lab-export` CLI dumps a paper's resolved bibliography in
the format your reference manager expects:

```bash
paper-lab-export paper.md --format bibtex > refs.bib
paper-lab-export paper.md --format ris    > refs.ris
paper-lab-export paper.md --format csljson > refs.json
paper-lab-export paper.md --format all    > everything.txt
```

Uses [Citation.js](https://github.com/citation-js/citation-js)
(`@citation-js/core` + `@citation-js/plugin-bibtex` +
`@citation-js/plugin-ris`), lazy-loaded only when invoked. Hot path
(`paper-lab-finalize`) stays Citation.js-free.

## Local reference library (v0.7.5)

`paper-lab-library` manages a per-project, gitignored directory of
CSL-JSON papers at `<projectRoot>/paper-lab-library/`. Use it for
offline citation resolution and reuse.

```bash
paper-lab-library add 10.1038/nature12373          # Add by DOI
paper-lab-library add-from-search "cachexia Drosophila"  # Search OpenAlex
paper-lab-library import refs.bib                 # Import .bib / .ris / .csl.json
paper-lab-library list                            # List all entries
paper-lab-library search "cachexia IL6"           # BM25 search (offline)
paper-lab-library export --format bibtex          # Export to BibTeX
paper-lab-library sync                            # Rebuild SQLite cache
paper-lab-library stats
```

Auto-populating the library from `/paper-cite` is **not yet implemented** — entries are added manually via the CLI or via `add-from-search`. Automatic population is planned for a future release.

The library uses [sql.js](https://github.com/sql-js/sql.js) (pure
WASM SQLite, no native binding, no `node-gyp` build) for the
optional cache. Search uses pure-TypeScript BM25 (no ML model, no
embeddings) — see `src/library/bm25.ts`.

## Citation backends

`/paper-lab` → option 6 picks:

- `auto` (default): tries CrossRef first (canonical metadata), falls back to Serper
- `serper`: Google Scholar via Serper.dev
- `exa`: Exa.ai publications index, 350M+ papers
- `both`: parallel query, merge + dedupe

v0.7.0 also adds **OpenAlex** and **Europe PMC** as primary source-finders (no key required, structured metadata + abstracts). These run automatically during the study phase to give the LLM richer context (abstracts, MeSH terms, citation counts).

## How it works

```
/paper-write "topic"
  → study_topic (search OpenAlex + Europe PMC + CrossRef, save study-notes.md)
  → write draft (grounded in study notes, anti-AI voice rules)
  → ai_detect_statistical (check for AI-tells, length-adaptive calibration)
  → find_citation per claim (batch, with disambiguation if unclear)
  → finalizeDoc [--live] → .docx with Word-native citations
```

The `--live` flag (default in v0.7.0) produces a `.docx` with:
- CustomXML source list (`customXml/item1.xml`) — Word's Source Manager sees all citations
- CITATION fields in the body — renumber on `Ctrl+A, F9`
- BIBLIOGRAPHY SDT at the end — regenerates from the source list

The `--static` flag produces `<sup>[N]</sup>` + manual `## References` section — works in any editor.

After publish to npm (see [PUBLISHING.md](./PUBLISHING.md)), anyone can install via `pi install npm:pi-paper-lab`.

## Acknowledgements

- [bun-docx](https://github.com/SFETNI/bun-docx). Markdown ↔ .docx conversion CLI used for file I/O.
- [pi](https://github.com/earendil-works/pi-coding-agent). The agent runtime this extends.
- [Serper.dev](https://serper.dev). Google Scholar API.
- [Exa](https://exa.ai). Neural academic search.
- [CrossRef](https://www.crossref.org/). DOI metadata for citation formatting.

## Platform

- macOS: works
- Windows: works (Git Bash)
- Linux: should work

## Security

`npm audit` reports **1 known HIGH vulnerability** in the dependency tree:

- `brace-expansion@≤5.0.7` (transitive via `@earendil-works/pi-coding-agent` → `minimatch`).
  - GHSA-mh99-v99m-4gvg — DoS via unbounded brace expansion causing out-of-memory crash.
  - Impact: requires a malicious input file passed to `minimatch` glob patterns. The extension does not call `minimatch` directly with user input; risk for normal use is low.
  - Status: `npm overrides` cannot fully force-rewrite this transitive copy (known npm CLI bug for nested deps, npm/cli#9659). The fix will land automatically when `@earendil-works/pi-coding-agent` updates its `minimatch` dependency.
  - `npm audit` is wired into the `prepack` script so any new HIGH vulnerability blocks the next publish.

To audit locally: `npm run audit` (or `npm audit --audit-level=high`).

## License

MIT
