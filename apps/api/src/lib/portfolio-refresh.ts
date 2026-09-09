import { formatUnits } from "viem";
import { ASSETS } from "../../../../packages/b20/src/registry.ts";
import type { SupportedAsset } from "../../../../packages/core/src/types.ts";
import { getBaseClient, readReferencePrice, readTokenBalance, readTokenDecimals } from "./chain.ts";
import { getAdminSupabase } from "./db.ts";

const TRACKED_ASSETS: SupportedAsset[] = ["USDC", "AAPLc", "GOOGLc", "METAc", "NVDAc"];

export async function capturePortfolioSnapshotNow(input: {
  userId: string;
  smartAccountAddress: string;
  strategyId: string;
  strategyVersion?: number;
}) {
  const db = getAdminSupabase();
  const { data: wallet, error: walletError } = await db
    .from("wallets")
    .select("id,smart_account_address")
    .eq("user_id", input.userId)
    .eq("chain_id", 8453)
    .eq("smart_account_address", input.smartAccountAddress)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (walletError) throw new Error(`Could not load wallet: ${walletError.message}`);
  if (!wallet) throw new Error("StockOS wallet record is unavailable");

  const { data: strategy, error: strategyError } = await db
    .from("strategies")
    .select("id,current_version")
    .eq("id", input.strategyId)
    .eq("user_id", input.userId)
    .maybeSingle();
  if (strategyError) throw new Error(`Could not load strategy: ${strategyError.message}`);
  if (!strategy) throw new Error("Active strategy not found");

  const versionNumber = input.strategyVersion ?? strategy.current_version;
  const { data: version, error: versionError } = await db
    .from("strategy_versions")
    .select("id")
    .eq("strategy_id", strategy.id)
    .eq("version", versionNumber)
    .maybeSingle();
  if (versionError) throw new Error(`Could not load strategy version: ${versionError.message}`);
  if (!version) throw new Error("Strategy version not found");

  const { data: targetRows, error: targetError } = await db
    .from("strategy_assets")
    .select("asset_symbol,target_weight")
    .eq("strategy_version_id", version.id);
  if (targetError) throw new Error(`Could not load target weights: ${targetError.message}`);
  const targets = new Map((targetRows ?? []).map(row => [row.asset_symbol as SupportedAsset, Number(row.target_weight)]));

  const positions: Array<{
    asset: SupportedAsset;
    rawBalance: string;
    tokenUnits: number;
    priceUsd: number | null;
    priceUpdatedAt: string | null;
    valueUsd: number | null;
    targetWeight: number;
    currentWeight?: number;
    drift?: number;
    absoluteDrift?: number;
  }> = [];

  for (const asset of TRACKED_ASSETS) {
    const record = ASSETS[asset];
    if (!record?.enabled || !record.address) continue;
    const [balance, decimals, reference] = await Promise.all([
      readTokenBalance(record.address, input.smartAccountAddress),
      record.decimals == null ? readTokenDecimals(record.address) : Promise.resolve(record.decimals),
      readReferencePrice(asset),
    ]);
    const tokenUnits = Number(formatUnits(balance, Number(decimals)));
    const priceUsd = reference.configured && Number.isFinite(reference.priceUsd) ? Number(reference.priceUsd) : null;
    const valueUsd = priceUsd == null ? null : tokenUnits * priceUsd;
    positions.push({
      asset,
      rawBalance: balance.toString(),
      tokenUnits,
      priceUsd,
      priceUpdatedAt: reference.updatedAt ?? null,
      valueUsd,
      targetWeight: targets.get(asset) ?? 0,
    });
  }

  const totalValueUsd = positions.reduce((sum, position) => sum + (position.valueUsd ?? 0), 0);
  for (const position of positions) {
    const currentWeight = totalValueUsd > 0 && position.valueUsd != null ? position.valueUsd / totalValueUsd : 0;
    position.currentWeight = currentWeight;
    position.drift = currentWeight - position.targetWeight;
    position.absoluteDrift = Math.abs(position.drift);
  }

  const blockNumber = await getBaseClient().getBlockNumber();
  const cashValueUsd = positions.find(position => position.asset === "USDC")?.valueUsd ?? 0;
  const capturedAt = new Date().toISOString();
  const { error: insertError } = await db.from("portfolio_snapshots").insert({
    user_id: input.userId,
    wallet_id: wallet.id,
    total_value_usd: totalValueUsd,
    cash_value_usd: cashValueUsd,
    positions,
    block_number: blockNumber.toString(),
    captured_at: capturedAt,
  });
  if (insertError) throw new Error(`Could not persist portfolio snapshot: ${insertError.message}`);

  return { totalValueUsd, cashValueUsd, positions, blockNumber: blockNumber.toString(), capturedAt };
}
