import { createPublicClient, encodeFunctionData, formatUnits, http, isAddress, parseAbi, type Address } from "viem";
import { base } from "viem/chains";
import type { SupportedAsset } from "../../../../packages/core/src/types.ts";

const erc20Abi = parseAbi([
  "function decimals() view returns (uint8)",
  "function balanceOf(address account) view returns (uint256)",
  "function allowance(address owner,address spender) view returns (uint256)",
  "function approve(address spender,uint256 amount) returns (bool)",
]);
const aggregatorAbi = parseAbi([
  "function decimals() view returns (uint8)",
  "function latestRoundData() view returns (uint80 roundId,int256 answer,uint256 startedAt,uint256 updatedAt,uint80 answeredInRound)",
]);

let client: ReturnType<typeof createPublicClient> | null = null;
export function getBaseClient() {
  if (!client) client = createPublicClient({ chain: base, transport: http(process.env.BASE_RPC_URL ?? "https://mainnet.base.org") });
  return client;
}

function address(value: string, label: string): Address {
  if (!isAddress(value)) throw new Error(`${label} is not a valid EVM address`);
  return value;
}

export async function readTokenDecimals(token: string): Promise<number> {
  const decimals = await getBaseClient().readContract({ address: address(token, "token"), abi: erc20Abi, functionName: "decimals" });
  return Number(decimals);
}

export async function readTokenBalance(token: string, account: string): Promise<bigint> {
  return getBaseClient().readContract({ address: address(token, "token"), abi: erc20Abi, functionName: "balanceOf", args: [address(account, "account")] });
}

export async function readAllowance(token: string, owner: string, spender: string): Promise<bigint> {
  return getBaseClient().readContract({
    address: address(token, "token"),
    abi: erc20Abi,
    functionName: "allowance",
    args: [address(owner, "owner"), address(spender, "spender")],
  });
}

export function encodeExactApproval(spender: string, amount: bigint): `0x${string}` {
  return encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [address(spender, "spender"), amount] });
}

function feedEnvName(asset: SupportedAsset): string {
  return `CHAINLINK_FEED_${asset.toUpperCase()}`;
}

export type ReferencePrice = {
  configured: boolean;
  feed?: string;
  priceUsd?: number;
  updatedAt?: string;
  ageSeconds?: number;
  decimals?: number;
};

export async function readReferencePrice(asset: SupportedAsset): Promise<ReferencePrice> {
  if (asset === "USDC") return { configured: true, priceUsd: 1, updatedAt: new Date().toISOString(), ageSeconds: 0, decimals: 8 };
  const feed = process.env[feedEnvName(asset)];
  if (!feed) return { configured: false };
  const feedAddress = address(feed, `${asset} Chainlink feed`);
  const [decimals, round] = await Promise.all([
    getBaseClient().readContract({ address: feedAddress, abi: aggregatorAbi, functionName: "decimals" }),
    getBaseClient().readContract({ address: feedAddress, abi: aggregatorAbi, functionName: "latestRoundData" }),
  ]);
  const answer = round[1];
  const updatedAt = round[3];
  if (answer <= 0n || updatedAt <= 0n) throw new Error(`${asset} Chainlink feed returned invalid data`);
  const priceUsd = Number(formatUnits(answer, Number(decimals)));
  const updatedMs = Number(updatedAt) * 1000;
  return {
    configured: true,
    feed: feedAddress,
    priceUsd,
    updatedAt: new Date(updatedMs).toISOString(),
    ageSeconds: Math.max(0, Math.floor((Date.now() - updatedMs) / 1000)),
    decimals: Number(decimals),
  };
}
