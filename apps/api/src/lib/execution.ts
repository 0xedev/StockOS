import { randomUUID } from "node:crypto";
import { formatUnits, isAddress } from "viem";
import { ASSETS } from "../../../../packages/b20/src/registry.ts";
import type { CompiledStrategy, SupportedAsset } from "../../../../packages/core/src/types.ts";
import { buildAerodromeSwapTransaction, getAerodromeSwapQuote, type AerodromeQuote } from "./aerodrome.ts";
import { encodeExactApproval, readAllowance, readB20ReceiveSafety, readReferencePrice, readTokenBalance, readTokenDecimals } from "./chain.ts";
import { getAdminSupabase } from "./db.ts";
import { loadOwnedStrategyVersion } from "./strategy-store.ts";

const USDC = ASSETS.USDC.address!;
const USDC_DECIMALS = 6;
const QUOTE_TTL_MS = 25_000;
const AERODROME_SLIPPAGE = 0.005;

export class ExecutionPreparationError extends Error {
  constructor(public code: string, message: string, public statusCode = 400) {
    super(message);
  }
}

type PlanCall = {
  kind: "approval" | "swap";
  label: string;
  to: string;
  data: string;
  value: string;
};

type PlanCheck = {
  name: string;
  passed: boolean;
  detail?: string;
};

type PriceWork = {
  asset: SupportedAsset;
  allocationUsd: number;
  sellAmount: bigint;
  tokenAddress: string;
  tokenDecimals: number;
  quote: AerodromeQuote;
  b20Safety: {
    transferPaused: boolean;
    receiverPolicyId: bigint;
    receiverAuthorized: boolean;
  };
};

function usdcRaw(amountUsd: number): bigint {
  if (!Number.isFinite(amountUsd) || amountUsd <= 0) {
    throw new ExecutionPreparationError("invalid_allocation", "Allocation must be positive");
  }
  return BigInt(Math.round(amountUsd * 10 ** USDC_DECIMALS));
}

function serializeAerodromeQuote(quote: AerodromeQuote) {
  return {
    provider: "aerodrome",
    amountIn: quote.amountIn.toString(),
    amountOut: quote.amountOut.toString(),
    spenderAddress: quote.spenderAddress,
    priceImpact: quote.priceImpact.toString(),
    path: quote.path.map(hop => ({
      from: hop.from,
      to: hop.to,
      pool: hop.pool,
      factory: hop.factory,
      type: hop.type,
      poolFee: hop.poolFee.toString(),
    })),
  };
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
    policy_result: {
      allowed: input.checks.every(check => check.passed),
      checks: input.checks,
    },
    idempotency_key: randomUUID(),
  }).select("id").single();

  if (error || !data) {
    throw new Error(`Could not persist execution plan: ${error?.message ?? "unknown"}`);
  }

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
    metadata: { phase: input.plan.phase, provider: "aerodrome" },
  });

  return data.id as string;
}

async function getDirectAerodromeQuote(input: {
  asset: SupportedAsset;
  tokenAddress: string;
  tokenDecimals: number;
  sellAmount: bigint;
}) {
  try {
    const quote = await getAerodromeSwapQuote({
      fromToken: USDC,
      fromSymbol: "USDC",
      fromDecimals: USDC_DECIMALS,
      toToken: input.tokenAddress,
      toSymbol: input.asset,
      toDecimals: input.tokenDecimals,
      amountIn: input.sellAmount,
    });

    if (!quote) {
      throw new ExecutionPreparationError(
        "aerodrome_liquidity_unavailable",
        `Aerodrome could not find an onchain Base route from USDC to ${input.asset}.`,
        409,
      );
    }

    return quote;
  } catch (error) {
    if (error instanceof ExecutionPreparationError) throw error;
    const message = error instanceof Error ? error.message : "Unknown Aerodrome routing failure";
    console.error("aerodrome_quote_failed", {
      asset: input.asset,
      tokenAddress: input.tokenAddress,
      sellAmount: input.sellAmount.toString(),
      message,
    });
    throw new ExecutionPreparationError(
      "aerodrome_quote_unavailable",
      `StockOS could not read the direct Aerodrome route for ${input.asset}: ${message}`,
      503,
    );
  }
}

