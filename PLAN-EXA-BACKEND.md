# PLAN: Add Exa API as alternative/addition to Serper.dev Scholar

> **Goal**: Add Exa (exa.ai) as a backend for `find_citation`. Users can choose Serper, Exa, or both (merged). Exa has 350M+ publications index with `category="publication"` — better for academic search than general web search.
>
> **Scope**: Config-driven backend selection. No breaking changes. Existing Serper users keep working. New users can choose.

---

## Why Exa?

From the research:

| Feature | Serper.dev Scholar | Exa |
|---|---|---|
| Index | Google Scholar results (Google's index) | 350M+ publications (Exa's own neural index) |
| Search type | Keyword (Google's ranking) | Neural/embedding-based (semantic) |
| Academic mode | Default is academic | `category="publication"` filter |
| Result fields | title, authors, year, venue, citations, link, snippet | title, url, author, publishedDate, text, highlights |
| Free tier | 2,500 searches/month (Scholar) | $20 signup + $10/month recurring (=$30 free) |
| Cost beyond free | $50/10k searches | $7/1k searches (10 results) |
| Snippets | ✓ (Google snippet) | ✓ (highlights — token-efficient extracts) |
| Full text | ✗ | ✓ (Contents API) |
| Best for | Quick citation lookup | Deep research + full-text context |

**Complementary, not replacement**:
- Serper is fast + cheap for finding the canonical citation
- Exa is better for finding related work, getting full abstracts, doing "deep research"
- Many users want BOTH: Exa for finding papers, Serper for verifying citation count

---

## Design

### Backend selection

User configures via `/paper-lab` or `~/.pi/agent/.paper-lab-keys.json`:

```json
{
  "serper": "...",
  "exa": "...",
  "citation_backend": "serper" | "exa" | "both" | "auto"
}
```

- `"serper"` (default for existing users): use Serper only
- `"exa"`: use Exa only
- `"both"`: query both, merge + dedupe results
- `"auto"`: try Exa first (better results), fall back to Serper on failure

### What changes

| File | Change |
|---|---|
| `src/exa-scholar.ts` (NEW) | Exa API client (parallels `serper-scholar.ts`) |
| `src/config.ts` | Add `exa` + `citation_backend` fields |
| `src/citations.ts` | `find_citation` switches backend based on config |
| `extensions/index.ts` | `/paper-lab` option 5+6: Exa key + backend selection |

### What does NOT change

- `find_citation(topic)` tool signature (LLM doesn't know which backend)
- `[N](doi:...)` format in draft
- CrossRef verification (still CrossRef for DOI → Vancouver)
- `finalizeDoc` (unchanged)

---

## Implementation steps

### Step 1: `src/exa-scholar.ts` (NEW)

```typescript
// src/exa-scholar.ts
// Exa.ai API client. Returns ExaSearchResult interface.

import { getExaKey } from "./config.ts";

export interface ExaSearchResult {
  id: string;
  url: string;
  title: string;
  author?: string;
  publishedDate?: string;  // ISO 8601
  text?: string;           // full text (if requested)
  highlights?: string[];   // token-efficient extracts
  score?: number;          // Exa relevance score
}

export async function searchExa(
  query: string,
  opts?: { num?: number; signal?: AbortSignal; fullText?: boolean }
): Promise<ExaSearchResult[]> {
  const apiKey = process.env.EXA_API_KEY ?? getExaKey();
  if (!apiKey) throw new Error("EXA_API_KEY not set. Run /paper-lab to configure.");

  const num = opts?.num ?? 10;
  const body = {
    query,
    type: "auto",
    category: "publication",
    numResults: num,
    contents: {
      // Exa expects an OBJECT, not a boolean. Default: 3 sentences per result, query-aware.
      highlights: { numSentences: 3, highlightsPerUrl: 1, query },
      text: opts?.fullText ?? false,
    },
  };

  const res = await fetch("https://api.exa.ai/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
      "User-Agent": "pi-paper-lab/0.6",
    },
    body: JSON.stringify(body),
    signal: opts?.signal,
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Exa search failed (${res.status}): ${err.slice(0, 200)}`);
  }

  const data = await res.json();
  return (data.results ?? []).map((r: any) => ({
    id: r.id,
    url: r.url,
    title: r.title,
    author: r.author,
    publishedDate: r.publishedDate,
    text: r.text,
    highlights: r.highlights,
    score: r.score,
  }));
}
```

### Step 2: `src/config.ts` — add Exa + backend field

```typescript
export interface PaperLabConfig {
  serper?: string;
  exa?: string;                                          // NEW
  citation_backend?: "serper" | "exa" | "both" | "auto"; // NEW
  copyleaks_email?: string;
  copyleaks_api_key?: string;
  domain?: string;
}

export function getExaKey(): string | undefined {
  if (process.env.EXA_API_KEY) return process.env.EXA_API_KEY;
  return loadConfig().exa;
}
```

`/paper-lab` menu gets:
- Option 5: Exa API key (NEW)
- Option 6: Citation backend (serper / exa / both / auto)

### Step 3: `src/citations.ts` — backend-aware `find_citation`

```typescript
import { searchScholar } from "./serper-scholar.ts";
import { searchExa, type ExaSearchResult } from "./exa-scholar.ts";
import { loadConfig } from "./config.ts";

