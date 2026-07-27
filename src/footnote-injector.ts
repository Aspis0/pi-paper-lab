// src/footnote-injector.ts
// Post-processing: add Word footnotes to a .docx for each [N] citation.
// Uses bun-docx CLI: docx footnotes add <file> --at <locator> --text <citation>
//
// NOTE: This is a v0.5 feature. For v0.4, citations remain as [N] plain text
// in the .docx. The user can manually convert them to footnotes in Word,
// or wait for v0.5 which will parse the .docx and inject footnotes automatically.

import { execFileSync } from "node:child_process";

export interface FootnoteSpec {
  locator: string;  // e.g. "p3:42"
  text: string;     // full Vancouver citation
}

export function addFootnote(
  docxPath: string,
  spec: FootnoteSpec,
): { success: boolean; footnoteId?: string; error?: string } {
  try {
    const output = execFileSync(
      "docx",
      ["footnotes", "add", docxPath, "--at", spec.locator, "--text", spec.text],
      { stdio: "pipe", encoding: "utf-8" },
    );
    // bun-docx prints the footnote handle (fnN) on success
    const match = output.match(/fn\d+/);
    return { success: true, footnoteId: match?.[0] };
  } catch (err: any) {
    return {
      success: false,
      error: err?.message ?? String(err),
    };
  }
}

// Find all [N] markers in a .docx and return their locators.
// Uses: docx find <file> "[N]"
export function findCitationMarkers(docxPath: string): Array<{ marker: string; locator: string }> {
  const markers: Array<{ marker: string; locator: string }> = [];
  for (let n = 1; n <= 100; n++) {
    const marker = `[${n}]`;
    try {
      const output = execFileSync(
        "docx",
        ["find", docxPath, marker],
        { stdio: "pipe", encoding: "utf-8" },
      );
      // Output is like: p3:5-8
      const locators = output.trim().split("\n").filter(Boolean);
      for (const loc of locators) {
        markers.push({ marker, locator: loc });
      }
    } catch {
      // [N] not found — stop searching higher numbers
      break;
    }
  }
  return markers;
}

// Full footnote injection pipeline (v0.5 — not yet wired into commands).
// 1. Find all [N] markers in the .docx
// 2. For each, look up the Vancouver citation
// 3. Add a footnote at that position
// 4. The [N] text becomes a superscript footnote reference automatically
export function injectFootnotes(
  docxPath: string,
  citations: Array<{ number: number; citation: string }>,
): { injected: number; failed: number; errors: string[] } {
  const errors: string[] = [];
  let injected = 0;
  let failed = 0;

  const markers = findCitationMarkers(docxPath);

  for (const { marker, locator } of markers) {
    const num = Number(marker.match(/\[(\d+)\]/)?.[1]);
    const citation = citations.find((c) => c.number === num);
    if (!citation) {
      failed++;
      errors.push(`No citation metadata for [${num}]`);
      continue;
    }

    const result = addFootnote(docxPath, { locator, text: citation.citation });
    if (result.success) {
      injected++;
    } else {
      failed++;
      errors.push(`Failed to add footnote for [${num}] at ${locator}: ${result.error}`);
    }
  }

  return { injected, failed, errors };
}
