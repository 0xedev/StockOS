import { randomUUID } from "node:crypto";
import { formatUnits, isAddress } from "viem";
import { ASSETS } from "../../../../packages/b20/src/registry.ts";
import type { CompiledStrategy, SupportedAsset } from "../../../../packages/core/src/types.ts";
import { ZeroXClient, type ZeroXSwapResponse } from "../../../../packages/execution/src/zerox.ts";
import { encodeExactApproval, readAllowance, readB20ReceiveSafety, readReferencePrice, readTokenBalance, readTokenDecimals } from "./chain.ts";
import { getCdpSwapPriceProbe } from "./cdp-trade.ts";
import { getAdminSupabase } from "./db.ts";
import { loadOwnedStrategyVersion } from "./strategy-store.ts";

const USDC = ASSETS.USDC.address!;
const USDC_DECIMALS = 6;
const QUOTE_TTL_MS = 25_000;

type IndicativeProvider = "coinbase_cdp" | "0x";

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
  provider: IndicativeProvider;
  allowanceTarget: string | null;
  b20Safety: { transferPaused: boolean; receiverPolicyId: bigint; receiverAuthorized: boolean };
};

function usdcRaw(amountUsd: number): bigint {
  if (!Number.isFinite(amountUsd) || amountUsd <= 0) throw new ExecutionPreparationError("invalid_allocation", "Allocation must be positive");
  return BigInt(Math.round(amountUsd * 10 ** USDC_DECIMALS));
}

function targetFrom(response: ZeroXSwapResponse): string | null {
  const target = response.issues?.allowance?.spender ?? response.allowanceTarget;
  return target && isAddress(target) ? target : null;
}

