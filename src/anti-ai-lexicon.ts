// src/anti-ai-lexicon.ts
// YAML-backed lexicon loader + scoring + silent rewrite.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";

export type Weight = number;

export interface Lexicon {
  preferredVerbs: string[];
  avoidedVerbs: string[];
  avoidedNouns: string[];
  fillerAdverbs: string[];
  phraseOpeners: string[];
  fillerPhraseOpeners: string[];
  fillerConnectorPhrases: Record<string, string>;
  domain: {
    speciesFirstMention: string[];
    speciesSubsequent: string[];
    stockReferenceFormat: string;
    stockAlternative: string[];
    genotypeNotation: string;
    genotypeExample: string;
    genotypeRules: string[];
    balancers: string[];
    transgeneGal4Example: string;
    transgeneUasExample: string;
    transgeneRules: string[];
    lifeStages: string[];
    sexTerms: string[];
    standardAssays: string[];
    standardToolsFullMention: string[];
    domainTermMappings: Array<{ source: string; target: string }>;
  };
  numbers: {
    pValueFormat: string[];
    ciFormat: string[];
    effectSize: { requiredWhen: string; types: string[] };
    nRequired: { body: string; figureLegend: string };
    multipleTesting: { methods: string[]; mentionRequiredWhen: string };
  };
  hedging: {
    introduction: { assertiveness: string; allowed: string[]; avoided: string[] };
    methods: { assertiveness: string; noHedging: boolean };
    results: {
      assertiveness: string;
      required: string[];
      avoided: string[];
    };
    discussion: {
      interpretationParagraph: string;
      speculationParagraphFinal: string;
      required: string[];
      avoided: string[];
    };
  };
  voice: {
    introduction: {
      canUse: boolean | "limited";
      reason: string;
      alternative?: string;
      preferredPattern?: string;
      avoidPatterns?: string[];
    };
    methods: { firstPersonWe: boolean; passiveOk: boolean; format: string[] };
    results: { firstPersonWe: boolean; recommended: boolean; passiveOk: boolean; format: string[] };
    discussion: { firstPersonWe: boolean; recommended: boolean; format: string[] };
  };
  figures: { referenceStyle: string[]; avoid: string[] };
  citations: { inlineFormat: string[]; placeHolder: string; neverInvent: boolean; note: string };
  reportingStandards: {
    arrive2Essentials: {
      field: string;
      description: string;
      missingInMethodsIfAbsent: string[];
      checkCommand: string;
    };
    miqeBrief: { field: string; description: string; missingIfAbsent: string[] };
  };
  // v0.4 — sloppy human writing patterns
  sloppyPatterns: {
    vagueQuantifiers: string[];
    vagueTime: string[];
    vagueLocation: string[];
    causalOverclaim: string[];
    correlationCausationConflation: string[];
    passiveOveruse: string[];
    hedgeOveruseInResults: string[];
  };
  // v0.4 — claim strength policy
  claimStrength: {
    grades: Record<string, {
      requires: string[];
      allowedVerbs: string[];
      requiredQualifier?: string;
    }>;
    overclaimVerbsInResults: string[];
    underclaimVerbsInResults: string[];
    errorReporting: { rule: string; never: string };
  };
  scoring: {
    weights: {
      avoidedVerbHit: number;
      avoidedNounHit: number;
      fillerAdverbHit: number;
      aiOpenerHit: number;
      emdashOveruseThreshold: number;
      sentenceLengthUniformity: number;
    };
    thresholds: { safeMax: number; cautionMax: number };
  };
}

// Helper: flatten a string-or-string[] field into a string[].
const arr = (v: unknown): string[] => {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  if (typeof v === "string") return [v.trim()].filter(Boolean);
  return [];
};

const obj = (v: unknown): Record<string, string> => {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const o: Record<string, string> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      o[k] = String(val).trim();
    }
    return o;
  }
  return {};
};

