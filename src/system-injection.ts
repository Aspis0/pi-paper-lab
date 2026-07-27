// src/system-injection.ts
// Builds the system prompt injection for the active domain.
// Domain-agnostic: only emits rules defined in the domain YAML.
// If the domain has no species, no species rules are emitted.
// If the domain has no balancers, no balancer rules are emitted.

import type { Lexicon } from "./anti-ai-lexicon.ts";
import type { DomainProfile } from "./domains.ts";

export function buildSystemInjection(lex: Lexicon, domain: DomainProfile | null): string {
  const parts: string[] = [];

  // === 1. Common rules (always included) ===
  parts.push(buildCommonRules(lex));

  // === 2. Domain-specific rules (only if YAML has the data) ===
  if (domain) {
    if (domain.species) parts.push(buildSpeciesSection(domain.species, domain.key));
    if (domain.stocks) parts.push(buildStocksSection(domain.stocks, domain.key));
    if (domain.genotype) parts.push(buildGenotypeSection(domain.genotype));
    if (domain.balancers) parts.push(buildBalancersSection(domain.balancers));
    if (domain.nomenclature?.length) parts.push(buildNomenclatureSection(domain.nomenclature));
    if (domain.key_citations?.length) parts.push(buildKeyCitationsSection(domain.key_citations));
    if (domain.life_stages?.length) parts.push(buildLifeStagesSection(domain.life_stages));
    if (domain.sex?.length) parts.push(buildSexSection(domain.sex));
    if (domain.term_mappings?.length) parts.push(buildTermMappingsSection(domain.term_mappings));
    if (domain.reporting) parts.push(buildReportingSection(domain.reporting, domain.key));
    if (domain.standard_assays?.length) parts.push(buildAssaysSection(domain.standard_assays));
  }

  const label = domain?.name ?? domain?.key ?? "general";
  return `[pi-paper-lab ACTIVE — field=${label}]\n\n${parts.join("\n\n")}`;
}

// === Common rules — AI-tells, hedging, voice, numbers, figures, citations ===
function buildCommonRules(lex: Lexicon): string {
  // Build a concise voice/rules block from the common lexicon.
  return `You are writing scientific text. Follow these rules:

== Anti-AI prose ==
Avoid these AI-tell phrases: ${lex.avoidedVerbs.slice(0, 10).map(v => `"${v}"`).join(", ")}, and others.
Avoid these AI-tell nouns: ${lex.avoidedNouns.slice(0, 5).map(n => `"${n}"`).join(", ")}, and others.
Delete filler adverbs: ${lex.fillerAdverbs.slice(0, 8).map(a => `"${a}"`).join(", ")}.
Remove opener phrases: "It is important to note", "Of note", "Fascinatingly", "Notably", "In conclusion", "We believe".

== Voice ==
Introduction: HIGH assertiveness. State the gap; state the question. Preferred: "Here, we ...".
Methods: HIGHEST assertiveness. No hedging. Use "We crossed..." or "Flies were raised on...".
Results: HIGH assertiveness. State findings directly with n, p, effect size, 95% CI.
Discussion: Moderate hedging. Speculation only in final paragraph with hedged language.

== Numbers ==
- Every result claim must include n per group, replicates, statistical test, statistic, p-value, effect size, 95% CI.
- p-values as "p<0.001" (no leading zero before decimal). Use "ns" for non-significant.
- Effect size REQUIRED alongside p (Cohen's d, R², η²).
- Multiple-testing correction when >5 comparisons per figure.

== Figures ==
Reference as "Figure 1A shows..." (active verb first) or "(Figure 1A,B)". Never begin "As can be seen in Figure 1...".

== Citations ==
Inline: (Author, Year) or Author et al. (Year). NEVER invent DOIs, PMIDs, or stock numbers.
If a claim needs a citation you don't have, output [CITATION NEEDED: <topic>] in its place.
Cite primary studies, not reviews unless the review is the canonical reference.`;
}

// === Species section ===
function buildSpeciesSection(species: NonNullable<DomainProfile["species"]>, key: string): string {
  const lines: string[] = [`== Species conventions ==`];
  if (species.first_mention) {
    lines.push(`- First mention: "${species.first_mention}" (italicized in print).`);
  }
  if (species.subsequent?.length) {
    lines.push(`- Subsequent: ${species.subsequent.map(s => `"${s}"`).join(", ")}.`);
  }
  if (species.avoid) {
    lines.push(`- NEVER use redundant form: "${species.avoid}".`);
  }
  return lines.join("\n");
}

// === Stocks section ===
function buildStocksSection(stocks: NonNullable<DomainProfile["stocks"]>, key: string): string {
  const lines: string[] = [`== Stocks / strains ==`];
  if (stocks.format) lines.push(`- Format: "${stocks.format}".`);
  if (stocks.rrid_prefix) lines.push(`- RRID prefix: ${stocks.rrid_prefix}<id>.`);
  if (stocks.description) lines.push(`- ${stocks.description}`);
  if (stocks.common_strains?.length) {
    lines.push(`- Common strains: ${stocks.common_strains.join(", ")}.`);
  }
  if (stocks.rules?.length) {
    lines.push(`- Rules:\n${stocks.rules.map(r => `  - ${r}`).join("\n")}`);
  }
  return lines.join("\n");
}

