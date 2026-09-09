import { createClient } from "@supabase/supabase-js";
import Redis from "ioredis";
import {
  createPublicClient,
  formatUnits,
  http,
  isAddress,
  parseAbi,
  type Address,
  type Hash,
} from "viem";
import { base } from "viem/chains";
import { ASSETS } from "../../../packages/b20/src/registry.ts";

const redisUrl = process.env.REDIS_URL;
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!redisUrl) throw new Error("REDIS_URL must be configured for the StockOS worker");
if (!supabaseUrl || !supabaseServiceRoleKey) throw new Error("Supabase server credentials must be configured for the StockOS worker");

const redis = new Redis(redisUrl, { maxRetriesPerRequest: null, enableReadyCheck: true });
const db = createClient(supabaseUrl, supabaseServiceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
const chain = createPublicClient({ chain: base, transport: http(process.env.BASE_RPC_URL ?? "https://mainnet.base.org") });

const erc20Abi = parseAbi([
  "function balanceOf(address account) view returns (uint256)",
  "function decimals() view returns (uint8)",
]);
const aggregatorAbi = parseAbi([
  "function decimals() view returns (uint8)",
  "function latestRoundData() view returns (uint80 roundId,int256 answer,uint256 startedAt,uint256 updatedAt,uint80 answeredInRound)",
]);

const STOCK_ASSETS = ["AAPLc", "GOOGLc", "METAc", "NVDAc"] as const;
type StockAsset = (typeof STOCK_ASSETS)[number];
type TrackedAsset = StockAsset | "USDC";

let shuttingDown = false;
let reconciliationRunning = false;
let snapshotsRunning = false;

function asAddress(value: string): Address {
  if (!isAddress(value)) throw new Error(`Invalid EVM address: ${value}`);
  return value;
}

function feedEnv(asset: StockAsset) {
  return `CHAINLINK_FEED_${asset.toUpperCase()}`;
}

function nextRebalanceFrom(frequency: unknown, from = new Date()): string | null {
  if (typeof frequency !== "string") return null;
  const next = new Date(from);
  if (frequency === "WEEKLY") next.setUTCDate(next.getUTCDate() + 7);
  else if (frequency === "MONTHLY") next.setUTCMonth(next.getUTCMonth() + 1);
  else if (frequency === "QUARTERLY") next.setUTCMonth(next.getUTCMonth() + 3);
  else return null;
  return next.toISOString();
}

async function referencePrice(asset: TrackedAsset): Promise<{ priceUsd: number | null; updatedAt: string | null }> {
  if (asset === "USDC") return { priceUsd: 1, updatedAt: new Date().toISOString() };
  const feed = process.env[feedEnv(asset)];
  if (!feed || !isAddress(feed)) return { priceUsd: null, updatedAt: null };
  const [decimals, round] = await Promise.all([
    chain.readContract({ address: feed, abi: aggregatorAbi, functionName: "decimals" }),
    chain.readContract({ address: feed, abi: aggregatorAbi, functionName: "latestRoundData" }),
  ]);
  const answer = round[1];
  const updatedAt = round[3];
  if (answer <= 0n || updatedAt <= 0n) return { priceUsd: null, updatedAt: null };
  return {
    priceUsd: Number(formatUnits(answer, Number(decimals))),
    updatedAt: new Date(Number(updatedAt) * 1000).toISOString(),
  };
}

async function targetWeights(strategyId: string) {
  const { data: strategy } = await db.from("strategies").select("current_version").eq("id", strategyId).maybeSingle();
  if (!strategy) return new Map<string, number>();
  const { data: version } = await db
    .from("strategy_versions")
    .select("id")
    .eq("strategy_id", strategyId)
    .eq("version", strategy.current_version)
    .maybeSingle();
  if (!version) return new Map<string, number>();
  const { data: assets } = await db.from("strategy_assets").select("asset_symbol,target_weight").eq("strategy_version_id", version.id);
  return new Map((assets ?? []).map(row => [row.asset_symbol as string, Number(row.target_weight)]));
}

async function capturePortfolioSnapshot(userId: string, strategyId: string) {
  const { data: wallet } = await db
    .from("wallets")
    .select("id,smart_account_address")
    .eq("user_id", userId)
    .eq("chain_id", 8453)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!wallet?.smart_account_address || !isAddress(wallet.smart_account_address)) return;

  const account = wallet.smart_account_address as Address;
  const targets = await targetWeights(strategyId);
  const tracked: TrackedAsset[] = ["USDC", ...STOCK_ASSETS];
  const rawPositions: Array<{
    asset: TrackedAsset;
    rawBalance: string;
    tokenUnits: number;
    priceUsd: number | null;
    priceUpdatedAt: string | null;
    valueUsd: number | null;
    targetWeight: number;
  }> = [];

  for (const asset of tracked) {
    const registry = ASSETS[asset];
    if (!registry?.address || !registry.enabled) continue;
    try {
      const address = asAddress(registry.address);
      const [balance, decimals, price] = await Promise.all([
        chain.readContract({ address, abi: erc20Abi, functionName: "balanceOf", args: [account] }),
        chain.readContract({ address, abi: erc20Abi, functionName: "decimals" }),
        referencePrice(asset),
      ]);
      const tokenUnits = Number(formatUnits(balance, Number(decimals)));
      const valueUsd = price.priceUsd == null ? null : tokenUnits * price.priceUsd;
      rawPositions.push({
        asset,
        rawBalance: balance.toString(),
        tokenUnits,
        priceUsd: price.priceUsd,
        priceUpdatedAt: price.updatedAt,
        valueUsd,
        targetWeight: targets.get(asset) ?? 0,
      });
    } catch (error) {
      console.error(`StockOS worker could not snapshot ${asset}`, error);
    }
  }

  const totalValueUsd = rawPositions.reduce((sum, position) => sum + (position.valueUsd ?? 0), 0);
  const positions = rawPositions.map(position => {
    const currentWeight = totalValueUsd > 0 && position.valueUsd != null ? position.valueUsd / totalValueUsd : 0;
    return {
      ...position,
      currentWeight,
      drift: currentWeight - position.targetWeight,
      absoluteDrift: Math.abs(currentWeight - position.targetWeight),
    };
  });
  const cashValueUsd = positions.find(position => position.asset === "USDC")?.valueUsd ?? 0;
  const blockNumber = await chain.getBlockNumber();
  const { error } = await db.from("portfolio_snapshots").insert({
    user_id: userId,
    wallet_id: wallet.id,
    total_value_usd: totalValueUsd,
    cash_value_usd: cashValueUsd,
    positions,
    block_number: blockNumber.toString(),
    captured_at: new Date().toISOString(),
  });
  if (error) throw new Error(`Could not persist portfolio snapshot: ${error.message}`);
}