export async function prepareExecution(input: {
  userId: string;
  smartAccountAddress: string;
  strategyVersionId: string;
}) {
  const { version, strategy } = await loadOwnedStrategyVersion(input.userId, input.strategyVersionId);
  const compiled = version.compiled_strategy as CompiledStrategy;
  const stockAllocations = compiled.allocations.filter(
    allocation => allocation.asset !== "USDC" && allocation.amountUsd > 0,
  );

  if (!stockAllocations.length) {
    throw new ExecutionPreparationError("nothing_to_execute", "Strategy has no stock allocations");
  }

  const priceWork: PriceWork[] = [];

  // Verify each B20 token and discover its direct Aerodrome route before checking funding.
  // This lets an empty wallet still see real onchain price/liquidity information.
  for (const allocation of stockAllocations) {
    const record = ASSETS[allocation.asset];
    if (!record?.enabled || !record.address) {
      throw new ExecutionPreparationError(
        "asset_not_verified",
        `${allocation.asset} is not enabled for execution`,
        409,
      );
    }

    const [b20Safety, tokenDecimals] = await Promise.all([
      readB20ReceiveSafety(record.address, input.smartAccountAddress),
      readTokenDecimals(record.address),
    ]);

    if (b20Safety.transferPaused) {
      throw new ExecutionPreparationError(
        "b20_transfer_paused",
        `${allocation.asset} transfers are currently paused by the issuer`,
        409,
      );
    }

    if (!b20Safety.receiverAuthorized) {
      throw new ExecutionPreparationError(
        "b20_receiver_not_authorized",
        `This Smart Account is not authorized to receive ${allocation.asset}`,
        403,
      );
    }

    const sellAmount = usdcRaw(allocation.amountUsd);
    const quote = await getDirectAerodromeQuote({
      asset: allocation.asset,
      tokenAddress: record.address,
      tokenDecimals,
      sellAmount,
    });

    priceWork.push({
      asset: allocation.asset,
      allocationUsd: allocation.amountUsd,
      sellAmount,
      tokenAddress: record.address,
      tokenDecimals,
      quote,
      b20Safety,
    });
  }

  const totalSell = priceWork.reduce((sum, work) => sum + work.sellAmount, 0n);
  const totalPortfolioUsd = compiled.allocations.reduce(
    (sum, allocation) => sum + Number(allocation.amountUsd ?? 0),
    0,
  );
  const requiredCapital = usdcRaw(totalPortfolioUsd);
  const balance = await readTokenBalance(USDC, input.smartAccountAddress);

  const b20Checks: PlanCheck[] = priceWork.flatMap(work => [
    {
      name: `b20_transfer_unpaused:${work.asset}`,
      passed: !work.b20Safety.transferPaused,
    },
    {
      name: `b20_receiver_authorized:${work.asset}`,
      passed: work.b20Safety.receiverAuthorized,
      detail: `receiver policy ${work.b20Safety.receiverPolicyId.toString()}`,
    },
    {
      name: `aerodrome_liquidity:${work.asset}`,
      passed: true,
      detail: `${work.quote.path.length} hop direct onchain route`,
    },
  ]);

  const indicativePricing = priceWork.map(work => {
    const buyQuantity = Number(formatUnits(work.quote.amountOut, work.tokenDecimals));
    return {
      asset: work.asset,
      provider: "aerodrome",
      sellUsd: work.allocationUsd,
      buyAmount: work.quote.amountOut.toString(),
      tokenDecimals: work.tokenDecimals,
      buyQuantity: Number.isFinite(buyQuantity) ? buyQuantity : null,
      routeAvailable: true,
      routeHops: work.quote.path.length,
      spenderAddress: work.quote.spenderAddress,
      priceImpact: work.quote.priceImpact.toString(),
      path: serializeAerodromeQuote(work.quote).path,
    };
  });

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
      pricingProvider: "aerodrome",
      pricingType: "indicative_aerodrome_onchain_quote",
      pricing: indicativePricing,
      calls: [] as PlanCall[],
      executable: false,
      userApprovalRequired: false,
    };

    const planId = await persistPlan({
      userId: input.userId,
      strategyId: strategy.id,
      version: version.version,
      status: "draft",
      plan,
      checks,
    });

    return { planId, ...plan, checks };
  }

  const allowanceTargets = priceWork.map(work => work.quote.spenderAddress);
  const normalizedTargets = new Set(allowanceTargets.map(target => target.toLowerCase()));
  if (normalizedTargets.size !== 1) {
    throw new ExecutionPreparationError(
      "aerodrome_spender_mismatch",
      "Aerodrome returned inconsistent USDC spenders across portfolio routes. No approval was created.",
      409,
    );
  }

  const allowanceTarget = allowanceTargets[0];
  if (!isAddress(allowanceTarget)) {
    throw new ExecutionPreparationError(
      "invalid_aerodrome_spender",
      "Aerodrome returned an invalid USDC spender address.",
      502,
    );
  }

  const allowance = await readAllowance(USDC, input.smartAccountAddress, allowanceTarget);

  if (allowance < totalSell) {
    const calls: PlanCall[] = [{
      kind: "approval",
      label: `Approve exactly ${formatUnits(totalSell, USDC_DECIMALS)} USDC for Aerodrome`,
      to: USDC,
      data: encodeExactApproval(allowanceTarget, totalSell),
      value: "0",
    }];

    const checks: PlanCheck[] = [
      { name: "asset_registry", passed: true },
      ...b20Checks,
      {
        name: "usdc_balance",
        passed: true,
        detail: `${formatUnits(balance, USDC_DECIMALS)} USDC covers full ${formatUnits(requiredCapital, USDC_DECIMALS)} USDC portfolio capital`,
      },
      {
        name: "exact_allowance",
        passed: true,
        detail: `${formatUnits(totalSell, USDC_DECIMALS)} USDC stock spend; no unlimited approval`,
      },
    ];

    const plan = {
      phase: "allowance_required",
      strategyVersionId: version.id,
      allowanceTarget,
      requiredCapital: requiredCapital.toString(),
      requiredAllowance: totalSell.toString(),
      currentAllowance: allowance.toString(),
      pricingProvider: "aerodrome",
      pricingType: "indicative_aerodrome_onchain_quote",
      pricing: indicativePricing,
      calls,
      executable: true,
      userApprovalRequired: true,
    };

    const planId = await persistPlan({
      userId: input.userId,
      strategyId: strategy.id,
      version: version.version,
      status: "awaiting_approval",
      plan,
      checks,
    });

    return { planId, ...plan, checks };
  }

  const maxDeviationBps = Number(process.env.MAX_REFERENCE_DEVIATION_BPS ?? 200);
  const maxStaleness = Number(process.env.MAX_REFERENCE_STALENESS_SECONDS ?? 345600);
  const calls: PlanCall[] = [];
  const checks: PlanCheck[] = [
    { name: "asset_registry", passed: true },
    ...b20Checks,
    {
      name: "usdc_balance",
      passed: true,
      detail: `${formatUnits(balance, USDC_DECIMALS)} USDC covers full ${formatUnits(requiredCapital, USDC_DECIMALS)} USDC portfolio capital`,
    },
    {
      name: "usdc_allowance",
      passed: true,
      detail: `Aerodrome spender has at least ${formatUnits(totalSell, USDC_DECIMALS)} USDC allowance`,
    },
  ];

  const quoteSummaries: Array<Record<string, unknown>> = [];
  const persistedQuotes: Array<{
    asset: SupportedAsset;
    sellAmount: string;
    buyAmount: string;
    quote: Record<string, unknown>;
  }> = [];
  const expiresAt = new Date(Date.now() + QUOTE_TTL_MS).toISOString();

  // Re-quote after allowance/balance checks so execution calldata is based on fresh onchain state.
  for (const work of priceWork) {
    const freshQuote = await getDirectAerodromeQuote({
      asset: work.asset,
      tokenAddress: work.tokenAddress,
      tokenDecimals: work.tokenDecimals,
      sellAmount: work.sellAmount,
    });

    if (freshQuote.spenderAddress.toLowerCase() !== allowanceTarget.toLowerCase()) {
      throw new ExecutionPreparationError(
        "aerodrome_spender_changed",
        `Aerodrome spender changed while preparing ${work.asset}. Refresh the execution plan.`,
        409,
      );
    }

    const transaction = await buildAerodromeSwapTransaction({
      quote: freshQuote,
      account: input.smartAccountAddress,
      slippage: AERODROME_SLIPPAGE,
    });

    if (
      transaction.chainId !== 8453 ||
      !isAddress(transaction.to) ||
      typeof transaction.data !== "string" ||
      !transaction.data.startsWith("0x")
    ) {
      throw new ExecutionPreparationError(
        "invalid_aerodrome_transaction",
        `Aerodrome returned invalid Base transaction data for ${work.asset}.`,
        502,
      );
    }

    const buyQuantity = Number(formatUnits(freshQuote.amountOut, work.tokenDecimals));
    if (!Number.isFinite(buyQuantity) || buyQuantity <= 0) {
      throw new ExecutionPreparationError(
        "invalid_buy_quantity",
        `Could not interpret ${work.asset} Aerodrome buy amount`,
        502,
      );
    }

    const sellUsd = work.allocationUsd;
    const effectivePriceUsd = sellUsd / buyQuantity;
    const reference = await readReferencePrice(work.asset);
    const referenceConfigured = reference.configured && typeof reference.priceUsd === "number";
    const referenceFresh = referenceConfigured &&
      (reference.ageSeconds ?? Number.POSITIVE_INFINITY) <= maxStaleness;
    const deviationBps = referenceConfigured
      ? Math.round(Math.abs(effectivePriceUsd - reference.priceUsd!) / reference.priceUsd! * 10_000)
      : null;
    const referenceWithinDeviation = deviationBps != null && deviationBps <= maxDeviationBps;

    checks.push({
      name: `reference_configured:${work.asset}`,
      passed: referenceConfigured,
      detail: reference.feed ?? "Set a verified Chainlink total-return feed address",
    });
    checks.push({
      name: `reference_fresh:${work.asset}`,
      passed: !!referenceFresh,
      detail: reference.updatedAt
        ? `${reference.ageSeconds}s old; max ${maxStaleness}s`
        : "No feed data",
    });
    checks.push({
      name: `reference_deviation:${work.asset}`,
      passed: !!referenceWithinDeviation,
      detail: deviationBps == null ? "Unavailable" : `${deviationBps} bps <= ${maxDeviationBps} bps`,
    });

    calls.push({
      kind: "swap",
      label: `Swap ${sellUsd} USDC → ${work.asset} on Aerodrome`,
      to: transaction.to,
      data: transaction.data,
      value: transaction.value.toString(),
    });

    const serializedQuote = serializeAerodromeQuote(freshQuote);
    quoteSummaries.push({
      asset: work.asset,
      sellUsd,
      buyAmount: freshQuote.amountOut.toString(),
      tokenDecimals: work.tokenDecimals,
      buyQuantity,
      effectivePriceUsd,
      priceImpact: freshQuote.priceImpact.toString(),
      routeHops: freshQuote.path.length,
      path: serializedQuote.path,
      reference,
      deviationBps,
    });
    persistedQuotes.push({
      asset: work.asset,
      sellAmount: work.sellAmount.toString(),
      buyAmount: freshQuote.amountOut.toString(),
      quote: serializedQuote,
    });
  }

  const executable = checks.every(check => check.passed);
  const plan = {
    phase: executable ? "ready" : "blocked",
    strategyVersionId: version.id,
    allowanceTarget,
    requiredCapital: requiredCapital.toString(),
    calls,
    quotes: quoteSummaries,
    pricingProvider: "aerodrome",
    pricingType: "firm_aerodrome_onchain_quote",
    expiresAt,
    executable,
    userApprovalRequired: true,
  };

  const planId = await persistPlan({
    userId: input.userId,
    strategyId: strategy.id,
    version: version.version,
    status: executable ? "ready" : "draft",
    plan,
    checks,
  });

  const db = getAdminSupabase();
  for (const item of persistedQuotes) {
    await db.from("quotes").insert({
      user_id: input.userId,
      provider: "aerodrome",
      chain_id: 8453,
      sell_token: USDC,
      buy_token: ASSETS[item.asset].address,
      sell_amount: item.sellAmount,
      buy_amount: item.buyAmount,
      min_buy_amount: null,
      route: (item.quote.path as unknown) ?? null,
      raw_quote: item.quote,
      expires_at: expiresAt,
    });
  }

  return { planId, ...plan, checks };
}

