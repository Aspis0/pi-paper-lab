# pi-paper-lab

## v0.6.3 — citation sidecar cache

Editing a paper just became idempotent. Every successful `finalizeDoc`
writes a sidecar file `<draft>.citations.json` mapping each `[N]` to its
resolved `{doi, vancouver}` text. On the next run (after you've edited
prose, added a paragraph, or even re-ran `/paper-cite` over your own
file), the sidecar is loaded *before* CrossRef is called, so:

- Bare `[N]` markers from your edits re-materialize into a full bibliography
  with zero re-resolution cost.
- `/paper-cite` no longer wastes tokens re-finding DOIs for citations that
  already exist in the sidecar — it surfaces the cache directly in the
  prompt so the LLM can reuse IDs verbatim.
- `--no-cache` flag forces a fresh CrossRef pass (useful after manual
  sidecar edits or when refreshing a retracted paper).

Schema (v1):

```jsonc
{
  "schemaVersion": 1,
  "sourceMarkdown": ".../paper.md",
  "lastResolvedAt": "2026-07-28T10:00:00.000Z",
  "citationBackend": "crossref",
  "citations": {
    "23": {
      "doi": "10.1038/s41571-023-00734-5",
      "vancouver": "Argilés JM, ... doi:10.1038/s41571-023-00734-5"
    }
  }
}
```

Malformed/missing sidecars fail open: `finalizeDoc` falls back to direct
CrossRef lookup as if there were no cache.

## v0.6.2 — finalize-CLI fix

The v0.6.1 LLM-emitted finalize command
(`node --experimental-strip-types -e "import('.../pipeline.ts')"`) **fails** on
Windows when the package is installed under `node_modules/` because:

1. ESM `import()` rejects `C:/...` absolute Windows paths (needs a `file://` URL).
2. Node refuses to type-strip `.ts` files inside `node_modules/` (hard ERR throw).

v0.6.2 ships a standalone CLI in `bin/finalize.mjs` (plain JS, uses [jiti])
that works from any location and on all OSes. The LLM prompt now instructs
the model to invoke it as `paper-lab-finalize <path>`:

```bash
# Self-discovering: PATH lookup → installed package → npx fallback
if command -v paper-lab-finalize >/dev/null 2>&1; then
  paper-lab-finalize paper.md
elif [ -f "$HOME/.pi/agent/npm/node_modules/pi-paper-lab/bin/finalize.mjs" ]; then
  node "$HOME/.pi/agent/npm/node_modules/pi-paper-lab/bin/finalize.mjs" paper.md
else
  npx -y paper-lab-finalize paper.md
fi
```

You can also run it directly: `node <pkg>/bin/finalize.mjs paper.md`.


A [pi](https://github.com/earendil-works/pi-coding-agent) extension for writing scientific papers in any biology field. Anti-AI rewrite, Vancouver citations, `.docx` output.

Reads and writes `.docx` via the [bun-docx](https://www.npmjs.com/package/bun-docx) CLI (thanks to the bun-docx project for the file conversion backend).

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