export function scaledBalance(rawBalance: bigint, decimals: number, multiplier: bigint, multiplierDecimals = 18): number {
  const raw = Number(rawBalance) / 10 ** decimals;
  const mul = Number(multiplier) / 10 ** multiplierDecimals;
  return raw * mul;
}
export function rawFromScaled(scaled: number, decimals: number, multiplier: bigint, multiplierDecimals = 18): bigint {
  const mul = Number(multiplier) / 10 ** multiplierDecimals;
  return BigInt(Math.round((scaled / mul) * 10 ** decimals));
}
