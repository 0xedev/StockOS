"use client";

import { AuthButton, ExportWalletModal, FundModal, type FetchBuyOptions, type FetchBuyQuote } from "@coinbase/cdp-react";
import { useCurrentUser, useGetAccessToken, useIsSignedIn, useSendUserOperation } from "@coinbase/cdp-hooks";
import { useCallback, useEffect, useState } from "react";

const examples = [
  "Invest $1,000: 50% Apple, 30% Nvidia and 20% cash.",
  "Put $750 equally across Apple, Google and Meta. No Nvidia.",
  "Build an aggressive $2,000 portfolio. Keep Nvidia under 40%, hold at least 10% cash, and rebalance monthly.",
];
const defaultModel = "z-ai/glm-5.2:free";

type ExecutionPlan = {
  planId: string;
  phase: "allowance_required" | "ready" | "blocked";
  executable: boolean;
  expiresAt?: string;
  calls: Array<{ kind: "approval" | "swap"; label: string; to: string; data: string; value: string }>;
  checks: Array<{ name: string; passed: boolean; detail?: string }>;
};

type WalletSummary = {
  address: string;
  network: "base";
  chainId: 8453;
  balances: {
    ETH: { raw: string; formatted: string };
    USDC: { raw: string; formatted: string };
  };
};

