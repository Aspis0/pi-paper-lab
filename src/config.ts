// src/config.ts
// /paper-lab command — interactive API key management.
// Keys are stored in ~/.pi/agent/.paper-lab-keys.json (JSON, not committed).

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

const CONFIG_PATH = join(homedir(), ".pi", "agent", ".paper-lab-keys.json");

export type CitationBackend = "serper" | "exa" | "both" | "auto";

export interface PaperLabConfig {
  serper?: string;
  exa?: string;                                 // NEW: Exa.ai API key
  citation_backend?: CitationBackend;           // NEW: which backend to use
  copyleaks_email?: string;
  copyleaks_api_key?: string;
  domain?: string;  // domain key from data/domains/*.yaml, or "auto" for auto-detect
}

export function loadConfig(): PaperLabConfig {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
  } catch {
    return {};
  }
}

export function saveConfig(config: PaperLabConfig): void {
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), "utf-8");
}

// Called by serper-scholar.ts: tries env var first, then config file
export function getSerperKey(): string | undefined {
  if (process.env.SERPER_API_KEY) return process.env.SERPER_API_KEY;
  const config = loadConfig();
  return config.serper;
}

// Called by ai-detector.ts: tries env vars first, then config file
export function getCopyleaksEmail(): string | undefined {
  if (process.env.COPYLEAKS_EMAIL) return process.env.COPYLEAKS_EMAIL;
  return loadConfig().copyleaks_email;
}

export function getCopyleaksKey(): string | undefined {
  if (process.env.COPYLEAKS_API_KEY) return process.env.COPYLEAKS_API_KEY;
  return loadConfig().copyleaks_api_key;
}

// Called by exa-scholar.ts: tries env var first, then config file
export function getExaKey(): string | undefined {
  if (process.env.EXA_API_KEY) return process.env.EXA_API_KEY;
  return loadConfig().exa;
}