export function loadLexicon(rootDir: string): Lexicon {
  const path = join(rootDir, "data", "drosophila-lexicon.yaml");
  const raw = readFileSync(path, "utf8");
  const data = yaml.load(raw) as Record<string, any>;

  // --- preferred_verbs: list of strings (sub-keys flattened) ---
  const preferredVerbsRaw = data.preferred_verbs ?? {};
  let preferredVerbs: string[] = [];
  if (Array.isArray(preferredVerbsRaw)) {
    preferredVerbs = preferredVerbsRaw.map((x: any) => String(x)).flatMap((g: string) =>
      g.split(/\s+/).filter(Boolean),
    );
  } else if (typeof preferredVerbsRaw === "object" && preferredVerbsRaw !== null) {
    for (const v of Object.values(preferredVerbsRaw)) {
      preferredVerbs = preferredVerbs.concat(arr(v));
    }
  }

  // --- filler words ---
  const filler = data.filler_words ?? {};
  const fillerAdverbs = arr(filler.adverbs_to_remove);
  const phraseOpenersRaw = arr(filler.phrase_openers_to_remove);
  const connectorPhrasesSrc = filler.phrase_connectors_to_rephrase;
  const fillerConnectorPhrases: Record<string, string> = {};
  if (connectorPhrasesSrc && typeof connectorPhrasesSrc === "object" && !Array.isArray(connectorPhrasesSrc)) {
    for (const [k, v] of Object.entries(connectorPhrasesSrc as Record<string, unknown>)) {
      fillerConnectorPhrases[k.trim()] = String(v).trim();
    }
  }
  // Fallback only if YAML is missing the section entirely (defensive).
  const fallbackConnectors: Record<string, string> = {
    "in order to": "to",
    "due to the fact that": "because",
    "in spite of the fact that": "although",
    "with regard to": "for",
    "in the event that": "if",
    "a large number of": "many",
    "the majority of": "most",
    "at this point in time": "now",
    "is able to": "can",
  };
  for (const [k, v] of Object.entries(fallbackConnectors)) {
    if (!(k in fillerConnectorPhrases)) fillerConnectorPhrases[k] = v;
  }

  // --- domain ---
  const conventions = data.conventions ?? {};
  // Merge self-promotion openers into phrase_openers_to_remove (N3 fix):
  // "for the first time", "to our knowledge" etc. live in their own YAML key
  // but behave identically to opener removal at write-time.
  const phraseOpeners = [
    ...phraseOpenersRaw,
    ...arr(conventions.self_promotion_openers_to_remove),
  ];
  const speciesMent = conventions.species_first_mention ?? {};
  const speciesSub = conventions.species_subsequent ?? {};
  const stockRef = conventions.stock_reference ?? {};
  const genotype = conventions.genotype_notation ?? {};
  const balancer = conventions.balancer_notation ?? {};
  const transgene = conventions.transgene_naming ?? {};
  const life = conventions.fly_life_stage_terms ?? {};
  const sex = conventions.sex_canonical ?? {};
  const assays = conventions.standard_assays ?? {};
  const tools = conventions.standard_tools_mention_full ?? {};
  const domain = {
    speciesFirstMention: arr(speciesMent),
    speciesSubsequent: arr(speciesSub),
    stockReferenceFormat: String(stockRef.format ?? "BDSC stock #"),
    stockAlternative: arr(stockRef.alternatives),
    genotypeNotation: String(genotype.style ?? ""),
    genotypeExample: String(genotype.example ?? ""),
    genotypeRules: arr(genotype.rules),
    balancers: arr(balancer.canonical),
    transgeneGal4Example: String(transgene.gal4_example ?? ""),
    transgeneUasExample: String(transgene.uas_example ?? ""),
    transgeneRules: arr(transgene.rules),
    lifeStages: arr(life),
    sexTerms: arr(sex),
    standardAssays: arr(assays),
    standardToolsFullMention: arr(tools),
    domainTermMappings: (() => {
      const m = (data as any)?.conventions?.domain_term_mappings;
      if (!Array.isArray(m)) return [];
      return m
        .filter(
          (e: any) =>
            typeof e?.source === "string" && typeof e?.target === "string",
        )
        .map((e: any) => ({ source: e.source, target: e.target }));
    })(),
  };

  // --- numbers ---
  const numbers = data.numbers ?? {};
  const stats = numbers.statistics ?? {};
  return {
    preferredVerbs,
    avoidedVerbs: arr(data.avoided_verbs),
    avoidedNouns: arr(data.avoided_nouns),
    fillerAdverbs,
    phraseOpeners,
    fillerPhraseOpeners: phraseOpeners,
    fillerConnectorPhrases,
    domain,
    numbers: {
      pValueFormat: arr(stats.p_value_format),
      ciFormat: arr(stats.ci_format),
      effectSize: {
        requiredWhen: String(stats.effect_size?.required_when ?? "every p-value reported"),
        types: arr(stats.effect_size?.types),
      },
      nRequired: {
        body: String(stats.n_required?.body ?? ""),
        figureLegend: String(stats.n_required?.figure_legend ?? ""),
      },
      multipleTesting: {
        methods: arr(stats.multiple_testing?.methods),
        mentionRequiredWhen: String(stats.multiple_testing?.mention_required_when ?? ""),
      },
    },
    hedging: {
      introduction: {
        assertiveness: String(data.hedging?.introduction?.assertiveness ?? "high"),
        allowed: arr(data.hedging?.introduction?.allowed),
        avoided: arr(data.hedging?.introduction?.avoided),
      },
      methods: {
        assertiveness: String(data.hedging?.methods?.assertiveness ?? "highest"),
        noHedging: Boolean(data.hedging?.methods?.no_hedging ?? true),
      },
      results: {
        assertiveness: String(data.hedging?.results?.assertiveness ?? "high"),
        required: arr(data.hedging?.results?.required_format),
        avoided: arr(data.hedging?.results?.avoided),
      },
      discussion: {
        interpretationParagraph: String(data.hedging?.discussion?.interpretation_paragraph ?? ""),
        speculationParagraphFinal: String(data.hedging?.discussion?.speculation_paragraph_final ?? ""),
        required: arr(data.hedging?.discussion?.required_format),
        avoided: arr(data.hedging?.discussion?.avoided),
      },
    },
    voice: {
      introduction: {
        canUse: (() => {
          const v = data.voice?.introduction?.can_use;
          if (v === "limited" || v === "false" || v === false) return "limited" as const;
          return Boolean(v);
        })(),
        reason: String(data.voice?.introduction?.reason ?? ""),
        preferredPattern: String(data.voice?.introduction?.preferred_pattern ?? ""),
        avoidPatterns: arr(data.voice?.introduction?.avoid_patterns),
      },
      methods: {
        firstPersonWe: Boolean(data.voice?.methods?.first_person_we ?? true),
        passiveOk: Boolean(data.voice?.methods?.passive_ok ?? true),
        format: arr(data.voice?.methods?.format),
      },
      results: {
        firstPersonWe: Boolean(data.voice?.results?.first_person_we ?? true),
        recommended: Boolean(data.voice?.results?.recommended ?? true),
        passiveOk: Boolean(data.voice?.results?.passive_ok ?? false),
        format: arr(data.voice?.results?.format),
      },
      discussion: {
        firstPersonWe: Boolean(data.voice?.discussion?.first_person_we ?? true),
        recommended: Boolean(data.voice?.discussion?.recommended ?? true),
        format: arr(data.voice?.discussion?.format),
      },
    },
    figures: {
      referenceStyle: arr(data.figures?.reference_style),
      avoid: arr(data.figures?.avoid),
    },
    citations: {
      inlineFormat: arr(data.citations?.inline_format),
      placeHolder: String(data.citations?.when_no_citation_yet?.action ?? "[CITATION NEEDED: <topic>]"),
      neverInvent: Boolean(data.citations?.when_no_citation_yet?.never_invent ?? true),
      note: String(data.citations?.when_no_citation_yet?.note ?? ""),
    },
    reportingStandards: {
      arrive2Essentials: {
        field: String(data.reporting_standards?.arrive_2_essentials?.field ?? ""),
        description: String(data.reporting_standards?.arrive_2_essentials?.description ?? ""),
        missingInMethodsIfAbsent: arr(
          data.reporting_standards?.arrive_2_essentials?.missing_in_methods_if_absent,
        ),
        checkCommand: String(data.reporting_standards?.arrive_2_essentials?.check_command ?? "/bio-standards"),
      },
      miqeBrief: {
        field: String(data.reporting_standards?.miqe_brief?.field ?? ""),
        description: String(data.reporting_standards?.miqe_brief?.description ?? ""),
        missingIfAbsent: arr(data.reporting_standards?.miqe_brief?.missing_if_absent),
      },
    },

    // --- v0.4: sloppy patterns + claim strength ---
    sloppyPatterns: (() => {
      const s = data.sloppy_patterns ?? {};
      return {
        vagueQuantifiers: arr(s.vague_quantifiers),
        vagueTime: arr(s.vague_time),
        vagueLocation: arr(s.vague_location),
        causalOverclaim: arr(s.causal_overclaim),
        correlationCausationConflation: arr(s.correlation_causation_conflation),
        passiveOveruse: arr(s.passive_overuse),
        hedgeOveruseInResults: arr(s.hedge_overuse_in_results),
      };
    })(),

    claimStrength: (() => {
      const cs = data.claim_strength ?? {};
      const gradesRaw = cs.grades ?? {};
      const grades: Record<string, {
        requires: string[];
        allowedVerbs: string[];
        requiredQualifier?: string;
      }> = {};
      if (gradesRaw && typeof gradesRaw === "object" && !Array.isArray(gradesRaw)) {
        for (const [name, g] of Object.entries(gradesRaw as Record<string, any>)) {
          if (g && typeof g === "object") {
            grades[name] = {
              requires: arr(g.requires),
              allowedVerbs: arr(g.allowed_verbs),
              requiredQualifier: g.required_qualifier ? String(g.required_qualifier) : undefined,
            };
          }
        }
      }
      return {
        grades,
        overclaimVerbsInResults: arr(cs.overclaim_verbs_in_results),
        underclaimVerbsInResults: arr(cs.underclaim_verbs_in_results),
        errorReporting: {
          rule: String(cs.error_reporting?.rule ?? ""),
          never: String(cs.error_reporting?.never ?? ""),
        },
      };
    })(),
    scoring: {
      weights: {
        avoidedVerbHit: Number(data.ai_tell_scoring?.weights?.avoided_verb_hit ?? 1.0),
        avoidedNounHit: Number(data.ai_tell_scoring?.weights?.avoided_noun_hit ?? 1.0),
        fillerAdverbHit: Number(data.ai_tell_scoring?.weights?.filler_adverb_hit ?? 1.5),
        aiOpenerHit: Number(data.ai_tell_scoring?.weights?.ai_opener_hit ?? 3.0),
        emdashOveruseThreshold: Number(data.ai_tell_scoring?.weights?.emdash_overuse_threshold ?? 2.0),
        sentenceLengthUniformity: Number(data.ai_tell_scoring?.weights?.sentence_length_uniformity ?? 1.0),
      },
      thresholds: {
        safeMax: (() => {
          const v = data.ai_tell_scoring?.thresholds?.safe_max ?? data.ai_tell_scoring?.thresholds?.safe;
          const n = typeof v === "number" ? v : Number(v);
          return Number.isFinite(n) ? n : 2;
        })(),
        cautionMax: (() => {
          const v = data.ai_tell_scoring?.thresholds?.caution_max ?? data.ai_tell_scoring?.thresholds?.caution;
          const n = typeof v === "number" ? v : Number(v);
          return Number.isFinite(n) ? n : 5;
        })(),
      },
    },
  };
}

