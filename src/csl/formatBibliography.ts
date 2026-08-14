/**
 * formatBibliography — render a list of CslItems as a citation-style
 * formatted bibliography string.
 *
 * This is the v0.7.5 replacement for the old `formatVancouver()` regex
 * path. It uses Citestyle's `formatAll()` (one pass over the items) for
 * the simple case, and `createRegistry()` only when we need cross-
 * reference features (year-suffix disambiguation, citation-number
 * assignment for numeric styles).
 *
 * For our use case (bibliography rendering after a finalizeDoc run),
 * items are presented in citation order and don't need to be
 * renumbered across runs — so formatAll() is the right primitive.
 * createRegistry() would assign numbers twice if called repeatedly
 * on the same input.
 *
 * Source: @citestyle/registry (Uniweb, MIT).
 *   - formatAll(style, items, ctx) → FormattedEntry[]
 *   - Each entry: { text, html, parts, links }
 * We only use .text — that's what the user sees in
 * `## References` markdown. html/parts/links go to Word b:Source
 * (handled by word-live-builder.ts, not here).
 */

import { formatAll } from "@citestyle/registry";
import { bundled, resolveStyleId, type StyleId } from "./styles.ts";
import type { CslItem } from "./schema.ts";

export interface FormatBibliographyOptions {
  /** Citation style id (case-insensitive). Defaults to "ieee". */
  style?: string | StyleId;
  /**
   * Sort key for items before formatting. Most styles have their own
   * sort comparator (e.g. APA sorts by author/year), but for numeric
   * styles like IEEE and Vancouver, items keep the order they're
   * given in (citation order). Default: "input" (preserve order).
   */
  sort?: "input" | "alpha";
}

/**
 * Render a bibliography string from a list of CSL-JSON items.
 *
 * @param items CSL-JSON items (one per cited reference).
 * @param opts  Formatting options. See FormatBibliographyOptions.
 * @returns     Multi-line plain-text bibliography, one entry per line.
 *
 * Lines are joined with `\n`. The caller can wrap this in a markdown
 * section (`## References\n\n{output}`) or split it back into entries.
 */
export function formatBibliography(
  items: CslItem[],
  opts: FormatBibliographyOptions = {},
): string {
  const styleId = resolveStyleId(opts.style);
  const style = bundled[styleId];

  // Re-order items if the user asked for alphabetical sort. Numeric
  // styles (IEEE/Vancouver) want input order (= citation order).
  const sorted =
    opts.sort === "alpha"
      ? [...items].sort(alphaByAuthorThenYear)
      : items;

  const entries = formatAll(style, sorted as any);
  return entries.map((e) => e.text).join("\n");
}

/**
 * Same as formatBibliography but returns the structured entries
 * instead of joined text. Useful when callers want .html for
 * copy-as-rich-text or .parts for custom layouts.
 */
export function formatBibliographyEntries(
  items: CslItem[],
  opts: FormatBibliographyOptions = {},
): Array<{ text: string; html: string; id: string }> {
  const styleId = resolveStyleId(opts.style);
  const style = bundled[styleId];
  const sorted =
    opts.sort === "alpha"
      ? [...items].sort(alphaByAuthorThenYear)
      : items;

  const entries = formatAll(style, sorted as any);
  // Citestyle returns { text, html, parts, links }. We pair each
  // entry with its CslItem id (entries[i] corresponds to sorted[i]).
  return entries.map((e, i) => ({
    text: e.text,
    html: e.html,
    id: sorted[i]?.id ?? `ref-${i + 1}`,
  }));
}

function alphaByAuthorThenYear(a: CslItem, b: CslItem): number {
  const fa = firstAuthorFamily(a).toLowerCase();
  const fb = firstAuthorFamily(b).toLowerCase();
  if (fa !== fb) return fa < fb ? -1 : 1;
  const ya = a.issued?.["date-parts"]?.[0]?.[0] ?? 0;
  const yb = b.issued?.["date-parts"]?.[0]?.[0] ?? 0;
  return ya - yb;
}

function firstAuthorFamily(item: CslItem): string {
  const first = item.author?.[0];
  if (!first) return item.id ?? "";
  return first.literal ?? first.family ?? item.id ?? "";
}