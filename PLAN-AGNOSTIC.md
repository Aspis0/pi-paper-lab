# PLAN: Make pi-paper-lab Domain-Agnostic

> **Goal**: Transform pi-paper-lab from Drosophila-specific to domain-agnostic biology paper writing tool.
> Supports: Drosophila, Mouse/Mammalian, Cancer, Neuroscience, C. elegans, General/Custom.
> **Executor**: Another agent will implement this plan. Each step is self-contained and verifiable.

---

## Audit: What's already agnostic (NO CHANGES NEEDED)

| File | Status | Notes |
|---|---|---|
| `src/statistical-ai-detector.ts` | ✅ agnostic | 7 statistical features, no domain logic |
| `src/ai-detector.ts` | ✅ agnostic | Copyleaks API + local fallback |
| `src/serper-scholar.ts` | ✅ agnostic | Serper API client |
| `src/crossref.ts` | ✅ agnostic | CrossRef API + normalizeWork |
| `src/citations.ts` | ✅ agnostic | Citation parsing, Vancouver bibliography |
| `src/cite-verify.ts` | ✅ agnostic | Claim verification prompts |
| `src/config.ts` | ✅ agnostic | API key management |
| `src/word-builder.ts` | ✅ agnostic | Markdown → docx |
| `src/footnote-injector.ts` | ✅ agnostic | Footnote placeholder |
| `src/pipeline.ts` | ✅ agnostic logic | Prompts have minor Drosophila refs (Step 3) |
| `src/imrad.ts` | ✅ mostly agnostic | Checks n, p-values, CIs — universal |

## Audit: What's Drosophila-specific (MUST CHANGE)

| File | Issue | Lines |
|---|---|---|
| `src/system-injection.ts` | Hardcoded Drosophila voice, species, balancers, GAL4, MARCM, journals | ~150 lines, almost entirely Drosophila |
| `data/drosophila-lexicon.yaml` | `domain:` section, `domain_term_mappings`, species, balancers, stock format | Lines 270-350+ |
| `corpus-sources.md` | All papers are Drosophila | Entire file |
| `src/tools.ts` | Two tool descriptions say "Drosophila" | Lines 85, 110 |
| `src/anti-ai-lexicon.ts` | Lexicon type has Drosophila-specific fields (balancers, lifeStages, etc.) | Lines 19-30 |
| `src/claim-strength.ts` | References `drosophila-lexicon.yaml` in comment | Line 3 |

---

## Architecture: Domain Profile System

```
data/
├── lexicon-common.yaml          # AI-tells, fillers, hedging — SHARED across all domains
├── domains/
│   ├── drosophila.yaml          # Drosophila-specific: species, GAL4, MARCM, balancers, neuroblast
│   ├── mouse.yaml              # Mouse: M. musculus, strains (C57BL/6), alleles, transgenes
│   ├── cancer.yaml             # Cancer: cell lines, xenografts, IC50, Kaplan-Meier, HR
│   ├── neuroscience.yaml       # Neuro: electrodes, recording, brain regions, neurons
│   ├── c-elegans.yaml          # C. elegans: strains, alleles, balancers (hT2, nT1)
│   └── general.yaml            # Generic biology: minimal rules, no species-specific
└── (remove drosophila-lexicon.yaml — split into common + domains/drosophila.yaml)
```

### Domain profile YAML schema (each domain file):

```yaml
# data/domains/drosophila.yaml
name: "Drosophila genetics"
label: "drosophila-genetics"
journals:
  - "eLife"
  - "Genetics"
  - "G3"
  - "PLOS Genetics"
  - "Development"
  - "Nature Methods"

species:
  first_mention: "Drosophila melanogaster"
  subsequent: ["the fly", "Drosophila", "flies"]
  redundant_form: "the fruit fly Drosophila melanogaster"  # NEVER use this

stocks:
  format: "BDSC stock #91234"
  rrid_prefix: "RRID:BDSC_"
  description: "Bloomington Drosophila Stock Center"

genotype:
  format: "y[1] w[1118]; +; P{GAL4}attP2"
  chromosome_order: "X;Y;2;3;4"
  solidus: true  # use / for homologous chromosomes

balancers:
  canonical: ["FM7", "FM7a", "FM7h", "CyO", "SM1", "TM6B"]
  warning: "Do not confuse with MARKERS like Sp, If, Sb, Hu, Tb"

nomenclature:
  - rule: "ALWAYS capitalize GAL4 (not Gal4)"
    pattern: "Gal4"
    replacement: "GAL4"
  - rule: "Use promoter-GAL4 format (e.g. R57C10-GAL4)"

key_citations:
  - term: "MARCM"
    citation: "Lee and Luo, 1999, Neuron 22:451-461"
    doi: "10.1016/s0896-6273(00)80701-1"
    warning: "NOT the 2001 TINS review"

life_stages:
  - "embryo"
  - "first-instar larva (L1)"
  - "second-instar larva (L2)"
  - "third-instar larva (L3)"
  - "wandering L3"

domain_term_mappings:
  - source: "neural stem cell"
    target: "neuroblast"
  - source: "neural stem cells"
    target: "neuroblasts"
  - source: "neural progenitor"
    target: "neuroblast"

reporting:
  rrid_required: true
  rrid_types: ["antibody", "fly stock", "cell line"]
  key_resources_table: true

voice_rules:
  introduction: "HIGH assertiveness. State the gap; state the question."
  methods: "HIGHEST assertiveness. No hedging. Plain description."
  results: "HIGH assertiveness. State findings directly with n, p, effect size."
  discussion: "Moderate hedging. Speculation only in final paragraph with hedged language."
```

