import { CdpClient } from "@coinbase/cdp-sdk";

let client: CdpClient | null = null;

export function getCdpClient(): CdpClient {
  if (client) return client;
  const apiKeyId = process.env.CDP_API_KEY_ID;
  const apiKeySecret = process.env.CDP_API_KEY_SECRET;
  if (!apiKeyId || !apiKeySecret) {
    throw new Error("CDP_API_KEY_ID and CDP_API_KEY_SECRET must be configured");
  }
  const options: Record<string, string> = { apiKeyId, apiKeySecret };
  if (process.env.CDP_WALLET_SECRET) options.walletSecret = process.env.CDP_WALLET_SECRET;
  client = new CdpClient(options);
  return client;
}

export async function validateCdpAccessToken(accessToken: string) {
  return getCdpClient().endUser.validateAccessToken({ accessToken });
}
