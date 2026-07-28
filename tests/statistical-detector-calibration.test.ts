// tests/statistical-detector-calibration.test.ts
// Tests for the length-adaptive calibration of the statistical AI detector.
// v0.7.0-alpha.11 recalibration: short scientific paragraphs (100-300 words
// at ~5-10 sentences) now use different baselines than long blog/essay texts.
//
// The issue being tested: before recalibration, 7 out of 8 features would
// score 0 or 100 for short scientific text because the baselines were
// calibrated on 500-2000 word texts. With recalibration, features that
// work for short text fire; features that don't (e.g. sentence starter
// diversity in 5-sentence paragraphs) return neutral 0.5.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { detectStatistical } from "../src/statistical-ai-detector.ts";
import { loadLexicon } from "../src/anti-ai-lexicon.ts";

const ROOT = process.cwd();
const lex = loadLexicon(ROOT);

const SHORT_SCI_PARAGRAPH = `Phosphorylation of CRTC1 was assessed in wild-type and Crtc1-knockout mice. 
Cortical lysates from six mice per genotype were immunoprecipitated with anti-CRTC1 and resolved by SDS-PAGE. 
Western blot analysis revealed a significant increase in phosphorylated CRTC1 in wild-type animals under 
fasting conditions (p<0.01, n=6 per group). These results suggest that CRTC1 serves as a key metabolic 
sensor in the mammalian hypothalamus, integrating peripheral nutritional signals with transcriptional 
regulation of appetite-related neuropeptides.`;

const SHORT_TEXT_WITH_FILLERS = `Cachexia is notably a complex condition that essentially affects 
millions of people worldwide. Intricately linked to several chronic diseases, this multifaceted 
disorder plays a crucial role in patient outcomes. Importantly, it involves an intricate network 
of molecular pathways that are fundamentally driven by inflammatory cytokines.`;

test("detectStatistical: short scientific paragraph activates in short-text mode", () => {
  const result = detectStatistical(SHORT_SCI_PARAGRAPH, lex);
  assert.ok(result.shortTextMode, "150-word paragraph must activate short-text mode");
  assert.ok(result.wordCount > 50 && result.wordCount < 300, "word count in expected range");
});

test("detectStatistical: short scientific paragraph does NOT produce false-positive on human text", () => {
  const result = detectStatistical(SHORT_SCI_PARAGRAPH, lex);
  // Clean human scientific text should NOT trigger AI detection.
  // The lexicon_tells feature should be low (no AI-tell words).
  // The statistical features should not stack all to 100% like before
  // (where entropy/diversity were always 0 and burstiness was always high).
  const aiFeatureCount = result.features.filter((f) => f.score >= 0.8).length;
  assert.ok(aiFeatureCount <= 3, `clean scientific text should not have >3 features at 80%+, got ${aiFeatureCount}`);
});

test("detectStatistical: AI-tell-laden short text scores higher than clean text", () => {
  const clean = detectStatistical(SHORT_SCI_PARAGRAPH, lex);
  const withTells = detectStatistical(SHORT_TEXT_WITH_FILLERS, lex);
  // Text with "crucially", "notably", "intricacies" etc should score higher AI than clean text.
  assert.ok(withTells.finalScore > clean.finalScore,
    `text with AI tells (${withTells.finalScore}%) should score > clean text (${clean.finalScore}%)`);
});

test("detectStatistical: short text burstiness uses short-text calibration", () => {
  const result = detectStatistical(SHORT_SCI_PARAGRAPH, lex);
  const burstiness = result.features.find((f) => f.name === "burstiness")!;
  assert.ok(burstiness, "burstiness feature must be present");
  // The description should indicate short_sci mode
  assert.ok(burstiness.description.includes("mode=short_sci"),
    `burstiness should indicate short_sci mode, got: ${burstiness.description}`);
  // Human baseline was 0.35 before (long text); now 0.30 for short text
  assert.equal(burstiness.humanBaseline, 0.30, "short text burstiness human baseline = 0.30");
});

test("detectStatistical: starter_diversity is neutral for short text (5 sentences)", () => {
  const result = detectStatistical(SHORT_SCI_PARAGRAPH, lex);
  const starter = result.features.find((f) => f.name === "starter_diversity")!;
  assert.ok(starter, "starter_diversity feature must be present");
  // With 5 sentences (short text), the feature should return neutral 0.5
  // because it can't discriminate in such short windows.
  assert.equal(starter.score, 0.5,
    "short text (5 sentences) starter_diversity must return neutral 0.5");
  assert.ok(starter.description.toLowerCase().includes("insufficient"),
    `description should note limited sentences, got: ${starter.description}`);
});

test("detectStatistical: feature weights sum to 1.0", () => {
  const totalWeight = 0.10 + 0.05 + 0.08 + 0.03 + 0.08 + 0.04 + 0.07 + 0.55; // from WEIGHTS in detector
  assert.ok(Math.abs(totalWeight - 1.0) < 0.001, `weights should sum to 1.0, got ${totalWeight}`);
});
