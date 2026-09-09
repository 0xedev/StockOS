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

let cachedConfig: ReturnType<typeof getDefaultConfig> | null = null;

function getAerodromeConfig() {
  const rpcUrl = process.env.BASE_RPC_URL;
  if (!rpcUrl) throw new Error("BASE_RPC_URL is required for Aerodrome routing");
  if (!cachedConfig) {
    cachedConfig = getDefaultConfig({
      chains: [{ chain: base, rpcUrl }],
    });
  }
  return cachedConfig;
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
  const config = getAerodromeConfig();
  const fromToken = makeToken({ address: input.fromToken, symbol: input.fromSymbol, decimals: input.fromDecimals });
  const toToken = makeToken({ address: input.toToken, symbol: input.toSymbol, decimals: input.toDecimals });

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
  };
}

export async function buildAerodromeSwapTransaction(input: {
  quote: AerodromeQuote;
  account: string;
  slippage?: number;
}): Promise<UnsignedSwapTransaction> {
  const config = getAerodromeConfig();
  return swap({
    config,
    quote: input.quote.rawQuote,
    slippage: input.slippage ?? 0.005,
    unsignedTransactionOnly: true,
    account: input.account as Address,
  });
}
