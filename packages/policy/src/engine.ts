import type { CompiledStrategy, InvestmentIntent, SupportedAsset } from "../../core/src/types.ts";
import { ASSETS } from "../../b20/src/registry.ts";
export type PolicyContext = { eligible: boolean; maxSlippageBps: number; requestedSlippageBps: number; quoteAgeMs?: number; maxQuoteAgeMs?: number };
export type PolicyResult = { allowed: boolean; checks: { name: string; passed: boolean; detail?: string }[] };
export function evaluatePolicy(intent: InvestmentIntent, strategy: CompiledStrategy, ctx: PolicyContext): PolicyResult {
  const checks: PolicyResult["checks"] = [];
  checks.push({ name: "eligibility", passed: ctx.eligible });
  checks.push({ name: "slippage", passed: ctx.requestedSlippageBps <= ctx.maxSlippageBps });
  if (ctx.quoteAgeMs != null) checks.push({ name: "quote_freshness", passed: ctx.quoteAgeMs <= (ctx.maxQuoteAgeMs ?? 30_000) });
  for (const a of strategy.allocations) {
    const record = ASSETS[a.asset as SupportedAsset];
    checks.push({ name: `asset:${a.asset}`, passed: !!record && record.enabled && (a.asset === "USDC" || !!record.address) });
  }
  for (const c of intent.constraints.filter(c=>c.type==="MAX_WEIGHT")) {
    const w = strategy.allocations.find(a=>a.asset===c.asset)?.weight ?? 0;
    checks.push({ name: `max_weight:${c.asset}`, passed: w <= c.value + 1e-9, detail: `${w} <= ${c.value}` });
  }
  return { allowed: checks.every(c=>c.passed), checks };
}
