// bin/seed-sidecar.mjs
// One-shot: read paper.md with footer reference list (numbered "N. Author. Title. Journal. Year." entries
// possibly with "doi:10.x" inline), extract (N, fullReferenceText, doi?) per entry,
// write <md>.citations.json sidecar so finalizeDoc has Vancouver body to use.
//
// finalizeDoc requires `vancouver` (non-empty string) to populate the bibliography.
// CrossRef resolution is optional — if the cached Vancouver is good enough for the
// user's draft, no CrossRef call is needed.
//
// Usage:
//   node bin/seed-sidecar.mjs <path-to.md> [--force]
//
// `--force` overwrites an existing <md>.citations.json without warning.
// Without it, the script prints a warning and refuses to overwrite.
//
// Robustness notes (post-audit, v0.6.5):
//   - DOI extraction accepts parens (10.1016/s1470-2045(10)70218-7) and strips
//     a single trailing punctuation artifact that came from markdown link syntax.
//   - Duplicate [N] detected and reported; LAST occurrence wins.
//   - Existing sidecars are not silently overwritten (require --force).
//   - Heading regex matches whether or not the file ends with `\n`.
//   - Non-`.md` files are rejected upfront with a clear message.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

// Heading regex: heading level 1-3, allow "References" / "Bibliography" /
// "References and Notes", optional trailing colon, then EITHER newline or
// end-of-string (so files saved without trailing newline still match).
const refHeaderRe = /(?:^|\n)(#{1,3})\s*(References|Bibliography|References\s+and\s+Notes):?\s*(?:\n|$)/i;

// Entry regex: numbered "<N>. <body>" up to the next numbered entry or EOL/EOF.
// The lookahead lets the LAST entry terminate without a successor.
const entryRe = /(?:^|\n)\s*(\d+)\.\s+([\s\S]*?)(?=\n\s*\d+\.\s|\s*$)/g;

// DOI extraction. Real-world DOIs frequently contain parentheses, especially
// older Lancet/Cell style: 10.1016/s1470-2045(10)70218-7.
// Strategy: capture up to whitespace, then strip ONE trailing punctuation
// character that came from markdown link syntax (e.g. "doi:10.x).").
function extractDoi(body) {
  // Step 1: capture greedy until whitespace/newline. The doi string may
  // contain parens (Lancet/Cell) and the user's text often wraps it in
  // markdown link syntax: [doi:10.x](doi:10.x).
  const m = body.match(/(?:^|[\s\[]|[(])doi:\s*(10\.[^\s\n]*)/i);
  if (!m) return null;
  let doi = m[1];
  // Step 2: if the captured string ends with `](doi:...` form (markdown link),
  // the first `]` is the closing bracket of the link text, NOT part of the
  // DOI. Identify that case: when the DOI contains `](doi:`, the actual DOI
  // ends just BEFORE the `]`.
  const linkCloneIdx = doi.indexOf("](doi:");
  if (linkCloneIdx >= 0) {
    doi = doi.slice(0, linkCloneIdx);
  } else {
    // Step 3: strip at most one trailing artifact character. Real DOIs do
    // not end in punctuation; references often render as `doi:10.x).` or
    // `doi:10.x]` so capture swiped these characters.
    const last = doi[doi.length - 1];
    if (last === ")" || last === "]" || last === ";" || last === "," || last === ".") {
      doi = doi.slice(0, -1);
    }
  }
  return doi || null;
}

const target = process.argv[2];
const force = process.argv.includes("--force");

if (!target || target === "-h" || target === "--help") {
  console.error("Usage: seed-sidecar.mjs <path-to.md> [--force]");
  console.error("  --force  Overwrite an existing .citations.json without prompting.");
  process.exit(2);
}
const abs = join(process.cwd(), target);
if (!existsSync(abs)) {
  console.error(`[seed-sidecar] File not found: ${abs}`);
  process.exit(2);
}

// Reject non-.md input upfront so .docx / .markdown errors are obvious
// rather than confusing the regex with binary / extension-less text.
if (!/\.md$/i.test(abs)) {
  console.error(`[seed-sidecar] ${target} does not have a .md extension. seed-sidecar parses Markdown only.`);
  process.exit(2);
}

const text = readFileSync(abs, "utf8");

const refHeader = text.match(refHeaderRe);
if (!refHeader) {
  console.error("[seed-sidecar] No '## References' / '## Bibliography' section in the .md.");
  console.error("                Make sure the references are under a heading like:");
  console.error('                  "## References"');
  process.exit(2);
}
const refStart = refHeader.index + refHeader[0].length;
const tail = text.slice(refStart);

const entries = [];
let m;
while ((m = entryRe.exec(tail)) !== null) {
  const num = parseInt(m[1]);
  let body = m[2].trim();
  if (num < 1 || num >= 1000 || !body) continue;
  const doi = extractDoi(body);
  entries.push({ num, body, doi });
}

if (entries.length === 0) {
  console.error("[seed-sidecar] No numbered entries found inside the references section.");
  console.error("                Each entry must start with '<N>. ' on its own line.");
  process.exit(2);
}
console.log(`[seed-sidecar] Parsed ${entries.length} numbered entries from references section.`);

// Duplicate detection (HIGH-1): warn if the same [N] appears more than once.
const seen = new Set();
const dupes = [];
for (const e of entries) {
  if (seen.has(e.num)) dupes.push(e.num);
  seen.add(e.num);
}
if (dupes.length > 0) {
  const unique = [...new Set(dupes)];
  console.error(`[seed-sidecar] WARNING: duplicate entry numbers detected: [${unique.join("], [")}]`);
  console.error("               Only the LAST occurrence will be saved. Fix the duplicates and re-run.");
}

const cachePath = abs.replace(/\.md$/i, ".citations.json");

// HIGH-2: refuse to overwrite an existing sidecar without --force.
// Doing so silently destroys CrossRef-resolved data from a previous
// paper-lab-finalize run.
if (existsSync(cachePath) && !force) {
  console.error(`[seed-sidecar] ERROR: ${cachePath} already exists.`);
  console.error("                Refusing to overwrite — pass --force to override.");
  console.error("                (CrossRef-resolved entries from a previous finalizeDoc run would be lost.)");
  process.exit(2);
}

const sidecar = {
  schemaVersion: 1,
  sourceMarkdown: abs,
  lastResolvedAt: new Date().toISOString(),
  citationBackend: "user-supplied (seed-sidecar)",
  citations: {},
};
for (const { num, body, doi } of entries) {
  const vancouver = body.endsWith(".") ? body : body + ".";
  sidecar.citations[String(num)] = { doi, vancouver };
}
writeFileSync(cachePath, JSON.stringify(sidecar, null, 2) + "\n", "utf8");
console.log(`[seed-sidecar] Wrote ${cachePath}`);
console.log(`[seed-sidecar] Sample entry [${entries[0].num}]: ${entries[0].body.slice(0, 80)}...`);
const parensFixed = entries.filter(e => e.doi && e.doi.includes("(")).length;
if (parensFixed > 0) {
  console.log(`[seed-sidecar] Captured ${parensFixed} DOI(s) containing parentheses (Lancet/Cell-style).`);
}

console.log("");
console.log(`[seed-sidecar] Next: 'paper-lab-finalize ${abs}' to build the .docx with bibliography.`);
console.log(`              CrossRef will refresh each entry automatically (DOI-change detection + verification).`);
