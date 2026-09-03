import assert from "node:assert/strict";
import { demoIntent } from "../packages/ai/src/openrouter.ts";
import { validateInvestmentIntent } from "../packages/core/src/validation.ts";
import { compileStrategy } from "../packages/strategy/src/compiler.ts";
import { evaluatePolicy } from "../packages/policy/src/engine.ts";
import { scaledBalance, rawFromScaled } from "../packages/b20/src/multiplier.ts";
import { encryptByok, decryptByok } from "../packages/ai/src/byok.ts";

const intent = demoIntent("Build me an aggressive AI portfolio with $500. Keep Nvidia below 35% and 10% in cash. Rebalance monthly.");
const strategy = compileStrategy(intent);
assert.equal(strategy.totalUsd, 500);
assert.equal(strategy.cashWeight, 0.10);
assert.ok((strategy.allocations.find(a => a.asset === "NVDAc")?.weight ?? 1) <= 0.35 + 1e-9);

const policy = evaluatePolicy(intent, strategy, { maxSlippageBps: 100, requestedSlippageBps: 50 });
assert.equal(policy.allowed, true);
assert.equal(policy.checks.some(check => check.name === "eligibility"), false);

assert.throws(() => validateInvestmentIntent({
  intentVersion: 1,
  action: "CREATE_PORTFOLIO",
  capital: { currency: "USDC", amount: 100 },
  themes: ["ai"],
  risk: "moderate",
  exclusions: ["EVILc"],
  constraints: [],
  automation: { rebalance: "NONE" },
}), /Unsupported asset/);

const multiplier = 1_250_000_000_000_000_000n;
const raw = 200_000_000n;
const scaled = scaledBalance(raw, 8, multiplier);
assert.equal(scaled, 2.5);
assert.equal(rawFromScaled(scaled, 8, multiplier), raw);

const encrypted = encryptByok("sk-or-test-secret", "stockos-master-test");
assert.equal(decryptByok(encrypted, "stockos-master-test"), "sk-or-test-secret");

console.log(JSON.stringify({ intent, strategy, policy, eligibilityGateRemoved: true, unsupportedAssetRejected: true, multiplierRoundTrip: true, byokRoundTrip: true }, null, 2));
