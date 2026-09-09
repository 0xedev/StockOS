import { getCdpClient } from "./cdp.ts";

export type CdpSwapPriceProbe = {
  liquidityAvailable: boolean;
  toAmount: string | null;
  minToAmount: string | null;
  allowanceSpender: string | null;
  balanceIssue: boolean;
  simulationIncomplete: boolean;
  raw: unknown;
};

function amountToString(value: unknown): string | null {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string" && /^\d+$/.test(value)) return value;
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return Math.trunc(value).toString();
  return null;
}

function safeTradeError(error: unknown) {
  if (!(error instanceof Error)) return { message: "Unknown CDP Trade API failure" };
  const anyError = error as any;
  return {
    name: error.name,
    message: error.message,
    status: anyError?.status ?? anyError?.statusCode ?? anyError?.response?.status ?? null,
    code: anyError?.code ?? anyError?.error?.code ?? null,
  };
}

/**
 * Non-destructive Coinbase CDP Trade API price discovery.
 * This calls getSwapPrice only; it does not create a firm quote, sign, or submit a transaction.
 */
export async function getCdpSwapPriceProbe(input: {
  fromToken: string;
  toToken: string;
  fromAmount: bigint;
  taker: string;
  slippageBps?: number;
}): Promise<CdpSwapPriceProbe> {
  const cdp = getCdpClient();
  let result: unknown;
  try {
    result = await cdp.evm.getSwapPrice({
      network: "base",
      fromToken: input.fromToken as `0x${string}`,
      toToken: input.toToken as `0x${string}`,
      fromAmount: input.fromAmount,
      taker: input.taker as `0x${string}`,
      slippageBps: input.slippageBps ?? 50,
    });
  } catch (error) {
    // Safe observability only: no credentials, auth headers, or response bodies are logged.
    console.warn("cdp_trade_price_probe_failed", {
      ...safeTradeError(error),
      network: "base",
      fromToken: input.fromToken,
      toToken: input.toToken,
      fromAmount: input.fromAmount.toString(),
      taker: input.taker,
    });
    throw error;
  }

  const raw = result as any;
  return {
    liquidityAvailable: raw?.liquidityAvailable !== false,
    toAmount: amountToString(raw?.toAmount),
    minToAmount: amountToString(raw?.minToAmount),
    allowanceSpender: typeof raw?.issues?.allowance?.spender === "string" ? raw.issues.allowance.spender : null,
    balanceIssue: !!raw?.issues?.balance,
    simulationIncomplete: !!raw?.issues?.simulationIncomplete,
    raw: result,
  };
}
