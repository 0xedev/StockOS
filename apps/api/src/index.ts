import Fastify from "fastify";
import cors from "@fastify/cors";
import { formatEther, formatUnits, parseEther, parseUnits } from "viem";
import { OpenRouterRequestError } from "../../../packages/ai/src/openrouter.ts";
import { parseIntentWithOpenRouterCompatible } from "../../../packages/ai/src/openrouter-compatible.ts";
import { parseIntentWithProvider, type ByokProvider } from "../../../packages/ai/src/providers.ts";
import { deterministicIntentV3 } from "../../../packages/ai/src/deterministic-v3.ts";
import { ASSETS } from "../../../packages/b20/src/registry.ts";
import type { InvestmentIntent } from "../../../packages/core/src/types.ts";
import { compileStrategy } from "../../../packages/strategy/src/compiler.ts";
import { evaluatePolicy } from "../../../packages/policy/src/engine.ts";
import { getAiSettings, resolveAiRuntime, saveByok, switchToManagedAi } from "./lib/ai-runtime.ts";
import { assertEvmAddress, encodeTokenTransfer, readNativeBalance, readTokenBalance } from "./lib/chain.ts";
import { ExecutionPreparationError, markPlanSubmitted, prepareExecution } from "./lib/execution.ts";
import { createOnrampBuyQuote, getOnrampBuyOptions, OnrampRequestError } from "./lib/onramp.ts";
import { capturePortfolioSnapshotNow } from "./lib/portfolio-refresh.ts";
import { getPortfolioState } from "./lib/portfolio.ts";
import { prepareRebalanceExecution, shouldPrepareRebalance } from "./lib/rebalance-execution.ts";
import { requireStockOsSession } from "./lib/session.ts";
import { getActiveStrategyContext, persistStrategyAmendment, persistStrategyDraft } from "./lib/strategy-store.ts";

const app = Fastify({ logger: true });
const allowedOrigins = new Set((process.env.CORS_ORIGINS ?? "http://localhost:3000").split(",").map(value => value.trim()).filter(Boolean));
const supportedByokProviders = new Set<ByokProvider>(["openai", "anthropic", "gemini", "openrouter"]);

function mapExecutionProviderError(error: unknown) {
  if (!(error instanceof Error)) return null;
  const match = error.message.match(/^0x\s+(\d{3}):\s*(.*)$/i);
  if (!match) return null;

  const providerStatus = Number(match[1]);
  const providerReason = match[2]?.trim() || "0x rejected the execution request";
  const normalized = providerReason.toLowerCase();

  if (providerStatus === 422 && normalized.includes("not authorized for trade")) {
    return {
      statusCode: 422,
      body: {
        error: "rwa_routing_not_enabled",
        message: "Live tokenized-stock execution is not enabled for this StockOS 0x account yet. 0x rejected the RWA route before any transaction was created or funds were moved.",
        action: "Enable tokenized-stock/RWA routing for the StockOS 0x API account, then retry execution.",
        provider: "0x",
        providerStatus,
        retryable: false,
      },
    };
  }

  if (providerStatus === 429) {
    return {
      statusCode: 503,
      body: {
        error: "execution_provider_rate_limited",
        message: "Live execution pricing is temporarily rate-limited by 0x. Your strategy is safe; retry shortly.",
        provider: "0x",
        providerStatus,
        retryable: true,
      },
    };
  }

  if (providerStatus >= 500) {
    return {
      statusCode: 503,
      body: {
        error: "execution_provider_unavailable",
        message: "0x is temporarily unavailable, so StockOS cannot prepare a safe execution plan right now. No transaction was created.",
        provider: "0x",
        providerStatus,
        retryable: true,
      },
    };
  }

  return {
    statusCode: 422,
    body: {
      error: "execution_quote_rejected",
      message: `0x rejected the execution request: ${providerReason}`,
      provider: "0x",
      providerStatus,
      retryable: false,
    },
  };
}

