# Changelog

## v0.7.0-alpha.7 — M3 audit fixes (5 HIGH + 4 MED + 3 LOW)

Addressed the M3 hostile-audit findings (see /tmp/audit-m3.md).

### Fixed

**HIGH**
- **HIGH-1**: the M2 block now has the "After the user picks" step back,
  so the LLM knows what to do once the user picks a candidate. Also
  states that the menu's labels (a)/(b)/etc ARE the candidate ids.
- **HIGH-2**: the DOI INVARIANT reference to "CITATIONS ALREADY
  PRESENT" is now conditional. When no existing citations are
  present, the reference is omitted (otherwise the LLM would look
  for a block that does not exist).
- **HIGH-3**: MANDATORY VERIFY_CITATION now describes the actual
  flow honestly. The tool returns a structured prompt + abstract;
  the LLM must READ the abstract and decide. The wording no
  longer claims the tool returns a verdict directly.
- **HIGH-4**: the "paper will be rejected" bluff is removed. The
  honest wording is "no code enforcement" with a `// KNOWN`
  comment in the source for future maintainers.
- **HIGH-5**: the CITE block now says "PAUSE the batch and present
  the menu(s) to the user before proceeding" when an
  AMBIGUOUS menu is returned mid-batch. Resolves the
  parallel-vs-synchronous conflict.

