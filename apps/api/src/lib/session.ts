import type { FastifyReply, FastifyRequest } from "fastify";
import { validateCdpAccessToken } from "./cdp.ts";
import { getAdminSupabase } from "./db.ts";

type EndUserLike = {
  userId: string;
  authenticationMethods?: { email?: { email?: string } };
  evmAccounts?: string[];
  evmAccountObjects?: Array<{ address: string }>;
  evmSmartAccounts?: string[];
  evmSmartAccountObjects?: Array<{ address: string; ownerAddresses?: string[] }>;
};

export type StockOsSession = {
  profile: { id: string; cdpUserId: string; email: string | null };
  wallet: { smartAccountAddress: string | null; ownerAddress: string | null; spendPermissionsEnabled: boolean };
};

function bearerToken(request: FastifyRequest): string | null {
  const value = request.headers.authorization;
  if (!value?.startsWith("Bearer ")) return null;
  return value.slice(7).trim() || null;
}

export async function syncEndUser(endUserInput: unknown): Promise<StockOsSession> {
  const endUser = endUserInput as EndUserLike;
  if (!endUser?.userId) throw new Error("CDP end user did not contain a userId");
  const db = getAdminSupabase();
  const email = endUser.authenticationMethods?.email?.email ?? null;
  const { data: profile, error: profileError } = await db
    .from("profiles")
    .upsert(
      { cdp_user_id: endUser.userId, email, auth_method: "cdp", updated_at: new Date().toISOString() },
      { onConflict: "cdp_user_id" },
    )
    .select("id,cdp_user_id,email")
    .single();
  if (profileError || !profile) throw new Error(`Profile sync failed: ${profileError?.message ?? "unknown"}`);

  const smartObject = endUser.evmSmartAccountObjects?.[0];
  const smartAccountAddress = smartObject?.address ?? endUser.evmSmartAccounts?.[0] ?? null;
  const ownerAddress = smartObject?.ownerAddresses?.[0] ?? endUser.evmAccountObjects?.[0]?.address ?? endUser.evmAccounts?.[0] ?? null;

  if (smartAccountAddress) {
    const { data: existing, error: lookupError } = await db
      .from("wallets")
      .select("id")
      .eq("user_id", profile.id)
      .eq("smart_account_address", smartAccountAddress)
      .maybeSingle();
    if (lookupError) throw new Error(`Wallet lookup failed: ${lookupError.message}`);
    const walletRecord = {
      user_id: profile.id,
      owner_address: ownerAddress,
      smart_account_address: smartAccountAddress,
      chain_id: 8453,
      spend_permissions_enabled: true,
    };
    const query = existing
      ? db.from("wallets").update(walletRecord).eq("id", existing.id)
      : db.from("wallets").insert(walletRecord);
    const { error: walletError } = await query;
    if (walletError) throw new Error(`Wallet sync failed: ${walletError.message}`);
  }

  return {
    profile: {
      id: profile.id,
      cdpUserId: profile.cdp_user_id,
      email: profile.email,
    },
    wallet: { smartAccountAddress, ownerAddress, spendPermissionsEnabled: !!smartAccountAddress },
  };
}

export async function requireStockOsSession(request: FastifyRequest, reply: FastifyReply): Promise<StockOsSession | null> {
  const token = bearerToken(request);
  if (!token) {
    await reply.code(401).send({ error: "authentication_required" });
    return null;
  }
  try {
    const endUser = await validateCdpAccessToken(token);
    return await syncEndUser(endUser);
  } catch (error) {
    request.log.warn({ err: error }, "CDP authentication failed");
    await reply.code(401).send({ error: "invalid_or_expired_session" });
    return null;
  }
}
