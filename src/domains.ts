// src/domains.ts
// Domain discovery and loading. Pure data-driven — NO hardcoded domain list.
// Domains are YAML files in data/domains/. Adding a domain = creating one file.

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";

function parseYaml(text: string): unknown {
  return yaml.load(text);
}

// === Domain profile shape ===
// Every field is optional. A YAML with just `name: "X"` is valid.
export interface DomainProfile {
  // The filename (without .yaml) — used as the domain key.
  key: string;

  // === Display ===
  name?: string;
  journals?: string[];

  // === Species ===
  species?: {
    first_mention?: string;
    subsequent?: string[];
    avoid?: string;
  };

  // === Stocks / strains ===
  stocks?: {
    format?: string;
    rrid_prefix?: string;
    description?: string;
    common_strains?: string[];
    rules?: string[];
    rrid_source?: string;
  };

  // === Genotype ===
  genotype?: {
    format?: string;
    chromosome_order?: string;
    rules?: string[];
  };

  // === Balancers ===
  balancers?: {
    canonical?: string[];
    not_markers?: string[];
    rules?: string[];
    warning?: string;
  };

  // === Nomenclature ===
  nomenclature?: (string | { rule?: string; find?: string; replace?: string })[];

  // === Key citations that must be cited correctly ===
  key_citations?: Array<{
    term: string;
    must_cite?: string;
    doi?: string;
    not?: string;
  }>;

  // === Life stages ===
  life_stages?: string[];

  // === Term mappings (auto-correct these in text) ===
  term_mappings?: Array<{ source: string; target: string }>;

  // === Standard assays ===
  standard_assays?: string[];

  // === Sex canonical names ===
  sex?: string[];

  // === Auto-detect keywords ===
  detect_keywords?: string[];

  // === Reporting standards ===
  reporting?: {
    rrid_required?: boolean;
    rrid_types?: string[];
    key_resources_table?: boolean;
    arrive2?: boolean;
    arrive2_field?: string;
    arrive2_reference?: string;
    arrive2_essential_10?: string[];
    ethical_approval?: string;
    acknowledge_jax?: string;
    acknowledge_bdsc?: string;
    acknowledge_cgc?: string;
    acknowledge_wormbase?: string;
    miqe?: boolean;
    miqe_field?: string;
    miqe_required?: boolean;
    rigorous_statistics?: string;
  };

  // === Voice rules ===
  voice?: {
    introduction?: string;
    methods?: string;
    results?: string;
    discussion?: string;
  };

  // Allow unknown fields (forward-compatibility — new YAML fields just ignored).
  [key: string]: unknown;
}

// === Discover all domains by scanning data/domains/*.yaml ===
export function discoverDomains(root: string): DomainProfile[] {
  const dir = join(root, "data", "domains");
  if (!existsSync(dir)) return [];

  const files = readdirSync(dir).filter(f => f.endsWith(".yaml") || f.endsWith(".yml"));
  const domains: DomainProfile[] = [];

  for (const file of files) {
    const key = file.replace(/\.ya?ml$/, "");
    try {
      const content = readFileSync(join(dir, file), "utf-8");
      const parsed = (parseYaml(content) as Record<string, unknown>) ?? {};
      domains.push({ key, ...parsed });
    } catch (err) {
      // Skip malformed files but continue with others
      console.error(`[domains] Failed to parse ${file}:`, err);
    }
  }

  return domains;
}

// === Auto-detect domain from text ===
// Scores each domain's detect_keywords against the text. Highest score wins.
// If no keywords match, returns "general-biology".
export function detectDomain(text: string, domains: DomainProfile[]): string {
  if (!text || domains.length === 0) return "general-biology";

  let best = "general-biology";
  let bestScore = 0;

  for (const d of domains) {
    const keywords = d.detect_keywords ?? [];
    if (keywords.length === 0) continue;

    let score = 0;
    for (const kw of keywords) {
      try {
        const re = new RegExp(kw, "i");
        if (re.test(text)) score++;
      } catch {
        // Invalid regex — skip this keyword
      }
    }

    if (score > bestScore) {
      bestScore = score;
      best = d.key;
    }
  }

  return best;
}

// === Get a specific domain profile by key ===
export function getDomain(root: string, key: string): DomainProfile | null {
  const domains = discoverDomains(root);
  return domains.find(d => d.key === key) ?? null;
}