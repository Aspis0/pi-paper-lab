// extensions/index.ts
// Entry point for pi-paper-lab v0.5.
// Only 2 visible commands: /paper-cite and /paper-rewrite.
// All other commands (bio-scan, cite-mark, etc.) are internal functions
// used by the pipelines but NOT registered as slash commands.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { loadLexicon } from "../src/anti-ai-lexicon.ts";
import { buildSystemInjection } from "../src/system-injection.ts";
import { discoverDomains, getDomain, detectDomain } from "../src/domains.ts";
import { loadConfig } from "../src/config.ts";
import { silentRewrite } from "../src/anti-ai-lexicon.ts";
import { registerTools } from "../src/tools.ts";
import { pipelineCite, pipelineRewrite, pipelineWrite, generateWord } from "../src/pipeline.ts";
import { paperLabConfigCommand } from "../src/config.ts";
import {
  citeBibliographyCommand,
  paperToWordCommand,
} from "../src/commands.ts";

// Resolve the repo root from this file's location so the YAML resolves.
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

export default function (pi: ExtensionAPI) {
  const lex = loadLexicon(ROOT);
  const domains = discoverDomains(ROOT);
  // Resolve active domain: config override → "auto" (detect from text each turn)
  // → first discovered domain
  const config = loadConfig();
  const resolveDomain = (text: string) => {
    if (config.domain && config.domain !== "auto") {
      return getDomain(ROOT, config.domain);
    }
    // Auto-detect from text
    const detected = detectDomain(text, domains);
    if (detected) return getDomain(ROOT, detected);
    // Fallback: first domain with empty detect_keywords (general fallback)
    return domains.find(d => !d.detect_keywords || d.detect_keywords.length === 0) ?? domains[0] ?? null;
  };
  // For initial injection, use first detected domain (will be refined per-turn)
  const activeDomain = domains.find(d => !d.detect_keywords || d.detect_keywords.length === 0) ?? domains[0] ?? null;
  const injection = buildSystemInjection(lex, activeDomain);
  // Make resolveDomain available to other parts of the extension
  (globalThis as any).__piPaperLab = { lex, domains, resolveDomain };

  // === 1. Inject domain-specific voice into the system prompt on every turn ===
  pi.on("before_agent_start", async (event, _ctx) => {
    return {
      systemPrompt: `${event.systemPrompt}\n\n${injection}`,
    };
  });

  // === 2. Silent rewrite interceptor on assistant message_end ===
  pi.on("message_end", async (event, _ctx) => {
    if (event.message.role !== "assistant") return;
    const content = event.message.content;
    if (!Array.isArray(content)) return;
    let dirty = false;
    const next: typeof content = [];
    for (const block of content) {
      if (block && (block as any).type === "text" && typeof (block as any).text === "string") {
        const t = (block as any).text as string;
        const { text: rewritten, stats } = silentRewrite(t, lex);
        if (stats.connectors + stats.fillers + stats.verbs > 0) {
          dirty = true;
          next.push({ ...(block as any), text: rewritten });
        } else {
          next.push(block as any);
        }
      } else {
        next.push(block as any);
      }
    }
    if (!dirty) return;
    return {
      message: { ...event.message, content: next },
    };
  });

  // === 3. Two visible pipeline commands + helper commands ===

  pi.registerCommand("paper-cite", {
    description: "Read a draft, find citations for claims (LLM cite-mark), assign DOIs, generate bibliography + Word .docx. The LLM may rewrite surrounding prose to fit new citations. Usage: /paper-cite <file.md> [instructions...]",
    handler: async (args, ctx) => {
      const raw = args.trim().replace(/["']/g, "");
      // Split at .md or .docx boundary — everything after is instructions
      const m = raw.match(/^(.+?\.(?:md|docx))\s*(.*)$/s);
      const target = m ? m[1] : raw;
      const instructions = m ? m[2] : "";
      if (!target) {
        ctx.ui.notify("Usage: /paper-cite <file-path.md> [cite instructions...]", "warning");
        return;
      }
      try {
        readFileSync(target, "utf8");
      } catch (err) {
        ctx.ui.notify(`Could not read ${target}: ${String(err)}`, "error");
        return;
      }
      await pipelineCite(target, pi, instructions);
    },
  });

  pi.registerCommand("paper-rewrite", {
    description: "Same as /paper-cite, but first rewrites the draft to remove AI-tells and sloppy writing. Add your rewrite instructions after the file path. Usage: /paper-rewrite <file.md> [rewrite instructions...]",
    handler: async (args, ctx) => {
      const raw = args.trim().replace(/["']/g, "");
      // Split at .md or .docx boundary — everything after is instructions
      const m = raw.match(/^(.+?\.(?:md|docx))\s*(.*)$/s);
      const target = m ? m[1] : raw;
      const instructions = m ? m[2] : "";
      if (!target) {
        ctx.ui.notify("Usage: /paper-rewrite <file-path.md> [rewrite instructions...]", "warning");
        return;
      }
      try {
        readFileSync(target, "utf8");
      } catch (err) {
        ctx.ui.notify(`Could not read ${target}: ${String(err)}`, "error");
        return;
      }
      await pipelineRewrite(target, instructions, pi);
    },
  });

  pi.registerCommand("paper-write", {
    description: "Generate new paper text from a description, then rewrite + cite + Word. Usage: /paper-write <what to write>",
    handler: async (args, ctx) => {
      const description = args.trim().replace(/^["']|["']$/g, "");
      // Parse --output <path> flag
      const args2 = args.trim().replace(/^["']|["']$/g, "");
      let outputPath: string | undefined;
      const outputMatch = args2.match(/--output\s+["']?([^"'\s]+)["']?/);
      if (outputMatch) {
        outputPath = outputMatch[1];
        // Strip the --output flag from the description
        const desc = args2.replace(/--output\s+["']?[^"'\s]+["']?/g, "").trim();
        if (!desc) {
          ctx.ui.notify("Usage: /paper-write <description> [--output <path>]", "warning");
          return;
        }
        await pipelineWrite(desc, pi, { outputPath });
      } else {
        const desc = args2.replace(/^["']|["']$/g, "").trim();
        if (!desc) {
          ctx.ui.notify("Usage: /paper-write <description> [--output <path>]", "warning");
          return;
        }
        await pipelineWrite(desc, pi);
      }
    },
  });

  // Helper commands (needed by the LLM during pipeline execution)
  pi.registerCommand("cite-bibliography", {
    description: "Generate a Vancouver-style bibliography from inline [N](doi:...) markers.",
    handler: citeBibliographyCommand({ lex, rootDir: ROOT }),
  });

  pi.registerCommand("paper-to-word", {
    description: "Generate a .docx from a Markdown draft. [N](doi:...) → [N] + References section.",
    handler: paperToWordCommand({ lex, rootDir: ROOT }),
  });

  // API key management
  pi.registerCommand("paper-lab", {
    description: "Manage API keys (Serper, Copyleaks) interactively.",
    handler: paperLabConfigCommand,
  });

  // === 4. Register LLM tools ===
  registerTools(pi, lex);

  // === 5. Status line ===
  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.setStatus("paper-lab", "paper-lab: ready (/paper-cite, /paper-rewrite)");
  });
}
