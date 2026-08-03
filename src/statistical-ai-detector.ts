// src/statistical-ai-detector.ts
// Statistical AI text detection for scientific prose (paragraphs and full papers).
//
// 2026-08 calibration against 24 pre-ChatGPT OA scientific papers (2018–2020):
//   - Raw TTR fell mechanically with length (3191w → TTR 0.227 → 100% AI-like),
//     so lexical diversity now uses MATTR (window 100), which is length-stable
//     (human sci MATTR100 mean 0.688, range 0.642–0.748 on that corpus).
//   - Lexicon component uses density per 1000 words, not absolute hit counts
//     (absolute counts saturated the 0.55-weight feature on every long human paper).
//   - Function-word and sophistication baselines are scientific (not blog/essay):
//     human sci FW mean 0.295; avg word length mean 6.30 on the same corpus.
//
// Each feature returns a 0-1 score (0=human, 1=AI). Weighted sum → final score.

import { scoreText, type Lexicon } from "./anti-ai-lexicon.ts";

export interface StatisticalFeature {
  name: string;
  score: number;        // 0-1, 1=AI-like
  rawValue: number;     // the actual measured value
  humanBaseline: number;
  aiBaseline: number;
  description: string;
}

export interface StatisticalDetectionResult {
  features: StatisticalFeature[];
  finalScore: number;   // 0-100
  isAI: boolean;
  threshold: number;
  topReasons: string[];
  wordCount: number;    // total word count (for length-adaptive reporting)
  shortTextMode: boolean; // true when < 300 words (scientific paragraphs)
}

function getWordCount(text: string): number {
  return text.split(/\s+/).filter((w) => w.length > 1).length;
}

// === Feature 1: Burstiness (sentence length variance) ===
// Human text: high variance in sentence length (bursty). AI: uniform.
// Measured as coefficient of variation (CV = std/mean) of sentence word counts.
//
// Scientific paragraphs (short, N<300):
//   Human CV ≈ 0.22-0.40 | AI CV ≈ 0.12-0.22
//   (lower than long text because 5-10 sentences have less opportunity for variance)
// Long text (N≥300):
//   Human CV ≈ 0.35-0.50 | AI CV ≈ 0.10-0.20 (original blog/essay baseline)
function measureBurstiness(text: string, wordCount: number): StatisticalFeature {
  const sentences = text.split(/(?<=[.!?])\s+/).filter((s) => s.trim().length > 10);
  if (sentences.length < 3) {
    return { name: "burstiness", score: 0.5, rawValue: 0, humanBaseline: 0.30, aiBaseline: 0.17, description: "insufficient sentences" };
  }
  const wordCounts = sentences.map((s) => s.split(/\s+/).length);
  const mean = wordCounts.reduce((a, b) => a + b, 0) / wordCounts.length;
  const variance = wordCounts.reduce((a, b) => a + (b - mean) ** 2, 0) / wordCounts.length;
  const std = Math.sqrt(variance);
  const cv = mean > 0 ? std / mean : 0;

  let humanBl: number, aiBl: number, score: number;
  if (wordCount < 300) {
    // Scientific paragraph calibration
    humanBl = 0.30;
    aiBl = 0.17;
    // Linear map: cv=0.30 → 0.0 (human), cv=0.17 → 1.0 (AI)
    score = Math.max(0, Math.min(1, (0.30 - cv) / 0.15));
  } else {
    // Long text (blog/essay) calibration
    humanBl = 0.40;
    aiBl = 0.15;
    score = Math.max(0, Math.min(1, (0.40 - cv) / 0.30));
  }
  const mode = wordCount < 300 ? "short_sci" : "long";
  return { name: "burstiness", score, rawValue: cv, humanBaseline: humanBl, aiBaseline: aiBl, description: `CV=${cv.toFixed(2)} (mode=${mode}, human≈${humanBl}, AI≈${aiBl})` };
}

