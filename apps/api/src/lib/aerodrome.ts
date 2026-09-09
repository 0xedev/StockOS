import {
  base,
  getDefaultConfig,
  swap,
  type Quote,
  type Token,
  type UnsignedSwapTransaction,
} from "@dromos-labs/sdk.js";
import {
  createPublicClient,
  decodeFunctionResult,
  encodeFunctionData,
  encodePacked,
  http,
  isAddressEqual,
  zeroAddress,
  type Address,
} from "viem";

const BASE_CHAIN_ID = 8453;

// Coinbase B20 launch liquidity lives on Aerodrome's newest Slipstream factory.
// Current Aerodrome Sugar SDK uses 0x080000 to identify this factory in mixed-route paths.
const NEW_SLIPSTREAM_FACTORY = "0xf8f2eB4940CFE7d13603DDDD87f123820Fc061Ef" as Address;
const LEGACY_SLIPSTREAM_FACTORY = "0x5e7BB104d84c7CB9B682AaC2F3d509f5F406809A" as Address;
const NEW_SLIPSTREAM_FACTORY_BITMASK = 0x080000;

// Current Base contracts from the upstream Aerodrome Sugar SDK configuration.
const AERODROME_QUOTER = "0xCd2A7D98e82D6107eac1828ce8DeAA6acB65b555" as Address;
const AERODROME_UNIVERSAL_ROUTER = "0xcAF22ce31298CF2BF1D152862F80216478ad7c67" as Address;

// B20 launch pools are CL10 (0.05%). Keep a small deterministic fallback set in case
// a supported asset moves to another concentrated-liquidity tick spacing later.
const DIRECT_TICK_SPACINGS = [10, 1, 50, 100, 200] as const;

const CL_FACTORY_ABI = [
  {
    type: "function",
    name: "getPool",
    stateMutability: "view",
    inputs: [
      { name: "tokenA", type: "address" },
      { name: "tokenB", type: "address" },
      { name: "tickSpacing", type: "int24" },
    ],
    outputs: [{ name: "pool", type: "address" }],
  },
] as const;

const QUOTER_ABI = [
  {
    type: "function",
    name: "quoteExactInput",
    stateMutability: "nonpayable",
    inputs: [
      { name: "path", type: "bytes" },
      { name: "amountIn", type: "uint256" },
    ],
    outputs: [
      { name: "amountOut", type: "uint256" },
      { name: "v3SqrtPriceX96AfterList", type: "uint160[]" },
      { name: "v3InitializedTicksCrossedList", type: "uint32[]" },
      { name: "v3SwapGasEstimate", type: "uint256" },
    ],
  },
] as const;

type AerodromeConfig = ReturnType<typeof getDefaultConfig>;
let cachedConfig: AerodromeConfig | null = null;
let cachedClient: ReturnType<typeof createPublicClient> | null = null;

function configuredRpcUrl(): string {
  const rpcUrl = process.env.BASE_RPC_URL?.trim();
  if (!rpcUrl) throw new Error("BASE_RPC_URL is required for Aerodrome routing");
  return rpcUrl;
}

function rpcLabel(): string {
  try {
    return new URL(configuredRpcUrl()).host;
  } catch {
    return "configured-base-rpc";
  }
}

function getClient() {
  if (!cachedClient) {
    cachedClient = createPublicClient({
      chain: base,
      transport: http(configuredRpcUrl(), {
        batch: true,
        retryCount: 2,
        retryDelay: 150,
        timeout: 12_000,
      }),
    });
  }
  return cachedClient;
}

