// src/config.ts
// /paper-lab command — interactive API key management.
// Keys are stored in ~/.pi/agent/.paper-lab-keys.json (JSON, not committed).

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

const CONFIG_PATH = join(homedir(), ".pi", "agent", ".paper-lab-keys.json");

export interface PaperLabConfig {
  serper?: string;
  copyleaks_email?: string;
  copyleaks_api_key?: string;
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

// === /paper-lab command ===
export async function paperLabConfigCommand(
  _args: string,
  ctx: ExtensionCommandContext,
): Promise<void> {
  const config = loadConfig();

  const masked = (key?: string) => {
    if (!key) return "❌ not set";
    if (key.length <= 8) return "✅ set (hidden)";
    return `✅ ${key.slice(0, 4)}...${key.slice(-4)}`;
  };

  const lines = [
    "╔══════════════════════════════════════╗",
    "║   pi-paper-lab API Key Manager       ║",
    "╚══════════════════════════════════════╝",
    "",
    `  1. Serper Scholar API key:  ${masked(config.serper)}`,
    `  2. Copyleaks email:          ${masked(config.copyleaks_email)}`,
    `  3. Copyleaks API key:        ${masked(config.copyleaks_api_key)}`,
    "",
    "  Pick a number to set/update, or press Esc to exit.",
  ];
  ctx.ui.notify(lines.join("\n"), "info");

  const choice = await ctx.ui.select("Which key to set?", [
    "1. Serper Scholar API key",
    "2. Copyleaks email",
    "3. Copyleaks API key",
    "4. Show all (masked)",
    "5. Delete all keys",
  ]);

  if (!choice) return;

  if (choice.startsWith("1")) {
    const key = await ctx.ui.input("Enter your Serper.dev API key (get one at https://serper.dev):");
    if (!key) { ctx.ui.notify("No key entered.", "warning"); return; }
    config.serper = key.trim();
    saveConfig(config);
    ctx.ui.notify(`✅ Serper key saved to ${CONFIG_PATH}`, "info");
  } else if (choice.startsWith("2")) {
    const email = await ctx.ui.input("Enter your Copyleaks account email:");
    if (!email) { ctx.ui.notify("No email entered.", "warning"); return; }
    config.copyleaks_email = email.trim();
    saveConfig(config);
    ctx.ui.notify("✅ Copyleaks email saved", "info");
  } else if (choice.startsWith("3")) {
    const key = await ctx.ui.input("Enter your Copyleaks API key (get one at https://copyleaks.com):");
    if (!key) { ctx.ui.notify("No key entered.", "warning"); return; }
    config.copyleaks_api_key = key.trim();
    saveConfig(config);
    ctx.ui.notify("✅ Copyleaks API key saved", "info");
  } else if (choice.startsWith("4")) {
    ctx.ui.notify(
      [
        "Current keys (masked):",
        `  Serper:     ${masked(config.serper)}`,
        `  Copyleaks:  ${masked(config.copyleaks_email)} / ${masked(config.copyleaks_api_key)}`,
        "",
        `  Config file: ${CONFIG_PATH}`,
      ].join("\n"),
      "info",
    );
  } else if (choice.startsWith("5")) {
    const confirm = await ctx.ui.confirm("Delete all keys?", "This will remove all stored API keys. Are you sure?");
    if (confirm) {
      saveConfig({});
      ctx.ui.notify("All keys deleted.", "info");
    }
  }
}