async function interpretStrategyPrompt(input: {
  userId: string;
  prompt: string;
  log: typeof app.log;
}) {
  const runtime = await resolveAiRuntime(input.userId);
  let intent: InvestmentIntent;
  let effectiveModel = runtime.model;
  let effectiveSource: string = runtime.source;
  let fallbackReason: string | null = null;

  try {
    if (runtime.apiKey) {
      const parsed = runtime.source === "managed"
        ? await parseIntentWithOpenRouterCompatible(input.prompt, runtime.apiKey, runtime.model)
        : await parseIntentWithProvider({ provider: runtime.provider as ByokProvider, prompt: input.prompt, apiKey: runtime.apiKey, model: runtime.model });
      intent = parsed.intent;
      effectiveModel = parsed.model;
    } else {
      intent = deterministicIntentV3(input.prompt);
      effectiveSource = "deterministic_demo";
      effectiveModel = "deterministic-parser-v3";
    }
  } catch (error) {
    if (error instanceof OpenRouterRequestError && runtime.source === "managed") {
      try {
        intent = deterministicIntentV3(input.prompt);
        effectiveSource = "deterministic_fallback";
        effectiveModel = "deterministic-parser-v3";
        fallbackReason = `${error.status}:${error.message}`;
        input.log.warn({ status: error.status, reason: error.message, requestedModel: runtime.model }, "managed AI unavailable; deterministic parser used");
      } catch (fallbackError) {
        const failure = new Error(fallbackError instanceof Error ? fallbackError.message : "Could not interpret this strategy") as Error & { statusCode?: number; code?: string };
        failure.statusCode = 503;
        failure.code = "strategy_interpretation_failed";
        throw failure;
      }
    } else if (error instanceof OpenRouterRequestError) {
      const failure = new Error(
        error.status === 429 ? "Your selected AI model is currently rate-limited or at capacity." :
        error.status === 504 ? "Your selected AI model did not respond before StockOS's timeout." :
        "The selected AI provider could not produce a valid strategy.",
      ) as Error & { statusCode?: number; code?: string; provider?: string; requestedModel?: string };
      failure.statusCode = error.status === 429 ? 429 : error.status === 504 ? 504 : 503;
      failure.code = error.status === 429 ? "ai_capacity_limited" : error.status === 504 ? "ai_timeout" : "ai_provider_unavailable";
      failure.provider = runtime.provider;
      failure.requestedModel = runtime.model;
      throw failure;
    } else {
      throw error;
    }
  }

  return { intent, effectiveModel, effectiveSource, fallbackReason, runtime };
}

await app.register(cors, {
  origin(origin, callback) {
    if (!origin || allowedOrigins.has(origin)) return callback(null, true);
    callback(new Error("Origin not allowed"), false);
  },
  methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Authorization", "Content-Type"],
});

app.get("/health", async () => ({ ok: true, service: "stockos-api" }));

app.post("/v1/session", async (request, reply) => {
  const session = await requireStockOsSession(request, reply);
  if (!session) return;
  return session;
});

app.get("/v1/portfolio/active", async (request, reply) => {
  const session = await requireStockOsSession(request, reply);
  if (!session) return;
  return getPortfolioState(session.profile.id);
});

app.post("/v1/portfolio/refresh", async (request, reply) => {
  const session = await requireStockOsSession(request, reply);
  if (!session) return;
  if (!session.wallet.smartAccountAddress) return reply.code(409).send({ error: "smart_account_required", message: "Smart Account is not ready yet." });
  const active = await getActiveStrategyContext(session.profile.id);
  if (!active) return reply.code(409).send({ error: "active_strategy_required", message: "There is no active portfolio to refresh." });
  await capturePortfolioSnapshotNow({
    userId: session.profile.id,
    smartAccountAddress: session.wallet.smartAccountAddress,
    strategyId: active.strategy.id,
    strategyVersion: active.strategy.current_version,
  });
  return getPortfolioState(session.profile.id);
});

app.get("/v1/wallet/summary", async (request, reply) => {
  const session = await requireStockOsSession(request, reply);
  if (!session) return;
  const account = session.wallet.smartAccountAddress;
  const usdc = ASSETS.USDC;
  if (!account) return reply.code(409).send({ error: "smart_account_required", message: "Smart Account is not ready yet." });
  if (!usdc.address || usdc.decimals == null) throw new Error("USDC registry configuration is incomplete");
  const [nativeBalance, usdcBalance] = await Promise.all([
    readNativeBalance(account),
    readTokenBalance(usdc.address, account),
  ]);
  return {
    address: account,
    network: "base",
    chainId: 8453,
    balances: {
      ETH: { raw: nativeBalance.toString(), formatted: formatEther(nativeBalance) },
      USDC: { raw: usdcBalance.toString(), formatted: formatUnits(usdcBalance, usdc.decimals) },
    },
  };
});

