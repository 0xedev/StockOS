import { decryptByok, encryptByok, maskSecret, type EncryptedSecret } from "../../../../packages/ai/src/byok.ts";
import { getAdminSupabase } from "./db.ts";

const FALLBACK_MODEL = "openai/gpt-5.6-luna";
type AiRuntime = { apiKey: string | null; model: string; source: "managed" | "byok" | "demo" };

function managedDefaultModel() { return process.env.OPENROUTER_MODEL ?? FALLBACK_MODEL; }
function masterKey(): string {
  if (!process.env.BYOK_MASTER_KEY) throw new Error("BYOK_MASTER_KEY is not configured");
  return process.env.BYOK_MASTER_KEY;
}

async function verifyOpenRouterKey(apiKey: string) {
  const response = await fetch("https://openrouter.ai/api/v1/key", { headers: { Authorization: `Bearer ${apiKey}` } });
  if (!response.ok) throw new Error("OpenRouter rejected this API key");
  return response.json();
}

export async function getAiSettings(userId: string) {
  const db = getAdminSupabase();
  const { data: preference } = await db.from("ai_preferences").select("provider,model").eq("user_id", userId).maybeSingle();
  const { data: credential } = await db.from("ai_credentials").select("id,provider,model_preference,masked_hint,last_verified_at,created_at").eq("user_id", userId).eq("provider", "openrouter_byok").is("revoked_at", null).order("created_at", { ascending: false }).limit(1).maybeSingle();
  return {
    provider: preference?.provider ?? "managed_openrouter",
    model: preference?.model ?? credential?.model_preference ?? managedDefaultModel(),
    managedModel: managedDefaultModel(),
    byok: credential ? { configured: true, maskedHint: credential.masked_hint, lastVerifiedAt: credential.last_verified_at } : { configured: false },
  };
}

export async function saveOpenRouterByok(userId: string, apiKey: string, model = managedDefaultModel()) {
  const normalized = apiKey.trim();
  if (!normalized) throw new Error("API key is required");
  await verifyOpenRouterKey(normalized);
  const db = getAdminSupabase();
  const encrypted = encryptByok(normalized, masterKey());
  const now = new Date().toISOString();
  await db.from("ai_credentials").update({ revoked_at: now }).eq("user_id", userId).eq("provider", "openrouter_byok").is("revoked_at", null);
  const { error: insertError } = await db.from("ai_credentials").insert({
    user_id: userId,
    provider: "openrouter_byok",
    encrypted_secret: JSON.stringify(encrypted),
    key_version: "aes-256-gcm-v1",
    model_preference: model,
    masked_hint: maskSecret(normalized),
    last_verified_at: now,
  });
  if (insertError) throw new Error(`Could not store BYOK credential: ${insertError.message}`);
  const { error: prefError } = await db.from("ai_preferences").upsert({ user_id: userId, provider: "openrouter_byok", model, updated_at: now }, { onConflict: "user_id" });
  if (prefError) throw new Error(`Could not store AI preference: ${prefError.message}`);
  return getAiSettings(userId);
}

export async function revokeOpenRouterByok(userId: string) {
  const db = getAdminSupabase();
  const now = new Date().toISOString();
  await db.from("ai_credentials").update({ revoked_at: now }).eq("user_id", userId).eq("provider", "openrouter_byok").is("revoked_at", null);
  await db.from("ai_preferences").upsert({ user_id: userId, provider: "managed_openrouter", model: managedDefaultModel(), updated_at: now }, { onConflict: "user_id" });
  return getAiSettings(userId);
}

export async function resolveAiRuntime(userId: string): Promise<AiRuntime> {
  const db = getAdminSupabase();
  const { data: preference } = await db.from("ai_preferences").select("provider,model").eq("user_id", userId).maybeSingle();
  const model = preference?.model ?? managedDefaultModel();
  if (preference?.provider === "openrouter_byok") {
    const { data: credential, error } = await db.from("ai_credentials").select("encrypted_secret,model_preference").eq("user_id", userId).eq("provider", "openrouter_byok").is("revoked_at", null).order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (error || !credential) throw new Error("BYOK is selected but no active OpenRouter key exists");
    const payload = JSON.parse(credential.encrypted_secret) as EncryptedSecret;
    return { apiKey: decryptByok(payload, masterKey()), model: credential.model_preference ?? model, source: "byok" };
  }
  if (process.env.OPENROUTER_API_KEY) return { apiKey: process.env.OPENROUTER_API_KEY, model, source: "managed" };
  return { apiKey: null, model, source: "demo" };
}
