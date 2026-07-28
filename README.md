# pi-paper-lab

A [pi](https://github.com/earendil-works/pi-coding-agent) extension for writing scientific papers in any biology field. Anti-AI rewrite, Vancouver citations, `.docx` output.

Reads and writes `.docx` via the [bun-docx](https://www.npmjs.com/package/bun-docx) CLI (thanks to the bun-docx project for the file conversion backend).

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
/paper-write "intro on micro-CT imaging in Drosophila cancer cachexia"
/paper-rewrite MyDraft.md "tighten the methods section"
/paper-cite MyDraft.docx "prefer Fearon 2011, Holland 2022"
```

`/paper-write` and `/paper-rewrite` start with a study phase: the LLM searches the literature and saves findings to `study-notes.md` next to the draft. The draft then cites the real papers it found.

`/paper-cite` skips the study phase. It finds citations for existing claims.

## Commands

| Command | What it does |
|---|---|
| `/paper-write <description> [--output path]` | Generate text from a description |
| `/paper-rewrite <file> [instructions]` | Rewrite anti-AI + add citations |
| `/paper-cite <file> [--strict] [instructions]` | Add citations to existing draft. Pass `--strict` to forbid rewriting surrounding prose (citation-only mode) |
| `/paper-lab` | API keys + domain + citation backend |

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

## Citation backends

`/paper-lab` → option 6 picks:

- `serper` (default): Google Scholar via Serper.dev
- `exa`: Exa.ai publications index, 350M+ papers
- `both`: parallel query, merge + dedupe
- `auto`: try Exa first, fall back to Serper on failure or empty results

## How it works

```
/paper-write "topic"
  → study_topic (search literature, save study-notes.md)
  → write draft (grounded in study notes)
  → ai_detect_statistical (check for AI-tells)
  → find_citation per claim (batch)
  → finalizeDoc → .docx with Vancouver references
```

After publish to npm (see [PUBLISHING.md](./PUBLISHING.md)), anyone can install via `pi install npm:pi-paper-lab`.

## Acknowledgements

- [bun-docx](https://github.com/SFETNI/bun-docx). Markdown ↔ .docx conversion CLI used for file I/O.
- [pi](https://github.com/earendil-works/pi-coding-agent). The agent runtime this extends.
- [Serper.dev](https://serper.dev). Google Scholar API.
- [Exa](https://exa.ai). Neural academic search.
- [CrossRef](https://www.crossref.org/). DOI metadata for Vancouver citation formatting.

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