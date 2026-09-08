import type { InvestmentIntent } from "../../core/src/types.ts";
import { validateInvestmentIntent } from "../../core/src/validation.ts";
import { OpenRouterRequestError } from "./openrouter.ts";
import { parseIntentWithOpenRouterCompatible } from "./openrouter-compatible.ts";

export type ByokProvider = "openrouter" | "openai" | "anthropic" | "gemini";

const SYSTEM = `Translate the user's portfolio instruction into a StockOS investment intent JSON object. Return ONLY valid JSON with no markdown or commentary. Allowed assets: NVDAc (Nvidia), GOOGLc (Google/Alphabet), METAc (Meta/Facebook), AAPLc (Apple), USDC (cash). Never output token addresses, calldata, wallet operations, transactions, or unsupported assets.

Required shape:
{"intentVersion":2,"action":"CREATE_PORTFOLIO|UPDATE_PORTFOLIO|REBALANCE","capital":{"currency":"USDC","amount":number},"themes":[string],"risk":"conservative|moderate|aggressive","exclusions":["NVDAc|GOOGLc|METAc|AAPLc|USDC"],"constraints":[{"type":"MAX_WEIGHT|MIN_WEIGHT|MIN_CASH","asset":"NVDAc|GOOGLc|METAc|AAPLc|USDC|null","value":number}],"targetAllocations":[{"asset":"NVDAc|GOOGLc|METAc|AAPLc|USDC","weight":number}],"automation":{"rebalance":"NONE|WEEKLY|MONTHLY|QUARTERLY"}}

targetAllocations must sum to exactly 1. Preserve exact percentages when supplied. For goals rather than exact percentages, choose sensible weights satisfying risk, preferences, exclusions and constraints. Use USDC for cash. Constraint/allocation values are decimals from 0 to 1.`;

const TIMEOUT_MS = 15_000;

export function defaultModelForProvider(provider: ByokProvider) {
  if (provider === "openai") return "gpt-5.6-luna";
  if (provider === "anthropic") return "claude-sonnet-5";
  if (provider === "gemini") return "gemini-3.8-flash";
  return "openrouter/free";
}

function parseJsonIntent(content: unknown, provider: string): InvestmentIntent {
  if (typeof content !== "string" || !content.trim()) throw new OpenRouterRequestError(502, `${provider} returned an empty strategy response`);
  const trimmed = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  const candidate = first >= 0 && last > first ? trimmed.slice(first, last + 1) : trimmed;
  try { return validateInvestmentIntent(JSON.parse(candidate)); }
  catch (error) { throw new OpenRouterRequestError(502, `${provider} returned an invalid strategy: ${error instanceof Error ? error.message : "invalid JSON"}`); }
}

async function fetchJson(url: string, init: RequestInit, provider: string) {
  let response: Response;
  try {
    response = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (error) {
    const timedOut = error instanceof DOMException && error.name === "TimeoutError";
    throw new OpenRouterRequestError(timedOut ? 504 : 502, timedOut ? `${provider} strategy parsing timed out` : `${provider} network request failed`);
  }
  let body: any;
  try { body = await response.json(); }
  catch { throw new OpenRouterRequestError(502, `${provider} returned a non-JSON API response`); }
  if (!response.ok) {
    const message = body?.error?.message ?? body?.message ?? `${provider} request failed`;
    throw new OpenRouterRequestError(response.status, message, body?.error?.code);
  }
  return body;
}

async function parseWithOpenAi(prompt: string, apiKey: string, model: string) {
  const body = await fetchJson("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [{ role: "system", content: SYSTEM }, { role: "user", content: prompt }],
      temperature: 0,
      max_completion_tokens: 1200,
    }),
  }, "OpenAI");
  return { intent: parseJsonIntent(body?.choices?.[0]?.message?.content, "OpenAI"), model: body?.model ?? model };
}

async function parseWithAnthropic(prompt: string, apiKey: string, model: string) {
  const body = await fetchJson("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      max_tokens: 1200,
      temperature: 0,
      system: SYSTEM,
      messages: [{ role: "user", content: prompt }],
    }),
  }, "Anthropic");
  const text = Array.isArray(body?.content) ? body.content.filter((part: any) => part?.type === "text").map((part: any) => part.text).join("") : "";
  return { intent: parseJsonIntent(text, "Anthropic"), model: body?.model ?? model };
}

async function parseWithGemini(prompt: string, apiKey: string, model: string) {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const body = await fetchJson(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM }] },
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0, maxOutputTokens: 1200, responseMimeType: "application/json" },
    }),
  }, "Gemini");
  const parts = body?.candidates?.[0]?.content?.parts;
  const text = Array.isArray(parts) ? parts.map((part: any) => part?.text ?? "").join("") : "";
  return { intent: parseJsonIntent(text, "Gemini"), model };
}

export async function parseIntentWithProvider(input: {
  provider: ByokProvider;
  prompt: string;
  apiKey: string;
  model: string;
}): Promise<{ intent: InvestmentIntent; model: string }> {
  if (input.provider === "openrouter") return parseIntentWithOpenRouterCompatible(input.prompt, input.apiKey, input.model);
  if (input.provider === "openai") return parseWithOpenAi(input.prompt, input.apiKey, input.model);
  if (input.provider === "anthropic") return parseWithAnthropic(input.prompt, input.apiKey, input.model);
  return parseWithGemini(input.prompt, input.apiKey, input.model);
}
