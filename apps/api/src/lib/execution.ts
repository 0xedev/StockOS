import { randomUUID } from "node:crypto";
import { formatUnits, isAddress } from "viem";
import { ASSETS } from "../../../../packages/b20/src/registry.ts";
import type { CompiledStrategy, InvestmentIntent, SupportedAsset } from "../../../../packages/core/src/types.ts";
import { ZeroXClient, type ZeroXSwapResponse } from "../../../../packages/execution/src/zerox.ts";
import { encodeExactApproval, readAllowance, readReferencePrice, readTokenBalance, readTokenDecimals } from "./chain.ts";
import { getAdminSupabase } from "./db.ts";
import { loadOwnedStrategyVersion } from "./strategy-store.ts";

const USDC = ASSETS.USDC.address!;
const USDC_DECIMALS = 6;
const QUOTE_TTL_MS = 25_000;

export class ExecutionPreparationError extends Error {
  constructor(public code: string, message: string, public statusCode = 400) { super(message); }
}

type PlanCall = { kind: "approval" | "swap"; label: string; to: string; data: string; value: string };
type PlanCheck = { name: string; passed: boolean; detail?: string };

type PriceWork = {
  asset: SupportedAsset;
  allocationUsd: number;
  sellAmount: bigint;
  tokenAddress: string;
  response: ZeroXSwapResponse;
  allowanceTarget: string;
};

function usdcRaw(amountUsd: number): bigint {
  if (!Number.isFinite(amountUsd) || amountUsd <= 0) throw new ExecutionPreparationError("invalid_allocation", "Allocation must be positive");
  return BigInt(Math.round(amountUsd * 10 ** USDC_DECIMALS));
}

function targetFrom(response: ZeroXSwapResponse): string {
  const target = response.issues?.allowance?.spender ?? response.allowanceTarget;
  if (!target || !isAddress(target)) throw new ExecutionPreparationError("invalid_0x_allowance_target", "0x did not return a valid AllowanceHolder target", 502);
  return target;
}

function assertPriceResponse(response: ZeroXSwapResponse, asset: SupportedAsset) {
  if (response.liquidityAvailable === false) throw new ExecutionPreparationError("liquidity_unavailable", `No 0x liquidity is available for ${asset}`, 409);
  if (response.issues?.balance) throw new ExecutionPreparationError("insufficient_usdc", "Smart account does not have enough USDC for this strategy", 409);
}

function assertFirmQuote(response: ZeroXSwapResponse, expectedTarget: string, asset: SupportedAsset) {
  if (response.liquidityAvailable === false) throw new ExecutionPreparationError("liquidity_unavailable", `No 0x liquidity is available for ${asset}`, 409);
  if (response.issues?.balance) throw new ExecutionPreparationError("insufficient_usdc", "Smart account does not have enough USDC", 409);
  if (response.issues?.allowance) throw new ExecutionPreparationError("allowance_changed", "USDC allowance changed; refresh the execution plan", 409);
  if (response.issues?.simulationIncomplete) throw new ExecutionPreparationError("simulation_incomplete", `0x could not fully simulate the ${asset} quote`, 409);
  if (!response.transaction || !isAddress(response.transaction.to) || !response.transaction.data?.startsWith("0x")) {
    throw new ExecutionPreparationError("invalid_0x_transaction", `0x returned invalid transaction data for ${asset}`, 502);
  }
  if (response.transaction.to.toLowerCase() !== expectedTarget.toLowerCase()) {
    throw new ExecutionPreparationError("unexpected_0x_target", `0x execution target changed for ${asset}`, 409);
  }
  if (!response.buyAmount || BigInt(response.buyAmount) <= 0n) throw new ExecutionPreparationError("invalid_buy_amount", `0x returned no buy amount for ${asset}`, 502);
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
  if (error || !data) throw new Error(`Could not persist execution plan: ${error?.message ?? "unknown"}`);
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
    event_type: "execution_plan_prepared",
    strategy_version: input.version,
    policy_snapshot: { checks: input.checks },
    metadata: { phase: input.plan.phase },
  });
  return data.id as string;
}

