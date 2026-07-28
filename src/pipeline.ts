// src/pipeline.ts
// Two automatic pipelines:
// 1. /paper-cite <file>    → LLM identifies claims, batch search, add citations
// 2. /paper-rewrite <file> → silent rewrite (anti-AI) + LLM cite-mark + batch search + citations
//
// Both use the active LLM for cite-mark (not regex) and batch find_citation.
// The old /bio-scan, /cite-mark, /cite-resolve etc. are hidden (internal only).

import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
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
import { lookupDoi, formatVancouver } from "./crossref.ts";
import { detectAI, detectRewriteLoop, formatDetectionReport, type AIDetectionResult } from "./ai-detector.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

// When re-reading a .docx that was already processed:
// 1. Parse the References section to extract DOIs per [N]
// 2. Replace bare [N] / <sup>[N]</sup> in text with [N](doi:...)
// 3. Strip the References section (finalizeDoc will regenerate it)
// This PRESERVES old citations so new text can be added without losing them.
function cleanExtractedDocx(text: string): string {
  let cleaned = text;

  // 1. Extract the References section (any heading format)
  const refsMatch = cleaned.match(/(?:---+\s*\n+)?#{1,3}\s*References\s*\n([\s\S]*?)$/i)
    ?? cleaned.match(/(?:---+\s*\n+)?\*{0,2}References\*{0,2}\s*\n([\s\S]*?)$/i);

  const doiMap = new Map<number, string>();
  if (refsMatch) {
    const refsText = refsMatch[1];
    // Parse each reference line: "N. Authors. Title. Journal. Year. doi:10.xxxx"
    const refLines = refsText.split(/\n\n+/);
    for (const line of refLines) {
      const numMatch = line.match(/^\s*(\d+)\.\s/);
      const doiMatch = line.match(/doi:(10\.[^\s\n]+)/i);
      if (numMatch && doiMatch) {
        doiMap.set(parseInt(numMatch[1]), doiMatch[1]);
      }
    }
  }

  // 2. Strip the References section entirely (finalizeDoc regenerates it)
  cleaned = cleaned.replace(/\n*---+\n*#{1,3}\s*References[\s\S]*$/i, "");
  cleaned = cleaned.replace(/\n*#{1,3}\s*References[\s\S]*$/i, "");
  cleaned = cleaned.replace(/\n*---+\n*\*{0,2}References\*{0,2}[\s\S]*$/i, "");

  // 3. Replace <sup>[N]</sup> → [N](doi:...) if we have the DOI, else just [N]
  cleaned = cleaned.replace(/<sup>\[(\d+)\]<\/sup>/g, (m, num) => {
    const doi = doiMap.get(parseInt(num));
    return doi ? `[${num}](doi:${doi})` : `[${num}]`;
  });

  // 4. Replace bare [N] (not followed by '(') → [N](doi:...) if we have the DOI
  cleaned = cleaned.replace(/\[(\d+)\](?!\()/g, (m, num) => {
    const doi = doiMap.get(parseInt(num));
    return doi ? `[${num}](doi:${doi})` : `[${num}]`;
  });

  // 5. Clean up multiple blank lines
  cleaned = cleaned.replace(/\n{3,}/g, "\n\n");
  return cleaned.trim() + "\n";
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
    writeFileSync(mdPath, readInputFile(inputPath), "utf-8");
    workPath = mdPath;
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
  // If .docx, extract to .md first
  let workPath = inputPath;
  if (/\.docx$/i.test(inputPath)) {
    const mdPath = inputPath.replace(/\.docx$/i, ".md");
    writeFileSync(mdPath, readInputFile(inputPath), "utf-8");
    workPath = mdPath;
  }
  const text = readFileSync(workPath, "utf8");
  const lex = loadLexicon(ROOT);

  // Step 1: AI detect-rewrite loop
  const { text: rewritten, iterations, finalScore, initialScore, source } =
    await detectRewriteLoop(text, lex, { maxIterations: 3 });

  // If still AI after loop, identify flagged sentences for the LLM
  const finalDetection = await detectAI(rewritten, lex);

  const rewrittenPath = inputPath.replace(/\.md$/, ".rewritten.md");
  writeFileSync(rewrittenPath, rewritten, "utf-8");

  const header = [
    `=== /paper-rewrite pipeline ===`,
    `File: ${inputPath}`,
    `Rewrite instructions: ${rewriteInstructions || "(default: anti-AI sloppy cleanup)"}`,
    ``,
    `Step 1: AI detect-rewrite loop DONE (${iterations} iterations)`,
    `  Detection source: ${source}`,
    `  AI score: ${initialScore}% → ${finalScore}%`,
    `  ${finalDetection.isAI ? "⚠️ Still AI-flagged — LLM must rewrite flagged sentences." : "✅ Human-like."}`,
    `  Rewritten draft: ${rewrittenPath}`,
    ``,
    `Step 2: LLM cite-mark + batch search + citations + Word...`,
  ].join("\n");

  // Build prompt with flagged sentences for the LLM to rewrite
  const flaggedInfo = finalDetection.isAI && finalDetection.flaggedSentences.length > 0
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

  const prompt = buildCiteMarkPrompt(rewrittenPath, rewritten, rewriteInstructions, true);
  pi.sendUserMessage(`${header}${flaggedInfo}\n\n${prompt}`, { deliverAs: "followUp" });
}

// === Pipeline 3: /paper-write ===
// User describes what to write → LLM generates draft → AI check → cite → finalize
export async function pipelineWrite(
  description: string,
  pi: ExtensionAPI,
  opts?: { outputPath?: string },
): Promise<void> {
  // Default: write to the CURRENT working directory (where pi is running).
  // User can override with --output <path>.
  const outPath = opts?.outputPath ?? join(process.cwd(), "paper-write-output.md");
  const notesPath = outPath.replace(/\.md$/, ".study-notes.md");

  const prompt = [
    `Write new text for a biology paper based on this description:`,
    ``,
    `"${description}"`,
    ``,
    `Follow the domain-specific voice rules in your system prompt (species, nomenclature, reporting standards are all defined by the active domain YAML).`,
    `- Reporting: n=X per group, statistical test, p-value, effect size, 95% CI.`,
    `- No AI-tells: no "delve", "leverage", "elucidate", "crucially", "notably".`,
    `- Paragraphs of 3-6 sentences. Vary sentence length.`,
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
    `STEP 4 — FINALIZE: Run this bash command:`,
    `   node --experimental-strip-types -e "import('${join(ROOT, 'src', 'pipeline.ts').replace(/\\/g, '/')}').then(({finalizeDoc}) => { const r = finalizeDoc('${outPath.replace(/\\/g, '/')}'); if (r.error) console.log('Error:', r.error); else console.log('Done! Word:', r.docxPath, '| References:', r.bibliographyCount); }).catch(err => console.log('Error:', err.message));"`,
    `STEP 5 — REPORT: Tell the user: number of papers studied, path to study-notes.md, path to .docx. Do NOT read the .docx (binary).`,
  ].join("\n");

  pi.sendUserMessage(prompt, { deliverAs: "followUp" });
}

// === Build the LLM cite-mark prompt ===
function buildCiteMarkPrompt(filePath: string, text: string, rewriteInstructions?: string, includeRewrite?: boolean, userInstructions?: string): string {
  const finalizeCmd = `node --experimental-strip-types -e "import('${join(ROOT, 'src', 'pipeline.ts').replace(/\\/g, '/')}').then(({finalizeDoc}) => { const r = finalizeDoc('${filePath.replace(/\\/g, '/')}'); if (r.error) console.log('Error:', r.error); else console.log('Done! Word:', r.docxPath, '| References:', r.bibliographyCount); }).catch(err => console.log('Error:', err.message));"`;

  const userBlock = userInstructions
    ? `USER INSTRUCTIONS (follow these):\n${userInstructions}\n\n`
    : "";

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

  return [
    `Paper draft: ${filePath}`,
    ``,
    userBlock,
    `---`,
    text,
    `---`,
    ``,
    rewriteBlock,
    studyBlock,
    `STEP ${startStep} — CITE: Mark every factual claim with [CITE:topic]. Call find_citation for each (batch parallel). Assign [N](<doi:10.xxxx>) sequentially — ALWAYS use angle brackets around the doi, even for simple DOIs. Write the resolved file to ${filePath}.`,
    `STEP ${startStep + 1} — FINALIZE: Run this bash command (it does bibliography + superscript + .docx automatically):`,
    `   ${finalizeCmd}`,
    `STEP ${startStep + 2} — REPORT: Tell the user the .docx path. Do NOT read the .docx (binary).`,
    ``,
    `Do ALL steps in ONE turn. Do not stop between steps.`,
  ].filter(Boolean).join("\n");
}

// === finalizeDoc: ONE function that does everything ===
// Reads .md with [N](doi:...) → generates bibliography → strips DOI → superscript [N] → .docx
// The LLM only needs to write the .md and call this.
export function finalizeDoc(markdownPath: string): { docxPath: string; bibliographyCount: number; error?: string } {
  const docxPath = markdownPath.replace(/\.md$/i, ".docx");
  let text = readFileSync(markdownPath, "utf-8");

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
  // Primary: angle-bracket form [N](<doi:XXX>) — handles ALL DOIs including parens
  // Fallback: plain form [N](doi:XXX) — but only for DOIs without parens (safe)
  const re = /\[(\d+)\]\((?:<doi:\s*([^>\n]+)>|doi:\s*([^)>\n]+))\)/g;
  let m: RegExpExecArray | null;
  // Strip trailing punctuation (LLM bugs that leave `;` or `,` at end of DOI)
  const cleanDoi = (s: string) => s.replace(/[;,.]$/, "").trim();
  while ((m = re.exec(text)) !== null) {
    const num = parseInt(m[1]);
    const doi = cleanDoi(m[2] ?? m[3] ?? "");
    if (!doi || citations.has(num)) continue;
    try {
      const work = lookupDoiSync(doi);
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
        citations.set(num, `${num}. ${authors}. ${title}. ${journal}. ${year}${vol ? ";" + vol : ""}${pages ? ":" + pages : ""}. doi:${doi}`);
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

  // 2b. Defensive: catch malformed DOI markers (LLM bugs) — extract DOI from any
  // "[N](doi:...anything...)" pattern even if parens don't close properly.
  // This prevents raw DOI text from leaking into the body.
  text = text.replace(/\[(\d+)\]\(doi:\s*([^\s\n][^)\n]*)/g, (_m, num, doi) => {
    // Trim trailing semicolons/commas/periods that the LLM might have added
    const cleanDoi = doi.replace(/[;,.]$/, "").trim();
    if (cleanDoi.startsWith("10.")) {
      // Try to add to citations if not already there
      const n = parseInt(num);
      if (!citations.has(n)) {
        citations.set(n, `${n}. (doi:${cleanDoi})`);
      }
    }
    return `<sup>[${num}]</sup>`;
  });

  // 3. Append References section (DOI only here, never in text)
  if (citations.size > 0) {
    const refs = [...citations.entries()].sort((a, b) => a[0] - b[0]).map(([, c]) => c).join("\n\n");
    text += `\n\n---\n\n## References\n\n${refs}\n`;
  }

  // 3b. Normalize any leftover references LLM wrote directly in the document.
  // Format: "<number>.   <text>" → "<number>. <text>" (collapse multi-space after period).
  // Without this, Markdown interprets "9.    Ding" as an ordered list item.
  text = text.replace(/^(\d+)\.\s\s+(?=\S)/gm, '$1. ');

  // 4. Create .docx with --force (overwrite)
  const tempMd = markdownPath.replace(/\.md$/i, ".final.md");
  try {
    writeFileSync(tempMd, text, "utf-8");
  } catch (err: any) {
    return { docxPath: "", bibliographyCount: 0, error: `Cannot write temp file: ${err?.message}` };
  }
  try {
    execFileSync("docx", ["create", docxPath, "--from", tempMd, "--force"], { stdio: "pipe" });
  } catch (err: any) {
    try { unlinkSync(tempMd); } catch {}
    const detail = err?.stderr ? String(err.stderr).slice(0, 200) : err?.message;
    return { docxPath: "", bibliographyCount: 0, error: `docx create failed: ${detail}` };
  }
  try { unlinkSync(tempMd); } catch {}

  return { docxPath, bibliographyCount: citations.size };
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

// Synchronous CrossRef DOI lookup (uses child_process to call node)
function lookupDoiSync(doi: string): any | null {
  const cleanDoi = doi.replace(/^https?:\/\/doi\.org\//i, "").trim();
  const url = `https://api.crossref.org/works/${encodeURIComponent(cleanDoi)}`;
  try {
    // Use curl for synchronous HTTP request
    const output = execFileSync("curl", ["-s", "-H", "User-Agent: pi-paper-lab/0.5", url], {
      stdio: "pipe",
      encoding: "utf-8",
      timeout: 10000,
    });
    const data = JSON.parse(output);
    return data?.message ?? null;
  } catch {
    return null;
  }
}
