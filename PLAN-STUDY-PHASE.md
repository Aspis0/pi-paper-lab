# PLAN: Study Phase for /paper-write and /paper-rewrite

> **Goal**: Before writing or rewriting, the LLM does a "study phase" — searches the literature, reads abstracts/snippets, synthesizes notes — THEN writes. Like "deep research" mode in Perplexity/Claude/Gemini, applied to scientific paper writing.
>
> **Scope**: `/paper-write` and `/paper-rewrite` only. `/paper-cite` does NOT need a study phase (text already exists, citations are found per-claim via `find_citation`).

---

## Why a study phase?

Current state: `/paper-write "micro-CT Drosophila cancer cachexia"` → LLM writes immediately based on training data. Risks:
- Hallucinated details (wrong methods, wrong numbers, wrong citations)
- Generic voice (doesn't sound like the specific field's literature)
- Missed key concepts the field cares about

With study phase: LLM first reads 5-10 recent papers on the topic, extracts:
- What's the state of the art? Key findings?
- What methods are standard in this literature?
- How do papers in this field structure themselves? Voice?
- What terminology is field-specific?
- Candidate references with DOIs

THEN writes — grounded in real literature, not just training data.

---

## Research: how other systems do this

From web search on AI writing assistants with research phases:

| System | Approach |
|---|---|
| **Perplexity Deep Research** | Iterative planning → dozens of searches → reads sources → refines plan → synthesizes report with citations |
| **Claude Deep Research** | Multi-agent: planner → searcher → synthesizer. Uses web tools, iterates on plan |
| **Gemini Deep Research** | Plan-and-execute loop: generates research plan, runs searches in parallel, synthesizes |
| **GPT Deep Research** | Multi-step agent: clarifies query → plans → searches → reads → iterates → writes long report |
| **research-pipeline (GitHub)** | Deterministic stages: plan → search → screen → quality → download → convert → extract → summarize → report |

**Common pattern**:
1. Plan queries (decompose topic into sub-queries)
2. Search in parallel (Serper Scholar, CrossRef, Semantic Scholar, arXiv)
3. Read abstracts/snippets (NOT full PDFs — too slow)
4. Synthesize structured notes (topic summary, key concepts, methods, voice, refs)
5. Iterate if notes are thin (re-search, read more)

**For our use case** (scientific paper writing), we don't need 100 papers — we need 5-10 recent, highly-cited papers on the exact topic. The LLM synthesizes notes, then writes grounded in them.

---

## Architecture

### Where the study phase lives

```
/paper-write "<description>"
  ↓
[STUDY] ← NEW: search + read abstracts + synthesize notes
  ↓
study-notes.md (saved to disk for the LLM to reference)
  ↓
[WRITE] ← existing pipeline (Step 1)
  ↓
[AI CHECK + CITE + FINALIZE]
```

Same for `/paper-rewrite` — but the study phase is lighter (the text already exists; we just need context on the topic).

### What the LLM does in the study phase

Given a topic like "micro-CT imaging in Drosophila cancer cachexia":

1. **Search** (3-5 parallel calls to `find_citation`):
   - "Drosophila micro-CT cancer cachexia"
   - "whole-body imaging tumor cachexia"
   - "micro-computed tomography insect"
   - "Yki gut tumor Drosophila"
   - "high-resolution imaging tumor progression fly"

2. **Read** the top 5-10 results (snippets from Serper Scholar + abstracts from CrossRef)

3. **Synthesize** into `study-notes.md` with structure:
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
   
   ## Candidate references (top 5-10 with DOIs)
   1. Author et al. (Year). Title. Journal. doi:10.xxxx
   2. ...
   
   ## Specific findings to ground the draft
   - <Finding 1>: <what the literature says>
   ...
   ```

4. **Write** the draft using the study notes + system prompt voice rules.

### Why save to file?

- The LLM can `read` the file to reference it during writing
- If the LLM loses context (long conversations), notes persist
- User can inspect/edit notes before writing (optional)
- Citable: notes are auditable artifacts

---

## Implementation

### Option A: Prompt-only (simplest)

Instruct the LLM in the pipeline prompt to do the study phase using existing tools (`find_citation`, `scholar_search`, `crossref_lookup`). No new code.

**Pros**: Zero new code. Uses existing tools.
**Cons**: LLM may skip steps. Less control over study depth.

### Option B: New `study_topic` tool

Add a `study_topic(description, domain?, num=10)` tool that:
- Searches Serper Scholar + CrossRef
- Returns structured notes (topic summary, key concepts, methods, voice, refs)
- Optionally saves to file

**Pros**: Consistent study phase. LLM gets reliable structured output.
**Cons**: More code. Another tool to maintain.

### Option C: Hybrid (recommended)

- Add `study_topic` tool (Option B) for the LLM to call explicitly
- The pipeline prompt strongly instructs the LLM to use it
- If the LLM skips, the pipeline still works (just less grounded)

**Pros**: Best of both. Tool available, prompt enforces, fallback works.

---

## Recommended implementation steps

### Step 1: Add `study_topic` tool

**File**: `src/study.ts` (NEW)

```typescript
// src/study.ts
// Study phase: search literature + synthesize notes before writing.

