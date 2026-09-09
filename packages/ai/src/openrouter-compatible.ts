import type { InvestmentIntent } from "../../core/src/types.ts";
import { validateInvestmentIntent } from "../../core/src/validation.ts";
import { OpenRouterRequestError } from "./openrouter.ts";

const SYSTEM = `Translate the user's portfolio instruction into a StockOS investment intent JSON object. Return ONLY valid JSON with no markdown or commentary. Allowed assets: NVDAc (Nvidia), GOOGLc (Google/Alphabet), METAc (Meta/Facebook), AAPLc (Apple), USDC (cash). Never output token addresses, calldata, wallet operations, transactions, or unsupported assets.

Required shape:
{"intentVersion":2,"action":"CREATE_PORTFOLIO|UPDATE_PORTFOLIO|REBALANCE","capital":{"currency":"USDC","amount":number},"themes":[string],"risk":"conservative|moderate|aggressive","exclusions":["NVDAc|GOOGLc|METAc|AAPLc|USDC"],"constraints":[{"type":"MAX_WEIGHT|MIN_WEIGHT|MIN_CASH","asset":"NVDAc|GOOGLc|METAc|AAPLc|USDC|null","value":number}],"targetAllocations":[{"asset":"NVDAc|GOOGLc|METAc|AAPLc|USDC","weight":number}],"automation":{"rebalance":"NONE|WEEKLY|MONTHLY|QUARTERLY"}}

targetAllocations must sum to exactly 1. Preserve exact percentages when the user supplies them. When the user gives goals rather than exact percentages, choose sensible weights that satisfy their risk, preferences, exclusions, and constraints. Use USDC for cash. Constraint and allocation values are decimals from 0 to 1.`;

const TIMEOUT_MS = 15_000;
const MAX_TOKENS = 1200;

function normalizeContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map(part => {
    if (typeof part === "string") return part;
    if (part && typeof part === "object" && "text" in part && typeof part.text === "string") {
      return part.text;
    }
    return "";
  }).join("");
}

function parseJsonIntent(content: unknown): InvestmentIntent {
  const normalized = normalizeContent(content);
  if (!normalized.trim()) {
    throw new OpenRouterRequestError(502, "Managed AI returned an empty strategy response");
  }
  const trimmed = normalized.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  const candidate = first >= 0 && last > first ? trimmed.slice(first, last + 1) : trimmed;
  try {
    return validateInvestmentIntent(JSON.parse(candidate));
  } catch (error) {
    throw new OpenRouterRequestError(502, `Managed AI returned an invalid strategy: ${error instanceof Error ? error.message : "invalid JSON"}`);
  }
}

type ManagedCompletion = {
  content: unknown;
  model: string;
};

async function requestManagedCompletion(input: {
  prompt: string;
  apiKey: string;
  models: string[];
  repair?: {
    previousContent: unknown;
    validationError: string;
  };
}): Promise<ManagedCompletion> {
  const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
    { role: "system", content: SYSTEM },
    { role: "user", content: input.prompt },
  ];

  if (input.repair) {
    const previous = normalizeContent(input.repair.previousContent);
    if (previous) messages.push({ role: "assistant", content: previous });
    messages.push({
      role: "user",
      content: `The previous JSON failed StockOS deterministic validation: ${input.repair.validationError}\n\nReturn a corrected JSON object only. Fix the validation error without changing the user's capital, named assets, explicit percentages, exclusions, or requested constraints. targetAllocations must total exactly 1. Re-check the arithmetic before responding.`,
    });
  }

  let response: Response;
  try {
    response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        Authorization: `Bearer ${input.apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://stockos-ashen.vercel.app",
        "X-Title": "StockOS",
      },
      body: JSON.stringify({
        models: input.models,
        temperature: 0,
        max_tokens: MAX_TOKENS,
        stream: false,
        // Require a provider that supports structured output instead of silently
        // accepting response_format and returning prose.
        provider: { allow_fallbacks: true, require_parameters: true },
        response_format: { type: "json_object" },
        messages,
      }),
    });
  } catch (error) {
    const timedOut = error instanceof DOMException && error.name === "TimeoutError";
    throw new OpenRouterRequestError(504, timedOut ? "Managed AI strategy parsing timed out" : "Managed AI network request failed");
  }

  let body: any;
  try {
    body = await response.json();
  } catch {
    throw new OpenRouterRequestError(502, "Managed AI returned a non-JSON response envelope");
  }

  if (!response.ok) {
    throw new OpenRouterRequestError(response.status, body?.error?.message ?? "Managed AI request failed", body?.error?.code);
  }

  return {
    content: body?.choices?.[0]?.message?.content,
    model: typeof body?.model === "string" ? body.model : input.models[0],
  };
}

export async function parseIntentWithOpenRouterCompatible(prompt: string, apiKey: string, model: string): Promise<{ intent: InvestmentIntent; model: string }> {
  const models = model === "openrouter/free" ? [model] : [model, "openrouter/free"];
  const first = await requestManagedCompletion({ prompt, apiKey, models });

  try {
    return {
      intent: parseJsonIntent(first.content),
      model: first.model,
    };
  } catch (error) {
    // Structured output guarantees JSON syntax, not StockOS semantic invariants.
    // Give the model one bounded repair attempt with the deterministic validator's
    // exact failure (e.g. allocations total 109%) before the API falls back to the
    // deterministic parser. No transaction or execution data is ever sent here.
    if (!(error instanceof OpenRouterRequestError) || error.status !== 502 || !error.message.includes("invalid strategy")) {
      throw error;
    }

    const validationError = error.message.replace(/^Managed AI returned an invalid strategy:\s*/i, "");
    const repaired = await requestManagedCompletion({
      prompt,
      apiKey,
      models,
      repair: {
        previousContent: first.content,
        validationError,
      },
    });

    return {
      intent: parseJsonIntent(repaired.content),
      model: repaired.model,
    };
  }
}
