import { createHash } from "node:crypto";
import type { CompiledStrategy, InvestmentIntent } from "../../../../packages/core/src/types.ts";
import { getAdminSupabase } from "./db.ts";

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export async function persistStrategyDraft(input: {
  userId: string;
  prompt: string;
  intent: InvestmentIntent;
  strategy: CompiledStrategy;
  aiSource: string;
  aiModel: string;
}) {
  const db = getAdminSupabase();
  const name = `${input.intent.themes[0]?.replaceAll("_", " ") ?? "AI"} portfolio`;
  const { data: strategyRow, error: strategyError } = await db
    .from("strategies")
    .insert({ user_id: input.userId, name, status: "draft", current_version: 1 })
    .select("id")
    .single();
  if (strategyError || !strategyRow) throw new Error(`Could not persist strategy: ${strategyError?.message ?? "unknown"}`);

  const strategyHash = sha256(JSON.stringify(input.strategy));
  const { data: versionRow, error: versionError } = await db
    .from("strategy_versions")
    .insert({
      strategy_id: strategyRow.id,
      version: 1,
      source_prompt: input.prompt,
      source_prompt_hash: sha256(input.prompt),
      parsed_intent: input.intent,
      compiled_strategy: input.strategy,
      strategy_hash: strategyHash,
    })
    .select("id")
    .single();
  if (versionError || !versionRow) throw new Error(`Could not persist strategy version: ${versionError?.message ?? "unknown"}`);

  const assets = input.strategy.allocations.map(allocation => ({
    strategy_version_id: versionRow.id,
    asset_symbol: allocation.asset,
    target_weight: allocation.weight,
  }));
  if (assets.length) {
    const { error } = await db.from("strategy_assets").insert(assets);
    if (error) throw new Error(`Could not persist strategy assets: ${error.message}`);
  }

  const constraints = input.intent.constraints.map(constraint => ({
    strategy_version_id: versionRow.id,
    kind: constraint.type,
    asset_symbol: "asset" in constraint ? constraint.asset : null,
    value: { value: constraint.value },
  }));
  if (constraints.length) {
    const { error } = await db.from("strategy_constraints").insert(constraints);
    if (error) throw new Error(`Could not persist strategy constraints: ${error.message}`);
  }

  await db.from("agent_decisions").insert({
    user_id: input.userId,
    strategy_id: strategyRow.id,
    provider: input.aiSource,
    model: input.aiModel,
    intent: input.intent,
    proposed_action: input.strategy,
    approved_action: null,
  });
  await db.from("audit_events").insert({
    user_id: input.userId,
    strategy_id: strategyRow.id,
    event_type: "strategy_compiled",
    prompt_hash: sha256(input.prompt),
    strategy_version: 1,
    metadata: { strategyHash, aiSource: input.aiSource, aiModel: input.aiModel },
  });

  return { strategyId: strategyRow.id as string, strategyVersionId: versionRow.id as string, version: 1, strategyHash };
}

export async function loadOwnedStrategyVersion(userId: string, versionId: string) {
  const db = getAdminSupabase();
  const { data: version, error } = await db
    .from("strategy_versions")
    .select("id,strategy_id,version,parsed_intent,compiled_strategy,strategy_hash")
    .eq("id", versionId)
    .maybeSingle();
  if (error || !version) throw new Error("Strategy version not found");
  const { data: strategy } = await db.from("strategies").select("id,user_id,status").eq("id", version.strategy_id).maybeSingle();
  if (!strategy || strategy.user_id !== userId) throw new Error("Strategy version not found");
  return { version, strategy };
}
