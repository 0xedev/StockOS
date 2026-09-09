import {
  base,
  getDefaultConfig,
  getQuoteForSwap,
  swap,
  type Quote,
  type Token,
  type UnsignedSwapTransaction,
} from "@dromos-labs/sdk.js";
import type { Address } from "viem";

const BASE_CHAIN_ID = 8453;
const DEFAULT_RPC_FALLBACKS = [
  "https://mainnet-preconf.base.org",
  "https://base-rpc.publicnode.com",
] as const;

const configCache = new Map<string, ReturnType<typeof getDefaultConfig>>();
let preferredRpcUrl: string | null = null;

function configuredRpcUrls(): string[] {
  const explicit = (process.env.AERODROME_RPC_URLS ?? "")
    .split(/[;,\s]+/)
    .map(value => value.trim())
    .filter(Boolean);
  const urls = [
    ...explicit,
    process.env.BASE_RPC_URL,
    ...DEFAULT_RPC_FALLBACKS,
  ].filter((value): value is string => Boolean(value));

  const unique = [...new Set(urls)];
  if (!unique.length) {
    throw new Error("No Base RPC URL is configured for Aerodrome routing");
  }
  if (preferredRpcUrl && unique.includes(preferredRpcUrl)) {
    return [preferredRpcUrl, ...unique.filter(url => url !== preferredRpcUrl)];
  }
  return unique;
}

function rpcLabel(rpcUrl: string): string {
  try {
    return new URL(rpcUrl).host;
  } catch {
    return "configured-rpc";
  }
}

function getAerodromeConfig(rpcUrl: string) {
  let config = configCache.get(rpcUrl);
  if (!config) {
    config = getDefaultConfig({
      chains: [{ chain: base, rpcUrl }],
    });
    configCache.set(rpcUrl, config);
  }
  return config;
}

function compactError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/over rate limit|rate limit|too many requests|\b429\b/i.test(message)) return "rate_limited";
  if (/timeout|timed out|ETIMEDOUT/i.test(message)) return "timeout";
  if (/ECONNRESET|ECONNREFUSED|network|fetch failed/i.test(message)) return "network_error";
  if (/execution reverted|reverted/i.test(message)) return "execution_reverted";
  return "rpc_error";
}

async function withAerodromeRpc<T>(
  operation: string,
  runner: (config: ReturnType<typeof getDefaultConfig>, rpcUrl: string) => Promise<T>,
  preferred?: string,
): Promise<T> {
  const baseUrls = configuredRpcUrls();
  const urls = preferred && baseUrls.includes(preferred)
    ? [preferred, ...baseUrls.filter(url => url !== preferred)]
    : baseUrls;
  const failures: Array<{ provider: string; reason: string }> = [];

  for (const rpcUrl of urls) {
    try {
      const result = await runner(getAerodromeConfig(rpcUrl), rpcUrl);
      preferredRpcUrl = rpcUrl;
      return result;
    } catch (error) {
      failures.push({ provider: rpcLabel(rpcUrl), reason: compactError(error) });
    }
  }

  console.error("aerodrome_rpc_exhausted", { operation, failures });
  throw new Error(`All configured Base RPC providers failed during Aerodrome ${operation}`);
}

function makeToken(input: {
  address: string;
  symbol: string;
  decimals: number;
}): Token {
  return {
    chainId: BASE_CHAIN_ID,
    address: input.address.toLowerCase() as Address,
    symbol: input.symbol,
    name: input.symbol,
    listed: true,
    decimals: input.decimals,
    balance: 0n,
    price: 0n,
    balanceValue: 0n,
  };
}

export type AerodromeQuote = {
  provider: "aerodrome";
  amountIn: bigint;
  amountOut: bigint;
  spenderAddress: Address;
  priceImpact: bigint;
  path: Array<{
    from: Address;
    to: Address;
    pool: Address;
    factory: Address;
    type: number;
    poolFee: bigint;
  }>;
  rawQuote: Quote;
  rpcUrl: string;
};

export async function getAerodromeSwapQuote(input: {
  fromToken: string;
  fromSymbol: string;
  fromDecimals: number;
  toToken: string;
  toSymbol: string;
  toDecimals: number;
  amountIn: bigint;
}): Promise<AerodromeQuote | null> {
  const fromToken = makeToken({ address: input.fromToken, symbol: input.fromSymbol, decimals: input.fromDecimals });
  const toToken = makeToken({ address: input.toToken, symbol: input.toSymbol, decimals: input.toDecimals });

  return withAerodromeRpc("quote discovery", async (config, rpcUrl) => {
    const quote = await getQuoteForSwap({
      config,
      fromToken,
      toToken,
      amountIn: input.amountIn,
    });

    if (!quote || quote.amountOut <= 0n) return null;

    return {
      provider: "aerodrome",
      amountIn: input.amountIn,
      amountOut: quote.amountOut,
      spenderAddress: quote.spenderAddress,
      priceImpact: quote.priceImpact,
      path: quote.path.nodes.map(node => ({
        from: node.from,
        to: node.to,
        pool: node.lp,
        factory: node.factory,
        type: node.type,
        poolFee: node.pool_fee,
      })),
      rawQuote: quote,
      rpcUrl,
    };
  });
}

export async function buildAerodromeSwapTransaction(input: {
  quote: AerodromeQuote;
  account: string;
  slippage?: number;
}): Promise<UnsignedSwapTransaction> {
  return withAerodromeRpc("transaction preparation", async config => {
    return swap({
      config,
      quote: input.quote.rawQuote,
      slippage: input.slippage ?? 0.005,
      unsignedTransactionOnly: true,
      account: input.account as Address,
    });
  }, input.quote.rpcUrl);
}
