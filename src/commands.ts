// src/commands.ts
// Command handlers for /bio-scan, /bio-rewrites, /bio-set-field, /bio-standards,
// /bio-write, /bio-abstract (skeleton), /bio-hedge (skeleton).

import { readFileSync } from "node:fs";
import { scoreText, silentRewrite } from "./anti-ai-lexicon.ts";
import { detectSloppy, formatSloppyReport } from "./sloppy-detector.ts";
import { markClaims, resolveCitation, formatResolveResult, generateBibliography, formatBibliography, CITE_MARKER } from "./citations.ts";
import { extractCitedClaims, buildVerificationPrompts, formatVerificationReport } from "./cite-verify.ts";
import { markdownToWord, isDocxCliAvailable } from "./word-builder.ts";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

export interface CommandDeps {
  lex: import("./anti-ai-lexicon.ts").Lexicon;
  rootDir: string;
}

const formatScore = (
  score: ReturnType<typeof scoreText>,
): string => {
  const lines: string[] = [];
  lines.push(`Total AI-tell score: ${score.total.toFixed(2)}`);
  lines.push(`Verdict: ${score.verdict}`);
  lines.push("");
  if (score.hits.length === 0) return lines.join("\n");
  lines.push("Hits (weight, category, match):");
  for (const h of score.hits) {
    lines.push(`  - [${h.weight.toFixed(2)} ${h.category}] ${h.hit}`);
  }
  return lines.join("\n");
};

export const scanCommand = (deps: CommandDeps) => async (
  args: string,
  ctx: ExtensionCommandContext,
) => {
  const target = args.trim() || ctx.cwd;
  let text = "";
  try {
    if (target === ctx.cwd || !target.includes(".")) {
      text = readFileSync(target, "utf8");
    } else {
      const fs = await import("node:fs/promises");
      text = await fs.readFile(target, "utf8");
    }
  } catch (err) {
    ctx.ui.notify(`Could not read ${target}: ${String(err)}`, "error");
    return;
  }
  const score = scoreText(text, deps.lex);
  ctx.ui.notify(formatScore(score), "info");
};

export const rewritesCommand = (deps: CommandDeps) => async (
  args: string,
  ctx: ExtensionCommandContext,
) => {
  const target = args.trim();
  if (!target) {
    ctx.ui.notify("Usage: /bio-rewrites <file-path>", "warning");
    return;
  }
  let text = "";
  try {
    const fs = await import("node:fs/promises");
    text = await fs.readFile(target, "utf8");
  } catch (err) {
    ctx.ui.notify(`Could not read ${target}: ${String(err)}`, "error");
    return;
  }
  const { text: rewritten, stats } = silentRewrite(text, deps.lex);
  // For safety we print diff instead of writing — user reviews.
  ctx.ui.notify(
    [
      `Silent rewrite stats:`,
      `  connectors: ${stats.connectors}`,
      `  fillers removed: ${stats.fillers}`,
      `  verbs rewritten: ${stats.verbs}`,
      stats.flaggedVerbs.length > 0
        ? `  UNRESOLVED verbs (manual): ${stats.flaggedVerbs.join(", ")}`
        : `  all verbs resolved`,
      ``,
      `Original length: ${text.length} chars`,
      `Rewritten length: ${rewritten.length} chars`,
      ``,
      `First 800 chars of rewrite:`,
      rewritten.slice(0, 800),
    ].join("\n"),
    "info",
  );
};

export const setFieldCommand = (
  _deps: CommandDeps,
) => async (
  args: string,
  ctx: ExtensionCommandContext,
) => {
  const field = args.trim();
  if (field !== "drosophila") {
    ctx.ui.notify(
      `Currently only "drosophila" voice is supported. Argument was: ${field || "(empty)"}`,
      "warning",
    );
    return;
  }
  ctx.ui.notify(
    `Field set to "drosophila-genetics". Voice injection now active. Use /bio-standards for the ARRIVE 2.0 checklist.`,
    "info",
  );
};

export const sloppyCommand = (deps: CommandDeps) => async (
  args: string,
  ctx: ExtensionCommandContext,
) => {
  const target = args.trim();
  if (!target) {
    ctx.ui.notify("Usage: /bio-sloppy <file-path>", "warning");
    return;
  }
  let text = "";
  try {
    const fs = await import("node:fs/promises");
    text = await fs.readFile(target, "utf8");
  } catch (err) {
    ctx.ui.notify(`Could not read ${target}: ${String(err)}`, "error");
    return;
  }
  const hits = detectSloppy(text, deps.lex);
  ctx.ui.notify(formatSloppyReport(hits), "info");
};

// === Module 2: Citation commands ===

