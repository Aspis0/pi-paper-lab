/**
 * CSL-JSON schema for pi-paper-lab.
 *
 * We use a structural subset of CSL-JSON that matches what Citestyle's
 * compiled styles consume (see @citestyle/styles/{ieee,vancouver,apa}).
 * Reference: https://docs.citationstyles.org/en/stable/specification.html#appendix-iv-variables
 *
 * Why a subset and not the full CSL-JSON spec? The crossref→CSL adapter
 * is the only thing that builds CslItem objects in this codebase, and we
 * only need the fields Word b:Source and Citestyle both consume:
 *   - id, type
 *   - title, author[].family/given
 *   - container-title, volume, issue, page
 *   - issued.date-parts[0][0] (year)
 *   - DOI, URL
 *
 * The full CSL-JSON type from @citation-js/plugin-common is compatible
 * with this subset; we only narrow to the fields we actually use.
 */

export interface CslName {
  /** Family name (last name). Required for most styles. */
  family?: string;
  /** Given name (first name). */
  given?: string;
  /** Literal name (for institutional authors like "World Health Organization"). */
  literal?: string;
  /** Dropping particle (e.g. "de" in Dutch "de Vries"). */
  "dropping-particle"?: string;
  /** Non-dropping particle (e.g. "von" in German "von Bach"). */
  "non-dropping-particle"?: string;
}

export interface CslDate {
  /** Array of date-part tuples: [year, month?, day?]. */
  "date-parts"?: Array<Array<number>>;
  /** ISO 8601 literal. */
  literal?: string;
}

export type CslType =
  | "article-journal"
  | "article"
  | "book"
  | "chapter"
  | "paper-conference"
  | "thesis"
  | "report"
  | "webpage"
  | (string & {}); // allow other types for forward-compat

export interface CslItem {
  /** Stable identifier. In v0.7.5 we use doiToId(doi) for journal articles. */
  id: string;
  /** CSL type, e.g. "article-journal". */
  type: CslType;
  /** Article title. */
  title?: string;
  /** Authors. */
  author?: CslName[];
  /** Editors (used when no authors). */
  editor?: CslName[];
  /** Journal/book title. */
  "container-title"?: string;
  /** Volume number. */
  volume?: string;
  /** Issue number. */
  issue?: string;
  /** Page range (e.g. "123-145" or "dmm049298"). */
  page?: string;
  /** Issue date. */
  issued?: CslDate;
  /** DOI (without the https://doi.org/ prefix). */
  DOI?: string;
  /** Canonical URL. */
  URL?: string;
  /** Abstract (plain text, possibly with JATS XML tags stripped). */
  abstract?: string;
  /** ISSN/ISBN. */
  ISBN?: string;
  ISSN?: string;
  /** Publisher. */
  publisher?: string;
  /** Provenance — who/what produced this CslItem. */
  source?: "crossref" | "openalex" | "europepmc" | "user" | "cached";
  /** v0.7.5 (M4): epoch ms when the item was added to the library.
   *  Optional; not part of upstream CSL-JSON but we persist it for
   *  provenance and library sync. */
  addedAt?: number;
  /** v0.7.5 (M4): how the item entered the library. */
  addedVia?: "user" | "add-from-search" | "auto-populate";
}

/**
 * Generate a stable CSL item ID from a DOI.
 *
 * Two-step normalization:
 *  1. Sanitize chars that aren't /, ., -, or ASCII alphanumeric → "_".
 *     This handles whitespace, diacritics, percent-encoded chars, etc.
 *     We keep "/", ".", and "-" intact so DOIs can be losslessly
 *     distinguished in the next step.
 *  2. Replace "/" with "__" so DOIs are visually distinct from
 *     path/version separators (CSL-JSON itself doesn't reserve this
 *     but our filesystem uses hash-prefix dirs like papers/<doi-id>/).
 *
 * Lowercase normalization (first step): DOIs are case-insensitive per
 * ISO 26324, so we lowercase first to ensure two DOIs differing only
 * in case map to the same library entry.
 *
 * NOT strictly idempotent for fully-normalized input — applying
 * doiToId to an already-normalized id (e.g. "10.1242__dmm.049298")
 * will collapse the `__` separator to a single `_`. Callers MUST
 * always pass raw DOIs; use `idToDoi` to invert.
 *
 * Examples:
 *   "10.1242/dmm.049298"             → "10.1242__dmm.049298"
 *   "10.1038/s41586-020-2649-2"      → "10.1038__s41586-020-2649-2"
 *   "10.1234/some.weird--doi"        → "10.1234__some.weird--doi"
 *   "10.1234/ABC"                    → "10.1234__abc"  (lowercased)
 */
export function doiToId(doi: string): string {
  if (!doi) return "";
  return doi
    .toLowerCase()
    .replace(/[^a-z0-9.\-/]+/g, "_")
    .replace(/\//g, "__");
}

/**
 * Inverse of doiToId. Recover the original DOI from a CSL id.
 *
 * Used for round-trip tests and for the rare case where we need
 * to talk back to CrossRef/OpenAlex (which expect real DOIs).
 */
export function idToDoi(id: string): string {
  if (!id) return "";
  return id.replace(/__/g, "/");
}