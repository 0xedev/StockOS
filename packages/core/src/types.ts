export type SupportedAsset = "NVDAc" | "GOOGLc" | "METAc" | "AAPLc" | "USDC";
export type RiskLevel = "conservative" | "moderate" | "aggressive";
export type Constraint =
  | { type: "MAX_WEIGHT"; asset: SupportedAsset; value: number }
  | { type: "MIN_WEIGHT"; asset: SupportedAsset; value: number }
  | { type: "MIN_CASH"; value: number };
export type TargetAllocation = { asset: SupportedAsset; weight: number };
export type InvestmentIntent = {
  intentVersion: 2;
  action: "CREATE_PORTFOLIO" | "UPDATE_PORTFOLIO" | "REBALANCE";
  capital: { currency: "USDC"; amount: number };
  themes: string[];
  risk: RiskLevel;
  exclusions: SupportedAsset[];
  constraints: Constraint[];
  targetAllocations: TargetAllocation[];
  automation?: { rebalance?: "NONE" | "WEEKLY" | "MONTHLY" | "QUARTERLY" };
};
export type Allocation = { asset: SupportedAsset; weight: number; amountUsd: number };
export type CompiledStrategy = { allocations: Allocation[]; totalUsd: number; cashWeight: number; warnings: string[] };
