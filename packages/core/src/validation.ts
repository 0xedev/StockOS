import type { Constraint, InvestmentIntent, RiskLevel, SupportedAsset, TargetAllocation } from "./types.ts";

const ASSETS = new Set<SupportedAsset>(["NVDAc", "GOOGLc", "METAc", "AAPLc", "USDC"]);
const ACTIONS = new Set(["CREATE_PORTFOLIO", "UPDATE_PORTFOLIO", "REBALANCE"]);
const RISKS = new Set<RiskLevel>(["conservative", "moderate", "aggressive"]);
const FREQUENCIES = new Set(["NONE", "WEEKLY", "MONTHLY", "QUARTERLY"]);

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected object");
  return value as Record<string, unknown>;
}
function asset(value: unknown): SupportedAsset {
  if (typeof value !== "string" || !ASSETS.has(value as SupportedAsset)) throw new Error(`Unsupported asset: ${String(value)}`);
  return value as SupportedAsset;
}
function unit(value: unknown, label: string, exclusiveZero = false): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1 || (exclusiveZero && value === 0)) {
    throw new Error(`${label} must be ${exclusiveZero ? "greater than 0 and " : ""}between 0 and 1`);
  }
  return value;
}

export function validateInvestmentIntent(input: unknown): InvestmentIntent {
  const v = record(input);
  if (v.intentVersion !== 2) throw new Error("Unsupported intent version");
  if (typeof v.action !== "string" || !ACTIONS.has(v.action)) throw new Error("Unsupported action");
  const capital = record(v.capital);
  if (capital.currency !== "USDC" || typeof capital.amount !== "number" || !Number.isFinite(capital.amount) || capital.amount <= 0) {
    throw new Error("Capital must be a positive USDC amount");
  }
  if (!Array.isArray(v.themes) || !v.themes.every(x => typeof x === "string")) throw new Error("themes must be strings");
  if (typeof v.risk !== "string" || !RISKS.has(v.risk as RiskLevel)) throw new Error("Invalid risk level");
  if (!Array.isArray(v.exclusions)) throw new Error("exclusions must be an array");
  const exclusions = v.exclusions.map(asset);
  if (!Array.isArray(v.constraints)) throw new Error("constraints must be an array");
  const constraints: Constraint[] = v.constraints.map(raw => {
    const c = record(raw);
    if (c.type === "MIN_CASH") return { type: "MIN_CASH", value: unit(c.value, "MIN_CASH") };
    if (c.type === "MAX_WEIGHT" || c.type === "MIN_WEIGHT") return { type: c.type, asset: asset(c.asset), value: unit(c.value, c.type) };
    throw new Error(`Unsupported constraint: ${String(c.type)}`);
  });

  if (!Array.isArray(v.targetAllocations) || v.targetAllocations.length === 0) throw new Error("targetAllocations must contain at least one asset");
  const seen = new Set<SupportedAsset>();
  const targetAllocations: TargetAllocation[] = v.targetAllocations.map(raw => {
    const a = record(raw);
    const targetAsset = asset(a.asset);
    if (seen.has(targetAsset)) throw new Error(`Duplicate target allocation: ${targetAsset}`);
    seen.add(targetAsset);
    if (exclusions.includes(targetAsset)) throw new Error(`Excluded asset cannot have a target allocation: ${targetAsset}`);
    return { asset: targetAsset, weight: unit(a.weight, `targetAllocations.${targetAsset}`, true) };
  });
  const totalWeight = targetAllocations.reduce((sum, item) => sum + item.weight, 0);
  if (Math.abs(totalWeight - 1) > 0.001) throw new Error(`Target allocations must total 100%; received ${(totalWeight * 100).toFixed(2)}%`);

  let automation: InvestmentIntent["automation"];
  if (v.automation != null) {
    const a = record(v.automation);
    if (typeof a.rebalance !== "string" || !FREQUENCIES.has(a.rebalance)) throw new Error("Invalid rebalance frequency");
    automation = { rebalance: a.rebalance as "NONE" | "WEEKLY" | "MONTHLY" | "QUARTERLY" };
  }
  return {
    intentVersion: 2,
    action: v.action as InvestmentIntent["action"],
    capital: { currency: "USDC", amount: capital.amount },
    themes: v.themes as string[],
    risk: v.risk as RiskLevel,
    exclusions,
    constraints,
    targetAllocations,
    automation,
  };
}
