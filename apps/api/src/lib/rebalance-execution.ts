import { randomUUID } from "node:crypto";
import { formatUnits, parseUnits } from "viem";
import { ASSETS } from "../../../../packages/b20/src/registry.ts";
import type { CompiledStrategy, SupportedAsset } from "../../../../packages/core/src/types.ts";
import { buildAerodromeSwapTransaction, getAerodromeSwapQuote, type AerodromeQuote } from "./aerodrome.ts";
import { encodeExactApproval, readAllowance, readB20ReceiveSafety, readReferencePrice, readTokenBalance, readTokenDecimals } from "./chain.ts";
import { getAdminSupabase } from "./db.ts";
import { ExecutionPreparationError } from "./execution.ts";
import { loadOwnedStrategyVersion } from "./strategy-store.ts";

const USDC = ASSETS.USDC.address!;
const USDC_DECIMALS = 6;
const QUOTE_TTL_MS = 25_000;
const SLIPPAGE = 0.005;
const REBALANCE_RESERVE_BPS = 75;
const MIN_TRADE_USD = 0.05;
const STOCKS: SupportedAsset[] = ["AAPLc", "GOOGLc", "METAc", "NVDAc"];

type PlanCall = {
  kind: "approval" | "swap";
  label: string;
  to: string;
  data: string;
  value: string;
};

type PlanCheck = { name: string; passed: boolean; detail?: string };

type LivePosition = {
  asset: SupportedAsset;
  tokenAddress: string;
  decimals: number;
  rawBalance: bigint;
  tokenUnits: number;
  priceUsd: number;
  valueUsd: number;
  targetUsd: number;
  deltaUsd: number;
};

type TradeWork = {
  direction: "sell" | "buy";
  asset: SupportedAsset;
  tokenAddress: string;
  tokenDecimals: number;
  amountIn: bigint;
  amountUsd: number;
  quote: AerodromeQuote;
};

function usdcRaw(amountUsd: number): bigint {
  if (!Number.isFinite(amountUsd) || amountUsd <= 0) throw new ExecutionPreparationError("invalid_allocation", "Allocation must be positive");
  return BigInt(Math.max(1, Math.floor(amountUsd * 10 ** USDC_DECIMALS)));
}

function rawFromUnits(units: number, decimals: number): bigint {
  if (!Number.isFinite(units) || units <= 0) return 0n;
  const precision = Math.min(decimals, 12);
  return parseUnits(units.toFixed(precision), decimals);
}

async function persistPlan(input: {
  userId: string;
  strategyId: string;
  version: number;
  status: "draft" | "ready" | "awaiting_approval";
  plan: Record<string, unknown>;
  checks: PlanCheck[];
}) {
  const db = getAdminSupabase();
  const { data, error } = await db.from("execution_plans").insert({
    user_id: input.userId,
    strategy_id: input.strategyId,
    strategy_version: input.version,
    status: input.status,
    plan: input.plan,
    policy_result: { allowed: input.checks.every(check => check.passed), checks: input.checks },
    idempotency_key: randomUUID(),
  }).select("id").single();
  if (error || !data) throw new Error(`Could not persist rebalance plan: ${error?.message ?? "unknown"}`);

  await db.from("policy_decisions").insert({
    user_id: input.userId,
    strategy_id: input.strategyId,
    execution_plan_id: data.id,
    decision: input.checks.every(check => check.passed) ? "allowed" : "blocked",
    checks: input.checks,
  });
  await db.from("audit_events").insert({
    user_id: input.userId,
    strategy_id: input.strategyId,
    event_type: "rebalance_plan_prepared",
    strategy_version: input.version,
    policy_snapshot: { checks: input.checks },
    metadata: { phase: input.plan.phase, source: "active_portfolio_delta", provider: "aerodrome" },
  });
  return data.id as string;
}

