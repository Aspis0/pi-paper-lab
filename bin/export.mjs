#!/usr/bin/env node
// bin/export.mjs — paper-lab-export CLI
//
// v0.7.5 (M3): export a paper's CSL-JSON bibliography as BibTeX, RIS,
// or CSL-JSON. The hot path (finalizeDoc) does not import Citation.js;
// this CLI is the ONLY entry point that triggers the lazy load.
//
// Usage:
//   paper-lab-export paper.md --format bibtex
//   paper-lab-export paper.md --format ris
//   paper-lab-export paper.md --format csljson
//   paper-lab-export paper.md --format all  (all three, labelled sections)
//   paper-lab-export paper.md --style ieee (style for any embedded markdown bib)
//
// The .md file's sidecar (.citations.json) is read for the resolved
// DOIs. If no sidecar exists, the CLI exits with an error asking the
// user to run `paper-lab-finalize paper.md --verify-all` first.

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

// We use jiti to load the .ts source directly. pi-paper-lab's own CLI
// (`bin/finalize.mjs`) uses this same trick — the package is ESM with
// "type": "module" but ships TypeScript source; jiti handles the
// strip-types dance under pi's runtime.
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url, { interopDefault: true });

const { crossrefToCsl } = jiti("../src/csl/adapters/crossrefToCsl.ts");
const { exportBibtex } = jiti("../src/csl/exportBibtex.ts");
const { exportRis } = jiti("../src/csl/exportRis.ts");
const { formatBibliography } = jiti("../src/csl/formatBibliography.ts");

// ── Argument parsing ──────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = {
    input: null,
    format: "bibtex",
    style: "ieee",
    out: null,
    help: false,
  };
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === "--format" || a === "-f") {
      args.format = argv[++i];
    } else if (a === "--style" || a === "-s") {
      args.style = argv[++i];
    } else if (a === "--out" || a === "-o") {
      args.out = argv[++i];
    } else if (a === "--help" || a === "-h") {
      args.help = true;
    } else if (!args.input && !a.startsWith("-")) {
      args.input = a;
    } else {
      throw new Error(`Unknown argument: ${a}`);
    }
    i++;
  }
  return args;
}

function printHelp() {
  process.stdout.write(`paper-lab-export — export bibliography in BibTeX, RIS, or CSL-JSON.

Usage:
  paper-lab-export <file.md> [--format bibtex|ris|csljson|all] [--style ieee|vancouver|apa] [--out <file>]

Options:
  -f, --format  Output format. One of: bibtex, ris, csljson, all.
                Default: bibtex.
  -s, --style   Citation style used to render any embedded markdown
                bibliography. Default: ieee.
  -o, --out     Write to this file instead of stdout.
  -h, --help    Show this help.

Examples:
  paper-lab-export paper.md --format bibtex > refs.bib
  paper-lab-export paper.md --format ris > refs.ris
  paper-lab-export paper.md --format all > bundle.txt

Notes:
  Reads the .citations.json sidecar next to <file.md>. Run
  \`paper-lab-finalize <file.md> --verify-all\` first if the sidecar
  is missing.

  Citation.js (~170KB) is loaded lazily on first export. Hot path
  (paper-lab-finalize) stays lean.
`);
}

// ── Sidecar loader ────────────────────────────────────────────────────────

function sidecarPath(mdPath) {
  // paper-lab-finalize writes <mdPath>.citations.json. We append the
  // suffix to whatever path the user gave us.
  return mdPath + ".citations.json";
}

function loadSidecar(mdPath) {
  const sc = sidecarPath(mdPath);
  if (!existsSync(sc)) {
    const err = new Error(
      `No sidecar at ${sc}. Run \`paper-lab-finalize ${mdPath} --verify-all\` first.`,
    );
    err.exitCode = 3;
    throw err;
  }
  const raw = JSON.parse(readFileSync(sc, "utf8"));
  if (!raw || typeof raw !== "object" || !raw.citations) {
    const err = new Error(`Sidecar at ${sc} is malformed (missing 'citations' field).`);
    err.exitCode = 3;
    throw err;
  }
  return raw.citations;
}

// ── CSL-JSON emission ────────────────────────────────────────────────────