export async function find_citation(topic: string, num = 5): Promise<ScholarResult[]> {
  const backend = loadConfig().citation_backend ?? "serper";

  if (backend === "serper") {
    return await searchScholar(topic, { num });
  }

  if (backend === "exa") {
    const exaResults = await searchExa(topic, { num });
    return exaResultsToScholar(exaResults);
  }

  if (backend === "both") {
    const [serper, exa] = await Promise.allSettled([
      searchScholar(topic, { num }),
      searchExa(topic, { num }),
    ]);
    return mergeDedupe(
      serper.status === "fulfilled" ? serper.value : [],
      exa.status === "fulfilled" ? exaResultsToScholar(exa.value) : []
    );
  }

  if (backend === "auto") {
    // Try Exa first; fall back to Serper on either failure OR empty results.
    try {
      const exaResults = await searchExa(topic, { num });
      if (exaResults.length > 0) return exaResultsToScholar(exaResults);
      // Exa returned 0 — not an error, but treat as fallback signal.
    } catch {
      // Exa threw (network, auth, rate limit) — fall through to Serper.
    }
    return await searchScholar(topic, { num });
  }

  return await searchScholar(topic, { num });
}

function exaResultsToScholar(exa: ExaSearchResult[]): ScholarResult[] {
  return exa.map(r => ({
    title: r.title,
    authors: r.author ? [r.author] : [],
    year: r.publishedDate ? new Date(r.publishedDate).getFullYear() : undefined,
    // Exa doesn't return venue. URL is unreliable for journal name.
    // Leave undefined — CrossRef lookup during resolveCitation fills it in.
    venue: undefined,
    link: r.url,
    snippet: r.highlights?.[0],
  }));
}

function mergeDedupe(a: ScholarResult[], b: ScholarResult[]): ScholarResult[] {
  // DOI-aware dedup. Falls back to URL, then to normalized title (lowercase, 60 chars).
  // Same pattern as existing dedupeCandidates in citations.ts.
  const seen = new Set<string>();
  const out: ScholarResult[] = [];
  const normTitle = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim().slice(0, 60);
  for (const r of [...a, ...b]) {
    const doi = r.doi;  // may be undefined
    const urlKey = r.link;
    const titleKey = r.title ? normTitle(r.title) : "";
    const key = doi ?? urlKey ?? titleKey;
    if (key && !seen.has(key)) { seen.add(key); out.push(r); }
  }
  return out;
}
```

### Step 4: `extensions/index.ts` — `/paper-lab` backend selection

Add options 5 (Exa key) and 6 (backend choice):

```typescript
const choice = await ctx.ui.select("Which key to set?", [
  "1. Serper Scholar API key",
  "2. Copyleaks email",
  "3. Copyleaks API key",
  "4. Domain",
  "5. Exa API key (NEW)",
  `6. Citation backend (current: ${config.citation_backend ?? "serper"})`,
  "7. Show all",
  "8. Delete all",
]);
```

### Step 5: Tests

```typescript
// tests/citation-backends.test.ts
// (Can be skipped in CI — requires actual API keys)
import { find_citation } from "../src/citations.ts";
const result = await find_citation("Drosophila neuroblast");
assert(result.length > 0);
assert(result[0].title);
assert(result[0].link);
```

### Step 6: README

Add a section on backend selection. Update install instructions to mention Exa as alternative.

---

## When is each backend used?

| `find_citation` called from | Backend behavior |
|---|---|
| Study phase (paper-write/rewrite) | Uses configured backend — Exa better for discovery |
| Inline citations (paper-cite) | Uses configured backend — Serper better for canonical citation |
| Both | Parallel query, merge + dedupe |

**Recommendation by use case**:
- Quick lookup of known paper → Serper
- Discovery of related work → Exa (`type="auto"`, `category="publication"`)
- Deep research → Exa with `type="deep-lite"` + full text
- Verify citation count → Serper (has `citations` field)

---

## Cost comparison

| Operation | Serper | Exa |
|---|---|---|
| Find paper for topic | $0.005 | $0.007 |
| Full abstract | ✗ | $0.001 (highlights) |
| Full text | ✗ | $0.001 |
| 100 citations/month | $0.50 | $0.70 |
| 1000 citations/month | $5.00 | $7.00 |

Both are cheap. Default Serper is fine for most users. Exa is for users who want better discovery + full text.

---

## Execution order

```
Step 1: src/exa-scholar.ts (new, ~50 lines)
Step 2: src/config.ts (add exa + citation_backend fields, getExaKey)
Step 3: src/citations.ts (backend-aware find_citation, mergeDedupe, exaResultsToScholar)
Step 4: extensions/index.ts (/paper-lab option 5+6)
Step 5: tests/citation-backends.test.ts (optional, requires API keys)
Step 6: README (document Exa + backend selection)
```

Each step gates the next. After Step 3, the backend works. Step 4 makes it user-configurable.

## Non-negotiable rules

1. `find_citation(topic)` signature unchanged — LLM doesn't know which backend
2. Default is Serper — existing users keep working without config change
3. Both backends return same `ScholarResult` format — downstream code unchanged
4. Failure of one backend doesn't fail the whole call — `auto` falls back, `both` uses partial results
5. No breaking changes to `/paper-cite`, `/paper-write`, `/paper-rewrite` — all continue to work
6. Exa API key stored same way as Serper — `~/.pi/agent/.paper-lab-keys.json` (already in .gitignore)
7. CrossRef verification unchanged — DOI → Vancouver format still uses CrossRef regardless of search backend

## Future enhancements (v0.7+)

- Exa's `type="deep-lite"` for study phase (4s synthesis, structured output)
- Exa's `/contents` API for full-text reading (heavyweight, opt-in)
- Confidence scoring: which backend gave the better result for this query
- Auto-tuning: track which backend has higher hit rate per domain