async function quoteTrade(input: {
  direction: "sell" | "buy";
  asset: SupportedAsset;
  tokenAddress: string;
  tokenDecimals: number;
  amountIn: bigint;
  amountUsd: number;
}): Promise<TradeWork> {
  const fromToken = input.direction === "sell" ? input.tokenAddress : USDC;
  const fromSymbol = input.direction === "sell" ? input.asset : "USDC";
  const fromDecimals = input.direction === "sell" ? input.tokenDecimals : USDC_DECIMALS;
  const toToken = input.direction === "sell" ? USDC : input.tokenAddress;
  const toSymbol = input.direction === "sell" ? "USDC" : input.asset;
  const toDecimals = input.direction === "sell" ? USDC_DECIMALS : input.tokenDecimals;
  const quote = await getAerodromeSwapQuote({
    fromToken,
    fromSymbol,
    fromDecimals,
    toToken,
    toSymbol,
    toDecimals,
    amountIn: input.amountIn,
  });
  if (!quote) {
    throw new ExecutionPreparationError(
      "aerodrome_liquidity_unavailable",
      `Aerodrome could not find a direct ${fromSymbol} to ${toSymbol} route.`,
      409,
    );
  }
  return { ...input, quote };
}

async function readLivePositions(account: string, compiled: CompiledStrategy): Promise<{ positions: LivePosition[]; totalValueUsd: number; currentUsdc: bigint }> {
  const targets = new Map(compiled.allocations.map(allocation => [allocation.asset, Number(allocation.amountUsd)]));
  const positions: LivePosition[] = [];

  for (const asset of STOCKS) {
    const record = ASSETS[asset];
    if (!record?.enabled || !record.address) continue;
    const [rawBalance, decimals, reference] = await Promise.all([
      readTokenBalance(record.address, account),
      record.decimals == null ? readTokenDecimals(record.address) : Promise.resolve(record.decimals),
      readReferencePrice(asset),
    ]);
    if (!reference.configured || !Number.isFinite(reference.priceUsd)) {
      throw new ExecutionPreparationError("reference_price_unavailable", `${asset} reference price is unavailable`, 409);
    }
    const tokenUnits = Number(formatUnits(rawBalance, Number(decimals)));
    const priceUsd = Number(reference.priceUsd);
    const valueUsd = tokenUnits * priceUsd;
    const targetUsd = targets.get(asset) ?? 0;
    positions.push({ asset, tokenAddress: record.address, decimals: Number(decimals), rawBalance, tokenUnits, priceUsd, valueUsd, targetUsd, deltaUsd: targetUsd - valueUsd });
  }

  const currentUsdc = await readTokenBalance(USDC, account);
  const currentCashUsd = Number(formatUnits(currentUsdc, USDC_DECIMALS));
  const totalValueUsd = positions.reduce((sum, position) => sum + position.valueUsd, currentCashUsd);
  return { positions, totalValueUsd, currentUsdc };
}

export async function shouldPrepareRebalance(input: { userId: string; strategyVersionId: string }) {
  const { version, strategy } = await loadOwnedStrategyVersion(input.userId, input.strategyVersionId);
  return strategy.status === "active" && Number(version.version) > Number(strategy.current_version ?? 0);
}