// === Detection ===

export interface ScoreDetail {
  hit: string;
  category: "verb" | "noun" | "filler" | "opener" | "connector" | "emdash";
  weight: number;
}

export interface ScoreResult {
  total: number;
  hits: ScoreDetail[];
  verdict: "human-like" | "edit-recommended" | "rewrite-mandatory";
}

const escapeForRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function scoreText(text: string, lex: Lexicon): ScoreResult {
  const hits: ScoreDetail[] = [];
  const lower = text.toLowerCase();

  const W = lex.scoring.weights;

  // avoided verbs (skip blanks and skip very short values like "we" / "use")
  for (const v of lex.avoidedVerbs) {
    if (!v || v.length < 4) continue;
    const re = new RegExp(`\\b${escapeForRegex(v.toLowerCase())}\\b`, "g");
    const m = lower.match(re);
    if (m) for (const _ of m) hits.push({ hit: v, category: "verb", weight: W.avoidedVerbHit });
  }
  // avoided nouns
  for (const n of lex.avoidedNouns) {
    if (!n || n.length < 5) continue;
    const re = new RegExp(`\\b${escapeForRegex(n.toLowerCase())}\\b`, "g");
    const m = lower.match(re);
    if (m) for (const _ of m) hits.push({ hit: n, category: "noun", weight: W.avoidedNounHit });
  }
  // filler adverbs
  for (const a of lex.fillerAdverbs) {
    if (!a) continue;
    const re = new RegExp(`\\b${escapeForRegex(a.toLowerCase())}\\b`, "g");
    const m = lower.match(re);
    if (m) for (const _ of m) hits.push({ hit: a, category: "filler", weight: W.fillerAdverbHit });
  }
  // phrase openers (substring because they include commas)
  for (const p of lex.phraseOpeners) {
    if (!p) continue;
    if (lower.includes(p.toLowerCase())) {
      hits.push({ hit: p, category: "opener", weight: W.aiOpenerHit });
    }
  }
  // em-dash overuse
  const emdashes = (text.match(/—/g) ?? []).length;
  if (emdashes > 2) {
    hits.push({
      hit: `em-dash x ${emdashes}`,
      category: "emdash",
      weight: W.emdashOveruseThreshold,
    });
  }

  const total = hits.reduce((acc, h) => acc + h.weight, 0);
  let verdict: ScoreResult["verdict"];
  if (total === 0 || total < lex.scoring.thresholds.safeMax) verdict = "human-like";
  else if (total <= lex.scoring.thresholds.cautionMax) verdict = "edit-recommended";
  else verdict = "rewrite-mandatory";

  return { total, hits, verdict };
}

