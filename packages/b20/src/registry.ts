import type { SupportedAsset } from "../../core/src/types.ts";

export type AssetRecord = {
  symbol: SupportedAsset;
  underlying: string;
  company: string;
  address: `0x${string}` | null;
  decimals: number | null;
  kind: "cash" | "b20";
  enabled: boolean;
};

// Official Coinbase B20 onchain registry on Base Mainnet.
// Source: https://docs.base.org/specifications/b20/tokenized-stocks-on-base
export const B20_ONCHAIN_REGISTRY = "0x3f3E8cf41cdd3b1D118c16471aB0113DfDDd5CaD" as const;

// B20 asset decimals are configurable at deployment (6-18). Never use a guessed
// decimal count for execution. StockOS reads decimals() from the live token.
// Tokens are identified by address, not ticker/symbol, because B20 metadata is mutable.
export const ASSETS: Record<SupportedAsset, AssetRecord> = {
  USDC: { symbol: "USDC", underlying: "USD", company: "USD Coin", address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6, kind: "cash", enabled: true },
  NVDAc: { symbol: "NVDAc", underlying: "NVDA", company: "NVIDIA", address: "0xb20000000000000000000078ee7ce2fE4908108C", decimals: null, kind: "b20", enabled: true },
  GOOGLc: { symbol: "GOOGLc", underlying: "GOOGL", company: "Alphabet", address: "0xb2000000000000000000002D0BA3164cc74f58B7", decimals: null, kind: "b20", enabled: true },
  METAc: { symbol: "METAc", underlying: "META", company: "Meta", address: "0xb2000000000000000000008bC8786B856E61707C", decimals: null, kind: "b20", enabled: true },
  AAPLc: { symbol: "AAPLc", underlying: "AAPL", company: "Apple", address: "0xb200000000000000000000C2e324d24d7eEcd1fb", decimals: null, kind: "b20", enabled: true },
};

export function assertSupportedAsset(asset: string): asserts asset is SupportedAsset {
  if (!(asset in ASSETS)) throw new Error(`Unsupported asset: ${asset}`);
}
