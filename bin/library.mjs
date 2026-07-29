#!/usr/bin/env node
// bin/library.mjs — paper-lab-library CLI
//
// v0.7.5 (M4): manage the local reference library.
//
// Usage:
//   paper-lab-library add 10.1038/nature12373
//   paper-lab-library add-from-search "cachexia Drosophila"
//   paper-lab-library import refs.bib
//   paper-lab-library list [--domain X]
//   paper-lab-library search "cachexia IL6" [--offline-only]
//   paper-lab-library export --format bibtex
//   paper-lab-library sync
//   paper-lab-library stats
//
// The library lives at <projectRoot>/paper-lab-library/ and is
// gitignored. All operations are offline EXCEPT `add-from-search`
// (queries OpenAlex) and `add <doi>` (queries CrossRef if the DOI
// isn't already in the library).

import { existsSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true });
const { Library } = jiti("../src/library/index.ts");
const { doiToId } = jiti("../src/csl/schema.ts");
const { crossrefToCsl } = jiti("../src/csl/adapters/crossrefToCsl.ts");

// ── Argument parsing ──────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = {
    cmd: null,
    positional: [],
    flags: {},
  };
  // Pre-pass: if --help / -h is present as the first arg, treat it
  // as a special command so the help branch can produce exit code 0
  // instead of "Unknown command".
  if (argv[0] === "--help" || argv[0] === "-h") {
    args.cmd = "--help";
    return args;
  }
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        args.flags[key] = next;
        i += 2;
      } else {
        args.flags[key] = true;
        i++;
      }
    } else if (!args.cmd) {
      args.cmd = a;
      i++;
    } else {
      args.positional.push(a);
      i++;
    }
  }
  return args;
}

function printHelp() {
  process.stdout.write(`paper-lab-library — manage your local reference library.

Usage:
  paper-lab-library <command> [args]

Commands:
  add <doi>              Add a paper by DOI (queries CrossRef).
  add-from-search <q>    Search OpenAlex/EPMC and pick top result.
  import <file>          Import from .bib|.ris|.csl.json file.
  list                   List all papers in the library.
  search <query>         BM25 search the library.
  export --format FMT    Export to bibtex|ris|csljson.
  sync                   Rebuild the SQLite cache.
  stats                  Show library size.

Examples:
  paper-lab-library add 10.1038/nature12373
  paper-lab-library search "cachexia IL6"
  paper-lab-library list
  paper-lab-library sync

Library root: <projectRoot>/paper-lab-library/ (gitignored).
`);
}

// ── Command implementations ───────────────────────────────────────────────

