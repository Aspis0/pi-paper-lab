# PLAN: Study Phase for /paper-write and /paper-rewrite

> **Goal**: Before writing or rewriting, the LLM does a "study phase" — searches the literature, reads abstracts/snippets, synthesizes notes — THEN writes. Like "deep research" mode in Perplexity/Claude/Gemini, applied to scientific paper writing.
>
> **Scope**: `/paper-write` and `/paper-rewrite` only. `/paper-cite` does NOT need a study phase (text already exists, citations are found per-claim).
>
> **Approach**: Prompt-only — the LLM uses its existing tools (`find_citation`, `scholar_search`, `web_search`, `fetch_content`) for the study. No new code.

---

## Why a study phase?

Current state: `/paper-write "micro-CT Drosophila cancer cachexia"` → LLM writes immediately based on training data. Risks:
- Hallucinated details (wrong methods, wrong numbers, wrong citations)
- Generic voice (doesn't sound like the specific field's literature)
- Missed key concepts the field cares about

With study phase: LLM first searches the literature (5-10 papers), extracts:
- What's the state of the art? Key findings?
- What methods are standard in this literature?
- How do papers in this field structure themselves? Voice?
- What terminology is field-specific?
- Candidate references with DOIs

THEN writes — grounded in real literature, not just training data.

---

## Why prompt-only (no new tool)

Initially the plan proposed a new `study_topic` tool that bundled Serper Scholar + CrossRef. After audit feedback, we simplified:

**The LLM already has the tools it needs**:
- `find_citation(topic)` — Serper Scholar + CrossRef (existing, working)
- `scholar_search(query)` — direct Serper Scholar (existing)
- `crossref_lookup(doi)` — DOI metadata + abstract (existing)
- `web_search(query)` — web search (Exa / Brave / etc.) — **free, already integrated**
- `fetch_content(url)` — fetch any URL content

**No new code needed**. The pipeline prompt instructs the LLM to call these tools before writing. The LLM synthesizes the notes itself (LLMs do synthesis better than code anyway).

This approach also means:
- Study phase is **opt-in by prompt** — the LLM might skip it, but the prompt strongly encourages it
- Study phase uses **whatever tool the LLM thinks best** — `find_citation` for academic, `web_search` for broader context, `fetch_content` for full abstracts
- **Zero new API costs** — uses existing Serper + web_search
- **Domain auto-detection** still happens (the pipeline resolves domain before sending prompt)

---

## Architecture

### Flow

```
/paper-write "<description>"
  ↓
pipelineWrite sends follow-up message with:
  STEP 0 — STUDY (call find_citation/web_search, synthesize notes)
  STEP 1 — WRITE (using notes + system prompt voice)
  STEP 2 — AI CHECK
  STEP 3 — CITE
  STEP 4 — FINALIZE
  STEP 5 — REPORT
```

Same for `/paper-rewrite`, but STEP 0 is lighter (text already exists; just refresh context if topic is unclear).

### What the LLM does in the study phase

Given a topic like "micro-CT imaging in Drosophila cancer cachexia":

1. **Search** (3-5 parallel calls to `find_citation` or `web_search`):
   - "Drosophila micro-CT cancer cachexia"
   - "whole-body imaging tumor cachexia"
   - "micro-computed tomography insect"
   - "Yki gut tumor Drosophila"
   - "high-resolution imaging tumor progression fly"

2. **Read** the top 5-10 results (snippets from Serper Scholar or web_search)

3. **Optionally fetch full content** via `fetch_content` for the most relevant papers' abstract pages

4. **Synthesize** into `study-notes.md` with structure:
   ```markdown
   # Study notes: <topic>

   ## Topic summary
   <2-3 sentences: what is this paper about, why does it matter>

   ## Key concepts
   - <term 1>: <definition specific to this field>
   - <term 2>: <definition>
   ...

   ## Standard methods in this literature
   - <method 1>: <how it's typically done>
   ...

   ## Voice / structure observations
   - Papers in this field typically <observation>
   - Common section structure: <observation>
   ...

   ## Candidate references (numbered, with DOIs)
   1. Author et al. (Year). Title. Journal. doi:10.xxxx
   2. ...

   ## Specific findings to ground the draft (tagged with ref numbers)
   - [ref 1] <Finding 1>: <what the literature says>
   - [ref 2] <Finding 2>: ...
   ```

5. **Write** the draft using the study notes + system prompt voice rules.

### Storage location

Study notes saved next to the draft:
- `/paper-write <description>` → `~/Desktop/paper-write-output.study-notes.md`
- `/paper-rewrite <file>` → `<basename_without_ext>.study-notes.md`
  - If user passed `paper.docx`, notes go to `paper.study-notes.md` (next to the .docx, not appended to its name)
  - The pipeline already converts .docx → .md internally

### Why save to file?

- The LLM can `read` the file to reference it during writing (long contexts)
- Notes persist across turns
- User can inspect/edit notes before final write
- Auditable artifact

---

## Updated prompt templates

### `/paper-write` prompt

