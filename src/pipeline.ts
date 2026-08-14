// src/pipeline.ts
// Two automatic pipelines:
// 1. /paper-cite <file>    → LLM identifies claims, batch search, add citations
// 2. /paper-rewrite <file> → silent rewrite (anti-AI) + LLM cite-mark + batch search + citations
//
// Both use the active LLM for cite-mark (not regex) and batch find_citation.
// The old /bio-scan, /cite-mark, /cite-resolve etc. are hidden (internal only).

import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, isAbsolute } from "node:path";
import { homedir } from "node:os";
import { loadConfig } from "./config.ts";
import { fileURLToPath } from "node:url";

// Ensure docx CLI (bun-docx) is on PATH — works on Windows and macOS
const pathDelimiter = process.platform === "win32" ? ";" : ":";
const extraBins = [
  join(homedir(), ".local", "bin"),       // Windows: manual install
  join(homedir(), ".npm-global", "bin"),  // macOS: npm global
  "/usr/local/bin",                       // macOS: Homebrew Intel
  "/opt/homebrew/bin",                    // macOS: Homebrew ARM
];
if (!process.env.PATH?.includes("local/bin") && !process.env.PATH?.includes("homebrew")) {
  process.env.PATH = [...extraBins, process.env.PATH ?? ""].join(pathDelimiter);
}
import { loadLexicon, silentRewrite, scoreText } from "./anti-ai-lexicon.ts";
import { resolveCitation, generateBibliography, formatBibliography, CITE_MARKER, CITE_WITH_DOI } from "./citations.ts";
import { classifyFindings, formatClarifyPrompt, serialiseClarifications, type ClarifyItem } from "./clarify.ts";
import { lookupDoi, type CrossRefWork } from "./crossref.ts";
import { crossrefToCsl } from "./csl/adapters/crossrefToCsl.ts";
import { formatBibliography as formatCslBibliography } from "./csl/formatBibliography.ts";
import { cslItemsToWordSources } from "./word-live-builder.ts";
import type { CslItem } from "./csl/schema.ts";
import { detectAI, detectRewriteLoop, formatDetectionReport, type AIDetectionResult } from "./ai-detector.ts";
import { buildWordLive, type WordLiveBuilderSource } from "./word-live-builder.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

// === Shell command the LLM runs to call finalizeDoc() ===
//
// History: this used to embed `node --experimental-strip-types -e "import('.../pipeline.ts')..."`,
// which fails on Windows + node_modules-installed extensions because:
//   1. ESM `import()` rejects `C:/...` absolute paths (needs file:// URL).
//   2. Node refuses to type-strip `.ts` files inside `node_modules/`.
// The dedicated CLI in bin/finalize.mjs uses jiti to bypass both.
//
// We emit a self-discovering command that prefers the global binary (npm i
// creates it on PATH) and falls back to the locally-installed package's
// bin/finalize.mjs (always present after `pi install npm:pi-paper-lab`).
function finalizeCommand(targetPath: string): string {
  const target = JSON.stringify(targetPath); // safe quoting for spaces/special chars
  // Prefer the *host agent dir* (Paperlab Studio sets PI_CODING_AGENT_DIR to
  // %APPDATA%/PaperlabStudio/agent with a vendored copy). Never require the
  // user's coding ~/.pi profile or a network npx fetch for the product path.
  // Order:
  //   1. $PI_CODING_AGENT_DIR/npm/node_modules/pi-paper-lab (Paperlab closed)
  //   2. paper-lab-finalize on PATH (optional)
  //   3. legacy ~/.pi install (dev only)
  //   4. npx last resort (dev only; avoid in packaged Paperlab)
  return [
    `if [ -n "$PI_CODING_AGENT_DIR" ] && [ -f "$PI_CODING_AGENT_DIR/npm/node_modules/pi-paper-lab/bin/finalize.mjs" ]; then`,
    `  node "$PI_CODING_AGENT_DIR/npm/node_modules/pi-paper-lab/bin/finalize.mjs" ${target}`,
    `elif command -v paper-lab-finalize >/dev/null 2>&1; then`,
    `  paper-lab-finalize ${target}`,
    `elif [ -f "$HOME/.pi/agent/npm/node_modules/pi-paper-lab/bin/finalize.mjs" ]; then`,
    `  node "$HOME/.pi/agent/npm/node_modules/pi-paper-lab/bin/finalize.mjs" ${target}`,
    `else`,
    `  npx -y paper-lab-finalize ${target}`,
    `fi`,
  ].join("\n   ");
}