async function activateStrategy(userId: string, strategyId: string, strategyVersion: number) {
  const activatedAt = new Date();
  const now = activatedAt.toISOString();
  await db.from("strategies").update({ status: "paused", updated_at: now }).eq("user_id", userId).eq("status", "active").neq("id", strategyId);
  const { error: strategyUpdateError } = await db.from("strategies").update({ status: "active", current_version: strategyVersion, updated_at: now }).eq("id", strategyId).eq("user_id", userId);
  if (strategyUpdateError) throw new Error(`Could not activate strategy version: ${strategyUpdateError.message}`);

  const { data: version, error: versionError } = await db
    .from("strategy_versions")
    .select("parsed_intent")
    .eq("strategy_id", strategyId)
    .eq("version", strategyVersion)
    .maybeSingle();
  if (versionError) throw new Error(`Could not load activated strategy intent: ${versionError.message}`);
  const frequency = (version?.parsed_intent as any)?.automation?.rebalance;

  const { data: rebalanceRules, error: rulesError } = await db
    .from("automation_rules")
    .select("id,parameters")
    .eq("strategy_id", strategyId)
    .eq("rule_type", "scheduled_rebalance")
    .order("created_at", { ascending: false });
  if (rulesError) throw new Error(`Could not load rebalance rules: ${rulesError.message}`);

  const nextRunAt = nextRebalanceFrom(frequency, activatedAt);
  const existingRule = rebalanceRules?.[0] ?? null;
  if (nextRunAt) {
    const parameters = { frequency, mode: "user_approval_required", source: "strategy_intent" };
    if (existingRule) {
      const { error } = await db.from("automation_rules").update({ parameters, enabled: true, next_run_at: nextRunAt, updated_at: now }).eq("id", existingRule.id);
      if (error) throw new Error(`Could not schedule rebalance from activation: ${error.message}`);
      const staleIds = (rebalanceRules ?? []).slice(1).map(rule => rule.id);
      if (staleIds.length) await db.from("automation_rules").update({ enabled: false, updated_at: now }).in("id", staleIds);
    } else {
      const { error } = await db.from("automation_rules").insert({ strategy_id: strategyId, rule_type: "scheduled_rebalance", parameters, enabled: true, next_run_at: nextRunAt });
      if (error) throw new Error(`Could not create rebalance schedule: ${error.message}`);
    }
  } else if (rebalanceRules?.length) {
    const { error } = await db.from("automation_rules").update({ enabled: false, updated_at: now }).in("id", rebalanceRules.map(rule => rule.id));
    if (error) throw new Error(`Could not disable rebalance schedule: ${error.message}`);
  }

  await db.from("audit_events").insert({
    user_id: userId,
    strategy_id: strategyId,
    event_type: "strategy_activated",
    strategy_version: strategyVersion,
    metadata: { source: "confirmed_execution" },
  });
}

