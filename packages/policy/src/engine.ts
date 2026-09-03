import type { CompiledStrategy, InvestmentIntent, SupportedAsset } from "../../core/src/types.ts";
import { ASSETS } from "../../b20/src/registry.ts";

export type PolicyContext = {
  maxSlippageBps: number;
  requestedSlippageBps: number;
  quoteAgeMs?: number;
  maxQuoteAgeMs?: number;
};

export type PolicyResult = {
  allowed: boolean;
  checks: { name: string; passed: boolean; detail?: string }[];
};

export function evaluatePolicy(intent: InvestmentIntent, strategy: CompiledStrategy, ctx: PolicyContext): PolicyResult {
  const checks: PolicyResult["checks"] = [];
  checks.push({ name: "slippage", passed: ctx.requestedSlippageBps <= ctx.maxSlippageBps });
  if (ctx.quoteAgeMs != null) {
    checks.push({ name: "quote_freshness", passed: ctx.quoteAgeMs <= (ctx.maxQuoteAgeMs ?? 30_000) });
  }
  for (const allocation of strategy.allocations) {
    const record = ASSETS[allocation.asset as SupportedAsset];
    checks.push({
      name: `asset:${allocation.asset}`,
      passed: !!record && record.enabled && (allocation.asset === "USDC" || !!record.address),
    });
  }
  for (const constraint of intent.constraints) {
    if (constraint.type === "MAX_WEIGHT") {
      const weight = strategy.allocations.find(allocation => allocation.asset === constraint.asset)?.weight ?? 0;
      checks.push({
        name: `max_weight:${constraint.asset}`,
        passed: weight <= constraint.value + 1e-9,
        detail: `${weight} <= ${constraint.value}`,
      });
    } else if (constraint.type === "MIN_WEIGHT") {
      const weight = strategy.allocations.find(allocation => allocation.asset === constraint.asset)?.weight ?? 0;
      checks.push({
        name: `min_weight:${constraint.asset}`,
        passed: weight + 1e-9 >= constraint.value,
        detail: `${weight} >= ${constraint.value}`,
      });
    } else if (constraint.type === "MIN_CASH") {
      checks.push({
        name: "min_cash",
        passed: strategy.cashWeight + 1e-9 >= constraint.value,
        detail: `${strategy.cashWeight} >= ${constraint.value}`,
      });
    }
  }
  return { allowed: checks.every(check => check.passed), checks };
}