// When re-reading a .docx that was already processed:
// 1. Parse the References section to extract DOIs per [N]
// 2. Replace bare [N] / <sup>[N]</sup> in text with [N](doi:...)
// 3. Strip the References section (finalizeDoc will regenerate it)
// This PRESERVES old citations so new text can be added without losing them.
export function cleanExtractedDocx(text: string): string {
  let cleaned = text;

  // 1. Extract the References section (any heading format)
  const refsMatch = cleaned.match(/(?:---+\s*\n+)?#{1,3}\s*References\s*\n([\s\S]*?)$/i)
    ?? cleaned.match(/(?:---+\s*\n+)?\*{0,2}References\*{0,2}\s*\n([\s\S]*?)$/i);

  const doiMap = new Map<number, string>();
  if (refsMatch) {
    const refsText = refsMatch[1];
    // Parse each reference line: "N. Authors. Title. Journal. Year. doi:10.xxxx"
    // Split on one-or-more newlines so we recover entries whether the docx
    // read-back preserved single or double line breaks. Each Vancouver
    // reference is a single line in the format finalizeDoc writes.
    const refLines = refsText.split(/\n+/).map((l) => l.trim()).filter(Boolean);
    for (const line of refLines) {
      // Accept both "[N] Author..." (what finalizeDoc writes) and the legacy
      // "N. Author..." form.
      const numMatch = line.match(/^\s*(?:\[(\d+)\]|(\d+)\.)\s/);
      const num = numMatch ? (numMatch[1] ?? numMatch[2]) : null;
      // Angle-bracket or https form — captures full DOI including internal
      // parentheses (e.g. 10.1016/S1470-2045(10)70218-7).
      const angleMatch = line.match(/<doi:\s*(10\.[^\s>]+?)\s*>/i)
        ?? line.match(/https?:\/\/(?:dx\.)?doi\.org\/(10\.[^\s>\]]+)/i);
      let doi = null;
      if (angleMatch) {
        doi = angleMatch[1].replace(/[\s,;.<>]+$/, "");
      } else {
        // Plain form `doi:10.x/...` — match `10.` plus everything up to the
        // first whitespace or `]`, preserving internal parentheses in real
        // DOIs (a DOI never contains a space and stops at line end). This
        // fixes the previous truncation at `)` that dropped paren-DOIs.
        const plainMatch = line.match(/doi:\s*(10\.[^\s\]]+)/i);
        // BUG 5 fix: strip trailing punctuation (period/comma) the regex captures
        // when a DOI ends a sentence — otherwise CrossRef lookup 404s.
        doi = plainMatch ? plainMatch[1].replace(/[\s,;.<>]+$/, "") : null;
      }
      // Previous code indexed `doiMatch[1]` on a STRING (returning its 2nd
      // character) — use the resolved DOI directly.
      if (num && doi) {
        doiMap.set(parseInt(num), doi);
      }
    }
  }

  // 2. Strip the References section entirely (finalizeDoc regenerates it)
  cleaned = cleaned.replace(/\n*---+\n*#{1,3}\s*References[\s\S]*$/i, "");
  cleaned = cleaned.replace(/\n*#{1,3}\s*References[\s\S]*$/i, "");
  cleaned = cleaned.replace(/\n*---+\n*\*{0,2}References\*{0,2}[\s\S]*$/i, "");

  // 3. Replace <sup>[N]</sup> → [N](<doi:...>) if we have the DOI, else just [N].
  // Hostile-audit fix #1: emit the ANGLE-BRACKET form so the main
  // finalizeDoc regex (which uses `[^)>\n]+` for the plain form and would
  // truncate parenthesised DOIs at the first `)`) can capture the full DOI.
  // The angle form `<doi:...>` is delimited by `>` and is unambiguous.
  cleaned = cleaned.replace(/<sup>\[(\d+)\]<\/sup>/g, (m, num) => {
    const doi = doiMap.get(parseInt(num));
    return doi ? `[${num}](<doi:${doi}>)` : `[${num}]`;
  });

  // 4. Replace bare [N] (not followed by '(') → [N](<doi:...>) if we have the DOI
  cleaned = cleaned.replace(/\[(\d+)\](?!\()/g, (m, num) => {
    const doi = doiMap.get(parseInt(num));
    return doi ? `[${num}](<doi:${doi}>)` : `[${num}]`;
  });

  // 5. Clean up multiple blank lines
  cleaned = cleaned.replace(/\n{3,}/g, "\n\n");
  return cleaned.trim() + "\n";
}

// === Instruction-fulfillment check (pipelineRewrite) ===
//
// The AI detect-rewrite loop (detectRewriteLoop) only measures AI-tells
// (burstiness, hedging, lexicon). It CANNOT see the user's specific
// structural/content requests. This heuristic closes that gap: it greps
// the rewritten draft for the concrete things the user named and returns
// a list of unmet requests. The pipeline surfaces these to the LLM exactly
// like flagged AI sentences, so the model fixes them instead of declaring
// "done" while the requested changes are absent.
//
// Heuristics are intentionally narrow — only the phrasings users actually
// write about. Each rule requires BOTH an instruction keyword AND a
// draft-state keyword, bounding false positives.
export function checkInstructionFulfillment(text: string, instructions: string): string[] {
  const warnings: string[] = [];
  const instr = instructions.toLowerCase();
  const lower = text.toLowerCase();

  // 1. "Future directions" requested to be removed → draft must not contain it.
  if (/future[- ]direction/.test(instr)) {
    if (/future[- ]directions/.test(lower)) {
      warnings.push(
        `Your instructions ask to remove "Future directions", but the draft still contains a Future directions section/heading. Delete it (papers do not carry a future-directions list).`,
      );
    }
  }

  // 2. RNA-seq → replace with a blank/placeholder, not a real result.
  if (/rna[- ]?seq/.test(instr)) {
    const hasRealResult = /rna[- ]?seq[^.\n]*\b(is underway|will test|compared|showed|revealed|found|indicate|demonstrate|identified|analys)/i.test(text);
    const hasPlaceholder = /rna[- ]?seq results?\s*(will be|to be)?\s*inserted here|\[rna[- ]?seq/i.test(text);
    const wantsBlank = /blank|placeholder|leave|when available/.test(instr);
    if (wantsBlank && hasRealResult && !hasPlaceholder) {
      warnings.push(
        `Your instructions ask to replace the RNA-seq result with a blank/placeholder, but the draft still contains a substantive RNA-seq finding sentence. Replace it with a placeholder such as "[RNA-seq results will be inserted here when available]".`,
      );
    }
  }

  // 3. First Results paragraph reads like a Methods copy.
  // Hostile-audit fix #8: the previous rule hard-coded a few cachexia-paper
  // phrases ("shifted to 18 °C", "n = 5 flies, ..."), so it could never fire
  // for any other manuscript. This version is document-agnostic: it builds
  // 6-grams from the Methods section and flags the first Results paragraph
  // if it shares ≥2 long phrases with Methods (i.e. copy-paste, regardless
  // of domain).
  if (/method/.test(instr) && /(copy|duplicate|like a method|rewrite|same as method)/.test(instr)) {
    const methods = text.match(/##\s*methods[\s\S]*?(?=##\s*(?:results|discussion))/i);
    const results = text.match(/##\s*results[\s\S]*?(?=##\s*discussion)/i);
    if (methods && results) {
      const firstPara = results[0].split(/\n\n+/)[1] ?? "";
      const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
      const mTokens = norm(methods[0]).split(" ").filter(Boolean);
      const methodsNgrams = new Set<string>();
      for (let i = 0; i + 6 <= mTokens.length; i++) {
        methodsNgrams.add(mTokens.slice(i, i + 6).join(" "));
      }
      const fTokens = norm(firstPara).split(" ").filter(Boolean);
      let shared = 0;
      const seen = new Set<string>();
      for (let i = 0; i + 6 <= fTokens.length; i++) {
        const ng = fTokens.slice(i, i + 6).join(" ");
        if (methodsNgrams.has(ng) && !seen.has(ng)) { shared++; seen.add(ng); }
      }
      if (shared >= 2) {
        warnings.push(
          `Your instructions note the first Results paragraph reads like a Methods copy. It still reuses method phrasing — the first Results paragraph shares ${shared} long phrases (6-word matches) with the Methods section. Rewrite it as a results-framed opening and point to Methods for the full design.`,
        );
      }
    }
  }

  return warnings;
}

// === Pipeline 1: /paper-cite ===
// Extract text from .docx using docx CLI, or read .md directly
function readInputFile(path: string): string {
  if (/\.docx$/i.test(path)) {
    try {
      const result = execFileSync("docx", ["read", path], { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
      // Check if docx read returned an error JSON
      if (result.trim().startsWith("{")) {
        try {
          const parsed = JSON.parse(result.trim());
          if (parsed.error) {
            throw new Error(`File is corrupted or not a valid .docx: ${parsed.error}. Try a different file or re-export from Word.`);
          }
        } catch (e) {
          if (e instanceof SyntaxError) return result; // valid text that happens to start with {
          throw e;
        }
      }
      return cleanExtractedDocx(result);
    } catch (err: any) {
      if (err.message?.includes("corrupted")) throw err;
      throw new Error(`Cannot read .docx file. Make sure it exists and is a valid Word document. Error: ${err?.message}`);
    }
  }
  return readFileSync(path, "utf8");
}

export async function pipelineCite(
  inputPath: string,
  pi: ExtensionAPI,
  instructions: string = "",
  strict: boolean = false,
): Promise<void> {
  // If .docx, extract to .md first so the LLM works on Markdown
  let workPath = inputPath;
  if (/\.docx$/i.test(inputPath)) {
    const mdPath = inputPath.replace(/\.docx$/i, ".md");
    // Prefer an existing DOI-bearing .md over re-extracting the .docx so we
    // don't clobber the source of truth or lose already-resolved citations.
    if (existsSync(mdPath) && /\[(\d+)\]\(<doi:/.test(readFileSync(mdPath, "utf-8"))) {
      workPath = mdPath;
    } else {
      writeFileSync(mdPath, readInputFile(inputPath), "utf-8");
      workPath = mdPath;
    }
  }
  const text = readFileSync(workPath, "utf8");
  const existingCitations = (text.match(CITE_WITH_DOI) ?? []).length;
  const existingMarkers = (text.match(CITE_MARKER) ?? []).length;

  // Backend-aware step description (exa, serper, both, auto)
  const backend = loadConfig().citation_backend ?? "serper";
  const searchDesc: Record<string, string> = {
    serper: "search Serper Scholar + CrossRef in batch",
    exa: "search Exa.ai publications + CrossRef in batch",
    both: "search Serper Scholar AND Exa.ai in parallel, then CrossRef in batch",
    auto: "search Exa.ai first, fall back to Serper Scholar if Exa fails, then CrossRef in batch",
  };

  const header = [
    `=== /paper-cite pipeline ===`,
    `File: ${inputPath}`,
    `Existing citations: ${existingCitations}`,
    `Unresolved [CITE:topic] markers: ${existingMarkers}`,
    `Citation backend: ${backend}`,
    strict ? `STRICT MODE: do NOT modify surrounding prose — only insert [N](<doi:...>) markers.` : "",
    instructions ? `User instructions: ${instructions}` : "",
    ``,
    `Step 1: I will identify claims that need citations (LLM cite-mark).`,
    `Step 2: For each claim, I will ${searchDesc[backend]}.`,
    `Step 3: I will assign [N](doi:...) inline.`,
    `Step 4: I will generate the References section and produce a .docx.`,
  ].join("\n");

  const prompt = buildCiteMarkPrompt(workPath, text, "", false, instructions);
  pi.sendUserMessage(`${header}\n\n${prompt}`, { deliverAs: "followUp" });
}

// === Pipeline 2: /paper-rewrite ===
// Silent rewrite + AI detect-rewrite loop (detect → rewrite AI sentences → re-detect → repeat)
// Then LLM cite-mark + batch search + citations + Word
export async function pipelineRewrite(
  inputPath: string,
  rewriteInstructions: string,
  pi: ExtensionAPI,
): Promise<void> {
  // If .docx, extract to .md first — BUT prefer an existing DOI-bearing .md
  // (e.g. the one finalizeDoc was run on) so we don't clobber the source of
  // truth with a DOI-stripped docx extraction, and so the LLM reuses the
  // already-resolved [N](<doi:...>) markers instead of backfilling them.
  let workPath = inputPath;
  if (/\.docx$/i.test(inputPath)) {
    const mdPath = inputPath.replace(/\.docx$/i, ".md");
    if (existsSync(mdPath) && /\[(\d+)\]\(<doi:/.test(readFileSync(mdPath, "utf-8"))) {
      workPath = mdPath; // reuse the faithful DOI-bearing source
    } else {
      writeFileSync(mdPath, readInputFile(inputPath), "utf-8");
      workPath = mdPath;
    }
  }
  const text = readFileSync(workPath, "utf8");
  const lex = loadLexicon(ROOT);

  // Step 1: AI detect-rewrite loop
  const { text: rewritten, iterations, finalScore, initialScore, source } =
    await detectRewriteLoop(text, lex, { maxIterations: 3 });

  // Step 1b: instruction-fulfillment check — the AI-tell loop above cannot
  // see the USER's specific structural/content requests (e.g. "remove Future
  // directions", "RNA-seq -> blank", "first Results paragraph is a Methods
  // copy"). Surface any unmet instructions so the LLM fixes them, exactly
  // like flagged AI sentences.
  const instructionWarnings = rewriteInstructions
    ? checkInstructionFulfillment(rewritten, rewriteInstructions)
    : [];

  // If still AI after loop, identify flagged sentences for the LLM
  const finalDetection = await detectAI(rewritten, lex);

  const rewrittenPath = workPath.replace(/\.md$/, ".rewritten.md");
  writeFileSync(rewrittenPath, rewritten, "utf-8");

  const header = [
    `=== /paper-rewrite pipeline ===`,
    `File: ${inputPath}`,
    `Working draft: ${workPath}`,
    `Rewrite instructions: ${rewriteInstructions || "(default: anti-AI sloppy cleanup)"}`,
    ``,
    `Step 1: AI detect-rewrite loop DONE (${iterations} iterations)`,
    `  Detection source: ${source}`,
    `  AI score: ${initialScore}% → ${finalScore}%`,
    `  ${finalDetection.isAI ? "⚠️ Still AI-flagged — LLM must rewrite flagged sentences." : "✅ Human-like."}`,
    `  Rewritten draft: ${rewrittenPath}`,
    instructionWarnings.length > 0
      ? `  ⚠️ INSTRUCTION CHECK: ${instructionWarnings.length} of your specific requests appear UNMET (see below).`
      : `  ✅ Instruction check: all detectable requests appear satisfied.`,
    ``,
    `Step 2: LLM cite-mark + batch search + citations + Word...`,
  ].join("\n");

  // Build prompt with flagged sentences for the LLM to rewrite
  const aiFlaggedBlock = finalDetection.isAI && finalDetection.flaggedSentences.length > 0
    ? [
        ``,
        `WARNING: AI detection (${finalDetection.source}) still flags this text as AI-generated (${finalScore}%).`,
        `The following sentences have the highest AI-tell scores:`,
        ...finalDetection.flaggedSentences.slice(0, 5).map((s, i) =>
          `  ${i + 1}. "${s.sentence.slice(0, 100)}..." (score: ${s.score})`
        ),
        ``,
        `Before adding citations, REWRITE these sentences to sound more human.`,
        `Vary sentence length. Use specific, concrete language. Remove hedging.`,
      ].join("\n")
    : "";
  const instructionBlock = instructionWarnings.length > 0
    ? [
        ``,
        `INSTRUCTION CHECK — your rewrite instructions were NOT fully satisfied:`,
        ...instructionWarnings.map((w, i) => `  ${i + 1}. ${w}`),
        ``,
        `Fix these BEFORE adding citations. They are structural/content issues, not AI-tells.`,
      ].join("\n")
    : "";
  const flaggedInfo = [aiFlaggedBlock, instructionBlock].filter(Boolean).join("\n");

  const prompt = buildCiteMarkPrompt(rewrittenPath, rewritten, rewriteInstructions, true, rewriteInstructions);
  pi.sendUserMessage(`${header}${flaggedInfo}\n\n${prompt}`, { deliverAs: "followUp" });
}

// === Pipeline 3: /paper-write ===

/**
 * Resolve the default output path for pipelineWrite.
 * M4 audit HIGH-1/HIGH-3: structural words ("write", "the", "section", ...)
 * are filtered so the slug reflects CONTENT, not prompt scaffolding.
 * Falls back to "paper.md" if no usable token. When outputPath is relative,
 * it's joined with outputDir (not resolved against cwd).
 * Exported for testing.
 */
export function resolveDefaultOutPath(
  description: string,
  opts: { outputDir?: string; outputPath?: string } = {},
): string {
  const outputDir = opts.outputDir ?? join(process.cwd(), "paper-write-out");
  // MED-1 fix: if outputPath is relative, join with outputDir instead of
  // silently resolving against cwd (which ignores outputDir entirely).
  if (opts.outputPath) {
    return isAbsolute(opts.outputPath) ? opts.outputPath : join(outputDir, opts.outputPath);
  }
  return join(outputDir, `${slugifyDescription(description)}.md`);
}

// Stop words for the filename slug. These structural/grammatical words
// must NOT appear in the slug because they do not identify content and
// cause collisions (e.g. "Write methods about X" vs "Write results about Y"
// would both map to "write-about" → same file).
const SLUG_STOP_WORDS = new Set([
  "the", "and", "for", "about", "with", "that", "this", "from",
  "your", "have", "into", "over", "than", "their", "there", "which",
  "section", "introduction", "paragraph", "topic", "paper", "essay",
  "comprehensive", "detailed", "long", "short", "new", "some", "more",
  "also", "will", "can", "use", "make", "need", "want", "please", "text",
  "generate", "create", "produce", "draft", "part", "here", "describe",
  "following", "below", "after", "before", "while", "when", "where",
  "write",
]);

function slugifyDescription(description: string): string {
  const tokens = description
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/) // Split only on whitespace, preserve hyphenated compounds
    .filter((w) => w.length >= 3 && !SLUG_STOP_WORDS.has(w))
    .slice(0, 5);
  if (tokens.length === 0) return "paper";
  return tokens.join("-");
}
// User describes what to write → LLM generates draft → AI check → cite → finalize
export async function pipelineWrite(
  description: string,
  pi: ExtensionAPI,
  opts?: { outputPath?: string; outputDir?: string },
): Promise<void> {
  // v0.7.x: the default outPath is derived from the `description`
  // itself (slug from the first 3-5 alphanumeric tokens). This way
  // multiple pipelineWrite calls with different descriptions produce
  // different files WITHOUT requiring the LLM to pass --output. The
  // LLM is free to pass --output <path> to override the default; we
  // also accept outputDir to change the destination directory.
  // The previous hardcoded `paper-write-output.md` was wrong: a
  // user running two pipelineWrite calls would silently clobber the
  // first output. The previous "paper.md inside paper-write-out/" was
  // also wrong for the same reason. Both versions required the LLM
  // to remember to pass --output. This version does NOT.
  // v0.7.6: parse --static / --no-live out of the description so the
  // documented `/paper-write "topic" --static` flag actually flows through to
  // the finalize step (appended as --no-live below). The flag is stripped
  // from the description so it does not pollute the filename slug or the
  // prompt shown to the LLM.
  const noLive = /(?:^|\s)--(?:no-live|static)(?=\s|$)|libreoffice|google docs|apple pages/i.test(description);
  const cleanDesc = description.replace(/\b(?:--no-live|--static)\b/gi, "").replace(/\s+/g, " ").trim();
  const outPath = resolveDefaultOutPath(cleanDesc, {
    outputDir: opts?.outputDir,
    outputPath: opts?.outputPath,
  });
  const notesPath = outPath.replace(/\.md$/, ".study-notes.md");

  const prompt = [
    `Write new text for a biology paper based on this description:`,
    ``,
    `"${cleanDesc}"`,
    ``,
    `Follow the domain-specific voice rules in your system prompt (species, nomenclature, reporting standards are all defined by the active domain YAML).`,
    `- Reporting: n=X per group, statistical test, p-value, effect size, 95% CI.`,
    `- No AI-tells: no "delve", "leverage", "elucidate", "crucially", "notably".`,
    `- Paragraphs of 3-6 sentences. Vary sentence length.`,
    ``,
    `If you want to write to a SPECIFIC file (e.g. for multiple sections of the same paper), pass --output <path>. The default file is ${outPath.replace(/\\/g, "/")} — it is auto-derived from the description so two pipelineWrite calls with different descriptions produce different files without you having to remember --output.`,
    ``,
    `Do these steps ALL IN ONE TURN:`,
    ``,
    `STEP 0 — STUDY (before writing anything):`,
    `   a) Call find_citation 3-5 times IN PARALLEL with different query variants of the description.`,
    `      Variants: as-is, reversed word order, with synonyms (imaging<->characterization), narrower scope, "<desc> review".`,
    `   b) Optionally call web_search or fetch_content for broader context or full abstracts.`,
    `   c) If ALL searches fail: note it in study-notes.md, mark uncertain claims [CITATION NEEDED], proceed to STEP 1 anyway (NEVER block).`,
    `   d) Write study-notes.md to ${notesPath.replace(/\\/g, "/")}: with sections: Topic summary, Key concepts (5-10 terms), Standard methods, Voice/structure observations, Candidate references (numbered, with DOIs), Specific findings (each tagged [ref N]).`,
    `   e) Report number of papers reviewed.`,
    ``,
    `STEP 1 — WRITE: Use study-notes.md + system prompt voice rules. Ground every claim in study notes (cite paper N from candidate list). Use DOIs from study-notes.md, NOT invented ones. Write to ${outPath.replace(/\\/g, "/")}.`,
    `   CRITICAL: Write ONLY the body text (paragraphs). DO NOT include any "References" section — the bibliography is added by finalizeDoc in STEP 4. DO NOT include any inline numbered references like [1], [2] in the body — those are added by STEP 3.`,
    `   CRITICAL: Follow the user's request for length and structure. If they ask for a "full introduction", write a full-length introduction (typically 4-6 substantial paragraphs, 600-1200 words). Do not write short summaries.`,
    `STEP 2 — AI CHECK: Call ai_detect_statistical on your text. If score >40%, rewrite flagged sentences. Re-test. Max 3 rounds.`,
    `STEP 3 — CITE: Mark every factual claim with [CITE:topic]. Call find_citation for each (batch). Assign [N](<doi:10.xxxx>) — ALWAYS use angle brackets (even for simple DOIs without special chars). Update ${outPath.replace(/\\/g, "/")}.`,
    `   CRITICAL: Each [N](<doi:...>) marker must be well-formed. Test your markers: they should be exactly "[1](<doi:10.1016/j.devcel.2015.03.001>)" with no missing parens, semicolons, or extra text.`,
    `   For each citation, call verify_citation(claim_sentence, doi) to confirm the paper actually supports the claim. If verification fails, find a different paper.`,
    `STEP 4 — FINALIZE: Run this shell command (it does bibliography + superscript + .docx automatically):`,
    `   ${finalizeCommand(outPath.replace(/\\/g, "/"))}${noLive ? " --no-live" : ""}`,
    `   If the command reports "paper-lab-finalize not installed", run \`pi install npm:pi-paper-lab\` first, then retry.`,
    `   The .docx ships with live Word citations by default (renumber on Ctrl+A, F9); pass --no-live for a static References section if editing outside Word.`,
    `STEP 5 — REPORT: Tell the user: number of papers studied, path to study-notes.md, path to .docx. Do NOT read the .docx (binary).`,
  ].join("\n");

  pi.sendUserMessage(prompt, { deliverAs: "followUp" });
}

// === Build the LLM cite-mark prompt ===
//
// Exported (as `export function`) so tests can introspect the rendered prompt
// without spinning up an LLM. Production code paths use it only via
// pipelineCite / pipelineRewrite / pipelineWrite — the export does not
// change runtime behaviour.
export function buildCiteMarkPrompt(filePath: string, text: string, rewriteInstructions?: string, includeRewrite?: boolean, userInstructions?: string): string {
  const userBlock = userInstructions
    ? `USER INSTRUCTIONS (follow these):\n${userInstructions}\n\n`
    : "";

  // Detect "verify all citations" intent from the user's free-form instructions.
  // The CLI/LLM enables --verify-all when the user writes something like:
  //   - "controlla TUTTE LE CITAZIONI"
  //   - "verify all citations" / "check all references"
  //   - "ricontrolla tutto" / "refresh metadata"
  // This is English+Italian heuristic — tight on false positives (must contain
  // both intent verb and a list word).
  const verifyAll = /\b(?:verify|check|recheck|re-?check|ricontrolla|controlla|verifica)\b[\s\S]{0,40}\b(?:all|every|ogni|tutte|tutto|all citations|all references|le citazioni|tutte le citazioni)\b/i
    .test(userInstructions ?? "")
    || /refresh.*(?:metadata|citations|references|tutto|cache)/i.test(userInstructions ?? "");

  // v0.7.6: detect "static / no-live" intent so the user can opt out of
  // Word-native citation fields when editing in LibreOffice / Google Docs /
  // Pages. Matches the --static / --no-live flags the README documents.
  const noLive = /(?:^|\s)--(?:no-live|static)(?=\s|$)|libreoffice|google docs|apple pages/i
    .test(userInstructions ?? "");


  const rewriteBlock = includeRewrite
    ? [`STEP 1 — REWRITE + AI CHECK:`,
       `Rewrite the draft for human scientific voice (follow your domain's voice rules). ${rewriteInstructions ? "Extra: " + rewriteInstructions : ""}`,
       `Call ai_detect_statistical on your rewrite. If score >40%, rewrite the flagged sentences and re-test. Max 3 rounds.`,
       `Write the result to ${filePath.replace(/\.md$/, ".rewritten.md")}. Report initial→final AI score.`,
       ``].join("\n")
    : "";

  const startStep = includeRewrite ? 2 : 1;

  const studyNotesPath = includeRewrite
    ? filePath.replace(/\.(?:rewritten\.)?md$/, ".study-notes.md")
    : "";
  const studyBlock = includeRewrite
    ? `STEP 0 — CONTEXT REFRESH (optional, only if topic is unclear):\n   If the draft's topic is ambiguous or you need recent literature context, call find_citation 1-3 times and save notes to ${studyNotesPath.replace(/\\/g, "/")} (same structure as study-notes.md: Topic summary, Key concepts, Candidate references with DOIs). Most rewrites skip this — proceed to STEP 1 if topic is clear.\n\n`
    : "";

  // v0.6.3: surface the citation sidecar to the LLM so it doesn't waste
  // tokens re-resolving already-cached DOIs. If the sidecar exists, list
  // every cached `[N] → doi` so the model can reuse it verbatim.
  //
  // Format is human-readable markdown so the model can grep it cheaply.
  //
  // v0.6.3.1: ALSO scan the inline text for any `[N](<doi:...>)` markers
  // that the user or a previous run already wrote. The LLM needs to see BOTH:
  //   1. citations in the sidecar (cached metadata, no DOI lookup needed)
  //   2. citations in the inline text (already cited, do not re-mark)
  // Without (2), the LLM would re-mark already-cited claims with [CITE:topic],
  // causing duplicate citations and breaking the bibliography.
  let cacheBlock = "";
  let hasExistingCitations = false;
  try {
    const sidecar = loadCitationSidecar(filePath);
    // Inline scan: every [N](<doi:...>) or [N](doi:...) already in the prose.
    // Maps N → doi for the prompt; takes priority over the sidecar if both exist.
    const inlineMap = new Map<number, string>();
    const inlineRe = /\[(\d+)\]\((?:<doi:\s*([^>\n]+)>|doi:\s*([^)>\n]+))\)/g;
    let im: RegExpExecArray | null;
    while ((im = inlineRe.exec(text)) !== null) {
      const num = parseInt(im[1]);
      const doi = (im[2] ?? im[3] ?? "").replace(/[;,.]$/, "").trim();
      if (doi) inlineMap.set(num, doi);
    }

    const inlineCount = inlineMap.size;
    const sidecarCount = sidecar.size;
    // Always collect bare [N] numbers (even when no DOIs are present),
    // because they consume citation slots and the LLM must number past them.
    const bareNumbers = new Set<number>();
    const bareReForCount = /(?<!<sup>)\[(\d+)\](?!\()/g;
    let br: RegExpExecArray | null;
    while ((br = bareReForCount.exec(text)) !== null) {
      const n = parseInt(br[1]);
      if (n >= 1 && n < 1000) bareNumbers.add(n);
    }
    if (inlineCount > 0 || sidecarCount > 0 || bareNumbers.size > 0) {
      hasExistingCitations = true;
      // Merge inline (priority) over sidecar. Inline wins because the user
      // just wrote it; sidecar could be stale from a previous session.
      const merged = new Map<number, { doi: string; source: "inline" | "cache" }>();
      for (const [num, entry] of sidecar.entries()) {
        if (entry.doi) merged.set(num, { doi: entry.doi, source: "cache" });
      }
      for (const [num, doi] of inlineMap.entries()) {
        // If inline matches the cached DOI for the same [N], prefer the
        // "(in cache)" label — nothing new to report beyond the cache. The
        // inline presence only UPGRADES the label when the inline DOI
        // differs from the cached one (the user just edited the prose to
        // repoint the reference).
        const existing = merged.get(num);
        if (existing && existing.doi === doi) continue;
        merged.set(num, { doi, source: "inline" });
      }
      const lines = [...merged.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([num, { doi, source }]) => {
          const tag = source === "inline" ? " (in text)" : " (in cache)";
          return `  [${num}] → ${doi}${tag}`;
        });
      // Bare [N] markers without any DOI in prose or cache — emit as
      // `[N]  (bare, no DOI)` entries so the LLM knows to BACKFILL them
      // (run find_citation to assign a DOI, OR user must provide one).
      for (const n of [...bareNumbers].sort((a, b) => a - b)) {
        if (!merged.has(n)) lines.push(`  [${n}]  (bare marker in prose — no DOI resolved yet)`);
      }
      const allKnownN = new Set<number>([...merged.keys(), ...bareNumbers]);
      const maxN = Math.max(0, ...allKnownN);
      cacheBlock = [
        ``,
        `CITATIONS ALREADY PRESENT (do NOT mark these claims again with [CITE:...]; re-use the existing [N](<doi:...>) verbatim):`,
        `  Source: ${inlineCount > 0 ? `inline text (${inlineCount})` : ""}${inlineCount > 0 && sidecarCount > 0 ? " + " : ""}${sidecarCount > 0 ? `sidecar cache (${sidecarCount})` : ""}`,
        `  Highest [N] in use: ${maxN} — assign NEW citations starting from [${maxN + 1}].`,
        ...lines,
        ``,
        `For each [N] in the list above:`,
        `  - If the [N](<doi:...>) marker is ALREADY in the prose, leave it as-is.`,
        `  - If the [N] is only in the cache (bare marker in prose), re-attach: replace [N] with [N](<doi:...>).`,
        `  - Do NOT call find_citation for any [N] that already has a resolved DOI in this list.`,
        `For [N] entries listed as '(bare marker in prose — no DOI resolved yet)': you MUST call find_citation to backfill them with a DOI.`,
        `Only call find_citation for claims that are NOT yet cited at all (genuinely new claims).`,
        ``,
      ].join("\n");
    }
  } catch (err) {
    // Real bug: silently swallowed in earlier versions, then we shipped
    // v0.6.3 with TDZ (using `bareNumbers` before its `const` declaration).
    // Surface to stderr so future regressions show up loudly.
    console.error("[paper-lab-finalize] WARN: failed to build CITATIONS ALREADY PRESENT block:", err?.message ?? err);
  }

  // v0.7.0 (M2.2 + M3): disambiguation, anti-hallucination, mandatory
  // verification. The block is the most important contract between the
  // LLM and our resolve pipeline; keep the wording tight and explicit.
  //
  // KNOWN: the M3 block contains a "paper will be rejected" warning
  // that is not enforced in code. It is a prompt-engineering safeguard
  // that the LLM will treat as a strong signal but a determined LLM
  // can ignore. The honest contract is the DOI INVARIANT itself;
  // the rejection threat is a behavioural nudge.
  const citeBlockRef = hasExistingCitations
    ? " OR DOIs in CITATIONS ALREADY PRESENT"
    : "";
  const clarifyBlock = [
    `━━━ DISAMBIGUATION (M2) ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    `When you are NOT sure between multiple candidates:`,
    `  1. Call find_citation with a \`claim\` field set to the sentence you need to back up. The tool appends a "CLARIFICATIONS NEEDED" menu you MUST present to the user verbatim — do NOT pick a candidate yourself.`,
    `  2. After the user picks (a)/(b)/etc, use the chosen candidate's DOI for [N](<doi:...>). The menu's labels ARE the candidate ids.`,
    `  3. If the user cannot decide or you cannot reach them: emit \`[ASK: short, single-line question]\` inline in the prose, OR \`[CITATION NEEDED: topic]\` to mark the gap honestly.`,
    ``,
    `━━━ ANTI-HALLUCINATION (M3) ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    `Every DOI you write MUST appear in a find_citation candidate above. The DOI INVARIANT:`,
    `  DOI_used(X) → X ∈ {DOIs returned by find_citation${citeBlockRef}}`,
    `If find_citation returns no candidate, emit \`[CITATION NEEDED: topic]\`. DOIs you invent violate this contract. (Note: this rule is prompt-engineering — there is no code enforcement. Be honest.)`,
    ``,
    `━━━ MANDATORY VERIFY_CITATION (M3) ━━━━━━━━━━━━━━━━━━━━━━━`,
    `For every [N] you emit, you MUST call verify_citation(claim_sentence, doi) before the FINALIZE step.`,
    `verify_citation does NOT return a verdict directly — it returns the reference's abstract plus a structured prompt. You MUST read the abstract, compare it against the claim, and answer:`,
    `  SUPPORTS — the reference's content backs the claim. Keep the citation.`,
    `  REFUTES — the reference's content contradicts the claim. That DOI is wrong. Pick a different candidate. If all candidates for this claim REFUTE, re-run find_citation with a different query; if the second search also fails, emit [CITATION NEEDED].`,
    `  UNCLEAR — the abstract is missing or ambiguous. Prefer a different candidate; if none, emit [CITATION NEEDED].`,
    ``,
  ].join("\n");

  return [
    `Paper draft: ${filePath}`,
    ``,
    userBlock,
    cacheBlock,
    clarifyBlock,
    `---`,
    text,
    `---`,
    ``,
    rewriteBlock,
    studyBlock,
    `━━━ CITE ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    `Follow the DISAMBIGUATION, ANTI-HALLUCINATION, and MANDATORY VERIFY_CITATION rules above. For every factual claim NOT already cited in the CITATIONS ALREADY PRESENT block, call find_citation with \`claim\` set to the claim sentence.`,
    `Call find_citation in parallel batches (up to 5 claims per batch). If any call in a batch returns a "CLARIFICATIONS NEEDED" menu, PAUSE the batch and present the menu(s) to the user before proceeding.`,
    `Assign NEW [N] sequentially starting from max(existing)+1. ALWAYS use angle brackets: [N](<doi:10.xxxx>).`,
    `After ALL [N] are assigned, run verify_citation(claim, doi) for every one in a second pass. If a citation REFUTES, swap the [N] to the next candidate in-place (do not renumber the others). If ALL candidates for a claim REFUTE or are UNCLEAR, re-run find_citation with a different query.`,
    `Write the resolved file to ${filePath}.`,
    ``,
    `━━━ FINALIZE ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    `Run this shell command (does bibliography + superscript + .docx automatically):`,
    `   ${finalizeCommand(filePath.replace(/\\/g, "/"))}${verifyAll ? " --verify-all" : ""}${noLive ? " --no-live" : ""}`,
    `If "paper-lab-finalize not installed" appears, run \`pi install npm:pi-paper-lab\` first. Pass \`--no-cache\` to force fresh DOI resolution; pass \`--verify-all\` to re-fetch every DOI even with cache; pass \`--no-live\` to force a static References section (for LibreOffice / Google Docs / Pages instead of Word).`,
    ``,
    `━━━ REPORT ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    `Tell the user the .docx path. Do NOT read the .docx (binary).`,
    ``,
    `Do ALL steps in ONE turn. Do not stop between steps.`,
  ].filter(Boolean).join("\n");
}

// === extractAskQuestions: exported helper for the [ASK:question] marker ===

/**
 * Extract `[ASK:question]` markers from a Markdown draft and return the
 * cleaned text (markers removed) + the questions (in order of appearance).
 * Exported so the integration tests can verify the parsing without
 * having to spin up the full finalizeDoc pipeline.
 *
 * Format: `[ASK: short, single-line question]`. Multi-line is allowed
 * (the regex captures until the first `]`) but the convention is to
 * keep the question on one line.
 *
 * Whitespace inside the captured question is trimmed; empty questions
 * are dropped.
 */
export function extractAskQuestions(text: string): { cleaned: string; questions: string[] } {
  const questions: string[] = [];
  const cleaned = text.replace(/\[ASK:([^\]]+)\]/g, (_m, q) => {
    const trimmed = q.trim();
    if (trimmed) questions.push(trimmed);
    return "";
  });
  return { cleaned, questions };
}

// === cleanDoi: exported, idempotent, the single source of truth for DOI normalisation ===
// Strips trailing punctuation and bracket artifacts that LLMs sometimes leave inside
// malformed citation markers (e.g. `[13](doi:10.1242/dmm.049298.]` or `.],`).
// Applied repeatedly until the string stops changing (idempotent).
// `)` is NOT stripped because parentheses are valid characters inside real DOI strings
// (e.g. `10.1016/S0896-6273(00)80701-1`).
// Exported so tests can verify the normalisation directly without going through
// finalizeDoc.
export function cleanDoi(input: string): string {
  let s = input.trim();
  let prev: string;
  do {
    prev = s;
    s = s.replace(/[\];,.]+$/, "");
  } while (s !== prev);
  return s.trim();
}

/**
 * Convert a Vancouver/HTML citation string to PLAIN TEXT for embedding as a
 * cached BIBLIOGRAPHY field result (BUG 8 fix). Vancouver strings from
 * Citestyle carry literal HTML markup (`<i>Drosophila</i>`) and entity-encoded
 * ampersands (`&amp;`). If we pass these straight to escapeXml, `<i>` becomes
 * `&lt;i&gt;` and `&amp;` becomes `&amp;amp;` (double-encoded). We strip HTML
 * tags and decode entities to plain text FIRST, so the downstream escapeXml
 * re-encodes correctly. Exported for testing.
 */
export function plainTextCitation(s: string): string {
  return s
    .replace(/<[^>]+>/g, "")        // strip HTML tags (<i>, </i>, <b>, ...)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")          // decode &amp; LAST (avoids &amp;lt; -> &lt; -> <)
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Strip trailing close-parens that LLM malformed markers leave behind
 * (e.g. `[1](doi:10.x/xxx)` becomes `10.x/xxx)` after marker split).
 *
 * Only applies the strip to ENDS, never internal. Uses `\)+$` to strip
 * any positive number of trailing parens, preventing residual `)`s
 * from leaks.
 *
 * IMPORTANT: we DO strip trailing `)` even though some DOIs contain
 * internal `)`, because no real DOI ends with `)`. DOIs are
 * `10.PREFIX/SUFFIX` where SUFFIX never ends with `)`.
 *
 * Exported for testability.
 */
export function stripTrailingParen(s: string | undefined): string | undefined {
  return s ? s.replace(/\)+$/, "") : s;
}

/**
 * Parse a Vancouver-format entry produced by `formatVancouver()`
 * back into structured source fields for the live Word citation
 * builder. Returns null if the entry is unparseable (e.g. truly
 * blank `## References` section). Three formats are supported:
 *
 *   A) Full Vancouver with volume: "1. Authors. Title. Journal. 2025;36:357-364. doi:..."
 *   B) No-volume (pages after year only): "1. Authors. Title. Proc. 2025:3762-3774. doi:..."
 *   C) DOI-only:  "1. (doi:10.xxx)" or "1. doi:10.xxx"
 *   D) Placeholder: "1. [Citation metadata unavailable...]" (no DOI)
 *
 * Exported so tests assert behaviour against the actual implementation
 * rather than a stale copy (CRIT-1 fix from v0.7.1 hotfix audit).
 */
