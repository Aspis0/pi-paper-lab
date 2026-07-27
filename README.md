# pi-paper-lab

A [pi coding agent](https://github.com/earendil-works/pi-coding-agent) extension for writing scientific papers in any biology field.

## Features

- **Anti-AI rewrite** — removes AI-tell phrases, calibrates hedging, enforces scientific voice (per domain YAML)
- **Automatic citations** — LLM identifies claims, searches Serper Scholar + CrossRef, assigns Vancouver-style `[N]` citations with DOIs
- **Word output** — generates `.docx` with superscript `[N]` citations, cross-reference hyperlinks, and a References section
- **AI detection** — 7 statistical features (burstiness, n-gram entropy, lexical diversity, etc.) + lexicon-tell scoring. Optional Copyleaks API.
- **Domain-agnostic** — data-driven via YAML profiles. Zero hardcoded domain names.

## Domains

Domains are YAML files in `data/domains/`. **Adding a domain = creating one file. Zero code changes.**

### Built-in domains (discovered at runtime)

The extension scans `data/domains/*.yaml` on startup. Current domains:

| Key | Name | Key features |
|---|---|---|
| `drosophila-genetics` | Drosophila genetics | GAL4, MARCM, balancers, neuroblast, BDSC, ARRIVE-exempt |
| `mouse-mammalian` | Mouse / Mammalian | MGI nomenclature, ARRIVE 2.0 essentials, JAX strains |
| `cancer-biology` | Cancer biology | Cell lines (MCF-7, A549), MIQE, Kaplan-Meier, HR |
| `c-elegans` | C. elegans | Brenner nomenclature, CGC strains, balancers (hT2, nT1) |
| `neuroscience` | Neuroscience | Patch-clamp, two-photon, brain regions, GCaMP |
| `general-biology` | General biology | Minimal — only common rules |

### Create a custom domain

Create `data/domains/my-field.yaml`:

```yaml
name: "My research field"
detect_keywords: [myfield, "my model"]
nomenclature:
  - rule: "My specific naming rule"
voice:
  methods: "HIGHEST assertiveness. Detail strain, sex, age."
```

Restart pi or `/reload`. The new domain appears in `/paper-lab` → option 4.

## Install

### 1. Install bun-docx CLI

**macOS:**
```bash
npm install -g bun-docx
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
git clone https://github.com/Aspis0/pi-paper-lab.git
```

### 4. Configure

Inside pi:
```
/paper-lab
```
Interactive menu for Serper API key + domain selection.

## Commands

| Command | Description |
|---|---|
| `/paper-cite <file>` | Add citations to a draft (.md or .docx) |
| `/paper-rewrite <file> [instructions]` | Rewrite anti-AI + add citations |
| `/paper-write <description>` | Generate new text from a description |
| `/paper-lab` | Manage API keys + domain selection |

## Usage

```
/paper-write "write the introduction for a paper about cancer cachexia"
/paper-rewrite MyDraft.md
/paper-cite MyDraft.docx
```

### Study phase

`/paper-write` and `/paper-rewrite` start with a **study phase**: the LLM
searches the literature (Serper Scholar, web_search, fetch_content) to
ground the draft in real papers. Findings are saved to `study-notes.md`
next to the draft.

```
~/Desktop/paper-write-output.md            ← the draft
~/Desktop/paper-write-output.study-notes.md ← the study notes (topic, key concepts, candidate refs)
```

If all searches fail, the pipeline proceeds with `[CITATION NEEDED]`
markers — the study phase NEVER blocks.

## Platform Support

- **macOS** — fully supported (Homebrew, npm global, bun)
- **Windows** — fully supported (Git Bash, `~/.local/bin/docx.exe`)
- **Linux** — should work (requires `docx` CLI on PATH)

## Architecture

```
pi-paper-lab/
├── extensions/index.ts          # entry: commands + tools + system prompt
├── src/
│   ├── domains.ts               # discoverDomains, detectDomain (filesystem-driven)
│   ├── system-injection.ts      # domain-driven voice prompt builder
│   ├── anti-ai-lexicon.ts       # 400+ lexicon + silent rewrite
│   ├── pipeline.ts              # /paper-cite + /paper-rewrite + /paper-write
│   ├── citations.ts             # markClaims + bibliography
│   ├── crossref.ts              # CrossRef API
│   ├── serper-scholar.ts        # Serper API
│   ├── config.ts                # /paper-lab API key + domain manager
│   ├── statistical-ai-detector.ts
│   └── ...
├── data/
│   ├── lexicon-common.yaml      # SHARED (AI-tells, fillers, voice, numbers)
│   └── domains/                 # YAML profiles, one per domain
│       ├── drosophila-genetics.yaml
│       ├── mouse-mammalian.yaml
│       ├── cancer-biology.yaml
│       ├── c-elegans.yaml
│       ├── neuroscience.yaml
│       └── general-biology.yaml
└── tests/                       # 66 unit tests
```

## License

MIT