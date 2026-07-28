# pi-paper-lab

A [pi](https://github.com/earendil-works/pi-coding-agent) extension that writes scientific papers in any biology field. Anti-AI rewrite, automatic Vancouver citations, `.docx` output.

## Install

**1. Install the docx CLI** (macOS / Linux)

```bash
npm install -g bun-docx
```

**Windows (Git Bash):** drop `docx.exe` into `~/.local/bin/`.

**2. Get a Serper API key** at https://serper.dev (2,500 free searches/month).

**3. Install the extension**

```bash
cd ~/.pi/agent/extensions
git clone https://github.com/Aspis0/pi-paper-lab.git
```

**4. Configure**. Inside pi, run `/paper-lab`.

## Use

```
/paper-write "intro on micro-CT imaging in Drosophila cancer cachexia"
/paper-rewrite MyDraft.md
/paper-cite MyDraft.docx
```

`/paper-write` and `/paper-rewrite` start with a study phase: the LLM searches the literature (Serper Scholar, `web_search`) and saves findings to `study-notes.md` next to the draft. The draft then cites the real papers it found.

`/paper-cite` skips the study phase. It operates on existing text and finds citations per-claim.

## Commands

| Command | What it does |
|---|---|
| `/paper-write <description>` | Generate text from a description |
| `/paper-rewrite <file> [instructions]` | Rewrite anti-AI + add citations |
| `/paper-cite <file>` | Add citations to existing draft |
| `/paper-lab` | API keys + domain selection |

## Domains

Domains are YAML files in `data/domains/`. The extension scans the folder at runtime. Adding a domain = creating one file, no code changes.

Built-in: `drosophila-genetics`, `mouse-mammalian`, `cancer-biology`, `c-elegans`, `neuroscience`, `general-biology`.

A YAML needs only `name:` to be valid. Example:

```yaml
name: "Zebrafish"
detect_keywords: [zebrafish, "Danio rerio", ZFIN]
species:
  first_mention: "Danio rerio"
```

## How it works

```
/paper-write "topic"
  → study_topic (search literature, save study-notes.md)
  → write draft (grounded in study notes)
  → ai_detect_statistical (check for AI-tells)
  → find_citation per claim (batch)
  → finalizeDoc → .docx with Vancouver references
```

Two visible pipelines: `/paper-write` and `/paper-rewrite` (full pipeline including rewrite + AI check) and `/paper-cite` (citations only). `/paper-lab` configures API keys and selects the active domain.

## Platform

- macOS: works
- Windows: works (Git Bash)
- Linux: should work

## License

MIT