import { searchScholar } from "./serper-scholar.ts";
import { lookupDoi } from "./crossref.ts";
import { getSerperKey } from "./config.ts";

export interface StudyNote {
  topic: string;
  summary: string;
  keyConcepts: Array<{ term: string; definition: string }>;
  methods: string[];
  voiceObservations: string[];
  candidateReferences: Array<{
    title: string;
    authors: string[];
    year?: number;
    venue?: string;
    doi?: string;
    snippet?: string;
  }>;
  findings: string[];
}

export async function runStudy(
  description: string,
  opts?: { num?: number; domain?: string }
): Promise<StudyNote> {
  const num = opts?.num ?? 10;

  // 1. Multi-query search for diverse results
  const queries = expandQueries(description, opts?.domain);
  const allResults: ScholarResult[] = [];
  for (const q of queries) {
    try {
      const results = await searchScholar(q, { num: Math.ceil(num / queries.length) });
      allResults.push(...results);
    } catch {
      // continue with partial results
    }
  }

  // 2. Deduplicate by DOI/title
  const deduped = dedupeByDoi(allResults).slice(0, num);

  // 3. For each result, try to fetch abstract via CrossRef
  const enriched = await Promise.all(
    deduped.map(async (r) => {
      const doi = extractDoi(r.link);
      if (doi) {
        const work = await lookupDoi(doi);
        return { ...r, doi, abstract: work?.abstract };
      }
      return r;
    })
  );

  // 4. Return structured notes (synthesis happens in the LLM)
  return {
    topic: description,
    summary: "", // filled by LLM
    keyConcepts: [], // filled by LLM
    methods: [], // filled by LLM
    voiceObservations: [], // filled by LLM
    candidateReferences: enriched.map((r) => ({
      title: r.title,
      authors: r.authors,
      year: r.year,
      venue: r.venue,
      doi: r.doi,
      snippet: r.snippet,
    })),
    findings: [], // filled by LLM
  };
}
```

**Tool registration** in `src/tools.ts`:
```typescript
{
  name: "study_topic",
  description: "Search the scientific literature for papers on a topic. Returns structured study notes (topic summary, candidate references with DOIs, abstracts) for use before writing.",
  parameters: Type.Object({
    topic: Type.String({ description: "What to research (e.g. 'micro-CT Drosophila cancer cachexia')" }),
    num: Type.Optional(Type.Number({ description: "Number of papers to retrieve (default 10)" }),
  }),
  execute: async (args, ctx) => {
    const notes = await runStudy(args.topic, { num: args.num ?? 10 });
    return notes;
  },
}
```

### Step 2: Update `pipelineWrite` prompt

Add Step 0 (STUDY) before Step 1 (WRITE):

```
STEP 0 — STUDY: Call the study_topic tool with a clear research query
  derived from your description. Run 1 call with num=10.
  Read the candidate references and snippets.
  Write study-notes.md to <same folder as output> with:
    - Topic summary (2-3 sentences)
    - Key concepts (5-10 terms specific to this field)
    - Standard methods used in this literature
    - Voice/structure observations
    - Candidate references with DOIs
  Then proceed to STEP 1.

STEP 1 — WRITE: Write the draft using study-notes.md as ground truth.
  - Cite real papers from your study notes, not made-up ones
  - Use the field-specific terminology you discovered
  - Match the voice/style observations from your study notes
  ...
```

### Step 3: Update `pipelineRewrite` prompt (lighter study)

For rewrite, the text already exists. The study phase is lighter:

```
STEP 0 — CONTEXT (optional, only if topic is unclear):
  If the draft's topic is ambiguous, call study_topic to refresh context.
  Most rewrites don't need this — proceed to STEP 1.

STEP 1 — REWRITE: ...
```

### Step 4: Storage of study notes

Default location: `<draft_output_dir>/study-notes.md`

For `/paper-write <description>`:
- Default output: `~/Desktop/paper-write-output.md`
- Study notes: `~/Desktop/paper-write-output.study-notes.md`

For `/paper-rewrite <file>`:
- Study notes (if generated): `<file>.study-notes.md`

### Step 5: Auto-detect domain before study

Before calling `study_topic`, detect the domain from the description (using existing `detectDomain`). Use domain keywords to expand the search queries:

```typescript
const domains = discoverDomains(ROOT);
const domain = detectDomain(description, domains);
const domainKeywords = domains.find(d => d.key === domain)?.detect_keywords ?? [];
```

Then `expandQueries(description, domain)` adds domain keywords to each query.

### Step 6: Token / cost considerations

- Study phase uses ~5-10 search calls
- Each result is a snippet (~200 tokens) + maybe an abstract (~300 tokens)
- Total study context: ~5K tokens
- Acceptable for scientific writing (vs full PDF parsing = 100K+ tokens)

User can configure `num` parameter to control depth:
- Quick: `num=3`
- Default: `num=10`
- Deep: `num=20`

---

## Prompt template (final)

### `/paper-write` prompt

```
Paper draft: <description>

STEP 0 — STUDY:
  1. Call study_topic with: "<description>" + any domain-specific keywords you detect
  2. Read the returned candidate references (title, snippet, abstract)
  3. Write study-notes.md to <output_dir> with:
     ## Topic summary (2-3 sentences)
     ## Key concepts (5-10 terms)
     ## Standard methods in this literature
     ## Voice / structure observations
     ## Candidate references (with DOIs)
     ## Specific findings to ground the draft
  4. Report the number of papers reviewed

STEP 1 — WRITE: Use study-notes.md + system prompt voice rules.
  - Ground every claim in your study notes
  - Use real DOIs from candidate references
  - Match voice/style observations
  - Save draft to <output_dir>/paper-write-output.md

STEP 2 — AI CHECK: Call ai_detect_statistical on your draft.
  If score >40%, rewrite flagged sentences. Re-test. Max 3 rounds.

STEP 3 — CITE: For each [CITE:topic] in the draft, call find_citation.
  Assign [N](<doi:10.xxxx>) — ALWAYS use angle brackets.
  Update the draft.

STEP 4 — FINALIZE: Run this bash command:
  node --experimental-strip-types -e "import('<root>/src/pipeline.ts').then(({finalizeDoc}) => { const r = finalizeDoc('<output>'); if (r.error) console.log('Error:', r.error); else console.log('Done! Word:', r.docxPath, '| References:', r.bibliographyCount); }).catch(err => console.log('Error:', err.message));"

STEP 5 — REPORT: Tell the user the .docx path and the number of papers studied.
  Do NOT read the .docx (binary).
```

### `/paper-rewrite` prompt (lighter study)

```
Draft to rewrite: <file>

STEP 0 — CONTEXT REFRESH (skip if topic is clear):
  If the draft's topic is ambiguous, call study_topic.
  Otherwise, proceed to STEP 1.

STEP 1 — REWRITE: ...
STEP 2-4: ...
```

---

## Execution order

```
Step 1: src/study.ts (new)
Step 2: register study_topic tool in src/tools.ts
Step 3: update pipelineWrite prompt
Step 4: update pipelineRewrite prompt
Step 5: add study-notes.md storage convention
Step 6: auto-detect domain in study calls
Step 7: add tests
Step 8: update README
```

Each step gates the next. After Step 4, the study phase is functional.

## Non-negotiable rules

1. Study phase is OPT-IN via the tool — pipeline prompt strongly recommends it but doesn't force it
2. Study phase adds NO new external API requirements — uses existing Serper + CrossRef
3. Study notes saved to disk in a predictable location
4. `/paper-cite` does NOT get a study phase (citations already come from inline claims)
5. Study phase never blocks the pipeline — if it fails, the pipeline continues without notes
6. Domain auto-detection runs BEFORE study to bias search queries toward the right field

## Future enhancements (v0.7+)

- `num` config in `/paper-lab` (default study depth)
- Study notes summarization by a smaller LLM (cost reduction)
- Multi-language support (study in user's language, write in English)
- ArXiv full-text search for preprints
- Semantic Scholar + OpenAlex as additional sources