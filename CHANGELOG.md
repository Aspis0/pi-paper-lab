# Changelog

## v0.6.3.2 — `--verify-all` + inline-citation preservation

### Fixes the user explicitly asked for

- **`/paper-cite` now sees existing citations.** Previously the prompt only
  surfaced the sidecar cache. Citations the LLM had already emitted in the
  prose as `[N](<doi:...>)` markers were silently ignored, and the LLM
  would re-mark them with `[CITE:topic]` — producing duplicates and breaking
  the bibliography numbering.

  The prompt now emits a `CITATIONS ALREADY PRESENT` block that lists
  every inline `[N]` AND every cached `[N]` (inline takes priority; matching
  DOIs are labelled `(in cache)`). The LLM skips these and only marks
  genuinely new claims. The block also reports the highest `[N]` in use
  so the LLM numbers new citations correctly.

- **Bare `[N]` markers** (no inline DOI) are now scanned separately and
  surfaced as `(bare marker in prose — no DOI resolved yet)`. The prompt
  explicitly tells the LLM to call `find_citation` to backfill them.

- **`--verify-all` flag.** Re-fetches every inline DOI from CrossRef even
  when the sidecar has matching metadata. Use after retraction notices,
  errata, or whenever the user wants to confirm every reference.

  The CLI flag is on `paper-lab-finalize` (e.g. `paper-lab-finalize file.md --verify-all`).
  The `/paper-cite` prompt also recognises the intent from user
  instructions ("controlla TUTTE LE CITAZIONI", "verify all citations",
  "ricontrolla tutto") and propagates the flag via the embedded finalize
  command.

### Bug found during the v0.6.3.2 implementation

- **TDZ (temporal-dead-zone) error** in the prompt builder: `bareNumbers`
  was used inside the cache-block construction before its `const` declaration.
  The whole block-building code was wrapped in a silent `try/catch`, so the
  block was never emitted and the user got a broken prompt. Fixed by
  hoisting the bare-number scan and replacing the silent catch with a
  `console.error` that future regressions will surface.

### Audit fixes from the v0.6.3.2 hostile review

- **MED-1 (prompt clarity)**: bare-marker entries in `CITATIONS ALREADY
  PRESENT` now include "you MUST call find_citation to backfill them" so
  the LLM knows to fill them in.
- **LOW-1 (sidecar honesty)**: sidecar `citationBackend` is now read from
  the user's config (`serper | exa | both | auto`), defaulting to
  `crossref` only when unset. Previously hardcoded regardless of config.

### Known limitations (documented; not bugs)

- `--verify-all` only covers inline `[N](<doi:...>)` markers. Bare `[N]`
  markers with no DOI are still served from the sidecar cache. Use
  `/paper-cite` to re-resolve them. (HIGH-1 in the audit.)

## v0.6.3 — citation sidecar cache + audit fixes

### Sidecar cache (the main feature)

Every successful `finalizeDoc` writes a sidecar file
`<draft>.citations.json` mapping each `[N]` to its resolved
`{doi, vancouver}` text. On the next run (after prose edits, paragraph
additions, or re-running `/paper-cite` over an existing file), the sidecar
is loaded *before* CrossRef is called, so:

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

### Bug fixes from the v0.6.3 hostile audit

- **CRIT-1** — nested `<sup><sup>[N]</sup></sup>` from re-running on a file
  that had resolved-DOI markers. Fixed by negative lookbehind in the
  bare-marker regex (`(?<!<sup>)\[(\d+)\](?!\()`).
- **CRIT-2** — ghost references in bibliography from citations the user
  had removed from the prose. Fixed by pruning the sidecar write to only
  the citation numbers actually present in the processed text
  (`<sup>[N]</sup>` scan).
- **HIGH-1** — stale-cache DOI override. When the user changed the DOI
  for an existing `[N]` in the prose, the cache silently won. Fixed by
  DOI comparison in the inline-marker scan: if `cached.doi !== newDoi`,
  evict and re-fetch via CrossRef.
- **HIGH-2** — `--no-cache` test was a tautology (deleted sidecar first,
  then verified `--no-cache` worked against an empty cache). New test
  plants a deliberately wrong cached DOI and verifies both branches
  (cache-honored vs `--no-cache` override).
- **MED-1** — removed unused `realpathSync` imports from `bin/finalize.mjs`
  and `tests/finalize-cli.test.ts`.
- **MED-2** — `--help` after the filename was silently ignored. Fixed in
  the argv parser so the flag is honored anywhere in the command line.

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

## v0.6.1 and earlier

See `git log v0.6.1` for prior versions.