export async function markPlanSubmitted(input: {
  userId: string;
  planId: string;
  transactionHash: string;
}) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(input.transactionHash)) {
    throw new ExecutionPreparationError("invalid_transaction_hash", "Invalid transaction hash");
  }

  const db = getAdminSupabase();
  const { data: row, error } = await db
    .from("execution_plans")
    .select("id,user_id,strategy_id,strategy_version,status,plan")
    .eq("id", input.planId)
    .maybeSingle();

  if (error || !row || row.user_id !== input.userId) {
    throw new ExecutionPreparationError("plan_not_found", "Execution plan not found", 404);
  }

  if (!new Set(["ready", "awaiting_approval"]).has(row.status)) {
    throw new ExecutionPreparationError(
      "plan_not_submittable",
      "Execution plan is not awaiting submission",
      409,
    );
  }

  const phase = (row.plan as any)?.phase;
  if (phase === "ready") {
    const expiresAt = Date.parse((row.plan as any)?.expiresAt ?? "");
    if (!Number.isFinite(expiresAt) || Date.now() > expiresAt) {
      throw new ExecutionPreparationError(
        "quote_expired",
        "Execution quote expired; prepare a fresh plan",
        409,
      );
    }

    await db.from("executions").insert({
      execution_plan_id: row.id,
      status: "submitted",
      authorization_type: "user_approved_cdp_user_operation",
      tx_hash: input.transactionHash,
      submitted_at: new Date().toISOString(),
    });
  }

  await db.from("execution_plans")
    .update({ status: "submitted", updated_at: new Date().toISOString() })
    .eq("id", row.id);

  await db.from("audit_events").insert({
    user_id: input.userId,
    strategy_id: row.strategy_id,
    event_type: phase === "allowance_required" ? "allowance_submitted" : "execution_submitted",
    strategy_version: row.strategy_version,
    authorization_type: "user_approved_cdp_user_operation",
    tx_hash: input.transactionHash,
    metadata: { executionPlanId: row.id, provider: "aerodrome" },
  });

  return { ok: true, phase, transactionHash: input.transactionHash };
}
