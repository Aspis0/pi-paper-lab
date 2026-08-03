// src/ai-detector.ts
// AI text detection: Copyleaks API (if key available) + local fallback (anti_ai_score).
// Used by /paper-rewrite pipeline: detect → rewrite AI sentences → re-detect → loop (max 3).

import { getCopyleaksEmail, getCopyleaksKey } from "./config.ts";
import { scoreText, silentRewrite, type Lexicon } from "./anti-ai-lexicon.ts";
import { detectStatistical, formatStatisticalReport, type StatisticalDetectionResult } from "./statistical-ai-detector.ts";

export interface AIDetectionResult {
  aiScore: number;          // 0-100, 0=human, 100=AI
  isAI: boolean;            // aiScore > threshold
  threshold: number;        // configurable
  flaggedSentences: Array<{
    sentence: string;
    score: number;
    reason: string;
  }>;
  source: "copyleaks" | "local";
}

const DEFAULT_THRESHOLD = 40; // 40% = "might be AI"

// === Copyleaks API client ===
// Requires COPYLEAKS_API_KEY env var. Free tier: 1000 requests/month.
// Docs: https://docs.copyleaks.com/concepts/products/ai-text-detection-api
export async function detectWithCopyleaks(
  text: string,
  opts?: { signal?: AbortSignal },
): Promise<AIDetectionResult | null> {
  const apiKey = getCopyleaksKey();
  const email = getCopyleaksEmail();
  if (!apiKey || !email) return null;

  try {
    // Step 1: Get access token
    const tokenRes = await fetch("https://id.copyleaks.com/v3/account/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, apiKey }),
      signal: opts?.signal,
    });
    if (!tokenRes.ok) return null;
    const tokenData = await tokenRes.json() as { access_token: string };
    const token = tokenData.access_token;

    // Step 2: Submit text for AI detection
    const scanId = `paper-lab-${Date.now()}`;
    const submitRes = await fetch(
      `https://api.copyleaks.com/v2/writer-detector/${scanId}/check`,
      {
        method: "PUT",
        headers: {
          "Authorization": `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          text,
          sensitivity: 2, // Level 2: catches AI text with small changes
        }),
        signal: opts?.signal,
      },
    );
    if (!submitRes.ok) return null;

    // Step 3: Poll for results (max 30 seconds)
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const resultRes = await fetch(
        `https://api.copyleaks.com/v2/writer-detector/${scanId}/status`,
        {
          headers: { "Authorization": `Bearer ${token}` },
          signal: opts?.signal,
        },
      );
      if (!resultRes.ok) continue;
      const result = await resultRes.json() as any;
      if (result.status === "done" || result.aiScore !== undefined) {
        return parseCopyleaksResult(result, text);
      }
    }
    return null; // timeout
  } catch {
    return null; // API error → fallback to local
  }
}

function parseCopyleaksResult(result: any, text: string): AIDetectionResult {
  const aiScore = result.aiScore ?? result.ai ?? 0;
  const threshold = DEFAULT_THRESHOLD;
  const flaggedSentences: AIDetectionResult["flaggedSentences"] = [];

  // Copyleaks returns "AI Logic" with specific phrases/sentences
  if (result.aiLogic?.phrases) {
    for (const phrase of result.aiLogic.phrases) {
      flaggedSentences.push({
        sentence: phrase.text ?? phrase,
        score: aiScore,
        reason: "flagged by Copyleaks AI Logic",
      });
    }
  }

  return {
    aiScore,
    isAI: aiScore > threshold,
    threshold,
    flaggedSentences,
    source: "copyleaks",
  };
}

// === Local fallback (statistical + lexicon) ===
// Uses the new statistical detector (burstiness, perplexity proxy, lexical diversity, etc.)
export function detectLocal(text: string, lex: Lexicon): AIDetectionResult {
  const statResult = detectStatistical(text, lex);
  return {
    aiScore: statResult.finalScore,
    isAI: statResult.isAI,
    threshold: statResult.threshold,
    flaggedSentences: statResult.features
      .filter((f) => f.score > 0.3)
      .sort((a, b) => b.score - a.score)
      .map((f) => ({
        sentence: f.description,
        score: Math.round(f.score * 100),
        reason: f.name,
      })),
    source: "local",
  };
}

// === Main detection function (tries Copyleaks first, falls back to local) ===
export async function detectAI(
  text: string,
  lex: Lexicon,
  opts?: { signal?: AbortSignal },
): Promise<AIDetectionResult> {
  const copyleaks = await detectWithCopyleaks(text, opts);
  if (copyleaks) return copyleaks;
  return detectLocal(text, lex);
}

// === Detect-rewrite loop (for /paper-rewrite pipeline) ===
// 1. Detect AI
// 2. If AI score > threshold → rewrite flagged sentences
// 3. Re-detect
// 4. Repeat until score < threshold or max 3 iterations
export async function detectRewriteLoop(
  text: string,
  lex: Lexicon,
  opts?: { signal?: AbortSignal; maxIterations?: number },
): Promise<{ text: string; iterations: number; finalScore: number; initialScore: number; source: string }> {
  const maxIter = opts?.maxIterations ?? 3;
  let current = text;
  let result = await detectAI(current, lex, opts);
  const initialScore = result.aiScore;
  let iterations = 0;

  while (result.isAI && iterations < maxIter) {
    iterations++;
    // Rewrite the full text with silent_rewrite (catches all AI-tells)
    const { text: rewritten } = silentRewrite(current, lex);
    // Hostile-audit fix #12: stop if silent_rewrite made no change — it is
    // not idempotent (capitalisation/article fixes accumulate), so re-running
    // it on an already-rewritten text can only drift, not improve.
    if (rewritten === current) break;
    current = rewritten;

    // Re-detect
    result = await detectAI(current, lex, opts);
  }

  return {
    text: current,
    iterations,
    finalScore: result.aiScore,
    initialScore,
    source: result.source,
  };
}

export function formatDetectionReport(result: AIDetectionResult): string {
  const lines: string[] = [];
  lines.push(`AI Detection (${result.source}):`);
  lines.push(`  Score: ${result.aiScore}% (threshold: ${result.threshold}%)`);
  lines.push(`  Verdict: ${result.isAI ? "⚠️ AI-generated" : "✅ Human-like"}`);
  if (result.flaggedSentences.length > 0) {
    lines.push(`  Flagged sentences (${result.flaggedSentences.length}):`);
    for (const s of result.flaggedSentences.slice(0, 5)) {
      lines.push(`    [${s.score}] "${s.sentence.slice(0, 80)}..."`);
      lines.push(`      Reason: ${s.reason}`);
    }
    if (result.flaggedSentences.length > 5) {
      lines.push(`    ... and ${result.flaggedSentences.length - 5} more`);
    }
  }
  return lines.join("\n");
}