function assertPriceResponse(response: ZeroXSwapResponse, asset: SupportedAsset, provider: IndicativeProvider) {
  const providerName = provider === "coinbase_cdp" ? "Coinbase CDP" : "0x";
  if (response.liquidityAvailable === false) throw new ExecutionPreparationError("liquidity_unavailable", `No ${providerName} liquidity is available for ${asset}`, 409);
  if (!response.buyAmount || BigInt(response.buyAmount) <= 0n) throw new ExecutionPreparationError("invalid_buy_amount", `${providerName} returned no indicative buy amount for ${asset}`, 502);
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

async function getIndicativePrice(input: {
  asset: SupportedAsset;
  tokenAddress: string;
  sellAmount: bigint;
  smartAccountAddress: string;
  zeroX: ZeroXClient | null;
}): Promise<{ provider: IndicativeProvider; response: ZeroXSwapResponse }> {
  let cdpFailure: unknown = null;
  try {
    const cdp = await getCdpSwapPriceProbe({
      fromToken: USDC,
      toToken: input.tokenAddress,
      fromAmount: input.sellAmount,
      taker: input.smartAccountAddress,
      slippageBps: 50,
    });
    if (cdp.liquidityAvailable && cdp.toAmount && BigInt(cdp.toAmount) > 0n) {
      return {
        provider: "coinbase_cdp",
        response: {
          liquidityAvailable: true,
          sellAmount: input.sellAmount.toString(),
          buyAmount: cdp.toAmount,
          minBuyAmount: cdp.minToAmount ?? undefined,
          allowanceTarget: cdp.allowanceSpender ?? undefined,
          issues: {
            allowance: cdp.allowanceSpender ? { spender: cdp.allowanceSpender } : null,
            balance: cdp.balanceIssue ? { token: USDC } : null,
            simulationIncomplete: cdp.simulationIncomplete,
          },
          route: { provider: "coinbase_cdp_trade_api" },
        },
      };
    }
    cdpFailure = new Error(`Coinbase CDP reported no liquidity for ${input.asset}`);
  } catch (error) {
    cdpFailure = error;
  }

  if (input.zeroX) {
    try {
      const response = await input.zeroX.price({
        sellToken: USDC,
        buyToken: input.tokenAddress,
        sellAmount: input.sellAmount.toString(),
        taker: input.smartAccountAddress,
        slippageBps: 50,
      });
      return { provider: "0x", response };
    } catch (zeroXError) {
      const cdpMessage = cdpFailure instanceof Error ? cdpFailure.message : "Coinbase CDP price discovery failed";
      const zeroXMessage = zeroXError instanceof Error ? zeroXError.message : "0x price discovery failed";
      throw new ExecutionPreparationError(
        "execution_pricing_unavailable",
        `Neither Coinbase CDP nor 0x could price ${input.asset}. Coinbase: ${cdpMessage}. 0x: ${zeroXMessage}`,
        503,
      );
    }
  }

  throw new ExecutionPreparationError(
    "cdp_trade_pricing_unavailable",
    cdpFailure instanceof Error ? `Coinbase CDP could not price ${input.asset}: ${cdpFailure.message}` : `Coinbase CDP could not price ${input.asset}`,
    503,
  );
}

export async function prepareExecution(input: { userId: string; smartAccountAddress: string; strategyVersionId: string }) {
  const { version, strategy } = await loadOwnedStrategyVersion(input.userId, input.strategyVersionId);
  const compiled = version.compiled_strategy as CompiledStrategy;
  const stockAllocations = compiled.allocations.filter(allocation => allocation.asset !== "USDC" && allocation.amountUsd > 0);
  if (!stockAllocations.length) throw new ExecutionPreparationError("nothing_to_execute", "Strategy has no stock allocations");

  const priceWork: PriceWork[] = [];
  const zeroX = process.env.ZEROX_API_KEY ? new ZeroXClient(process.env.ZEROX_API_KEY) : null;
  for (const allocation of stockAllocations) {
    const record = ASSETS[allocation.asset];
    if (!record?.enabled || !record.address) throw new ExecutionPreparationError("asset_not_verified", `${allocation.asset} is not enabled for execution`, 409);

    const b20Safety = await readB20ReceiveSafety(record.address, input.smartAccountAddress);
    if (b20Safety.transferPaused) {
      throw new ExecutionPreparationError("b20_transfer_paused", `${allocation.asset} transfers are currently paused by the issuer`, 409);
    }
    if (!b20Safety.receiverAuthorized) {
      throw new ExecutionPreparationError("b20_receiver_not_authorized", `This Smart Account is not authorized to receive ${allocation.asset}`, 403);
    }

    const sellAmount = usdcRaw(allocation.amountUsd);
    const priced = await getIndicativePrice({
      asset: allocation.asset,
      tokenAddress: record.address,
      sellAmount,
      smartAccountAddress: input.smartAccountAddress,
      zeroX,
    });
    assertPriceResponse(priced.response, allocation.asset, priced.provider);
    priceWork.push({
      asset: allocation.asset,
      allocationUsd: allocation.amountUsd,
      sellAmount,
      tokenAddress: record.address,
      response: priced.response,
      provider: priced.provider,
      allowanceTarget: targetFrom(priced.response),
      b20Safety,
    });
  }

  const totalSell = priceWork.reduce((sum, work) => sum + work.sellAmount, 0n);
  const totalPortfolioUsd = compiled.allocations.reduce((sum, allocation) => sum + Number(allocation.amountUsd ?? 0), 0);
  const requiredCapital = usdcRaw(totalPortfolioUsd);
  const balance = await readTokenBalance(USDC, input.smartAccountAddress);
  const providers = [...new Set(priceWork.map(work => work.provider))];
  const pricingProvider = providers.length === 1 ? providers[0] : "mixed";
  const b20Checks: PlanCheck[] = priceWork.flatMap(work => [
    { name: `b20_transfer_unpaused:${work.asset}`, passed: !work.b20Safety.transferPaused },
    { name: `b20_receiver_authorized:${work.asset}`, passed: work.b20Safety.receiverAuthorized, detail: `receiver policy ${work.b20Safety.receiverPolicyId.toString()}` },
    { name: `${work.provider === "coinbase_cdp" ? "cdp" : "zerox"}_liquidity:${work.asset}`, passed: true, detail: `Live ${work.provider === "coinbase_cdp" ? "Coinbase CDP" : "0x"} indicative pricing available` },
  ]);

  const indicativePricing = await Promise.all(priceWork.map(async work => {
    const tokenDecimals = await readTokenDecimals(work.tokenAddress);
    const buyAmount = work.response.buyAmount!;
    const buyQuantity = Number(formatUnits(BigInt(buyAmount), tokenDecimals));
    return {
      asset: work.asset,
      provider: work.provider,
      sellUsd: work.allocationUsd,
      buyAmount,
      tokenDecimals,
      buyQuantity: Number.isFinite(buyQuantity) ? buyQuantity : null,
      routeAvailable: !!work.response.route,
      balanceIssue: !!work.response.issues?.balance,
    };
  }));

  if (balance < requiredCapital) {
    const fundingShortfall = requiredCapital - balance;
    const checks: PlanCheck[] = [
      { name: "asset_registry", passed: true },
      ...b20Checks,
      {
        name: "usdc_funding",
        passed: false,
        detail: `${formatUnits(balance, USDC_DECIMALS)} / ${formatUnits(requiredCapital, USDC_DECIMALS)} USDC funded; ${formatUnits(fundingShortfall, USDC_DECIMALS)} USDC still needed`,
      },
    ];
    const plan = {
      phase: "funding_required",
      strategyVersionId: version.id,
      requiredCapital: requiredCapital.toString(),
      requiredStockSpend: totalSell.toString(),
      currentBalance: balance.toString(),
      fundingShortfall: fundingShortfall.toString(),
      pricingProvider,
      pricingType: pricingProvider === "coinbase_cdp" ? "indicative_cdp_price" : pricingProvider === "0x" ? "indicative_0x_price" : "indicative_multi_provider_price",
      pricing: indicativePricing,
      calls: [] as PlanCall[],
      executable: false,
      userApprovalRequired: false,
    };
    const planId = await persistPlan({ userId: input.userId, strategyId: strategy.id, version: version.version, status: "draft", plan, checks });
    return { planId, ...plan, checks };
  }

  if (priceWork.some(work => work.provider === "coinbase_cdp")) {
    throw new ExecutionPreparationError(
      "cdp_trade_quote_adapter_pending",
      "Coinbase CDP can price this B20 route. StockOS has not yet enabled the firm CDP quote/execution adapter, so no transaction was created.",
      409,
    );
  }

  if (!zeroX) throw new ExecutionPreparationError("zerox_not_configured", "0x is not configured for the fallback execution route", 503);
  const allowanceTargets = priceWork.map(work => work.allowanceTarget);
  if (allowanceTargets.some(target => !target)) {
    throw new ExecutionPreparationError("invalid_0x_allowance_target", "0x did not return a valid AllowanceHolder target", 502);
  }
  const normalizedTargets = new Set((allowanceTargets as string[]).map(target => target.toLowerCase()));
  if (normalizedTargets.size !== 1) throw new ExecutionPreparationError("allowance_target_mismatch", "0x returned inconsistent allowance targets", 409);
  const allowanceTarget = allowanceTargets[0] as string;
  const allowance = await readAllowance(USDC, input.smartAccountAddress, allowanceTarget);

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
      ...b20Checks,
      { name: "usdc_balance", passed: true, detail: `${formatUnits(balance, USDC_DECIMALS)} USDC covers full ${formatUnits(requiredCapital, USDC_DECIMALS)} USDC portfolio capital` },
      { name: "exact_allowance", passed: true, detail: `${formatUnits(totalSell, USDC_DECIMALS)} USDC stock spend; no unlimited approval` },
    ];
    const plan = {
      phase: "allowance_required",
      strategyVersionId: version.id,
      allowanceTarget,
      requiredCapital: requiredCapital.toString(),
      requiredAllowance: totalSell.toString(),
      currentAllowance: allowance.toString(),
      pricingProvider: "0x",
      pricingType: "indicative_0x_price",
      pricing: indicativePricing,
      calls,
      executable: true,
    };
    const planId = await persistPlan({ userId: input.userId, strategyId: strategy.id, version: version.version, status: "awaiting_approval", plan, checks });
    return { planId, ...plan, checks };
  }

  const maxDeviationBps = Number(process.env.MAX_REFERENCE_DEVIATION_BPS ?? 200);
  const maxStaleness = Number(process.env.MAX_REFERENCE_STALENESS_SECONDS ?? 345600);
  const calls: PlanCall[] = [];
  const checks: PlanCheck[] = [
    { name: "asset_registry", passed: true },
    ...b20Checks,
    { name: "usdc_balance", passed: true, detail: `${formatUnits(balance, USDC_DECIMALS)} USDC covers full ${formatUnits(requiredCapital, USDC_DECIMALS)} USDC portfolio capital` },
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
    checks.push({ name: `reference_fresh:${work.asset}`, passed: !!referenceFresh, detail: reference.updatedAt ? `${reference.ageSeconds}s old; max ${maxStaleness}s` : "No feed data" });
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
    requiredCapital: requiredCapital.toString(),
    calls,
    quotes: quoteSummaries,
    pricingProvider: "0x",
    pricingType: "firm_0x_quote",
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
