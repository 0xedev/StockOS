export type ZeroXQuoteParams = {
  chainId?: number;
  sellToken: string;
  buyToken: string;
  sellAmount: string;
  taker: string;
  slippageBps?: number;
};

export type ZeroXAllowanceIssue = { actual?: string; spender: string };
export type ZeroXBalanceIssue = { token?: string; actual?: string; expected?: string };
export type ZeroXTransaction = { to: string; data: string; value: string; gas?: string; gasPrice?: string };
export type ZeroXSwapResponse = {
  liquidityAvailable?: boolean;
  sellAmount?: string;
  buyAmount?: string;
  minBuyAmount?: string;
  sellToken?: string;
  buyToken?: string;
  allowanceTarget?: string;
  route?: unknown;
  issues?: {
    allowance?: ZeroXAllowanceIssue | null;
    balance?: ZeroXBalanceIssue | null;
    simulationIncomplete?: boolean;
  };
  transaction?: ZeroXTransaction;
};

export class ZeroXClient {
  constructor(private apiKey: string, private baseUrl = "https://api.0x.org") {}

  private async get(path: string, params: Record<string, string | number | undefined>): Promise<ZeroXSwapResponse> {
    const qs = new URLSearchParams(
      Object.entries(params)
        .filter(([, value]) => value != null)
        .map(([key, value]) => [key, String(value)]),
    );
    const response = await fetch(`${this.baseUrl}${path}?${qs}`, {
      headers: { "0x-api-key": this.apiKey, "0x-version": "v2" },
    });
    const body = await response.json() as any;
    if (!response.ok) throw new Error(`0x ${response.status}: ${body?.reason ?? body?.message ?? JSON.stringify(body)}`);
    return body as ZeroXSwapResponse;
  }

  price(params: ZeroXQuoteParams) {
    return this.get("/swap/allowance-holder/price", { chainId: params.chainId ?? 8453, ...params });
  }

  quote(params: ZeroXQuoteParams) {
    return this.get("/swap/allowance-holder/quote", { chainId: params.chainId ?? 8453, ...params });
  }
}
