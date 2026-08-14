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
    if (domain.species) parts.push(buildSpeciesSection(domain.species));
    if (domain.stocks) parts.push(buildStocksSection(domain.stocks));
    if (domain.genotype) parts.push(buildGenotypeSection(domain.genotype));
    if (domain.balancers) parts.push(buildBalancersSection(domain.balancers));
    if (domain.nomenclature?.length) parts.push(buildNomenclatureSection(domain.nomenclature));
    if (domain.key_citations?.length) parts.push(buildKeyCitationsSection(domain.key_citations));
    if (domain.life_stages?.length) parts.push(buildLifeStagesSection(domain.life_stages));
    if (domain.sex?.length) parts.push(buildSexSection(domain.sex));
    if (domain.term_mappings?.length) parts.push(buildTermMappingsSection(domain.term_mappings));
    if (hasAnyReportingData(domain.reporting)) parts.push(buildReportingSection(domain.reporting!));
    if (domain.standard_assays?.length) parts.push(buildAssaysSection(domain.standard_assays));
    if (domain.voice && hasAnyVoiceData(domain.voice)) parts.push(buildVoiceSection(domain.voice));
  }

  const label = domain?.name ?? domain?.key ?? "general";
  return `[pi-paper-lab ACTIVE — field=${label}]\n\n${parts.join("\n\n")}`;
}

// === Common rules — AI-tells, hedging, voice, numbers, figures, citations ===
function buildCommonRules(lex: Lexicon): string {
  // Build a concise voice/rules block from the common lexicon.
  return `You are writing scholarly / research text (papers, grants, reviews, methods, or other genres the user requests). Follow these rules:

== Anti-AI prose ==
Avoid these AI-tell phrases: ${lex.avoidedVerbs.slice(0, 10).map(v => `"${v}"`).join(", ")}, and others.
Avoid these AI-tell nouns: ${lex.avoidedNouns.slice(0, 5).map(n => `"${n}"`).join(", ")}, and others.
Delete filler adverbs: ${lex.fillerAdverbs.slice(0, 8).map(a => `"${a}"`).join(", ")}.
Remove opener phrases: "It is important to note", "Of note", "Fascinatingly", "Notably", "In conclusion", "We believe".

== Voice (default, genre-aware) ==
Match the user's genre and field. Prefer clear, specific prose; vary sentence length.
Do NOT invent experimental statistics, sample sizes, or p-values unless the user or source material provides them.
If an active domain profile adds reporting/voice rules below, follow those for that field only.

== Structure ==
Use the structure the user asks for (IMRaD, grant sections, free prose, etc.). Do not force Methods/Results/Discussion unless requested.

== Citations ==
Use the citation style implied by the user or domain profile. NEVER invent DOIs, PMIDs, or stock numbers.
If a claim needs a citation you don't have, output [CITATION NEEDED: <topic>] in its place.
Prefer primary sources when scholarly claims need support.`;
}

// === Species section ===
function buildSpeciesSection(species: NonNullable<DomainProfile["species"]>): string {
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
function buildStocksSection(stocks: NonNullable<DomainProfile["stocks"]>): string {
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
function buildReportingSection(reporting: NonNullable<DomainProfile["reporting"]>): string {
  const lines: string[] = [`== Reporting standards ==`];
  if (reporting.rrid_required) {
    lines.push(`- RRIDs REQUIRED for: ${(reporting.rrid_types ?? []).join(", ")}.`);
  }
  if (reporting.key_resources_table) {
    lines.push(`- Include a Key Resources Table (KRT) at end of manuscript.`);
  }
  if (reporting.arrive2) {
    lines.push(`- ARRIVE 2.0 essential 10${reporting.arrive2_reference ? ` (${reporting.arrive2_reference})` : ""}:`);
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

// === Voice section (domain-specific overrides for each IMRaD section) ===
function buildVoiceSection(voice: NonNullable<DomainProfile["voice"]>): string {
  const lines: string[] = [`== Domain voice overrides ==`];
  if (voice.introduction) lines.push(`- Introduction: ${voice.introduction}`);
  if (voice.methods) lines.push(`- Methods: ${voice.methods}`);
  if (voice.results) lines.push(`- Results: ${voice.results}`);
  if (voice.discussion) lines.push(`- Discussion: ${voice.discussion}`);
  return lines.join("\n");
}

// === Helpers: only emit a section header if it has actual content ===
function hasAnyReportingData(reporting: DomainProfile["reporting"]): boolean {
  if (!reporting) return false;
  return !!(
    reporting.rrid_required ||
    reporting.key_resources_table ||
    reporting.arrive2 ||
    reporting.miqe ||
    reporting.acknowledge_bdsc ||
    reporting.acknowledge_jax ||
    reporting.acknowledge_cgc ||
    reporting.acknowledge_wormbase ||
    reporting.rigorous_statistics
  );
}

function hasAnyVoiceData(voice: DomainProfile["voice"]): boolean {
  if (!voice) return false;
  return !!(voice.introduction || voice.methods || voice.results || voice.discussion);
}