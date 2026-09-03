import type { InvestmentIntent, SupportedAsset } from "../../core/src/types.ts";
import { validateInvestmentIntent } from "../../core/src/validation.ts";

const SYSTEM = `Translate the user's portfolio instructions into StockOS intent JSON. You are proposing portfolio weights, not executing trades. Allowed assets only: NVDAc (Nvidia), GOOGLc (Alphabet/Google), METAc (Meta/Facebook), AAPLc (Apple), USDC (cash). Never output token addresses, calldata, transactions, wallet operations, or unsupported assets. targetAllocations MUST contain the portfolio you actually propose and MUST sum to exactly 1. Preserve exact percentages when the user gives them. When the user gives goals instead of exact percentages, choose weights that best satisfy their stated risk, preferences, exclusions and constraints. Use USDC for cash. Constraints use decimal values from 0 to 1. Do not claim a trade was executed.`;
const OPENROUTER_TIMEOUT_MS = 15_000;

const INTENT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    intentVersion: { type: "integer", const: 2 },
    action: { type: "string", enum: ["CREATE_PORTFOLIO", "UPDATE_PORTFOLIO", "REBALANCE"] },
    capital: {
      type: "object",
      additionalProperties: false,
      properties: { currency: { type: "string", const: "USDC" }, amount: { type: "number", exclusiveMinimum: 0 } },
      required: ["currency", "amount"],
    },
    themes: { type: "array", items: { type: "string" } },
    risk: { type: "string", enum: ["conservative", "moderate", "aggressive"] },
    exclusions: { type: "array", items: { type: "string", enum: ["NVDAc", "GOOGLc", "METAc", "AAPLc", "USDC"] } },
    constraints: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          type: { type: "string", enum: ["MAX_WEIGHT", "MIN_WEIGHT", "MIN_CASH"] },
          asset: { type: ["string", "null"], enum: ["NVDAc", "GOOGLc", "METAc", "AAPLc", "USDC", null] },
          value: { type: "number", minimum: 0, maximum: 1 },
        },
        required: ["type", "asset", "value"],
      },
    },
    targetAllocations: {
      type: "array",
      minItems: 1,
      maxItems: 5,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          asset: { type: "string", enum: ["NVDAc", "GOOGLc", "METAc", "AAPLc", "USDC"] },
          weight: { type: "number", exclusiveMinimum: 0, maximum: 1 },
        },
        required: ["asset", "weight"],
      },
    },
    automation: {
      type: "object",
      additionalProperties: false,
      properties: { rebalance: { type: "string", enum: ["NONE", "WEEKLY", "MONTHLY", "QUARTERLY"] } },
      required: ["rebalance"],
    },
  },
  required: ["intentVersion", "action", "capital", "themes", "risk", "exclusions", "constraints", "targetAllocations", "automation"],
} as const;

export class OpenRouterRequestError extends Error {
  constructor(public status: number, message: string, public code?: string | number) {
    super(message);
    this.name = "OpenRouterRequestError";
  }
}

export type OpenRouterIntentResult = { intent: InvestmentIntent; model: string };

function parseStructuredContent(content: unknown): InvestmentIntent {
  if (typeof content !== "string" || !content.trim()) throw new OpenRouterRequestError(502, "OpenRouter returned an empty structured intent");
  const normalized = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return validateInvestmentIntent(JSON.parse(normalized));
  } catch (error) {
    throw new OpenRouterRequestError(502, `OpenRouter returned invalid structured intent: ${error instanceof Error ? error.message : "invalid JSON"}`);
  }
}

export async function parseIntentWithOpenRouter(prompt: string, apiKey: string, model: string): Promise<OpenRouterIntentResult> {
  const models = model === "openrouter/free" ? [model] : [model, "openrouter/free"];
  let res: Response;
  try {
    res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      signal: AbortSignal.timeout(OPENROUTER_TIMEOUT_MS),
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://stockos-ashen.vercel.app",
        "X-Title": "StockOS",
      },
      body: JSON.stringify({
        models,
        temperature: 0,
        max_tokens: 1100,
        provider: { require_parameters: true },
        messages: [{ role: "system", content: SYSTEM }, { role: "user", content: prompt }],
        response_format: { type: "json_schema", json_schema: { name: "stockos_investment_intent", strict: true, schema: INTENT_SCHEMA } },
      }),
    });
  } catch (error) {
    const timedOut = error instanceof DOMException && error.name === "TimeoutError";
    throw new OpenRouterRequestError(504, timedOut ? "OpenRouter strategy parsing timed out" : "OpenRouter network request failed");
  }

  let body: any;
  try { body = await res.json(); } catch { throw new OpenRouterRequestError(502, "OpenRouter returned a non-JSON response"); }
  if (!res.ok) throw new OpenRouterRequestError(res.status, body?.error?.message ?? "OpenRouter request failed", body?.error?.code);
  return { intent: parseStructuredContent(body.choices?.[0]?.message?.content), model: typeof body.model === "string" ? body.model : model };
}

