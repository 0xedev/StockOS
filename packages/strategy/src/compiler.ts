import type { CompiledStrategy, InvestmentIntent, SupportedAsset } from "../../core/src/types.ts";
import { ASSETS } from "../../b20/src/registry.ts";
const THEME_WEIGHTS: Record<string, Partial<Record<SupportedAsset, number>>> = {
  artificial_intelligence: { NVDAc: 0.4, GOOGLc: 0.3, METAc: 0.2, AAPLc: 0.1 },
  big_tech: { NVDAc: 0.25, GOOGLc: 0.25, METAc: 0.25, AAPLc: 0.25 }
};
export function compileStrategy(intent: InvestmentIntent): CompiledStrategy {
  if (intent.capital.amount <= 0) throw new Error("Capital amount must be positive");
  const minCash = Math.max(0, ...intent.constraints.filter(c => c.type === "MIN_CASH").map(c => c.value));
  if (minCash >= 1) throw new Error("Cash minimum leaves no investable capital");
  const theme = intent.themes[0] ?? "big_tech";
  const base = { ...(THEME_WEIGHTS[theme] ?? THEME_WEIGHTS.big_tech) };
  for (const excluded of intent.exclusions) delete base[excluded];
  const enabled = Object.entries(base).filter(([a, w]) => Number(w) > 0 && ASSETS[a as SupportedAsset]?.enabled) as [SupportedAsset, number][];
  if (!enabled.length) throw new Error("No enabled assets satisfy the strategy");
  const maxes = new Map(intent.constraints.filter(c => c.type === "MAX_WEIGHT").map(c => [c.asset, c.value]));
  const mins = new Map(intent.constraints.filter(c => c.type === "MIN_WEIGHT").map(c => [c.asset, c.value]));
  const investable = 1 - minCash;
  let weights = new Map<SupportedAsset, number>();
  const sum = enabled.reduce((s, [, w]) => s + w, 0);
  for (const [asset, w] of enabled) weights.set(asset, investable * w / sum);
  for (const [asset, max] of maxes) if (weights.has(asset)) weights.set(asset, Math.min(weights.get(asset)!, max));
  for (const [asset, min] of mins) if (weights.has(asset)) weights.set(asset, Math.max(weights.get(asset)!, min));
  let allocated = [...weights.values()].reduce((a,b)=>a+b,0);
  if (allocated > investable + 1e-9) {
    const scale = investable / allocated;
    for (const [asset,w] of weights) weights.set(asset, w * scale);
    allocated = investable;
  }
  let remainder = investable - allocated;
  if (remainder > 1e-9) {
    const candidates = [...weights.keys()].filter(a => !maxes.has(a) || weights.get(a)! < maxes.get(a)! - 1e-9);
    let guard = 0;
    while (remainder > 1e-9 && candidates.length && guard++ < 20) {
      const each = remainder / candidates.length;
      let consumed = 0;
      for (const asset of candidates) {
        const current = weights.get(asset)!;
        const cap = maxes.get(asset) ?? 1;
        const add = Math.min(each, cap - current);
        if (add > 0) { weights.set(asset, current + add); consumed += add; }
      }
      if (consumed <= 1e-12) break;
      remainder -= consumed;
    }
  }
  const allocations = [...weights.entries()].map(([asset,weight]) => ({ asset, weight, amountUsd: Math.round(intent.capital.amount * weight * 100)/100 }));
  if (minCash > 0 || remainder > 1e-9) allocations.push({ asset: "USDC", weight: minCash + Math.max(0,remainder), amountUsd: Math.round(intent.capital.amount * (minCash + Math.max(0,remainder))*100)/100 });
  const totalWeight = allocations.reduce((s,a)=>s+a.weight,0);
  if (Math.abs(totalWeight - 1) > 1e-6) throw new Error(`Invalid allocation total ${totalWeight}`);
  return { allocations, totalUsd: intent.capital.amount, cashWeight: allocations.find(a=>a.asset==="USDC")?.weight ?? 0, warnings: [] };
}
