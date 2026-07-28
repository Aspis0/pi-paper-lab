# Changelog

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