function getAerodromeConfig(): AerodromeConfig {
  if (!cachedConfig) {
    const config = getDefaultConfig({
      chains: [{ chain: base, rpcUrl: configuredRpcUrl() }],
    });
    const baseChainConfig = config.sugarConfig.chains.find(chain => chain.CHAIN.id === BASE_CHAIN_ID);
    if (!baseChainConfig) throw new Error("Aerodrome Base configuration is unavailable");

    // @dromos-labs/sdk.js@0.3.0-alpha.3 predates the current Base router deployment.
    // We use the SDK only to encode the unsigned Universal Router transaction. The route
    // itself is discovered and quoted directly below using current Aerodrome contracts.
    // Keep the SDK's factory marker on the legacy factory so a pre-encoded 0x080000 B20
    // route is not incorrectly rewritten with the alpha SDK's older 0x100000 marker.
    Object.assign(baseChainConfig, {
      UNIVERSAL_ROUTER_ADDRESS: AERODROME_UNIVERSAL_ROUTER,
      SLIPSTREAM_FACTORY_ADDRESS: LEGACY_SLIPSTREAM_FACTORY,
    });

    cachedConfig = config;
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

function compactError(error: unknown): string {
  const record = error && typeof error === "object" ? error as Record<string, unknown> : null;
  const cause = record?.cause && typeof record.cause === "object"
    ? record.cause as Record<string, unknown>
    : null;
  const values = [
    record?.shortMessage,
    record?.details,
    cause?.shortMessage,
    cause?.details,
    error instanceof Error ? error.message : String(error),
  ].filter((value): value is string => typeof value === "string" && value.length > 0);

  let text = values.join(" | ");
  text = text.replace(/https?:\/\/[^\s"']+/gi, "[rpc]");
  text = text.replace(/\/v2\/[A-Za-z0-9_-]+/g, "/v2/[redacted]");
  text = text.replace(/Request body:[\s\S]*/gi, "[request body redacted]");
  text = text.replace(/0x[a-fA-F0-9]{128,}/g, "[calldata]");
  text = text.replace(/\s+/g, " ").trim();
  return text.slice(0, 500) || "unknown_rpc_error";
}

async function findDirectB20Pool(fromToken: Address, toToken: Address) {
  const client = getClient();
  for (const tickSpacing of DIRECT_TICK_SPACINGS) {
    const pool = await client.readContract({
      address: NEW_SLIPSTREAM_FACTORY,
      abi: CL_FACTORY_ABI,
      functionName: "getPool",
      args: [fromToken, toToken, tickSpacing],
    });
    if (!isAddressEqual(pool, zeroAddress)) {
      return { pool, tickSpacing };
    }
  }
  return null;
}

async function quoteDirectB20(input: {
  fromToken: Address;
  toToken: Address;
  amountIn: bigint;
  tickSpacing: number;
}) {
  const flaggedTickSpacing = input.tickSpacing | NEW_SLIPSTREAM_FACTORY_BITMASK;
  const path = encodePacked(
    ["address", "int24", "address"],
    [input.fromToken, flaggedTickSpacing, input.toToken],
  );
  const data = encodeFunctionData({
    abi: QUOTER_ABI,
    functionName: "quoteExactInput",
    args: [path, input.amountIn],
  });
  const result = await getClient().call({
    to: AERODROME_QUOTER,
    data,
  });
  if (!result.data) throw new Error("Aerodrome quoter returned no data");

  const decoded = decodeFunctionResult({
    abi: QUOTER_ABI,
    functionName: "quoteExactInput",
    data: result.data,
  });
  return { amountOut: decoded[0], flaggedTickSpacing };
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
  const fromToken = makeToken({ address: input.fromToken, symbol: input.fromSymbol, decimals: input.fromDecimals });
  const toToken = makeToken({ address: input.toToken, symbol: input.toSymbol, decimals: input.toDecimals });

  try {
    const directPool = await findDirectB20Pool(fromToken.address, toToken.address);
    if (!directPool) return null;

    const { amountOut, flaggedTickSpacing } = await quoteDirectB20({
      fromToken: fromToken.address,
      toToken: toToken.address,
      amountIn: input.amountIn,
      tickSpacing: directPool.tickSpacing,
    });
    if (amountOut <= 0n) return null;

    const routeNode = {
      from: fromToken.address,
      to: toToken.address,
      lp: directPool.pool,
      factory: NEW_SLIPSTREAM_FACTORY,
      // Pre-flag for the current Slipstream factory. The alpha JS SDK must not rewrite it.
      type: flaggedTickSpacing,
      pool_fee: 500n,
      chainId: BASE_CHAIN_ID,
    };
    const rawQuote: Quote = {
      path: { nodes: [routeNode] },
      amount: input.amountIn,
      amountOut,
      fromToken,
      toToken,
      priceImpact: 0n,
      spenderAddress: AERODROME_UNIVERSAL_ROUTER,
    };

    return {
      provider: "aerodrome",
      amountIn: input.amountIn,
      amountOut,
      spenderAddress: AERODROME_UNIVERSAL_ROUTER,
      priceImpact: 0n,
      path: [{
        from: routeNode.from,
        to: routeNode.to,
        pool: routeNode.lp,
        factory: routeNode.factory,
        type: routeNode.type,
        poolFee: routeNode.pool_fee,
      }],
      rawQuote,
    };
  } catch (error) {
    console.error("aerodrome_quote_failed", {
      provider: rpcLabel(),
      fromToken: fromToken.address,
      toToken: toToken.address,
      amountIn: input.amountIn.toString(),
      detail: compactError(error),
    });
    throw new Error("Aerodrome quote discovery failed on the configured Base RPC. No transaction was created.");
  }
}

export async function buildAerodromeSwapTransaction(input: {
  quote: AerodromeQuote;
  account: string;
  slippage?: number;
}): Promise<UnsignedSwapTransaction> {
  try {
    return await swap({
      config: getAerodromeConfig(),
      quote: input.quote.rawQuote,
      slippage: input.slippage ?? 0.005,
      unsignedTransactionOnly: true,
      account: input.account as Address,
    });
  } catch (error) {
    console.error("aerodrome_transaction_prepare_failed", {
      provider: rpcLabel(),
      detail: compactError(error),
    });
    throw new Error("Aerodrome transaction preparation failed. No transaction was created.");
  }
}