async function cmdAdd(lib, doi) {
  const normalised = doi.replace(/^https?:\/\/doi\.org\//i, "").trim();
  if (!normalised) {
    process.stderr.write(`Invalid DOI: ${doi}\n`);
    process.exitCode = 1;
    return null;
  }

  // Already in library? Return the existing entry.
  const existing = lib.lookupByDoi(normalised);
  if (existing) {
    process.stdout.write(`Already in library: ${existing.id} (${existing.title})\n`);
    return existing;
  }

  // Fetch from CrossRef.
  const url = `https://api.crossref.org/works/${encodeURIComponent(normalised)}`;
  const res = await fetch(url, {
    headers: { "User-Agent": "pi-paper-lab/0.7 (mailto:paper-lab@example.com)" },
  });
  if (!res.ok) {
    process.stderr.write(`CrossRef error ${res.status} for DOI ${normalised}\n`);
    process.exitCode = 2;
    return null;
  }
  const data = await res.json();
  const csl = crossrefToCsl(data.message, normalised);
  lib.add(csl);
  process.stdout.write(`Added ${csl.id}: ${csl.title}\n`);
  return csl;
}

async function cmdAddFromSearch(lib, query) {
  // v0.7.5 minimal implementation: query OpenAlex directly (we don't
  // import Citation.js's plugin-doi here to keep this CLI lean).
  // We pick the FIRST result if there's a clear winner; otherwise we
  // print candidates and let the user run \`add <doi>\` for the right
  // one. Plan §13.6 mentions "user approves/rejects each interactively"
  // — for v0.7.5 we ship the no-questions version (pick first).
  const url = `https://api.openalex.org/works?search=${encodeURIComponent(query)}&per_page=1`;
  const res = await fetch(url, {
    headers: { "User-Agent": "pi-paper-lab/0.7 (mailto:paper-lab@example.com)" },
  });
  if (!res.ok) {
    process.stderr.write(`OpenAlex error ${res.status}\n`);
    process.exitCode = 2;
    return null;
  }
  const data = await res.json();
  const top = data.results?.[0];
  if (!top || !top.doi) {
    process.stderr.write(`No OpenAlex results for: ${query}\n`);
    process.exitCode = 3;
    return null;
  }
  // HIGH-3 fix: try CrossRef first (canonical metadata), and if that
  // fails, fall back to OpenAlex's reconstructed CSL. The OpenAlex
  // response has title, authorships[], publication_date, primary_location
  // etc. — we map the relevant fields into our CslItem shape.
  const crResult = await cmdAdd(lib, top.doi);
  if (crResult) return crResult;
  // CrossRef failed. Build a CslItem from OpenAlex's response.
  process.stderr.write(`CrossRef failed for ${top.doi}, falling back to OpenAlex metadata.\n`);
  const authorships = top.authorships ?? [];
  const authors = authorships.map((a) => {
    const name = a.author?.display_name ?? "?";
    // OpenAlex returns a single string like "Ying Liu". We split on
    // the LAST space and treat the second half as the family name.
    // This is imperfect but better than dropping the author entirely.
    const lastSpace = name.lastIndexOf(" ");
    if (lastSpace < 0) return { family: name };
    return { family: name.slice(lastSpace + 1), given: name.slice(0, lastSpace) };
  });
  const year = top.publication_year ?? null;
  const cslFallback = {
    id: top.doi ? top.doi.replace(/\//g, "__").replace(/[^a-z0-9.\-]+/gi, "_") : `openalex-${top.id ?? "unknown"}`,
    type: "article-journal",
    title: top.title ?? "(untitled)",
    author: authors,
    "container-title": top.primary_location?.source?.display_name ?? "",
    issued: year ? { "date-parts": [[year]] } : undefined,
    DOI: top.doi ?? undefined,
    URL: top.doi ? `https://doi.org/${top.doi}` : (top.id ? `https://openalex.org/${top.id}` : undefined),
    source: "openalex",
  };
  lib.add(cslFallback);
  process.stdout.write(`Added (OpenAlex fallback) ${cslFallback.id}: ${cslFallback.title}\n`);
  return cslFallback;
}

async function cmdImport(lib, filePath) {
  if (!existsSync(filePath)) {
    process.stderr.write(`File not found: ${filePath}\n`);
    process.exitCode = 2;
    return;
  }
  const raw = readFileSync(filePath, "utf8");
  // Detect format by extension.
  const ext = filePath.toLowerCase().split(".").pop();
  if (ext === "json") {
    // CSL-JSON array.
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      process.stderr.write(`JSON parse error: ${err.message}\n`);
      process.exitCode = 4;
      return;
    }
    if (!Array.isArray(parsed)) {
      process.stderr.write(`Expected a JSON array of CSL items.\n`);
      process.exitCode = 4;
      return;
    }
    let count = 0;
    for (const item of parsed) {
      if (item && typeof item === "object" && item.id) {
        lib.add(item);
        count++;
      }
    }
    process.stdout.write(`Imported ${count} CSL-JSON entries.\n`);
    return;
  }
  if (ext === "bib") {
    // Lazy BibTeX import via Citation.js. Same lazy pattern as the
    // export CLI: only loaded when actually called.
    const { Cite } = await import("@citation-js/core");
    await import("@citation-js/plugin-bibtex");
    const cite = new Cite(raw);
    // CRIT-5 fix: Citation.js stores DOI as an array `["10.xxx/yyy"]`,
    // not a string. Calling `doiToId(arr)` would crash because
    // arrays don't have `.toLowerCase()`. We normalize to first DOI
    // (or empty string if no DOI). The same logic applies to RIS.
    const items = (cite.data ?? []).map((it) => {
      const doi = Array.isArray(it.DOI) ? it.DOI[0] : (it.DOI ?? "");
      return {
        ...it,
        DOI: doi,
        id: it.id ?? doiToId(doi),
      };
    });
    for (const item of items) lib.add(item);
    process.stdout.write(`Imported ${items.length} BibTeX entries.\n`);
    return;
  }
  if (ext === "ris") {
    const { Cite } = await import("@citation-js/core");
    await import("@citation-js/plugin-ris");
    const cite = new Cite(raw);
    const items = (cite.data ?? []).map((it) => {
      const doi = Array.isArray(it.DOI) ? it.DOI[0] : (it.DOI ?? "");
      return {
        ...it,
        DOI: doi,
        id: it.id ?? doiToId(doi),
      };
    });
    for (const item of items) lib.add(item);
    process.stdout.write(`Imported ${items.length} RIS entries.\n`);
    return;
  }
  process.stderr.write(`Unsupported file extension: .${ext}. Use .bib, .ris, or .json.\n`);
  process.exitCode = 5;
  return;
}

function cmdList(lib, flags) {
  const papers = lib.list();
  const domain = flags.domain;
  // CRIT-4 fix: the old filter (JSON.stringify(authors).includes(domain))
  // was parody code — it matched against the author array's JSON, not
  // the domain. Now we match against title + container-title + abstract
  // (lowercased) which is at least semantically correct: the user is
  // searching for a topic keyword, not a name. Domain-specific papers
  // (e.g. Drosophila) will mention the species in title/abstract.
  const filtered = domain
    ? papers.filter((p) => {
        const haystack = [
          p.title ?? "",
          p["container-title"] ?? "",
          p.abstract ?? "",
        ]
          .join(" ")
          .toLowerCase();
        return haystack.includes(domain.toLowerCase());
      })
    : papers;
  for (const p of filtered) {
    const year = p.issued?.["date-parts"]?.[0]?.[0] ?? "?";
    const firstAuthor = p.author?.[0]?.family ?? "?";
    process.stdout.write(`${p.id}  ${firstAuthor} (${year})  ${p.title ?? "(untitled)"}\n`);
  }
  process.stdout.write(`\nTotal: ${filtered.length} entries\n`);
}

function cmdSearch(lib, query, flags) {
  const topN = Number(flags.n ?? flags.top ?? 10);
  const hits = lib.search(query, topN);
  if (hits.length === 0) {
    process.stdout.write(`No matches for: ${query}\n`);
    return;
  }
  for (const hit of hits) {
    const paper = lib.get(hit.id);
    if (!paper) continue;
    const year = paper.issued?.["date-parts"]?.[0]?.[0] ?? "?";
    process.stdout.write(`${hit.score.toFixed(2)}  ${hit.id}  ${year}  ${paper.title ?? "(untitled)"}\n`);
  }
}

async function cmdExport(lib, flags) {
  const fmt = flags.format ?? "bibtex";
  const papers = lib.list();
  if (papers.length === 0) {
    process.stderr.write(`Library is empty.\n`);
    process.exitCode = 3;
    return;
  }
  let output = "";
  if (fmt === "bibtex") {
    const { Cite } = await import("@citation-js/core");
    await import("@citation-js/plugin-bibtex");
    output = new Cite(papers).format("bibtex");
  } else if (fmt === "ris") {
    const { Cite } = await import("@citation-js/core");
    await import("@citation-js/plugin-ris");
    output = new Cite(papers).format("ris");
  } else if (fmt === "csljson") {
    output = JSON.stringify(papers, null, 2);
  } else {
    process.stderr.write(`Unknown format: ${fmt}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(output);
  if (!output.endsWith("\n")) process.stdout.write("\n");
}

async function cmdSync(lib) {
  const n = await lib.sync();
  process.stdout.write(`Synced ${n} entries to SQLite cache.\n`);
}

function cmdStats(lib) {
  const s = lib.stats();
  process.stdout.write(`Library: ${s.count} entries, ${s.totalAbstractBytes} bytes of abstracts\n`);
  process.stdout.write(`Path: ${lib.path}\n`);
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));

  // Handle help / no-command BEFORE initialising the library — we
  // don't want to create the directory tree just to print help text.
  if (!args.cmd || args.cmd === "--help" || args.cmd === "-h" || args.flags.help) {
    printHelp();
    // Use exitCode (deferred exit) — `process.exit()` here would race
    // with pending async work and Node would silently override the
    // exit code to 1 on unhandled rejections.
    process.exitCode = args.cmd ? 0 : 1;
    return;
  }

  // Library root is always relative to the current working directory.
  // The user can override with --project-root <path>.
  const projectRoot = resolve(args.flags["project-root"] ?? process.cwd());
  const lib = new Library(projectRoot);
  await lib.init();

  switch (args.cmd) {
    case "add":
      if (args.positional.length === 0) {
        process.stderr.write(`Usage: paper-lab-library add <doi>\n`);
        process.exitCode = 1;
      }
      await cmdAdd(lib, args.positional[0]);
      break;
    case "add-from-search":
      if (args.positional.length === 0) {
        process.stderr.write(`Usage: paper-lab-library add-from-search "<query>"\n`);
        process.exitCode = 1;
      }
      await cmdAddFromSearch(lib, args.positional[0]);
      break;
    case "import":
      if (args.positional.length === 0) {
        process.stderr.write(`Usage: paper-lab-library import <file>\n`);
        process.exitCode = 1;
      }
      await cmdImport(lib, resolve(args.positional[0]));
      break;
    case "list":
      cmdList(lib, args.flags);
      break;
    case "search":
      if (args.positional.length === 0) {
        process.stderr.write(`Usage: paper-lab-library search "<query>"\n`);
        process.exitCode = 1;
      }
      cmdSearch(lib, args.positional[0], args.flags);
      break;
    case "export":
      await cmdExport(lib, args.flags);
      break;
    case "sync":
      await cmdSync(lib);
      break;
    case "stats":
      cmdStats(lib);
      break;
    default:
      process.stderr.write(`Unknown command: ${args.cmd}\n`);
      printHelp();
      process.exitCode = 1;
  }
}

main().catch((err) => {
  process.stderr.write(`paper-lab-library: ${err?.message ?? err}\n`);
  process.exitCode = err?.exitCode ?? 1;
});

process.on("unhandledRejection", (reason) => {
  process.stderr.write(`paper-lab-library: unhandled rejection: ${reason?.message ?? reason}\n`);
  process.exitCode = 1;
});