app.post("/v1/wallet/send/prepare", async (request, reply) => {
  const session = await requireStockOsSession(request, reply);
  if (!session) return;
  const account = session.wallet.smartAccountAddress;
  if (!account) return reply.code(409).send({ error: "smart_account_required", message: "Smart Account is not ready yet." });

  const body = (request.body ?? {}) as { asset?: string; to?: string; amount?: string | number };
  if (body.asset !== "USDC" && body.asset !== "ETH") {
    return reply.code(400).send({ error: "unsupported_transfer_asset", message: "Manual wallet sends support Base USDC and ETH." });
  }
  if (!body.to) return reply.code(400).send({ error: "recipient_required", message: "Recipient address is required." });
  let recipient: string;
  try { recipient = assertEvmAddress(body.to.trim(), "recipient"); }
  catch (error) { return reply.code(400).send({ error: "invalid_recipient", message: error instanceof Error ? error.message : "Invalid recipient" }); }

  const amountText = String(body.amount ?? "").trim();
  const decimalLimit = body.asset === "USDC" ? 6 : 18;
  if (!new RegExp(`^\\d+(?:\\.\\d{1,${decimalLimit}})?$`).test(amountText) || Number(amountText) <= 0) {
    return reply.code(400).send({ error: "invalid_amount", message: `Enter a positive ${body.asset} amount with up to ${decimalLimit} decimal places.` });
  }

  if (body.asset === "ETH") {
    const rawAmount = parseEther(amountText);
    const balance = await readNativeBalance(account);
    if (rawAmount > balance) {
      return reply.code(409).send({ error: "insufficient_eth_balance", message: `Insufficient ETH. Available balance: ${formatEther(balance)} ETH.` });
    }
    return {
      asset: "ETH",
      amount: amountText,
      recipient,
      balanceBefore: formatEther(balance),
      call: { kind: "transfer", label: `Send ${amountText} ETH`, to: recipient, data: "0x", value: rawAmount.toString() },
    };
  }

  const usdc = ASSETS.USDC;
  if (!usdc.address || usdc.decimals == null) throw new Error("USDC registry configuration is incomplete");
  const rawAmount = parseUnits(amountText, usdc.decimals);
  const balance = await readTokenBalance(usdc.address, account);
  if (rawAmount > balance) {
    return reply.code(409).send({ error: "insufficient_usdc_balance", message: `Insufficient USDC. Available balance: ${formatUnits(balance, usdc.decimals)} USDC.` });
  }
  return {
    asset: "USDC",
    amount: amountText,
    recipient,
    balanceBefore: formatUnits(balance, usdc.decimals),
    call: {
      kind: "transfer",
      label: `Send ${amountText} USDC`,
      to: usdc.address,
      data: encodeTokenTransfer(recipient, rawAmount),
      value: "0",
    },
  };
});

app.get("/v1/ai/settings", async (request, reply) => {
  const session = await requireStockOsSession(request, reply);
  if (!session) return;
  return getAiSettings(session.profile.id);
});

app.post("/v1/ai/byok", async (request, reply) => {
  const session = await requireStockOsSession(request, reply);
  if (!session) return;
  const body = (request.body ?? {}) as { provider?: string; apiKey?: string; model?: string };
  if (!body.apiKey) return reply.code(400).send({ error: "api_key_required", message: "API key is required" });
  if (!body.provider || !supportedByokProviders.has(body.provider as ByokProvider)) {
    return reply.code(400).send({ error: "unsupported_ai_provider", message: "Choose OpenAI, Anthropic, Gemini, or OpenRouter." });
  }
  try { return await saveByok(session.profile.id, body.provider as ByokProvider, body.apiKey, body.model); }
  catch (error) { return reply.code(400).send({ error: "byok_verification_failed", message: error instanceof Error ? error.message : "Could not verify BYOK key" }); }
});

app.delete("/v1/ai/byok", async (request, reply) => {
  const session = await requireStockOsSession(request, reply);
  if (!session) return;
  return switchToManagedAi(session.profile.id);
});

// Legacy endpoint kept temporarily so older deployed clients can switch without breaking.
app.post("/v1/ai/byok/openrouter", async (request, reply) => {
  const session = await requireStockOsSession(request, reply);
  if (!session) return;
  const body = (request.body ?? {}) as { apiKey?: string; model?: string };
  if (!body.apiKey) return reply.code(400).send({ error: "api_key_required" });
  try { return await saveByok(session.profile.id, "openrouter", body.apiKey, body.model); }
  catch (error) { return reply.code(400).send({ error: "byok_verification_failed", message: error instanceof Error ? error.message : "Could not verify BYOK key" }); }
});
app.delete("/v1/ai/byok/openrouter", async (request, reply) => {
  const session = await requireStockOsSession(request, reply);
  if (!session) return;
  return switchToManagedAi(session.profile.id);
});

