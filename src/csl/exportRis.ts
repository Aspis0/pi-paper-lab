/**
 * Lazy RIS exporter — wraps Citation.js's RIS plugin and only loads it
 * when actually called. Hot-path isolation: see tests/csl/lazyLoad.test.ts.
 *
 * Source: @citation-js/plugin-ris
 *   (Citation.js, MIT, https://github.com/citation-js/citation-js)
 *
 * RIS format is widely supported by reference managers
 * (EndNote, Zotero, Mendeley, RefMan). The output is one block per
 * citation, terminated by `ER  - `.
 */

import type { CslItem } from "./schema.ts";

/**
 * Convert CSL-JSON items to an RIS string.
 *
 * @param items CSL-JSON items.
 * @returns     RIS entries. Each entry is a block of `XX  - value\n`
 *              lines, ending with `ER  -`. Blocks are separated by
 *              blank lines for readability.
 */
export async function exportRis(items: CslItem[]): Promise<string> {
  // Lazy: Citation.js core + RIS plugin stay off the hot path.
  const { Cite } = await import("@citation-js/core");
  await import("@citation-js/plugin-ris");

  const cite = new Cite(items as any);
  return cite.format("ris") as string;
}