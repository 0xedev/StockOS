import type { CompiledStrategy, InvestmentIntent, SupportedAsset } from "../../core/src/types.ts";
import { ASSETS } from "../../b20/src/registry.ts";

export function compileStrategy(intent: InvestmentIntent): CompiledStrategy {
  if (intent.capital.amount <= 0) throw new Error("Capital amount must be positive");
  if (!intent.targetAllocations.length) throw new Error("Strategy requires target allocations");

  const warnings: string[] = [];
  const allocations = intent.targetAllocations.map(target => {
    const record = ASSETS[target.asset as SupportedAsset];
    if (!record?.enabled) throw new Error(`${target.asset} is not enabled for StockOS execution`);
    if (target.asset !== "USDC" && !record.address) throw new Error(`${target.asset} does not have a verified token address`);
    return {
      asset: target.asset,
      weight: target.weight,
      amountUsd: Math.round(intent.capital.amount * target.weight * 100) / 100,
    };
  });

  const totalWeight = allocations.reduce((sum, allocation) => sum + allocation.weight, 0);
  if (Math.abs(totalWeight - 1) > 0.001) throw new Error(`Invalid allocation total ${totalWeight}`);

  const cashWeight = allocations.find(allocation => allocation.asset === "USDC")?.weight ?? 0;
  for (const constraint of intent.constraints) {
    if (constraint.type === "MIN_CASH" && cashWeight + 1e-9 < constraint.value) {
      warnings.push(`Cash target ${(cashWeight * 100).toFixed(1)}% is below the requested minimum ${(constraint.value * 100).toFixed(1)}%.`);
    }
    if (constraint.type === "MAX_WEIGHT") {
      const weight = allocations.find(allocation => allocation.asset === constraint.asset)?.weight ?? 0;
      if (weight > constraint.value + 1e-9) warnings.push(`${constraint.asset} exceeds the requested maximum weight.`);
    }
    if (constraint.type === "MIN_WEIGHT") {
      const weight = allocations.find(allocation => allocation.asset === constraint.asset)?.weight ?? 0;
      if (weight + 1e-9 < constraint.value) warnings.push(`${constraint.asset} is below the requested minimum weight.`);
    }
  }

  return { allocations, totalUsd: intent.capital.amount, cashWeight, warnings };
}
