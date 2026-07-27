// src/word-builder.ts
// Pipeline: Markdown draft → preprocessed Markdown → .docx via bun-docx CLI.
// Citations in Vancouver style: [N](doi:...) → superscript [N] + footnote.
// Bibliography section appended at the end.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { generateBibliography, formatBibliography, CITE_WITH_DOI } from "./citations.ts";

// Check if docx CLI (bun-docx) is available on PATH.
export function isDocxCliAvailable(): boolean {
  try {
    execFileSync("docx", ["--version"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

// Preprocess the draft for docx generation:
// 1. Convert [N](doi:...) markers to superscript-friendly format
// 2. Append bibliography section at the end
// 3. Strip [CITE:topic] markers that weren't resolved (flag as [CITATION NEEDED])
export async function preprocessForWord(
  draftPath: string,
): Promise<{ processedText: string; bibliography: string; citationCount: number; unresolvedCount: number }> {
  const text = readFileSync(draftPath, "utf8");

  let processedText = text;
  let citationCount = 0;

  // Replace [N](doi:...) with [N] (superscript will be handled by docx footnotes)
  // We keep [N] as plain text; the footnote-injector adds footnotes after docx creation.
  processedText = processedText.replace(CITE_WITH_DOI, (match, num, doi) => {
    citationCount++;
    return `[${num}]`;
  });

  // Flag unresolved [CITE:topic] markers
  processedText = processedText.replace(/\[CITE:([^\]]+)\]/g, (_match, topic) => {
    return `[CITATION NEEDED: ${topic}]`;
  });

  // Generate bibliography
  const resolved = new Map();
  const { bibliography: bib, unresolved } = await generateBibliography(text, resolved);

  const bibliographySection = bib.length > 0 ? `\n\n${formatBibliography(bib)}` : "";

  return {
    processedText: processedText + bibliographySection,
    bibliography: formatBibliography(bib),
    citationCount,
    unresolvedCount: unresolved.length,
  };
}

// Build a .docx from a preprocessed Markdown file.
// Calls: docx create <output.docx> --from <preprocessed.md>
export function buildDocx(
  markdownPath: string,
  outputPath: string,
): { success: boolean; error?: string } {
  try {
    execFileSync("docx", ["create", outputPath, "--from", markdownPath], {
      stdio: "pipe",
      encoding: "utf-8",
    });
    return { success: true };
  } catch (err: any) {
    return {
      success: false,
      error: err?.message ?? String(err),
    };
  }
}

// Full pipeline: Markdown draft → .docx with footnotes.
export async function markdownToWord(
  draftPath: string,
  outputDocxPath?: string,
): Promise<{ docxPath: string; citationCount: number; unresolvedCount: number; error?: string }> {
  // 0. Check bun-docx is available
  if (!isDocxCliAvailable()) {
    return {
      docxPath: "",
      citationCount: 0,
      unresolvedCount: 0,
      error: "bun-docx CLI not found. Install with: bun add -g bun-docx (or npm install -g bun-docx)",
    };
  }

  // 1. Preprocess: resolve citations, append bibliography
  const { processedText, citationCount, unresolvedCount } = await preprocessForWord(draftPath);

  // 2. Write preprocessed markdown to temp file
  const dir = dirname(draftPath);
  const tempMd = join(dir, ".paper-lab.temp.md");
  writeFileSync(tempMd, processedText, "utf-8");

  try {
    // 3. Build .docx
    const docxPath = outputDocxPath ?? draftPath.replace(/\.md$/, ".docx");
    const buildResult = buildDocx(tempMd, docxPath);

    if (!buildResult.success) {
      return {
        docxPath: "",
        citationCount,
        unresolvedCount,
        error: buildResult.error,
      };
    }

    return { docxPath, citationCount, unresolvedCount };
  } finally {
    // B2 fix: always clean up temp file
    try { unlinkSync(tempMd); } catch { /* already gone */ }
  }
}