export function parseVancouverForLive(entry: string): WordLiveBuilderSource | null {
  // A) Full Vancouver.
  // CRIT-3 (M4 audit): volume MUST be digits (`\d+`), issue is `(digits)`
  // after the volume. The previous `\S+?` was too loose and caused
  // `;15(4):1-10` to be parsed as vol="15(4)".
  // HIGH-5 (M4 audit): parseInt is guarded against NaN.
  // MED-3 (M4 audit): issue is captured separately.
  const full = entry.match(/^(\d+)\.\s+(.+?)\.\s+(.+?)\.\s+([^.]+?)\.\s+(\d{4})(?:;(\d+)(?:\((\d+)\))?(?::(.+?))?)?\.\s+doi:(\S+?)\.?$/);
  if (full) {
    const [, n, authors, title, journal, year, vol, issue, pages, doi] = full;
    const id = parseInt(n!, 10);
    if (!Number.isFinite(id) || id < 1) return null;
    const authorList = authors!.split(/,\s*/).map((family) => ({ family }));
    return { id, tag: `Ref${id}`, title: title!, year, journal: journal!.trim(), doi: stripTrailingParen(doi), authors: authorList, volume: vol, issue, pages };
  }
  // B) No-volume: capture journal name allowing embedded dots (e.g.
  // "Proc. Natl. Acad. Sci.") followed by optional trailing dot and
  // whitespace+year. CRIT-3 audit: dotted names like "Proc. Natl. Acad.
  // Sci." used to be truncated to "Sci" because the journal capture
  // was `[^.]+?` (excluded dots). The new capture `((?:[^.]+\.)*[^.]+\.?)`
  // matches one-or-more "word." segments optionally followed by a
  // final word (with or without trailing period).
  const noVol = entry.match(/^(\d+)\.\s+(.+?)\.\s+(.+?)\.\s+((?:[^.]+\.)*[^.]+\.?)\s+(\d{4}):(\S+?)\.\s+doi:(\S+?)\.?$/);
  if (noVol) {
    const [, n, authors, title, journal, year, pages, doi] = noVol;
    const id = parseInt(n!, 10);
    if (!Number.isFinite(id) || id < 1) return null;
    const authorList = authors!.split(/,\s*/).map((family) => ({ family }));
    return { id, tag: `Ref${id}`, title: title!, year, journal: journal!.trim(), doi: stripTrailingParen(doi), authors: authorList, pages };
  }
  // C) DOI-only. Symmetric parens: require `(?:` either both or neither.
  const doiOnly = entry.match(/^(\d+)\.\s+(?:\(doi:(\S+?)\.?\)|doi:(\S+?)\.?)$/);
  if (doiOnly) {
    const id = parseInt(doiOnly[1]!, 10);
    if (!Number.isFinite(id) || id < 1) return null;
    return { id, tag: `Ref${id}`, title: `Reference ${id}`, doi: stripTrailingParen(doiOnly[2] ?? doiOnly[3]) };
  }
  // D) Placeholder — CRIT-2 fix (v0.7.1 hotfix audit): the CRIT-4
  // (M4 audit) placeholder handling was REMOVED by mistake in
  // v0.7.1. Restore it so `[N]` references without DOIs still get
  // a b:Source (so Word's Source Manager and BIBLIOGRAPHY do not
  // show empty cells for them).
  const placeholder = entry.match(/^(\d+)\.\s+\[(.+)\]$/);
  if (placeholder) {
    const id = parseInt(placeholder[1]!, 10);
    if (!Number.isFinite(id) || id < 1) return null;
    return { id, tag: `Ref${id}`, title: `[${placeholder[2]}]` };
  }
  return null;
}