function emitCslJson(items) {
  return JSON.stringify(items, null, 2);
}

function emitAll(items, style) {
  // Human-readable bundle: each format in a labelled section.
  // Synchronous parts first; the async ones are awaited below.
  return [
    `=== BIBTEX ===`,
    "", // placeholder, filled by caller
    `=== RIS ===`,
    "", // placeholder
    `=== CSL-JSON ===`,
    emitCslJson(items),
    "",
    `=== ${style.toUpperCase()} (markdown bibliography) ===`,
    formatBibliography(items, { style }),
  ].join("\n");
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.input) {
    printHelp();
    process.exit(args.help ? 0 : 1);
  }

  // Validate format BEFORE any I/O so bad flags fail fast.
  const validFormats = new Set(["bibtex", "ris", "csljson", "all"]);
  if (!validFormats.has(args.format)) {
    process.stderr.write(`Unknown format: ${args.format}. Use bibtex, ris, csljson, or all.\n`);
    process.exit(1);
  }

  const mdPath = resolve(args.input);
  if (!existsSync(mdPath)) {
    process.stderr.write(`File not found: ${mdPath}\n`);
    process.exit(2);
  }

  // v0.7.5 note: the sidecar currently carries {doi, vancouver} but NOT
  // a CslItem. To export BibTeX/RIS we need CslItem. The easiest path:
  // re-fetch from CrossRef for each DOI. The sidecar's vancouver is
  // ignored for export; --verify-all ensures we have a csl field too.
  const sidecar = loadSidecar(mdPath);
  const dois = Object.values(sidecar)
    .map((e) => e?.doi)
    .filter((d) => typeof d === "string" && d.length > 0);

  if (dois.length === 0) {
    process.stderr.write(`Sidecar has no resolved DOIs. Re-run finalize with --verify-all.\n`);
    process.exit(3);
  }

  // Resolve DOIs in parallel. HIGH-1 fix: use Promise.allSettled so
  // one bad DOI doesn't kill the whole export. We collect successes
  // and warn on failures (printed to stderr at the end).
  const results = await Promise.allSettled(
    dois.map(async (doi) => {
      const url = `https://api.crossref.org/works/${encodeURIComponent(doi)}`;
      const res = await fetch(url, {
        headers: { "User-Agent": "pi-paper-lab/0.7 (mailto:paper-lab@example.com)" },
      });
      if (!res.ok) throw new Error(`CrossRef error for ${doi}: ${res.status}`);
      const data = await res.json();
      return crossrefToCsl(data.message, doi);
    }),
  );
  const items = [];
  for (const r of results) {
    if (r.status === "fulfilled") {
      items.push(r.value);
    } else {
      process.stderr.write(`paper-lab-export: ${r.reason?.message ?? r.reason}\n`);
    }
  }
  if (items.length === 0) {
    process.stderr.write(`paper-lab-export: all DOI lookups failed\n`);
    process.exitCode = 4;
    return;
  }

  // Emit the requested format(s). The `all` format is a labelled bundle.
  let output = "";
  if (args.format === "bibtex") {
    output = await exportBibtex(items);
  } else if (args.format === "ris") {
    output = await exportRis(items);
  } else if (args.format === "csljson") {
    output = emitCslJson(items);
  } else if (args.format === "all") {
    const bib = await exportBibtex(items);
    const ris = await exportRis(items);
    const csl = emitCslJson(items);
    const bibMd = formatBibliography(items, { style: args.style });
    output = [
      "=== BIBTEX ===",
      bib,
      "",
      "=== RIS ===",
      ris,
      "",
      "=== CSL-JSON ===",
      csl,
      "",
      `=== ${args.style.toUpperCase()} (markdown bibliography) ===`,
      bibMd,
    ].join("\n");
  }

  if (args.out) {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(resolve(args.out), output, "utf8");
    process.stderr.write(`Wrote ${output.length} bytes to ${args.out}\n`);
  } else {
    process.stdout.write(output);
    if (!output.endsWith("\n")) process.stdout.write("\n");
  }
}

main().catch((err) => {
  process.stderr.write(`paper-lab-export: ${err?.message ?? err}\n`);
  process.exit(err?.exitCode ?? 1);
});