app.get("/v1/onramp/buy-options", async (request, reply) => {
  const session = await requireStockOsSession(request, reply);
  if (!session) return;
  const query = (request.query ?? {}) as { country?: string; subdivision?: string };
  try { return await getOnrampBuyOptions(query); }
  catch (error) {
    if (error instanceof OnrampRequestError) return reply.code(error.status).send({ error: "onramp_unavailable", message: error.message });
    throw error;
  }
});

app.post("/v1/onramp/buy-quote", async (request, reply) => {
  const session = await requireStockOsSession(request, reply);
  if (!session) return;
  if (!session.wallet.smartAccountAddress) return reply.code(409).send({ error: "smart_account_required", message: "Smart Account is not ready yet." });
  try { return await createOnrampBuyQuote((request.body ?? {}) as Record<string, any>, session.wallet.smartAccountAddress); }
  catch (error) {
    if (error instanceof OnrampRequestError) return reply.code(error.status).send({ error: "onramp_unavailable", message: error.message });
    throw error;
  }
});

app.post("/v1/strategy/compile", async (request, reply) => {
  const session = await requireStockOsSession(request, reply);
  if (!session) return;
  const body = (request.body ?? {}) as { prompt?: string };
  if (!body.prompt?.trim()) return reply.code(400).send({ error: "prompt_required" });
  const prompt = body.prompt.trim();

  try {
    const interpreted = await interpretStrategyPrompt({ userId: session.profile.id, prompt, log: request.log });
    const strategy = compileStrategy(interpreted.intent);
    if (interpreted.fallbackReason) strategy.warnings.push("Managed AI was unavailable, so StockOS used the deterministic parser. Exact percentages and named assets are preserved; review the result before proceeding.");
    const policy = evaluatePolicy(interpreted.intent, strategy, { maxSlippageBps: 100, requestedSlippageBps: 50 });
    const draft = await persistStrategyDraft({ userId: session.profile.id, prompt, intent: interpreted.intent, strategy, aiSource: interpreted.effectiveSource, aiModel: interpreted.effectiveModel });
    return {
      intent: interpreted.intent,
      strategy,
      policy,
      draft,
      ai: { source: interpreted.effectiveSource, model: interpreted.effectiveModel, requestedModel: interpreted.runtime.model, fallbackReason: interpreted.fallbackReason },
      session: { smartAccountAddress: session.wallet.smartAccountAddress },
    };
  } catch (error) {
    const failure = error as Error & { statusCode?: number; code?: string; provider?: string; requestedModel?: string };
    if (failure.statusCode) return reply.code(failure.statusCode).send({ error: failure.code ?? "strategy_interpretation_failed", message: failure.message, provider: failure.provider, requestedModel: failure.requestedModel });
    throw error;
  }
});

