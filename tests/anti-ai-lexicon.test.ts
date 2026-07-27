// tests/anti-ai-lexicon.test.ts
// Regression suite for pi-paper-lab v0.2.

import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadLexicon, scoreText, silentRewrite } from "../src/anti-ai-lexicon.ts";
import { checkClaimStrength } from "../src/claim-strength.ts";
import { detectSloppy } from "../src/sloppy-detector.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

const lex = loadLexicon(ROOT);

const assert = (cond: unknown, msg: string): void => {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exit(1);
  } else {
    console.log("ok:", msg);
  }
};

// =====================================================================
// ORIGINAL v0.1 tests (preserved for non-regression)
// =====================================================================

const aiProse = `
It is important to note that our study delves into the genetic landscape of Drosophila development.
We leverage state-of-the-art CRISPR technology to shed light on the complex interplay between Gal4 drivers.
Crucially, our findings may potentially navigate the underlying mechanisms.
`;
const score = scoreText(aiProse, lex);
assert(score.total > 5, "AI prose scores above flagged threshold");
assert(score.hits.some((h) => h.category === "verb"), "Detected avoided verbs");
assert(score.hits.some((h) => h.category === "opener"), "Detected phrase opener");
assert(score.hits.some((h) => h.category === "filler"), "Detected filler adverb");

const humanProse = `
We crossed y[1] w[1118]; +; P{GAL4}attP2 females to balancer males and aged the
progeny at 25 degrees C. Third-instar larvae (n=24 per genotype, 3 biological
replicates) were dissected and stained. We measured axon diameter from confocal
z-stacks (Fiji). Statistical comparisons used Mann-Whitney U tests with
Bonferroni-Holm correction (alpha=0.05). Effect sizes are reported as Hedges' g
with 95% CI [-3.2, 0.1]. As shown in Figure 1A, mutation of taranis reduces
axon crossing. We did not observe a phenotype in heterozygous siblings.
`;
const goodScore = scoreText(humanProse, lex);
assert(goodScore.total < 2, `Human prose scores under threshold (got ${goodScore.total})`);
assert(goodScore.verdict === "human-like", `Human prose verdict is human-like (got ${goodScore.verdict})`);

const rewriteTarget =
  "It is important to note that, in order to study the fly, we leverage CRISPR in order to shed light on gene function.";
const { text: rewritten, stats } = silentRewrite(rewriteTarget, lex);
assert(stats.connectors > 0, "Connectors rewritten");
const fillerOnly = "It is crucial, notably, that the gene is, importantly, expressed.";
const { stats: fillerStats } = silentRewrite(fillerOnly, lex);
assert(fillerStats.fillers >= 2, "Filler adverbs silently removed");
assert(!rewritten.includes("leverage"), "Avoided verb 'leverage' replaced in main test");
assert(!rewritten.includes("in order to"), "Connector compressed");
assert(!rewritten.toLowerCase().includes("it is important to note"), "Opener removed from main test");

// =====================================================================
// DEEPSEEK V4 PRO BLOCKING BUG REGRESSION TESTS
// =====================================================================

// --- B1: YAML connector phrases no longer decorative ---
assert(
  Object.keys(lex.fillerConnectorPhrases).length >= 9,
  "B1: connector phrases loaded from YAML (≥9)",
);
assert(
  lex.fillerConnectorPhrases["in order to"] === "to",
  "B1: 'in order to' → 'to' present in YAML-loaded map",
);

// --- B2: thresholds are real numbers, not NaN ---
assert(
  Number.isFinite(lex.scoring.thresholds.safeMax),
  `B2: safeMax is finite (got ${lex.scoring.thresholds.safeMax})`,
);
assert(
  Number.isFinite(lex.scoring.thresholds.cautionMax),
  `B2: cautionMax is finite (got ${lex.scoring.thresholds.cautionMax})`,
);
// Real verdict logic: human-like is reachable for score 0
const zeroScore = scoreText("OK.", lex);
assert(zeroScore.verdict === "human-like", "B2: zero-score verdict is human-like");

// --- B3: sentence-start capitalisation after opener removal ---
const cap1 = silentRewrite("It is important to note that the gene is expressed.", lex).text;
assert(/^The gene is expressed/.test(cap1), `B3: opener removed + capitalize works (got "${cap1}")`);

// --- B3b: comma-suffixed openers no longer dead ---
const cap2 = silentRewrite("Of note, the gene was expressed.", lex).text;
assert(!cap2.includes("Of note"), `B3b: 'Of note,' removed (got "${cap2}")`);
const cap3 = silentRewrite("In conclusion, we showed the result.", lex).text;
assert(!cap3.includes("In conclusion"), `B3b: 'In conclusion,' removed (got "${cap3}")`);

// --- B4: subject-verb agreement on Our/These/The findings ---
assert(
  silentRewrite("Our findings may suggest a link.", lex).text.includes("are consistent"),
  "B4: 'Our findings is' fixed",
);
assert(
  silentRewrite("These findings may suggest a link.", lex).text.includes("are consistent"),
  "B4: 'These findings is' fixed",
);
assert(
  silentRewrite("The findings may suggest a link.", lex).text.includes("are consistent"),
  "B4: 'The findings is' fixed",
);
// And the 'that'-clause preserved
assert(
  silentRewrite("Our findings may suggest that X drives Y.", lex).text.includes("the observation that"),
  "B4: 'may suggest that' preserves the that-clause grammatically",
);