export async function prepareExecution(input: { userId: string; smartAccountAddress: string; strategyVersionId: string }) {
  if (!process.env.ZEROX_API_KEY) throw new ExecutionPreparationError("zerox_not_configured", "0x is not configured", 503);
  const { version, strategy } = await loadOwnedStrategyVersion(input.userId, input.strategyVersionId);
  const compiled = version.compiled_strategy as CompiledStrategy;
  const intent = version.parsed_intent as InvestmentIntent;
  const stockAllocations = compiled.allocations.filter(allocation => allocation.asset !== "USDC" && allocation.amountUsd > 0);
  if (!stockAllocations.length) throw new ExecutionPreparationError("nothing_to_execute", "Strategy has no stock allocations");

  const priceWork: PriceWork[] = [];
  const zeroX = new ZeroXClient(process.env.ZEROX_API_KEY);
  for (const allocation of stockAllocations) {
    const record = ASSETS[allocation.asset];
    if (!record?.enabled || !record.address) throw new ExecutionPreparationError("asset_not_verified", `${allocation.asset} is not enabled for execution`, 409);
    const sellAmount = usdcRaw(allocation.amountUsd);
    const response = await zeroX.price({ sellToken: USDC, buyToken: record.address, sellAmount: sellAmount.toString(), taker: input.smartAccountAddress, slippageBps: 50 });
    assertPriceResponse(response, allocation.asset);
    priceWork.push({ asset: allocation.asset, allocationUsd: allocation.amountUsd, sellAmount, tokenAddress: record.address, response, allowanceTarget: targetFrom(response) });
  }

  const allowanceTargets = new Set(priceWork.map(work => work.allowanceTarget.toLowerCase()));
  if (allowanceTargets.size !== 1) throw new ExecutionPreparationError("allowance_target_mismatch", "0x returned inconsistent allowance targets", 409);
  const allowanceTarget = priceWork[0].allowanceTarget;
  const totalSell = priceWork.reduce((sum, work) => sum + work.sellAmount, 0n);
  const [balance, allowance] = await Promise.all([
    readTokenBalance(USDC, input.smartAccountAddress),
    readAllowance(USDC, input.smartAccountAddress, allowanceTarget),
  ]);
  if (balance < totalSell) throw new ExecutionPreparationError("insufficient_usdc", `Strategy needs ${formatUnits(totalSell, USDC_DECIMALS)} USDC but the smart account balance is lower`, 409);

  if (allowance < totalSell) {
    const calls: PlanCall[] = [{
      kind: "approval",
      label: `Approve exactly ${formatUnits(totalSell, USDC_DECIMALS)} USDC for 0x AllowanceHolder`,
      to: USDC,
      data: encodeExactApproval(allowanceTarget, totalSell),
      value: "0",
    }];
    const checks: PlanCheck[] = [
      { name: "asset_registry", passed: true },
      { name: "usdc_balance", passed: true },
      { name: "exact_allowance", passed: true, detail: `${formatUnits(totalSell, USDC_DECIMALS)} USDC; no unlimited approval` },
    ];
    const plan = {
      phase: "allowance_required",
      strategyVersionId: version.id,
      allowanceTarget,
      requiredAllowance: totalSell.toString(),
      currentAllowance: allowance.toString(),
      calls,
      executable: true,
    };
    const planId = await persistPlan({ userId: input.userId, strategyId: strategy.id, version: version.version, status: "awaiting_approval", plan, checks });
    return { planId, ...plan, checks };
  }

  const maxDeviationBps = Number(process.env.MAX_REFERENCE_DEVIATION_BPS ?? 200);
  const maxStaleness = Number(process.env.MAX_REFERENCE_STALENESS_SECONDS ?? 300);
  const calls: PlanCall[] = [];
  const checks: PlanCheck[] = [
    { name: "asset_registry", passed: true },
    { name: "usdc_balance", passed: true },
    { name: "usdc_allowance", passed: true, detail: `AllowanceHolder has at least ${formatUnits(totalSell, USDC_DECIMALS)} USDC allowance` },
  ];
  const quoteSummaries: Array<Record<string, unknown>> = [];
  const rawQuotes: Array<{ asset: SupportedAsset; sellAmount: string; response: ZeroXSwapResponse; expiresAt: string }> = [];
  const expiresAt = new Date(Date.now() + QUOTE_TTL_MS).toISOString();

  for (const work of priceWork) {
    const quote = await zeroX.quote({ sellToken: USDC, buyToken: work.tokenAddress, sellAmount: work.sellAmount.toString(), taker: input.smartAccountAddress, slippageBps: 50 });
    assertFirmQuote(quote, allowanceTarget, work.asset);
    const tokenDecimals = await readTokenDecimals(work.tokenAddress);
    const buyQuantity = Number(formatUnits(BigInt(quote.buyAmount!), tokenDecimals));
    if (!Number.isFinite(buyQuantity) || buyQuantity <= 0) throw new ExecutionPreparationError("invalid_buy_quantity", `Could not interpret ${work.asset} buy amount`, 502);
    const sellUsd = Number(formatUnits(BigInt(quote.sellAmount ?? work.sellAmount.toString()), USDC_DECIMALS));
    const effectivePriceUsd = sellUsd / buyQuantity;
    const reference = await readReferencePrice(work.asset);
    const referenceConfigured = reference.configured && typeof reference.priceUsd === "number";
    const referenceFresh = referenceConfigured && (reference.ageSeconds ?? Number.POSITIVE_INFINITY) <= maxStaleness;
    const deviationBps = referenceConfigured ? Math.round(Math.abs(effectivePriceUsd - reference.priceUsd!) / reference.priceUsd! * 10_000) : null;
    const referenceWithinDeviation = deviationBps != null && deviationBps <= maxDeviationBps;
    checks.push({ name: `reference_configured:${work.asset}`, passed: referenceConfigured, detail: reference.feed ?? "Set a verified Chainlink total-return feed address" });
    checks.push({ name: `reference_fresh:${work.asset}`, passed: !!referenceFresh, detail: reference.updatedAt ? `${reference.ageSeconds}s old` : "No feed data" });
    checks.push({ name: `reference_deviation:${work.asset}`, passed: !!referenceWithinDeviation, detail: deviationBps == null ? "Unavailable" : `${deviationBps} bps <= ${maxDeviationBps} bps` });
    calls.push({ kind: "swap", label: `Swap ${sellUsd} USDC → ${work.asset}`, to: quote.transaction!.to, data: quote.transaction!.data, value: quote.transaction!.value ?? "0" });
    quoteSummaries.push({ asset: work.asset, sellUsd, buyAmount: quote.buyAmount, tokenDecimals, buyQuantity, effectivePriceUsd, reference, deviationBps });
    rawQuotes.push({ asset: work.asset, sellAmount: work.sellAmount.toString(), response: quote, expiresAt });
  }

  const executable = checks.every(check => check.passed);
  const plan = {
    phase: executable ? "ready" : "blocked",
    strategyVersionId: version.id,
    allowanceTarget,
    calls,
    quotes: quoteSummaries,
    expiresAt,
    executable,
    userApprovalRequired: true,
  };
  const planId = await persistPlan({ userId: input.userId, strategyId: strategy.id, version: version.version, status: executable ? "ready" : "draft", plan, checks });
  const db = getAdminSupabase();
  for (const item of rawQuotes) {
    await db.from("quotes").insert({
      user_id: input.userId,
      provider: "0x",
      chain_id: 8453,
      sell_token: USDC,
      buy_token: ASSETS[item.asset].address,
      sell_amount: item.sellAmount,
      buy_amount: item.response.buyAmount ?? null,
      min_buy_amount: item.response.minBuyAmount ?? null,
      route: item.response.route ?? null,
      raw_quote: item.response,
      expires_at: item.expiresAt,
    });
  }
  return { planId, ...plan, checks };
}

