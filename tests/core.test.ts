import assert from "node:assert/strict";
import { demoIntent } from "../packages/ai/src/openrouter.ts";
import { validateInvestmentIntent } from "../packages/core/src/validation.ts";
import { compileStrategy } from "../packages/strategy/src/compiler.ts";
import { evaluatePolicy } from "../packages/policy/src/engine.ts";
import { scaledBalance, rawFromScaled } from "../packages/b20/src/multiplier.ts";
import { encryptByok, decryptByok } from "../packages/ai/src/byok.ts";

const explicitIntent = demoIntent("Invest $1,000: 50% Apple, 30% Nvidia and 20% cash.");
const explicitStrategy = compileStrategy(explicitIntent);
assert.equal(explicitStrategy.totalUsd, 1000);
assert.equal(explicitStrategy.allocations.find(a => a.asset === "AAPLc")?.weight, 0.5);
assert.equal(explicitStrategy.allocations.find(a => a.asset === "NVDAc")?.weight, 0.3);
assert.equal(explicitStrategy.cashWeight, 0.2);

const customIntent = demoIntent("Put $750 equally across Apple, Google and Meta. No Nvidia.");
const customStrategy = compileStrategy(customIntent);
assert.equal(customStrategy.allocations.length, 3);
assert.equal(customStrategy.allocations.some(a => a.asset === "NVDAc"), false);
assert.ok(customStrategy.allocations.every(a => Math.abs(a.weight - 1 / 3) < 1e-9));
assert.notDeepEqual(customStrategy.allocations, explicitStrategy.allocations);

const fallbackConstraintIntent = demoIntent("Build an aggressive $2,000 portfolio. Keep Nvidia under 40%, hold at least 10% cash, and rebalance monthly.");
const fallbackConstraintStrategy = compileStrategy(fallbackConstraintIntent);
const fallbackNvda = fallbackConstraintStrategy.allocations.find(a => a.asset === "NVDAc")?.weight ?? 0;
assert.ok(fallbackNvda <= 0.4 + 1e-9);
assert.ok(fallbackConstraintStrategy.cashWeight >= 0.1 - 1e-9);
assert.equal(fallbackConstraintIntent.automation?.rebalance, "MONTHLY");
const fallbackPolicy = evaluatePolicy(fallbackConstraintIntent, fallbackConstraintStrategy, { maxSlippageBps: 100, requestedSlippageBps: 50 });
assert.equal(fallbackPolicy.allowed, true);

const constrainedIntent = validateInvestmentIntent({
  intentVersion: 2,
  action: "CREATE_PORTFOLIO",
  capital: { currency: "USDC", amount: 500 },
  themes: ["custom"],
  risk: "aggressive",
  exclusions: [],
  constraints: [{ type: "MAX_WEIGHT", asset: "NVDAc", value: 0.35 }, { type: "MIN_CASH", asset: null, value: 0.1 }],
  targetAllocations: [
    { asset: "NVDAc", weight: 0.35 },
    { asset: "GOOGLc", weight: 0.25 },
    { asset: "METAc", weight: 0.15 },
    { asset: "AAPLc", weight: 0.15 },
    { asset: "USDC", weight: 0.10 },
  ],
  automation: { rebalance: "MONTHLY" },
});
const constrainedStrategy = compileStrategy(constrainedIntent);
const policy = evaluatePolicy(constrainedIntent, constrainedStrategy, { maxSlippageBps: 100, requestedSlippageBps: 50 });
assert.equal(policy.allowed, true);

const badCashIntent = validateInvestmentIntent({
  intentVersion: 2,
  action: "CREATE_PORTFOLIO",
  capital: { currency: "USDC", amount: 500 },
  themes: ["custom"],
  risk: "moderate",
  exclusions: [],
  constraints: [{ type: "MIN_CASH", asset: null, value: 0.2 }],
  targetAllocations: [{ asset: "AAPLc", weight: 0.9 }, { asset: "USDC", weight: 0.1 }],
  automation: { rebalance: "NONE" },
});
assert.equal(evaluatePolicy(badCashIntent, compileStrategy(badCashIntent), { maxSlippageBps: 100, requestedSlippageBps: 50 }).allowed, false);

assert.throws(() => validateInvestmentIntent({
  intentVersion: 2,
  action: "CREATE_PORTFOLIO",
  capital: { currency: "USDC", amount: 100 },
  themes: ["custom"],
  risk: "moderate",
  exclusions: ["EVILc"],
  constraints: [],
  targetAllocations: [{ asset: "AAPLc", weight: 1 }],
  automation: { rebalance: "NONE" },
}), /Unsupported asset/);

const multiplier = 1_250_000_000_000_000_000n;
const raw = 200_000_000n;
const scaled = scaledBalance(raw, 8, multiplier);
assert.equal(scaled, 2.5);
assert.equal(rawFromScaled(scaled, 8, multiplier), raw);

const encrypted = encryptByok("sk-or-test-secret", "stockos-master-test");
assert.equal(decryptByok(encrypted, "stockos-master-test"), "sk-or-test-secret");

console.log(JSON.stringify({ explicitStrategy, customStrategy, fallbackConstraintStrategy, policy, unsupportedAssetRejected: true, multiplierRoundTrip: true, byokRoundTrip: true }, null, 2));