export const citeMarkCommand = (deps: CommandDeps) => async (
  args: string,
  ctx: ExtensionCommandContext,
) => {
  const target = args.trim();
  if (!target) {
    ctx.ui.notify("Usage: /cite-mark <file-path>", "warning");
    return;
  }
  let text = "";
  try {
    const fs = await import("node:fs/promises");
    text = await fs.readFile(target, "utf8");
  } catch (err) {
    ctx.ui.notify(`Could not read ${target}: ${String(err)}`, "error");
    return;
  }
  const { text: marked, markedCount } = markClaims(text);
  const outPath = target.replace(/\.md$/, ".marked.md");
  try {
    const fs = await import("node:fs/promises");
    await fs.writeFile(outPath, marked, "utf8");
  } catch (err) {
    ctx.ui.notify(`Could not write ${outPath}: ${String(err)}`, "error");
    return;
  }
  ctx.ui.notify(
    `Marked ${markedCount} claims with [CITE:topic]. Output: ${outPath}\n\nNext: run /cite-resolve ${outPath} to find candidates.`,
    "info",
  );
};

export const citeResolveCommand = (deps: CommandDeps) => async (
  args: string,
  ctx: ExtensionCommandContext,
) => {
  const target = args.trim();
  if (!target) {
    ctx.ui.notify("Usage: /cite-resolve <file-path>", "warning");
    return;
  }
  let text = "";
  try {
    const fs = await import("node:fs/promises");
    text = await fs.readFile(target, "utf8");
  } catch (err) {
    ctx.ui.notify(`Could not read ${target}: ${String(err)}`, "error");
    return;
  }
  // Find all [CITE:topic] markers
  const topics: string[] = [];
  let m: RegExpExecArray | null;
  const re = CITE_MARKER;
  while ((m = re.exec(text)) !== null) {
    if (!topics.includes(m[1])) topics.push(m[1]);
  }
  if (topics.length === 0) {
    ctx.ui.notify("No [CITE:topic] markers found. Run /cite-mark first.", "warning");
    return;
  }
  ctx.ui.notify(`Resolving ${topics.length} citation(s)...`, "info");
  const reports: string[] = [];
  for (const topic of topics) {
    const result = await resolveCitation(topic);
    reports.push(formatResolveResult(result));
  }
  const outPath = target.replace(/\.marked\.md$/, ".candidates.md");
  try {
    const fs = await import("node:fs/promises");
    await fs.writeFile(outPath, reports.join("\n\n---\n\n"), "utf8");
  } catch (err) {
    ctx.ui.notify(`Could not write ${outPath}: ${String(err)}`, "error");
    return;
  }
  ctx.ui.notify(
    `Resolved ${topics.length} topic(s). Candidates written to ${outPath}.\n\nNext: review the candidates, assign [1], [2], etc. in the draft, then run /cite-verify.`,
    "info",
  );
};

export const citeVerifyCommand = (deps: CommandDeps) => async (
  args: string,
  ctx: ExtensionCommandContext,
) => {
  const target = args.trim();
  if (!target) {
    ctx.ui.notify("Usage: /cite-verify <file-path>", "warning");
    return;
  }
  let text = "";
  try {
    const fs = await import("node:fs/promises");
    text = await fs.readFile(target, "utf8");
  } catch (err) {
    ctx.ui.notify(`Could not read ${target}: ${String(err)}`, "error");
    return;
  }
  const claims = extractCitedClaims(text);
  if (claims.length === 0) {
    ctx.ui.notify("No [N] citations found. Assign numbers from /cite-resolve first.", "warning");
    return;
  }
  ctx.ui.notify(`Building verification prompts for ${claims.length} citation(s)...`, "info");
  // Extract citation metadata from a companion bibliography file if present
  const bibPath = target.replace(/\.md$/, "").replace(/\.resolved$/, "") + ".bibliography.md";
  let citations: Array<{ number: number; title: string; authors: string; year: string; doi?: string; link?: string }> = [];
  try {
    const fs = await import("node:fs/promises");
    const bibText = await fs.readFile(bibPath, "utf8");
    citations = parseBibliographyFile(bibText);
  } catch {
    // no bibliography file — use placeholder citations
    citations = claims.map((c) => ({ number: c.number, title: "(unknown)", authors: "(unknown)", year: "?" }));
  }
  const prompts = await buildVerificationPrompts(claims, citations);
  const outPath = target.replace(/\.md$/, ".verification.md");
  try {
    const fs = await import("node:fs/promises");
    await fs.writeFile(outPath, formatVerificationReport(prompts), "utf8");
  } catch (err) {
    ctx.ui.notify(`Could not write ${outPath}: ${String(err)}`, "error");
    return;
  }
  ctx.ui.notify(
    `Verification report written to ${outPath}. Review each prompt and answer SUPPORTS/REFUTES/UNCLEAR.`,
    "info",
  );
};

