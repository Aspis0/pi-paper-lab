// src/exa-scholar.ts
// Exa search client.
// 1) REST https://api.exa.ai/search when EXA_API_KEY / config key is set
// 2) Free unauthenticated Exa MCP (https://mcp.exa.ai/mcp) otherwise
//    Official free tier: ~3 QPS / ~150 calls/day without a key.

import { getExaKey } from "./config.ts";

export interface ExaSearchResult {
  id: string;
  url: string;
  title: string;
  author?: string;
  publishedDate?: string; // ISO 8601
  text?: string;          // full text (if requested)
  highlights?: string[];  // token-efficient extracts
  score?: number;         // Exa relevance score
  /** How the hit was obtained (no secrets). */
  via?: "rest" | "mcp-free";
}

const EXA_REST_ENDPOINT = "https://api.exa.ai/search";
const EXA_MCP_URL = "https://mcp.exa.ai/mcp";

export async function searchExa(
  query: string,
  opts?: { num?: number; signal?: AbortSignal; fullText?: boolean },
): Promise<ExaSearchResult[]> {
  const apiKey = process.env.EXA_API_KEY ?? getExaKey();
  if (apiKey) {
    try {
      return await searchExaRest(query, apiKey, opts);
    } catch (err) {
      // Fall through to free MCP if REST fails (quota / network).
      console.error("[exa] REST search failed, trying free MCP:", err);
    }
  }
  return searchExaMcpFree(query, opts);
}