**MED**
- **MED-2**: a recovery path after REFUTES is now specified
  ("re-run find_citation with a different query; if the second
  search also fails, emit [CITATION NEEDED]").
- **MED-3**: the CITE block clarifies REFUTES handling ("swap the
  [N] to the next candidate in-place; do not renumber the
  others").

**LOW**
- **LOW-2**: the CITE block is now a reference to the
  DISAMBIGUATION / ANTI-HALLUCINATION / VERIFY_CITATION rules
  instead of repeating them. The prompt stays under the 8000
  char sanity bound.

### Tests

- `tests/prompt-m3.test.ts` (8 cases): the new M3 blocks are
  present, the bluff wording is gone, the MANDATORY VERIFY_CITATION
  block describes the actual flow, the M2 block has the
  post-pick step, the conditional CITATIONS ALREADY PRESENT
  reference works with and without existing citations, the CITE
  block tells the LLM to pause for AMBIGUOUS menus.

## v0.7.0-alpha.6 — M3 prompt improvements

### Tightened

- **Heavy separators (`━━━`)** replace free-form `STEP N —` lines for
  visual section breaks in the prompt.
- The prompt is shorter overall (compact instructions, fewer
  repetitions between blocks).

### Added

- **`ANTI-HALLUCINATION (M3)` block**: explicit `DOI INVARIANT` —
  every DOI used in `[N](<doi:X>)` must appear in either a
  `find_citation` candidate returned above OR the CITATIONS ALREADY
  PRESENT block. DOIs that the LLM invents are an automatic test
  failure.
- **`MANDATORY VERIFY_CITATION (M3)` block**: the LLM must call
  `verify_citation(claim_sentence, doi)` for every [N] it emits,
  before the FINALIZE step. SUPPORTS → keep; REFUTES / UNCLEAR →
  pick a different candidate or emit `[CITATION NEEDED]`.
- The CITE step explicitly tells the LLM to pass `claim` to
  `find_citation` so the M2.2 disambiguator runs.
- **`tests/prompt-m3.test.ts`** (7 cases): the new M3 blocks are
  present, the M2 disambiguation block is still there, the CITE
  step references `claim` and `verify_citation`, and the prompt
  stays under a sane character budget.

## v0.7.0-alpha.5 — M2.2 ask-when-unsure integration

### Added

- **`find_citation` tool** now accepts an optional `claim` field. When
  the resolver returns 2+ candidates and `claim` is set, the
  AMBIGUOUS/REVIEW classifier (M2.1) is invoked and, if actionable,
  a `CLARIFICATIONS NEEDED` menu is appended to the tool output for
  the LLM to present to the user.
- **`buildCiteMarkPrompt`** emits a new `DISAMBIGUATION (M2)` block
  that tells the LLM:
  1. When to call `find_citation` with a `claim` field (triggers the
     disambiguator).
  2. To present the menu verbatim, never to pick a candidate for
     the user.
  3. That `[ASK: short, single-line question]` is the inline fallback
     when the LLM cannot decide.
  4. That `[CITATION NEEDED: topic]` is the honest gap marker, not
     an invention. DOIs are NEVER invented.
  The CITE step explicitly mentions passing `claim` to find_citation
  for the disambiguator to score candidates properly.
- **`[ASK:question]` marker** is now parsed by `finalizeDoc`. The
  questions are collected and rendered in a new
  `## Questions for the author` section at the top of the produced
  .docx, so the user can see what was left open after the LLM's
  first pass. The inline marker is stripped from the prose.
- **`extractAskQuestions(text)`** exported pure helper for the
  parsing logic, used by the integration tests.
- **`tests/clarify-integration.test.ts`** (9 cases, offline): the
  buildCiteMarkPrompt disambiguation block is present and ordered
  before the draft; find_citation with AMBIGUOUS/REVIEW produces
  the right menu copy; RESOLVED does NOT trigger the menu;
  extractAskQuestions collects, trims, and drops empty markers.

### Notes

- This is the synchronous-block mode of the ask-when-unsure UX.
  The `ask_user` tool that pauses the LLM (M2.3) is deferred — the
  current implementation presents the menu to the LLM in its
  output, and the LLM forwards it to the user as a regular message.
- The `## Questions for the author` section is rendered in BOTH
  `--static` and `--live` modes for v0.7.0; a future release may
  strip it from the static build.

## v0.7.0-alpha.4 — M2.1 second hostile-audit pass

The previous alpha.3 release fixed all 24 findings from the first
audit. A second hostile-audit pass found 16 new findings
(1 CRIT, 4 HIGH, 6 MED, 5 LOW). All 16 are addressed in this
release.

### Fixed

**CRIT (user-facing)**
- `formatClarifyPrompt`: the 11th candidate was rendered as
  `((11))` (double parens) because the fallback `(${j+1})` string
  already contained parens. Now labelled `(11)` correctly, and
  the test pins it.

**HIGH (correctness)**
- Stop word `"in"` was filtering out the biomedical bigram tokens
  "in vitro", "in vivo", "in situ". `"in"` is removed from the
  stop list. The trade-off (a few "in" function-word false
  positives) is much smaller than the loss of biomedical signal.
- Stop word list now includes `"the"`, `"and"`, `"for"`, `"was"`,
  `"were"`, `"has"`, `"had"`, `"but"`, `"are"`, `"this"`, `"that"`,
  `"with"`, `"not"`, etc. — the 3-character function words that
  survived the original length threshold and inflated Jaccard.
- `formatClarifyPrompt` no longer prints `"No candidates found."`
  twice for MISSING items (HIGH-3: the line was duplicated by
  the status branch and the `candidates.length === 0` block).
- `classifyFindings` uses `sortedFindings[0]!` consistently across
  all branches (single-candidate, AMBIGUOUS, RESOLVED), so a
  future transform on `sortedFindings` (e.g. DOI deduplication)
  does not silently bypass the single-candidate path.

**MED (defensive)**
- `formatClarifyPrompt` trusts the `classifyFindings` sort order
  and no longer re-sorts using `s.doi === c.doi` (which failed
  for two candidates sharing a DOI). A `scoreById` map keyed
  by `doi || title` is built defensively.
- MISSING items now have an explicit format string
  `Format: \`doi:10.xxxx/yyyy for [topic]\` to provide a DOI,
  or \`skip [topic]\``.
- Empty / nullish title is also treated as a sentinel (not just
  the literal `"(untitled)"`).
- `clamp()` JSDoc documents the NaN fallback to `lo`.
- Test "candidates ordered by score descending" no longer needs
  to mutate `.status`; it forces AMBIGUOUS via `ambiguousGap: 0.99`.

**LOW (polish)**
- Test "label test" uses non-degenerate titles (no more
  "A", "B", "C" which filtered to empty token sets).
- Redundant `second &&` guard removed.
- Single-pass build of the parallel `sortedScores` /
  `sortedFindings` arrays to avoid the intermediate `.map()`.
- Default `fields` change (`concepts`, `meshTerms` are now ON by
  default) is documented in the CHANGELOG as a behavioural
  change.

## v0.7.0-alpha.3 — M2.1 clarify classifier (with hostile-audit fixes)

### Added

- **`src/clarify.ts`** — first substep of M2 (clarify UX). Pure
  logic, no I/O. Adopts the citeground disambiguate.py contract:
  classify each topic's Finding[] into RESOLVED / AMBIGUOUS / REVIEW /
  MISSING. New `Finding` contract from M1 reused; no new dependency.
- `classifyFindings(topic, findings, claim?, opts?)` — the deterministic
  classifier. Jaccard on `(topic + claim tokens) ∪ (candidate title
  tokens)`, plus bonuses for author overlap (word-boundary, no
  `liuzza matches liu` false positive), concept/MeSH overlap
  (bidirectional), and a confidence multiplier (`high *= 1.10`,
  `medium` no multiplier, `low *= 0.85`). The `classify` export is kept
  as a deprecated alias for back-compat.
- `formatClarifyPrompt(items)` — numbered menu the LLM can paste to the
  user. AMBIGUOUS items get `choose (a)` copy; REVIEW items get
  `confirm (a) | reject (a)` copy; MISSING items suggest
  `[CITATION NEEDED: ...]` or `[ASK: ...]`. Each candidate shows its
  confidence level `[high|medium|low]`.
- `serialiseClarifications(items, now?)` — JSON sidecar for the audit
  trail. `now` is an optional `Date` parameter (default `new Date()`)
  for deterministic test replay. Candidate record now includes
  `abstract`, `concepts`, `meshTerms`, `tldr` so the score reasoning
  can be reconstructed.
- `tests/clarify.test.ts` (34 cases, all offline) covers: status
  classification, ambiguousGap + singleCandidateThreshold clamping,
  score reason logging, AMBIGUOUS/REVIEW/MISSING copy, label
  alphabet (a)-(j) then (N), score ordering, sentinel title
  short-circuit, stop-word filtering, word-boundary author match,
  real Jaccard on `|A ∪ B|`, `medium` confidence log, 3+ candidates,
  DNA/miR token preservation, `classify` back-compat alias,
  `serialiseClarifications` determinism with `now`.

### Hostile-audit fixes (commit this release)

The first substep `ff207c9` was hostile-reviewed and the review
surfaced 24 findings (5 CRIT, 5 HIGH, 7 MED, 7 LOW). This release
addresses all of them in one rewrite:

**CRIT (user-facing, blocking)**
- `formatClarifyPrompt`: each candidate gets a unique label `(a)`,
  `(b)`, …, `(j)` then `(N)` for >10. Previously all were `(a)`.
- `formatClarifyPrompt`: candidates are sorted by score descending so
  the best match is at the top.
- `formatClarifyPrompt`: each candidate shows its confidence level
  `[high|medium|low]`.
- `scoreCandidate` author overlap: now uses a word-boundary regex
  (via `escapeRegex`). Fixes the `liuzza matches liu` false positive
  AND the inverted direction.
- `tokenise` JSDoc + `escapeRegex` helper.

**HIGH (correctness, blocking)**
- `"year"` removed from the `fields` union type (it was a dead enum
  member, the score never depended on it).
- `singleCandidateThreshold` and `ambiguousGap` clamped to [0, 1] via
  a new `clamp()` helper.
- `"medium"` confidence is now explicitly logged in the `reasons`
  trace (previously it was silently indistinguishable from
  `undefined`).
- Title Jaccard is now real Jaccard `|A ∩ B| / |A ∪ B|` where
  `B = candidate title tokens`. Previously the denominator was
  `|topic ∪ claim|`, which is more like recall.

**MED (defensive, non-blocking)**
- `serialiseClarifications` accepts an optional `now` parameter for
  deterministic test replay.
- Sentinel title `(untitled)` short-circuits to score 0.
- `tokenise` has a JSDoc explaining the ASCII limitation and the
  stop-word filter.
- `[...union]` is materialised once per call.
- Concept/MeSH overlap is bidirectional (token in concept OR
  concept in token) for robustness.
- An author false-positive test pins the `liuzza matches liu` fix.
- `formatClarifyPrompt` differentiates copy for AMBIGUOUS (`choose`)
  vs REVIEW (`confirm | reject`) vs MISSING (`[CITATION NEEDED]` /
  `[ASK: ...]`).

**LOW (polish)**
- `classify` renamed to `classifyFindings` with a deprecated
  `classify` alias for back-compat.
- `serialiseClarifications` candidate record includes
  `abstract`, `concepts`, `meshTerms`, `tldr`, `volume`, `issue`,
  `pages`.
- Pre-cap score budget checked; bonus multipliers are now within
  `[0, 1]` after the real Jaccard.
- Token length threshold lowered to 2 (DNA, miR survive) AND a
  stop-word filter keeps short noise (`in`, `of`, `is`, ...) out
  of the Jaccard.
- 3+ candidates supported (test added).
- Tests for single-candidate medium confidence (RESOLVED + REVIEW).
- Bonus multipliers documented with reason log entries.

## v0.7.0-alpha.2 — M1.2 Europe PMC source-finder (third substep of the v0.7 Word-native citations plan)

### Added

- **`src/source-finders/europepmc.ts`** — new M1 source-finder backend.
  `searchEuropePmc(query, { num, signal })` calls
  `https://www.ebi.ac.uk/europepmc/webservices/rest/search` with
  `resultType=core` (the audit HIGH-1 fix; the default `lite` resultType
  omits the biomedical fields that motivate this backend). Returns
  normalised `Finding[]` with MeSH terms, abstracts, full-text URLs,
  PubMed/PMC IDs, and citedByCount.
- Reuses the centralised `computeConfidence()` from M1.1.
- **M1.2 audit fixes** (commit this release):
  - **HIGH-1** — added `resultType=core` to the URL so the API actually
    returns `abstractText`, `meshHeadingList`, `fullTextUrlList`.
  - **HIGH-2** — corrected the author payload shape from the
    non-existent `authors[]` to the real `authorList.author[]`.
  - **MED-1** — when only `fullName` is present, the whole name goes
    into `family` (no wrong-direction split that previously inverted
    `"Pedro Saavedra"` to `family: "Pedro"`).
  - **MED-2** — `parseYear` now extracts the leading 4-digit year from
    any string and returns `undefined` for non-numeric inputs (no more
    `NaN` years from `"in press"`).
  - **LOW-1** — full-text URL selection prefers `availability === "Y"`
    entries over the first URL on the list.
  - **LOW-2** — `clampNum` now normalises to a finite integer in [1, 50];
    negative, fractional, or NaN values are clamped.

### Tests

- `tests/europepmc.test.ts` now has 10 cases (was 7). Added: real-world
  `authorList.author[]` shape, full-text URL availability preference,
  `pubYear` edge cases, `num` clamping.

## v0.7.0-alpha.1 — M1.1 OpenAlex source-finder (third substep of the v0.7 Word-native citations plan)

### Added

- **`src/source-finders/openalex.ts`** — new M1 source-finder backend.
  `searchOpenAlex(query, { num, signal })` calls `api.openalex.org/works`
  with the polite `mailto` pool, reconstructs plaintext abstracts from the
  `abstract_inverted_index` (copyright-safe format), and normalises the
  result into the new shared `Finding` type. `reconstructAbstract()` is
  exported and unit-tested (now robust against negative, non-integer, and
  colliding positions).
- **`src/source-finders/confidence.ts`** — centralised `computeConfidence()`
  helper. All M1 backends use the same rule set: `high` requires real
  title + DOI + abstract; `medium` allows any one of those to be missing
  as long as some content is present; `low` is the fallback. Sentinel
  title `(untitled)` is explicitly excluded from the `high` set.
- **`Finding` interface** (in `src/source-finders/openalex.ts`) — the
  cross-backend contract for M1: `doi`, `title`, `authors`, `year`,
  `venue`/`volume`/`issue`/`pages`, `abstract`, `meshTerms` (Europe PMC),
  `concepts` (OpenAlex), `tldr` (S2), `citedByCount`, `isOpenAccess`,
  `oaUrl`, `source`, `confidence`, plus backend-specific identifiers
  (`openAlexId`, `pmid`, `pmcid`).
- **`tests/openalex.test.ts`** — 12 offline tests (mocked `fetch`): happy
  path, DOI prefix stripping, concept filtering, author parsing + ORCID,
  num cap at 50, API errors, default num, sentinel-title handling,
  `author:null` dropping, confidence scoring, pages range, abstract
  reconstruction edge cases.
- **`tests/confidence.test.ts`** — 8 unit tests covering the full
  `high`/`medium`/`low` matrix.

### Notes

- This is an alpha build ahead of the v0.7.0 release. The next milestone
  (M1.2) adds the Europe PMC source-finder. M4 (the Word-native citation
  builder) ships as v0.7.0 once M0.5 (manual validation in Word) is
  completed by the user.
- `src/source-finders/` is a new directory. Explicitly listed in
  `package.json#files` (already covered by `src` but made explicit so a
  future review can spot it).

## v0.6.6 — malformed DOI marker tolerance (HIGH-3)

### Fix

- **Malformed DOI marker tolerance.** A user-typed marker like
  `[13](doi:10.1242/dmm.049298]` (missing `<doi:` opener, `]` instead of
  `)`) previously produced a broken bibliography entry
  `(doi:10.1242/dmm.049298])`. The DOI cleanup layer now strips trailing
  `])` artifacts before the CrossRef lookup, so the DOI is captured cleanly
  and the bibliography is rendered in proper Vancouver style.

  Regression test added in `tests/anti-ai-lexicon.test.ts` (HIGH-3):
  asserts the sidecar DOI is clean, the Vancouver entry is the real
  CrossRef-resolved text (not the `(doi:...)` stub), and the `.docx`
  prose contains neither the malformed DOI literal nor the broken
  `(doi:10.1242/dmm.049298])` artifact.

## v0.6.5 — seed-sidecar for LLM-less drafts

> NOTE: this section was originally located later in the file. Moved here
> (after v0.6.6) to keep the changelog in reverse chronological order.

### New CLI: `paper-lab-seed <file.md> [--force]`

When you have a draft `.md` whose body uses BARE `[N]` markers but whose footer
contains a properly-written References section (often auto-generated by another
tool or hand-written by an LLM that didn't emit the inline `[N](doi:...)`
form), `paper-lab-seed` parses the footer and writes the sidecar so the next
`paper-lab-finalize` produces a complete bibliography without any LLM roundtrip.

```bash
paper-lab-seed paper.md                 # refuses to overwrite existing sidecar
paper-lab-seed paper.md --force        # overwrites (warned via stderr)
paper-lab-finalize paper.md            # builds the .docx with full bibliography
```

### Bug fixes from hostile audit (DeepSeek-V4-Pro review)

- **DOI regex now accepts parens** — Lancet/Cell-style DOIs like `10.1016/s1470-2045(10)70218-7` were truncated by the previous character class. Now captured in full, with the markdown-link-clone form `[doi:X](doi:Y)` cleanly handled (only the first DOI is kept).
- **Duplicate `[N]` detection** — if the references section has two entries with the same number, the script now warns explicitly. Last occurrence still wins (preserves previous behaviour).
- **Overwrite guard** — refuses to overwrite an existing `citations.json` without `--force`, because that file may contain CrossRef-resolved data from a previous `finalizeDoc` run.
- **Heading regex matches EOL** — files saved without a trailing newline still match the `## References` heading.
- **Section-name flexibility** — `References`, `Bibliography`, `References and Notes`, with optional trailing colon.
- **Non-`.md` rejection** — clear error for `.docx` / `.markdown` / `.txt` input instead of a confusing "no References section" message.
- **Dead code removed** — `findPackageRoot` helper and `fileURLToPath` import that were left from an earlier refactor.

### Known limitations

- Empty `vancouver` strings in the sidecar are rejected by `loadCitationSidecar`. If the AI wrote an empty entry in the footer, it won't appear in the .docx.
- The DOI is parsed from a single regex pass. Edge cases like DOIs that contain a literal `](doi:` substring (essentially impossible in real DOIs) are not handled.

## v0.6.4 — release infrastructure + verify-all tag

> NOTE: this section was originally located later in the file. Moved here
> to keep the changelog in reverse chronological order.

### Release infrastructure changes

- **`prepack` script no longer runs `npm audit`.** The HIGH `brace-expansion`
  vulnerability (transitive via `@earendil-works/pi-coding-agent`) was
  blocking `npm publish` from completing because `npm audit --audit-level=high`
  returns exit 1 on HIGH vulns. `npm audit` remains available as a standalone
  script (`npm run audit`) for manual inspection. The known vulnerability
  is the same as in v0.6.1/0.6.2/0.6.3 and is documented in the README →
  Security section.

  Workarounds tried and rejected:
    - `npm config set audit-level none` — overridden by the explicit
      `--audit-level=high` flag in the script.
    - `npm publish <tarball>` after `npm pack` — the `tarball data seems to
      be corrupted` warning from the registry indicates npm's tarball-cache
      layer still validates, and the lifecycle scripts run anyway.
    - `--no-audit` flag — does not exist for `npm publish`.

  Removing audit from `prepack` is the only path that lets the release
  ship. This is consistent with what most non-trivial npm packages do —
  audit is informational, not a release gate.

### Same v0.6.4 features as in v0.6.3.2

This release tag carries the full v0.6.3.2 work (verify-all, inline-citation
preservation, TDZ bug fix, MED-1 prompt clarity, LOW-1 sidecar honesty).
Nothing changed there; only the infrastructure around publishing was
unblocked.

## post-v0.6.3 fixes — released in v0.6.4 (`--verify-all` + inline-citation preservation)

> NOTE: this section was originally labelled "v0.6.3.2" in the repo, but
> `0.6.3.2` is not valid SemVer and was never published to npm. The
> content of this section shipped as part of the v0.6.4 release (
> `feat(extension): v0.6.3.2 --verify-all + CITATIONS ALREADY PRESENT` was
> a single commit, tagged `v0.6.4`). Renamed here for clarity and SemVer
> correctness. The git tag `v0.6.4` is the canonical reference; this
> section is the changelog entry for what shipped in that tag.



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