```yaml
# data/domains/mouse.yaml
name: "Mouse / Mammalian biology"
label: "mouse-mammalian"
journals:
  - "Cell"
  - "Nature"
  - "Science"
  - "JCI"
  - "Nature Communications"
  - "Cell Reports"

species:
  first_mention: "Mus musculus"
  subsequent: ["the mouse", "mice", "animals"]
  redundant_form: "the house mouse Mus musculus"

strains:
  format: "C57BL/6J"
  rrid_prefix: "RRID:IMSR_"
  common: ["C57BL/6J", "BALB/c", "FVB/N", "CD1", "129Sv"]

nomenclature:
  - rule: "Gene names italicized (e.g. Brca1, Trp53)"
  - rule: "Protein names: BRCA1, TRP53 (uppercase, no italics)"
  - rule: "Transgene format: Tg(promoter-gene)Line#"

domain_term_mappings: []  # no special mappings needed

reporting:
  rrid_required: true
  rrid_types: ["antibody", "mouse strain", "cell line"]
  key_resources_table: true
  arrive2: true  # ARRIVE 2.0 guidelines for animal studies

voice_rules:
  introduction: "HIGH assertiveness."
  methods: "HIGHEST assertiveness."
  results: "HIGH assertiveness."
  discussion: "Moderate hedging."
```

```yaml
# data/domains/cancer.yaml
name: "Cancer biology"
label: "cancer-biology"
journals:
  - "Cancer Cell"
  - "Cell"
  - "Nature"
  - "Cancer Research"
  - "JCO"
  - "Lancet Oncology"

species:
  first_mention: null  # cancer papers may not have a single species
  subsequent: []

nomenclature:
  - rule: "Gene names: BRCA1, TP53 (uppercase, human)"
  - rule: "Cell lines: MCF-7, A549, HCT116 (hyphen, no italics)"
  - rule: "Drug concentrations: μM, nM (not uM)"

domain_term_mappings: []

reporting:
  rrid_required: true
  rrid_types: ["antibody", "cell line", "drug"]
  key_resources_table: true

voice_rules:
  introduction: "HIGH assertiveness."
  methods: "HIGHEST assertiveness."
  results: "HIGH assertiveness."
  discussion: "Moderate hedging."
```

```yaml
# data/domains/general.yaml
name: "General biology"
label: "general-biology"
journals: []  # no specific journals

species:
  first_mention: null
  subsequent: []

nomenclature: []
domain_term_mappings: []
balancers: null
stocks: null
genotype: null
key_citations: []

reporting:
  rrid_required: false
  rrid_types: []
  key_resources_table: false

voice_rules:
  introduction: "HIGH assertiveness."
  methods: "HIGHEST assertiveness."
  results: "HIGH assertiveness."
  discussion: "Moderate hedging."
```

---

## Implementation Steps

### Step 1: Split the lexicon
**File**: `data/drosophila-lexicon.yaml` → split into two files

1a. Create `data/lexicon-common.yaml` with the SHARED entries:
- `preferred_verbs`, `avoided_verbs`, `avoided_nouns`, `filler_words`
- `sentence_tells`, `ai_tell_scoring`
- Generic `conventions` (not species-specific)
- Generic `statistics`, `hedging`, `voice`, `figures`, `citations`
- Generic `sloppy_patterns`, `claim_strength`
- `reporting_standards` (generic parts)

1b. Create `data/domains/drosophila.yaml` with Drosophila-specific:
- Everything from the `domain:` section
- `domain_term_mappings`
- Species, stocks, genotype, balancers, life stages, key citations
- Drosophila-specific conventions (GAL4, MARCM)

1c. Create `data/domains/mouse.yaml`, `cancer.yaml`, `neuroscience.yaml`, `c-elegans.yaml`, `general.yaml` (see schemas above)

