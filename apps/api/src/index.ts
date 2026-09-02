import Fastify from "fastify";
import cors from "@fastify/cors";
import { demoIntent, parseIntentWithOpenRouter } from "../../../packages/ai/src/openrouter.ts";
import { compileStrategy } from "../../../packages/strategy/src/compiler.ts";
import { evaluatePolicy } from "../../../packages/policy/src/engine.ts";
const app = Fastify({ logger: true });
await app.register(cors, { origin: true });
app.get("/health", async () => ({ ok:true, service:"stockos-api" }));
app.post("/v1/strategy/compile", async (req, reply) => {
  const body = (req.body ?? {}) as { prompt?: string; eligible?: boolean };
  if (!body.prompt) return reply.code(400).send({ error:"prompt_required" });
  const intent = process.env.OPENROUTER_API_KEY
    ? await parseIntentWithOpenRouter(body.prompt, process.env.OPENROUTER_API_KEY, process.env.OPENROUTER_MODEL ?? "openai/gpt-5.6-mini")
    : demoIntent(body.prompt);
  const strategy = compileStrategy(intent);
  const policy = evaluatePolicy(intent, strategy, { eligible:body.eligible ?? false, maxSlippageBps:100, requestedSlippageBps:50 });
  return { intent, strategy, policy, mode: process.env.OPENROUTER_API_KEY ? "live-ai" : "demo-ai" };
});
const port = Number(process.env.PORT ?? 4000);
await app.listen({ port, host:"0.0.0.0" });
