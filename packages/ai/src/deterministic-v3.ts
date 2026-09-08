import type { InvestmentIntent, SupportedAsset } from "../../core/src/types.ts";
import { validateInvestmentIntent } from "../../core/src/validation.ts";
import { demoIntent } from "./openrouter.ts";

const STOCKS: SupportedAsset[] = ["NVDAc", "GOOGLc", "METAc", "AAPLc"];

function redistributeFromCashOnly(intent: InvestmentIntent): InvestmentIntent {
  const onlyCash = intent.targetAllocations.length === 1 && intent.targetAllocations[0]?.asset === "USDC";
  const cashMinimum = Math.max(0, ...intent.constraints.filter(c => c.type === "MIN_CASH").map(c => c.value));
  // This repair is intentionally narrow: it only corrects the old parser bug where
  // “at least N% cash” was mistaken for an explicit cash allocation and the remainder
  // was then also filled with USDC. Explicit all-cash requests have no MIN_CASH
  // constraint and must remain untouched.
  const shouldDiversify = onlyCash && cashMinimum > 0 && cashMinimum < 0.999;
  if (!shouldDiversify) return intent;

  const available = STOCKS.filter(asset => !intent.exclusions.includes(asset));
  if (!available.length) return intent;

  const maxes = new Map<SupportedAsset, number>();
  for (const constraint of intent.constraints) {
    if (constraint.type === "MAX_WEIGHT" && constraint.asset && constraint.asset !== "USDC") {
      maxes.set(constraint.asset as SupportedAsset, constraint.value);
    }
  }

  const weights = new Map<SupportedAsset, number>();
  const investable = 1 - cashMinimum;
  for (const asset of available) weights.set(asset, investable / available.length);

  let overflow = 0;
  for (const asset of available) {
    const cap = maxes.get(asset);
    const current = weights.get(asset) ?? 0;
    if (cap != null && current > cap) {
      overflow += current - cap;
      weights.set(asset, cap);
    }
  }

  let guard = 0;
  while (overflow > 1e-10 && guard++ < 20) {
    const open = available.filter(asset => (maxes.get(asset) ?? 1) - (weights.get(asset) ?? 0) > 1e-10);
    if (!open.length) break;
    const each = overflow / open.length;
    let consumed = 0;
    for (const asset of open) {
      const current = weights.get(asset) ?? 0;
      const capacity = (maxes.get(asset) ?? 1) - current;
      const add = Math.min(each, capacity);
      weights.set(asset, current + add);
      consumed += add;
    }
    if (consumed <= 1e-12) break;
    overflow -= consumed;
  }

  const targetAllocations = [...weights.entries()]
    .filter(([, weight]) => weight > 1e-10)
    .map(([asset, weight]) => ({ asset, weight }));
  const finalCash = cashMinimum + Math.max(0, overflow);
  if (finalCash > 1e-10) targetAllocations.push({ asset: "USDC", weight: finalCash });

  return validateInvestmentIntent({ ...intent, targetAllocations });
}

export function deterministicIntentV3(prompt: string): InvestmentIntent {
  return redistributeFromCashOnly(demoIntent(prompt));
}