// === Feature 2: Perplexity proxy (n-gram predictability) ===
// True perplexity requires an LM. We approximate using bigram entropy.
// AI text has lower entropy = more predictable word sequences.
//
// Short text (N<300 words): bigram entropy is naturally higher because
// most bigrams are unique. Human ~6.5, AI ~4.5.
// Long text (N≥300): original calibration. Human ~5.5, AI ~3.5.
function measureNgramEntropy(text: string, wordCount: number): StatisticalFeature {
  const words = text.toLowerCase().replace(/[^a-z\s]/g, "").split(/\s+/).filter((w) => w.length > 1);
  if (words.length < 20) {
    return { name: "ngram_entropy", score: 0.5, rawValue: 0, humanBaseline: 5.0, aiBaseline: 3.0, description: "insufficient words" };
  }
  // Build bigram frequency table
  const bigrams: Record<string, number> = {};
  for (let i = 0; i < words.length - 1; i++) {
    const bg = `${words[i]} ${words[i + 1]}`;
    bigrams[bg] = (bigrams[bg] ?? 0) + 1;
  }
  // Shannon entropy of bigram distribution
  const total = Object.values(bigrams).reduce((a, b) => a + b, 0);
  let entropy = 0;
  for (const count of Object.values(bigrams)) {
    const p = count / total;
    if (p > 0) entropy -= p * Math.log2(p);
  }

  let humanBl: number, aiBl: number, score: number;
  if (wordCount < 300) {
    // Short text: entropy is naturally higher
    humanBl = 6.5;
    aiBl = 4.5;
    score = Math.max(0, Math.min(1, (6.5 - entropy) / 2.5));
  } else {
    // Long text: original calibration
    humanBl = 5.5;
    aiBl = 3.5;
    score = Math.max(0, Math.min(1, (5.5 - entropy) / 2.5));
  }
  return { name: "ngram_entropy", score, rawValue: entropy, humanBaseline: humanBl, aiBaseline: aiBl, description: `entropy=${entropy.toFixed(2)} bits (human≈${humanBl}, AI≈${aiBl})` };
}

// === Feature 3: Lexical diversity (MATTR, not raw TTR) ===
// Raw type-token ratio falls with length (Zipf): on the 24-paper pre-ChatGPT
// corpus, TTR ranged 0.227 (3191w) → 0.401 (580w) and correlated with score
// (r≈−0.37 with TTR, r≈+0.55 length→score). It was a length proxy.
//
// MATTR (Moving-Average TTR, window W=100): mean TTR over successive windows.
// Same corpus: MATTR100 mean 0.688, min 0.642, max 0.748 — nearly length-flat.
// Chose MATTR over MTLD because it is simpler, fully local, and the window
// mean is stable enough for a 0–1 feature without factor-threshold tuning.
//
// Human baseline 0.69 ≈ corpus mean. AI baseline 0.55 is a conservative
// lower band for repetitive LLM prose under the same window (literature and
// adversarial probes with formulaic openers sit well below 0.60).
// Window 100: standard MATTR default; short texts (<100 tokens) fall back to TTR.
export const MATTR_WINDOW = 100;
// Measured: human sci MATTR100 mean ≈ 0.688 on 24 pre-ChatGPT OA papers.
export const MATTR_HUMAN_BASELINE = 0.69;
// Below this → fully AI-like on this feature. Room under human min (0.642).
export const MATTR_AI_BASELINE = 0.55;

/**
 * Moving-average type-token ratio over a fixed window (default 100 tokens).
 * Pure exported helper — no framework tests in this package; keep it small.
 */
export function measureMattr(words: string[], windowSize: number = MATTR_WINDOW): number {
  if (words.length === 0) return 0;
  if (words.length < windowSize) {
    return new Set(words).size / words.length;
  }
  let sum = 0;
  let n = 0;
  for (let i = 0; i + windowSize <= words.length; i++) {
    // Window TTR; Set per window is fine for paper-scale N (few thousand tokens).
    sum += new Set(words.slice(i, i + windowSize)).size / windowSize;
    n++;
  }
  return n > 0 ? sum / n : 0;
}

