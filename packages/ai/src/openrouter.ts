import type { InvestmentIntent } from "../../core/src/types.ts";
const SYSTEM = `You parse a user's portfolio request into strict JSON. Never output token addresses, calldata, wallet operations, or unsupported assets. Allowed assets: NVDAc, GOOGLc, METAc, AAPLc, USDC. Return only JSON matching InvestmentIntent.`;
export async function parseIntentWithOpenRouter(prompt: string, apiKey: string, model: string): Promise<InvestmentIntent> {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json", "HTTP-Referer": "https://stockos.app", "X-Title": "StockOS" },
    body: JSON.stringify({ model, temperature: 0, messages: [{role:"system",content:SYSTEM},{role:"user",content:prompt}], response_format: { type: "json_object" } })
  });
  if (!res.ok) throw new Error(`OpenRouter ${res.status}`);
  const body = await res.json() as any;
  return JSON.parse(body.choices?.[0]?.message?.content ?? "{}") as InvestmentIntent;
}
export function demoIntent(prompt: string): InvestmentIntent {
  const amount = Number(prompt.match(/\$([\d,.]+)/)?.[1]?.replaceAll(",", "") ?? 500);
  const nvdaMax = Number(prompt.match(/(?:nvidia|nvda)[^\d]{0,20}(\d{1,2})%/i)?.[1] ?? 35) / 100;
  const cash = Number(prompt.match(/(\d{1,2})%\s*(?:cash|usdc)/i)?.[1] ?? 10) / 100;
  return { intentVersion:1, action:"CREATE_PORTFOLIO", capital:{currency:"USDC",amount}, themes:["artificial_intelligence"], risk:"aggressive", exclusions:[], constraints:[{type:"MAX_WEIGHT",asset:"NVDAc",value:nvdaMax},{type:"MIN_CASH",value:cash}], automation:{rebalance:/monthly/i.test(prompt)?"MONTHLY":"NONE"} };
}