// === Genotype section ===
function buildGenotypeSection(genotype: NonNullable<DomainProfile["genotype"]>): string {
  const lines: string[] = [`== Genotype format ==`];
  if (genotype.format) lines.push(`- Format: "${genotype.format}".`);
  if (genotype.chromosome_order) lines.push(`- Chromosome order: ${genotype.chromosome_order}.`);
  if (genotype.rules?.length) {
    lines.push(`- Rules:\n${genotype.rules.map(r => `  - ${r}`).join("\n")}`);
  }
  return lines.join("\n");
}

// === Balancers section ===
function buildBalancersSection(balancers: NonNullable<DomainProfile["balancers"]>): string {
  const lines: string[] = [`== Balancers ==`];
  if (balancers.canonical?.length) {
    lines.push(`- Canonical balancers: ${balancers.canonical.join(", ")}.`);
  }
  if (balancers.not_markers?.length) {
    lines.push(`- These are MARKERS (not balancers): ${balancers.not_markers.join(", ")}.`);
  }
  if (balancers.warning) lines.push(`- WARNING: ${balancers.warning}`);
  if (balancers.rules?.length) {
    lines.push(`- Rules:\n${balancers.rules.map(r => `  - ${r}`).join("\n")}`);
  }
  return lines.join("\n");
}

// === Nomenclature section ===
function buildNomenclatureSection(nomenclature: NonNullable<DomainProfile["nomenclature"]>): string {
  const lines: string[] = [`== Nomenclature ==`];
  for (const item of nomenclature) {
    if (typeof item === "string") {
      lines.push(`- ${item}`);
    } else if (item.rule) {
      lines.push(`- ${item.rule}`);
    } else if (item.find && item.replace) {
      lines.push(`- "${item.find}" → "${item.replace}".`);
    }
  }
  return lines.join("\n");
}

// === Key citations section ===
function buildKeyCitationsSection(keyCitations: NonNullable<DomainProfile["key_citations"]>): string {
  const lines: string[] = [`== Key citations (mandatory) ==`];
  for (const c of keyCitations) {
    if (c.term && c.must_cite) {
      lines.push(`- "${c.term}" → must cite: ${c.must_cite}${c.doi ? ` (doi:${c.doi})` : ""}.`);
      if (c.not) lines.push(`  NOT: ${c.not}.`);
    }
  }
  return lines.join("\n");
}

// === Life stages section ===
function buildLifeStagesSection(stages: string[]): string {
  return `== Life stages ==\nCanonical names: ${stages.join(", ")}.`;
}

// === Sex section ===
function buildSexSection(sex: string[]): string {
  return `== Sex (canonical names) ==\n${sex.join(", ")}.`;
}

// === Term mappings section ===
function buildTermMappingsSection(mappings: Array<{ source: string; target: string }>): string {
  const lines: string[] = [`== Domain term mappings ==`];
  for (const m of mappings) {
    lines.push(`- "${m.source}" → "${m.target}".`);
  }
  return lines.join("\n");
}

// === Reporting section ===
function buildReportingSection(reporting: NonNullable<DomainProfile["reporting"]>, key: string): string {
  const lines: string[] = [`== Reporting standards ==`];
  if (reporting.rrid_required) {
    lines.push(`- RRIDs REQUIRED for: ${(reporting.rrid_types ?? []).join(", ")}.`);
  }
  if (reporting.key_resources_table) {
    lines.push(`- Include a Key Resources Table (KRT) at end of manuscript.`);
  }
  if (reporting.arrive2) {
    lines.push(`- ARRIVE 2.0 essential 10 (${reporting.arrive2_reference ?? "Percie du Sert et al. 2020"}):`);
    if (reporting.arrive2_essential_10) {
      for (const item of reporting.arrive2_essential_10) {
        lines.push(`  ${item}`);
      }
    }
    if (reporting.ethical_approval) lines.push(`- ${reporting.ethical_approval}`);
  }
  if (reporting.miqe) {
    lines.push(`- MIQE guidelines required for qPCR experiments.`);
  }
  // Acknowledgements
  if (reporting.acknowledge_bdsc) lines.push(`- BDSC acknowledgement: "${reporting.acknowledge_bdsc}"`);
  if (reporting.acknowledge_jax) lines.push(`- JAX acknowledgement: "${reporting.acknowledge_jax}"`);
  if (reporting.acknowledge_cgc) lines.push(`- CGC acknowledgement: "${reporting.acknowledge_cgc}"`);
  if (reporting.acknowledge_wormbase) lines.push(`- WormBase acknowledgement: "${reporting.acknowledge_wormbase}"`);
  if (reporting.rigorous_statistics) lines.push(`- ${reporting.rigorous_statistics}`);
  return lines.join("\n");
}

// === Standard assays section ===
function buildAssaysSection(assays: string[]): string {
  return `== Standard assays ==\nCanonical names: ${assays.join(", ")}.`;
}