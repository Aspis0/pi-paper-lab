// src/statistical-ai-detector.ts
// Statistical AI text detection based on peer-reviewed features.
// Pure TypeScript, no ML models, no GPU, no external API.
// Features derived from: GPTZero (burstiness/perplexity), Binoculars (ratio),
// nlp-ai-detector (linguistic features), and survey papers (Wu et al. 2025).
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
}

// === Feature 1: Burstiness (sentence length variance) ===
// Human text: high variance in sentence length (bursty). AI: uniform.
// Measured as coefficient of variation (CV = std/mean) of sentence word counts.
function measureBurstiness(text: string): StatisticalFeature {
  const sentences = text.split(/(?<=[.!?])\s+/).filter((s) => s.trim().length > 10);
  if (sentences.length < 3) {
    return { name: "burstiness", score: 0.5, rawValue: 0, humanBaseline: 0.6, aiBaseline: 0.2, description: "insufficient sentences" };
  }
  const wordCounts = sentences.map((s) => s.split(/\s+/).length);
  const mean = wordCounts.reduce((a, b) => a + b, 0) / wordCounts.length;
  const variance = wordCounts.reduce((a, b) => a + (b - mean) ** 2, 0) / wordCounts.length;
  const std = Math.sqrt(variance);
  const cv = mean > 0 ? std / mean : 0;
  // Human CV ≈ 0.35-0.5, AI CV ≈ 0.10-0.20 in scientific text
  const score = Math.max(0, Math.min(1, (0.35 - cv) / 0.25));
  return { name: "burstiness", score, rawValue: cv, humanBaseline: 0.35, aiBaseline: 0.15, description: `CV=${cv.toFixed(2)} (human_sci≈0.35, AI_sci≈0.15)` };
}

// === Feature 2: Perplexity proxy (n-gram predictability) ===
// True perplexity requires an LM. We approximate using bigram/trigram entropy.
// AI text has lower entropy = more predictable word sequences.
function measureNgramEntropy(text: string): StatisticalFeature {
  const words = text.toLowerCase().replace(/[^a-z\s]/g, "").split(/\s+/).filter((w) => w.length > 1);
  if (words.length < 20) {
    return { name: "ngram_entropy", score: 0.5, rawValue: 0, humanBaseline: 4.0, aiBaseline: 2.0, description: "insufficient words" };
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
    entropy -= p * Math.log2(p);
  }
  // Normalize: human bigram entropy ≈ 5-7, AI ≈ 3-4
  const score = Math.max(0, Math.min(1, (5.0 - entropy) / 3.0));
  return { name: "ngram_entropy", score, rawValue: entropy, humanBaseline: 5.5, aiBaseline: 3.5, description: `entropy=${entropy.toFixed(2)} bits (human≈5.5, AI≈3.5)` };
}

// === Feature 3: Lexical diversity (type-token ratio) ===
// Human text uses more diverse vocabulary. AI repeats words more.
function measureLexicalDiversity(text: string): StatisticalFeature {
  const words = text.toLowerCase().replace(/[^a-z\s]/g, "").split(/\s+/).filter((w) => w.length > 1);
  if (words.length < 20) {
    return { name: "lexical_diversity", score: 0.5, rawValue: 0, humanBaseline: 0.6, aiBaseline: 0.4, description: "insufficient words" };
  }
  const types = new Set(words);
  const ttr = types.size / words.length;
  // Human TTR ≈ 0.55-0.70, AI TTR ≈ 0.35-0.50
  const score = Math.max(0, Math.min(1, (0.6 - ttr) / 0.3));
  return { name: "lexical_diversity", score, rawValue: ttr, humanBaseline: 0.6, aiBaseline: 0.4, description: `TTR=${ttr.toFixed(2)} (human≈0.6, AI≈0.4)` };
}

// === Feature 4: Punctuation analysis (em-dash, semicolons) ===
// AI overuses em-dashes (—) and semicolons (;). Humans rarely use them.
function measurePunctuation(text: string): StatisticalFeature {
  const charCount = text.length;
  if (charCount < 100) return { name: "punctuation", score: 0, rawValue: 0, humanBaseline: 0.001, aiBaseline: 0.005, description: "too short" };
  const emdashes = (text.match(/—/g) ?? []).length;
  const semicolons = (text.match(/;/g) ?? []).length;
  const ratio = (emdashes + semicolons) / charCount;
  // Human ratio ≈ 0.001-0.003, AI ≈ 0.005-0.015
  const score = Math.max(0, Math.min(1, ratio / 0.01));
  return { name: "punctuation", score, rawValue: ratio, humanBaseline: 0.002, aiBaseline: 0.008, description: `em-dash+semicolon ratio=${(ratio * 1000).toFixed(1)}‰ (human≈2‰, AI≈8‰)` };
}

