import { createHash } from "node:crypto";
import type { CompiledStrategy, InvestmentIntent } from "../../../../packages/core/src/types.ts";
import { getAdminSupabase } from "./db.ts";

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function nextRebalanceAt(rebalance: InvestmentIntent["automation"]["rebalance"] | undefined): string | null {
  if (!rebalance || rebalance === "NONE") return null;
  const next = new Date();
  if (rebalance === "WEEKLY") next.setUTCDate(next.getUTCDate() + 7);
  if (rebalance === "MONTHLY") next.setUTCMonth(next.getUTCMonth() + 1);
  if (rebalance === "QUARTERLY") next.setUTCMonth(next.getUTCMonth() + 3);
  return next.toISOString();
}

async function persistVersionDetails(input: {
  userId: string;
  strategyId: string;
  version: number;
  prompt: string;
  intent: InvestmentIntent;
  strategy: CompiledStrategy;
  aiSource: string;
  aiModel: string;
  eventType: "strategy_compiled" | "strategy_amendment_compiled";
}) {
  const db = getAdminSupabase();
  const strategyHash = sha256(JSON.stringify(input.strategy));
  const { data: versionRow, error: versionError } = await db
    .from("strategy_versions")
    .insert({
      strategy_id: input.strategyId,
      version: input.version,
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
    strategy_id: input.strategyId,
    provider: input.aiSource,
    model: input.aiModel,
    intent: input.intent,
    proposed_action: input.strategy,
    approved_action: null,
  });
  await db.from("audit_events").insert({
    user_id: input.userId,
    strategy_id: input.strategyId,
    event_type: input.eventType,
    prompt_hash: sha256(input.prompt),
    strategy_version: input.version,
    metadata: { strategyHash, aiSource: input.aiSource, aiModel: input.aiModel },
  });

  return { strategyVersionId: versionRow.id as string, strategyHash };
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

  const persisted = await persistVersionDetails({
    ...input,
    strategyId: strategyRow.id,
    version: 1,
    eventType: "strategy_compiled",
  });

  const nextRunAt = nextRebalanceAt(input.intent.automation?.rebalance);
  if (nextRunAt) {
    const { error } = await db.from("automation_rules").insert({
      strategy_id: strategyRow.id,
      rule_type: "scheduled_rebalance",
      parameters: {
        frequency: input.intent.automation?.rebalance,
        mode: "user_approval_required",
        source: "strategy_intent",
      },
      enabled: true,
      next_run_at: nextRunAt,
    });
    if (error) throw new Error(`Could not persist rebalance rule: ${error.message}`);
  }

  return {
    strategyId: strategyRow.id as string,
    strategyVersionId: persisted.strategyVersionId,
    version: 1,
    strategyHash: persisted.strategyHash,
  };
}

export async function getActiveStrategyContext(userId: string) {
  const db = getAdminSupabase();
  const { data: strategy, error: strategyError } = await db
    .from("strategies")
    .select("id,name,status,current_version")
    .eq("user_id", userId)
    .eq("status", "active")
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (strategyError) throw new Error(`Could not load active strategy: ${strategyError.message}`);
  if (!strategy) return null;

  const { data: version, error: versionError } = await db
    .from("strategy_versions")
    .select("id,version,parsed_intent,compiled_strategy,strategy_hash")
    .eq("strategy_id", strategy.id)
    .eq("version", strategy.current_version)
    .maybeSingle();
  if (versionError) throw new Error(`Could not load active strategy version: ${versionError.message}`);
  if (!version) throw new Error("Active strategy version not found");

  return { strategy, version };
}

export async function persistStrategyAmendment(input: {
  userId: string;
  prompt: string;
  intent: InvestmentIntent;
  strategy: CompiledStrategy;
  aiSource: string;
  aiModel: string;
}) {
  const db = getAdminSupabase();
  const active = await getActiveStrategyContext(input.userId);
  if (!active) throw new Error("No active strategy to adjust");

  const { data: latestVersion, error: latestError } = await db
    .from("strategy_versions")
    .select("version")
    .eq("strategy_id", active.strategy.id)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (latestError) throw new Error(`Could not determine next strategy version: ${latestError.message}`);
  const nextVersion = Math.max(Number(active.strategy.current_version ?? 1), Number(latestVersion?.version ?? 1)) + 1;

  const persisted = await persistVersionDetails({
    ...input,
    strategyId: active.strategy.id,
    version: nextVersion,
    eventType: "strategy_amendment_compiled",
  });

  return {
    strategyId: active.strategy.id as string,
    strategyVersionId: persisted.strategyVersionId,
    version: nextVersion,
    previousVersion: active.strategy.current_version as number,
    strategyHash: persisted.strategyHash,
    amendment: true,
  };
}

export async function loadOwnedStrategyVersion(userId: string, versionId: string) {
  const db = getAdminSupabase();
  const { data: version, error } = await db
    .from("strategy_versions")
    .select("id,strategy_id,version,parsed_intent,compiled_strategy,strategy_hash")
    .eq("id", versionId)
    .maybeSingle();
  if (error || !version) throw new Error("Strategy version not found");
  const { data: strategy } = await db.from("strategies").select("id,user_id,status,current_version").eq("id", version.strategy_id).maybeSingle();
  if (!strategy || strategy.user_id !== userId) throw new Error("Strategy version not found");
  return { version, strategy };
}