// === /paper-lab command ===
export async function paperLabConfigCommand(
  _args: string,
  ctx: ExtensionCommandContext,
): Promise<void> {
  // Discover available domains from filesystem (data-driven, no hardcoded list)
  const ROOT_DIR = join(homedir(), ".pi", "agent", "extensions", "pi-paper-lab");
  let domainChoices: Array<{ key: string; label: string }> = [];
  try {
    const { discoverDomains } = await import("./domains.ts");
    const domains = discoverDomains(ROOT_DIR);
    domainChoices = domains.map(d => ({
      key: d.key,
      label: `${d.key} — ${d.name ?? d.key}`,
    }));
  } catch {
    // domains.ts not loadable — continue without domain options
  }
  const config = loadConfig();

  const masked = (key?: string) => {
    if (!key) return "❌ not set";
    if (key.length <= 8) return "✅ set (hidden)";
    return `✅ ${key.slice(0, 4)}...${key.slice(-4)}`;
  };

  const lines = [
    "╔════════════════════════════════════════════╗",
    "║   pi-paper-lab Configuration Manager       ║",
    "╚════════════════════════════════════════════╝",
    "",
    `  1. Serper Scholar API key:  ${masked(config.serper)}`,
    `  2. Exa API key:             ${masked(config.exa)}`,
    `  3. Copyleaks email:         ${masked(config.copyleaks_email)}`,
    `  4. Copyleaks API key:       ${masked(config.copyleaks_api_key)}`,
    `  5. Domain (current: ${config.domain ?? "auto"})`,
    `  6. Citation backend (current: ${config.citation_backend ?? "serper"})`,
    "",
    "  Pick a number to set/update, or press Esc to exit.",
  ];
  ctx.ui.notify(lines.join("\n"), "info");

  const choice = await ctx.ui.select("Which to set?", [
    "1. Serper Scholar API key",
    "2. Exa API key",
    "3. Copyleaks email",
    "4. Copyleaks API key",
    "5. Domain",
    "6. Citation backend (serper / exa / both / auto)",
    "7. Show all (masked)",
    "8. Delete all keys",
  ]);

  if (!choice) return;

  if (choice.startsWith("1")) {
    const key = await ctx.ui.input("Enter your Serper.dev API key (get one at https://serper.dev):");
    if (!key) { ctx.ui.notify("No key entered.", "warning"); return; }
    config.serper = key.trim();
    saveConfig(config);
    ctx.ui.notify(`✅ Serper key saved to ${CONFIG_PATH}`, "info");
  } else if (choice.startsWith("2")) {
    const key = await ctx.ui.input("Enter your Exa API key (get one at https://dashboard.exa.ai/api-keys):");
    if (!key) { ctx.ui.notify("No key entered.", "warning"); return; }
    config.exa = key.trim();
    saveConfig(config);
    ctx.ui.notify(`✅ Exa key saved to ${CONFIG_PATH}`, "info");
  } else if (choice.startsWith("3")) {
    const email = await ctx.ui.input("Enter your Copyleaks account email:");
    if (!email) { ctx.ui.notify("No email entered.", "warning"); return; }
    config.copyleaks_email = email.trim();
    saveConfig(config);
    ctx.ui.notify("✅ Copyleaks email saved", "info");
  } else if (choice.startsWith("4")) {
    const key = await ctx.ui.input("Enter your Copyleaks API key (get one at https://copyleaks.com):");
    if (!key) { ctx.ui.notify("No key entered.", "warning"); return; }
    config.copyleaks_api_key = key.trim();
    saveConfig(config);
    ctx.ui.notify("✅ Copyleaks API key saved", "info");
  } else if (choice.startsWith("5")) {
    // Domain selection (data-driven from filesystem scan)
    const domainOptions = ["auto — detect from text", ...domainChoices.map(c => c.label)];
    const selected = await ctx.ui.select("Select domain:", domainOptions);
    if (selected) {
      if (selected.startsWith("auto")) {
        delete config.domain;
      } else {
        const match = domainChoices.find(c => selected.includes(c.key));
        if (match) {
          config.domain = match.key;
          saveConfig(config);
          ctx.ui.notify(`✅ Domain set to: ${match.key}`, "info");
        }
      }
    }
  } else if (choice.startsWith("6")) {
    // Citation backend selection
    const selected = await ctx.ui.select("Citation backend:", [
      `serper (default — use Serper only) — current: ${(config.citation_backend ?? "serper") === "serper" ? "✓" : ""}`,
      `exa (use Exa only) — current: ${config.citation_backend === "exa" ? "✓" : ""}`,
      `both (parallel query, merge + dedupe) — current: ${config.citation_backend === "both" ? "✓" : ""}`,
      `auto (try Exa first, fall back to Serper) — current: ${config.citation_backend === "auto" ? "✓" : ""}`,
    ]);
    if (selected) {
      if (selected.startsWith("serper")) config.citation_backend = "serper";
      else if (selected.startsWith("exa")) config.citation_backend = "exa";
      else if (selected.startsWith("both")) config.citation_backend = "both";
      else if (selected.startsWith("auto")) config.citation_backend = "auto";
      saveConfig(config);
      ctx.ui.notify(`✅ Citation backend set to: ${config.citation_backend}`, "info");
    }
  } else if (choice.startsWith("7")) {
    ctx.ui.notify(
      [
        "Current keys (masked):",
        `  Serper:     ${masked(config.serper)}`,
        `  Exa:        ${masked(config.exa)}`,
        `  Copyleaks:  ${masked(config.copyleaks_email)} / ${masked(config.copyleaks_api_key)}`,
        `  Domain:     ${config.domain ?? "auto"}`,
        `  Backend:    ${config.citation_backend ?? "serper"}`,
        "",
        `  Config file: ${CONFIG_PATH}`,
      ].join("\n"),
      "info",
    );
  } else if (choice.startsWith("8")) {
    const confirm = await ctx.ui.confirm("Delete all keys?", "This will remove all stored API keys. Are you sure?");
    if (confirm) {
      saveConfig({});
      ctx.ui.notify("All keys deleted.", "info");
    }
  }
}
