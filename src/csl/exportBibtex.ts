/**
 * Lazy BibTeX exporter — wraps Citation.js's BibTeX plugin and only
 * loads it when actually called. The hot path (finalizeDoc) must
 * NEVER trigger this module's static imports; see tests/csl/lazyLoad.test.ts.
 *
 * Source: @citation-js/core + @citation-js/plugin-bibtex
 *   (Citation.js, MIT, https://github.com/citation-js/citation-js)
 *
 * The Cite constructor accepts CSL-JSON arrays directly:
 *   new Cite([{ id, type, title, author, issued, ... }])
 * .format('bibtex') returns the standard BibTeX entry block.
 */

import type { CslItem } from "./schema.ts";

/**
 * Convert CSL-JSON items to a BibTeX string.
 *
 * @param items CSL-JSON items.
 * @returns     BibTeX entries, one per `\n\n`-separated block.
 *              No outer `@string{...}` preamble is added — the
 *              output is a flat sequence of `@article{...}` blocks
 *              suitable for direct inclusion in a .bib file.
 */
export async function exportBibtex(items: CslItem[]): Promise<string> {
  // Lazy: Citation.js core stays off the hot path.
  const { Cite } = await import("@citation-js/core");
  // Side-effect: registers the BibTeX output plugin on first import.
  await import("@citation-js/plugin-bibtex");

  // Cite() deep-copies the input, so caller mutations to `items` after
  // this point are safe.
  const cite = new Cite(items as any);
  return cite.format("bibtex") as string;
}