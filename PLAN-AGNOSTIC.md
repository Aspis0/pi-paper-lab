# PLAN: Make pi-paper-lab Domain-Agnostic

> **Goal**: pi-paper-lab works for ANY biology field. No hardcoded domains.
> Domains are discovered at runtime by scanning `data/domains/*.yaml`.
> Drop a YAML file → new domain. Zero code changes.
> **Executor**: Another agent will implement this plan.

---

## Core principle: DATA-DRIVEN, NEVER HARDCODED

- NO domain list in code. NO `if (domain === "X")`.
- `/paper-lab` reads `data/domains/*.yaml` → shows whatever exists.
- Auto-detect reads ALL domain profiles → matches text against each.
- Adding a domain = creating one YAML file. That's it.

---

## Audit: What's already agnostic (NO CHANGES)

| File | Status |
|---|---|
| `src/statistical-ai-detector.ts` | ✅ 7 features, zero domain logic |
| `src/ai-detector.ts` | ✅ Copyleaks + local fallback |
| `src/serper-scholar.ts` | ✅ Serper API |
| `src/crossref.ts` | ✅ CrossRef API |
| `src/citations.ts` | ✅ Vancouver bibliography |
| `src/cite-verify.ts` | ✅ Claim verification |
| `src/config.ts` | ✅ API keys (add `domain` field — Step 4) |
| `src/word-builder.ts` | ✅ Markdown → docx |
| `src/pipeline.ts` | ✅ Logic agnostic (prompts need minor fix — Step 5) |
| `src/imrad.ts` | ✅ Checks n, p, CI — universal |

## Audit: What's Drosophila-specific (MUST CHANGE)

| File | Issue |
|---|---|
| `src/system-injection.ts` | ~150 lines hardcoded Drosophila voice |
| `data/drosophila-lexicon.yaml` | `domain:` section, term mappings, balancers |
| `corpus-sources.md` | Only Drosophila papers |
| `src/tools.ts` | 2 descriptions say "Drosophila" |
| `src/anti-ai-lexicon.ts` | Lexicon type has Drosophila-specific fields |

---

## Domain Profile YAML Schema

Each file in `data/domains/` is ONE domain. The filename IS the domain key.

```yaml
# data/domains/drosophila-genetics.yaml
# The filename (without .yaml) is the domain key: "drosophila-genetics"
# Everything below is OPTIONAL. Omit a section → those rules don't apply.

name: "Drosophila genetics"           # display name
journals:                              # relevant journals
  - eLife
  - Genetics
  - "PLOS Genetics"

# Species conventions (omit if not species-specific, e.g. cancer)
species:
  first_mention: "Drosophila melanogaster"
  subsequent: ["the fly", "Drosophila", "flies"]
  avoid: "the fruit fly Drosophila melanogaster"

# Stock/strain conventions (omit if not applicable)
stocks:
  format: "BDSC stock #91234"
  rrid_prefix: "RRID:BDSC_"

# Genotype format (omit if not applicable)
genotype:
  format: "y[1] w[1118]; +; P{GAL4}attP2"
  chromosome_order: "X;Y;2;3;4"

# Balancers (omit if not applicable)
balancers:
  canonical: [FM7, FM7a, CyO, SM1, TM6B]
  not_markers: [Sp, If, Sb, Hu, Tb]

# Nomenclature rules (each is a find→replace or a rule string)
nomenclature:
  - find: "Gal4"
    replace: "GAL4"
    rule: "ALWAYS capitalize GAL4"
  - rule: "Use promoter-GAL4 format (e.g. R57C10-GAL4)"

# Key citations that must be cited correctly (omit if none)
key_citations:
  - term: "MARCM"
    must_cite: "Lee and Luo, 1999, Neuron 22:451-461"
    doi: "10.1016/s0896-6273(00)80701-1"
    not: "the 2001 TINS review"

# Life stages (omit if not applicable)
life_stages: [embryo, "L1", "L2", "L3", "wandering L3"]

# Term mappings (auto-correct these in text)
term_mappings:
  - source: "neural stem cell"
    target: "neuroblast"
  - source: "neural stem cells"
    target: "neuroblasts"

# Auto-detect keywords (used to guess the domain from text)
detect_keywords: [drosophila, flies, GAL4, UAS, MARCM, neuroblast, balancer]

# Reporting standards
reporting:
  rrid_required: true
  rrid_types: [antibody, "fly stock", "cell line"]
  key_resources_table: true

# Voice rules per section
voice:
  introduction: "HIGH assertiveness. State the gap; state the question."
  methods: "HIGHEST assertiveness. No hedging."
  results: "HIGH assertiveness. State findings directly."
  discussion: "Moderate hedging. Speculation only in final paragraph."
```