**Verify**: `lexicon-common.yaml` has zero references to Drosophila, GAL4, neuroblast, balancers, flies.

### Step 2: Update Lexicon type
**File**: `src/anti-ai-lexicon.ts`

2a. Make domain fields optional in the `Lexicon` type:
```typescript
interface Lexicon {
  // ... existing fields ...
  domain?: {
    speciesFirstMention?: string[];
    speciesSubsequent?: string[];
    balancers?: string[];
    lifeStages?: string[];
    domainTermMappings?: { source: string; target: string }[];
    // ... etc
  };
}
```

2b. Update `loadLexicon` to load `lexicon-common.yaml` + a domain profile:
```typescript
export function loadLexicon(root: string, domain?: string): Lexicon {
  const common = loadYaml(join(root, "data", "lexicon-common.yaml"));
  if (domain && domain !== "general") {
    const domainProfile = loadYaml(join(root, "data", "domains", `${domain}.yaml`));
    return mergeLexicon(common, domainProfile);
  }
  return parseLexicon(common);
}
```

**Verify**: `npx tsc --noEmit` passes.

### Step 3: Rewrite system-injection.ts
**File**: `src/system-injection.ts`

3a. Replace the hardcoded Drosophila text with a **template** that reads from the domain profile:

```typescript
export function buildSystemInjection(lex: Lexicon, domain: string): string {
  const parts: string[] = [];

  // Always include: AI-tell rules, hedging, voice, reporting
  parts.push(buildCommonRules(lex));

  // Domain-specific (only if domain profile has data)
  if (lex.domain?.speciesFirstMention) {
    parts.push(buildSpeciesRules(lex.domain));
  }
  if (lex.domain?.balancers) {
    parts.push(buildBalancerRules(lex.domain));
  }
  if (lex.domain?.domainTermMappings?.length) {
    parts.push(buildTermMappingRules(lex.domain));
  }
  if (lex.domain?.keyCitations?.length) {
    parts.push(buildKeyCitationRules(lex.domain));
  }

  return parts.join("\n\n");
}
```

3b. Each `build*Rules` function generates text only if the domain profile has the relevant data. For `general.yaml` (empty domain), only common rules are emitted.

**Verify**: With `domain="general"`, the system prompt has NO references to Drosophila, GAL4, neuroblast, flies, balancers.

### Step 4: Domain selection mechanism
**File**: `src/config.ts` + `extensions/index.ts`

4a. Add `domain` field to `PaperLabConfig`:
```typescript
interface PaperLabConfig {
  serper?: string;
  copyleaks_email?: string;
  copyleaks_api_key?: string;
  domain?: string;  // "drosophila-genetics" | "mouse-mammalian" | "cancer-biology" | etc.
}
```

4b. Add domain selection to `/paper-lab` command:
```
/paper-lab
→ 1. Serper API key
→ 2. Copyleaks email
→ 3. Copyleaks API key
→ 4. Domain: [drosophila-genetics / mouse-mammalian / cancer-biology / neuroscience / c-elegans / general]
→ 5. Show all
→ 6. Delete all
```

4c. Auto-detect domain if not configured:
```typescript
function detectDomain(text: string): string {
  if (/drosophila|flies?\s|GAL4|UAS|MARCM|neuroblast/i.test(text)) return "drosophila-genetics";
  if (/mouse|mice|mus musculus|C57BL|knockout.*mouse/i.test(text)) return "mouse-mammalian";
  if (/cancer|tumor|xenograft|oncogene|metastasis/i.test(text)) return "cancer-biology";
  if (/c\.?\s*elegans|nematode|worm/i.test(text)) return "c-elegans";
  if (/neuron|synapse|cortex|hippocamp/i.test(text)) return "neuroscience";
  return "general-biology";
}
```

4d. In `extensions/index.ts`, load the domain from config and pass to `loadLexicon` + `buildSystemInjection`:
```typescript
const config = loadConfig();
const domain = config.domain ?? "general-biology";
const lex = loadLexicon(ROOT, domain);
const injection = buildSystemInjection(lex, domain);
```

**Verify**: `/paper-lab` shows domain selector. Changing domain changes the system prompt.

### Step 5: Update pipeline prompts
**File**: `src/pipeline.ts`

5a. In `pipelineWrite`, replace hardcoded Drosophila rules with dynamic domain info:
```typescript
export async function pipelineWrite(description: string, pi: ExtensionAPI): Promise<void> {
  const domain = loadConfig().domain ?? "general-biology";
  const lex = loadLexicon(ROOT, domain);
  // Build domain-specific instructions from lex.domain
  const domainRules = buildDomainPromptRules(lex);
  // ... use domainRules in the prompt instead of hardcoded Drosophila rules
}
```

