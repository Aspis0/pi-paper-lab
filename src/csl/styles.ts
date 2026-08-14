/**
 * CSL style registry — load the bundled citation styles from
 * @citestyle/styles as ES modules and expose them through a single
 * import map keyed by lowercase style id.
 *
 * v0.7.5 ships three styles:
 *   - "ieee"      (numeric, IEEE)
 *   - "vancouver" (numeric, Vancouver / ICMJE)
 *   - "apa"       (author-date, APA 7th edition)
 *
 * Source code is from @citestyle/styles (Uniweb, MIT, see
 * https://github.com/uniweb/csl/tree/main/packages/styles). Each style
 * module is a pre-compiled CSL — the actual CSL XML from the upstream
 * repository is compiled at build time by Uniweb's compiler into ~3-5KB
 * JavaScript modules. We do NOT compile from CSL XML at runtime.
 *
 * To add a new style, install the pre-compiled module from the same
 * package family (Uniweb ships nine styles; for anything else use
 * @citestyle/compiler). Add it to `bundled` below and to `StyleId`.
 */

import type { CompiledStyle } from "@citestyle/types";

import * as ieee from "@citestyle/styles/ieee";
import * as vancouver from "@citestyle/styles/vancouver";
import * as apa from "@citestyle/styles/apa";

/** Style ids recognised by --style flag. Lowercase. */
export type StyleId = "ieee" | "vancouver" | "apa";

/** Default style when none specified. Was "ieee" in v0.7.0. */
export const DEFAULT_STYLE: StyleId = "ieee";

/** All bundled styles. Used by formatBibliography() to look up by id. */
export const bundled: Record<StyleId, CompiledStyle> = {
  ieee,
  vancouver,
  apa,
};

/**
 * Resolve a style id (case-insensitive, falls back to default).
 *
 * Accepts user input like "IEEE", "vancouver", "APA-7" and normalises
 * to one of our known ids. Unknown ids throw — we don't silently fall
 * back to the default, because the user picked that id for a reason.
 */
export function resolveStyleId(raw: string | undefined | null): StyleId {
  if (!raw) return DEFAULT_STYLE;
  const norm = raw.trim().toLowerCase();
  if (norm === "ieee") return "ieee";
  if (norm === "vancouver" || norm === "icmje") return "vancouver";
  if (norm === "apa") return "apa";
  throw new Error(
    `Unknown citation style: "${raw}". Known styles: ieee, vancouver, apa.`
  );
}

/** List of all style ids (for CLI help text and tests). */
export const KNOWN_STYLES: StyleId[] = ["ieee", "vancouver", "apa"];