function measureLexicalDiversity(text: string, _wordCount: number): StatisticalFeature {
  const words = text.toLowerCase().replace(/[^a-z\s]/g, "").split(/\s+/).filter((w) => w.length > 1);
  if (words.length < 20) {
    return {
      name: "lexical_diversity",
      score: 0.5,
      rawValue: 0,
      humanBaseline: MATTR_HUMAN_BASELINE,
      aiBaseline: MATTR_AI_BASELINE,
      description: "insufficient words",
    };
  }
  const mattr = measureMattr(words, MATTR_WINDOW);
  const humanBl = MATTR_HUMAN_BASELINE;
  const aiBl = MATTR_AI_BASELINE;
  // Higher MATTR → more human. Map humanBl→0, aiBl→1.
  const span = humanBl - aiBl; // 0.14
  const score = Math.max(0, Math.min(1, (humanBl - mattr) / span));
  return {
    name: "lexical_diversity",
    score,
    rawValue: mattr,
    humanBaseline: humanBl,
    aiBaseline: aiBl,
    description: `MATTR${MATTR_WINDOW}=${mattr.toFixed(3)} (human≈${humanBl}, AI≈${aiBl})`,
  };
}

// === Feature 4: Punctuation analysis (em-dash, semicolons) ===
// AI overuses em-dashes (—) and semicolons (;). But in scientific text,
// these are RARELY used even by AI. This feature is less discriminating
// for scientific text. We lower its weight accordingly.
function measurePunctuation(text: string): StatisticalFeature {
  const charCount = text.length;
  if (charCount < 100) return { name: "punctuation", score: 0, rawValue: 0, humanBaseline: 0.001, aiBaseline: 0.005, description: "too short" };
  const emdashes = (text.match(/—/g) ?? []).length;
  const semicolons = (text.match(/;/g) ?? []).length;
  const ratio = (emdashes + semicolons) / charCount;
  // Keep original thresholds — works for both short and long text when
  // present. The key change is weight reduction (0.10 → 0.03).
  const score = Math.max(0, Math.min(1, ratio / 0.01));
  return { name: "punctuation", score, rawValue: ratio, humanBaseline: 0.002, aiBaseline: 0.008, description: `em-dash+semicolon ratio=${(ratio * 1000).toFixed(1)}‰ (human≈2‰, AI≈8‰)` };
}

// === Feature 5: Function word ratio ===
// AI overuses function words (the, of, and, to, a, in, is, it, that, for).
// This lab scores scientific prose only — blog/essay baselines (human≈0.25)
// falsely flagged every paper. Pre-ChatGPT OA corpus: mean 0.295, range 0.252–0.341.
// Use scientific baselines for all lengths (short paragraphs share the same register).
const AI_OVERUSED_FUNCTION_WORDS = ["the", "of", "and", "to", "a", "in", "is", "it", "that", "for", "on", "with", "as", "by", "this", "we", "are", "be", "was", "were"];
// Measured mean on 24 pre-ChatGPT scientific samples.
export const FW_HUMAN_BASELINE = 0.30;
// Upper AI-like band; human max on corpus was 0.341 so span keeps humans mid-low.
export const FW_AI_BASELINE = 0.40;
function measureFunctionWords(text: string, _wordCount: number): StatisticalFeature {
  const words = text.toLowerCase().replace(/[^a-z\s]/g, "").split(/\s+/).filter((w) => w.length > 0);
  if (words.length < 20) {
    return {
      name: "function_words",
      score: 0.5,
      rawValue: 0,
      humanBaseline: FW_HUMAN_BASELINE,
      aiBaseline: FW_AI_BASELINE,
      description: "insufficient words",
    };
  }
  const funcCount = words.filter((w) => AI_OVERUSED_FUNCTION_WORDS.includes(w)).length;
  const ratio = funcCount / words.length;
  const humanBl = FW_HUMAN_BASELINE;
  const aiBl = FW_AI_BASELINE;
  const score = Math.max(0, Math.min(1, (ratio - humanBl) / (aiBl - humanBl)));
  return {
    name: "function_words",
    score,
    rawValue: ratio,
    humanBaseline: humanBl,
    aiBaseline: aiBl,
    description: `function word ratio=${(ratio * 100).toFixed(1)}% (human_sci≈${humanBl}, AI≈${aiBl})`,
  };
}

