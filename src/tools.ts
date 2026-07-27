// src/tools.ts
// LLM-callable tools registered via pi.registerTool().

import { Type } from "typebox";
import { scoreText, silentRewrite } from "./anti-ai-lexicon.ts";
import { checkImrad, formatImradReport } from "./imrad.ts";
import { checkClaimStrength, formatClaimReport } from "./claim-strength.ts";
import { detectSloppy, formatSloppyReport } from "./sloppy-detector.ts";
import { searchScholar, formatScholarResults } from "./serper-scholar.ts";
import { lookupDoi, formatCrossRefWork } from "./crossref.ts";
import { resolveCitation, formatResolveResult, markClaims } from "./citations.ts";
import { extractCitedClaims, buildVerificationPrompts, formatVerificationReport } from "./cite-verify.ts";
import { markdownToWord, isDocxCliAvailable } from "./word-builder.ts";
import { detectAI, formatDetectionReport } from "./ai-detector.ts";
import { detectStatistical, formatStatisticalReport } from "./statistical-ai-detector.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Lexicon } from "./anti-ai-lexicon.ts";

export function registerTools(pi: ExtensionAPI, lex: Lexicon): void {
  // === AI detection tools ===
  pi.registerTool({
    name: "ai_detect",
    label: "Detect AI-generated text",
    description:
      "Detect whether text is AI-generated or human-written. Tries Copyleaks API (if COPYLEAKS_API_KEY set), falls back to 7-feature statistical detection (burstiness, perplexity proxy, lexical diversity, punctuation, function words, sentence starter diversity, lexical sophistication + lexicon AI-tells). Returns score 0-100, verdict, and top AI signals.",
    parameters: Type.Object({
      text: Type.String({ description: "Text to analyze" }),
    }),
    async execute(_id, params, signal, _onUpdate, _ctx) {
      const result = await detectAI(params.text, lex, { signal });
      return {
        content: [{ type: "text", text: formatDetectionReport(result) }],
        details: { aiScore: result.aiScore, isAI: result.isAI, source: result.source },
      };
    },
  });

  pi.registerTool({
    name: "ai_detect_statistical",
    label: "Statistical AI detection (7 features)",
    description:
      "Run 7 statistical features (burstiness, n-gram entropy, lexical diversity, punctuation, function words, sentence starter diversity, lexical sophistication) + lexicon AI-tells. Pure TypeScript, no API. Returns per-feature breakdown.",
    parameters: Type.Object({
      text: Type.String(),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      const result = detectStatistical(params.text, lex);
      return {
        content: [{ type: "text", text: formatStatisticalReport(result) }],
        details: { finalScore: result.finalScore, isAI: result.isAI },
      };
    },
  });

  // === Existing tools ===
  pi.registerTool({
    name: "anti_ai_score",
    label: "Score AI-tell likelihood",
    description:
      "Score a scientific passage for AI-tell density. Returns total weighted score, hit list, and verdict (human-like / edit-recommended / rewrite-mandatory). Use before producing final text or to audit draft text from a collaborator.",
    parameters: Type.Object({
      text: Type.String({ description: "Scientific text to score" }),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      const s = scoreText(params.text, lex);
      const detail = s.hits
        .map((h) => `- [${h.weight.toFixed(2)} ${h.category}] ${h.hit}`)
        .join("\n");
      return {
        content: [
          {
            type: "text",
            text: `Total: ${s.total.toFixed(2)}\nVerdict: ${s.verdict}\n\nHits:\n${detail || "(no hits)"}`,
          },
        ],
        details: { total: s.total, verdict: s.verdict, hitCount: s.hits.length },
      };
    },
  });

  pi.registerTool({
    name: "silent_rewrite",
    label: "Silent rewrite for AI-tells",
    description:
      "Rewrite a passage to remove AI-tells and domain-specific voice violations. Connectors compressed, fillers deleted, avoided verbs mapped to neutral. Returns the rewritten text and a stats report.",
    parameters: Type.Object({
      text: Type.String(),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      const { text: rewritten, stats } = silentRewrite(params.text, lex);
      const unresolved = stats.flaggedVerbs.length > 0
        ? `Unresolved verbs (manual): ${stats.flaggedVerbs.join(", ")}`
        : `All avoided verbs resolved.`;
      return {
        content: [
          {
            type: "text",
            text: `Stats: connectors=${stats.connectors}, fillers=${stats.fillers}, verbs=${stats.verbs}. ${unresolved}\n\n---\n\n${rewritten}`,
          },
        ],
        details: { stats },
      };
    },
  });

  pi.registerTool({
    name: "imrad_check",
    label: "IMRaD structure check",
    description:
      "Check a Markdown draft for IMRaD presence and domain-specific Methods/Results content (n, statistical test, software version, sex, age, genotype, ethics, data availability, p-values, effect sizes, confidence intervals, figure references).",
    parameters: Type.Object({
      text: Type.String(),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      const c = checkImrad(params.text);
      return {
        content: [{ type: "text", text: formatImradReport(c) }],
        details: {
          hasIntroduction: c.hasIntroduction,
          hasMethods: c.hasMethods,
          hasResults: c.hasResults,
          hasDiscussion: c.hasDiscussion,
          issueCount: c.structuralIssues.length,
        },
      };
    },
  });

  pi.registerTool({
    name: "claim_strength_check",
    label: "Check claim strength vs data",
    description:
      "Given a Results sentence, extract n/p/replicates/effect-size/CI from the text and return the assertion grade the data supports (strong_observation / observation / preliminary / speculative). Flags overclaiming (strong verb with weak data) and underclaiming (hedged verb with strong data).",
    parameters: Type.Object({
      sentence: Type.String({ description: "Results sentence to check" }),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      const r = checkClaimStrength(params.sentence, lex);
      return {
        content: [{ type: "text", text: formatClaimReport(r) }],
        details: {
          grade: r.grade,
          verdict: r.verdict,
          detectedN: r.detectedN,
          detectedP: r.detectedP,
        },
      };
    },
  });

  pi.registerTool({
    name: "scholar_search",
    label: "Search Google Scholar via Serper",
    description:
      "Search Google Scholar via the Serper.dev API. Requires SERPER_API_KEY env var. Returns title, authors, year, venue, citations count, link, and snippet for each result. Use to find academic sources for claims.",
    parameters: Type.Object({
      query: Type.String({ description: "Search query (topic, author, title fragment)" }),
      num_results: Type.Optional(Type.Number({ description: "Max results (default 5, max 20)" })),
    }),
    async execute(_id, params, signal, _onUpdate, _ctx) {
      try {
        const results = await searchScholar(params.query, {
          num: params.num_results,
          signal,
        });
        return {
          content: [{ type: "text", text: formatScholarResults(results) }],
          details: { count: results.length, query: params.query },
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Scholar search failed: ${String(err)}` }],
          details: { error: String(err) },
        };
      }
    },
  });

  pi.registerTool({
    name: "crossref_lookup",
    label: "Lookup DOI metadata via CrossRef",
    description:
      "Fetch canonical metadata for a DOI from the CrossRef REST API. Returns title, authors, year, journal, volume, issue, pages, and abstract (if available). Use to verify or get full citation details.",
    parameters: Type.Object({
      doi: Type.String({ description: "DOI (e.g. 10.7554/eLife.91927) or full URL" }),
    }),
    async execute(_id, params, signal, _onUpdate, _ctx) {
      try {
        const work = await lookupDoi(params.doi, { signal });
        if (!work) {
          return {
            content: [{ type: "text", text: `DOI not found: ${params.doi}` }],
            details: { found: false },
          };
        }
        const abstract = work.abstract ? work.abstract.replace(/<[^>]+>/g, "").trim() : undefined;
        return {
          content: [
            {
              type: "text",
              text: [
                formatCrossRefWork(work, params.doi),
                abstract ? `\nAbstract: ${abstract.slice(0, 1000)}` : "\nAbstract: (not available)",
              ].join("\n"),
            },
          ],
          details: { found: true, hasAbstract: Boolean(abstract), doi: params.doi },
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `CrossRef lookup failed: ${String(err)}` }],
          details: { error: String(err) },
        };
      }
    },
  });

  pi.registerTool({
    name: "find_citation",
    label: "Find citations for a topic",
    description:
      "Search for academic citations on a given topic. Combines Serper Scholar (broad) + CrossRef (DOI metadata). Returns ranked candidates with title, authors, year, venue, DOI, link, and citations count. Use when you see [CITE:topic] in a draft and need sources.",
    parameters: Type.Object({
      topic: Type.String({ description: "Topic or claim to find citations for" }),
      num_results: Type.Optional(Type.Number({ description: "Max results per source (default 5)" })),
    }),
    async execute(_id, params, signal, _onUpdate, _ctx) {
      const result = await resolveCitation(params.topic, {
        numResults: params.num_results,
        signal,
      });
      return {
        content: [{ type: "text", text: formatResolveResult(result) }],
        details: {
          topic: params.topic,
          candidateCount: result.candidates.length,
        },
      };
    },
  });

  pi.registerTool({
    name: "verify_citation",
    label: "Verify claim against reference",
    description:
      "Given a claim sentence and a reference DOI, fetch the reference abstract from CrossRef and build a structured verification prompt. Returns the prompt for you (the LLM) to evaluate as SUPPORTS / REFUTES / UNCLEAR. Use to check that citations actually support the claims they're attached to.",
    parameters: Type.Object({
      claim: Type.String({ description: "The claim sentence (without [N] markers)" }),
      doi: Type.String({ description: "DOI of the cited reference" }),
      reference_title: Type.Optional(Type.String({ description: "Reference title (if known)" })),
    }),
    async execute(_id, params, signal, _onUpdate, _ctx) {
      try {
        const work = await lookupDoi(params.doi, { signal });
        const abstract = work?.abstract ? work.abstract.replace(/<[^>]+>/g, "").trim() : undefined;
        const title = params.reference_title ?? work?.title?.[0] ?? "(unknown)";
        const authors = work?.author
          .map((a) => (a.family ? `${a.given ?? ""} ${a.family}`.trim() : a.name ?? "?"))
          .join(", ") ?? "(unknown)";
        const year =
          work?.published?.dateParts?.[0] ??
          work?.publishedPrint?.dateParts?.[0] ??
          work?.publishedOnline?.dateParts?.[0] ??
          "?";
        const prompts = await buildVerificationPrompts(
          [{ number: 0, claim: params.claim }],
          [{ number: 0, title, authors: String(authors), year: String(year), doi: params.doi }],
        );
        return {
          content: [{ type: "text", text: prompts[0]?.prompt ?? "No prompt generated." }],
          details: {
            hasAbstract: Boolean(abstract),
            doi: params.doi,
          },
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Verification failed: ${String(err)}` }],
          details: { error: String(err) },
        };
      }
    },
  });
}