async function reconcileExecution(execution: { id: string; execution_plan_id: string; status: string; tx_hash: string | null }) {
  if (!execution.tx_hash || !/^0x[0-9a-fA-F]{64}$/.test(execution.tx_hash)) return;
  const { data: plan } = await db
    .from("execution_plans")
    .select("id,user_id,strategy_id,strategy_version,status")
    .eq("id", execution.execution_plan_id)
    .maybeSingle();
  if (!plan) return;

  let receipt;
  try {
    receipt = await chain.getTransactionReceipt({ hash: execution.tx_hash as Hash });
  } catch (error) {
    if (execution.status === "submitted") {
      await db.from("executions").update({ status: "confirming", updated_at: new Date().toISOString() }).eq("id", execution.id);
      await db.from("execution_plans").update({ status: "confirming", updated_at: new Date().toISOString() }).eq("id", plan.id);
    }
    const message = error instanceof Error ? error.message.toLowerCase() : "";
    if (!message.includes("not found") && !message.includes("could not be found")) console.error("StockOS receipt lookup failed", error);
    return;
  }

  const now = new Date().toISOString();
  if (receipt.status === "success") {
    await db.from("executions").update({ status: "confirmed", confirmed_at: now, failure_code: null, failure_message: null, updated_at: now }).eq("id", execution.id);
    await db.from("execution_plans").update({ status: "confirmed", updated_at: now }).eq("id", plan.id);
    await activateStrategy(plan.user_id, plan.strategy_id, plan.strategy_version);
    await db.from("audit_events").insert({
      user_id: plan.user_id,
      strategy_id: plan.strategy_id,
      event_type: "execution_confirmed",
      strategy_version: plan.strategy_version,
      metadata: { txHash: execution.tx_hash, blockNumber: receipt.blockNumber.toString(), gasUsed: receipt.gasUsed.toString() },
    });
    await capturePortfolioSnapshot(plan.user_id, plan.strategy_id);
    console.log(`Execution ${execution.id} confirmed in block ${receipt.blockNumber}`);
    return;
  }

  await db.from("executions").update({
    status: "failed",
    failure_code: "transaction_reverted",
    failure_message: "The Base transaction reverted",
    updated_at: now,
  }).eq("id", execution.id);
  await db.from("execution_plans").update({ status: "failed", updated_at: now }).eq("id", plan.id);
  await db.from("audit_events").insert({
    user_id: plan.user_id,
    strategy_id: plan.strategy_id,
    event_type: "execution_failed",
    strategy_version: plan.strategy_version,
    metadata: { txHash: execution.tx_hash, blockNumber: receipt.blockNumber.toString(), reason: "transaction_reverted" },
  });
}

async function reconcileExecutions() {
  if (reconciliationRunning) return;
  reconciliationRunning = true;
  try {
    const { data, error } = await db
      .from("executions")
      .select("id,execution_plan_id,status,tx_hash")
      .in("status", ["submitted", "confirming"])
      .not("tx_hash", "is", null)
      .order("created_at", { ascending: true })
      .limit(50);
    if (error) throw error;
    for (const execution of data ?? []) await reconcileExecution(execution);
  } catch (error) {
    console.error("StockOS execution reconciler failed", error);
  } finally {
    reconciliationRunning = false;
  }
}

async function snapshotActivePortfolios() {
  if (snapshotsRunning) return;
  snapshotsRunning = true;
  try {
    const { data, error } = await db.from("strategies").select("id,user_id").eq("status", "active").order("updated_at", { ascending: false });
    if (error) throw error;
    const seen = new Set<string>();
    for (const strategy of data ?? []) {
      if (seen.has(strategy.user_id)) continue;
      seen.add(strategy.user_id);
      await capturePortfolioSnapshot(strategy.user_id, strategy.id);
    }
  } catch (error) {
    console.error("StockOS portfolio snapshotter failed", error);
  } finally {
    snapshotsRunning = false;
  }
}

redis.on("ready", () => {
  console.log("StockOS worker connected to Redis. Execution reconciliation and portfolio monitoring are active; autonomous trading remains disabled.");
});
redis.on("error", error => console.error("StockOS worker Redis error", error));

void reconcileExecutions();
void snapshotActivePortfolios();
const reconciliationTimer = setInterval(() => void reconcileExecutions(), 10_000);
const snapshotTimer = setInterval(() => void snapshotActivePortfolios(), 60_000);
const heartbeat = setInterval(async () => {
  try {
    await redis.ping();
    console.log("StockOS worker heartbeat ok");
  } catch (error) {
    console.error("StockOS worker heartbeat failed", error);
  }
}, 60_000);

async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(reconciliationTimer);
  clearInterval(snapshotTimer);
  clearInterval(heartbeat);
  console.log(`StockOS worker shutting down after ${signal}`);
  await redis.quit().catch(() => redis.disconnect());
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