// --- B5: hyphen-protected regex ---
assert(
  silentRewrite("The deep-delve-into-like state.", lex).text === "The deep-delve-into-like state.",
  "B5: hyphen-protected 'delve' (no false match)",
);
assert(
  silentRewrite("The re-leverage test.", lex).text === "The re-leverage test.",
  "B5: hyphen-protected 'leverage' (no false match)",
);

// --- B7: flaggedVerbs only flagged if verb is in text ---
const { stats: cleanStats } = silentRewrite("The fly was crossed.", lex);
assert(
  cleanStats.flaggedVerbs.length === 0,
  `B7: clean text has zero flaggedVerbs (got ${cleanStats.flaggedVerbs.length})`,
);

// =====================================================================
// ORACLE SCIENTIFIC BUG REGRESSION TESTS
// =====================================================================

// --- Oracle M1: neural stem cell → neuroblast ---
const m1 = silentRewrite("Neural stem cell specification in Drosophila.", lex).text;
assert(
  /Neuroblast specification/.test(m1),
  `M1: 'neural stem cell specification' → 'neuroblast specification' (got "${m1}")`,
);
const m1b = silentRewrite("Neural stem cells in the brain.", lex).text;
assert(
  /Neuroblasts in the brain/.test(m1b),
  `M1b: 'neural stem cells' → 'neuroblasts' (got "${m1b}")`,
);

// --- Oracle M4: 'plays a crucial role' → 'is required for' ---
const m4 = silentRewrite("Taranis plays a crucial role in neuroblast self-renewal.", lex).text;
assert(
  m4.includes("is required for neuroblast"),
  `M4: 'plays a crucial role in' → 'is required for' (got "${m4}")`,
);
const m4b = silentRewrite("X plays an essential role in Y.", lex).text;
assert(m4b.includes("is required for"), `M4: 'plays an essential role' → 'is required for' (got "${m4b}")`);

// --- Oracle B1: balancer list correct ---
assert(lex.domain.balancers.includes("FM7"), "B1 balancers: FM7 present (X-chromosome)");
assert(lex.domain.balancers.includes("CyO"), "B1 balancers: CyO present (chr 2)");
assert(lex.domain.balancers.includes("TM6B"), "B1 balancers: TM6B present (chr 3)");
assert(!lex.domain.balancers.includes("Sp"), "B1 balancers: Sp NOT present (it's a marker)");

// --- Oracle M5: intricate/multifaceted actually rewrite ---
const m5 = silentRewrite("The intricate network of the progenitor cells.", lex).text;
assert(!m5.includes("intricate"), `M5: 'intricate' rewritten (got "${m5}")`);
const m5b = silentRewrite("We explored the multifaceted role of taranis.", lex).text;
assert(!m5b.includes("multifaceted"), `M5: 'multifaceted role' rewritten (got "${m5b}")`);

// --- Oracle: adjective intensifiers flagged ---
const intensifier = silentRewrite("This shows a profound disorganization.", lex).text;
assert(!intensifier.includes("profound"), `Adjective 'profound' replaced (got "${intensifier}")`);

// --- Voice rule: 'limited' allowed 'Here, we...' ---
const voiceCheck = silentRewrite("Here, we investigated the role.", lex).text;
assert(voiceCheck.includes("Here, we"), `Voice: 'Here, we' preserved (got "${voiceCheck}")`);

// --- N1 (article agreement): noun replacement rebuilds the article ---
assert(
  silentRewrite("An detailed mechanism.", lex).text.startsWith("A detailed"),
  "N1: 'An detailed' → 'A detailed'",
);
assert(
  !/\bA intricate\b/.test(silentRewrite("A intricate network.", lex).text),
  "N1: 'A intricate' never reaches the output (intricate→detailed or removed)",
);

// --- N2 (noun ordering): compound matches before subword ---
assert(
  silentRewrite("We explored the multifaceted role.", lex).text.includes("explored the role") &&
  !silentRewrite("We explored the multifaceted role.", lex).text.includes("multiple role"),
  "N2: 'multifaceted role' → 'role', not 'multiple role'",
);
assert(
  silentRewrite("The intricate network shows X.", lex).text.includes("The network"),
  "N2: 'intricate network' → 'network', not 'detailed network'",
);

// --- N3 (self-promotion openers wired into opener removal) ---
assert(
  !silentRewrite("For the first time, we show that X is expressed.", lex).text.includes("For the first time"),
  "N3: 'For the first time' removed",
);
assert(
  !silentRewrite("To our knowledge, this is novel.", lex).text.includes("To our knowledge"),
  "N3: 'To our knowledge' removed",
);

// --- Domain-term mappings loaded from YAML ---
assert(
  lex.domain.domainTermMappings.length >= 3,
  `Domain-term mappings loaded (got ${lex.domain.domainTermMappings.length})`,
);

