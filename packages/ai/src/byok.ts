import { createCipheriv, createDecipheriv, randomBytes, createHash } from "node:crypto";
export type EncryptedSecret = { v: 1; iv: string; tag: string; ciphertext: string };
function keyFromMaster(master: string): Buffer { return createHash("sha256").update(master).digest(); }
export function encryptByok(secret: string, master: string): EncryptedSecret {
  if (!secret || !master) throw new Error("Missing BYOK secret or master key");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyFromMaster(master), iv);
  const ciphertext = Buffer.concat([cipher.update(secret,"utf8"), cipher.final()]);
  return { v:1, iv:iv.toString("base64url"), tag:cipher.getAuthTag().toString("base64url"), ciphertext:ciphertext.toString("base64url") };
}
export function decryptByok(payload: EncryptedSecret, master: string): string {
  const decipher = createDecipheriv("aes-256-gcm", keyFromMaster(master), Buffer.from(payload.iv,"base64url"));
  decipher.setAuthTag(Buffer.from(payload.tag,"base64url"));
  return Buffer.concat([decipher.update(Buffer.from(payload.ciphertext,"base64url")),decipher.final()]).toString("utf8");
}
export function maskSecret(secret: string): string { return secret.length < 8 ? "••••" : `${secret.slice(0,3)}••••••${secret.slice(-4)}`; }