async function searchExaRest(
  query: string,
  apiKey: string,
  opts?: { num?: number; signal?: AbortSignal; fullText?: boolean },
): Promise<ExaSearchResult[]> {
  const num = opts?.num ?? 10;
  const body = {
    query,
    type: "auto",
    category: "publication",
    numResults: num,
    contents: {
      // Exa expects an OBJECT, not a boolean. Default: 3 sentences per result, query-aware.
      highlights: { numSentences: 3, highlightsPerUrl: 1, query },
      text: opts?.fullText ?? false,
    },
  };

  const res = await fetch(EXA_REST_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
      "User-Agent": "pi-paper-lab/0.7",
    },
    body: JSON.stringify(body),
    signal: opts?.signal,
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Exa REST search failed (${res.status}): ${err.slice(0, 200)}`);
  }

  const data = (await res.json()) as { results?: any[] };
  return (data.results ?? []).map((r: any) => ({
    id: r.id,
    url: r.url,
    title: r.title,
    author: r.author,
    publishedDate: r.publishedDate,
    text: r.text,
    highlights: r.highlights,
    score: r.score,
    via: "rest" as const,
  }));
}

/** Parse MCP SSE (event: message / data: {...}) or bare JSON-RPC body. */
function parseMcpJsonRpc(body: string): any {
  const lines = body.split(/\r?\n/);
  for (const line of lines) {
    if (line.startsWith("data:")) {
      const raw = line.slice(5).trim();
      if (!raw || raw === "[DONE]") continue;
      try {
        return JSON.parse(raw);
      } catch {
        /* keep scanning */
      }
    }
  }
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

async function mcpPost(
  sessionId: string | null,
  payload: object,
  signal?: AbortSignal,
): Promise<{ sessionId: string | null; message: any; status: number }> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    "MCP-Protocol-Version": "2024-11-05",
    "User-Agent": "pi-paper-lab/0.7 (exa-mcp-free)",
  };
  if (sessionId) headers["Mcp-Session-Id"] = sessionId;

  const res = await fetch(EXA_MCP_URL, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
    signal,
  });
  const text = await res.text();
  const nextSession =
    res.headers.get("mcp-session-id") ||
    res.headers.get("Mcp-Session-Id") ||
    sessionId;
  return {
    sessionId: nextSession,
    message: parseMcpJsonRpc(text),
    status: res.status,
  };
}

/**
 * Free unauthenticated Exa MCP search.
 * Tools: web_search_exa (default free surface).
 * Not the REST API — publication category is approximated via query wording.
 */
async function searchExaMcpFree(
  query: string,
  opts?: { num?: number; signal?: AbortSignal },
): Promise<ExaSearchResult[]> {
  const num = opts?.num ?? 10;
  const signal = opts?.signal;

  const init = await mcpPost(
    null,
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "pi-paper-lab", version: "0.7.7" },
      },
    },
    signal,
  );
  if (init.status >= 400 || !init.sessionId) {
    throw new Error(
      `Exa MCP free init failed (${init.status}). Set EXA_API_KEY for REST access.`,
    );
  }

  // Required by streamable HTTP MCP after initialize.
  await mcpPost(
    init.sessionId,
    { jsonrpc: "2.0", method: "notifications/initialized" },
    signal,
  );

  // Bias free web search toward scholarly literature (no REST category filter).
  const scholarlyQuery = `peer-reviewed scientific publications: ${query}`;
  const call = await mcpPost(
    init.sessionId,
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "web_search_exa",
        arguments: { query: scholarlyQuery, numResults: num },
      },
    },
    signal,
  );

  if (call.status === 429) {
    throw new Error(
      "Exa MCP free rate limit (≈150/day). Add EXA_API_KEY for higher limits.",
    );
  }
  if (call.status >= 400) {
    throw new Error(`Exa MCP free call failed (${call.status})`);
  }

  const errMsg = call.message?.error?.message;
  if (errMsg) {
    throw new Error(`Exa MCP free error: ${String(errMsg).slice(0, 200)}`);
  }

  const content = call.message?.result?.content;
  if (!Array.isArray(content)) {
    return [];
  }
  const textBlocks = content
    .filter((c: any) => c && c.type === "text" && typeof c.text === "string")
    .map((c: any) => c.text as string);
  return parseMcpSearchText(textBlocks.join("\n\n"), num);
}

/** Parse MCP web_search_exa text payload into ExaSearchResult[]. */
function parseMcpSearchText(blob: string, limit: number): ExaSearchResult[] {
  if (!blob.trim()) return [];

  // Split on "Title:" starts (first may not have leading newline).
  const parts = blob.split(/(?=^Title:\s)/m).filter((p) => p.trim().length > 0);
  const out: ExaSearchResult[] = [];

  for (const part of parts) {
    if (out.length >= limit) break;
    const title = matchField(part, "Title");
    const url = matchField(part, "URL");
    if (!title && !url) continue;
    const published = matchField(part, "Published");
    const authorRaw = matchField(part, "Author");
    const author =
      authorRaw && authorRaw !== "N/A" ? authorRaw : undefined;
    const highlightsBlock = part.match(
      /Highlights:\s*([\s\S]*?)(?=\nTitle:|\nURL:|\nPublished:|\nAuthor:|$)/i,
    );
    let highlights: string[] | undefined;
    if (highlightsBlock?.[1]) {
      const h = highlightsBlock[1].trim();
      if (h) highlights = [h.slice(0, 800)];
    }
    out.push({
      id: url || title || `mcp-${out.length}`,
      url: url || "",
      title: title || "(untitled)",
      author,
      publishedDate: published,
      highlights,
      via: "mcp-free",
    });
  }

  // Fallback: if structured parse failed, try URL/title lines loosely.
  if (out.length === 0) {
    const urlRe = /URL:\s*(\S+)/gi;
    let m: RegExpExecArray | null;
    while ((m = urlRe.exec(blob)) !== null && out.length < limit) {
      out.push({
        id: m[1],
        url: m[1],
        title: m[1],
        via: "mcp-free",
      });
    }
  }
  return out;
}

function matchField(block: string, name: string): string | undefined {
  const re = new RegExp(`^${name}:\\s*(.+)$`, "im");
  const m = block.match(re);
  return m?.[1]?.trim() || undefined;
}