// === Silent rewrite ===

const VERB_REPLACEMENTS: Record<string, string> = {
  "has been shown to": "",
  "have been shown to": "",
  "has previously been shown to": "",
  "have previously been shown to": "",
  "is known to": "",
  "are known to": "",
  "delve into": "examine",
  "delve": "examine",
  "navigate": "examine",
  "shed light on": "reveal",
  "shed new light on": "reveal",
  "unravel": "dissect",
  "leverage": "use",
  "foster": "support",
  "elucidate": "clarify",
  "explore the complexities of": "examine",
  "explore the intricate": "examine the",
  "tackle the challenge": "address",
  "pave the way": "enable",
  "open new avenues": "enable",
  "drive innovation": "advance",
};

const NOUN_REPLACEMENTS: Record<string, string> = {
  "intricacies": "mechanisms",
  "intricate network": "network",
  "intricate": "detailed",
  "multifaceted role": "role",
  "multifaceted": "multiple",
  "tapestry": "set",
  "complex interplay": "interaction",
  "state-of-the-art": "established",
  "novel insights": "findings",
  "novel approach": "approach",
  "novel therapeutic targets": "targets",
  "groundbreaking": "new",
  "unprecedented": "",
  "revolutionary": "",
  "burgeoning field": "field",
  "profound": "marked",
  "remarkable": "marked",
  "novel": "new",
  "cutting-edge": "established",
};