export async function markPlanSubmitted(input: { userId: string; planId: string; transactionHash: string }) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(input.transactionHash)) throw new ExecutionPreparationError("invalid_transaction_hash", "Invalid transaction hash");
  const db = getAdminSupabase();
  const { data: row, error } = await db.from("execution_plans").select("id,user_id,strategy_id,strategy_version,status,plan").eq("id", input.planId).maybeSingle();
  if (error || !row || row.user_id !== input.userId) throw new ExecutionPreparationError("plan_not_found", "Execution plan not found", 404);
  if (!new Set(["ready", "awaiting_approval"]).has(row.status)) throw new ExecutionPreparationError("plan_not_submittable", "Execution plan is not awaiting submission", 409);
  const phase = (row.plan as any)?.phase;
  if (phase === "ready") {
    const expiresAt = Date.parse((row.plan as any)?.expiresAt ?? "");
    if (!Number.isFinite(expiresAt) || Date.now() > expiresAt) throw new ExecutionPreparationError("quote_expired", "Execution quote expired; prepare a fresh plan", 409);
    await db.from("executions").insert({
      execution_plan_id: row.id,
      status: "submitted",
      authorization_type: "user_approved_cdp_user_operation",
      tx_hash: input.transactionHash,
      submitted_at: new Date().toISOString(),
    });
  }
  await db.from("execution_plans").update({ status: "submitted", updated_at: new Date().toISOString() }).eq("id", row.id);
  await db.from("audit_events").insert({
    user_id: input.userId,
    strategy_id: row.strategy_id,
    event_type: phase === "allowance_required" ? "allowance_submitted" : "execution_submitted",
    strategy_version: row.strategy_version,
    authorization_type: "user_approved_cdp_user_operation",
    tx_hash: input.transactionHash,
    metadata: { executionPlanId: row.id },
  });
  return { ok: true, phase, transactionHash: input.transactionHash };
}