// === Feature 6: Sentence starter diversity ===
// AI often starts sentences with the same words (We, The, This, This study).
// For SHORT text (5-10 sentences), BOTH human and AI produce near-100% unique
// starters because N=sentences and the pool of "same-ness" is too small.
// This feature ONLY discriminates when there are enough sentences for
// repetition to emerge (N > 10). For shorter text, return neutral 0.5.
function measureSentenceStarterDiversity(text: string): StatisticalFeature {
  const sentences = text.split(/(?<=[.!?])\s+/).filter((s) => s.trim().length > 10);
  if (sentences.length < 4) {
    return { name: "starter_diversity", score: 0.5, rawValue: 0, humanBaseline: 0.7, aiBaseline: 0.4, description: "insufficient sentences" };
  }

  // For short text (few sentences), this feature cannot discriminate.
  // Both human and AI produce ~100% unique starters in N=5 sentences.
  // Return neutral score and note in description.
  if (sentences.length <= 10) {
    const starters = sentences.map((s) => s.trim().split(/\s+/)[0].toLowerCase());
    const uniqueStarters = new Set(starters);
    const diversity = uniqueStarters.size / starters.length;
    return {
      name: "starter_diversity",
      score: 0.5,
      rawValue: diversity,
      humanBaseline: 0.7,
      aiBaseline: 0.4,
      description: `unique starters=${(diversity * 100).toFixed(0)}% (neutral — only ${sentences.length} sentences, insufficient for discrimination)`,
    };
  }

  const starters = sentences.map((s) => s.trim().split(/\s+/)[0].toLowerCase());
  const uniqueStarters = new Set(starters);
  const diversity = uniqueStarters.size / starters.length;
  // For longer text: human diversity ≈ 0.7-0.9, AI ≈ 0.3-0.5
  const score = Math.max(0, Math.min(1, (0.7 - diversity) / 0.4));
  return { name: "starter_diversity", score, rawValue: diversity, humanBaseline: 0.7, aiBaseline: 0.4, description: `unique starters=${(diversity * 100).toFixed(0)}% (human≈70%, AI≈40%)` };
}

// === Feature 7: Lexical sophistication (avg word length) ===
// Pre-ChatGPT OA corpus: mean avg word length 6.30 (range 5.71–7.01).
// Old human baseline 6.0 treated normal scientific vocabulary as AI-like.
export const SOPH_HUMAN_BASELINE = 6.3;
export const SOPH_AI_BASELINE = 7.3;
function measureLexicalSophistication(text: string): StatisticalFeature {
  const words = text.replace(/[^a-zA-Z\s]/g, "").split(/\s+/).filter((w) => w.length > 2);
  if (words.length < 20) {
    return {
      name: "lexical_sophistication",
      score: 0.5,
      rawValue: 0,
      humanBaseline: SOPH_HUMAN_BASELINE,
      aiBaseline: SOPH_AI_BASELINE,
      description: "insufficient words",
    };
  }
  const avgLen = words.reduce((sum, w) => sum + w.length, 0) / words.length;
  const humanBl = SOPH_HUMAN_BASELINE;
  const aiBl = SOPH_AI_BASELINE;
  const score = Math.max(0, Math.min(1, (avgLen - humanBl) / (aiBl - humanBl)));
  return {
    name: "lexical_sophistication",
    score,
    rawValue: avgLen,
    humanBaseline: humanBl,
    aiBaseline: aiBl,
    description: `avg word length=${avgLen.toFixed(1)} (human_sci≈${humanBl}, AI_sci≈${aiBl})`,
  };
}

// === Combined detection (statistical + lexicon) ===
// Weights unchanged in spirit: lexicon_tells dominates (0.55) because the
// product target is recognisable AI register, not secondary stylometrics.
const WEIGHTS: Record<string, number> = {
  burstiness: 0.10,
  ngram_entropy: 0.05,
  lexical_diversity: 0.08,
  punctuation: 0.03,
  function_words: 0.08,
  starter_diversity: 0.04,
  lexical_sophistication: 0.07,
  lexicon_tells: 0.55,
};

