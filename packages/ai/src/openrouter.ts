import type { InvestmentIntent } from "../../core/src/types.ts";
import { validateInvestmentIntent } from "../../core/src/validation.ts";

const SYSTEM = `Convert the user's portfolio request to the required schema. Never output token addresses, calldata, transactions, wallet operations, or unsupported assets. Allowed assets are NVDAc, GOOGLc, METAc, AAPLc and USDC. Percentages in constraints must be decimals from 0 to 1. Do not claim a trade was executed.`;

const INTENT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    intentVersion: { type: "integer", const: 1 },
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
    automation: {
      type: "object",
      additionalProperties: false,
      properties: { rebalance: { type: "string", enum: ["NONE", "WEEKLY", "MONTHLY", "QUARTERLY"] } },
      required: ["rebalance"],
    },
  },
  required: ["intentVersion", "action", "capital", "themes", "risk", "exclusions", "constraints", "automation"],
} as const;

export async function parseIntentWithOpenRouter(prompt: string, apiKey: string, model: string): Promise<InvestmentIntent> {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", "HTTP-Referer": "https://stockos.app", "X-Title": "StockOS" },
    body: JSON.stringify({
      model,
      temperature: 0,
      provider: { require_parameters: true },
      messages: [{ role: "system", content: SYSTEM }, { role: "user", content: prompt }],
      response_format: { type: "json_schema", json_schema: { name: "stockos_investment_intent", strict: true, schema: INTENT_SCHEMA } },
    }),
  });
  const body = await res.json() as any;
  if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${body?.error?.message ?? "request failed"}`);
  const content = body.choices?.[0]?.message?.content;
  if (typeof content !== "string") throw new Error("OpenRouter returned no structured intent");
  return validateInvestmentIntent(JSON.parse(content));
}

export function demoIntent(prompt: string): InvestmentIntent {
  const amount = Number(prompt.match(/\$([\d,.]+)/)?.[1]?.replaceAll(",", "") ?? 500);
  const nvdaMax = Number(prompt.match(/(?:nvidia|nvda)[^\d]{0,20}(\d{1,2})%/i)?.[1] ?? 35) / 100;
  const cash = Number(prompt.match(/(\d{1,2})%\s*(?:cash|usdc)/i)?.[1] ?? 10) / 100;
  return validateInvestmentIntent({
    intentVersion: 1,
    action: "CREATE_PORTFOLIO",
    capital: { currency: "USDC", amount },
    themes: ["artificial_intelligence"],
    risk: "aggressive",
    exclusions: [],
    constraints: [{ type: "MAX_WEIGHT", asset: "NVDAc", value: nvdaMax }, { type: "MIN_CASH", asset: null, value: cash }],
    automation: { rebalance: /monthly/i.test(prompt) ? "MONTHLY" : "NONE" },
  });
}