### Example: minimal domain (cancer)
```yaml
# data/domains/cancer-biology.yaml
name: "Cancer biology"
journals: ["Cancer Cell", "Cancer Research", "Lancet Oncology"]
nomenclature:
  - rule: "Cell lines: MCF-7, A549, HCT116 (hyphen, no italics)"
  - rule: "Drug concentrations: μM, nM (not uM)"
detect_keywords: [cancer, tumor, xenograft, oncogene, metastasis, "cell line"]
reporting:
  rrid_required: true
  rrid_types: [antibody, "cell line", drug]
voice:
  introduction: "HIGH assertiveness."
  results: "HIGH assertiveness."
```

### Example: truly minimal (user creates new domain)
```yaml
# data/domains/my-field.yaml
name: "My research field"
detect_keywords: [myfield, "my model"]
```

That's a valid domain. Everything else is optional.

---

## Implementation Steps

### Step 1: Split the lexicon
**From**: `data/drosophila-lexicon.yaml` (one file, mixed)
**To**: `data/lexicon-common.yaml` + `data/domains/drosophila-genetics.yaml`

1a. `data/lexicon-common.yaml` — SHARED entries (AI-tells, fillers, hedging, statistics, sloppy patterns, claim strength). Zero references to any species/domain.

1b. `data/domains/drosophila-genetics.yaml` — Drosophila-specific (see schema above). Everything from the old `domain:` section + term mappings + species + balancers + GAL4 + MARCM.

1c. Create a few more domain files as examples:
- `data/domains/mouse-mammalian.yaml`
- `data/domains/cancer-biology.yaml`
- `data/domains/general-biology.yaml` (minimal — just voice rules)

**Verify**: `grep -ri "drosophila\|GAL4\|neuroblast\|balancer\|fly" data/lexicon-common.yaml` → nothing.

### Step 2: Discover domains at runtime
**File**: `src/anti-ai-lexicon.ts` (or new `src/domains.ts`)

```typescript
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Discover all domains by scanning data/domains/*.yaml
export function discoverDomains(root: string): DomainProfile[] {
  const dir = join(root, "data", "domains");
  try {
    const files = readdirSync(dir).filter(f => f.endsWith(".yaml"));
    return files.map(f => {
      const key = f.replace(".yaml", "");
      const raw = readFileSync(join(dir, f), "utf-8");
      return { key, ...parseYaml(raw) };
    });
  } catch {
    return [];  // no domains folder → general mode
  }
}

// Auto-detect: score text against each domain's detect_keywords
export function detectDomain(text: string, domains: DomainProfile[]): string {
  let best = "general-biology";
  let bestScore = 0;
  for (const d of domains) {
    const keywords = d.detect_keywords ?? [];
    const score = keywords.filter(kw => new RegExp(kw, "i").test(text)).length;
    if (score > bestScore) { bestScore = score; best = d.key; }
  }
  return best;
}

// Load: common lexicon + merge domain profile
export function loadLexicon(root: string, domainKey?: string): Lexicon {
  const common = loadYaml(join(root, "data", "lexicon-common.yaml"));
  if (!domainKey) return parseLexicon(common);
  const domainFile = join(root, "data", "domains", `${domainKey}.yaml`);
  try {
    const domain = loadYaml(domainFile);
    return mergeLexicon(common, domain);
  } catch {
    return parseLexicon(common);  // domain file not found → general
  }
}
```

**Key**: NO hardcoded domain list. `discoverDomains` reads the filesystem.

**Verify**: Add a new `data/domains/foo.yaml` → `discoverDomains` returns it. Delete it → gone.

### Step 3: Rewrite system-injection.ts
**File**: `src/system-injection.ts`

Replace ALL hardcoded text with a **template engine** that reads from the domain profile:

```typescript
export function buildSystemInjection(lex: Lexicon, domain: DomainProfile | null): string {
  const parts: string[] = [];

  // 1. Common rules (always included — AI-tells, hedging, voice, numbers, figures)
  parts.push(buildCommonRules(lex));

  // 2. Domain-specific rules (only if domain profile has the data)
  if (!domain) return parts.join("\n\n");

  if (domain.species)
    parts.push(buildSpeciesSection(domain.species));
  if (domain.stocks)
    parts.push(buildStocksSection(domain.stocks));
  if (domain.genotype)
    parts.push(buildGenotypeSection(domain.genotype));
  if (domain.balancers)
    parts.push(buildBalancersSection(domain.balancers));
  if (domain.nomenclature?.length)
    parts.push(buildNomenclatureSection(domain.nomenclature));
  if (domain.key_citations?.length)
    parts.push(buildKeyCitationsSection(domain.key_citations));
  if (domain.life_stages?.length)
    parts.push(buildLifeStagesSection(domain.life_stages));
  if (domain.term_mappings?.length)
    parts.push(buildTermMappingsSection(domain.term_mappings));
  if (domain.reporting)
    parts.push(buildReportingSection(domain.reporting));
  if (domain.voice)
    parts.push(buildVoiceSection(domain.voice));

  // Header
  const label = domain.name ?? "general";
  return `[pi-paper-lab ACTIVE — field=${label}]\n\n${parts.join("\n\n")}`;
}
```

