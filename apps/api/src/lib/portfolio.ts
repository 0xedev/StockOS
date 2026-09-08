import { getAdminSupabase } from "./db.ts";

export async function getPortfolioState(userId: string) {
  const db = getAdminSupabase();

  const { data: activeStrategy, error: strategyError } = await db
    .from("strategies")
    .select("id,name,status,current_version,created_at,updated_at")
    .eq("user_id", userId)
    .eq("status", "active")
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (strategyError) throw new Error(`Could not load active strategy: ${strategyError.message}`);

  const { data: latestPlan, error: planError } = await db
    .from("execution_plans")
    .select("id,strategy_id,strategy_version,status,plan,created_at,updated_at")
    .eq("user_id", userId)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (planError) throw new Error(`Could not load execution state: ${planError.message}`);

  let latestExecution = null as any;
  if (latestPlan) {
    const { data, error } = await db
      .from("executions")
      .select("id,status,tx_hash,submitted_at,confirmed_at,failure_code,failure_message,created_at,updated_at")
      .eq("execution_plan_id", latestPlan.id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(`Could not load execution: ${error.message}`);
    latestExecution = data;
  }

  let strategyVersion = null as any;
  let rebalanceRule = null as any;
  if (activeStrategy) {
    const { data: version, error: versionError } = await db
      .from("strategy_versions")
      .select("id,version,parsed_intent,compiled_strategy,strategy_hash,created_at")
      .eq("strategy_id", activeStrategy.id)
      .eq("version", activeStrategy.current_version)
      .maybeSingle();
    if (versionError) throw new Error(`Could not load active strategy version: ${versionError.message}`);
    strategyVersion = version;

    const { data: rule, error: ruleError } = await db
      .from("automation_rules")
      .select("id,rule_type,parameters,enabled,next_run_at,expires_at")
      .eq("strategy_id", activeStrategy.id)
      .eq("enabled", true)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (ruleError) throw new Error(`Could not load automation rule: ${ruleError.message}`);
    rebalanceRule = rule;
  }

  const { data: wallet, error: walletError } = await db
    .from("wallets")
    .select("id,smart_account_address")
    .eq("user_id", userId)
    .eq("chain_id", 8453)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (walletError) throw new Error(`Could not load wallet: ${walletError.message}`);

  let snapshot = null as any;
  if (wallet) {
    const { data, error } = await db
      .from("portfolio_snapshots")
      .select("id,total_value_usd,cash_value_usd,positions,block_number,captured_at")
      .eq("user_id", userId)
      .eq("wallet_id", wallet.id)
      .order("captured_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(`Could not load portfolio snapshot: ${error.message}`);
    snapshot = data;
  }

  const positions = Array.isArray(snapshot?.positions) ? snapshot.positions : [];
  const largestDrift = positions.reduce((largest: number, position: any) => {
    const drift = Number(position?.absoluteDrift ?? 0);
    return Number.isFinite(drift) ? Math.max(largest, drift) : largest;
  }, 0);

  const execution = latestPlan
    ? {
        planId: latestPlan.id,
        strategyId: latestPlan.strategy_id,
        planStatus: latestPlan.status,
        phase: (latestPlan.plan as any)?.phase ?? null,
        status: latestExecution?.status ?? latestPlan.status,
        transactionHash: latestExecution?.tx_hash ?? null,
        submittedAt: latestExecution?.submitted_at ?? null,
        confirmedAt: latestExecution?.confirmed_at ?? null,
        failureCode: latestExecution?.failure_code ?? null,
        failureMessage: latestExecution?.failure_message ?? null,
        updatedAt: latestExecution?.updated_at ?? latestPlan.updated_at,
      }
    : null;

  return {
    activeStrategy: activeStrategy
      ? {
          id: activeStrategy.id,
          name: activeStrategy.name,
          status: activeStrategy.status,
          version: activeStrategy.current_version,
          activatedAt: activeStrategy.updated_at,
          intent: strategyVersion?.parsed_intent ?? null,
          strategy: strategyVersion?.compiled_strategy ?? null,
          nextRebalanceAt: rebalanceRule?.next_run_at ?? null,
          rebalance: rebalanceRule?.parameters ?? null,
        }
      : null,
    portfolio: snapshot
      ? {
          totalValueUsd: Number(snapshot.total_value_usd ?? 0),
          cashValueUsd: Number(snapshot.cash_value_usd ?? 0),
          positions,
          largestDrift,
          blockNumber: snapshot.block_number,
          capturedAt: snapshot.captured_at,
        }
      : null,
    execution,
    wallet: wallet ? { address: wallet.smart_account_address } : null,
  };
}