// === Feature 5: Function word ratio ===
// AI overuses function words (the, of, and, to, a, in, is, it, that, for).
const AI_OVERUSED_FUNCTION_WORDS = ["the", "of", "and", "to", "a", "in", "is", "it", "that", "for", "on", "with", "as", "by", "this", "we", "are", "be", "was", "were"];
function measureFunctionWords(text: string): StatisticalFeature {
  const words = text.toLowerCase().replace(/[^a-z\s]/g, "").split(/\s+/).filter((w) => w.length > 0);
  if (words.length < 20) return { name: "function_words", score: 0.5, rawValue: 0, humanBaseline: 0.40, aiBaseline: 0.50, description: "insufficient words" };
  const funcCount = words.filter((w) => AI_OVERUSED_FUNCTION_WORDS.includes(w)).length;
  const ratio = funcCount / words.length;
  // Human ratio ≈ 0.25, AI ≈ 0.35 in scientific text
  const score = Math.max(0, Math.min(1, (ratio - 0.25) / 0.12));
  return { name: "function_words", score, rawValue: ratio, humanBaseline: 0.25, aiBaseline: 0.35, description: `function word ratio=${(ratio * 100).toFixed(1)}% (human_sci≈25%, AI_sci≈35%)` };
}

// === Feature 6: Sentence starter diversity ===
// AI often starts sentences with the same words (We, The, This, This study).
function measureSentenceStarterDiversity(text: string): StatisticalFeature {
  const sentences = text.split(/(?<=[.!?])\s+/).filter((s) => s.trim().length > 10);
  if (sentences.length < 4) return { name: "starter_diversity", score: 0.5, rawValue: 0, humanBaseline: 0.7, aiBaseline: 0.4, description: "insufficient sentences" };
  const starters = sentences.map((s) => s.trim().split(/\s+/)[0].toLowerCase());
  const uniqueStarters = new Set(starters);
  const diversity = uniqueStarters.size / starters.length;
  // Human diversity ≈ 0.7-0.9, AI ≈ 0.3-0.5
  const score = Math.max(0, Math.min(1, (0.7 - diversity) / 0.4));
  return { name: "starter_diversity", score, rawValue: diversity, humanBaseline: 0.7, aiBaseline: 0.4, description: `unique starters=${(diversity * 100).toFixed(0)}% (human≈70%, AI≈40%)` };
}

// === Feature 7: Lexical sophistication (avg word length) ===
// AI uses slightly longer words on average than humans in scientific context.
function measureLexicalSophistication(text: string): StatisticalFeature {
  const words = text.replace(/[^a-zA-Z\s]/g, "").split(/\s+/).filter((w) => w.length > 2);
  if (words.length < 20) return { name: "lexical_sophistication", score: 0.5, rawValue: 0, humanBaseline: 5.0, aiBaseline: 5.8, description: "insufficient words" };
  const avgLen = words.reduce((sum, w) => sum + w.length, 0) / words.length;
  // Scientific text: human avg word length ≈ 6.0, AI ≈ 7.0
  const score = Math.max(0, Math.min(1, (avgLen - 6.0) / 1.2));
  return { name: "lexical_sophistication", score, rawValue: avgLen, humanBaseline: 6.0, aiBaseline: 7.0, description: `avg word length=${avgLen.toFixed(1)} (human_sci≈6.0, AI_sci≈7.0)` };
}

// === Combined detection (statistical + lexicon) ===
const WEIGHTS = {
  burstiness: 0.12,
  ngram_entropy: 0.05,
  lexical_diversity: 0.05,
  punctuation: 0.10,
  function_words: 0.08,
  starter_diversity: 0.10,
  lexical_sophistication: 0.05,
  lexicon_tells: 0.45, // from our existing anti_ai_score
};

export function detectStatistical(text: string, lex: Lexicon): StatisticalDetectionResult {
  const features: StatisticalFeature[] = [
    measureBurstiness(text),
    measureNgramEntropy(text),
    measureLexicalDiversity(text),
    measurePunctuation(text),
    measureFunctionWords(text),
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
    finalScore += f.score * (WEIGHTS as any)[f.name];
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

  return { features, finalScore, isAI, threshold, topReasons };
}

export function formatStatisticalReport(r: StatisticalDetectionResult): string {
  const lines: string[] = [];
  lines.push(`=== Statistical AI Detection ===`);
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
