import { createPublicClient, encodeFunctionData, formatUnits, http, isAddress, parseAbi, type Address } from "viem";
import { base } from "viem/chains";
import type { SupportedAsset } from "../../../../packages/core/src/types.ts";

const POLICY_REGISTRY = "0x8453000000000000000000000000000000000002" as const;

const erc20Abi = parseAbi([
  "function decimals() view returns (uint8)",
  "function balanceOf(address account) view returns (uint256)",
  "function allowance(address owner,address spender) view returns (uint256)",
  "function approve(address spender,uint256 amount) returns (bool)",
  "function transfer(address to,uint256 amount) returns (bool)",
]);
const b20Abi = parseAbi([
  "function isPaused(uint8 feature) view returns (bool)",
  "function TRANSFER_RECEIVER_POLICY() view returns (bytes32)",
  "function policyId(bytes32 policyScope) view returns (uint64)",
]);
const policyRegistryAbi = parseAbi([
  "function isAuthorized(uint64 policyId,address account) view returns (bool)",
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

export function assertEvmAddress(value: string, label = "address"): Address {
  if (!isAddress(value)) throw new Error(`${label} is not a valid EVM address`);
  return value;
}

function address(value: string, label: string): Address {
  return assertEvmAddress(value, label);
}

export async function readTokenDecimals(token: string): Promise<number> {
  const decimals = await getBaseClient().readContract({ address: address(token, "token"), abi: erc20Abi, functionName: "decimals" });
  return Number(decimals);
}

export async function readTokenBalance(token: string, account: string): Promise<bigint> {
  return getBaseClient().readContract({ address: address(token, "token"), abi: erc20Abi, functionName: "balanceOf", args: [address(account, "account")] });
}

export async function readNativeBalance(account: string): Promise<bigint> {
  return getBaseClient().getBalance({ address: address(account, "account") });
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

export function encodeTokenTransfer(recipient: string, amount: bigint): `0x${string}` {
  if (amount <= 0n) throw new Error("Transfer amount must be positive");
  return encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [address(recipient, "recipient"), amount] });
}

export type B20ReceiveSafety = {
  transferPaused: boolean;
  receiverPolicyId: bigint;
  receiverAuthorized: boolean;
};

// StockOS currently prepares BUY flows, so the user Smart Account is the B20 transfer receiver.
// 0x simulation still validates the complete route; this explicit read catches receiver-policy and
// token pause failures before we ever present a firm quote for approval.
export async function readB20ReceiveSafety(token: string, receiver: string): Promise<B20ReceiveSafety> {
  const tokenAddress = address(token, "B20 token");
  const receiverAddress = address(receiver, "receiver");
  const [transferPaused, receiverScope] = await Promise.all([
    getBaseClient().readContract({ address: tokenAddress, abi: b20Abi, functionName: "isPaused", args: [0] }),
    getBaseClient().readContract({ address: tokenAddress, abi: b20Abi, functionName: "TRANSFER_RECEIVER_POLICY" }),
  ]);
  const receiverPolicyId = await getBaseClient().readContract({
    address: tokenAddress,
    abi: b20Abi,
    functionName: "policyId",
    args: [receiverScope],
  });
  const receiverAuthorized = receiverPolicyId === 0n
    ? true
    : await getBaseClient().readContract({
        address: POLICY_REGISTRY,
        abi: policyRegistryAbi,
        functionName: "isAuthorized",
        args: [receiverPolicyId, receiverAddress],
      });
  return { transferPaused, receiverPolicyId, receiverAuthorized };
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
