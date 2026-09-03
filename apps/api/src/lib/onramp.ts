import { generateJwt } from "@coinbase/cdp-sdk/auth";

const ONRAMP_API_BASE_URL = "https://api.developer.coinbase.com";

export class OnrampRequestError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "OnrampRequestError";
  }
}

function credentials() {
  const apiKeyId = process.env.CDP_API_KEY_ID;
  const apiKeySecret = process.env.CDP_API_KEY_SECRET;
  if (!apiKeyId || !apiKeySecret) throw new OnrampRequestError(503, "CDP Onramp credentials are not configured");
  return { apiKeyId, apiKeySecret };
}

async function jwt(method: string, path: string) {
  const { apiKeyId, apiKeySecret } = credentials();
  return generateJwt({ apiKeyId, apiKeySecret, requestMethod: method, requestHost: new URL(ONRAMP_API_BASE_URL).hostname, requestPath: path });
}

function camelize(value: any): any {
  if (Array.isArray(value)) return value.map(camelize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase()), camelize(item)]));
  }
  return value;
}

async function parseResponse(response: Response) {
  const text = await response.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  if (!response.ok) throw new OnrampRequestError(response.status, body?.message ?? body?.error ?? `Coinbase Onramp request failed (${response.status})`);
  return camelize(body);
}

function normalizeCountry(country: unknown) {
  const value = typeof country === "string" ? country.trim().toUpperCase() : "";
  if (!/^[A-Z]{2}$/.test(value)) throw new OnrampRequestError(400, "A two-letter country code is required for funding");
  return value;
}

export async function getOnrampBuyOptions(input: { country?: unknown; subdivision?: unknown }) {
  const country = normalizeCountry(input.country);
  const subdivision = typeof input.subdivision === "string" && input.subdivision.trim() ? input.subdivision.trim().toUpperCase() : undefined;
  const apiPath = "/onramp/v1/buy/options";
  const query = new URLSearchParams({ country, networks: "base" });
  if (subdivision) query.set("subdivision", subdivision);
  const token = await jwt("GET", apiPath);
  const response = await fetch(`${ONRAMP_API_BASE_URL}${apiPath}?${query}`, { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } });
  return parseResponse(response);
}

export async function createOnrampBuyQuote(input: Record<string, any>, destinationAddress: string) {
  const country = normalizeCountry(input.country);
  const subdivision = typeof input.subdivision === "string" && input.subdivision.trim() ? input.subdivision.trim().toUpperCase() : undefined;
  if (country === "US" && !subdivision) throw new OnrampRequestError(400, "State/subdivision is required for US funding");
  const apiPath = "/onramp/v1/buy/quote";
  const token = await jwt("POST", apiPath);
  const requestBody = {
    purchaseCurrency: input.purchaseCurrency,
    purchaseNetwork: "base",
    paymentAmount: input.paymentAmount,
    paymentCurrency: input.paymentCurrency,
    paymentMethod: input.paymentMethod,
    country,
    subdivision,
    destinationAddress,
  };
  if (!requestBody.purchaseCurrency || !requestBody.paymentAmount || !requestBody.paymentCurrency || !requestBody.paymentMethod) {
    throw new OnrampRequestError(400, "Missing required funding quote parameters");
  }
  const response = await fetch(`${ONRAMP_API_BASE_URL}${apiPath}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(requestBody),
  });
  return parseResponse(response);
}
