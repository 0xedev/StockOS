import type { InvestmentIntent } from "../../core/src/types.ts";
import { validateInvestmentIntent } from "../../core/src/validation.ts";
import { OpenRouterRequestError } from "./openrouter.ts";

const SYSTEM = `Translate the user's portfolio instruction into a StockOS investment intent JSON object. Return ONLY valid JSON with no markdown or commentary. Allowed assets: NVDAc (Nvidia), GOOGLc (Google/Alphabet), METAc (Meta/Facebook), AAPLc (Apple), USDC (cash). Never output token addresses, calldata, wallet operations, transactions, or unsupported assets.

Required shape:
{"intentVersion":2,"action":"CREATE_PORTFOLIO|UPDATE_PORTFOLIO|REBALANCE","capital":{"currency":"USDC","amount":number},"themes":[string],"risk":"conservative|moderate|aggressive","exclusions":["NVDAc|GOOGLc|METAc|AAPLc|USDC"],"constraints":[{"type":"MAX_WEIGHT|MIN_WEIGHT|MIN_CASH","asset":"NVDAc|GOOGLc|METAc|AAPLc|USDC|null","value":number}],"targetAllocations":[{"asset":"NVDAc|GOOGLc|METAc|AAPLc|USDC","weight":number}],"automation":{"rebalance":"NONE|WEEKLY|MONTHLY|QUARTERLY"}}

targetAllocations must sum to exactly 1. Preserve exact percentages when the user supplies them. When the user gives goals rather than exact percentages, choose sensible weights that satisfy their risk, preferences, exclusions, and constraints. Use USDC for cash. Constraint and allocation values are decimals from 0 to 1.`;

const TIMEOUT_MS = 15_000;

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

export async function parseIntentWithOpenRouterCompatible(prompt: string, apiKey: string, model: string): Promise<{ intent: InvestmentIntent; model: string }> {
  const models = model === "openrouter/free" ? [model] : [model, "openrouter/free"];
  let response: Response;
  try {
    response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://stockos-ashen.vercel.app",
        "X-Title": "StockOS",
      },
      body: JSON.stringify({
        models,
        temperature: 0,
        max_tokens: 1200,
        stream: false,
        // Do not let a provider silently ignore JSON mode. If the requested model/provider
        // cannot honor it, OpenRouter can move to another compatible provider/model.
        provider: { allow_fallbacks: true, require_parameters: true },
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: prompt },
        ],
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
    intent: parseJsonIntent(body?.choices?.[0]?.message?.content),
    model: typeof body?.model === "string" ? body.model : model,
  };
}
