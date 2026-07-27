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
      return result;
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

  const header = [
    `=== /paper-cite pipeline ===`,
    `File: ${inputPath}`,
    `Existing citations: ${existingCitations}`,
    `Unresolved [CITE:topic] markers: ${existingMarkers}`,
    ``,
    `Step 1: I will identify claims that need citations (LLM cite-mark).`,
    `Step 2: For each claim, I will search Serper Scholar + CrossRef in batch.`,
    `Step 3: I will assign [N](doi:...) inline.`,
    `Step 4: I will generate the References section and produce a .docx.`,
  ].join("\n");

  const prompt = buildCiteMarkPrompt(workPath, text);
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

// === Build the LLM cite-mark prompt ===
function buildCiteMarkPrompt(filePath: string, text: string, rewriteInstructions?: string, includeRewrite?: boolean): string {
  const finalizeCmd = `node --experimental-strip-types -e "import('${join(ROOT, 'src', 'pipeline.ts').replace(/\\/g, '/')}').then(({finalizeDoc}) => { const r = finalizeDoc('${filePath.replace(/\\/g, '/')}'); if (r.error) console.log('Error:', r.error); else console.log('Done! Word:', r.docxPath, '| References:', r.bibliographyCount); }).catch(err => console.log('Error:', err.message));"`;

  const rewriteBlock = includeRewrite
    ? [`STEP 1 — REWRITE + AI CHECK:`,
       `Rewrite the draft for human scientific voice (Drosophila genetics paper). ${rewriteInstructions ? "Extra: " + rewriteInstructions : ""}`,
       `Call ai_detect_statistical on your rewrite. If score >40%, rewrite the flagged sentences and re-test. Max 3 rounds.`,
       `Write the result to ${filePath.replace(/\.md$/, ".rewritten.md")}. Report initial→final AI score.`,
       ``].join("\n")
    : "";

  const startStep = includeRewrite ? 2 : 1;

  return [
    `Paper draft: ${filePath}`,
    ``,
    `---`,
    text,
    `---`,
    ``,
    rewriteBlock,
    `STEP ${startStep} — CITE: Mark every factual claim with [CITE:topic]. Call find_citation for each (batch parallel). Assign [N](doi:10.xxxx) sequentially. Write the resolved file to ${filePath}.`,
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

  // 1. Parse all [N](doi:...) markers and build Vancouver citations via CrossRef
  const citations = new Map<number, string>();
  // Match: [N](doi:XXX), [N](doi: XXX) with optional space, [N](<doi:XXX>) angle-bracket form,
  // and [N](https://doi.org/XXX) URL form. Group 2=plain, 3=angle, 4=URL prefix.
  const re = /\[(\d+)\]\((?:doi:\s*([^)>\n]+)|<doi:\s*([^>\n]+)>|https?:\/\/doi\.org\/([^)\s\n]+))\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const num = parseInt(m[1]);
    const doi = (m[2] ?? m[3] ?? m[4])?.trim();
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

  // 2. Strip [N](doi:...) → <sup>[N]</sup> (superscript, NO DOI in text)
  // Must match the same formats as the parser above.
  text = text.replace(/\[(\d+)\]\((?:doi:\s*[^)>\n]+|<doi:\s*[^>\n]+>|https?:\/\/doi\.org\/[^)\s\n]+)\)/g, (_m, num) => `<sup>[${num}]</sup>`);
  // Also strip any remaining [CITE:topic] → [CITATION NEEDED]
  text = text.replace(CITE_MARKER, (_m, topic) => `[CITATION NEEDED: ${topic}]`);

  // 3. Append References section (DOI only here, never in text)
  if (citations.size > 0) {
    const refs = [...citations.entries()].sort((a, b) => a[0] - b[0]).map(([, c]) => c).join("\n\n");
    text += `\n\n---\n\n## References\n\n${refs}\n`;
  }

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