const VERB_PHRASE_REPLACEMENTS: Record<string, string> = {
  // "X plays a crucial role in Y" → "X is required for Y" (B4 / M4)
  // The "in " is intentionally preserved: the source phrase is "plays a role
  // IN Y" and the target is "required for Y", so we map to "is required for"
  // and the trailing "in " is consumed by the broader sentence.
  // Use case-sensitive match on multi-word phrases; the regex later handles
  // case preservation for the first character.
  "plays a crucial role in": "is required for",
  "plays a key role in": "is required for",
  "plays an essential role in": "is required for",
  "plays a critical role in": "is required for",
  "plays a vital role in": "is required for",
  "plays a major role in": "is required for",
  "plays a central role in": "is required for",
  "plays an important role in": "is required for",
  "plays a significant role in": "is required for",
  "play a crucial role in": "are required for",
  "play a key role in": "are required for",
  "play an essential role in": "are required for",
};

export interface SilentRewriteStats {
  connectors: number;
  fillers: number;
  verbs: number;
  flaggedVerbs: string[];
}

export function silentRewrite(text: string, lex: Lexicon): { text: string; stats: SilentRewriteStats } {
  let out = text;
  const stats: SilentRewriteStats = {
    connectors: 0,
    fillers: 0,
    verbs: 0,
    flaggedVerbs: [],
  };

  // Connectors (longest first)
  const connectorsSorted = Object.entries(lex.fillerConnectorPhrases).sort(
    ([a], [b]) => b.length - a.length,
  );
  for (const [phrase, replacement] of connectorsSorted) {
    if (!phrase) continue;
    const re = new RegExp(`\\b${escapeForRegex(phrase)}\\b`, "gi");
    out = out.replace(re, (match) => {
      stats.connectors++;
      if (match[0] === match[0].toUpperCase()) {
        return replacement[0].toUpperCase() + replacement.slice(1);
      }
      return replacement;
    });
  }

  // Filler adverbs (silent deletion of adverb + adjacent comma)
  for (const a of lex.fillerAdverbs) {
    if (!a) continue;
    const re = new RegExp(
      `(,\\s*)?\\b${escapeForRegex(a)}\\b(\\s*,)?`,
      "gi",
    );
    const matches: RegExpExecArray[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(out)) !== null) {
      matches.push(m);
      re.lastIndex = m.index + m[0].length;
    }
    if (matches.length === 0) continue;
    stats.fillers += matches.length;
    let result = out;
    for (let i = matches.length - 1; i >= 0; i--) {
      const mm = matches[i];
      const head = result.slice(0, mm.index);
      const tail = result.slice(mm.index + mm[0].length);
      result = head + " " + tail;
    }
    out = result;
  }

  // Avoided nouns (rewrite to neutral noun). Hyphen-protected (B5 fix).
  // Process longest-first so "intricate network" matches before "intricate" (N2 fix).
  const nounsByLength = lex.avoidedNouns.slice().sort((a, b) => b.length - a.length);
  for (const n of nounsByLength) {
    if (!n) continue;
    const lower = n.toLowerCase();
    const replacement = NOUN_REPLACEMENTS[lower];
    if (!replacement && replacement !== "") {
      // no mapping for this noun — leave alone
      continue;
    }
    const re = new RegExp(`(?<!-)\\b${escapeForRegex(lower)}\\b(?!-)`, "gi");
    const matches = out.match(re);
    if (matches) {
      stats.verbs += matches.length;
      out = out.replace(re, (match) => {
        const rep = replacement === "" ? "" : replacement;
        if (rep.length === 0) return "";
        if (match[0] === match[0].toUpperCase()) {
          return rep[0].toUpperCase() + rep.slice(1);
        }
        return rep;
      });
    }
  }

  // Avoided verbs (rewrite to neutral verb). Hyphen-protected to avoid false
  // matches inside compound words like "deep-delve-into-like" (B5 fix).
  for (const v of lex.avoidedVerbs) {
    if (!v) continue;
    const lower = v.toLowerCase();
    const replacement = VERB_REPLACEMENTS[lower] ?? VERB_PHRASE_REPLACEMENTS[lower];
    if (replacement === undefined) {
      // Only flag if the verb actually appears in the text (B7 fix).
      const probe = new RegExp(`(?<!-)\\b${escapeForRegex(lower)}\\b(?!-)`, "gi");
      if (probe.test(out)) stats.flaggedVerbs.push(v);
      continue;
    }
    const re = new RegExp(`(?<!-)\\b${escapeForRegex(lower)}\\b(?!-)`, "gi");
    const matches = out.match(re);
    if (matches) {
      stats.verbs += matches.length;
      out = out.replace(re, (match) => {
        if (replacement === "") return "";
        if (match[0] === match[0].toUpperCase()) {
          return replacement[0].toUpperCase() + replacement.slice(1);
        }
        return replacement;
      });
    }
  }
  // === Domain-term mappings (M1 — "neural stem cell" → "neuroblast") ===
  // Longest-first to avoid partial-match loss.
  const domainMappings = lex.domain.domainTermMappings.slice().sort(
    (a, b) => b.source.length - a.source.length,
  );
  for (const { source, target } of domainMappings) {
    const re = new RegExp(`(?<!-)\\b${escapeForRegex(source)}\\b(?!-)`, "gi");
    const matches = out.match(re);
    if (matches) {
      stats.verbs += matches.length;
      out = out.replace(re, (match) => {
        if (match[0] === match[0].toUpperCase()) {
          return target[0].toUpperCase() + target.slice(1);
        }
        return target;
      });
    }
  }

  // Phrase openers (silent deletion of boilerplate that opens sentences/paragraphs).
  // These often need to be removed, not rewritten, because the sentence usually
  // does not need the opener once it's stripped.
  // Use a lookahead `(?=\s|,|$)` instead of `\b` so comma-suffixed openers
  // like "Of note," / "In conclusion," also match (B3b fix).
  for (const openerRaw of lex.phraseOpeners) {
    if (!openerRaw) continue;
    const opener = openerRaw.toLowerCase();
    // Note: we drop the trailing \b on the opener because comma-suffixed
    // openers like "Of note," / "In conclusion," end with a non-word char
    // (comma) which \b would not match. Use lookahead instead.
    const re = new RegExp(
      `(?:^|[.!?]\\s+)\\b${escapeForRegex(opener)}(?=\\s|,|$)\\s*,?\\s*`,
      "gmi",
    );
    const m = out.match(re);
    if (m) {
      stats.connectors += m.length; // count under connectors for stat unification
      out = out.replace(re, " ");
    }
  }

  // === Capitalize at sentence starts (B3 fix — runs AFTER all rewrites) ===
  // Boundaries: start of text, ". ", "! ", "? ", "\n\n", and \n followed by
  // space (paragraph reflow in markdown).
  out = out.replace(
    /(^|[\.\!\?]\s+|\n\n+|\n[ \t]+)([ \t]*)([a-z])/g,
    (_full, boundary, ws, ch) => `${boundary}${ws}${ch.toUpperCase()}`,
  );

  // === Article agreement fix (N1 fix) ===
  // After noun replacements ("intricate"→"detailed", "novel"→"", etc.) the
  // preceding article may now be wrong: "An detailed" → "A detailed",
  // "A intricate" → "An intricate". We rebuild the article by vowel test
  // on the first letter of the following word.
  out = out.replace(
    /\b([Aa])(n?)\s+([a-zA-Z])/g,
    (_full, a, n, firstLetter) => {
      const isVowel = /^[aeiouAEIOU]/.test(firstLetter);
      const needAn = isVowel;
      const hasAn = n.length > 0;
      if (needAn === hasAn) return `${a}${n} ${firstLetter}`;
      // Flip n. Keep the case of "A"/"a" as-is.
      return `${a}${needAn ? "n" : ""} ${firstLetter}`;
    },
  );

  // === Cleanup specific opener-removal artifacts ===
  // When "It is important to note that" is removed at start of paragraph,
  // a leading space remains. Strip leading whitespace at line start.
  out = out.replace(/^[ \t\u00A0]+/gm, "");
  // "aim to investigate" → real tense
  out = out.replace(/\baim to\b/gi, () => {
    stats.connectors++;
    return "set out to";
  });
  // "set out to <verb>" → past tense for v0.2 polish
  out = out.replace(/\b(set out to|set about)\s+(\w+)/gi, (_full, _prep, verb) => {
    stats.connectors++;
    return verb.endsWith("e") ? `${verb}d` : `${verb}ed`;
  });
  // "may suggest" / "could indicate" — rewrite to observation language.
  // Use the "that"-preserving form first so the resulting sentence is grammatically
  // sound (Oracle B3 fix: avoids stranded `that` clause).
  out = out.replace(
    /\b([\w\s'-]{2,80}?)\s+(may|could|would|might)\s+(suggest|indicate|imply)\s+that\s+/gi,
    (_full, subject, _modal, _verb) => {
      stats.connectors++;
      const s = subject.trim();
      return `${s} is consistent with the observation that `;
    },
  );
  out = out.replace(
    /\b([\w\s'-]{2,80}?)\s+(may|could|would|might)\s+(suggest|indicate|imply)\b/gi,
    (_full, subject, _modal, _verb) => {
      stats.connectors++;
      const s = subject.trim();
      return `${s} is consistent with`;
    },
  );
  // "Our findings suggest" → "We observed" inside Results only — we apply heuristic.
  out = out.replace(/\b(our findings|the data)\s+suggest(s|ed)?\b/gi, (m) => {
    stats.connectors++;
    return "we observed";
  });
  // "These findings suggest" → keep but lower-tense claim
  out = out.replace(/\bthese findings\s+(suggest|indicate|imply)\b/gi, (m, verb) => {
    stats.connectors++;
    return `these findings are consistent with`;
  });
  // "We aim to investigate" → "We investigated" (Drosophila writing is direct).
  out = out.replace(/\bwe aim to\s+(\w+)/gi, (_full, verb) => {
    stats.connectors++;
    const past = verb.endsWith("e") ? `${verb}d` : `${verb}ed`;
    return `we ${past}`;
  });
  out = out.replace(/\bin this paper,?\s*we\b/gi, () => {
    stats.connectors++;
    return "Here, we";
  });
  // Broader Results-claim hedges — "may suggest that" removed verb is too strong.
  out = out.replace(/\b(may|might)\s+play\s+a\s+(crucial|key|critical|essential|important|vital)\s+role\b/gi, (m) => {
    stats.connectors++;
    return "is required for";
  });
  // Subject-verb agreement fix after "These/Our/The findings" + is/are (B4 fix).
  out = out.replace(/\b(these|our|the)\s+findings\s+is\b/gi, "$1 findings are");

  out = out.replace(/[ \t]{2,}/g, " ");
  out = out.replace(/\s+([.,;:])/g, "$1");
  out = out.trim();

  return { text: out, stats };
}