Each `build*Section` function generates text ONLY from the YAML data. If a section is missing from the YAML, it's skipped entirely. No hardcoded species names, no hardcoded balancers, no hardcoded journals.

**Verify**: With a minimal domain `{name: "test"}`, the system prompt has only common rules + `[pi-paper-lab ACTIVE — field=test]`. Zero Drosophila references.

### Step 4: Domain selection in /paper-lab
**File**: `src/config.ts` + `extensions/index.ts`

4a. Add `domain` to config:
```typescript
interface PaperLabConfig {
  serper?: string;
  copyleaks_email?: string;
  copyleaks_api_key?: string;
  domain?: string;  // key from data/domains/*.yaml
}
```

4b. `/paper-lab` dynamically lists domains:
```typescript
// In paperLabConfigCommand:
const domains = discoverDomains(ROOT);
const domainChoices = domains.map(d => `${d.key} — ${d.name}`);
// Add "Auto-detect (from text)" option
// Add to the existing menu
```

NO hardcoded list. The menu shows whatever YAML files exist in `data/domains/`.

4c. In `extensions/index.ts`:
```typescript
const config = loadConfig();
const domains = discoverDomains(ROOT);
const domainKey = config.domain ?? "auto";
// If "auto", detectDomain is called per-file in the pipeline
const lex = loadLexicon(ROOT, domainKey === "auto" ? undefined : domainKey);
const injection = buildSystemInjection(lex, domains.find(d => d.key === domainKey) ?? null);
```

**Verify**: Drop `data/domains/foo.yaml` → `/paper-lab` shows "foo". Delete → gone. No code change.

### Step 5: Update pipeline prompts
**File**: `src/pipeline.ts`

5a. `pipelineCite` / `pipelineRewrite`: auto-detect domain from text if config is "auto":
```typescript
const config = loadConfig();
let domainKey = config.domain;
if (!domainKey || domainKey === "auto") {
  const domains = discoverDomains(ROOT);
  domainKey = detectDomain(text, domains);
}
// Pass domainKey to buildCiteMarkPrompt
```

5b. `pipelineWrite`: replace hardcoded Drosophila rules with domain-driven rules:
```typescript
const domain = domains.find(d => d.key === domainKey);
const domainRules = domain ? buildDomainPromptRules(domain) : "";
// Use domainRules in the prompt instead of hardcoded "neuroblast not neural stem cell" etc.
```

5c. `buildCiteMarkPrompt`: remove the hardcoded Drosophila rewrite instructions. The system prompt (injected per turn) already handles voice rules. The prompt just says "rewrite for1 for human voice" and the system prompt provides the domain-specific rules.

**Verify**: `/paper-write "write about mouse genetics"` with domain=mouse → text about mice. No Drosophila terms.

### Step 6: Update tool descriptions
**File**: `src/tools.ts`

Line 85: `"Drosophila-voice violations"` → `"domain-specific voice violations"`
Line 110: `"Drosophila-specific Methods/Results"` → `"domain-specific Methods/Results"`

**Verify**: `grep -ri "drosophila" src/tools.ts` → nothing.

### Step 7: Update corpus-sources
**File**: `corpus-sources.md`

Add a section per domain with 2-3 key papers. These inform the domain-specific YAML profiles. Future agents can read these to expand domain lexicon entries.

### Step 8: Update README
**File**: `README.md`

```markdown
## Domains

Domains are YAML files in `data/domains/`. No code changes needed to add one.

### Built-in domains
(scanned from the folder at runtime — check `data/domains/` for current list)

### Create a custom domain
Create `data/domains/my-field.yaml`:
\`\`\`yaml
name: "My research field"
detect_keywords: [myfield, "my model"]
nomenclature:
  - rule: "My specific naming rule"
\`\`\`
Then run `/paper-lab` → select your domain. Done.
```

---

## Execution Order

```
Step 1 → Step 2 → Step 3 → Step 4 → Step 5 → Step 6 → Step 7 → Step 8
```

After Step 4: extension works with any domain YAML, auto-detects.
After Step 5: pipelines are domain-driven.
Steps 6-8: cleanup.

## Non-negotiable rules for the executor

1. NO hardcoded domain names in any .ts file. Ever.
2. NO `if (domain === "drosophila")`. Ever.
3. Domain discovery = filesystem scan. Adding a domain = 1 YAML file.
4. Every domain YAML field is OPTIONAL. A domain with just `name:` is valid.
5. `buildSystemInjection` generates text from YAML data, not from string literals.
6. Auto-detect uses `detect_keywords` from YAML, not hardcoded regexes.
