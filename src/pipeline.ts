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
import { lookupDoi, formatVancouver, type CrossRefWork } from "./crossref.ts";
import { detectAI, detectRewriteLoop, formatDetectionReport, type AIDetectionResult } from "./ai-detector.ts";
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
  // Single shell pipeline that works on bash, Git Bash, and PowerShell-via-Cmd:
  //   1. Try `command -v paper-lab-finalize` first (PATH lookup).
  //   2. Else fall back to the well-known install location under .pi/agent.
  //   3. Else fall back to npx (will fetch from npm registry if absent).
  return [
    `if command -v paper-lab-finalize >/dev/null 2>&1; then`,
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
    `STEP 4 — FINALIZE: Run this shell command (it does bibliography + superscript + .docx automatically):`,
    `   ${finalizeCommand(outPath.replace(/\\/g, "/"))}`,
    `   If the command reports "paper-lab-finalize not installed", run \`pi install npm:pi-paper-lab\` first, then retry.`,
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

  return [
    `Paper draft: ${filePath}`,
    ``,
    userBlock,
    cacheBlock,
    `---`,
    text,
    `---`,
    ``,
    rewriteBlock,
    studyBlock,
    `STEP ${startStep} — CITE: Mark every factual claim that is NOT already cited with [CITE:topic]. Read the CITATIONS ALREADY PRESENT block above carefully — every [N] listed there is already valid; do NOT re-search or re-mark those claims. Call find_citation ONLY for genuinely new claims (batch parallel). Assign NEW [N] sequentially starting from max(existing)+1 (the block tells you the current maximum). ALWAYS use angle brackets around the DOI: [N](<doi:10.xxxx>). Write the resolved file to ${filePath}.`,
    `STEP ${startStep + 1} — FINALIZE: Run this shell command (it does bibliography + superscript + .docx automatically):`,
    `   ${finalizeCommand(filePath.replace(/\\/g, "/"))}${verifyAll ? " --verify-all" : ""}`,
    `   If the command reports "paper-lab-finalize not installed", run \`pi install npm:pi-paper-lab\` first, then retry. To force fresh DOI resolution (bypass cache), add \`--no-cache\` at the end. To verify ALL citations (including ones with cached DOIs), add \`--verify-all\`.`,
    `STEP ${startStep + 2} — REPORT: Tell the user the .docx path. Do NOT read the .docx (binary).`,
    ``,
    `Do ALL steps in ONE turn. Do not stop between steps.`,
  ].filter(Boolean).join("\n");
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

// === finalizeDoc: ONE function that does everything ===
// Reads .md with [N](doi:...) → generates bibliography → strips DOI → superscript [N] → .docx
// The LLM only needs to write the .md and call this.
export function finalizeDoc(
  markdownPath: string,
  opts?: {
    noCache?: boolean;
    verifyAll?: boolean;
    // Dependency injection for tests. Production callers omit this and the
    // real `lookupDoiSync` (which hits CrossRef) is used. Tests pass a
    // fixture-backed function to keep the suite offline.
    lookupDoi?: (doi: string) => CrossRefWork | null;
  },
): { docxPath: string; bibliographyCount: number; error?: string } {
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
      if (cachedEntry?.doi === doi) continue; // cache hit, DOI matches
      citations.delete(num); // stale or first-time — start fresh
    } else if (verifyAll) {
      // verifyAll: drop any cached entry that was pre-populated above.
      // The loop body below re-fetches via CrossRef unconditionally.
      citations.delete(num);
    }
    try {
      const work = resolveDoi(doi);
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

  // 3. Append References section (DOI only here, never in text)
  if (citations.size > 0) {
    const refs = [...citations.entries()].sort((a, b) => a[0] - b[0]).map(([, c]) => c).join("\n\n");
    text += `\n\n---\n\n## References\n\n${refs}\n`;
  }

  // 3a. CRIT-2 fix: detect which citation numbers are actually USED in the
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
      // Try to extract the DOI back out of the Vancouver string for the cache.
      // Schema: the Vancouver entry includes "doi:10.xxxx" (resolved) or
      // the placeholder text (unresolved).
      const doiMatch = vancouver.match(/doi:(10\.[^\s\n]+)/);
      entries[String(num)] = {
        doi: doiMatch ? doiMatch[1] : null,
        vancouver,
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

  return { docxPath, bibliographyCount: citations.size };
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
}

interface SidecarFile {
  schemaVersion: 1;
  sourceMarkdown: string;
  lastResolvedAt: string; // ISO8601
  citationBackend: string;
  citations: Record<string, SidecarEntry>;
}

function sidecarPathFor(markdownPath: string): string {
  return markdownPath.replace(/\.md$/i, ".citations.json");
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
    out.set(num, { doi: entry.doi ?? null, vancouver: entry.vancouver });
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

// Synchronous CrossRef DOI lookup (uses child_process to call node)
function lookupDoiSync(doi: string): any | null {
  const cleanDoiUrl = cleanDoi(doi.replace(/^https?:\/\/doi\.org\//i, ""));
  const url = `https://api.crossref.org/works/${encodeURIComponent(cleanDoiUrl)}`;
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