export async function prepareRebalanceExecution(input: {
  userId: string;
  smartAccountAddress: string;
  strategyVersionId: string;
}) {
  const { version, strategy } = await loadOwnedStrategyVersion(input.userId, input.strategyVersionId);
  if (strategy.status !== "active" || Number(version.version) <= Number(strategy.current_version ?? 0)) {
    throw new ExecutionPreparationError("not_active_amendment", "This strategy version is not a pending amendment to the active portfolio", 409);
  }

  const compiled = version.compiled_strategy as CompiledStrategy;
  const live = await readLivePositions(input.smartAccountAddress, compiled);
  const targetCapital = Number(compiled.totalUsd);
  const capitalDrift = Math.abs(live.totalValueUsd - targetCapital);
  const checks: PlanCheck[] = [
    { name: "active_strategy_amendment", passed: true, detail: `version ${strategy.current_version} → ${version.version}` },
    { name: "live_portfolio_value", passed: true, detail: `$${live.totalValueUsd.toFixed(2)} current vs $${targetCapital.toFixed(2)} target capital` },
    { name: "capital_consistency", passed: capitalDrift <= Math.max(1, live.totalValueUsd * 0.05), detail: `capital drift $${capitalDrift.toFixed(2)}` },
  ];
  if (!checks[2].passed) {
    const plan = { phase: "blocked", executable: false, calls: [] as PlanCall[], reason: "Target capital differs materially from the live portfolio. Refresh and compile the adjustment again." };
    const planId = await persistPlan({ userId: input.userId, strategyId: strategy.id, version: version.version, status: "draft", plan, checks });
    return { planId, ...plan, checks };
  }

  const sellCandidates = live.positions.filter(position => position.deltaUsd < -MIN_TRADE_USD && position.valueUsd > 0);
  const buyCandidates = live.positions.filter(position => position.deltaUsd > MIN_TRADE_USD);
  const sells: TradeWork[] = [];
  for (const position of sellCandidates) {
    const sellUsd = Math.min(-position.deltaUsd, position.valueUsd);
    const sellUnits = Math.min(position.tokenUnits, sellUsd / position.priceUsd);
    const amountIn = rawFromUnits(sellUnits, position.decimals);
    if (amountIn <= 0n) continue;
    sells.push(await quoteTrade({ direction: "sell", asset: position.asset, tokenAddress: position.tokenAddress, tokenDecimals: position.decimals, amountIn, amountUsd: sellUsd }));
  }

  const expectedSellUsdc = sells.reduce((sum, trade) => sum + trade.quote.amountOut, 0n);
  const availableUsdc = live.currentUsdc + expectedSellUsdc;
  const reserveFactor = (10_000 - REBALANCE_RESERVE_BPS) / 10_000;
  const requestedBuyUsd = buyCandidates.reduce((sum, position) => sum + position.deltaUsd, 0);
  const maxBuyUsd = Number(formatUnits(availableUsdc, USDC_DECIMALS)) * reserveFactor;
  const buyScale = requestedBuyUsd > 0 ? Math.min(1, maxBuyUsd / requestedBuyUsd) : 1;
  const buys: TradeWork[] = [];
  for (const position of buyCandidates) {
    const buyUsd = position.deltaUsd * buyScale;
    if (buyUsd < MIN_TRADE_USD) continue;
    const safety = await readB20ReceiveSafety(position.tokenAddress, input.smartAccountAddress);
    if (safety.transferPaused) throw new ExecutionPreparationError("b20_transfer_paused", `${position.asset} transfers are currently paused`, 409);
    if (!safety.receiverAuthorized) throw new ExecutionPreparationError("b20_receiver_not_authorized", `This Smart Account is not authorized to receive ${position.asset}`, 403);
    buys.push(await quoteTrade({ direction: "buy", asset: position.asset, tokenAddress: position.tokenAddress, tokenDecimals: position.decimals, amountIn: usdcRaw(buyUsd), amountUsd: buyUsd }));
  }

  if (!sells.length && !buys.length) {
    const plan = { phase: "blocked", executable: false, calls: [] as PlanCall[], reason: "The portfolio is already within the minimum rebalance threshold." };
    const planId = await persistPlan({ userId: input.userId, strategyId: strategy.id, version: version.version, status: "draft", plan, checks: [...checks, { name: "trade_delta", passed: true, detail: "No material delta" }] });
    return { planId, ...plan, checks };
  }

  const allTrades = [...sells, ...buys];
  const spenders = new Set(allTrades.map(trade => trade.quote.spenderAddress.toLowerCase()));
  if (spenders.size !== 1) throw new ExecutionPreparationError("aerodrome_spender_mismatch", "Aerodrome returned inconsistent spenders across rebalance routes", 409);
  const spender = allTrades[0].quote.spenderAddress;

  const approvals: PlanCall[] = [];
  for (const trade of sells) {
    const allowance = await readAllowance(trade.tokenAddress, input.smartAccountAddress, spender);
    if (allowance < trade.amountIn) {
      approvals.push({ kind: "approval", label: `Approve ${trade.asset} sell for rebalance`, to: trade.tokenAddress, data: encodeExactApproval(spender, trade.amountIn), value: "0" });
    }
  }
  const totalBuyUsdc = buys.reduce((sum, trade) => sum + trade.amountIn, 0n);
  if (totalBuyUsdc > 0n) {
    const allowance = await readAllowance(USDC, input.smartAccountAddress, spender);
    if (allowance < totalBuyUsdc) {
      approvals.push({ kind: "approval", label: `Approve exactly ${formatUnits(totalBuyUsdc, USDC_DECIMALS)} USDC for rebalance`, to: USDC, data: encodeExactApproval(spender, totalBuyUsdc), value: "0" });
    }
  }

  const pricing = allTrades.map(trade => ({
    direction: trade.direction,
    asset: trade.asset,
    amountUsd: trade.amountUsd,
    amountIn: trade.amountIn.toString(),
    amountOut: trade.quote.amountOut.toString(),
    routeAvailable: true,
    routeHops: trade.quote.path.length,
  }));

  if (approvals.length) {
    const plan = {
      phase: "allowance_required",
      strategyVersionId: version.id,
      amendment: true,
      fromVersion: strategy.current_version,
      toVersion: version.version,
      executable: true,
      userApprovalRequired: true,
      pricingProvider: "aerodrome",
      pricingType: "rebalance_delta_indicative",
      pricing,
      calls: approvals,
    };
    const planId = await persistPlan({ userId: input.userId, strategyId: strategy.id, version: version.version, status: "awaiting_approval", plan, checks: [...checks, { name: "rebalance_allowances", passed: true, detail: `${approvals.length} exact approval(s) required` }] });
    return { planId, ...plan, checks };
  }

  const calls: PlanCall[] = [];
  const freshPricing: typeof pricing = [];
  for (const trade of allTrades) {
    const fresh = await quoteTrade({ direction: trade.direction, asset: trade.asset, tokenAddress: trade.tokenAddress, tokenDecimals: trade.tokenDecimals, amountIn: trade.amountIn, amountUsd: trade.amountUsd });
    const transaction = await buildAerodromeSwapTransaction({ quote: fresh.quote, account: input.smartAccountAddress, slippage: SLIPPAGE });
    calls.push({
      kind: "swap",
      label: `${trade.direction === "sell" ? "Sell" : "Buy"} ${trade.asset} for portfolio rebalance`,
      to: transaction.to,
      data: transaction.data,
      value: transaction.value?.toString() ?? "0",
    });
    freshPricing.push({ direction: fresh.direction, asset: fresh.asset, amountUsd: fresh.amountUsd, amountIn: fresh.amountIn.toString(), amountOut: fresh.quote.amountOut.toString(), routeAvailable: true, routeHops: fresh.quote.path.length });
  }

  const expiresAt = new Date(Date.now() + QUOTE_TTL_MS).toISOString();
  const plan = {
    phase: "ready",
    strategyVersionId: version.id,
    amendment: true,
    fromVersion: strategy.current_version,
    toVersion: version.version,
    executable: true,
    userApprovalRequired: true,
    expiresAt,
    pricingProvider: "aerodrome",
    pricingType: "rebalance_delta_firm_quote",
    pricing: freshPricing,
    calls,
  };
  const planId = await persistPlan({ userId: input.userId, strategyId: strategy.id, version: version.version, status: "ready", plan, checks: [...checks, { name: "rebalance_delta", passed: true, detail: `${sells.length} sell(s), ${buys.length} buy(s)` }] });
  return { planId, ...plan, checks };
}
