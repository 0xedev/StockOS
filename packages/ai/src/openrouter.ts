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

function escapedNames(names: string[]) { return names.map(name => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"); }
function mentioned(prompt: string, names: string[]) { return new RegExp(`\\b(?:${escapedNames(names)})\\b`, "i").test(prompt); }
function percentageFor(prompt: string, names: string[]): number | null {
  const joined = escapedNames(names);
  const after = prompt.match(new RegExp(`(?:${joined})[^\\d%]{0,24}(\\d+(?:\\.\\d+)?)\\s*%`, "i"));
  const before = prompt.match(new RegExp(`(\\d+(?:\\.\\d+)?)\\s*%[^,.;]{0,24}(?:${joined})`, "i"));
  const value = after?.[1] ?? before?.[1];
  return value == null ? null : Number(value) / 100;
}

export function demoIntent(prompt: string): InvestmentIntent {
  const amountMatch = prompt.match(/\$\s*([\d,.]+)/) ?? prompt.match(/(?:invest|portfolio|with|use)\s+(?:about\s+)?([\d,.]+)\s*(?:usdc|dollars?|usd)?/i);
  const amount = Number(amountMatch?.[1]?.replaceAll(",", "") ?? 500);
  const exclusions = aliases.filter(({ names }) => new RegExp(`(?:no|exclude|without|avoid)\\s+(?:${escapedNames(names)})`, "i").test(prompt)).map(({ asset }) => asset);
  const explicit = new Map<SupportedAsset, number>();
  for (const entry of aliases) {
    if (exclusions.includes(entry.asset)) continue;
    const weight = percentageFor(prompt, entry.names);
    if (weight != null && weight > 0) explicit.set(entry.asset, weight);
  }

  const maxConstraints = aliases.flatMap(entry => {
    const joined = escapedNames(entry.names);
    const match = prompt.match(new RegExp(`(?:${joined})[^\\d%]{0,24}(?:max|maximum|below|under|not more than|cap(?:ped)? at)?[^\\d%]{0,12}(\\d+(?:\\.\\d+)?)\\s*%`, "i"));
    return match ? [{ type: "MAX_WEIGHT" as const, asset: entry.asset, value: Number(match[1]) / 100 }] : [];
  });
  const cashMinimum = prompt.match(/(?:at least|minimum|min)\s+(\d+(?:\.\d+)?)\s*%\s*(?:cash|usdc)/i);
  const constraints: any[] = [...maxConstraints];
  if (cashMinimum) constraints.push({ type: "MIN_CASH", asset: null, value: Number(cashMinimum[1]) / 100 });

  let targetAllocations: Array<{ asset: SupportedAsset; weight: number }>;
  const explicitTotal = [...explicit.values()].reduce((sum, weight) => sum + weight, 0);
  if (explicit.size) {
    if (explicitTotal > 1.001) throw new Error("Explicit percentages exceed 100%");
    if (explicitTotal < 0.999) explicit.set("USDC", (explicit.get("USDC") ?? 0) + (1 - explicitTotal));
    targetAllocations = [...explicit.entries()].map(([asset, weight]) => ({ asset, weight }));
  } else {
    const stocks = aliases.filter(entry => entry.asset !== "USDC" && !exclusions.includes(entry.asset) && mentioned(prompt, entry.names)).map(entry => entry.asset);
    const candidates = stocks.length ? stocks : aliases.filter(entry => entry.asset !== "USDC" && !exclusions.includes(entry.asset)).map(entry => entry.asset);
    if (!candidates.length) throw new Error("No supported assets remain after exclusions");
    const cashRequested = percentageFor(prompt, ["cash", "usdc"]) ?? 0;
    const stockWeight = (1 - cashRequested) / candidates.length;
    targetAllocations = candidates.map(asset => ({ asset, weight: stockWeight }));
    if (cashRequested > 0) targetAllocations.push({ asset: "USDC", weight: cashRequested });
  }

  const risk = /conservative|low[ -]?risk/i.test(prompt) ? "conservative" : /aggressive|high[ -]?risk/i.test(prompt) ? "aggressive" : "moderate";
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