// === finalizeDoc: ONE function that does everything ===
// Reads .md with [N](doi:...) → generates bibliography → strips DOI → superscript [N] → .docx
// The LLM only needs to write the .md and call this.
export function finalizeDoc(
  markdownPath: string,
  opts?: {
    noCache?: boolean;
    verifyAll?: boolean;
    /**
     * v0.7.0 (M4): when true, after the static .docx is built the
     * post-processor injects Word's native citation system so the
     * user can edit the document in Word with renumbering-on-F9 and
     * live Source Manager. Only meaningful when the user is on a
     * machine with Word installed (M0.5 manual validation).
     */
    live?: boolean;
    /**
     * v0.7.6: when true, buildWordLive installs the bundled superscript
     * bibliography XSL to %APPDATA%\Microsoft\Bibliography\Style. OPT-IN —
     * we never write to the user's machine without explicit consent. The CLI
     * flag is --install-style; without it, the CLI prints install instructions
     * when --live is used and the style is missing.
     */
    installStyleXsl?: boolean;
    // Dependency injection for tests. Production callers omit this and the
    // real `lookupDoiSync` (which hits CrossRef) is used. Tests pass a
    // fixture-backed function to keep the suite offline.
    lookupDoi?: (doi: string) => CrossRefWork | null;
  },
): { docxPath: string; bibliographyCount: number; error?: string; liveApplied?: boolean } {
  const docxPath = markdownPath.replace(/\.md$/i, ".docx");
  let text = readFileSync(markdownPath, "utf-8");

  // v0.6.3: --no-cache forces fresh CrossRef resolution.
  // v0.6.3.2: --verify-all is a stronger form — invalidate the cache for
  // every [N] that has an inline DOI (still trusts bare markers with no DOI).
  // Use when the user says "controlla TUTTE LE CITAZIONI" or after a paper
  // retraction, journal errata, etc.
  const noCache = !!opts?.noCache;
  const verifyAll = !!opts?.verifyAll;
  // `trustCache` is the central knob — both flags degrade it. With verifyAll,
  // we still LOAD the sidecar (so we can know which [N] had a DOI), but we
  // ignore the cached Vancouver metadata for ones with inline DOIs.
  const trustCache = !noCache && !verifyAll;
  // Dependency-injected resolver; defaults to the real CrossRef-backed one.
  const resolveDoi = opts?.lookupDoi ?? lookupDoiSync;

  // 0. Strip any existing References section (idempotent — safe to re-run)
  // Step 0a: If the last line is exactly "## References" (no content after), remove it.
  text = text.replace(/\n*##\s*References\s*$/i, "");
  // Step 0b: Strip --- separator + ## References + bibliography content to EOF.
  text = text.replace(/\n*---\n*##\s*References[\s\S]*$/i, "");
  // Step 0c: Strip bare ## References heading (must be followed by newline or EOF —
  // NOT mid-sentence like "## References is important") + bibliography to EOF.
  text = text.replace(/\n*##\s*References(?=\s*\n|\s*$)[\s\S]*$/i, "");

  // 1. Parse all [N](<doi:...>) and [N](doi:...) markers and build Vancouver citations via CrossRef
  const citations = new Map<number, string>();
  // v0.7.5 (M2): parallel CSL-JSON map for the live-citation branch.
  // --live passes these directly to buildWordLive (no regex Vancouver
  // re-parse, no parseVancouverForLive). The static-text path still uses
  // `citations` (Vancouver regex) for backwards compatibility with
  // existing golden tests; M5 cleanup removes formatVancouver entirely.
  const cslItems = new Map<number, CslItem>();

  // 1a. Load any cached citations from the sidecar file (v0.6.3).
  //
  // The sidecar is a JSON map of `{N: {doi, vancouver}}` produced by previous
  // successful finalizeDoc runs. We pre-populate `citations` from it so that
  // bare [N] markers (a common case when the LLM has stripped DOIs or when
  // the user re-edits prose without changing references) resolve WITHOUT a
  // CrossRef roundtrip. This both speeds things up AND prevents the silent
  // orphan-citation bug we had in v0.6.2.
  //
  // HIGH-1 fix: cache entries only populate `citations` PROVISIONALLY —
  // the inline-`[N](doi:X)` scan below will EVICT a cached entry if the
  // user changed the DOI for that [N] in the prose. Without this, silently
  // trusting the cache would let a stale DOI persist forever.
  //
  // v0.6.3.2 / verifyAll: with --verify-all we still load the sidecar (so we
  // can detect conflicts between cached DOIs and inline DOIs), but we SKIP
  // the trust-the-cache write below — every [N] with an inline DOI gets a
  // fresh CrossRef pass. Bare [N] markers without inline DOIs STILL pull
  // from the sidecar (we have no way to re-resolve them without an LLM).
  const sidecar = (trustCache || verifyAll)
    ? loadCitationSidecar(markdownPath)
    : new Map<number, SidecarEntry>();
  if (trustCache) {
    for (const [num, entry] of sidecar.entries()) {
      citations.set(num, entry.vancouver);
      // CRIT-2 fix: also seed cslItems from the sidecar's csl field.
      // Without this, re-runs of finalizeDoc always fall back to
      // the regex Vancouver parser (cslItems.size === 0).
      if (entry.csl) {
        cslItems.set(num, entry.csl);
      }
    }
  }

  // Primary: angle-bracket form [N](<doi:XXX>) — handles ALL DOIs including parens
  // Fallback: plain form [N](doi:XXX) — but only for DOIs without parens (safe)
  const re = /\[(\d+)\]\((?:<doi:\s*([^>\n]+)>|doi:\s*([^)>\n]+))\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const num = parseInt(m[1]);
    const doi = cleanDoi(m[2] ?? m[3] ?? "");
    if (!doi) continue;
    // HIGH-1 fix: if we already have a citation cached for this N, compare
    // DOIs. If they differ, the user has re-pointed [N] at a different paper
    // — evict the stale entry and re-fetch from CrossRef. If they match,
    // skip the (expensive) lookup entirely.
    //
    // verifyAll: skip the cache-hit shortcut entirely. Every inline DOI
    // gets re-fetched. Use when the user wants to verify ALL citations.
    if (citations.has(num) && !verifyAll) {
      const cachedEntry = sidecar.get(num);
      if (cachedEntry?.doi === doi) {
        // Cache hit for the Vancouver string. But if this is a pre-v0.7.5
        // sidecar (no `csl` field), cslItems is missing this entry and the
        // --live path would drop it from b:Sources — a cited-but-unsourced
        // (broken) citation in Word. Lazily fetch the CSL once; the sidecar
        // write at the end persists it, so subsequent runs are cache-fast.
        if (!cslItems.has(num)) {
          // Lazily fetch the CSL once so the sidecar is upgraded (subsequent runs
          // are cache-fast). The resolver contract is SYNC (CrossRefWork | null),
          // but some test mocks pass an ASYNC function whose rejection would crash
          // the process as an unhandled rejection. Treat a Promise return (or a
          // throw) as "CSL unavailable here" — the live source-selection falls
          // back to parseVancouverForLive so the entry still gets a b:Source.
          try {
            const work = resolveDoi(doi);
            if (work && typeof work === "object") {
              if (typeof (work as any).then === "function") {
                // async mock — swallow its rejection so it can't crash the process.
                (work as Promise<unknown>).catch(() => {});
              } else {
                cslItems.set(num, crossrefToCsl(work as CrossRefWork, doi));
              }
            }
          } catch { /* keep Vancouver-only entry; live fallback uses parseVancouverForLive */ }
        }
        continue; // cache hit, DOI matches
      }
      citations.delete(num); // stale or first-time — start fresh
    } else if (verifyAll) {
      // verifyAll: drop any cached entry that was pre-populated above.
      // The loop body below re-fetches via CrossRef unconditionally.
      citations.delete(num);
    }
    try {
      const work = resolveDoi(doi);
      if (work) {
        // M2 + CRIT-1 (v0.7.5 audit): use Citestyle to render the
        // bibliography entry (no `[N]` prefix — we add the original
        // number ourselves at markdown-write time so non-contiguous
        // citations like [1], [4], [7] preserve their numbers).
        const csl = crossrefToCsl(work, doi);
        cslItems.set(num, csl);
        const rendered = formatCslBibliography([csl], { style: "vancouver" });
        // Strip Citestyle's leading "[N] " — we re-apply the original
        // [N] in the markdown writer (line 953) with a backslash-escaped
        // period so bun-docx doesn't interpret it as a numbered list.
        const withoutNumber = rendered.replace(/^\[\d+\]\s+/, "");
        citations.set(num, withoutNumber);
      } else {
        citations.set(num, `${num}. (doi:${doi})`);
      }
    } catch {
      citations.set(num, `${num}. (doi:${doi})`);
    }
  }

  // 2. Strip [N](<doi:...>) and [N](doi:...) → <sup>[N]</sup> (superscript, NO DOI in text)
  text = text.replace(/\[(\d+)\]\((?:<doi:\s*[^>\n]+>|doi:\s*[^)>\n]+)\)/g, (_m, num) => `<sup>[${num}]</sup>`);
  // Also strip any remaining [CITE:topic] → [CITATION NEEDED]
  text = text.replace(CITE_MARKER, (_m, topic) => `[CITATION NEEDED: ${topic}]`);

  // v0.7.0 (M2.2): collect [ASK:question] markers the LLM emitted when
  // it could not decide between candidates. The questions are stripped
  // from the prose (the user already saw them) and gathered into a
  // QUESTIONS FOR THE AUTHOR section rendered at the top of the .docx
  // in `--live` mode. In `--static` mode (the final submission build)
  // the section is removed entirely so the .docx ships clean.
  // The marker is collected into the askQuestions local variable,
  // which is then emitted to the bibliography section below.
  // For the static path the questions are dropped (they were LLM
  // work-in-progress, not paper content).
  const askExtraction = extractAskQuestions(text);
  text = askExtraction.cleaned;
  const askQuestions = askExtraction.questions;

  // 2a. Handle bare [N] markers (v0.6.3).
  //
  // WHY: When /paper-cite runs on a file that already has bare [N] markers from
  // an earlier session or from manual editing, the LLM typically leaves those
  // markers alone and only adds new numbers. Result: the .docx ends up with
  // orphan superscripts pointing to nothing in the References section.
  //
  // FIX: After processing [N](doi:...) markers, scan the remaining text for
  // bare [N] references. For each one we don't already know about (no DOI),
  // add a "no DOI resolved" placeholder to the bibliography AND convert the
  // marker to <sup>[N]</sup> like the others. This makes the gap visible
  // instead of hiding it (the user can then re-run /paper-cite to fill them).
  //
  // We do NOT touch [CITATION NEEDED: ...] (those are LLM work-in-progress
  // markers, not user-authored [N] references).
  //
  // CRIT-1 fix: skip `[N]` that already lives inside `<sup>...</sup>` tags.
  // Without this guard, the DOI-strip in step 2 produces `<sup>[1]</sup>`
  // which step 2a would re-wrap into `<sup><sup>[1]</sup></sup>` on every
  // run that has resolved DOI markers. The negative lookbehind anchors to
  // the literal `<sup>` opening tag of any preceding marker, so re-stripping
  // cannot nest.
  const bareNums = new Set<number>();
  const bareRe = /(?<!<sup>)\[(\d+)\](?!\()/g;
  let bm: RegExpExecArray | null;
  while ((bm = bareRe.exec(text)) !== null) {
    const n = parseInt(bm[1]);
    if (n >= 1 && n < 1000) bareNums.add(n); // sanity cap on absurd numbers
  }
  if (bareNums.size > 0) {
    for (const n of bareNums) {
      // First try the sidecar cache — if we already resolved this [N] in a
      // previous run, reuse the Vancouver text instead of writing a placeholder.
      const cached = sidecar.get(n);
      if (cached) {
        citations.set(n, cached.vancouver);
      } else if (!citations.has(n)) {
        citations.set(n, `${n}. [Citation metadata unavailable — no DOI found. Re-run /paper-cite to resolve this reference.]`);
      }
    }
    // Convert all bare [N] → <sup>[N]</sup> so the .docx has consistent styling.
    // Apply the same negative lookbehind to avoid nesting inside existing tags.
    text = text.replace(/(?<!<sup>)\[(\d+)\](?!\()/g, (_m, num) => `<sup>[${num}]</sup>`);
  }

  // 2a-bis. Use sidecar to resolve bare [N] markers (v0.6.3).
  //
  // The bare-marker scan above first writes a placeholder into the
  // bibliography. THEN we look up each bare number in the sidecar: if we
  // find a cached entry, we UPGRADE the placeholder with the real
  // Vancouver text. Order matters: the placeholder path runs on a fresh
  // project (no sidecar yet) and degrades gracefully when the cache is
  // missing, while the upgrade path runs only when the user has already
  // resolved citations in a previous session.
  //
  // This is what makes "edit prose → re-finalize" actually work end-to-end
  // without the LLM having to re-resolve any DOIs.

  // 2b. Defensive: catch malformed DOI markers (LLM bugs) — extract DOI from any
  // "[N](doi:...anything...)" pattern even if parens don't close properly.
  // This prevents raw DOI text from leaking into the body.
  // A malformed marker such as `[13](doi:10.1242/dmm.049298]` is common
  // when a citation is copied from an LLM draft. Normalize its DOI before the
  // lookup so the sidecar never stores the Markdown `]` artifact.
  // Note: the well-formed regex above handles normal markers first; this
  // fallback only handles a missing closing `)`.
  text = text.replace(
    /\[(\d+)\]\(doi:\s*(10\.[^\s\]\n]+)\]?/g,
    (_m, num, doi) => {
      const normalizedDoi = doi.replace(/[;,.]+$/, "").trim();
      if (normalizedDoi.startsWith("10.")) {
        const n = parseInt(num);
        // The malformed marker was not handled by the well-formed scan above,
        // so this is always a fresh entry. Do not use `has()` as a guard: a
        // bare-marker placeholder may already have occupied the same number.
        citations.delete(n);
        let work: any | null = null;
        try { work = resolveDoi(normalizedDoi); } catch { /* keep DOI stub */ }
        if (work) {
          const authors = (work.author ?? []).map((a: any) =>
            a.family ? `${a.family} ${a.given ?? ""}`.trim() : a.name ?? "?").join(", ");
          const year = work.published?.["date-parts"]?.[0]?.[0]
            ?? work["published-print"]?.["date-parts"]?.[0]?.[0]
            ?? work["published-online"]?.["date-parts"]?.[0]?.[0] ?? "?";
          const title = work.title?.[0] ?? "(untitled)";
          const journal = work["container-title"]?.[0] ?? "";
          const vol = work.volume ?? "";
          const pages = work.page ?? "";
          citations.set(n, `${n}. ${authors}. ${title}. ${journal}. ${year}${vol ? ";" + vol : ""}${pages ? ":" + pages : ""}. doi:${normalizedDoi}`);
        } else {
          citations.set(n, `${n}. (doi:${normalizedDoi})`);
        }
      }
      return `<sup>[${num}]</sup>`;
    },
  );

  // 3. Append static References section for non-live mode.
  // In --live mode, Word's BIBLIOGRAPHY field (injected by
  // buildWordLive) is the single source of truth — a static
  // section would duplicate. In --static mode, we produce a
  // plain References section that works in any editor.

  // v0.7.0 (M2.2): QUESTIONS FOR THE AUTHOR section at the top of the doc.
  // The LLM emitted [ASK:question] markers while writing; collect them
  // here so the user can see what was left open. The section is rendered
  // in the .docx output regardless of --static / --live mode, but it is
  // removed by `cleanExtractedDocx` if the user re-runs finalize on the
  // .docx (the questions are no longer open once answered). For the
  // very first finalize run, this is the only way the user sees the
  // questions in the produced document.
  if (askQuestions.length > 0) {
    const numbered = askQuestions.map((q, i) => `${i + 1}. ${q}`).join("\n");
    text = `## Questions for the author\n\n${numbered}\n\n---\n\n` + text;
  }

  // 3a. Static mode (no --live flag): append a plain References
  // section. In --live mode the BIBLIOGRAPHY field handles this.
  if (opts?.live === false && citations.size > 0) {
    const sorted = [...citations.entries()].sort((a, b) => a[0] - b[0]);
    const lines = sorted.map(([num, raw]) => {
      const clean = raw.replace(/^\[?\d+\]\.?\s*/, "");
      return `[${num}] ${clean}`;
    });
    text += "\n\n## References\n\n" + lines.join("\n\n");
  }

  // 3b. CRIT-2 fix: detect which citation numbers are actually USED in the
  // processed text, and prune `citations` (and the sidecar write below)
  // to only those. Otherwise, if the user removed `[N]` from the prose in
  // a previous edit, the sidecar keeps it forever — and the bibliography
  // ends up listing a reference that nothing in the body cites.
  //
  // We scan the FINAL text (after all <sup>[N]</sup> conversion) for any
  // `<sup>[N]</sup>` occurrence. The set of N's that appear is the truth.
  {
    const used = new Set<number>();
    const usedRe = /<sup>\[(\d+)\]<\/sup>/g;
    let um: RegExpExecArray | null;
    while ((um = usedRe.exec(text)) !== null) {
      used.add(parseInt(um[1]));
    }
    for (const num of [...citations.keys()]) {
      if (!used.has(num)) citations.delete(num);
    }
  }

  // 3b. Normalize any leftover references LLM wrote directly in the document.
  // Format: "<number>.   <text>" → "<number>. <text>" (collapse multi-space after period).
  // Without this, Markdown interprets "9.    Ding" as an ordered list item.
  text = text.replace(/^(\d+)\.\s\s+(?=\S)/gm, '$1. ');

  // 4. Create .docx with --force (overwrite)
  // Hostile-audit fix #9: same no-.md guard as sidecarPathFor — never let the
  // temp file path collapse onto the source path.
  const tempMd = /\.md$/i.test(markdownPath)
    ? markdownPath.replace(/\.md$/i, ".final.md")
    : markdownPath + ".final.md";
  try {
    writeFileSync(tempMd, text, "utf-8");
  } catch (err: any) {
    return { docxPath: "", bibliographyCount: 0, error: `Cannot write temp file: ${err?.message}` };
  }
  try {
    execFileSync("docx", ["create", docxPath, "--from", tempMd, "--force"], { stdio: "pipe" });
  } catch (err: any) {
    try { unlinkSync(tempMd); } catch {}
    const detail = err?.stderr ? String(err.stderr).slice(0, 200) : (err?.message ? String(err.message).slice(0, 200) : String(err));
    return { docxPath: "", bibliographyCount: 0, error: `docx create failed: ${detail}` };
  }
  try { unlinkSync(tempMd); } catch {}

  // 5. Write sidecar citation cache (v0.6.3).
  //
  // Why: when the user later edits the prose and re-finalizes the SAME .md
  // (without adding new citations), we don't want to re-fetch the same 22
  // DOIs from CrossRef. The sidecar lets subsequent runs re-use DOI +
  // Vancouver string verbatim, even when the .md only has BARE [N] markers
  // (the LLM-emitted format strips DOIs from prose on save).
  //
  // The sidecar is keyed by `[N] → { doi, vancouver }`. Resolved-DOI entries
  // (with Vancouver from CrossRef) AND placeholder entries (no DOI) are BOTH
  // written — placeholders let /paper-cite detect gaps on the next run.
  //
  // The file is JSON so it's diff-friendly if the user puts it under git.
  // Schema version field lets us evolve without silent breakage.
  try {
    const cachePath = sidecarPathFor(markdownPath);
    const entries: Record<string, SidecarEntry> = {};
    for (const [num, vancouver] of citations.entries()) {
      // Try to extract the DOI back out of the citation text for the cache.
      // Schema: the resolved text has "doi:10.xxxx" (old regex path) OR
      // "https://doi.org/10.xxxx" (Citestyle path). Both are accepted.
      // We use [\w./\-()]+ (allowing internal parens, used by older
      // Elsevier DOIs) and trim trailing terminator chars afterwards.
      const rawDoiMatch = vancouver.match(/(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:)([\w./\-()]+)/i);
      const doiMatch = rawDoiMatch ? rawDoiMatch[1].replace(/[\s,;.<>]+$/, "") : null;
      // CRIT-2 fix: also write the CSL-JSON sidecar. Without this, the
      // next finalizeDoc run loads {doi, vancouver} only and the live
      // builder falls back to the regex Vancouver parser (because
      // cslItems stays empty). The CSL field is the v0.7.5 promise.
      const csl = cslItems.get(num);
      entries[String(num)] = {
        doi: doiMatch ? doiMatch : null,
        vancouver,
        csl: csl ?? undefined,
      };
    }
    const sidecar: SidecarFile = {
      schemaVersion: 1,
      sourceMarkdown: markdownPath,
      lastResolvedAt: new Date().toISOString(),
      citationBackend: loadConfig().citation_backend ?? "crossref",
      citations: entries,
    };
    writeFileSync(cachePath, JSON.stringify(sidecar, null, 2) + "\n", "utf-8");
  } catch (err) {
    // Sidecar write failure is non-fatal: the .docx was already produced.
    // Don't fail the whole finalize if the cache write fails (disk full,
    // permission denied, etc.). User loses cache, not bibliography.
  }

  // v0.7.0 (M4): if --live, post-process the .docx to inject Word's
  // native citation system. The M0.5 manual matrix must validate the
  // runtime behaviour (renumber on F9, source manager recognition).
  // If buildWordLive throws (bad XML, missing part), fall back to the
  // static .docx rather than fail the whole finalize.
  //
  // v0.7.6: live is the DEFAULT. Word native CITATION fields renumber on
  // F9, and the bundled IEEE2006SuperscriptOfficeOnline.xsl (installed once
  // via --install-style, with consent) makes them render as superscript [N].
  // The BIBLIOGRAPHY field also carries the static list as its cached result,
  // so non-Word apps (LibreOffice/Google Docs/Pages) still display a complete
  // bibliography. Pass --no-live / --static to force the plain-text References
  // section (e.g. for editors without Word, or when the superscript XSL is not
  // installed).
  //
  // NOTE on auto-renumber: Word never auto-renumbers citation fields on
  // delete (only Zotero/Mendeley plugins do, by intercepting edits). After
  // deleting a [N] in the text, run Ctrl+A → F9 (or the ribbon "Update
  // Citations & Bibliography") to renumber. This is a Word engine limit, not
  // fixable from a .docx file.
  // Only inject the live citation system when there is at least one citation.
  // An empty b:Sources list would add customXml parts + a BIBLIOGRAPHY field for
  // nothing, and Word's Source Manager would show an empty list. With zero
  // citations we ship a plain docx (the static ## References section is also
  // skipped when citations.size === 0 above).
  const live = opts?.live !== false && citations.size > 0;
  if (live) {
    try {
      // v0.7.1 fix: buildWordLive is imported statically at the top of this
      // file. The previous version used a dynamic `require("./word-live-builder.js")`
      // which silently failed when finalizeDoc was loaded through pi's extension
      // runtime (jiti/strip-types) — the catch path produced a static .docx
      // without the CustomXML parts, so Word never saw live citations.
      //
      // v0.7.2 fix: parseVancouverForLive was the canonical entry point.
      //
      // v0.7.5 fix (M2.4): the canonical path is now CslItem → b:Source.
      // The regex Vancouver parser is reserved for the FALLBACK when
      // `cslItems` is empty (i.e. the user ran --live against an old
      // sidecar that only carries Vancouver strings — they would
      // otherwise lose their live bibliography). New finalize runs
      // that resolve DOIs populate `cslItems` directly and skip the
      // regex entirely.
      const liveSources: WordLiveBuilderSource[] = [];
      // BUG 6 fix: iterate over ALL citations (sorted), preferring the
      // structured CslItem but FALLING BACK to parseVancouverForLive(vancouver)
      // when cslItems is missing an entry (e.g. a pre-v0.7.5 sidecar where the
      // lazy CrossRef fetch returned null). Previously, if ANY entry had CSL,
      // the CslItem-only path was taken and entries without CSL were silently
      // dropped from b:Sources — a cited-but-unsourced (broken) citation.
      const orderedNums = [...citations.keys()].sort((a, b) => a - b);
      const originalToPositional = new Map<number, number>();
      const csls: CslItem[] = [];
      const fallbackSources: WordLiveBuilderSource[] = [];
      for (const num of orderedNums) {
        if (cslItems.has(num)) {
          csls.push(cslItems.get(num)!);
        } else {
          // No CSL — parse the Vancouver string so the entry still gets a
          // b:Source. Include the entry if it has a real DOI, OR if it is an
          // explicit sidecar placeholder (doi=null but the user/previous run
          // recorded it — CRIT-2 wants those surfaced in Source Manager).
          // EXCLUDE first-run bare markers (no sidecar, no DOI): those have no
          // real source and the CSL-smoke expects them absent from b:Sources.
          const source = parseVancouverForLive(citations.get(num) ?? "");
          if (source && (source.doi || sidecar.has(num))) fallbackSources.push(source);
        }
      }
      // Build positional sources: CSL items first (via cslItemsToWordSources,
      // which assigns 1..N), then the fallback sources appended with continuing
      // ids. The originalToPositional map remaps the user's [N] markers to the
      // positional ids Word's CITATION fields expect.
      if (csls.length > 0) {
        liveSources.push(...cslItemsToWordSources(csls));
      }
      const cslCount = csls.length;
      fallbackSources.forEach((src, i) => {
        src.id = cslCount + i + 1;
        src.tag = `Ref${cslCount + i + 1}`;
        liveSources.push(src);
      });
      orderedNums.forEach((orig, i) => {
        originalToPositional.set(orig, i + 1);
      });
      (buildWordLive as any)._lastMap = originalToPositional;
      // If the CslItem path populated a map, pass it to buildWordLive
      // so the CITATION field rewriter can remap the user's original
      // [N] markers (e.g. 1, 4, 7) to positional ids (1, 2, 3).
      // The bibliography style (ieee, apa, vancouver) is read from
      // the user's config (`citation_style`) so they can switch
      // between numbered and author-date formats via /paper-lab.
      const config = loadConfig();
      const styleRaw = (config.citation_style ?? "ieee").toLowerCase();
      const style: "ieee" | "apa" | "vancouver" =
        styleRaw === "apa" ? "apa"
        : styleRaw === "vancouver" ? "vancouver"
        : "ieee";
      const buildOpts: any = { style };
      const lastMap = (buildWordLive as any)._lastMap as
        | Map<number, number>
        | undefined;
      if (lastMap) {
        buildOpts.originalToPositional = lastMap;
        // Clear so a fallback path doesn't accidentally use it.
        (buildWordLive as any)._lastMap = undefined;
      }
      // v0.7.6: ship the resolved reference list as the BIBLIOGRAPHY field's
      // cached result so non-Word apps render a complete bibliography.
      buildOpts.cachedBibliography = [...citations.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([n, v]) => `[${n}] ${plainTextCitation(v.replace(/^\[?\d+\]\.?\s*/, ""))}`);
      // v0.7.6: only install the superscript XSL when the caller EXPLICITLY opts
      // in. Never auto-install files to %APPDATA%.
      buildOpts.installStyleXsl = !!opts?.installStyleXsl;
      buildWordLive(docxPath, liveSources, buildOpts);
    } catch (err: any) {
      console.error("[paper-lab-finalize] WARN: --live build failed, falling back to static:", err?.message ?? err);
    }
  }

  return { docxPath, bibliographyCount: citations.size, error: undefined, liveApplied: live };
}

// === Sidecar citation cache ===
//
// File: <markdownPath>.citations.json
// Schema: { schemaVersion: 1, sourceMarkdown, lastResolvedAt, citationBackend,
//           citations: { [N]: { doi, vancouver } } }
//
// The sidecar is an OPTIMIZATION: it lets /paper-cite and finalizeDoc skip
// repeated CrossRef lookups for already-resolved citations. If the sidecar
// is missing, stale, or malformed, finalizeDoc falls back to direct lookup.
//
// We deliberately keep the format human-readable JSON (not binary) so users
// can grep, diff, and version-control the cache alongside their draft.
interface SidecarEntry {
  doi: string | null;
  vancouver: string;
  /** v0.7.5 (M2): CSL-JSON for the live-citation path. Optional —
   *  sidecars from v0.7.0/v0.7.2 only carry {doi, vancouver}. When
   *  missing, the live path falls back to the Vancouver regex parser
   *  (deprecated, removed in M5). */
  csl?: CslItem;
}

interface SidecarFile {
  schemaVersion: 1;
  sourceMarkdown: string;
  lastResolvedAt: string; // ISO8601
  citationBackend: string;
  citations: Record<string, SidecarEntry>;
}

function sidecarPathFor(markdownPath: string): string {
  // Hostile-audit fix #9: if the path has no .md suffix, .replace is a no-op
  // and would return the path unchanged — writing the sidecar OVER the source.
  // Append the suffix instead.
  return /\.md$/i.test(markdownPath)
    ? markdownPath.replace(/\.md$/i, ".citations.json")
    : markdownPath + ".citations.json";
}

function loadCitationSidecar(markdownPath: string): Map<number, SidecarEntry> {
  const out = new Map<number, SidecarEntry>();
  const cachePath = sidecarPathFor(markdownPath);
  if (!existsSync(cachePath)) return out;
  let raw: string;
  try {
    raw = readFileSync(cachePath, "utf-8");
  } catch {
    return out;
  }
  let parsed: SidecarFile;
  try {
    parsed = JSON.parse(raw) as SidecarFile;
  } catch {
    // Malformed JSON — treat as empty cache. Don't fail loudly; the user
    // might have corrupted the file manually and finalizeDoc still works
    // via CrossRef fallback.
    return out;
  }
  // Validate schema. If schemaVersion is unsupported, bail rather than
  // guess — we'd rather miss cache hits than corrupt the bibliography.
  if (!parsed || parsed.schemaVersion !== 1 || !parsed.citations) return out;
  for (const [numStr, entry] of Object.entries(parsed.citations)) {
    const num = parseInt(numStr);
    if (!isFinite(num) || num < 1 || num >= 1000) continue;
    if (!entry || typeof entry.vancouver !== "string") continue;
    // CRIT-2 fix: also load CSL-JSON if present (written by a previous
    // v0.7.5 run). Without this, the live builder's cslItems Map is
    // empty on every re-run and we fall back to the regex parser.
    out.set(num, {
      doi: entry.doi ?? null,
      vancouver: entry.vancouver,
      csl: (entry as any).csl as CslItem | undefined,
    });
  }
  return out;
}


// === Generate .docx from a resolved Markdown file (legacy, kept for /paper-to-word) ===
// Step 1: create .docx with [N] as plain text
// Step 2: for each [N], add a Word footnote (superscript reference + citation text at bottom)
// NOTE: finalizeDoc is the preferred function. This is kept for backward compat.
export function generateWord(
  markdownPath: string,
  outputPath?: string,
): { docxPath: string; error?: string; footnoteCount?: number } {
  try {
    execFileSync("docx", ["--version"], { stdio: "pipe" });
  } catch {
    process.env.PATH = `${process.env.HOME ?? ""}/.local/bin:${process.env.PATH ?? ""}`;
    try {
      execFileSync("docx", ["--version"], { stdio: "pipe" });
    } catch {
      return { docxPath: "", error: "bun-docx CLI not found." };
    }
  }

  const docxPath = outputPath ?? markdownPath.replace(/\.md$/, ".docx");
  const text = readFileSync(markdownPath, "utf-8");

  // Preprocess: strip [CITE:topic] → [CITATION NEEDED]
  // Strip [N](doi:...) → <sup>[N]</sup> (superscript, removes DOI link from text)
  let processed = text.replace(CITE_MARKER, (_m, topic) => `[CITATION NEEDED: ${topic}]`);
  processed = processed.replace(CITE_WITH_DOI, (_m, num) => `<sup>[${num}]</sup>`);

  // Generate bibliography to get Vancouver citations for footnotes
  const dir = dirname(markdownPath);
  const tempMd = join(dir, ".paper-lab.temp.md");
  writeFileSync(tempMd, processed, "utf-8");

  // Step 1: Create .docx
  try {
    execFileSync("docx", ["create", docxPath, "--from", tempMd, "--force"], { stdio: "pipe" });
  } catch (err: any) {
    try { unlinkSync(tempMd); } catch {}
    return { docxPath: "", error: err?.message ?? String(err) };
  }

  // Step 2: Add footnotes for each [N] — converts [N] to superscript footnote reference
  // Parse the bibliography to get citation text per number
  const citationMap = parseInlineBibliography(text);
  let footnoteCount = 0;

  for (const [numStr, citation] of Object.entries(citationMap)) {
    const num = parseInt(numStr);
    if (!num || !citation) continue;

    // Find [N] in the docx and add a footnote at that position
    try {
      // Use docx find to locate [N] in the document
      const findOutput = execFileSync("docx", ["find", docxPath, `[${num}]`], {
        stdio: "pipe",
        encoding: "utf-8",
      }).trim();

      if (!findOutput) continue;

      // Take the first occurrence
      const locator = findOutput.split("\n")[0].trim();
      if (!locator) continue;

      // Add footnote at that position
      execFileSync("docx", [
        "footnotes", "add", docxPath,
        "--at", locator,
        "--text", citation,
      ], { stdio: "pipe", encoding: "utf-8" });
      footnoteCount++;
    } catch {
      // footnote addition failed — [N] stays as plain text
    }
  }

  try { unlinkSync(tempMd); } catch {}
  return { docxPath, footnoteCount };
}

// Parse inline [N](doi:...) markers and build a map of number → Vancouver citation
// Uses synchronous CrossRef lookup (called during Word generation)
function parseInlineBibliography(text: string): Record<number, string> {
  const map: Record<number, string> = {};
  const re = /\[(\d+)\]\((?:doi:([^)>\s]+)|<doi:([^>]+)>)\)/g;
  let m: RegExpExecArray | null;
  const seen = new Set<number>();
  while ((m = re.exec(text)) !== null) {
    const num = parseInt(m[1]);
    const doi = m[2] ?? m[3];
    if (!doi || seen.has(num)) continue;
    seen.add(num);

    // Synchronous DOI lookup — needed because generateWord is sync
    // (execFileSync cannot be async)
    try {
      const work = lookupDoiSync(doi);
      if (work) {
        const authors = work.author?.map((a: any) =>
          a.family ? `${a.family} ${a.given ?? ""}`.trim() : a.name ?? "?").join(", ") ?? "";
        const year = work.published?.["date-parts"]?.[0]?.[0] ?? work["published-print"]?.["date-parts"]?.[0]?.[0] ?? work["published-online"]?.["date-parts"]?.[0]?.[0] ?? work.published?.dateParts?.[0] ?? "?";
        const title = work.title?.[0] ?? "(untitled)";
        const journal = work["container-title"]?.[0] ?? "";
        map[num] = `${authors}. ${title}. ${journal}. ${year}. doi:${doi}`;
      } else {
        map[num] = `Citation ${num} (doi:${doi})`;
      }
    } catch {
      map[num] = `Citation ${num} (doi:${doi})`;
    }
  }
  return map;
}

// Synchronous CrossRef DOI lookup.
//
// CRIT-3 fix: previously this used `execFileSync("curl", ...)` which
// is dead on Windows (no `curl` binary, or different name/flags). We
// now spawn `node -e <script>` and use the built-in `fetch` (Node 18+).
// This works on macOS, Linux, and Windows identically.
function lookupDoiSync(doi: string): any | null {
  const cleanDoiUrl = cleanDoi(doi.replace(/^https?:\/\/doi\.org\//i, ""));
  const url = `https://api.crossref.org/works/${encodeURIComponent(cleanDoiUrl)}`;
  // The script is a string literal that gets `eval`'d by `node -e`. We
  // pass the URL as an argv slot and read it via process.argv to avoid
  // any shell-quoting issues (Windows cmd interprets `&`, `^`, etc.).
  const script = `
    (async () => {
      try {
        const url = process.argv[1];
        const r = await fetch(url, { headers: { "User-Agent": "pi-paper-lab/0.7" } });
        if (!r.ok) { process.stdout.write(""); process.exit(0); }
        const data = await r.json();
        process.stdout.write(JSON.stringify(data?.message ?? null));
      } catch { process.stdout.write(""); }
    })();
  `;
  try {
    const output = execFileSync(process.execPath, ["-e", script, url], {
      stdio: "pipe",
      encoding: "utf-8",
      timeout: 15000,
    });
    if (!output) return null;
    return JSON.parse(output);
  } catch {
    return null;
  }
}