/**
 * Density (weighted hits / 1000 words) at which lexicon_tells saturates to 1.0.
 * Measured after lexicon prune: human papers ≈ 0–2 /1k; stacked adversarial
 * probes (delve/tapestry/em-dashes/formulaic openers) reach 15–40+ /1k.
 * 8 /1k ≈ a few real tells in a short paragraph — full component weight without
 * needing a novel-length document.
 */
export const LEXICON_DENSITY_SATURATION_PER_1K = 8;

export function detectStatistical(text: string, lex: Lexicon): StatisticalDetectionResult {
  const wordCount = getWordCount(text);
  const shortTextMode = wordCount < 300;

  const features: StatisticalFeature[] = [
    measureBurstiness(text, wordCount),
    measureNgramEntropy(text, wordCount),
    measureLexicalDiversity(text, wordCount),
    measurePunctuation(text),
    measureFunctionWords(text, wordCount),
    measureSentenceStarterDiversity(text),
    measureLexicalSophistication(text),
  ];

  // Lexicon feature: density per 1k words (scoreText.total), not absolute counts.
  const lexScore = scoreText(text, lex);
  const lexiconScore = Math.max(
    0,
    Math.min(1, lexScore.total / LEXICON_DENSITY_SATURATION_PER_1K),
  );
  features.push({
    name: "lexicon_tells",
    score: lexiconScore,
    rawValue: lexScore.total,
    humanBaseline: 0,
    // aiBaseline documents the density that maps near 1.0 under saturation.
    aiBaseline: LEXICON_DENSITY_SATURATION_PER_1K,
    description: `AI-tell density=${lexScore.total.toFixed(1)}/1k (${lexScore.hits.length} hits, rawWeight=${lexScore.rawWeight.toFixed(1)}, ${lexScore.verdict})`,
  });

  // Weighted sum
  let finalScore = 0;
  for (const f of features) {
    finalScore += f.score * (WEIGHTS[f.name] ?? 0);
  }
  finalScore = Math.round(finalScore * 100);

  // Calibrated against 24 open-access 2018-2020 (pre-ChatGPT, therefore human)
  // scientific papers: human median 6, human max 34, only 1 of 24 above 30,
  // while human prose with AI tells injected scores 60-69. 30 sits in the empty
  // band between the two. Must match DEFAULT_THRESHOLD in ai-detector.ts.
  const threshold = 30;
  const isAI = finalScore > threshold;

  // Top reasons (features with highest score)
  const topReasons = features
    .filter((f) => f.score > 0.3)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((f) => `${f.name}: ${f.description} (score: ${(f.score * 100).toFixed(0)}%)`);

  return { features, finalScore, isAI, threshold, topReasons, wordCount, shortTextMode };
}

export function formatStatisticalReport(r: StatisticalDetectionResult): string {
  const lines: string[] = [];
  const modeLabel = r.shortTextMode ? "short scientific text" : "long text";
  lines.push(`=== Statistical AI Detection (${modeLabel}, ${r.wordCount} words) ===`);
  lines.push(`Final score: ${r.finalScore}% (threshold: ${r.threshold}%)`);
  lines.push(`Verdict: ${r.isAI ? "⚠️ AI-generated" : "✅ Human-like"}`);
  lines.push(``);
  lines.push(`Features:`);
  for (const f of r.features) {
    const bar = "█".repeat(Math.round(f.score * 10)).padEnd(10, "░");
    lines.push(`  ${f.name.padEnd(22)} ${bar} ${(f.score * 100).toFixed(0)}%  ${f.description}`);
  }
  if (r.topReasons.length > 0) {
    lines.push(``);
    lines.push(`Top AI signals:`);
    for (const reason of r.topReasons) lines.push(`  • ${reason}`);
  }
  return lines.join("\n");
}
