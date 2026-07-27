# pi-paper-lab

A [pi coding agent](https://github.com/earendil-works/pi-coding-agent) extension for writing *Drosophila* genetics papers in the style of eLife, Genetics, G3, PLOS Genetics, Development, and Nature Methods.

## Features

- **Anti-AI rewrite** — removes AI-tell phrases, calibrates hedging, enforces Drosophila voice (neuroblast not "neural stem cell", GAL4 not Gal4, MARCM → Lee & Luo 1999, RRIDs, balancers)
- **Automatic citations** — LLM identifies claims, searches Serper Scholar + CrossRef, assigns Vancouver-style `[N]` citations with DOIs
- **Word output** — generates `.docx` with superscript `[N]` citations, cross-reference hyperlinks (click [3] → jumps to ref 3), and a References section
- **AI detection** — 7 statistical features (burstiness, n-gram entropy, lexical diversity, punctuation, function words, starter diversity, lexical sophistication) + lexicon-tell scoring. Optional Copyleaks API integration.

## Install

### 1. Install bun-docx CLI

**macOS:**
```bash
npm install -g bun-docx
# or with bun:
bun install -g bun-docx
```

**Windows (Git Bash):**
```bash
mkdir -p ~/.local/bin
# download docx.exe to ~/.local/bin/
```

### 2. Get a Serper.dev API key

Sign up at https://serper.dev (free tier: 2,500 searches/month).

### 3. Install the extension

```bash
cd ~/.pi/agent/extensions
git clone https://github.com/gualt/pi-paper-lab.git
```

### 4. Configure API keys

Inside pi, run:
```
/paper-lab
```
This opens an interactive menu to set your Serper and Copyleaks API keys.

## Usage

### Add citations to a draft

```
/paper-cite C:/Users/gualt/Desktop/MyPaper.docx
```
or
```
/paper-cite ~/Desktop/MyPaper.md
```

The pipeline:
1. Extracts text (if .docx, uses `docx read`)
2. LLM identifies claims needing citations → `[CITE:topic]` markers
3. Batch search: Serper Scholar + CrossRef for each claim
4. Assigns `[N](doi:10.xxxx)` inline
5. Generates Vancouver bibliography (References section)
6. Creates `.docx` with superscript `[N]` + cross-reference hyperlinks

### Rewrite + add citations

```
/paper-rewrite ~/Desktop/MyPaper.md "tighten the introduction, remove hedging"
```

The pipeline:
1. Silent rewrite (anti-AI lexicon → removes AI-tells, calibrates voice)
2. AI detection → rewrite loop (detect → rewrite → re-detect)
3. Everything from `/paper-cite` above

### Manage API keys

```
/paper-lab
```

## Commands

| Command | Description |
|---|---|
| `/paper-cite <file>` | Add citations to a draft (.md or .docx) |
| `/paper-rewrite <file> [instructions]` | Rewrite anti-AI + add citations |
| `/paper-lab` | Manage API keys interactively |

## LLM Tools (auto-registered)

| Tool | Description |
|---|---|
| `find_citation(topic)` | Search Serper Scholar + CrossRef |
| `crossref_lookup(doi)` | Fetch DOI metadata → Vancouver citation |
| `scholar_search(query)` | Direct Serper Scholar search |
| `verify_citation(claim, doi)` | Check if a DOI supports a claim |
| `ai_detect(text)` | AI detection (Copyleaks API or local) |
| `anti_ai_score(text)` | Lexicon-based AI-tell score |
| `claim_strength_check(sentence)` | Grade claim strength (n, p, effect size) |
| `sloppy_scan(text)` | Detect vague quantifiers, causal overclaim |

## Platform Support

- **macOS** — fully supported (Homebrew, npm global, bun)
- **Windows** — fully supported (Git Bash, `~/.local/bin/docx.exe`)
- **Linux** — should work (requires `docx` CLI on PATH)

## Architecture

```
pi-paper-lab/
├── extensions/index.ts          # entry point: commands + tools + system prompt
├── src/
│   ├── anti-ai-lexicon.ts       # 400+ YAML lexicon → score + silentRewrite
│   ├── statistical-ai-detector.ts  # 7 statistical features
│   ├── ai-detector.ts           # Copyleaks API + local fallback
│   ├── pipeline.ts              # /paper-cite + /paper-rewrite pipelines
│   ├── citations.ts             # markClaims + resolveCitation + bibliography
│   ├── crossref.ts              # CrossRef REST API + normalizeWork
│   ├── serper-scholar.ts        # Serper.dev Scholar API client
│   ├── config.ts                # /paper-lab API key manager
│   ├── system-injection.ts      # Drosophila voice prompt builder
│   ├── word-builder.ts          # Markdown → .docx via bun-docx CLI
│   ├── claim-strength.ts        # n/p/replicates grading
│   ├── sloppy-detector.ts       # vague quantifier detection
│   ├── cite-verify.ts           # claim ↔ reference verification
│   ├── commands.ts              # internal helper commands
│   ├── tools.ts                 # LLM tool registration
│   ├── footnote-injector.ts     # [N] → Word footnote (placeholder)
│   └── imrad.ts                 # IMRaD structural validator
├── data/drosophila-lexicon.yaml # 400+ lexicon entries
├── tests/                       # 67 unit tests
└── package.json
```

## License

MIT
