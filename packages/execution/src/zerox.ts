export type ZeroXQuoteParams = { chainId?: number; sellToken: string; buyToken: string; sellAmount: string; taker: string; slippageBps?: number };
export class ZeroXClient {
  constructor(private apiKey: string, private baseUrl = "https://api.0x.org") {}
  private async get(path: string, params: Record<string,string|number|undefined>) {
    const qs = new URLSearchParams(Object.entries(params).filter(([,v])=>v!=null).map(([k,v])=>[k,String(v)]));
    const r = await fetch(`${this.baseUrl}${path}?${qs}`, { headers: { "0x-api-key": this.apiKey, "0x-version": "v2" } });
    const body = await r.json();
    if (!r.ok) throw new Error(`0x ${r.status}: ${JSON.stringify(body)}`);
    return body;
  }
  price(p: ZeroXQuoteParams) { return this.get("/swap/allowance-holder/price", { chainId:p.chainId??8453, ...p }); }
  quote(p: ZeroXQuoteParams) { return this.get("/swap/allowance-holder/quote", { chainId:p.chainId??8453, ...p }); }
}
