// src/statistical-ai-detector.ts
// Statistical AI text detection calibrated for SHORT scientific paragraphs
// (100-300 words, 5-10 sentences). Previous baselines were calibrated on
// 500-2000 word blog/essay texts where CV, TTR, entropy etc. behaved
// differently. For short scientific text:
//   - CV is naturally lower (fewer sentences → less variance opportunity)
//   - TTR is naturally higher (short samples have high type/token ratio)
//   - Bigram entropy is higher in short text (fewer repeated bigrams)
//   - Sentence starters are always diverse in N=5-10 sentences
//   - Function word ratio is higher in scientific text (passive voice, etc.)
//
// Length-adaptive: the detector now counts words and adjusts formulas.
// Under 100 words: only lexicon_tells fires reliably → heavy weight.
// 100-300 words: all features fire with appropriate scientific baselines.
// 300+ words: original baselines apply (blog-style calibration).
//
// Each feature returns a 0-1 score (0=human, 1=AI). Weighted sum → final score.
// Weighted sum → final score.

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

// === Feature 3: Lexical diversity (type-token ratio) ===
// Scientific text has HIGH TTR at short length because vocabulary is dense.
// Human scientific TTR (100-300 words): ~0.70-0.85
// AI scientific TTR (100-300 words):     ~0.55-0.70
// We use modified TTR to correct for text length: sqrt(N)*TTR is more stable
// but for our purposes we just raise the human baseline for short text.
function measureLexicalDiversity(text: string, wordCount: number): StatisticalFeature {
  const words = text.toLowerCase().replace(/[^a-z\s]/g, "").split(/\s+/).filter((w) => w.length > 1);
  if (words.length < 20) {
    return { name: "lexical_diversity", score: 0.5, rawValue: 0, humanBaseline: 0.70, aiBaseline: 0.50, description: "insufficient words" };
  }
  const types = new Set(words);
  const ttr = types.size / words.length;

  let humanBl: number, aiBl: number, score: number;
  if (wordCount < 300) {
    // Scientific short text: TTR is higher because of technical vocabulary
    // AND because shorter samples have naturally higher type/token ratio.
    humanBl = 0.78;
    aiBl = 0.58;
    score = Math.max(0, Math.min(1, (0.78 - ttr) / 0.22));
  } else {
    // Long text: original calibration
    humanBl = 0.60;
    aiBl = 0.40;
    score = Math.max(0, Math.min(1, (0.60 - ttr) / 0.25));
  }
  return { name: "lexical_diversity", score, rawValue: ttr, humanBaseline: humanBl, aiBaseline: aiBl, description: `TTR=${ttr.toFixed(3)} (human≈${humanBl}, AI≈${aiBl})` };
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
// Scientific text has HIGHER function word ratio for both human and AI
// (passive voice, complex sentences, articles). Adjust baselines up.
//
// Scientific text: human ≈ 0.35, AI ≈ 0.42
// General text:    human ≈ 0.25, AI ≈ 0.35
const AI_OVERUSED_FUNCTION_WORDS = ["the", "of", "and", "to", "a", "in", "is", "it", "that", "for", "on", "with", "as", "by", "this", "we", "are", "be", "was", "were"];
function measureFunctionWords(text: string, wordCount: number): StatisticalFeature {
  const words = text.toLowerCase().replace(/[^a-z\s]/g, "").split(/\s+/).filter((w) => w.length > 0);
  if (words.length < 20) return { name: "function_words", score: 0.5, rawValue: 0, humanBaseline: 0.35, aiBaseline: 0.42, description: "insufficient words" };
  const funcCount = words.filter((w) => AI_OVERUSED_FUNCTION_WORDS.includes(w)).length;
  const ratio = funcCount / words.length;

  let humanBl: number, aiBl: number, score: number;
  if (wordCount < 300) {
    // Scientific text: more function words overall
    humanBl = 0.35;
    aiBl = 0.42;
    score = Math.max(0, Math.min(1, (ratio - 0.35) / 0.08));
  } else {
    // General text
    humanBl = 0.25;
    aiBl = 0.35;
    score = Math.max(0, Math.min(1, (ratio - 0.25) / 0.12));
  }
  return { name: "function_words", score, rawValue: ratio, humanBaseline: humanBl, aiBaseline: aiBl, description: `function word ratio=${(ratio * 100).toFixed(1)}% (human≈${humanBl}, AI≈${aiBl})` };
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
// AI uses slightly longer words on average than humans in scientific context.
// For BOTH short and long scientific text, this works with the original
// calibration since word length distribution is relatively stable.
function measureLexicalSophistication(text: string): StatisticalFeature {
  const words = text.replace(/[^a-zA-Z\s]/g, "").split(/\s+/).filter((w) => w.length > 2);
  if (words.length < 20) return { name: "lexical_sophistication", score: 0.5, rawValue: 0, humanBaseline: 6.0, aiBaseline: 7.0, description: "insufficient words" };
  const avgLen = words.reduce((sum, w) => sum + w.length, 0) / words.length;
  // Scientific text: human avg word length ≈ 6.0, AI ≈ 7.0
  const score = Math.max(0, Math.min(1, (avgLen - 6.0) / 1.2));
  return { name: "lexical_sophistication", score, rawValue: avgLen, humanBaseline: 6.0, aiBaseline: 7.0, description: `avg word length=${avgLen.toFixed(1)} (human_sci≈6.0, AI_sci≈7.0)` };
}

// === Combined detection (statistical + lexicon) ===
// Revised weights for scientific text:
//   - lexicon_tells increased to 0.55 (the single most reliable feature
//     for short scientific paragraphs — directly catches AI-tell words)
//   - burstiness at 0.10 (works but less discriminating in short text)
//   - ngram_entropy at 0.05 (higher entropy in short text masks differences)
//   - lexical_diversity at 0.08 (TTR is higher in short text, reduces signal)
//   - punctuation reduced to 0.03 (em-dashes/semicolons are rare in sci text)
//   - function_words at 0.08 (now works with short-text calibration)
//   - starter_diversity reduced to 0.04 (neutral for short text)
//   - lexical_sophistication at 0.07 (stable signal)
const WEIGHTS: Record<string, number> = {
  burstiness: 0.10,
  ngram_entropy: 0.05,
  lexical_diversity: 0.08,
  punctuation: 0.03,
  function_words: 0.08,
  starter_diversity: 0.04,
  lexical_sophistication: 0.07,
  lexicon_tells: 0.55,  // up from 0.45
};

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

  // Add lexicon-based score as a feature
  const lexScore = scoreText(text, lex);
  const lexiconScore = Math.max(0, Math.min(1, lexScore.total / 10));
  features.push({
    name: "lexicon_tells",
    score: lexiconScore,
    rawValue: lexScore.total,
    humanBaseline: 0,
    aiBaseline: 5,
    description: `AI-tell hits: ${lexScore.total} (${lexScore.verdict})`,
  });

  // Weighted sum
  let finalScore = 0;
  for (const f of features) {
    finalScore += f.score * (WEIGHTS[f.name] ?? 0);
  }
  finalScore = Math.round(finalScore * 100);

  const threshold = 40;
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