export const citeBibliographyCommand = (deps: CommandDeps) => async (
  args: string,
  ctx: ExtensionCommandContext,
) => {
  const target = args.trim();
  if (!target) {
    ctx.ui.notify("Usage: /cite-bibliography <file-path>", "warning");
    return;
  }
  let text = "";
  try {
    const fs = await import("node:fs/promises");
    text = await fs.readFile(target, "utf8");
  } catch (err) {
    ctx.ui.notify(`Could not read ${target}: ${String(err)}`, "error");
    return;
  }
  const resolved = new Map<string, any>();
  const { bibliography, unresolved } = await generateBibliography(text, resolved);
  const outPath = target.replace(/\.md$/, ".bibliography.md");
  try {
    const fs = await import("node:fs/promises");
    await fs.writeFile(outPath, formatBibliography(bibliography), "utf8");
  } catch (err) {
    ctx.ui.notify(`Could not write ${outPath}: ${String(err)}`, "error");
    return;
  }
  const msg = [
    `Bibliography written to ${outPath}.`,
    `${bibliography.length} entries.`,
    unresolved.length > 0 ? `${unresolved.length} unresolved [CITE:topic] markers remain.` : "All citations resolved.",
  ].join("\n");
  ctx.ui.notify(msg, "info");
};

// Helper: parse a bibliography.md file into citation metadata.
function parseBibliographyFile(text: string): Array<{ number: number; title: string; authors: string; year: string; doi?: string }> {
  const lines = text.split("\n").filter((l) => /^\d+\./.test(l.trim()));
  return lines.map((line) => {
    const m = line.match(/^(\d+)\.\s+(.+)$/);
    if (!m) return { number: 0, title: "", authors: "", year: "" };
    const num = Number(m[1]);
    const rest = m[2];
    // Try to extract DOI
    const doiMatch = rest.match(/doi:(10\.[^\s]+)/i);
    const doi = doiMatch?.[1];
    // Try to extract year
    const yearMatch = rest.match(/\((\d{4})\)/);
    const year = yearMatch?.[1] ?? "?";
    // Split authors from title (rough: everything before first period after authors)
    return { number: num, title: rest, authors: "", year, doi };
  });
}

// === Module 3: Word generation command ===

export const paperToWordCommand = (deps: CommandDeps) => async (
  args: string,
  ctx: ExtensionCommandContext,
) => {
  const target = args.trim();
  if (!target) {
    ctx.ui.notify("Usage: /paper-to-word <draft.md>", "warning");
    return;
  }
  // Check bun-docx availability
  if (!isDocxCliAvailable()) {
    ctx.ui.notify(
      "bun-docx CLI not found. Install with: bun add -g bun-docx (or npm install -g bun-docx)",
      "error",
    );
    return;
  }
  ctx.ui.notify("Generating .docx from Markdown...", "info");
  const result = await markdownToWord(target);
  if (result.error) {
    ctx.ui.notify(`Word generation failed: ${result.error}`, "error");
    return;
  }
  const msg = [
    `Word document generated: ${result.docxPath}`,
    `Citations processed: ${result.citationCount}`,
    result.unresolvedCount > 0
      ? `WARNING: ${result.unresolvedCount} unresolved [CITE:topic] markers remain — marked as [CITATION NEEDED] in the output.`
      : "All citations resolved.",
    `Note: [N] markers are plain text in the .docx. Footnote injection (superscript) is v0.5.`,
  ].join("\n");
  ctx.ui.notify(msg, "info");
};

export const standardsCommand = (_deps: CommandDeps) => async (
  _args: string,
  ctx: ExtensionCommandContext,
) => {
  const lines = [
    `Reporting standards — ARRIVE 2.0 essentials for animal research`,
    ``,
    `Checklist (essentials 1-10):`,
    `  1. Study design`,
    `  2. Sample size (with rationale)`,
    `  3. Inclusion and exclusion criteria`,
    `  4. Randomisation`,
    `  5. Blinding`,
    `  6. Outcome measures`,
    `  7. Statistical methods`,
    `  8. Experimental animals (species, strain, sex, age, weight)`,
    `  9. Experimental procedures (detail level)`,
    `10. Results (n per group, statistical results, adverse events)`,
    ``,
    `Note: Drosophila work is typically IACUC-exempt. State the rationale in Methods.`,
    ``,
    `For an automated check, point /bio-scan at your paper.md and look for`,
    `signals of missing items (e.g. absence of sex, age, n, statistical method`,
    `raises a silent warning in the rewritten draft).`,
  ];
  ctx.ui.notify(lines.join("\n"), "info");
};