export default function Home() {
  const { isSignedIn } = useIsSignedIn();
  const { currentUser } = useCurrentUser();
  const { getAccessToken } = useGetAccessToken();
  const { sendUserOperation, status: sendStatus } = useSendUserOperation();
  const [prompt, setPrompt] = useState("");
  const [result, setResult] = useState<any>(null);
  const [executionPlan, setExecutionPlan] = useState<ExecutionPlan | null>(null);
  const [session, setSession] = useState<any>(null);
  const [walletSummary, setWalletSummary] = useState<WalletSummary | null>(null);
  const [sendAsset, setSendAsset] = useState<"USDC" | "ETH">("USDC");
  const [sendTo, setSendTo] = useState("");
  const [sendAmount, setSendAmount] = useState("");
  const [aiSettings, setAiSettings] = useState<any>(null);
  const [byokKey, setByokKey] = useState("");
  const [byokModel, setByokModel] = useState(defaultModel);
  const [fundCountry, setFundCountry] = useState("");
  const [fundSubdivision, setFundSubdivision] = useState("");
  const [loading, setLoading] = useState(false);
  const [compiling, setCompiling] = useState(false);
  const [message, setMessage] = useState("");
  const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
  const smartAddress = currentUser?.evmSmartAccountObjects?.[0]?.address ?? currentUser?.evmSmartAccounts?.[0] ?? null;
  const cdpSmartAccount = currentUser?.evmSmartAccounts?.[0] ?? null;
  const ownerAddress = session?.wallet?.ownerAddress ?? null;

  const authenticatedFetch = useCallback(async (path: string, init: RequestInit = {}) => {
    const token = await getAccessToken();
    if (!token) throw new Error("Sign in is required");
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${token}`);
    if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    return fetch(`${apiUrl}${path}`, { ...init, headers });
  }, [apiUrl, getAccessToken]);

  const refreshWallet = useCallback(async () => {
    if (!isSignedIn) return;
    const response = await authenticatedFetch("/v1/wallet/summary");
    const body = await response.json();
    if (!response.ok) throw new Error(body.message ?? body.error ?? "Could not load wallet balances");
    setWalletSummary(body);
  }, [authenticatedFetch, isSignedIn]);

  const syncSession = useCallback(async () => {
    if (!isSignedIn) return;
    const response = await authenticatedFetch("/v1/session", { method: "POST" });
    if (!response.ok) throw new Error("Could not establish StockOS session");
    setSession(await response.json());

    const [aiResponse, walletResponse] = await Promise.all([
      authenticatedFetch("/v1/ai/settings"),
      authenticatedFetch("/v1/wallet/summary"),
    ]);
    if (aiResponse.ok) {
      const settings = await aiResponse.json();
      setAiSettings(settings);
      setByokModel(settings.model ?? defaultModel);
    }
    if (walletResponse.ok) setWalletSummary(await walletResponse.json());
  }, [authenticatedFetch, isSignedIn]);

  useEffect(() => {
    if (!isSignedIn) {
      setSession(null); setWalletSummary(null); setAiSettings(null); setResult(null); setExecutionPlan(null);
      return;
    }
    syncSession().catch(error => setMessage(error.message));
  }, [isSignedIn, currentUser?.userId, syncSession]);

  useEffect(() => {
    if (fundCountry || typeof navigator === "undefined") return;
    const region = navigator.language.match(/[-_]([A-Za-z]{2})$/)?.[1];
    if (region) setFundCountry(region.toUpperCase());
  }, [fundCountry]);

  const fetchBuyOptions: FetchBuyOptions = useCallback(async params => {
    const query = new URLSearchParams({ country: params.country });
    if (params.subdivision) query.set("subdivision", params.subdivision);
    const response = await authenticatedFetch(`/v1/onramp/buy-options?${query}`);
    const body = await response.json();
    if (!response.ok) throw new Error(body.message ?? body.error ?? "Could not load funding options");
    return body;
  }, [authenticatedFetch]);

  const fetchBuyQuote: FetchBuyQuote = useCallback(async params => {
    const response = await authenticatedFetch("/v1/onramp/buy-quote", { method: "POST", body: JSON.stringify(params) });
    const body = await response.json();
    if (!response.ok) throw new Error(body.message ?? body.error ?? "Could not create funding quote");
    return body;
  }, [authenticatedFetch]);

  async function copyReceiveAddress() {
    if (!smartAddress) return;
    await navigator.clipboard.writeText(smartAddress);
    setMessage("Smart Account address copied. Send Base USDC, ETH, or other supported Base assets to this address.");
  }

  async function sendWalletAsset() {
    if (!cdpSmartAccount) return setMessage("Smart Account is not ready yet.");
    if (!sendTo.trim() || !sendAmount.trim()) return setMessage("Enter a recipient and amount.");
    setLoading(true); setMessage("");
    try {
      const response = await authenticatedFetch("/v1/wallet/send/prepare", {
        method: "POST",
        body: JSON.stringify({ asset: sendAsset, to: sendTo.trim(), amount: sendAmount.trim() }),
      });
      const prepared = await response.json();
      if (!response.ok) throw new Error(prepared.message ?? prepared.error ?? "Could not prepare wallet send");
      const sent = await sendUserOperation({
        evmSmartAccount: cdpSmartAccount,
        network: "base",
        calls: [{ to: prepared.call.to as `0x${string}`, data: prepared.call.data as `0x${string}`, value: BigInt(prepared.call.value) }],
        useCdpPaymaster: true,
      });
      const reference = (sent as any)?.transactionHash ?? (sent as any)?.userOperationHash ?? (sent as any)?.hash;
      if (!reference) throw new Error("CDP did not return a transaction or user-operation reference");
      setMessage(`${prepared.amount} ${prepared.asset} send submitted: ${reference}`);
      setSendAmount("");
      await refreshWallet().catch(() => undefined);
    } catch (error) { setMessage(error instanceof Error ? error.message : "Wallet send failed"); }
    finally { setLoading(false); }
  }

  async function compile() {
    if (!prompt.trim()) return setMessage("Describe the portfolio you want first.");
    setCompiling(true); setMessage(""); setExecutionPlan(null);
    try {
      const response = await authenticatedFetch("/v1/strategy/compile", { method: "POST", body: JSON.stringify({ prompt }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.message ?? body.error ?? "Strategy compilation failed");
      setResult(body);
    } catch (error) { setMessage(error instanceof Error ? error.message : "Strategy compilation failed"); }
    finally { setCompiling(false); }
  }

  async function prepare() {
    if (!result?.draft?.strategyVersionId) return;
    setLoading(true); setMessage(""); setExecutionPlan(null);
    try {
      const response = await authenticatedFetch("/v1/execution/prepare", { method: "POST", body: JSON.stringify({ strategyVersionId: result.draft.strategyVersionId }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.message ?? body.error ?? "Could not prepare execution");
      setExecutionPlan(body);
    } catch (error) { setMessage(error instanceof Error ? error.message : "Could not prepare execution"); }
    finally { setLoading(false); }
  }

  async function executePlan() {
    if (!executionPlan?.executable || !cdpSmartAccount) return;
    if (executionPlan.expiresAt && Date.now() > Date.parse(executionPlan.expiresAt)) {
      setMessage("The quote expired. Prepare a fresh execution plan."); setExecutionPlan(null); return;
    }
    setLoading(true); setMessage("");
    try {
      const sent = await sendUserOperation({
        evmSmartAccount: cdpSmartAccount,
        network: "base",
        calls: executionPlan.calls.map(call => ({ to: call.to as `0x${string}`, data: call.data as `0x${string}`, value: BigInt(call.value) })),
        useCdpPaymaster: true,
      });
      const transactionHash = (sent as any)?.transactionHash;
      if (!transactionHash) throw new Error("CDP did not return a transaction hash");
      await authenticatedFetch(`/v1/execution/${executionPlan.planId}/submitted`, { method: "POST", body: JSON.stringify({ transactionHash }) });
      if (executionPlan.phase === "allowance_required") {
        setMessage("Exact USDC allowance confirmed. Re-checking 0x quotes is required before any stock trade.");
        setExecutionPlan(null); await prepare();
      } else {
        setMessage(`StockOS submitted the user-approved portfolio transaction: ${transactionHash}`);
        await refreshWallet().catch(() => undefined);
      }
    } catch (error) { setMessage(error instanceof Error ? error.message : "User operation failed"); }
    finally { setLoading(false); }
  }

  async function saveByok() {
    if (!byokKey.trim()) return setMessage("Enter an OpenRouter API key first.");
    setLoading(true); setMessage("");
    try {
      const response = await authenticatedFetch("/v1/ai/byok/openrouter", { method: "POST", body: JSON.stringify({ apiKey: byokKey, model: byokModel }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.message ?? body.error ?? "Could not save BYOK key");
      setAiSettings(body); setByokKey(""); setMessage("OpenRouter BYOK verified and enabled. The raw key is not returned by StockOS.");
    } catch (error) { setMessage(error instanceof Error ? error.message : "Could not save BYOK key"); }
    finally { setLoading(false); }
  }

  async function useManagedAi() {
    setLoading(true); setMessage("");
    try {
      const response = await authenticatedFetch("/v1/ai/byok/openrouter", { method: "DELETE" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.message ?? body.error ?? "Could not switch AI provider");
      setAiSettings(body); setByokModel(body.model ?? defaultModel); setMessage("StockOS managed OpenRouter is active.");
    } catch (error) { setMessage(error instanceof Error ? error.message : "Could not switch AI provider"); }
    finally { setLoading(false); }
  }

  const operationPending = loading || compiling || sendStatus === "pending";
  const countryReady = /^[A-Z]{2}$/.test(fundCountry) && (fundCountry !== "US" || !!fundSubdivision.trim());
  const usdcBalance = Number(walletSummary?.balances.USDC.formatted ?? 0).toLocaleString(undefined, { maximumFractionDigits: 6 });
  const ethBalance = Number(walletSummary?.balances.ETH.formatted ?? 0).toLocaleString(undefined, { maximumFractionDigits: 6 });

  return <main>
    <nav><strong>StockOS</strong><div className="nav-right"><span>Base · AI portfolio OS</span><AuthButton /></div></nav>
    <section className="hero">
      <div><p className="eyebrow">PROGRAMMABLE INVESTING</p><h1>Tell your portfolio<br/>what you want.</h1><p className="lede">Type the allocation, constraints, risk profile or plain-English goal. StockOS turns it into a validated portfolio using tokenized stocks on Base.</p>{isSignedIn && <div className="identity"><span>Smart account</span><code>{smartAddress ?? "Creating…"}</code></div>}</div>
      <div className="composer"><label>Describe your strategy</label><textarea value={prompt} onChange={event => setPrompt(event.target.value)} placeholder="e.g. Invest $1,000: 50% Apple, 30% Nvidia and 20% cash."/><div className="examples">{examples.map(example => <button type="button" key={example} onClick={() => setPrompt(example)}>{example}</button>)}</div><button className="primary" onClick={compile} disabled={operationPending || !isSignedIn || !prompt.trim()}>{!isSignedIn ? "Sign in to build" : compiling ? "Compiling your strategy…" : "Build my strategy"}</button><small>AI proposes actual weights. StockOS validates allowed assets and constraints. You approve execution.</small></div>
    </section>
    {message && <p className="message">{message}</p>}

    {isSignedIn && <section className="wallet-panel">
      <div><p className="eyebrow">YOUR BASE WALLET</p><h2>Your wallet should be usable, not just visible.</h2><p>The Smart Account holds and trades your assets. Its owner EOA is the exportable key that controls it.</p><div className="balance-grid"><div><span>USDC</span><strong>{usdcBalance}</strong></div><div><span>ETH</span><strong>{ethBalance}</strong></div></div><div className="wallet-address"><span>Smart Account</span><code>{smartAddress ?? "Creating…"}</code></div>{ownerAddress && <div className="wallet-address"><span>Owner EOA</span><code>{ownerAddress}</code></div>}<div className="buttons wallet-top-actions"><button onClick={copyReceiveAddress} disabled={!smartAddress}>Receive / copy address</button><button className="secondary-action" onClick={() => refreshWallet().catch(error => setMessage(error.message))} disabled={operationPending}>Refresh balances</button>{smartAddress && <a className="button-link" href={`https://basescan.org/address/${smartAddress}`} target="_blank" rel="noreferrer">BaseScan</a>}</div></div>
      <div className="wallet-actions">
        <div className="wallet-box"><strong>Fund wallet</strong><p>Buy USDC into this Smart Account with Coinbase Onramp, where available.</p><div className="fund-config"><label>Country code<input value={fundCountry} maxLength={2} onChange={event => setFundCountry(event.target.value.toUpperCase())} placeholder="NG"/></label>{fundCountry === "US" && <label>State code<input value={fundSubdivision} maxLength={3} onChange={event => setFundSubdivision(event.target.value.toUpperCase())} placeholder="NY"/></label>}</div><div className="buttons">{countryReady && smartAddress ? <FundModal country={fundCountry} subdivision={fundSubdivision || undefined} cryptoCurrency="usdc" fiatCurrency="usd" fetchBuyQuote={fetchBuyQuote} fetchBuyOptions={fetchBuyOptions} network="base" destinationAddress={smartAddress} presetAmountInputs={[25,50,100]} title="Fund your StockOS wallet" onSuccess={() => { setMessage("Funding completed. Refreshing wallet balance."); refreshWallet().catch(() => undefined); }} onError={() => setMessage("Coinbase funding is unavailable for this country, account, or payment method.")} /> : <button disabled>{!smartAddress ? "Smart Account is still being created" : "Enter country code to fund"}</button>}{ownerAddress && <ExportWalletModal address={ownerAddress} onCopySuccess={() => setMessage("Owner private key copied through Coinbase's secure export flow. StockOS never receives it.")} onIframeError={error => setMessage(error ?? "Wallet export failed")}><button type="button" className="secondary-action">Export owner key</button></ExportWalletModal>}</div><small>You can always fund directly by sending Base USDC or ETH to the Smart Account address.</small></div>
        <div className="wallet-box"><strong>Send / withdraw</strong><p>Prepare a deterministic transfer, then approve it with your CDP Smart Account.</p><div className="send-row"><select value={sendAsset} onChange={event => setSendAsset(event.target.value as "USDC" | "ETH")}><option value="USDC">USDC</option><option value="ETH">ETH</option></select><input value={sendAmount} onChange={event => setSendAmount(event.target.value)} inputMode="decimal" placeholder="Amount"/></div><input value={sendTo} onChange={event => setSendTo(event.target.value)} placeholder="0x recipient address"/><button onClick={sendWalletAsset} disabled={operationPending || !sendAmount.trim() || !sendTo.trim()}>Review & send {sendAsset}</button><small>The AI cannot call this action. The backend only prepares transfer calldata after you enter the destination and amount.</small></div>
      </div>
    </section>}

    {isSignedIn && <section className="settings"><div><p className="eyebrow">AI LAYER</p><h2>Managed AI or bring your own key.</h2><p>The model proposes actual target weights instead of selecting a hardcoded theme. Token addresses and transaction calldata stay deterministic and outside the model.</p></div><div className="byok"><div className="provider-row"><strong>Current</strong><span>{aiSettings?.provider === "openrouter_byok" ? `OpenRouter BYOK ${aiSettings?.byok?.maskedHint ?? ""}` : `Managed · ${aiSettings?.managedModel ?? aiSettings?.model ?? defaultModel}`}</span></div><input type="password" value={byokKey} onChange={event => setByokKey(event.target.value)} placeholder="OpenRouter API key" autoComplete="off"/><input value={byokModel} onChange={event => setByokModel(event.target.value)} placeholder={defaultModel}/><div className="buttons"><button onClick={saveByok} disabled={operationPending}>Use my key</button><button className="secondary-action" onClick={useManagedAi} disabled={operationPending}>Use managed AI</button></div></div></section>}

    {result && <section className="result"><header><div><span>Strategy preview</span><h2>${result.strategy?.totalUsd?.toLocaleString()}</h2><small>{result.ai?.source} · {result.ai?.model}</small></div><span className={result.policy?.allowed ? "pill ok" : "pill"}>{result.policy?.allowed ? "Policy passed" : "Review required"}</span></header><div className="grid">{result.strategy?.allocations?.map((allocation: any) => <article key={allocation.asset}><strong>{allocation.asset}</strong><b>{(allocation.weight * 100).toFixed((allocation.weight * 100) % 1 ? 1 : 0)}%</b><span>${allocation.amountUsd}</span></article>)}</div>{result.strategy?.warnings?.length > 0 && <div className="warnings">{result.strategy.warnings.map((warning: string) => <p key={warning}>{warning}</p>)}</div>}<div className="checks">{result.policy?.checks?.map((check: any) => <span key={check.name} className={check.passed ? "pass" : "fail"}>{check.passed ? "✓" : "×"} {check.name}</span>)}</div><div className="action-row"><button onClick={prepare} disabled={operationPending || !result.policy?.allowed}>Prepare execution</button><span>StockOS re-reads balances, allowance, B20 transfer policy, token decimals, 0x liquidity and Chainlink reference prices server-side.</span></div></section>}

    {executionPlan && <section className="execution"><header><div><p className="eyebrow">EXECUTION PLAN</p><h2>{executionPlan.phase === "allowance_required" ? "Exact allowance required" : executionPlan.phase === "ready" ? "Ready for your approval" : "Execution blocked"}</h2></div><span className={executionPlan.executable ? "pill ok" : "pill"}>{executionPlan.executable ? "Executable" : "Fail closed"}</span></header><div className="call-list">{executionPlan.calls.map((call,index) => <div key={`${call.kind}-${index}`}><b>{index+1}. {call.label}</b><code>{call.to}</code></div>)}</div><div className="checks">{executionPlan.checks.map(check => <span key={check.name} className={check.passed ? "pass" : "fail"}>{check.passed ? "✓" : "×"} {check.name}{check.detail ? ` · ${check.detail}` : ""}</span>)}</div>{executionPlan.expiresAt && <p className="note">Firm 0x quote expires at {new Date(executionPlan.expiresAt).toLocaleTimeString()}.</p>}<button className="execute-button" onClick={executePlan} disabled={operationPending || !executionPlan.executable}>{executionPlan.phase === "allowance_required" ? "Approve exact USDC allowance" : "Confirm & invest"}</button><p className="note">This button invokes your CDP Smart Account. The AI never signs or submits this operation.</p></section>}
  </main>;
}