const aliases: Array<{ asset: SupportedAsset; names: string[] }> = [
  { asset: "NVDAc", names: ["nvidia", "nvda", "nvdac"] },
  { asset: "GOOGLc", names: ["google", "alphabet", "googl", "googlc"] },
  { asset: "METAc", names: ["meta", "facebook", "metac"] },
  { asset: "AAPLc", names: ["apple", "aapl", "aaplc"] },
  { asset: "USDC", names: ["cash", "usdc"] },
];
const CONSTRAINT_WORDS = /\b(?:max|maximum|below|under|not more than|at most|cap(?:ped)?|minimum|min|at least)\b/i;

function escapedNames(names: string[]) { return names.map(name => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"); }
function mentioned(prompt: string, names: string[]) { return new RegExp(`\\b(?:${escapedNames(names)})\\b`, "i").test(prompt); }

function allocationPercentageFor(prompt: string, names: string[]): number | null {
  const joined = escapedNames(names);
  const patterns = [
    new RegExp(`(?:${joined})[^,.;]{0,30}?(\\d+(?:\\.\\d+)?)\\s*%`, "i"),
    new RegExp(`(\\d+(?:\\.\\d+)?)\\s*%[^,.;]{0,30}?(?:${joined})`, "i"),
  ];
  for (const pattern of patterns) {
    const match = prompt.match(pattern);
    if (!match || CONSTRAINT_WORDS.test(match[0])) continue;
    return Number(match[1]) / 100;
  }
  return null;
}

function maxWeightFor(prompt: string, names: string[]): number | null {
  const joined = escapedNames(names);
  const patterns = [
    new RegExp(`(?:${joined})[^,.;]{0,20}?(?:max(?:imum)?|below|under|not more than|at most|cap(?:ped)?(?:\\s+at)?)\\s*(\\d+(?:\\.\\d+)?)\\s*%`, "i"),
    new RegExp(`(?:max(?:imum)?|not more than|at most|cap(?:ped)?(?:\\s+at)?)\\s*(\\d+(?:\\.\\d+)?)\\s*%[^,.;]{0,20}?(?:${joined})`, "i"),
  ];
  for (const pattern of patterns) {
    const match = prompt.match(pattern);
    if (match) return Number(match[1]) / 100;
  }
  return null;
}

function minCashFor(prompt: string): number | null {
  const patterns = [
    /(?:at least|minimum|min)\s+(\d+(?:\.\d+)?)\s*%\s*(?:cash|usdc)/i,
    /(?:cash|usdc)[^,.;]{0,20}?(?:at least|minimum|min)\s+(\d+(?:\.\d+)?)\s*%/i,
  ];
  for (const pattern of patterns) {
    const match = prompt.match(pattern);
    if (match) return Number(match[1]) / 100;
  }
  return null;
}

function distributeWithCaps(candidates: SupportedAsset[], investable: number, maxes: Map<SupportedAsset, number>) {
  const weights = new Map<SupportedAsset, number>();
  if (!candidates.length || investable <= 0) return weights;
  for (const asset of candidates) weights.set(asset, investable / candidates.length);
  let overflow = 0;
  for (const asset of candidates) {
    const cap = maxes.get(asset);
    const current = weights.get(asset)!;
    if (cap != null && current > cap) {
      overflow += current - cap;
      weights.set(asset, cap);
    }
  }
  let guard = 0;
  while (overflow > 1e-10 && guard++ < 20) {
    const open = candidates.filter(asset => (maxes.get(asset) ?? 1) - (weights.get(asset) ?? 0) > 1e-10);
    if (!open.length) break;
    const each = overflow / open.length;
    let consumed = 0;
    for (const asset of open) {
      const current = weights.get(asset) ?? 0;
      const capacity = (maxes.get(asset) ?? 1) - current;
      const add = Math.min(each, capacity);
      weights.set(asset, current + add);
      consumed += add;
    }
    if (consumed <= 1e-12) break;
    overflow -= consumed;
  }
  return { weights, unallocated: Math.max(0, overflow) };
}

export function demoIntent(prompt: string): InvestmentIntent {
  const amountMatch = prompt.match(/\$\s*([\d,.]+)/) ?? prompt.match(/(?:invest|portfolio|with|use)\s+(?:about\s+)?([\d,.]+)\s*(?:usdc|dollars?|usd)?/i);
  const amount = Number(amountMatch?.[1]?.replaceAll(",", "") ?? 500);
  const exclusions = aliases
    .filter(({ names }) => new RegExp(`(?:no|exclude|without|avoid)\\s+(?:${escapedNames(names)})`, "i").test(prompt))
    .map(({ asset }) => asset);

  const risk = /conservative|low[ -]?risk/i.test(prompt) ? "conservative" : /aggressive|high[ -]?risk/i.test(prompt) ? "aggressive" : "moderate";
  const maxes = new Map<SupportedAsset, number>();
  for (const entry of aliases.filter(entry => entry.asset !== "USDC")) {
    const value = maxWeightFor(prompt, entry.names);
    if (value != null) maxes.set(entry.asset, value);
  }
  const cashMinimum = minCashFor(prompt);
  const constraints: Array<Record<string, any>> = [...maxes.entries()].map(([asset, value]) => ({ type: "MAX_WEIGHT", asset, value }));
  if (cashMinimum != null) constraints.push({ type: "MIN_CASH", asset: null, value: cashMinimum });

  const explicit = new Map<SupportedAsset, number>();
  for (const entry of aliases) {
    if (exclusions.includes(entry.asset)) continue;
    const weight = allocationPercentageFor(prompt, entry.names);
    if (weight != null && weight > 0) explicit.set(entry.asset, weight);
  }

  let targetAllocations: Array<{ asset: SupportedAsset; weight: number }>;
  const explicitTotal = [...explicit.values()].reduce((sum, weight) => sum + weight, 0);
  if (explicit.size) {
    if (explicitTotal > 1.001) throw new Error("Explicit percentages exceed 100%");
    if (explicitTotal < 0.999) explicit.set("USDC", (explicit.get("USDC") ?? 0) + (1 - explicitTotal));
    targetAllocations = [...explicit.entries()].map(([asset, weight]) => ({ asset, weight }));
  } else {
    const namedStocks = aliases
      .filter(entry => entry.asset !== "USDC" && !exclusions.includes(entry.asset) && mentioned(prompt, entry.names))
      .map(entry => entry.asset);
    const selectionLanguage = /\b(?:across|between|among|only|include|focus(?:ed)?\s+on|prefer|mostly|split|equal(?:ly)?)\b/i.test(prompt);
    const allStocks = aliases.filter(entry => entry.asset !== "USDC" && !exclusions.includes(entry.asset)).map(entry => entry.asset);
    const candidates = selectionLanguage && namedStocks.length ? namedStocks : allStocks;
    if (!candidates.length) throw new Error("No supported assets remain after exclusions");

    const explicitCash = allocationPercentageFor(prompt, ["cash", "usdc"]);
    const defaultCash = risk === "conservative" ? 0.25 : risk === "moderate" ? 0.10 : 0.05;
    let cashWeight = Math.max(explicitCash ?? 0, cashMinimum ?? 0, explicitCash == null && cashMinimum == null ? defaultCash : 0);
    cashWeight = Math.min(cashWeight, 0.95);
    const distributed = distributeWithCaps(candidates, 1 - cashWeight, maxes);
    if (!(distributed instanceof Map)) {
      cashWeight += distributed.unallocated;
      targetAllocations = [...distributed.weights.entries()].filter(([, weight]) => weight > 1e-10).map(([asset, weight]) => ({ asset, weight }));
    } else {
      targetAllocations = [...distributed.entries()].map(([asset, weight]) => ({ asset, weight }));
    }
    if (cashWeight > 1e-10) targetAllocations.push({ asset: "USDC", weight: cashWeight });
  }

  return validateInvestmentIntent({
    intentVersion: 2,
    action: /rebalance/i.test(prompt) ? "REBALANCE" : /update|change|modify/i.test(prompt) ? "UPDATE_PORTFOLIO" : "CREATE_PORTFOLIO",
    capital: { currency: "USDC", amount },
    themes: [/(?:ai|artificial intelligence)/i.test(prompt) ? "artificial_intelligence" : "custom"],
    risk,
    exclusions,
    constraints,
    targetAllocations,
    automation: { rebalance: /weekly/i.test(prompt) ? "WEEKLY" : /monthly/i.test(prompt) ? "MONTHLY" : /quarterly/i.test(prompt) ? "QUARTERLY" : "NONE" },
  });
}
