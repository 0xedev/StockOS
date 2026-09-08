import { decryptByok, encryptByok, maskSecret, type EncryptedSecret } from "../../../../packages/ai/src/byok.ts";
import { defaultModelForProvider, type ByokProvider } from "../../../../packages/ai/src/providers.ts";
import { getAdminSupabase } from "./db.ts";

const FALLBACK_MODEL = "openai/gpt-5.6-luna";
const BYOK_DB_PROVIDERS = ["openrouter_byok", "openai_byok", "anthropic_byok", "gemini_byok"] as const;
const providerToDb: Record<ByokProvider, (typeof BYOK_DB_PROVIDERS)[number]> = {
  openrouter: "openrouter_byok",
  openai: "openai_byok",
  anthropic: "anthropic_byok",
  gemini: "gemini_byok",
};
const dbToProvider = Object.fromEntries(Object.entries(providerToDb).map(([provider, dbProvider]) => [dbProvider, provider])) as Record<string, ByokProvider>;

export type AiRuntime = {
  apiKey: string | null;
  model: string;
  source: "managed" | "byok" | "demo";
  provider: "managed" | ByokProvider;
};

function managedDefaultModel() { return process.env.OPENROUTER_MODEL ?? FALLBACK_MODEL; }
function masterKey(): string {
  if (!process.env.BYOK_MASTER_KEY) throw new Error("BYOK_MASTER_KEY is not configured");
  return process.env.BYOK_MASTER_KEY;
}

async function verifyProviderKey(provider: ByokProvider, apiKey: string) {
  let response: Response;
  if (provider === "openrouter") {
    response = await fetch("https://openrouter.ai/api/v1/key", { headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(10_000) });
  } else if (provider === "openai") {
    response = await fetch("https://api.openai.com/v1/models", { headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(10_000) });
  } else if (provider === "anthropic") {
    response = await fetch("https://api.anthropic.com/v1/models", {
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      signal: AbortSignal.timeout(10_000),
    });
  } else {
    response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`, { signal: AbortSignal.timeout(10_000) });
  }
  if (!response.ok) throw new Error(`${provider} rejected this API key`);
}

export async function getAiSettings(userId: string) {
  const db = getAdminSupabase();
  const { data: preference } = await db.from("ai_preferences").select("provider,model").eq("user_id", userId).maybeSingle();
  const { data: credential } = await db
    .from("ai_credentials")
    .select("id,provider,model_preference,masked_hint,last_verified_at,created_at")
    .eq("user_id", userId)
    .in("provider", [...BYOK_DB_PROVIDERS])
    .is("revoked_at", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const selectedProvider = preference?.provider ? dbToProvider[preference.provider] : undefined;
  return {
    mode: selectedProvider ? "byok" : "managed",
    provider: selectedProvider ?? "managed",
    model: preference?.model ?? credential?.model_preference ?? managedDefaultModel(),
    managedModel: managedDefaultModel(),
    byok: credential
      ? {
          configured: true,
          provider: dbToProvider[credential.provider] ?? "openrouter",
          maskedHint: credential.masked_hint,
          lastVerifiedAt: credential.last_verified_at,
          model: credential.model_preference,
        }
      : { configured: false },
    supportedProviders: ["openai", "anthropic", "gemini", "openrouter"],
  };
}

export async function saveByok(userId: string, provider: ByokProvider, apiKey: string, model?: string) {
  const normalized = apiKey.trim();
  if (!normalized) throw new Error("API key is required");
  if (!providerToDb[provider]) throw new Error("Unsupported AI provider");
  await verifyProviderKey(provider, normalized);
  const selectedModel = model?.trim() || defaultModelForProvider(provider);
  const db = getAdminSupabase();
  const encrypted = encryptByok(normalized, masterKey());
  const now = new Date().toISOString();

  await db.from("ai_credentials").update({ revoked_at: now }).eq("user_id", userId).in("provider", [...BYOK_DB_PROVIDERS]).is("revoked_at", null);
  const { error: insertError } = await db.from("ai_credentials").insert({
    user_id: userId,
    provider: providerToDb[provider],
    encrypted_secret: JSON.stringify(encrypted),
    key_version: "aes-256-gcm-v1",
    model_preference: selectedModel,
    masked_hint: maskSecret(normalized),
    last_verified_at: now,
  });
  if (insertError) throw new Error(`Could not store BYOK credential: ${insertError.message}`);
  const { error: prefError } = await db.from("ai_preferences").upsert({
    user_id: userId,
    provider: providerToDb[provider],
    model: selectedModel,
    updated_at: now,
  }, { onConflict: "user_id" });
  if (prefError) throw new Error(`Could not store AI preference: ${prefError.message}`);
  return getAiSettings(userId);
}

export async function switchToManagedAi(userId: string) {
  const db = getAdminSupabase();
  const now = new Date().toISOString();
  await db.from("ai_credentials").update({ revoked_at: now }).eq("user_id", userId).in("provider", [...BYOK_DB_PROVIDERS]).is("revoked_at", null);
  await db.from("ai_preferences").upsert({ user_id: userId, provider: "managed_openrouter", model: managedDefaultModel(), updated_at: now }, { onConflict: "user_id" });
  return getAiSettings(userId);
}

export async function resolveAiRuntime(userId: string): Promise<AiRuntime> {
  const db = getAdminSupabase();
  const { data: preference } = await db.from("ai_preferences").select("provider,model").eq("user_id", userId).maybeSingle();
  const byokProvider = preference?.provider ? dbToProvider[preference.provider] : undefined;
  if (byokProvider) {
    const { data: credential, error } = await db
      .from("ai_credentials")
      .select("encrypted_secret,model_preference")
      .eq("user_id", userId)
      .eq("provider", providerToDb[byokProvider])
      .is("revoked_at", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error || !credential) throw new Error(`BYOK is selected but no active ${byokProvider} key exists`);
    const payload = JSON.parse(credential.encrypted_secret) as EncryptedSecret;
    return {
      apiKey: decryptByok(payload, masterKey()),
      model: credential.model_preference ?? preference?.model ?? defaultModelForProvider(byokProvider),
      source: "byok",
      provider: byokProvider,
    };
  }
  if (process.env.OPENROUTER_API_KEY) {
    return { apiKey: process.env.OPENROUTER_API_KEY, model: preference?.model ?? managedDefaultModel(), source: "managed", provider: "managed" };
  }
  return { apiKey: null, model: managedDefaultModel(), source: "demo", provider: "managed" };
}

// Backward-compatible aliases for clients deployed before the generic BYOK route.
export async function saveOpenRouterByok(userId: string, apiKey: string, model?: string) {
  return saveByok(userId, "openrouter", apiKey, model);
}
export async function revokeOpenRouterByok(userId: string) {
  return switchToManagedAi(userId);
}