```
Paper draft: <description>

STEP 0 — STUDY (before writing anything):
  a) Call find_citation 3-5 times IN PARALLEL with different query variants:
     "<description>" (as-is)
     <reversed word order of description>
     <description with synonyms (imaging↔characterization, etc.)>
     <narrower scope>
     "<description> review"
     Use the queries that best capture this topic.
  b) Optionally: call web_search or fetch_content for broader context or
     to get full abstracts (not just snippets).
  c) If all searches fail: note this in study-notes.md, mark uncertain claims
     with [CITATION NEEDED], proceed to STEP 1 anyway (NEVER block).
  d) Write study-notes.md to <output_dir>/paper-write-output.study-notes.md:
     # Study notes: <topic>
     ## Topic summary (2-3 sentences)
     ## Key concepts (5-10 terms specific to this field)
     ## Standard methods in this literature
     ## Voice / structure observations
     ## Candidate references (numbered, with DOIs)
     ## Specific findings (each tagged [ref N] from candidate list)
  e) Report the number of papers reviewed.

STEP 1 — WRITE: Use study-notes.md + system prompt voice rules.
  - Ground every claim in study notes (cite paper N where N is in candidate list)
  - Use the DOIs from study-notes.md, NOT invented ones
  - Match voice/style observations
  - Save draft to <output_dir>/paper-write-output.md

STEP 2 — AI CHECK: Call ai_detect_statistical on your draft.
  If score >40%, rewrite flagged sentences. Re-test. Max 3 rounds.

STEP 3 — CITE: For each [CITE:topic] in the draft, call find_citation.
  Assign [N](<doi:10.xxxx>) — ALWAYS use angle brackets (even for DOIs with parens).
  Update the draft.

STEP 4 — FINALIZE: Run this bash command:
  node --experimental-strip-types -e "import('<root>/src/pipeline.ts').then(({finalizeDoc}) => { const r = finalizeDoc('<output>'); if (r.error) console.log('Error:', r.error); else console.log('Done! Word:', r.docxPath, '| References:', r.bibliographyCount); }).catch(err => console.log('Error:', err.message));"

STEP 5 — REPORT: Tell the user:
  - Number of papers studied
  - Path to study-notes.md
  - Path to .docx
  Do NOT read the .docx (binary).
```

IMPORTANT: STEP 0 (study) requires waiting for tool calls to return.
Complete STEPs 1-5 in the SAME turn after receiving study results.

### `/paper-rewrite` prompt (lighter study)

```
Draft to rewrite: <file>

STEP 0 — CONTEXT REFRESH (optional, only if topic is unclear):
  If the draft's topic is ambiguous or you need to ground claims in
  recent literature, call find_citation 1-3 times.
  Most rewrites skip this — proceed to STEP 1.

STEP 1 — REWRITE: Rewrite the draft for human scientific voice
  (follow your domain's voice rules from the system prompt).
  If you did STEP 0, use study-notes.md as additional context.
  ${rewriteInstructions ? "Extra instructions: " + rewriteInstructions : ""}

STEP 2 — AI CHECK: Call ai_detect_statistical.
  If score >40%, rewrite flagged sentences. Re-test. Max 3 rounds.

STEP 3 — CITE: For each [CITE:topic] in the rewritten draft, call find_citation.
  Assign [N](<doi:10.xxxx>) — ALWAYS use angle brackets.

STEP 4 — FINALIZE: Run finalizeDoc via bash (one command).

STEP 5 — REPORT: Tell the user the .docx path.
```

---

## Implementation (simpler than original plan)

### Step 1: Update `pipelineWrite` prompt

**File**: `src/pipeline.ts` — `pipelineWrite` function

Add STEP 0 (STUDY) with explicit instructions to call `find_citation` and optionally `web_search`/`fetch_content`.

### Step 2: Update `pipelineRewrite` prompt

**File**: `src/pipeline.ts` — `buildCiteMarkPrompt` when `includeRewrite=true`

Add STEP 0 (CONTEXT REFRESH, optional).

### Step 3: Add `study-notes.md` storage convention

**File**: `src/pipeline.ts` — `pipelineWrite` and `pipelineRewrite`

Save notes next to the output file:
- `pipelineWrite`: `~/Desktop/paper-write-output.study-notes.md`
- `pipelineRewrite`: `<basename_without_ext>.study-notes.md` (next to the original file)

### Step 4: Update README

**File**: `README.md`

Add a "Study phase" section explaining the new behavior.

---

## Execution order

```
Step 1: pipelineWrite prompt (add STEP 0)
Step 2: pipelineRewrite prompt (add optional STEP 0)
Step 3: study-notes.md storage convention
Step 4: README update
```

Each step gates the next. Total: ~4 file edits, no new code files.

## Non-negotiable rules

1. Study phase is **prompt-instructed** — LLM may skip, but the prompt strongly recommends it
2. Study phase **NEVER blocks the pipeline** — if all searches fail, LLM proceeds with [CITATION NEEDED] markers
3. `/paper-cite` does NOT get a study phase (citations already come from inline claims)
4. Study phase uses **existing tools** (`find_citation`, `scholar_search`, `web_search`, `fetch_content`) — no new APIs
5. Study notes saved to disk in a predictable location, adjacent to the draft
6. Study phase never reads the .docx (binary)
7. `/paper-rewrite` study phase is **lighter** (text exists; just refresh if ambiguous)

## Future enhancements (v0.7+)

- Iterative refinement: if study-notes.md has < 3 findings, re-search with adjusted queries
- User confirmation of search plan before executing (Perplexity pattern)
- Multi-language support
- ArXiv full-text search for preprints
- Semantic Scholar + OpenAlex as additional sources
- Configurable study depth (`/paper-lab` option)