5b. In `buildCiteMarkPrompt`, remove the hardcoded Drosophila reference in STEP 1 (rewrite instructions). The system prompt already handles voice rules.

**Verify**: `/paper-write` with domain=mouse generates text about mice, not Drosophila.

### Step 6: Update tool descriptions
**File**: `src/tools.ts`

6a. Line 85: `"Rewrite a passage to remove AI-tells and Drosophila-voice violations."`
→ `"Rewrite a passage to remove AI-tells and domain-specific voice violations."`

6b. Line 110: `"Check a Markdown draft for IMRaD presence and Drosophila-specific Methods/Results content"`
→ `"Check a Markdown draft for IMRaD presence and domain-specific Methods/Results content"`

**Verify**: `grep -ri "drosophila" src/tools.ts` returns nothing.

### Step 7: Update corpus-sources
**File**: `corpus-sources.md`

7a. Keep Drosophila papers (they inform the Drosophila domain profile)
7b. Add papers from other domains:
- Mouse: 2-3 key mouse genetics papers
- Cancer: 2-3 key cancer biology papers
- C. elegans: 2-3 key C. elegans papers
- Neuroscience: 2-3 key neuroscience papers

These inform the domain-specific lexicon entries and voice rules.

### Step 8: Add domain-specific lexicon entries
**Files**: `data/domains/*.yaml`

For each domain, add 20-50 domain-specific lexicon entries:

8a. **Mouse** (`mouse.yaml`):
- `domain_term_mappings`: none needed (mouse doesn't have the neural stem cell issue)
- `nomenclature`: gene italics rules, protein uppercase, transgene format
- `conventions`: C57BL/6J, BALB/c, FVB/N, knockin/knockout notation
- `key_citations`: none that are universally required

8b. **Cancer** (`cancer.yaml`):
- `nomenclature`: cell line format (MCF-7, A549), drug concentration (μM not uM)
- `conventions`: HR (hazard ratio), CI (confidence interval), OS (overall survival)
- `domain_term_mappings`: none needed

8c. **C. elegans** (`c-elegans.yaml`):
- `species`: C. elegans, the worm, worms
- `strains`: N2, CB, etc.
- `balancers`: hT2, nT1, sT1
- `nomenclature`: gene names lowercase italic (e.g. daf-2, let-23)
- `domain_term_mappings`: none needed

8d. **Neuroscience** (`neuroscience.yaml`):
- `nomenclature`: brain region abbreviations (CA1, CA3, V1, S1)
- `conventions`: recording types (patch-clamp, extracellular, two-photon)
- `domain_term_mappings`: none needed

### Step 9: Test each domain
For each domain, verify:
1. `/paper-lab` → set domain → system prompt changes
2. `/paper-write "write an introduction about X"` → text in correct domain style
3. `/paper-cite file.md` → citations work (domain-agnostic)
4. `/paper-rewrite file.md` → rewrite works (domain-agnostic)
5. `ai_detect_statistical` → scores are reasonable for the domain
6. No Drosophila-specific terms leak into other domains

### Step 10: Update README
**File**: `README.md`

Add section:
```markdown
## Supported Domains

| Domain | Key | Species | Key Features |
|---|---|---|---|
| Drosophila genetics | `drosophila-genetics` | D. melanogaster | GAL4, MARCM, balancers, neuroblast |
| Mouse/Mammalian | `mouse-mammalian` | M. musculus | Strains, alleles, ARRIVE 2.0 |
| Cancer biology | `cancer-biology` | — | Cell lines, xenografts, HR/KM |
| Neuroscience | `neuroscience` | — | Brain regions, recording types |
| C. elegans | `c-elegans` | C. elegans | Strains, balancers, gene naming |
| General biology | `general-biology` | — | Minimal rules, no species-specific |

Set via `/paper-lab` → option 4. Auto-detected from text if not set.
```

---

## Execution Order

```
Step 1 (split lexicon) → Step 2 (update type) → Step 3 (rewrite system-injection) →
Step 4 (domain selection) → Step 5 (pipeline prompts) → Step 6 (tool descriptions) →
Step 7 (corpus) → Step 8 (domain lexicon entries) → Step 9 (test) → Step 10 (README)
```

Each step gates the next. After Step 4, the extension works in "general" mode.
After Step 8, all domains work. Step 9 verifies.

## Risk: Backward Compatibility

- Users with existing `drosophila-lexicon.yaml` → the file is split. Add a migration note.
- Users with `domain` not set in config → default to auto-detect (falls back to `general-biology`).
- The `silentRewrite` function uses domain term mappings → with no mappings (general mode), it's a no-op for that feature. AI-tell rewrite still works (common lexicon).
