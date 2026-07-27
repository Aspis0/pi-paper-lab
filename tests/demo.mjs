// tests/demo.mjs
// Demo: run the silent rewrite on AI-tell prose and print before/after.

import { loadLexicon, silentRewrite, scoreText } from "../src/anti-ai-lexicon.ts";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const lex = loadLexicon(ROOT);

const AI_PROSE = `It is important to note that our study delves into the genetic landscape of Drosophila neural development. We leverage state-of-the-art CRISPR technology to shed light on the complex interplay between Gal4 drivers and neural stem cells. Crucially, our findings may potentially navigate the underlying mechanisms. We further explore the multifaceted role of notable transcription factors, fundamentally advancing our understanding. The intricate network of interactions was uncovered through our novel approach.`;

const HUMAN_PROSE = `We crossed y[1] w[1118]; +; P{GAL4}attP2 females to balancer males and aged the progeny at 25 degrees C. Third-instar larvae (n=24 per genotype, 3 biological replicates) were dissected and stained with anti-FasII antibody. We measured axon diameter from confocal z-stacks (Fiji). Statistical comparisons used Mann-Whitney U tests with Bonferroni-Holm correction (alpha=0.05). Effect sizes are reported as Hedges' g with 95% CI [-3.2, 0.1]. As shown in Figure 1A, mutation of taranis reduces axon crossing (p<0.001, Mann-Whitney). We did not observe a phenotype in heterozygous siblings.`;

console.log("=== AI prose BEFORE ===");
console.log(AI_PROSE);
console.log("\n=== AI score ===");
const aiScore = scoreText(AI_PROSE, lex);
console.log(`Total: ${aiScore.total.toFixed(2)} | Verdict: ${aiScore.verdict}`);
console.log("Hits:", aiScore.hits.map((h) => `[${h.weight} ${h.category}] ${h.hit}`).join(", "));

console.log("\n=== AI prose AFTER (silent rewrite) ===");
const { text: rewritten, stats } = silentRewrite(AI_PROSE, lex);
console.log(rewritten);
console.log(`\nStats: connectors=${stats.connectors}, fillers=${stats.fillers}, verbs=${stats.verbs}, unresolved=${stats.flaggedVerbs.join(", ") || "(none)"}`);

const aiScoreAfter = scoreText(rewritten, lex);
console.log(`Score after rewrite: ${aiScoreAfter.total.toFixed(2)} | Verdict: ${aiScoreAfter.verdict}`);

console.log("\n=== Human prose ===");
console.log(HUMAN_PROSE);
const humScore = scoreText(HUMAN_PROSE, lex);
console.log(`Total: ${humScore.total.toFixed(2)} | Verdict: ${humScore.verdict}`);
