/**
 * Adapter: CrossRefWork → CslItem
 *
 * CrossRef's wire format uses camelCase + flat arrays; CSL-JSON uses
 * kebab-case + nested author objects. This adapter is the only place
 * that bridges the two. Adding more adapters (OpenAlex, Europe PMC)
 * means writing more adapters to the SAME CslItem shape — never
 * let CrossRefWork cross module boundaries outside this adapter.
 *
 * Field mapping reference:
 *
 *   CrossRefWork              → CslItem
 *   ─────────────────────────────────────────────────────
 *   doi                       → id (via doiToId), DOI
 *   title[0]                  → title
 *   author[].given/family     → author[].given/family
 *   author[].name             → author[].literal  (institutional)
 *   published/publishedPrint/
 *     publishedOnline         → issued["date-parts"][0]  (first year wins)
 *   containerTitle[0]         → "container-title"
 *   volume                    → volume
 *   issue                     → issue
 *   page                      → page  (with `--` → en-dash)
 *   abstract                  → abstract
 *
 * CrossRefWork `published.dateParts` is a flat array of numbers
 * (e.g. `[2024, 4, 30]`); CSL-JSON `issued["date-parts"]` is
 * an ARRAY OF TUPLES (e.g. `[[2024, 4, 30]]`) because one entry
 * can carry multiple dates. We always use a single tuple.
 */

import type { CrossRefWork } from "../../crossref.ts";
import { doiToId, type CslItem } from "../schema.ts";

/**
 * Convert a CrossRefWork into a CslItem suitable for Citestyle.
 *
 * @param work The normalized CrossRef API response.
 * @param doi  The DOI string used to fetch the work. Required because
 *             CrossRef sometimes returns the DOI in mixed case or
 *             uppercase, and we want a stable lowercase id.
 */
export function crossrefToCsl(work: CrossRefWork, doi: string): CslItem {
  return {
    id: doiToId(doi),
    type: mapCrossRefType(work.type),
    title: work.title?.[0] ?? "(untitled)",
    author: (work.author ?? []).map(crossrefAuthorToCsl),
    issued: pickIssued(work),
    "container-title": work.containerTitle?.[0],
    volume: work.volume,
    issue: work.issue,
    // CrossRef uses `--` for page ranges (e.g. "123--145"); CSL prefers
    // the en-dash `–`. Normalize so bibliographies look typographically
    // correct, regardless of how the publisher encoded the range.
    page: work.page?.replace(/--/g, "\u2013"),
    DOI: doi,
    URL: work.url ?? `https://doi.org/${doi}`,
    abstract: stripJats(work.abstract),
    publisher: work.publisher,
    ISSN: work.issn?.[0],
    source: "crossref",
  };
}

// ── helpers ────────────────────────────────────────────────────────────────

function crossrefAuthorToCsl(a: {
  family?: string;
  given?: string;
  name?: string;
}): { family?: string; given?: string; literal?: string } {
  // Institutional / corporate authors (no family/given) come through
  // as `name` only — we map to CSL's `literal` field which Citestyle
  // renders without trying to split into first/last.
  if (!a.family && !a.given && a.name) {
    return { literal: a.name };
  }
  return {
    family: a.family ?? a.name ?? "?",
    given: a.given,
  };
}

function pickIssued(work: CrossRefWork): CslItem["issued"] {
  // CrossRef has three date slots; we prefer published > published-print >
  // published-online in that order. Each is `{ dateParts: [year] }`.
  const year =
    work.published?.dateParts?.[0] ??
    work.publishedPrint?.dateParts?.[0] ??
    work.publishedOnline?.dateParts?.[0];
  if (year == null) return undefined;
  return { "date-parts": [[year]] };
}

function mapCrossRefType(t: string | undefined): CslItem["type"] {
  // CrossRef types map roughly to CSL types. The most common case is
  // "journal-article" → "article-journal". Anything unknown falls back
  // to "article" which most styles can render as a generic citation.
  switch (t) {
    case "journal-article":
      return "article-journal";
    case "book":
      return "book";
    case "book-chapter":
      return "chapter";
    case "proceedings-article":
      return "paper-conference";
    case "dissertation":
      return "thesis";
    case "report":
      return "report";
    case "posted-content":
    case "preprint":
      return "article"; // CSL doesn't distinguish preprints cleanly
    default:
      return "article";
  }
}

/**
 * Strip JATS XML tags from a CrossRef abstract.
 *
 * CrossRef returns abstracts as JATS XML fragments (e.g.
 * `<jats:p>Background.</jats:p>`). CSL-JSON's `abstract` field is
 * supposed to be plain text — passing JATS through makes Citestyle
 * and downstream consumers emit raw `<jats:p>` to users.
 *
 * The implementation is intentionally a single regex, not a full XML
 * parser: JATS-in-abstract is well-formed in practice and we don't need
 * to handle nested tags. If a tag has attributes we keep the inner
 * text only.
 */
function stripJats(jats: string | undefined): string | undefined {
  if (!jats) return undefined;
  // Drop any <...> tag, keep inner text. Repeatedly apply to handle
  // nested tags like <jats:p>foo <jats:bold>bar</jats:bold> baz</jats:p>.
  let out = jats;
  let prev: string;
  do {
    prev = out;
    out = out.replace(/<[^>]+>/g, "");
  } while (out !== prev);
  // Decode the four entities CrossRef uses most often. Other entities
  // are uncommon in abstracts; if needed we can extend this list.
  return out
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x[a-f0-9]+;/gi, "")
    .trim();
}