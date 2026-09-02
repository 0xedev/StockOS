import Fastify from "fastify";
import cors from "@fastify/cors";
import { demoIntent, parseIntentWithOpenRouter } from "../../../packages/ai/src/openrouter.ts";
import { compileStrategy } from "../../../packages/strategy/src/compiler.ts";
import { evaluatePolicy } from "../../../packages/policy/src/engine.ts";
import { getAiSettings, resolveAiRuntime, revokeOpenRouterByok, saveOpenRouterByok } from "./lib/ai-runtime.ts";
import { requireStockOsSession } from "./lib/session.ts";

const app = Fastify({ logger: true });
const allowedOrigins = new Set((process.env.CORS_ORIGINS ?? "http://localhost:3000").split(",").map(v => v.trim()).filter(Boolean));
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
  return saveOpenRouterByok(session.profile.id, body.apiKey, body.model);
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
  const runtime = await resolveAiRuntime(session.profile.id);
  const intent = runtime.apiKey
    ? await parseIntentWithOpenRouter(body.prompt.trim(), runtime.apiKey, runtime.model)
    : demoIntent(body.prompt.trim());
  const strategy = compileStrategy(intent);
  const policy = evaluatePolicy(intent, strategy, {
    eligible: session.profile.eligibilityStatus === "eligible",
    maxSlippageBps: 100,
    requestedSlippageBps: 50,
  });
  return { intent, strategy, policy, ai: { source: runtime.source, model: runtime.model }, session: { smartAccountAddress: session.wallet.smartAccountAddress } };
});

app.setErrorHandler((error, request, reply) => {
  request.log.error({ err: error }, "request failed");
  reply.code(500).send({ error: "internal_error" });
});

const port = Number(process.env.PORT ?? 4000);
await app.listen({ port, host: "0.0.0.0" });
