import Fastify from "fastify";
import cors from "@fastify/cors";
import { demoIntent, OpenRouterRequestError, parseIntentWithOpenRouter } from "../../../packages/ai/src/openrouter.ts";
import { compileStrategy } from "../../../packages/strategy/src/compiler.ts";
import { evaluatePolicy } from "../../../packages/policy/src/engine.ts";
import { getAiSettings, resolveAiRuntime, revokeOpenRouterByok, saveOpenRouterByok } from "./lib/ai-runtime.ts";
import { ExecutionPreparationError, markPlanSubmitted, prepareExecution } from "./lib/execution.ts";
import { requireStockOsSession } from "./lib/session.ts";
import { persistStrategyDraft } from "./lib/strategy-store.ts";

const app = Fastify({ logger: true });
const allowedOrigins = new Set((process.env.CORS_ORIGINS ?? "http://localhost:3000").split(",").map(value => value.trim()).filter(Boolean));
await app.register(cors, {
  origin(origin, callback) {
    if (!origin || allowedOrigins.has(origin)) return callback(null, true);
    callback(new Error("Origin not allowed"), false);
  },
});

app.get("/health", async () => ({ ok: true, service: "stockos-api" }));

app.post("/v1/session", async (request, reply) => {
  const session = await requireStockOsSession(request, reply);
  if (!session) return;
  return session;
});

app.get("/v1/ai/settings", async (request, reply) => {
  const session = await requireStockOsSession(request, reply);
  if (!session) return;
  return getAiSettings(session.profile.id);
});

app.post("/v1/ai/byok/openrouter", async (request, reply) => {
  const session = await requireStockOsSession(request, reply);
  if (!session) return;
  const body = (request.body ?? {}) as { apiKey?: string; model?: string };
  if (!body.apiKey) return reply.code(400).send({ error: "api_key_required" });
  try {
    return await saveOpenRouterByok(session.profile.id, body.apiKey, body.model);
  } catch (error) {
    return reply.code(400).send({ error: "byok_verification_failed", message: error instanceof Error ? error.message : "Could not verify BYOK key" });
  }
});

app.delete("/v1/ai/byok/openrouter", async (request, reply) => {
  const session = await requireStockOsSession(request, reply);
  if (!session) return;
  return revokeOpenRouterByok(session.profile.id);
});

app.post("/v1/strategy/compile", async (request, reply) => {
  const session = await requireStockOsSession(request, reply);
  if (!session) return;
  const body = (request.body ?? {}) as { prompt?: string };
  if (!body.prompt?.trim()) return reply.code(400).send({ error: "prompt_required" });
  const prompt = body.prompt.trim();
  const runtime = await resolveAiRuntime(session.profile.id);

  let intent;
  let effectiveModel = runtime.model;
  let effectiveSource: string = runtime.source;
  let fallbackReason: string | null = null;

  try {
    if (runtime.apiKey) {
      const parsed = await parseIntentWithOpenRouter(prompt, runtime.apiKey, runtime.model);
      intent = parsed.intent;
      effectiveModel = parsed.model;
    } else {
      intent = demoIntent(prompt);
      effectiveSource = "deterministic_demo";
      effectiveModel = "deterministic-parser";
    }
  } catch (error) {
    if (error instanceof OpenRouterRequestError && runtime.source === "managed") {
      intent = demoIntent(prompt);
      effectiveSource = "deterministic_fallback";
      effectiveModel = "deterministic-parser";
      fallbackReason = `${error.status}:${error.message}`;
      request.log.warn({ status: error.status, requestedModel: runtime.model }, "managed AI unavailable; deterministic parser used");
    } else if (error instanceof OpenRouterRequestError) {
      const statusCode = error.status === 429 ? 429 : error.status === 504 ? 504 : 503;
      return reply.code(statusCode).send({
        error: error.status === 429 ? "ai_capacity_limited" : error.status === 504 ? "ai_timeout" : "ai_provider_unavailable",
        message: error.status === 429
          ? "Your selected OpenRouter model is currently rate-limited or at capacity."
          : error.status === 504
            ? "Your selected OpenRouter model did not respond before StockOS's timeout."
            : "The selected AI provider could not produce a valid structured strategy.",
        provider: "openrouter",
        requestedModel: runtime.model,
      });
    } else {
      throw error;
    }
  }

  const strategy = compileStrategy(intent);
  if (fallbackReason) {
    strategy.warnings.push("Managed AI was unavailable, so StockOS used its deterministic fallback parser. Review the generated strategy before proceeding.");
  }
  const policy = evaluatePolicy(intent, strategy, {
    maxSlippageBps: 100,
    requestedSlippageBps: 50,
  });
  const draft = await persistStrategyDraft({
    userId: session.profile.id,
    prompt,
    intent,
    strategy,
    aiSource: effectiveSource,
    aiModel: effectiveModel,
  });
  return {
    intent,
    strategy,
    policy,
    draft,
    ai: {
      source: effectiveSource,
      model: effectiveModel,
      requestedModel: runtime.model,
      fallbackReason,
    },
    session: { smartAccountAddress: session.wallet.smartAccountAddress },
  };
});

app.post("/v1/execution/prepare", async (request, reply) => {
  const session = await requireStockOsSession(request, reply);
  if (!session) return;
  if (!session.wallet.smartAccountAddress) {
    return reply.code(409).send({ error: "smart_account_required", message: "CDP Smart Account is not ready yet." });
  }
  const body = (request.body ?? {}) as { strategyVersionId?: string };
  if (!body.strategyVersionId) return reply.code(400).send({ error: "strategy_version_required" });
  try {
    return await prepareExecution({ userId: session.profile.id, smartAccountAddress: session.wallet.smartAccountAddress, strategyVersionId: body.strategyVersionId });
  } catch (error) {
    if (error instanceof ExecutionPreparationError) return reply.code(error.statusCode).send({ error: error.code, message: error.message });
    throw error;
  }
});

app.post("/v1/execution/:planId/submitted", async (request, reply) => {
  const session = await requireStockOsSession(request, reply);
  if (!session) return;
  const { planId } = request.params as { planId: string };
  const body = (request.body ?? {}) as { transactionHash?: string };
  if (!body.transactionHash) return reply.code(400).send({ error: "transaction_hash_required" });
  try {
    return await markPlanSubmitted({ userId: session.profile.id, planId, transactionHash: body.transactionHash });
  } catch (error) {
    if (error instanceof ExecutionPreparationError) return reply.code(error.statusCode).send({ error: error.code, message: error.message });
    throw error;
  }
});

app.setErrorHandler((error, request, reply) => {
  request.log.error({ err: error }, "request failed");
  reply.code(500).send({ error: "internal_error" });
});

const port = Number(process.env.PORT ?? 4000);
await app.listen({ port, host: "0.0.0.0" });
