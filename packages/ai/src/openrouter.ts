import type { InvestmentIntent } from "../../core/src/types.ts";
import { validateInvestmentIntent } from "../../core/src/validation.ts";

const SYSTEM = `Convert the user's portfolio request to the required schema. Never output token addresses, calldata, transactions, wallet operations, or unsupported assets. Allowed assets are NVDAc, GOOGLc, METAc, AAPLc and USDC. Percentages in constraints must be decimals from 0 to 1. Do not claim a trade was executed.`;
const OPENROUTER_TIMEOUT_MS = 12_000;

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

export class OpenRouterRequestError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string | number,
  ) {
    super(message);
    this.name = "OpenRouterRequestError";
  }
}

export type OpenRouterIntentResult = {
  intent: InvestmentIntent;
  model: string;
};

function parseStructuredContent(content: unknown): InvestmentIntent {
  if (typeof content !== "string" || !content.trim()) {
    throw new OpenRouterRequestError(502, "OpenRouter returned an empty structured intent");
  }
  const normalized = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return validateInvestmentIntent(JSON.parse(normalized));
  } catch (error) {
    if (error instanceof OpenRouterRequestError) throw error;
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
        max_tokens: 700,
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
  try {
    body = await res.json();
  } catch {
    throw new OpenRouterRequestError(502, "OpenRouter returned a non-JSON response");
  }
  if (!res.ok) {
    throw new OpenRouterRequestError(
      res.status,
      body?.error?.message ?? "OpenRouter request failed",
      body?.error?.code,
    );
  }

  return {
    intent: parseStructuredContent(body.choices?.[0]?.message?.content),
    model: typeof body.model === "string" ? body.model : model,
  };
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