// --- ARRIVE essentials expanded ---
const arrive = lex.reportingStandards.arrive2Essentials.missingInMethodsIfAbsent;
assert(arrive.length >= 8, `ARRIVE essentials ≥8 (got ${arrive.length})`);
assert(
  arrive.some((s) => /randomisation/i.test(s)),
  "ARRIVE essentials: Randomisation present",
);
assert(
  arrive.some((s) => /blinding/i.test(s)),
  "ARRIVE essentials: Blinding present",
);

// --- MARCM citation is the primary paper ---
const tools = lex.domain.standardToolsFullMention;
assert(
  tools.some((t) => /Lee and Luo,?\s*1999/i.test(t)),
  "MARCM citation is Lee & Luo 1999 (primary), not 2001 (review)",
);

console.log("\nAll tests passed.");

// =====================================================================
// v0.4 — MODULE 1 tests: sloppy detector + claim strength
// =====================================================================

// --- /bio-sloppy detects vague quantifiers ---
const sloppy1 = "We observed several phenotypes in a few flies.";
const sloppyHits = detectSloppy(sloppy1, lex);
assert(sloppyHits.length >= 2, `Sloppy: vague quantifiers detected (got ${sloppyHits.length} hits)`);
assert(sloppyHits.some((h) => h.category === "vague_quantifier"), "Sloppy: vague_quantifier category present");

// --- /bio-sloppy detects causal overclaim ---
const sloppy2 = "Taranis causes neuroblast specification.";
const sloppyHits2 = detectSloppy(sloppy2, lex);
assert(sloppyHits2.some((h) => h.category === "causal_overclaim"), "Sloppy: causal overclaim detected");

// --- claim_strength_check flags overclaim ---
const overclaim = "We demonstrate that tara mutants reduce neuroblast numbers (n=3, p<0.05).";
const overclaimResult = checkClaimStrength(overclaim, lex);
assert(overclaimResult.grade === "preliminary", `Claim: small n → preliminary (got ${overclaimResult.grade})`);
assert(overclaimResult.verdict === "overclaim", `Claim: 'demonstrate' with n=3 → overclaim (got ${overclaimResult.verdict})`);

// --- claim_strength_check OK for strong data ---
const strong = "We show reduced neuroblast numbers (n=30 per group, 3 biological replicates, p<0.001, Cohen's d=1.2, 95% CI [1.5, 2.8]).";
const strongResult = checkClaimStrength(strong, lex);
assert(strongResult.grade === "strong_observation", `Claim: strong data → strong_observation (got ${strongResult.grade})`);
assert(strongResult.verdict === "ok", `Claim: 'show' with strong data → ok (got ${strongResult.verdict})`);

// --- claim_strength_check flags underclaim ---
const underclaim = "We might suggest that tara is required for neuroblasts (n=50, 3 biological replicates, p<0.001, Cohen's d=1.5, 95% CI [1.0, 2.0]).";
const underclaimResult = checkClaimStrength(underclaim, lex);
assert(underclaimResult.verdict === "underclaim", `Claim: 'might suggest' with strong data → underclaim (got ${underclaimResult.verdict})`);

// --- B1 fix: correlation_causation bare-verb matching ---
const cc = detectSloppy("Tara regulates neuroblast numbers.", lex);
assert(cc.some((h) => h.category === "correlation_causation"), `B1: 'regulates' flagged as correlation_causation (got ${JSON.stringify(cc.map((h) => h.category))})`);

// --- N3: p=0.013 edge case ---
const p013 = checkClaimStrength("We observed X (n=5, p=0.013).", lex);
assert(p013.detectedP === 0.013, `p=0.013 extracts correctly, not 0.13 (got ${p013.detectedP})`);

// --- v0.4: new openers removed ---
assert(
  !silentRewrite("In recent years, the field has advanced.", lex).text.includes("In recent years"),
  "v0.4: 'In recent years' opener removed",
);
assert(
  !silentRewrite("With the advent of CRISPR, we can now...", lex).text.includes("With the advent of"),
  "v0.4: 'With the advent of' opener removed",
);

// --- v0.4: 'plays a major role' rewritten ---
assert(
  silentRewrite("X plays a major role in Y.", lex).text.includes("is required for"),
  "v0.4: 'plays a major role in' → 'is required for'",
);

// --- v0.4: 'has been shown to' removed ---
const hbst = silentRewrite("Tara has been shown to regulate neuroblasts.", lex).text;
assert(!hbst.includes("has been shown to"), `v0.4: 'has been shown to' removed (got "${hbst}")`);

// --- v0.4: sloppy patterns loaded from YAML ---
assert(lex.sloppyPatterns.vagueQuantifiers.length >= 5, `Sloppy: vagueQuantifiers loaded (got ${lex.sloppyPatterns.vagueQuantifiers.length})`);
assert(lex.claimStrength.grades && Object.keys(lex.claimStrength.grades).length >= 4, `Claim: grades loaded (got ${Object.keys(lex.claimStrength.grades).length})`);