app.post("/v1/strategy/adjust", async (request, reply) => {
  const session = await requireStockOsSession(request, reply);
  if (!session) return;
  if (!session.wallet.smartAccountAddress) return reply.code(409).send({ error: "smart_account_required", message: "Smart Account is not ready yet." });
  const body = (request.body ?? {}) as { prompt?: string };
  if (!body.prompt?.trim()) return reply.code(400).send({ error: "prompt_required" });

  const active = await getActiveStrategyContext(session.profile.id);
  if (!active) return reply.code(409).send({ error: "active_strategy_required", message: "Start a portfolio before adjusting it." });

  const fresh = await capturePortfolioSnapshotNow({
    userId: session.profile.id,
    smartAccountAddress: session.wallet.smartAccountAddress,
    strategyId: active.strategy.id,
    strategyVersion: active.strategy.current_version,
  });
  const currentStrategy = active.version.compiled_strategy as { allocations?: Array<{ asset: string; weight: number }> };
  const currentAllocations = (currentStrategy.allocations ?? []).map(allocation => `${allocation.asset} ${(allocation.weight * 100).toFixed(2)}%`).join(", ");
  const prompt = body.prompt.trim();
  const contextualPrompt = [
    `Update the user's EXISTING portfolio, not a new portfolio.`,
    `Current portfolio value: $${fresh.totalValueUsd.toFixed(2)} USDC-equivalent.`,
    `Current target allocations: ${currentAllocations || "unknown"}.`,
    `The action must be UPDATE_PORTFOLIO. Keep capital at exactly ${fresh.totalValueUsd.toFixed(2)} unless the user explicitly asks to add or withdraw capital.`,
    `User requested adjustment: ${prompt}`,
    `Return a complete target allocation summing to 100%, including unchanged assets and USDC cash.`,
  ].join("\n");

  try {
    const interpreted = await interpretStrategyPrompt({ userId: session.profile.id, prompt: contextualPrompt, log: request.log });
    interpreted.intent.action = "UPDATE_PORTFOLIO";
    interpreted.intent.capital = { currency: "USDC", amount: Number(fresh.totalValueUsd.toFixed(2)) };
    const strategy = compileStrategy(interpreted.intent);
    if (interpreted.fallbackReason) strategy.warnings.push("Managed AI was unavailable, so StockOS used the deterministic parser. Review the proposed adjustment carefully before execution.");
    const policy = evaluatePolicy(interpreted.intent, strategy, { maxSlippageBps: 100, requestedSlippageBps: 50 });
    const draft = await persistStrategyAmendment({
      userId: session.profile.id,
      prompt,
      intent: interpreted.intent,
      strategy,
      aiSource: interpreted.effectiveSource,
      aiModel: interpreted.effectiveModel,
    });
    return {
      intent: interpreted.intent,
      strategy,
      policy,
      draft,
      amendment: true,
      current: { strategyId: active.strategy.id, version: active.strategy.current_version, totalValueUsd: fresh.totalValueUsd },
      ai: { source: interpreted.effectiveSource, model: interpreted.effectiveModel, requestedModel: interpreted.runtime.model, fallbackReason: interpreted.fallbackReason },
      session: { smartAccountAddress: session.wallet.smartAccountAddress },
    };
  } catch (error) {
    const failure = error as Error & { statusCode?: number; code?: string; provider?: string; requestedModel?: string };
    if (failure.statusCode) return reply.code(failure.statusCode).send({ error: failure.code ?? "strategy_interpretation_failed", message: failure.message, provider: failure.provider, requestedModel: failure.requestedModel });
    throw error;
  }
});

app.post("/v1/execution/prepare", async (request, reply) => {
  const session = await requireStockOsSession(request, reply);
  if (!session) return;
  if (!session.wallet.smartAccountAddress) return reply.code(409).send({ error: "smart_account_required", message: "CDP Smart Account is not ready yet." });
  const body = (request.body ?? {}) as { strategyVersionId?: string };
  if (!body.strategyVersionId) return reply.code(400).send({ error: "strategy_version_required" });
  try {
    const isRebalance = await shouldPrepareRebalance({ userId: session.profile.id, strategyVersionId: body.strategyVersionId });
    return isRebalance
      ? await prepareRebalanceExecution({ userId: session.profile.id, smartAccountAddress: session.wallet.smartAccountAddress, strategyVersionId: body.strategyVersionId })
      : await prepareExecution({ userId: session.profile.id, smartAccountAddress: session.wallet.smartAccountAddress, strategyVersionId: body.strategyVersionId });
  }
  catch (error) {
    if (error instanceof ExecutionPreparationError) return reply.code(error.statusCode).send({ error: error.code, message: error.message });
    const providerError = mapExecutionProviderError(error);
    if (providerError) {
      request.log.warn({ provider: "0x", status: providerError.body.providerStatus, code: providerError.body.error }, "execution provider rejected request");
      return reply.code(providerError.statusCode).send(providerError.body);
    }
    throw error;
  }
});

app.post("/v1/execution/:planId/submitted", async (request, reply) => {
  const session = await requireStockOsSession(request, reply);
  if (!session) return;
  const { planId } = request.params as { planId: string };
  const body = (request.body ?? {}) as { transactionHash?: string };
  if (!body.transactionHash) return reply.code(400).send({ error: "transaction_hash_required" });
  try { return await markPlanSubmitted({ userId: session.profile.id, planId, transactionHash: body.transactionHash }); }
  catch (error) {
    if (error instanceof ExecutionPreparationError) return reply.code(error.statusCode).send({ error: error.code, message: error.message });
    throw error;
  }
});

app.setErrorHandler((error, request, reply) => {
  const requestId = String(request.id);
  request.log.error({ err: error, requestId }, "request failed");
  reply.code(500).send({
    error: "internal_error",
    message: `StockOS could not complete this request. Please retry. If it keeps failing, share reference ${requestId}.`,
    requestId,
    retryable: true,
  });
});

const port = Number(process.env.PORT ?? 4000);
await app.listen({ port, host: "0.0.0.0" });
